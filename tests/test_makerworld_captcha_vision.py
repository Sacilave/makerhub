import base64
import json
import subprocess
import sys
import unittest

import cv2
import numpy as np

from app.services.makerworld_captcha_vision import solve_click_challenge, solve_request, solve_slider_challenge


def png_bytes(image: np.ndarray) -> bytes:
    ok, encoded = cv2.imencode(".png", image)
    assert ok
    return encoded.tobytes()


def png_base64(image: np.ndarray) -> str:
    return base64.b64encode(png_bytes(image)).decode("ascii")


def _scale_point(x: int, y: int, *, size: int) -> tuple[int, int]:
    scale = size / 96.0
    return int(round(x * scale)), int(round(y * scale))


def symbol(kind: str, *, size: int = 96) -> np.ndarray:
    image = np.full((size, size, 4), 255, dtype=np.uint8)
    color = (20, 20, 20, 255)
    if kind == "triangle":
        points = np.array([
            _scale_point(48, 14, size=size),
            _scale_point(14, 78, size=size),
            _scale_point(82, 78, size=size),
        ])
        cv2.fillPoly(image, [points], color)
    elif kind == "circle":
        center = _scale_point(48, 48, size=size)
        radius = max(2, int(round(28 * size / 96.0)))
        cv2.circle(image, center, radius, color, -1)
    elif kind == "cross":
        cv2.rectangle(image, _scale_point(40, 14, size=size), _scale_point(56, 82, size=size), color, -1)
        cv2.rectangle(image, _scale_point(14, 40, size=size), _scale_point(82, 56, size=size), color, -1)
    else:
        cv2.rectangle(image, _scale_point(18, 18, size=size), _scale_point(78, 78, size=size), color, -1)
    return image


class MakerWorldCaptchaVisionTest(unittest.TestCase):
    def test_click_selects_scaled_shape_with_confident_margin(self):
        result = solve_click_challenge(
            png_bytes(symbol("triangle", size=72)),
            [png_bytes(symbol(name)) for name in ("circle", "square", "triangle", "cross")],
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["candidate_index"], 2)
        self.assertGreaterEqual(result["confidence"], 0.70)
        self.assertGreaterEqual(result["margin"], 0.08)

    def test_click_matches_small_and_large_triangle_targets(self):
        for size in (32, 160):
            with self.subTest(size=size):
                result = solve_click_challenge(
                    png_bytes(symbol("triangle", size=size)),
                    [png_bytes(symbol(name)) for name in ("circle", "square", "triangle", "cross")],
                )
                self.assertTrue(result["ok"])
                self.assertEqual(result["candidate_index"], 2)
                self.assertGreaterEqual(result["confidence"], 0.70)
                self.assertGreaterEqual(result["margin"], 0.08)

    def test_click_rejects_ambiguous_candidates(self):
        triangle = png_bytes(symbol("triangle"))
        result = solve_click_challenge(
            triangle,
            [triangle, triangle, png_bytes(symbol("circle")), png_bytes(symbol("cross"))],
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "ambiguous_candidates")

    def test_solve_request_accepts_click_payload_with_base64_pngs(self):
        result = solve_request(
            {
                "mode": "click",
                "target_png": png_base64(symbol("triangle", size=72)),
                "candidate_pngs": [png_base64(symbol(name)) for name in ("circle", "square", "triangle", "cross")],
            }
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["candidate_index"], 2)

    def test_solve_request_rejects_unknown_or_sensitive_top_level_fields(self):
        for extra_key in ("url", "URL", "browser_url", "Cookies", "unexpected"):
            with self.subTest(extra_key=extra_key):
                payload = {
                    "mode": "click",
                    "target_png": png_base64(symbol("triangle")),
                    "candidate_pngs": [png_base64(symbol(name)) for name in ("circle", "square", "triangle", "cross")],
                    extra_key: "forbidden",
                }
                result = solve_request(payload)
                self.assertEqual(result, {"ok": False, "reason": "unsupported_fields"})

    def test_solve_request_rejects_invalid_base64_and_invalid_images(self):
        invalid_base64_result = solve_request(
            {
                "mode": "click",
                "target_png": "not-base64",
                "candidate_pngs": [png_base64(symbol("triangle")), png_base64(symbol("circle"))],
            }
        )
        self.assertEqual(invalid_base64_result, {"ok": False, "reason": "image_base64_invalid"})

        invalid_image_result = solve_request(
            {
                "mode": "slider",
                "background_png": base64.b64encode(b"not-a-png").decode("ascii"),
                "piece_png": png_base64(symbol("triangle")),
                "geometry": {"image_width": 320, "track_width": 280, "handle_width": 40},
            }
        )
        self.assertEqual(invalid_image_result, {"ok": False, "reason": "image_decode_failed"})

    def test_solve_slider_challenge_rejects_invalid_geometry(self):
        background = png_bytes(symbol("square", size=128))
        piece = png_bytes(symbol("triangle", size=32))
        for geometry in ({}, {"track_width": 320, "piece_width": 0}, {"track_width": "320", "piece_width": 48}):
            with self.subTest(geometry=geometry):
                result = solve_slider_challenge(background, piece, geometry)
                self.assertEqual(result, {"ok": False, "reason": "geometry_invalid"})

    def test_slider_returns_css_distance_after_image_scale_conversion(self):
        background = np.full((160, 320, 3), 235, dtype=np.uint8)
        piece = np.zeros((52, 52, 4), dtype=np.uint8)
        cv2.rectangle(piece, (6, 6), (46, 46), (80, 80, 80, 255), -1)
        cv2.rectangle(background, (206, 54), (246, 94), (150, 150, 150), 2)

        result = solve_slider_challenge(
            png_bytes(background),
            png_bytes(piece),
            {"image_width": 320, "track_width": 280, "handle_width": 40},
        )

        self.assertTrue(result["ok"])
        self.assertAlmostEqual(result["distance_css"], 180, delta=6)
        self.assertGreaterEqual(result["confidence"], 0.72)

    def test_solve_slider_challenge_rejects_missing_or_out_of_range_required_geometry(self):
        result = solve_slider_challenge(
            png_bytes(symbol("square", size=128)),
            png_bytes(symbol("triangle", size=32)),
            {"image_width": 320, "track_width": 280},
        )
        self.assertEqual(result, {"ok": False, "reason": "geometry_invalid"})

        for geometry in (
            {"image_width": 7, "track_width": 280, "handle_width": 40},
            {"image_width": 320, "track_width": 4097, "handle_width": 40},
            {"image_width": 320, "track_width": 280, "handle_width": 7},
        ):
            with self.subTest(geometry=geometry):
                result = solve_slider_challenge(
                    png_bytes(symbol("square", size=128)),
                    png_bytes(symbol("triangle", size=32)),
                    geometry,
                )
                self.assertEqual(result, {"ok": False, "reason": "geometry_invalid"})

    def test_solve_request_keeps_mode_specific_fields_restricted(self):
        result = solve_request(
            {
                "mode": "click",
                "target_png": png_base64(symbol("triangle")),
                "candidate_pngs": [png_base64(symbol("triangle")), png_base64(symbol("circle"))],
                "geometry": {"image_width": 320, "track_width": 280, "handle_width": 40},
            }
        )
        self.assertEqual(result, {"ok": False, "reason": "unsupported_fields"})

    def test_cli_rejects_secret_shaped_fields(self):
        payload = {"mode": "slider", "cookie": "secret", "background_png": "", "piece_png": "", "geometry": {}}
        completed = subprocess.run(
            [sys.executable, "-m", "app.services.makerworld_captcha_vision"],
            input=json.dumps(payload),
            text=True,
            capture_output=True,
            check=False,
        )
        output = json.loads(completed.stdout)
        self.assertFalse(output["ok"])
        self.assertEqual(output["reason"], "unsupported_fields")
        self.assertNotIn("secret", completed.stdout + completed.stderr)

    def test_cli_returns_exit_code_two_for_malformed_json(self):
        completed = subprocess.run(
            [sys.executable, "-m", "app.services.makerworld_captcha_vision"],
            input="{",
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 2)
        self.assertEqual(json.loads(completed.stdout), {"ok": False, "reason": "json_invalid"})
