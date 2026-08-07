import base64
import json
import subprocess
import sys
import unittest

import cv2
import numpy as np

from app.services.makerworld_captcha_vision import (
    _decode_png,
    _foreground_mask,
    solve_click_challenge,
    solve_coordinate_click_challenge,
    solve_request,
    solve_slider_challenge,
)


def png_bytes(image: np.ndarray) -> bytes:
    ok, encoded = cv2.imencode(".png", image)
    assert ok
    return encoded.tobytes()


def png_base64(image: np.ndarray) -> str:
    return base64.b64encode(png_bytes(image)).decode("ascii")


def jpeg_bytes(image: np.ndarray) -> bytes:
    ok, encoded = cv2.imencode(".jpg", image)
    assert ok
    return encoded.tobytes()


def slider_geometry(**overrides) -> dict[str, float]:
    geometry = {
        "image_width": 320,
        "image_height": 160,
        "track_width": 280,
        "track_height": 140,
        "handle_width": 40,
        "piece_offset_x": 10,
        "piece_offset_y": 10,
    }
    geometry.update(overrides)
    return geometry


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


def coordinate_fixture(
    kinds: tuple[str, ...] = ("triangle", "cross", "circle"),
    centers: tuple[tuple[int, int], ...] = ((286, 58), (82, 174), (226, 142)),
) -> tuple[np.ndarray, np.ndarray, list[tuple[float, float]]]:
    target_x = tuple(8 + (72 * index) for index in range(len(kinds)))
    targets = np.full((64, max(224, target_x[-1] + 64), 4), 255, dtype=np.uint8)
    background = np.full((240, 360, 3), 238, dtype=np.uint8)
    for kind, left, center in zip(kinds, target_x, centers, strict=True):
        target = cv2.resize(symbol(kind), (56, 56), interpolation=cv2.INTER_AREA)
        targets[4:60, left:left + 56] = target
        item = cv2.resize(symbol(kind)[:, :, :3], (72, 72), interpolation=cv2.INTER_AREA)
        x = center[0] - 36
        y = center[1] - 36
        background[y:y + 72, x:x + 72] = item
    expected = [(x / 360, y / 240) for x, y in centers]
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

    def test_coordinate_click_accepts_two_targets(self):
        targets, background, expected = coordinate_fixture(
            ("triangle", "circle"),
            ((286, 58), (82, 174)),
        )

        result = solve_coordinate_click_challenge(png_bytes(targets), png_bytes(background))

        self.assertTrue(result["ok"], result)
        self.assertEqual(len(result["points"]), 2)
        for point, (expected_x, expected_y) in zip(result["points"], expected, strict=True):
            self.assertAlmostEqual(point["x"], expected_x, delta=0.04)
            self.assertAlmostEqual(point["y"], expected_y, delta=0.04)

    def test_coordinate_click_rejects_six_inferred_targets(self):
        targets, background, _ = coordinate_fixture(
            ("triangle", "cross", "circle", "square", "triangle", "cross"),
            ((45, 120), (100, 120), (155, 120), (210, 120), (265, 120), (315, 120)),
        )

        result = solve_coordinate_click_challenge(png_bytes(targets), png_bytes(background))

        self.assertEqual(result, {"ok": False, "reason": "target_count_invalid"})

    def test_coordinate_click_rejects_a_duplicated_best_location(self):
        targets, background, _ = coordinate_fixture(
            ("triangle", "triangle"),
            ((286, 58), (82, 174)),
        )
        background[:, :] = 238
        item = cv2.resize(symbol("triangle")[:, :, :3], (72, 72), interpolation=cv2.INTER_AREA)
        background[22:94, 250:322] = item

        result = solve_coordinate_click_challenge(png_bytes(targets), png_bytes(background))

        self.assertFalse(result["ok"])
        self.assertIn(result["reason"], {"coordinate_not_found", "confidence_too_low", "coordinate_ambiguous", "coordinate_invalid"})

    def test_coordinate_click_rejects_equally_strong_background_matches(self):
        targets, background, _ = coordinate_fixture(
            ("triangle", "cross"),
            ((286, 58), (82, 174)),
        )
        item = cv2.resize(symbol("triangle")[:, :, :3], (72, 72), interpolation=cv2.INTER_AREA)
        background[138:210, 46:118] = item

        result = solve_coordinate_click_challenge(png_bytes(targets), png_bytes(background))

        self.assertEqual(result["ok"], False)
        self.assertEqual(result["reason"], "coordinate_ambiguous")

    def test_coordinate_click_rejects_malformed_pngs(self):
        valid_targets, valid_background, _ = coordinate_fixture()
        for targets_png, background_png in ((b"invalid", png_bytes(valid_background)), (png_bytes(valid_targets), b"invalid")):
            with self.subTest(targets_png=targets_png, background_png=background_png):
                result = solve_coordinate_click_challenge(targets_png, background_png)
                self.assertEqual(result, {"ok": False, "reason": "image_format_invalid"})

    def test_solve_request_accepts_coordinate_click_payload(self):
        targets, background, _ = coordinate_fixture()

        result = solve_request(
            {
                "mode": "coordinate_click",
                "targets_png": png_base64(targets),
                "background_png": png_base64(background),
            }
        )

        self.assertTrue(result["ok"], result)

    def test_solve_request_rejects_coordinate_click_sensitive_fields(self):
        targets, background, _ = coordinate_fixture()
        for extra_key in ("cookie", "url"):
            with self.subTest(extra_key=extra_key):
                result = solve_request(
                    {
                        "mode": "coordinate_click",
                        "targets_png": png_base64(targets),
                        "background_png": png_base64(background),
                        extra_key: "forbidden",
                    }
                )
                self.assertEqual(result, {"ok": False, "reason": "unsupported_fields"})

    def test_decode_png_rejects_other_decodable_image_formats(self):
        with self.assertRaisesRegex(ValueError, "^image_format_invalid$"):
            _decode_png(jpeg_bytes(np.full((32, 32, 3), 180, dtype=np.uint8)))

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

    def test_foreground_mask_uses_alpha_for_a_light_piece_with_transparent_padding(self):
        piece = np.zeros((48, 48, 4), dtype=np.uint8)
        cv2.rectangle(piece, (8, 8), (39, 39), (250, 250, 250, 255), -1)

        mask = _foreground_mask(piece)

        self.assertEqual(int(mask[24, 24]), 255)
        self.assertEqual(int(mask[2, 2]), 0)

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
                "background_png": base64.b64encode(b"\x89PNG\r\n\x1a\ninvalid").decode("ascii"),
                "piece_png": png_base64(symbol("triangle")),
                "geometry": slider_geometry(),
            }
        )
        self.assertEqual(invalid_image_result, {"ok": False, "reason": "image_decode_failed"})

    def test_solve_slider_challenge_rejects_invalid_geometry(self):
        background = png_bytes(symbol("square", size=128))
        piece = png_bytes(symbol("triangle", size=32))
        for geometry in ({}, {"track_width": 0}, {"track_width": "320"}):
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
            slider_geometry(),
        )

        self.assertTrue(result["ok"])
        self.assertAlmostEqual(result["distance_css"], 180, delta=6)
        self.assertGreaterEqual(result["confidence"], 0.72)

    def test_slider_subtracts_the_hidden_textured_background_from_a_composited_piece(self):
        y_coords, x_coords = np.indices((160, 320))
        texture = (214 + ((x_coords * 3 + y_coords * 5) % 9)).astype(np.uint8)
        background = cv2.merge((texture, texture, texture))
        cv2.rectangle(background, (206, 54), (246, 94), (120, 120, 120), 2)

        piece_x, piece_y = 24, 54
        visible_piece = background[piece_y:piece_y + 52, piece_x:piece_x + 52].copy()
        cv2.rectangle(visible_piece, (6, 6), (46, 46), (248, 248, 248), -1)

        result = solve_slider_challenge(
            png_bytes(background),
            png_bytes(visible_piece),
            slider_geometry(
                track_width=320,
                track_height=160,
                piece_offset_x=piece_x,
                piece_offset_y=piece_y,
            ),
        )

        self.assertTrue(result["ok"], result)
        self.assertAlmostEqual(result["distance_css"], 206, delta=6)

    def test_slider_rejects_an_opaque_piece_identical_to_the_hidden_background_crop(self):
        background = np.full((160, 320, 3), 245, dtype=np.uint8)
        cv2.rectangle(background, (30, 60), (70, 100), (70, 70, 70), -1)
        piece_x, piece_y = 24, 54
        piece = background[piece_y:piece_y + 52, piece_x:piece_x + 52].copy()

        result = solve_slider_challenge(
            png_bytes(background),
            png_bytes(piece),
            slider_geometry(
                track_width=320,
                track_height=160,
                piece_offset_x=piece_x,
                piece_offset_y=piece_y,
            ),
        )

        self.assertEqual(result, {"ok": False, "reason": "image_foreground_missing"})

    def test_solve_slider_challenge_rejects_missing_or_out_of_range_required_geometry(self):
        result = solve_slider_challenge(
            png_bytes(symbol("square", size=128)),
            png_bytes(symbol("triangle", size=32)),
            {"image_width": 320, "track_width": 280},
        )
        self.assertEqual(result, {"ok": False, "reason": "geometry_invalid"})

        for geometry in (
            slider_geometry(image_width=7),
            slider_geometry(track_width=4097),
            slider_geometry(handle_width=7),
        ):
            with self.subTest(geometry=geometry):
                result = solve_slider_challenge(
                    png_bytes(symbol("square", size=128)),
                    png_bytes(symbol("triangle", size=32)),
                    geometry,
                )
                self.assertEqual(result, {"ok": False, "reason": "geometry_invalid"})

    def test_solve_slider_challenge_rejects_unknown_geometry_fields(self):
        background = png_bytes(symbol("square", size=128))
        piece = png_bytes(symbol("triangle", size=32))
        for extra_key in ("cookie", "token", "url", "unexpected"):
            with self.subTest(extra_key=extra_key):
                result = solve_slider_challenge(
                    background,
                    piece,
                    {**slider_geometry(), extra_key: "forbidden"},
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

    def test_cli_returns_exit_code_zero_for_valid_json_larger_than_stdin_limit(self):
        payload = b'{"mode":"click"}' + (b" " * (24 * 1024 * 1024))
        completed = subprocess.run(
            [sys.executable, "-m", "app.services.makerworld_captcha_vision"],
            input=payload,
            capture_output=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 0)
        self.assertEqual(json.loads(completed.stdout), {"ok": False, "reason": "input_too_large"})
