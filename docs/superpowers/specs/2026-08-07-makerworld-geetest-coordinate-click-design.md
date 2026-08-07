# MakerWorld GeeTest Coordinate Click Design

## Purpose

Fix MakerHub's automatic verification for the GeeTest challenge used by
MakerWorld CN. The real challenge shows an ordered sequence of target symbols
and a single background image containing multiple matching symbols. MakerHub
must click the matching positions in target order and then confirm. It must not
classify this layout as a slider or assume that each candidate is a separate
DOM element.

This design amends the click-challenge assumptions in
`2026-08-06-makerworld-automatic-verification-design.md`. The existing slider
and Turnstile designs remain unchanged.

## Scope

In scope:

- Detect a visible coordinate-click challenge before attempting slider
  detection.
- Require a target-symbol region, one clickable background region, and a
  visible confirmation control that belong to the same GeeTest container.
- Capture only those regions as in-memory PNG images.
- Use the existing local OpenCV subprocess to locate every target symbol in
  the background image.
- Return an ordered list of image-relative coordinates and bounded confidence
  values.
- Convert image coordinates to viewport coordinates and dispatch trusted CDP
  mouse clicks in the requested order.
- Click the confirmation control only after every coordinate has been
  validated and clicked.
- Fall back to the existing manual browser flow without clicking when the
  layout, target count, image geometry, or confidence is invalid.
- Keep the existing limit of at most two provider interactions, where a second
  interaction is allowed only after GeeTest visibly replaces the challenge.

Out of scope:

- Uploading screenshots to OpenAI or another external service.
- Persisting challenge images or adding screenshots to logs.
- Replacing CloakBrowser, changing account state, or changing the archive
  scheduler.
- Blind clicks, repeated confirmation clicks, or retries against an unchanged
  challenge.
- Changing the existing slider or Turnstile recognition algorithms.

## Root Cause

The current discovery path checks for a slider before checking for a click
challenge. GeeTest's coordinate-click layout exposes generated classes that
also match the broad slider selectors, so MakerHub returns a `slider`
challenge and eventually reports `distance_invalid`.

The existing click path cannot serve as a fallback. It expects one target
element plus two to six separate candidate elements, calls
`solve_click_challenge`, and clicks only one candidate. The real challenge has
one background image and requires multiple ordered clicks followed by a
confirmation action.

## Architecture

### Browser Discovery

`cloakbrowser_verification.mjs` adds a distinct `coordinate_click` challenge
type. For each visible GeeTest container, discovery evaluates challenge types
in this order:

1. coordinate click;
2. the existing independent-candidate icon click;
3. slider.

A coordinate-click layout is accepted only when its target region, background
region, and confirmation control are visible, have valid non-overlapping
geometry, and are contained by the same visible GeeTest container. Broad
class-name matches alone are insufficient. This prevents ordinary slider
parts from being treated as coordinate-click controls and prevents the current
coordinate-click background from being treated as a slider.

### Vision Contract

The Python subprocess adds a `coordinate_click` request mode:

```json
{
  "mode": "coordinate_click",
  "targets_png": "<base64 PNG>",
  "background_png": "<base64 PNG>"
}
```

It returns only bounded diagnostic data:

```json
{
  "ok": true,
  "points": [
    {"x": 0.21, "y": 0.67, "confidence": 0.88},
    {"x": 0.74, "y": 0.35, "confidence": 0.84},
    {"x": 0.48, "y": 0.79, "confidence": 0.81}
  ],
  "confidence": 0.81,
  "margin": 0.10
}
```

Coordinates are normalized to `0..1` relative to the background screenshot.
The subprocess rejects unknown fields and never receives cookies, URLs,
headers, tokens, browser credentials, or account identifiers. The target count
is inferred from the target strip and limited to two through five. Every
returned point must be finite, in-bounds, and sufficiently separated from the
other points.

### OpenCV Recognition

The recognizer performs these bounded steps:

1. Decode and validate both PNG images using the existing size limits.
2. Segment the ordered target strip into two through five symbols using alpha,
   foreground masks, connected components, and horizontal ordering.
3. Build grayscale, edge, and color-normalized representations for each target
   and the background.
4. Search the background at a bounded set of scales using masked template
   matching and edge agreement.
5. Apply non-maximum suppression so two targets cannot resolve to the same
   location.
6. Score each winner from template correlation, edge overlap, and winner
   margin.
7. Reject the complete result when any target is below its confidence or
   margin threshold; partial coordinate lists are never returned as success.
8. Preserve the target strip's left-to-right order in the returned point list.

The first implementation uses generated fixtures to establish conservative
thresholds. Real challenges that do not produce an unambiguous match fall back
to manual confirmation rather than weakening the thresholds or guessing.

### Browser Interaction

Node validates the Python result before moving the mouse:

- the number of points must be between two and five and equal the number of
  targets segmented by the recognizer;
- every coordinate and confidence must be finite and bounded;
- converted points must stay within the current background element;
- points must remain distinct after conversion;
- the challenge fingerprint and element geometry must be unchanged since the
  screenshots were captured.

After validation, MakerHub creates one CDP mouse session, clicks each point in
order with short bounded delays, and clicks the confirmation control once. It
then uses the existing outcome watcher. A successful provider state completes
the attempt; a replaced challenge may receive one final attempt; an unchanged
or rejected challenge returns to manual verification.

## Error Handling And Privacy

New failures use bounded reason codes such as `target_count_invalid`,
`target_segmentation_failed`, `coordinate_invalid`, `coordinate_ambiguous`,
and `confirmation_unavailable`. Logs continue to expose only the provider,
challenge type, attempt count, reason, and aggregate confidence. Raw images,
coordinates, DOM text, and subprocess stderr are not persisted or returned to
the API.

Timeout and abort behavior follows the existing shared verification deadline.
An abort closes the CDP session and prevents any remaining point or confirmation
click. A subprocess timeout falls back without interaction.

## Testing

Python tests generate target strips and cluttered backgrounds in memory. They
cover ordered multi-target success, scale differences, duplicate-location
rejection, ambiguous matches, invalid inferred target counts, invalid images,
unsupported fields, and CLI output sanitization.

Node tests cover coordinate-click precedence over slider-like selectors,
layout validation, strict subprocess payloads, coordinate conversion at
fractional device scale, ordered CDP events, confirmation timing, changed
fingerprints, malformed recognizer output, timeout cleanup, and diagnostic
sanitization. Existing icon-click, slider, Turnstile, bridge, release-contract,
and Python suites must remain green.

## Success Criteria

- The real MakerWorld coordinate-click layout is no longer reported as a
  slider with `distance_invalid`.
- A generated multi-target challenge produces the correct ordered click
  coordinates and exactly one confirmation click.
- No click occurs when any target is ambiguous or the page geometry changes.
- Automatic failure continues into the existing manual browser-verification
  flow without marking the account as logged out.
- No challenge image or sensitive browser data is persisted or uploaded.
