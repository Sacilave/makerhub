from __future__ import annotations

import importlib.util
import tarfile
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "build_release_bundles.py"
RELEASE_GATE = ROOT / "scripts" / "release_gate.sh"


def load_module():
    spec = importlib.util.spec_from_file_location("build_release_bundles", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_release_compose_requires_digest():
    with pytest.raises(RuntimeError):
        load_module().render_compose("ghcr.io/sacilave/makerhub:0.16.16")


def test_release_compose_renders_immutable_image():
    module = load_module()
    image = "ghcr.io/sacilave/makerhub@sha256:" + ("a" * 64)
    rendered = module.render_compose(image)
    assert image in rendered
    assert "__MAKERHUB_IMAGE__" not in rendered
    assert "127.0.0.1" in rendered
    assert "internal: true" in rendered


def test_platform_launchers_exist():
    assert (ROOT / "packaging/windows-amd64/makerhub.ps1").is_file()
    assert (ROOT / "packaging/windows-amd64/MakerHub.cmd").is_file()
    assert (ROOT / "packaging/linux-amd64/makerhub.sh").is_file()


def test_bundle_builder_creates_expected_archives(tmp_path, monkeypatch):
    module = load_module()
    image = "ghcr.io/sacilave/makerhub@sha256:" + ("b" * 64)
    monkeypatch.setattr(module, "DIST", tmp_path / "dist")
    module.DIST.mkdir()
    work = tmp_path / "work"
    work.mkdir()

    windows = module.build_windows(work, image, "0.16.16")
    linux = module.build_linux(work, image, "0.16.16")
    module.validate_archives(windows, linux, image)

    with zipfile.ZipFile(windows) as zf:
        assert "makerhub-windows-amd64/MakerHub.cmd" in zf.namelist()
    with tarfile.open(linux, "r:gz") as tf:
        assert tf.getmember("makerhub-linux-amd64/makerhub.sh").mode & 0o100


def test_release_gate_cleanup_preserves_e2e_exit_status_and_handles_root_owned_mounts():
    text = RELEASE_GATE.read_text(encoding="utf-8")
    assert "local status=$?" in text
    assert 'exit "$status"' in text
    assert "sudo -n true" in text
    assert "docker run --rm --user 0:0" in text
    assert 'if [[ -d "$TMP" ]]' in text
    assert "warning: unable to remove temporary directory" in text
