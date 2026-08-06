from __future__ import annotations

import base64
import binascii
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

_NORMALIZED_SIZE = 96
_REQUEST_FIELDS_BY_MODE = {
    "click": {"mode", "target_png", "candidate_pngs"},
    "slider": {"mode", "background_png", "piece_png", "geometry"},
}


def _decode_png(raw: bytes) -> np.ndarray:
    if not raw or len(raw) > MAX_IMAGE_BYTES:
        raise ValueError("image_size_invalid")
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
        _decode_png(background_png)
        _decode_png(piece_png)
    except ValueError as exc:
        return {"ok": False, "reason": str(exc)}
    if not isinstance(geometry, dict) or not geometry:
        return {"ok": False, "reason": "geometry_invalid"}
    invalid_geometry = any(
        not isinstance(value, (int, float)) or value <= 0
        for value in geometry.values()
    )
    if invalid_geometry:
        return {"ok": False, "reason": "geometry_invalid"}
    return {"ok": False, "reason": "slider_not_supported"}


def solve_request(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {"ok": False, "reason": "payload_invalid"}
    mode = str(payload.get("mode") or "").strip().lower()
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
