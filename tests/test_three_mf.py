import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from app.services import three_mf
from app.services.three_mf import (
    describe_three_mf_failure,
    inspect_3mf_file,
    merge_three_mf_failure,
    normalize_three_mf_failure_state,
    parse_3mf_metadata,
    release_three_mf_inspect_cache,
    resolve_model_instance_files,
)


class ThreeMfFailureTest(unittest.TestCase):
    def test_verification_required_wins_over_auth_required_when_merging_failures(self):
        merged = merge_three_mf_failure(
            {
                "state": "auth_required",
                "message": "下载 3MF 需要有效登录态，请检查 Cookie / token 是否过期。",
            },
            {
                "state": "verification_required",
                "message": "MakerWorld 需要验证，前往官网任意下载一个模型。",
            },
        )

        self.assertEqual(merged["state"], "verification_required")

    def test_auth_required_message_is_not_reclassified_as_verification(self):
        message = describe_three_mf_failure("auth_required", source="global")

        self.assertEqual(
            normalize_three_mf_failure_state("missing", message),
            "auth_required",
        )

    def test_auth_required_message_overrides_stale_verification_state(self):
        self.assertEqual(
            normalize_three_mf_failure_state(
                "verification_required",
                "Please log in to download models.",
            ),
            "auth_required",
        )

    def test_linked_browser_logged_out_message_is_auth_required(self):
        self.assertEqual(
            normalize_three_mf_failure_state(
                "",
                "关联的指纹浏览器尚未登录 MakerWorld，请完成浏览器登录后重试。",
            ),
            "auth_required",
        )

    def test_daily_limit_message_overrides_noncanonical_upstream_state(self):
        for message in (
            "今日下载次数已达到上限，请明日再试。",
            "Your daily quota has been exhausted.",
        ):
            with self.subTest(message=message):
                self.assertEqual(
                    normalize_three_mf_failure_state("verification_required", message),
                    "download_limited",
                )

    def test_daily_limit_default_message_does_not_claim_a_midnight_reset(self):
        message = describe_three_mf_failure("download_limited", source="cn")

        self.assertEqual(message, "国区返回了每日下载上限，暂时停止自动重试。")
        self.assertNotIn("今日暂停", message)
        self.assertNotIn("过零点", message)


class ThreeMfMetadataTest(unittest.TestCase):
    def tearDown(self):
        release_three_mf_inspect_cache()

    def test_inspection_cache_evicts_oldest_files(self):
        with tempfile.TemporaryDirectory() as temp_dir, \
                patch.object(three_mf, "_INSPECT_CACHE_MAX_ITEMS", 2):
            root = Path(temp_dir)
            paths = []
            for index in range(3):
                source_path = root / f"model-{index}.3mf"
                with zipfile.ZipFile(source_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                    archive.writestr(
                        "3D/3dmodel.model",
                        f'<model><metadata name="DesignProfileId">{index}</metadata><resources /></model>',
                    )
                paths.append(source_path)
                inspect_3mf_file(source_path)

            cached_paths = list(three_mf._INSPECT_CACHE)

        self.assertEqual(len(cached_paths), 2)
        self.assertNotIn(paths[0].resolve().as_posix(), cached_paths)
        self.assertIn(paths[2].resolve().as_posix(), cached_paths)

    def test_release_inspection_cache_reports_removed_entries(self):
        three_mf._INSPECT_CACHE["model"] = {"signature": (1, 1), "payload": {}}

        self.assertEqual(release_three_mf_inspect_cache(), 1)
        self.assertEqual(release_three_mf_inspect_cache(), 0)

    def test_parser_returns_root_metadata_without_reading_invalid_geometry_tail(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            source_path = Path(temp_dir) / "large.3mf"
            model_xml = (
                b'<?xml version="1.0" encoding="UTF-8"?>'
                b'<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
                b'<metadata name="DesignProfileId">123456</metadata>'
                b'<metadata name="ProfileTitle" value="Fast profile" />'
                b'<resources><object id="1"><mesh><vertices>'
                b'<vertex x="0" y="0" z="0">'
            )
            with zipfile.ZipFile(source_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("3D/3dmodel.model", model_xml)

            metadata = parse_3mf_metadata(source_path)

        self.assertEqual(metadata["DesignProfileId"], "123456")
        self.assertEqual(metadata["ProfileTitle"], "Fast profile")

    def test_exact_file_name_match_does_not_inspect_three_mf_xml(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            model_root = Path(temp_dir)
            instances_dir = model_root / "instances"
            instances_dir.mkdir()
            (instances_dir / "profile.3mf").write_bytes(b"not-a-zip")
            meta = {
                "instances": [
                    {
                        "id": "123456",
                        "fileName": "profile.3mf",
                    }
                ]
            }

            with patch(
                "app.services.three_mf.inspect_3mf_file",
                side_effect=AssertionError("exact file matches must not parse 3MF XML"),
            ):
                resolved = resolve_model_instance_files(meta, model_root)

        self.assertEqual(resolved["matches"][0]["reason"], "exact_file_name")
        self.assertEqual(resolved["unmatched_instance_indexes"], [])


if __name__ == "__main__":
    unittest.main()
