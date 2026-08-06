# MakerWorld Automatic Verification Design

## Purpose

MakerHub should make one bounded automatic verification attempt when a real
CloakBrowser-backed 3MF authorization is blocked by MakerWorld verification.
The browser profile remains the source of truth for cookies, fingerprint, and
proxy state. Automatic verification only operates inside the already-open
authorization page and falls back to the existing manual browser flow when it
cannot complete confidently.

The first implementation covers both platforms:

- MakerWorld CN: GeeTest 4 dynamic icon selection.
- MakerWorld Global: Cloudflare Turnstile browser-native completion.

## Current State

`cloakbrowser_bridge.mjs` opens a temporary model page, clicks the visible 3MF
download action once, and waits for the matching `/f3mf` response. A successful
response returns the signed download URL. A blocked response returns a
sanitized payload such as `captchaId`, after which the temporary target closes
and the archive task enters manual verification state.

This is the correct place to add automation because the page already has the
real profile, proxy, fingerprint, and MakerWorld JavaScript runtime. Completing
the provider widget in that page lets the site generate its own validation
proof, including `x-bbl-captcha-result`; MakerHub does not need to reproduce or
forge provider cryptography.

## Scope

In scope:

- Attempt automatic verification only during browser-backed 3MF authorization.
- Preserve the existing single click on the 3MF download action.
- Detect a GeeTest 4 dynamic icon challenge in the current page or child frame.
- Capture the target icon and four candidate cells in memory.
- Select a candidate only when both absolute confidence and winner margin pass
  conservative thresholds.
- Click the selected candidate through Puppeteer and wait for the page to retry
  the same `/f3mf` authorization request.
- Detect Cloudflare Turnstile on MakerWorld Global, wait for browser-native
  completion, and make at most one checkbox-style interaction when exposed.
- Return the latest sanitized authorization response to the existing archive
  flow.
- Keep verification failures classified as verification requirements, not
  account login failures.
- Add focused unit and bridge contract tests.

Out of scope:

- Automatic handling for listing, refresh, health-check, or login requests.
- Solving Turnstile visual challenges.
- Supporting every GeeTest 4 question type in the first iteration.
- Calling an external captcha-solving service or uploading challenge images.
- Persisting screenshots, target symbols, provider tokens, or raw response
  bodies.
- Removing CloakBrowser or changing profile lifecycle management.
- Repeatedly clicking Download 3MF or explicitly replaying authorization API
  requests.

## Considered Approaches

### 1. Extend the existing CloakBrowser bridge

This is the recommended approach. Detection, screenshots, input, and response
capture stay in one temporary browser page. It preserves the exact browser
identity that received the challenge and lets MakerWorld perform its normal
post-verification request.

### 2. Add a Python/OpenCV subprocess

OpenCV would provide convenient contour and image primitives, but it adds a
large runtime dependency and another subprocess boundary inside the current
Python-to-Node bridge. Timeout handling and image transport would become more
complex than the narrow recognizer requires.

### 3. Use an external solving service

This reduces local image-processing work but introduces image disclosure,
fees, availability risk, and another credential. It is not appropriate for a
self-hosted default.

## Architecture

### Authorization Coordinator

Refactor the current authorization response handling into a small coordinator:

1. Navigate to the model page and locate the 3MF action as today.
2. Start listening for the matching `/f3mf` response.
3. Click the download action exactly once.
4. Parse the first response.
5. Return immediately when it is successful or not a recognized verification
   response.
6. For a recognized verification response, start the next-response waiter
   before interacting with the provider widget.
7. Run the matching provider adapter once.
8. If the adapter reports completion, wait for the page-generated retry of the
   same `/f3mf` endpoint and return that response.
9. If detection, recognition, interaction, or waiting fails, return the first
   verification response unchanged.

No adapter may click the 3MF action, call the authorization endpoint directly,
or reload the model page.

### Provider Adapter Contract

Provider adapters return a small result with these semantics:

- `attempted`: a supported widget was found.
- `completed`: the widget appeared to accept the interaction or produce a
  provider token.
- `provider`: `geetest4` or `turnstile`.
- `reason`: a bounded, non-sensitive diagnostic code.
- `confidence`: optional recognition confidence for GeeTest.

The bridge uses this only to decide whether to wait for a second authorization
response and to emit sanitized diagnostics. Provider tokens and screenshots
never leave the browser operation.

### GeeTest 4 Adapter

The adapter searches the main page and child frames for a visible GeeTest
widget. It identifies:

- one target symbol in the instruction row;
- four similarly sized candidate cells arranged as a 2 by 2 grid.

DOM relationships and geometry are preferred over hard-coding one generated
CSS class. The adapter rejects ambiguous layouts instead of guessing. Each
element screenshot remains an in-memory PNG buffer.

The recognizer is an independently implemented local module at
`app/services/geetest4_recognizer.mjs`. It does not copy code from
`kimbleex/geetest4-dynamic-click-recognizer`, which currently has no license.
It uses `pngjs` to decode Puppeteer screenshots and otherwise relies on local
JavaScript image operations; OpenCV is not added.

Recognition pipeline:

1. Convert each screenshot to grayscale.
2. Separate the darker symbol from its light background.
3. Remove small connected components and large border/background components.
4. Crop to the remaining symbol bounds.
5. Preserve aspect ratio while centering on a fixed normalized canvas.
6. Compare the target with every candidate using perceptual shape similarity,
   binary overlap, and connected-component structure.
7. Require an initial absolute score of at least `0.70` and a best-to-second
   score gap of at least `0.08`. Both values are named constants covered by
   fixture tests and can be recalibrated after live samples without changing
   the adapter contract.
8. Click the center of the original candidate element only after both checks
   pass.

The adapter makes one recognition and click attempt. Layout mismatch, empty
foreground, low confidence, or a close tie returns a fallback result.

### Turnstile Adapter

The adapter detects Cloudflare frames and the standard Turnstile response
field. It first waits for browser-native completion because managed Turnstile
often resolves without input when the browser profile is accepted.

If a visible checkbox-style control is exposed, the adapter performs one real
Puppeteer click and waits again for a non-empty response token or widget
completion. It does not attempt image selection, repeated clicking, page
reloads, or challenge-token synthesis. Any interactive challenge that remains
returns to manual verification.

## Resource and Quota Safety

- The 3MF action is clicked once per authorization operation.
- Provider interaction is attempted once.
- MakerHub never sends an additional authorization request itself.
- Only a retry initiated by the existing MakerWorld page is accepted.
- GeeTest discovery and completion use at most 20 seconds; Turnstile waiting
  and its optional checkbox interaction use at most 30 seconds. Both remain
  within the existing 90-second authorization timeout.
- Screenshots are held in memory and released when the temporary target closes.
- The existing per-platform resource slot continues to serialize operations for
  the same profile.

These constraints prevent the recognizer from turning a failed challenge into
repeated quota-consuming authorization attempts.

## Failure and Status Semantics

Automatic verification is best effort. The original sanitized provider
response remains the fallback value for all failures, including:

- no supported widget found;
- widget layout changed;
- recognition confidence too low;
- provider rejected the click;
- Turnstile required an unsupported interactive challenge;
- no page-generated retry response arrived before timeout.

The archive layer continues to classify such a response as
`verification_required`. It must not clear cookies, mark the profile logged out,
or tell the user to log in again solely because automatic verification failed.

Diagnostics may record provider, attempted/completed flags, bounded reason
codes, score ranges, and elapsed time. They must not record screenshots,
cookies, authorization headers, provider tokens, or raw challenge payloads.

## Testing

Recognizer unit tests use generated fixtures rather than third-party challenge
images and cover:

- exact and lightly scaled symbol matches;
- four-candidate ordering;
- noise removal;
- low absolute confidence;
- an ambiguous top-two result;
- missing foreground;
- invalid candidate count or grid layout.

Bridge tests cover:

- the existing successful first response remains unchanged;
- a recognized verification response invokes one provider adapter;
- successful provider completion returns the page-generated second response;
- adapter failure returns the original verification response;
- the download action is clicked exactly once;
- timeout does not reload the page or call the endpoint directly;
- temporary targets still close on every path;
- returned diagnostics are sanitized.

Regression commands include the focused Node tests, existing
`tests/test_cloakbrowser_session.py`, archive verification tests, the frontend
test suite, and a production frontend build.

Live acceptance is performed separately for CN and Global with a disposable
authorization attempt:

- CN completes a supported GeeTest 4 icon challenge or cleanly falls back.
- Global completes browser-native Turnstile or cleanly falls back.
- A successful verification continues the same archive task.
- No scenario generates more than the initial page request and one
  page-generated post-verification request.

## Rollout

The first release uses `MAKERHUB_AUTO_VERIFY_3MF`, disabled by default, so it can
be enabled on the maintained DSM instance before becoming the default. The
value is parsed with the project's existing boolean environment convention.
The disabled path is behaviorally equivalent to the existing authorization
flow. After both platform checks and quota observations pass, the default can
be changed in a separate release.

## Acceptance Criteria

- Automatic verification runs only for CloakBrowser-backed 3MF authorization.
- MakerWorld CN can complete the supported GeeTest 4 dynamic icon layout when
  confidence is high.
- MakerWorld Global can use browser-native or checkbox-style Turnstile when no
  visual challenge remains.
- The 3MF action is never clicked more than once per operation.
- Unsupported or uncertain challenges fall back to manual browser confirmation.
- Automatic failure is not presented as an expired login.
- No challenge image, token, cookie, or sensitive header is persisted or logged.
- Existing authorization behavior remains available by disabling the rollout
  switch.
- CloakBrowser remains the sole browser session, proxy, and fingerprint owner.
