import base64
import json
import subprocess
import sys
import unittest

import cv2
import numpy as np

from app.services.makerworld_captcha_vision import solve_click_challenge


def png_bytes(image: np.ndarray) -> bytes:
    ok, encoded = cv2.imencode(".png", image)
    assert ok
    return encoded.tobytes()


def symbol(kind: str, *, size: int = 96) -> np.ndarray:
    image = np.full((size, size, 4), 255, dtype=np.uint8)
    color = (20, 20, 20, 255)
    if kind == "triangle":
        cv2.fillPoly(image, [np.array([[48, 14], [14, 78], [82, 78]])], color)
    elif kind == "circle":
        cv2.circle(image, (48, 48), 28, color, -1)
    elif kind == "cross":
        cv2.rectangle(image, (40, 14), (56, 82), color, -1)
        cv2.rectangle(image, (14, 40), (82, 56), color, -1)
    else:
        cv2.rectangle(image, (18, 18), (78, 78), color, -1)
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

    def test_click_rejects_ambiguous_candidates(self):
        triangle = png_bytes(symbol("triangle"))
        result = solve_click_challenge(triangle, [triangle, triangle, png_bytes(symbol("circle")), png_bytes(symbol("cross"))])
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "ambiguous_candidates")
