# MakerWorld GeeTest Coordinate Click Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recognize MakerWorld's ordered GeeTest coordinate-click challenge locally with OpenCV, click every target in order through CloakBrowser CDP, and confirm once without misclassifying the challenge as a slider.

**Architecture:** Extend the existing sanitized Python vision subprocess with one `coordinate_click` mode that converts two PNG inputs into a complete ordered list of normalized points. Extend the existing Node provider adapter with strict coordinate-click discovery, output validation, and one bounded CDP interaction; retain the current icon-grid, slider, Turnstile, timeout, and manual fallback behavior.

**Tech Stack:** Python 3.11, OpenCV, NumPy, Node.js ESM, Puppeteer CDP, pytest/unittest, Node test runner.

## Global Constraints

- Challenge images remain in memory and are never persisted, logged, or uploaded.
- The Python subprocess receives only `mode`, `targets_png`, and `background_png` for coordinate-click requests.
- A successful result contains two through five distinct normalized points in target order; partial success is rejected.
- Automatic interaction is limited to one full sequence per challenge and a second sequence only after the provider replaces the challenge.
- Low-confidence, malformed, timed-out, or changed challenges fall back without further clicks and must not mark the account logged out.
- Existing slider and Turnstile recognition behavior must remain unchanged.
- User-facing release metadata advances from `0.16.1` to `0.16.2` before release.

---

## File Structure

- `app/services/makerworld_captcha_vision.py`: validate, segment, match, and serialize coordinate-click vision requests.
- `tests/test_makerworld_captcha_vision.py`: generated image fixtures and Python/CLI contract tests.
- `app/services/cloakbrowser_verification.mjs`: discover the real GeeTest layout, validate vision output, and perform ordered CDP input.
- `frontend/src/lib/cloakbrowser-verification.test.mjs`: Node discovery, privacy, interaction, timeout, and regression tests.
- `VERSION`, `frontend/package.json`, `frontend/package-lock.json`: repository version metadata.
- `README.md`, `CHANGELOG.md`, `tests/test_release_contract.py`: visible release notes and release contract.

---

### Task 1: Local Ordered Coordinate Recognition

**Files:**
- Modify: `tests/test_makerworld_captcha_vision.py`
- Modify: `app/services/makerworld_captcha_vision.py`

**Interfaces:**
- Consumes: `solve_coordinate_click_challenge(targets_png: bytes, background_png: bytes) -> dict[str, Any]` inputs containing one ordered target strip and one complete background PNG.
- Produces: `{"ok": true, "points": [{"x": float, "y": float, "confidence": float}, ...], "confidence": float, "margin": float}` or a bounded `{"ok": false, "reason": str, ...}` result; `solve_request` accepts the exact `coordinate_click` mode fields.

- [ ] **Step 1: Add failing generated-fixture tests for ordered multi-target matching**

Add helpers that draw three asymmetric symbols into a target strip and the same symbols at different background positions. The test must assert target-strip order rather than background scan order:

```python
from app.services.makerworld_captcha_vision import solve_coordinate_click_challenge


def coordinate_fixture() -> tuple[np.ndarray, np.ndarray, list[tuple[float, float]]]:
    targets = np.full((64, 224, 4), 255, dtype=np.uint8)
    background = np.full((240, 360, 3), 238, dtype=np.uint8)
    kinds = ("triangle", "cross", "circle")
    target_x = (8, 80, 152)
    background_centers = ((286, 58), (82, 174), (226, 142))
    for kind, left, center in zip(kinds, target_x, background_centers, strict=True):
        target = cv2.resize(symbol(kind), (56, 56), interpolation=cv2.INTER_AREA)
        targets[4:60, left:left + 56] = target
        item = cv2.resize(symbol(kind)[:, :, :3], (72, 72), interpolation=cv2.INTER_AREA)
        x = center[0] - 36
        y = center[1] - 36
        background[y:y + 72, x:x + 72] = item
    expected = [(x / 360, y / 240) for x, y in background_centers]
    return targets, background, expected


class MakerWorldCaptchaVisionTest(unittest.TestCase):
    def test_coordinate_click_returns_points_in_target_order(self):
        targets, background, expected = coordinate_fixture()
        result = solve_coordinate_click_challenge(png_bytes(targets), png_bytes(background))
        self.assertTrue(result["ok"], result)
        self.assertEqual(len(result["points"]), 3)
        for point, (expected_x, expected_y) in zip(result["points"], expected, strict=True):
            self.assertAlmostEqual(point["x"], expected_x, delta=0.04)
            self.assertAlmostEqual(point["y"], expected_y, delta=0.04)
```

Also add separate tests for two valid targets, six inferred targets, a duplicated best location, two equally strong background matches, malformed PNGs, and a coordinate-click request containing `cookie` or `url`.

- [ ] **Step 2: Run the coordinate tests and verify the red state**

Run:

```bash
python -m pytest tests/test_makerworld_captcha_vision.py -q
```

Expected: collection fails because `solve_coordinate_click_challenge` is not exported.

- [ ] **Step 3: Add bounded target segmentation and location scoring**

Add these constants and focused helpers beside the existing click recognizer:

```python
COORDINATE_TARGET_MIN = 2
COORDINATE_TARGET_MAX = 5
COORDINATE_CONFIDENCE_MIN = 0.68
COORDINATE_MARGIN_MIN = 0.06
COORDINATE_SCALES = (0.80, 0.90, 1.00, 1.10, 1.20, 1.35)


def _segment_target_symbols(targets: np.ndarray) -> list[np.ndarray]:
    mask = _foreground_mask(targets)
    joined = cv2.morphologyEx(
        mask,
        cv2.MORPH_CLOSE,
        np.ones((3, 5), dtype=np.uint8),
    )
    occupied = np.any(joined > 0, axis=0)
    runs = _contiguous_true_runs(occupied)
    runs = [(left, right) for left, right in runs if right - left >= 6]
    if not COORDINATE_TARGET_MIN <= len(runs) <= COORDINATE_TARGET_MAX:
        raise ValueError("target_count_invalid")
    return [targets[:, left:right] for left, right in runs]


def _coordinate_match(
    target: np.ndarray,
    background: np.ndarray,
    excluded: list[tuple[int, int, int]],
) -> dict[str, float] | None:
    """Return the best non-overlapping center, confidence, and winner margin."""
```

`_coordinate_match` must evaluate the bounded scales with grayscale template correlation and Canny edge correlation, suppress the winning neighborhood when calculating the runner-up, and exclude locations already assigned to earlier targets. Clamp every score to `0..1` and never return raw image content.

- [ ] **Step 4: Implement complete-result validation**

Add the public solver with all-or-nothing semantics:

```python
def solve_coordinate_click_challenge(
    targets_png: bytes,
    background_png: bytes,
) -> dict[str, Any]:
    try:
        targets = _decode_png(targets_png)
        background = _decode_png(background_png)
        symbols = _segment_target_symbols(targets)
    except ValueError as exc:
        return {"ok": False, "reason": str(exc)}

    matches: list[dict[str, float]] = []
    excluded: list[tuple[int, int, int]] = []
    for symbol_image in symbols:
        match = _coordinate_match(symbol_image, background, excluded)
        if match is None:
            return {"ok": False, "reason": "coordinate_not_found"}
        if match["confidence"] < COORDINATE_CONFIDENCE_MIN:
            return {"ok": False, "reason": "confidence_too_low", "confidence": match["confidence"]}
        if match["margin"] < COORDINATE_MARGIN_MIN:
            return {"ok": False, "reason": "coordinate_ambiguous", "confidence": match["confidence"]}
        matches.append(match)
        excluded.append((int(match["pixel_x"]), int(match["pixel_y"]), int(match["radius"])))

    height, width = background.shape[:2]
    points = [
        {
            "x": round(match["pixel_x"] / width, 6),
            "y": round(match["pixel_y"] / height, 6),
            "confidence": round(match["confidence"], 4),
        }
        for match in matches
    ]
    return {
        "ok": True,
        "points": points,
        "confidence": min(point["confidence"] for point in points),
        "margin": round(min(match["margin"] for match in matches), 4),
    }
```

Before returning success, reject non-finite or out-of-bounds normalized points and point pairs closer than four background pixels with `coordinate_invalid`.

- [ ] **Step 5: Extend the strict CLI dispatcher**

Extend `ALLOWED_REQUEST_FIELDS`, `_REQUEST_FIELDS_BY_MODE`, and `solve_request` exactly as follows:

```python
ALLOWED_REQUEST_FIELDS = {
    "mode", "target_png", "candidate_pngs", "targets_png",
    "background_png", "piece_png", "geometry",
}

_REQUEST_FIELDS_BY_MODE["coordinate_click"] = {
    "mode", "targets_png", "background_png",
}

if mode == "coordinate_click":
    targets_png = _decode_base64_png(payload.get("targets_png"))
    background_png = _decode_base64_png(payload.get("background_png"))
    return solve_coordinate_click_challenge(targets_png, background_png)
```

The mode branch must run before the existing slider branch so a coordinate request never tries to decode `piece_png` or `geometry`.

- [ ] **Step 6: Run the Python suite and verify green**

Run:

```bash
python -m pytest tests/test_makerworld_captcha_vision.py -q
```

Expected: all existing click, slider, CLI, and new coordinate-click tests pass.

- [ ] **Step 7: Commit the recognizer slice**

```bash
git add app/services/makerworld_captcha_vision.py tests/test_makerworld_captcha_vision.py
git commit -m "feat: 添加坐标点选验证码识别"
```

---

### Task 2: GeeTest Discovery And Ordered Trusted Input

**Files:**
- Modify: `frontend/src/lib/cloakbrowser-verification.test.mjs`
- Modify: `app/services/cloakbrowser_verification.mjs`

**Interfaces:**
- Consumes: Python `coordinate_click` result with two through five ordered normalized points.
- Produces: `detectVerificationChallenge(page)` result `{provider: "geetest4", challenge_type: "coordinate_click", frame, container, targets, background, confirm}` and a sanitized automatic-verification summary.

- [ ] **Step 1: Add failing discovery and payload tests**

Create a fake GeeTest container whose broad selectors also expose slider parts, then assert coordinate-click wins:

```javascript
test("coordinate-click discovery wins over slider-like generated classes", async () => {
  const targets = fakeHandle({ box: { x: 70, y: 18, width: 150, height: 42 } });
  const background = fakeHandle({ box: { x: 20, y: 72, width: 300, height: 200 } });
  const confirm = fakeHandle({ box: { x: 136, y: 282, width: 68, height: 30 } });
  const sliderHandle = fakeHandle({ box: { x: 20, y: 282, width: 40, height: 30 } });
  const container = coordinateDiscoveryContainer({ targets, background, confirm, sliderHandle });
  const frame = fakeFrame({ one: selector => selector.includes("geetest") ? container : null });

  const challenge = await detectVerificationChallenge({ mainFrame: () => frame, frames: () => [frame] });

  assert.equal(challenge.challenge_type, "coordinate_click");
  assert.equal(challenge.targets, targets);
  assert.equal(challenge.background, background);
  assert.equal(challenge.confirm, confirm);
});
```

Add a `runVisionRequest` test proving that `url`, `cookie`, `token`, and unknown geometry are removed while `targets_png` and `background_png` remain.

- [ ] **Step 2: Run the Node tests and verify the red state**

Run:

```bash
node --test frontend/src/lib/cloakbrowser-verification.test.mjs
```

Expected: the discovery assertion fails because the current detector returns `slider` or `null`, and the payload test fails because `cleanVisionPayload` does not recognize `coordinate_click`.

- [ ] **Step 3: Add strict selectors and layout validation**

Add bounded selectors matching known GeeTest roles, with fallbacks constrained by the common container:

```javascript
const COORDINATE_TARGET_SELECTORS = [
  ".geetest_ques_tips", ".geetest_ques_back", ".geetest_question",
  "[class*='geetest'][class*='ques']",
];
const COORDINATE_BACKGROUND_SELECTORS = [
  ".geetest_bg", ".geetest_canvas_bg", ".geetest_window",
  "[class*='geetest'][class*='bg']",
];
const COORDINATE_CONFIRM_SELECTORS = [
  ".geetest_commit_tip", ".geetest_submit",
  "[class*='geetest'][class*='commit']", "[class*='geetest'][class*='submit']",
];
```

Implement `validateCoordinateClickLayout(challenge, signal)` to require all four handles, visibility, common-container membership, valid finite boxes, a background at least `120x80`, a target strip above and not overlapping the background, and a confirmation control outside the target/background interiors. Discovery must call this branch before independent-candidate icon detection and slider detection.

- [ ] **Step 4: Extend the privacy and diagnostic contracts**

Add `coordinate_click` to `sanitizeVerificationResult`, and add only these safe reasons:

```javascript
"challenge_changed",
"confirmation_unavailable",
"coordinate_ambiguous",
"coordinate_invalid",
"coordinate_not_found",
"target_count_invalid",
"target_segmentation_failed",
```

Extend `cleanVisionPayload` with the exact payload:

```javascript
if (String(payload?.mode || "").trim().toLowerCase() === "coordinate_click") {
  return {
    mode: "coordinate_click",
    targets_png: payload?.targets_png,
    background_png: payload?.background_png,
  };
}
```

Update `defaultFingerprintChallenge` so coordinate-click identity contains only stable identities for `targets` and `background`. It must not include click-marker overlays, coordinates, or confirmation text.

- [ ] **Step 5: Add failing ordered-interaction tests**

Drive `attemptAutomaticVerification` with a coordinate challenge and injected vision result. Assert the precise CDP event order and one final confirmation click:

```javascript
test("coordinate click dispatches every point in target order before confirmation", async () => {
  const events = [];
  const challenge = coordinateChallenge({ events });
  const result = await attemptAutomaticVerification(fakeInputPage({
    dispatch: async event => events.push(event),
  }), {
    detectChallenge: async () => challenge,
    fingerprintChallenge: async () => "coordinate-a",
    visionRequest: async () => ({
      ok: true,
      points: [
        { x: 0.75, y: 0.25, confidence: 0.90 },
        { x: 0.20, y: 0.80, confidence: 0.86 },
      ],
      confidence: 0.86,
      margin: 0.12,
    }),
    isChallengeComplete: async () => true,
    sleep: async () => {},
  });

  assert.equal(result.completed, true);
  assert.deepEqual(pressedCenters(events), [[245, 122], [80, 232], [170, 297]]);
});
```

Add separate tests proving zero mouse events for one point, six points, NaN/infinite/out-of-range coordinates, duplicate coordinates, changed layout, changed fingerprint, missing confirmation, vision timeout, and an abort between two point clicks.

- [ ] **Step 6: Run the interaction tests and verify the red state**

Run:

```bash
node --test frontend/src/lib/cloakbrowser-verification.test.mjs
```

Expected: the new interaction test returns `challenge_unsupported` and emits no ordered clicks.

- [ ] **Step 7: Implement coordinate result validation and one-session input**

Add a pure validator and a bounded solver:

```javascript
function validateCoordinatePoints(result, backgroundBox) {
  const points = Array.isArray(result?.points) ? result.points : [];
  if (!result?.ok || points.length < 2 || points.length > 5 || !validBox(backgroundBox)) {
    return null;
  }
  const converted = points.map((point) => ({
    x: backgroundBox.x + (Number(point.x) * backgroundBox.width),
    y: backgroundBox.y + (Number(point.y) * backgroundBox.height),
    confidence: Number(point.confidence),
  }));
  if (converted.some((point) => (
    !Number.isFinite(point.x) || !Number.isFinite(point.y)
    || !Number.isFinite(point.confidence) || point.confidence < 0 || point.confidence > 1
    || point.x < backgroundBox.x || point.x > backgroundBox.x + backgroundBox.width
    || point.y < backgroundBox.y || point.y > backgroundBox.y + backgroundBox.height
  ))) return null;
  return coordinatePointsAreDistinct(converted) ? converted : null;
}
```

`solveCoordinateClickChallenge` must screenshot `targets` and `background`, call vision mode `coordinate_click`, re-run layout validation, compare a fresh fingerprint with the pre-recognition fingerprint, and then create one mouse driver. For each validated point it sends `move`, `down`, `up`, waits a bounded injected delay, then performs one final trusted click at the current confirmation-control center. A `finally` block always releases the mouse and detaches the session.

- [ ] **Step 8: Route the new challenge and preserve retry semantics**

In `attemptWithinStage`, route `coordinate_click` before `icon_click`:

```javascript
} else if (challenge.challenge_type === "coordinate_click") {
  fingerprint = await abortable(fingerprintChallenge(challenge, stage), signal);
  throwIfActionExpired(stage);
  summary.attempted = true;
  summary.attempts = attempt;
  interaction = await solveCoordinateClickChallenge(
    page, challenge, fingerprint, options, visionRequest, stage,
  );
} else if (challenge.challenge_type === "icon_click") {
```

The existing outcome watcher remains responsible for completion and permits a second attempt only when the fingerprint changes. An unchanged challenge returns `challenge_unchanged` without a second confirmation click.

- [ ] **Step 9: Run focused and cross-language tests**

Run:

```bash
node --test frontend/src/lib/cloakbrowser-verification.test.mjs
python -m pytest tests/test_makerworld_captcha_vision.py -q
```

Expected: both suites pass without warnings or leaked subprocesses.

- [ ] **Step 10: Commit the browser adapter slice**

```bash
git add app/services/cloakbrowser_verification.mjs frontend/src/lib/cloakbrowser-verification.test.mjs
git commit -m "fix: 支持 GeeTest 多坐标点选"
```

---

### Task 3: Release Metadata And Full Verification

**Files:**
- Modify: `VERSION`
- Modify: `frontend/package.json`
- Modify: `frontend/package-lock.json`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `tests/test_release_contract.py`

**Interfaces:**
- Consumes: completed coordinate-click behavior from Tasks 1 and 2.
- Produces: coherent `0.16.2` repository metadata and public update notes; no tag or push is created by this task.

- [ ] **Step 1: Update the release-contract test first**

Change the current-version assertions to `0.16.2` and require release notes to mention all three observable guarantees:

```python
self.assertEqual(version, "0.16.2")
self.assertIn("> 当前版本：`v0.16.2`", readme)
self.assertIn("### 2026-08-07 · v0.16.2", readme)
self.assertIn("## 2026-08-07 · v0.16.2", changelog)
for expected in ("坐标点选", "按目标顺序", "转人工"):
    self.assertIn(expected, release_notes)
```

- [ ] **Step 2: Run the release test and verify the red state**

Run:

```bash
python -m pytest tests/test_release_contract.py -q
```

Expected: current version and update-note assertions fail at `0.16.1`.

- [ ] **Step 3: Bump version metadata and add focused notes**

Set `VERSION`, `frontend/package.json`, and both version fields in `frontend/package-lock.json` to `0.16.2`. Add `v0.16.2` as the newest README and CHANGELOG entry with these user-facing points:

```markdown
- 修复 MakerWorld 国区真实坐标点选验证码被误判为滑块的问题。
- 本地 OpenCV 会识别目标序列和背景中的多个位置，并按目标顺序点击后确认；验证码截图不会上传或持久化。
- 识别结果不完整、置信度不足或页面发生变化时立即转人工验证，不会盲点、重复确认或把账号误报为退出登录。
```

Keep only the newest three README releases expanded and move the previous third entry into the existing collapsed history block.

- [ ] **Step 4: Run release and version checks**

Run:

```bash
python -m pytest tests/test_release_contract.py -q
python scripts/check_release_version.py --root .
```

Expected: both commands pass for `0.16.2` without requiring a Git tag.

- [ ] **Step 5: Run all verification gates**

Run:

```bash
python -m pytest -q
node --test frontend/src/lib/*.test.mjs
npm --prefix frontend run build
git diff --check
```

Expected: the complete Python suite, complete Node suite, frontend production build, and whitespace check all pass.

- [ ] **Step 6: Review the final diff and commit release metadata**

Review only the task-owned files, confirm `videos/makerhub-intro/output/` remains untracked and unstaged, then commit:

```bash
git add VERSION frontend/package.json frontend/package-lock.json README.md CHANGELOG.md tests/test_release_contract.py
git commit -m "chore: 准备 v0.16.2 验证码修复"
```

Do not push, tag, deploy, or touch the untracked video output unless the user explicitly requests a release.
