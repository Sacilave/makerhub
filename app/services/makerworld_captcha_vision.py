from __future__ import annotations

import base64
import binascii
import json
import sys
from typing import Any

import cv2
import numpy as np


MAX_IMAGE_BYTES = 4 * 1024 * 1024
MAX_IMAGE_DIMENSION = 2048
MAX_CANDIDATES = 6
CLICK_CONFIDENCE_MIN = 0.70
CLICK_MARGIN_MIN = 0.08
SLIDER_CONFIDENCE_MIN = 0.72
SLIDER_MARGIN_MIN = 0.06
MAX_STDIN_BYTES = 24 * 1024 * 1024
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

_NORMALIZED_SIZE = 96
_SLIDER_SCALES = (0.90, 0.95, 1.00, 1.05, 1.10)
_SLIDER_GEOMETRY_FIELDS = {"image_width", "track_width", "handle_width"}
ALLOWED_REQUEST_FIELDS = {
    "mode",
    "target_png",
    "candidate_pngs",
    "background_png",
    "piece_png",
    "geometry",
}
_REQUEST_FIELDS_BY_MODE = {
    "click": {"mode", "target_png", "candidate_pngs"},
    "slider": {"mode", "background_png", "piece_png", "geometry"},
}


def _decode_png(raw: bytes) -> np.ndarray:
    if not raw or len(raw) > MAX_IMAGE_BYTES:
        raise ValueError("image_size_invalid")
    if not raw.startswith(_PNG_SIGNATURE):
        raise ValueError("image_format_invalid")
    image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_UNCHANGED)
    if image is None or image.ndim not in {2, 3}:
        raise ValueError("image_decode_failed")
    height, width = image.shape[:2]
    if min(width, height) < 8 or max(width, height) > MAX_IMAGE_DIMENSION:
        raise ValueError("image_dimensions_invalid")
    return image


def _decode_base64_png(value: Any) -> bytes:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("image_base64_invalid")
    raw = value.strip()
    if raw.startswith("data:"):
        _, separator, raw = raw.partition(",")
        if not separator:
            raise ValueError("image_base64_invalid")
    try:
        return base64.b64decode(raw, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("image_base64_invalid") from exc


def _foreground_mask(image: np.ndarray) -> np.ndarray:
    if image.ndim == 2:
        gray = image
    elif image.shape[2] == 4:
        gray = cv2.cvtColor(image, cv2.COLOR_BGRA2GRAY)
    else:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    _, mask = cv2.threshold(gray, 235, 255, cv2.THRESH_BINARY_INV)
    if image.ndim == 3 and image.shape[2] == 4:
        alpha_mask = image[:, :, 3] > 0
        mask = np.where(alpha_mask, mask, 0).astype(np.uint8)
    return _remove_border_components(mask)


def _remove_border_components(mask: np.ndarray) -> np.ndarray:
    binary = np.where(mask > 0, 255, 0).astype(np.uint8)
    component_count, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    if component_count <= 1:
        return binary
    height, width = binary.shape
    cleaned = np.zeros_like(binary)
    kept = 0
    for label in range(1, component_count):
        x, y, w, h, _ = stats[label]
        touches_border = x == 0 or y == 0 or x + w >= width or y + h >= height
        if touches_border:
            continue
        cleaned[labels == label] = 255
        kept += 1
    return cleaned if kept else binary


def _crop_mask(mask: np.ndarray) -> np.ndarray:
    points = cv2.findNonZero(mask)
    if points is None:
        raise ValueError("image_foreground_missing")
    x, y, width, height = cv2.boundingRect(points)
    return mask[y:y + height, x:x + width]


def _normalize_mask(mask: np.ndarray, size: int = _NORMALIZED_SIZE) -> np.ndarray:
    cropped = _crop_mask(mask)
    height, width = cropped.shape
    scale = (size - 8) / max(height, width)
    scaled_width = max(1, int(round(width * scale)))
    scaled_height = max(1, int(round(height * scale)))
    interpolation = cv2.INTER_AREA if scale < 1.0 else cv2.INTER_NEAREST
    resized = cv2.resize(cropped, (scaled_width, scaled_height), interpolation=interpolation)
    canvas = np.zeros((size, size), dtype=np.uint8)
    offset_x = (size - scaled_width) // 2
    offset_y = (size - scaled_height) // 2
    canvas[offset_y:offset_y + scaled_height, offset_x:offset_x + scaled_width] = resized
    return np.where(canvas > 127, 255, 0).astype(np.uint8)


def _edge_mask(mask: np.ndarray) -> np.ndarray:
    return np.where(cv2.Canny(mask, 64, 160) > 0, 255, 0).astype(np.uint8)


def _binary_iou(left: np.ndarray, right: np.ndarray) -> float:
    left_bool = left > 0
    right_bool = right > 0
    union = np.logical_or(left_bool, right_bool).sum()
    if union == 0:
        return 0.0
    intersection = np.logical_and(left_bool, right_bool).sum()
    return float(intersection / union)


def _edge_overlap(left: np.ndarray, right: np.ndarray) -> float:
    left_edge = _edge_mask(left)
    right_edge = _edge_mask(right)
    left_points = left_edge > 0
    right_points = right_edge > 0
    if not left_points.any() or not right_points.any():
        return 0.0
    left_distance = cv2.distanceTransform(np.where(left_points, 0, 255).astype(np.uint8), cv2.DIST_L2, 3)
    right_distance = cv2.distanceTransform(np.where(right_points, 0, 255).astype(np.uint8), cv2.DIST_L2, 3)
    tolerance = 3.0
    left_match = float((right_distance[left_points] <= tolerance).sum() / left_points.sum())
    right_match = float((left_distance[right_points] <= tolerance).sum() / right_points.sum())
    return (left_match + right_match) / 2.0


def _hu_similarity(left: np.ndarray, right: np.ndarray) -> float:
    left_hu = cv2.HuMoments(cv2.moments(left)).flatten()
    right_hu = cv2.HuMoments(cv2.moments(right)).flatten()
    scale = max(float(np.linalg.norm(left_hu)), float(np.linalg.norm(right_hu)), 1e-12)
    distance = float(np.linalg.norm(left_hu - right_hu)) / scale
    return max(0.0, 1.0 - distance)


def _clamp_score(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def _normalized_symbol(raw: bytes) -> np.ndarray:
    image = _decode_png(raw)
    return _normalize_mask(_foreground_mask(image))


def _slider_geometry(geometry: dict[str, Any]) -> tuple[float, float, float]:
    if not isinstance(geometry, dict) or set(geometry) != _SLIDER_GEOMETRY_FIELDS:
        raise ValueError("geometry_invalid")
    values: list[float] = []
    for name in ("image_width", "track_width", "handle_width"):
        value = geometry.get(name)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not 8 <= value <= 4096:
            raise ValueError("geometry_invalid")
        values.append(float(value))
    image_width, track_width, handle_width = values
    if handle_width > track_width:
        raise ValueError("geometry_invalid")
    return image_width, track_width, handle_width


def _grayscale(image: np.ndarray) -> np.ndarray:
    if image.ndim == 2:
        return image
    if image.shape[2] == 4:
        return cv2.cvtColor(image, cv2.COLOR_BGRA2GRAY)
    return cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)


def _slider_edge_overlap(template_edges: np.ndarray, patch_edges: np.ndarray) -> float:
    template_points = template_edges > 0
    patch_points = patch_edges > 0
    if not template_points.any() or not patch_points.any():
        return 0.0
    template_distance = cv2.distanceTransform(
        np.where(template_points, 0, 255).astype(np.uint8), cv2.DIST_L2, 3,
    )
    patch_distance = cv2.distanceTransform(
        np.where(patch_points, 0, 255).astype(np.uint8), cv2.DIST_L2, 3,
    )
    tolerance = 2.5
    template_match = float((patch_distance[template_points] <= tolerance).sum() / template_points.sum())
    patch_match = float((template_distance[patch_points] <= tolerance).sum() / patch_points.sum())
    return (template_match + patch_match) / 2.0


def _slider_score(
    background_edges: np.ndarray,
    template_edges: np.ndarray,
    x: int,
    y: int,
    template_score: float,
) -> float:
    height, width = template_edges.shape
    patch = background_edges[y:y + height, x:x + width]
    overlap = _slider_edge_overlap(template_edges, patch)
    return _clamp_score((0.65 * max(0.0, template_score)) + (0.35 * overlap))


def _best_slider_location(
    background_edges: np.ndarray,
    piece_edges: np.ndarray,
) -> tuple[float, int, int, np.ndarray, float, int, int, np.ndarray] | None:
    matches: list[tuple[np.ndarray, np.ndarray]] = []
    best: tuple[float, int, int, np.ndarray] | None = None
    for scale in _SLIDER_SCALES:
        template = cv2.resize(
            piece_edges,
            None,
            fx=scale,
            fy=scale,
            interpolation=cv2.INTER_NEAREST,
        )
        template_height, template_width = template.shape
        background_height, background_width = background_edges.shape
        if template_height > background_height or template_width > background_width:
            continue
        response = cv2.matchTemplate(background_edges, template, cv2.TM_CCOEFF_NORMED)
        matches.append((response, template))
        _, score, _, location = cv2.minMaxLoc(response)
        candidate = (float(score), location[0], location[1], template)
        if best is None or candidate[0] > best[0]:
            best = candidate
    if best is None:
        return None

    best_score, best_x, best_y, best_template = best
    second: tuple[float, int, int, np.ndarray] | None = None
    suppression_radius = max(best_template.shape) // 2
    for response, template in matches:
        suppressed = response.copy()
        left = max(0, best_x - suppression_radius)
        right = min(suppressed.shape[1], best_x + suppression_radius + 1)
        top = max(0, best_y - suppression_radius)
        bottom = min(suppressed.shape[0], best_y + suppression_radius + 1)
        suppressed[top:bottom, left:right] = -1.0
        _, score, _, location = cv2.minMaxLoc(suppressed)
        candidate = (float(score), location[0], location[1], template)
        if second is None or candidate[0] > second[0]:
            second = candidate
    if second is None:
        return None
    second_score, second_x, second_y, second_template = second
    return (
        best_score,
        best_x,
        best_y,
        best_template,
        second_score,
        second_x,
        second_y,
        second_template,
    )


def solve_click_challenge(target_png: bytes, candidate_pngs: list[bytes]) -> dict[str, Any]:
    if not 2 <= len(candidate_pngs) <= MAX_CANDIDATES:
        return {"ok": False, "reason": "candidate_count_invalid"}
    try:
        target_mask = _normalized_symbol(target_png)
        candidate_masks = [_normalized_symbol(raw) for raw in candidate_pngs]
    except ValueError as exc:
        return {"ok": False, "reason": str(exc)}

    scored_candidates: list[tuple[float, int]] = []
    for index, candidate_mask in enumerate(candidate_masks):
        binary_iou = _binary_iou(target_mask, candidate_mask)
        edge_overlap = _edge_overlap(target_mask, candidate_mask)
        hu_similarity = _hu_similarity(target_mask, candidate_mask)
        score = _clamp_score((0.50 * binary_iou) + (0.30 * edge_overlap) + (0.20 * hu_similarity))
        scored_candidates.append((score, index))
    scored_candidates.sort(key=lambda item: item[0], reverse=True)
    best_score, best_index = scored_candidates[0]
    second_score = scored_candidates[1][0] if len(scored_candidates) > 1 else 0.0
    margin = _clamp_score(best_score - second_score)
    result = {
        "ok": False,
        "candidate_index": best_index,
        "confidence": round(best_score, 4),
        "margin": round(margin, 4),
    }
    if best_score < CLICK_CONFIDENCE_MIN:
        result["reason"] = "confidence_too_low"
        return result
    if margin < CLICK_MARGIN_MIN:
        result["reason"] = "ambiguous_candidates"
        return result
    result["ok"] = True
    return result


def solve_slider_challenge(background_png: bytes, piece_png: bytes, geometry: dict[str, Any]) -> dict[str, Any]:
    try:
        image_width, track_width, handle_width = _slider_geometry(geometry)
        background = _decode_png(background_png)
        piece = _decode_png(piece_png)
    except ValueError as exc:
        return {"ok": False, "reason": str(exc)}
    try:
        piece_edges = _crop_mask(cv2.Canny(_foreground_mask(piece), 64, 160))
    except ValueError as exc:
        return {"ok": False, "reason": str(exc)}

    background_edges = cv2.Canny(_grayscale(background), 64, 160)
    match = _best_slider_location(background_edges, piece_edges)
    if match is None:
        return {"ok": False, "reason": "gap_not_found"}
    (
        template_score,
        gap_left,
        gap_top,
        template,
        second_template_score,
        second_left,
        second_top,
        second_template,
    ) = match
    confidence = _slider_score(background_edges, template, gap_left, gap_top, template_score)
    second_confidence = _slider_score(
        background_edges,
        second_template,
        second_left,
        second_top,
        second_template_score,
    )
    margin = _clamp_score(confidence - second_confidence)
    gap_x = gap_left + (template.shape[1] / 2.0)
    distance_css = (gap_x * track_width / image_width) - (handle_width / 2.0)
    result = {
        "ok": False,
        "distance_css": round(distance_css, 2),
        "confidence": round(confidence, 4),
        "margin": round(margin, 4),
    }
    if not 0 <= distance_css <= track_width - handle_width:
        result["reason"] = "distance_invalid"
        return result
    if confidence < SLIDER_CONFIDENCE_MIN:
        result["reason"] = "confidence_too_low"
        return result
    if margin < SLIDER_MARGIN_MIN:
        result["reason"] = "ambiguous_gap"
        return result
    result["ok"] = True
    return result


def solve_request(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {"ok": False, "reason": "payload_invalid"}
    if set(payload) - ALLOWED_REQUEST_FIELDS:
        return {"ok": False, "reason": "unsupported_fields"}
    raw_mode = payload.get("mode")
    mode = raw_mode.strip().lower() if isinstance(raw_mode, str) else ""
    allowed_fields = _REQUEST_FIELDS_BY_MODE.get(mode)
    if allowed_fields is None:
        return {"ok": False, "reason": "mode_invalid"}
    unknown_fields = set(payload.keys()) - allowed_fields
    if unknown_fields:
        return {"ok": False, "reason": "unsupported_fields"}
    try:
        if mode == "click":
            target_png = _decode_base64_png(payload.get("target_png"))
            candidate_values = payload.get("candidate_pngs")
            if not isinstance(candidate_values, list):
                return {"ok": False, "reason": "candidate_count_invalid"}
            candidate_pngs = [_decode_base64_png(item) for item in candidate_values]
            return solve_click_challenge(target_png, candidate_pngs)
        background_png = _decode_base64_png(payload.get("background_png"))
        piece_png = _decode_base64_png(payload.get("piece_png"))
        return solve_slider_challenge(background_png, piece_png, payload.get("geometry"))
    except ValueError as exc:
        return {"ok": False, "reason": str(exc)}


def main() -> int:
    raw_input = sys.stdin.buffer.read(MAX_STDIN_BYTES + 1)
    if len(raw_input) > MAX_STDIN_BYTES:
        print(json.dumps({"ok": False, "reason": "input_too_large"}, separators=(",", ":")))
        return 0
    try:
        payload = json.loads(raw_input)
    except (UnicodeDecodeError, json.JSONDecodeError):
        print(json.dumps({"ok": False, "reason": "json_invalid"}, separators=(",", ":")))
        return 2
    try:
        result = solve_request(payload)
    except Exception:
        result = {"ok": False, "reason": "request_invalid"}
    print(json.dumps(result, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
