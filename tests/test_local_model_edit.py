import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from app.services import catalog, local_model_edit
from tests.test_helpers import InMemoryDatabaseState


def _upload(filename: str, data: bytes, content_type: str = "application/octet-stream"):
    return SimpleNamespace(filename=filename, file=io.BytesIO(data), content_type=content_type)


class LocalModelEditTest(unittest.TestCase):
    def setUp(self):
        self.db_state = InMemoryDatabaseState()
        self.db_state.__enter__()

    def tearDown(self):
        self.db_state.__exit__(None, None, None)

    def _write_local_model(self, root: Path) -> Path:
        model_root = root / "LOCAL_Test"
        (model_root / "instances").mkdir(parents=True)
        (model_root / "images").mkdir()
        (model_root / "instances" / "body.stl").write_bytes(b"solid body\nendsolid body\n")
        (model_root / "images" / "cover.jpg").write_bytes(b"fake-jpeg")
        meta = {
            "title": "Test",
            "source": "local",
            "cover": "images/cover.jpg",
            "designImages": [{"relPath": "images/cover.jpg"}],
            "summary": {"text": "old", "html": "<p>old</p>"},
            "stats": {"comments": 0},
            "comments": [],
            "attachments": [],
            "instances": [
                {
                    "id": "local-1",
                    "title": "body",
                    "fileName": "body.stl",
                    "fileKind": "STL",
                    "thumbnailLocal": "images/cover.jpg",
                    "pictures": [{"relPath": "images/cover.jpg"}],
                }
            ],
            "localImport": {
                "modelFileCount": 1,
            },
        }
        (model_root / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
        return model_root

    def test_edit_description_and_add_delete_files_and_images(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive_root = Path(tmp).resolve()
            model_root = self._write_local_model(archive_root)
            with patch.object(local_model_edit, "ARCHIVE_DIR", archive_root), \
                patch.object(catalog, "ARCHIVE_DIR", archive_root):
                local_model_edit.update_local_model_description("LOCAL_Test", "1\n2\n\n3\n4")
                added_file = local_model_edit.add_local_model_file(
                    "LOCAL_Test",
                    _upload("extra.3mf", b"3mf-data"),
                )
                added_image = local_model_edit.add_local_model_image(
                    "LOCAL_Test",
                    _upload("side.png", b"png-data", content_type="image/png"),
                )
                detail = catalog.get_model_detail("LOCAL_Test")

                self.assertEqual(detail["summary_text"], "1\n2\n\n3\n4")
                self.assertIn("1<br", detail["summary_html"])
                self.assertIn("3<br", detail["summary_html"])
                self.assertEqual(len(detail["instances"]), 2)
                self.assertTrue((model_root / "instances" / "extra.3mf").exists())
                self.assertTrue((model_root / "images" / "side.png").exists())
                meta = json.loads((model_root / "meta.json").read_text(encoding="utf-8"))
                self.assertEqual(meta["localImport"]["modelFileCount"], 2)

                local_model_edit.delete_local_model_file("LOCAL_Test", added_file["id"])
                local_model_edit.delete_local_model_image("LOCAL_Test", added_image["relPath"])
                detail = catalog.get_model_detail("LOCAL_Test")

            self.assertEqual(len(detail["instances"]), 1)
            self.assertEqual(len(detail["gallery"]), 1)
            self.assertFalse((model_root / "instances" / "extra.3mf").exists())
            self.assertFalse((model_root / "images" / "side.png").exists())

    def test_saved_description_html_newlines_render_after_reload(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive_root = Path(tmp).resolve()
            model_root = self._write_local_model(archive_root)
            meta_path = model_root / "meta.json"
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            meta["summary"] = {
                "text": "1\n2\n3",
                "html": "<p>1\n2\n3</p>",
            }
            meta_path.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")

            with patch.object(catalog, "ARCHIVE_DIR", archive_root):
                detail = catalog.get_model_detail("LOCAL_Test")

            self.assertEqual(detail["summary_text"], "1\n2\n3")
            self.assertIn("1<br", detail["summary_html"])
            self.assertIn("2<br", detail["summary_html"])

    def test_summary_html_sanitizes_scripts_and_unsafe_attributes(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive_root = Path(tmp).resolve()
            model_root = self._write_local_model(archive_root)
            meta_path = model_root / "meta.json"
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            meta["summary"] = {
                "text": "unsafe",
                "html": (
                    '<p onclick="alert(1)" style="color:red">ok<script>alert(1)</script></p>'
                    '<a href="javascript:alert(1)" onmouseover="alert(2)">bad</a>'
                    '<img src="javascript:alert(3)" onerror="alert(4)">'
                    '<iframe src="https://example.com"></iframe>'
                    '<a href="images/cover.jpg">cover</a>'
                ),
            }
            meta_path.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")

            with patch.object(catalog, "ARCHIVE_DIR", archive_root):
                detail = catalog.get_model_detail("LOCAL_Test")

            html = detail["summary_html"]
            self.assertIn(">ok", html)
            self.assertIn('/archive/LOCAL_Test/images/cover.jpg', html)
            self.assertNotIn("<script", html)
            self.assertNotIn("<iframe", html)
            self.assertNotIn("onclick", html)
            self.assertNotIn("onmouseover", html)
            self.assertNotIn("onerror", html)
            self.assertNotIn("style=", html)
            self.assertNotIn("javascript:", html)

    def test_summary_html_rewrites_dot_slash_image_sources(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive_root = Path(tmp).resolve()
            model_root = self._write_local_model(archive_root)
            meta_path = model_root / "meta.json"
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            meta["summary"] = {
                "text": "with image",
                "html": '<p><img src="./images/cover.jpg"></p>',
            }
            meta_path.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")

            with patch.object(catalog, "ARCHIVE_DIR", archive_root):
                detail = catalog.get_model_detail("LOCAL_Test")

            self.assertIn('/archive/LOCAL_Test/images/cover.jpg', detail["summary_html"])
            self.assertNotIn('src="./images/cover.jpg"', detail["summary_html"])

    def test_update_metadata_changes_title_and_description(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive_root = Path(tmp).resolve()
            model_root = self._write_local_model(archive_root)

            with patch.object(local_model_edit, "ARCHIVE_DIR", archive_root), \
                patch.object(catalog, "ARCHIVE_DIR", archive_root):
                result = local_model_edit.update_local_model_metadata(
                    "LOCAL_Test",
                    title="新的标题",
                    description="一\n二",
                )
                detail = catalog.get_model_detail("LOCAL_Test")

            self.assertEqual(result["title"], "新的标题")
            self.assertEqual(detail["title"], "新的标题")
            self.assertEqual(detail["summary_text"], "一\n二")
            self.assertIn("一<br", detail["summary_html"])
            self.assertTrue(model_root.exists())
            meta = json.loads((model_root / "meta.json").read_text(encoding="utf-8"))
            self.assertEqual(meta["title"], "新的标题")

    def test_set_local_model_cover_image_reorders_gallery_without_overwriting_instances(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive_root = Path(tmp).resolve()
            model_root = self._write_local_model(archive_root)
            (model_root / "images" / "side.png").write_bytes(b"png-data")
            (model_root / "images" / "head.png").write_bytes(b"head-data")
            meta_path = model_root / "meta.json"
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            meta["designImages"].append({"relPath": "images/side.png"})
            meta["instances"][0]["pictures"].append({"relPath": "images/side.png"})
            meta["instances"].append(
                {
                    "id": "local-2",
                    "title": "head",
                    "fileName": "head.stl",
                    "fileKind": "STL",
                    "thumbnailLocal": "images/head.png",
                    "pictures": [{"relPath": "images/head.png"}],
                }
            )
            meta_path.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")

            with patch.object(local_model_edit, "ARCHIVE_DIR", archive_root), \
                patch.object(catalog, "ARCHIVE_DIR", archive_root):
                updated = local_model_edit.set_local_model_cover_image("LOCAL_Test", "images/side.png")
                detail = catalog.get_model_detail("LOCAL_Test")

            self.assertEqual(updated["relPath"], "images/side.png")
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            self.assertEqual(meta["cover"], "images/side.png")
            self.assertEqual(meta["designImages"][0]["relPath"], "images/side.png")
            self.assertEqual(meta["instances"][0]["thumbnailLocal"], "images/cover.jpg")
            self.assertEqual(meta["instances"][0]["pictures"][0]["relPath"], "images/cover.jpg")
            self.assertEqual(meta["instances"][1]["thumbnailLocal"], "images/head.png")
            self.assertEqual(meta["instances"][1]["pictures"], [{"relPath": "images/head.png"}])
            self.assertTrue(detail["cover_url"].endswith("/LOCAL_Test/images/side.png"))
            self.assertTrue(detail["gallery"][0]["url"].endswith("/LOCAL_Test/images/side.png"))

    def test_save_generated_three_preview_updates_cover_and_gallery(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive_root = Path(tmp).resolve()
            model_root = self._write_local_model(archive_root)
            meta_path = model_root / "meta.json"
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            meta["cover"] = ""
            meta["designImages"] = []
            meta["instances"][0]["thumbnailLocal"] = ""
            meta["instances"][0]["pictures"] = []
            meta_path.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")

            with patch.object(local_model_edit, "ARCHIVE_DIR", archive_root), \
                patch.object(catalog, "ARCHIVE_DIR", archive_root):
                result = local_model_edit.save_local_model_generated_preview(
                    "LOCAL_Test",
                    image_data="data:image/png;base64,aW1hZ2U=",
                    mime_type="image/png",
                    source_instance_key="local-1",
                    source_file_name="body.stl",
                )
                detail = catalog.get_model_detail("LOCAL_Test")

            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            self.assertEqual(result["preview"]["status"], "success")
            self.assertTrue(meta["cover"].startswith("images/three_preview_body"))
            self.assertTrue((model_root / meta["cover"]).exists())
            self.assertEqual(meta["designImages"][0]["kind"], "generated_three_preview")
            self.assertEqual(meta["instances"][0]["thumbnailLocal"], meta["cover"])
            self.assertEqual(meta["localImport"]["previewStatus"], "success")
            self.assertFalse(meta["localImport"]["previewNeedsGeneration"])
            self.assertTrue(detail["cover_url"].endswith(f"/LOCAL_Test/{meta['cover']}"))
            self.assertEqual(detail["local_preview"]["status"], "success")

    def test_generated_three_preview_only_updates_its_source_instance(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive_root = Path(tmp).resolve()
            model_root = self._write_local_model(archive_root)
            (model_root / "instances" / "head.stl").write_bytes(b"solid head\nendsolid head\n")
            (model_root / "images" / "head.jpg").write_bytes(b"head-preview")
            meta_path = model_root / "meta.json"
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            meta["cover"] = ""
            meta["designImages"] = []
            meta["instances"][0]["thumbnailLocal"] = ""
            meta["instances"][0]["pictures"] = []
            meta["instances"].append(
                {
                    "id": "local-2",
                    "title": "head",
                    "fileName": "head.stl",
                    "fileKind": "STL",
                    "thumbnailLocal": "images/head.jpg",
                    "pictures": [{"relPath": "images/head.jpg"}],
                }
            )
            meta_path.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")

            with patch.object(local_model_edit, "ARCHIVE_DIR", archive_root):
                local_model_edit.save_local_model_generated_preview(
                    "LOCAL_Test",
                    image_data="data:image/png;base64,aW1hZ2U=",
                    mime_type="image/png",
                    source_instance_key="local-1",
                    source_file_name="body.stl",
                )

            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            source_instance, other_instance = meta["instances"]
            self.assertEqual(source_instance["thumbnailLocal"], meta["cover"])
            self.assertEqual(source_instance["pictures"][0]["relPath"], meta["cover"])
            self.assertEqual(other_instance["thumbnailLocal"], "images/head.jpg")
            self.assertEqual(other_instance["pictures"], [{"relPath": "images/head.jpg"}])

    def test_detail_removes_historical_generated_preview_from_other_instance(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive_root = Path(tmp).resolve()
            model_root = self._write_local_model(archive_root)
            (model_root / "instances" / "head.stl").write_bytes(b"solid head\nendsolid head\n")
            (model_root / "images" / "head.jpg").write_bytes(b"head-preview")
            generated_path = "images/three_preview_body.png"
            (model_root / generated_path).write_bytes(b"generated-preview")
            generated_item = {
                "relPath": generated_path,
                "kind": "generated_three_preview",
                "generated": True,
                "generator": "three",
                "previewVersion": 2,
                "sourceFileName": "body.stl",
                "sourceInstanceKey": "local-1",
            }
            meta_path = model_root / "meta.json"
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            meta["cover"] = generated_path
            meta["designImages"] = [generated_item]
            meta["instances"][0]["thumbnailLocal"] = generated_path
            meta["instances"][0]["pictures"] = [generated_item]
            meta["instances"].append(
                {
                    "id": "local-2",
                    "title": "head",
                    "fileName": "head.stl",
                    "fileKind": "STL",
                    "thumbnailLocal": generated_path,
                    "pictures": [generated_item, {"relPath": "images/head.jpg"}],
                }
            )
            meta["localImport"] = {
                "previewGenerator": "three",
                "previewVersion": 2,
                "previewStatus": "success",
                "previewNeedsGeneration": False,
                "previewFile": generated_path,
                "previewSourceFileName": "body.stl",
                "previewSourceInstanceKey": "local-1",
            }
            meta_path.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")

            with patch.object(catalog, "ARCHIVE_DIR", archive_root):
                detail = catalog.get_model_detail("LOCAL_Test")

            self.assertIsNotNone(detail)
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            source_instance, other_instance = meta["instances"]
            self.assertEqual(source_instance["pictures"][0]["relPath"], generated_path)
            self.assertEqual(other_instance["thumbnailLocal"], "images/head.jpg")
            self.assertEqual(other_instance["pictures"], [{"relPath": "images/head.jpg"}])

    def test_rejects_non_local_model(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive_root = Path(tmp).resolve()
            model_root = archive_root / "MW_1_Test"
            model_root.mkdir()
            (model_root / "meta.json").write_text(
                json.dumps({"source": "mw_cn", "title": "MW"}),
                encoding="utf-8",
            )
            with patch.object(local_model_edit, "ARCHIVE_DIR", archive_root):
                with self.assertRaisesRegex(ValueError, "只有本地导入模型支持编辑"):
                    local_model_edit.update_local_model_description("MW_1_Test", "x")


if __name__ == "__main__":
    unittest.main()
