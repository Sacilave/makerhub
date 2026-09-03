from __future__ import annotations
import importlib.util, tarfile, zipfile
from pathlib import Path
import pytest
ROOT=Path(__file__).resolve().parents[1]; SCRIPT=ROOT/'scripts'/'build_release_bundles.py'
def load_module():
    spec=importlib.util.spec_from_file_location('build_release_bundles',SCRIPT); assert spec and spec.loader; module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module
def test_release_compose_requires_digest():
    with pytest.raises(RuntimeError): load_module().render_compose('ghcr.io/sacilave/makerhub:0.16.16-h1')
def test_release_compose_renders_immutable_image():
    m=load_module(); image='ghcr.io/sacilave/makerhub@sha256:'+('a'*64); r=m.render_compose(image); assert image in r and '__MAKERHUB_IMAGE__' not in r and '127.0.0.1' in r and 'internal: true' in r
def test_platform_launchers_exist():
    assert (ROOT/'packaging/windows-amd64/makerhub.ps1').is_file(); assert (ROOT/'packaging/windows-amd64/MakerHub.cmd').is_file(); assert (ROOT/'packaging/linux-amd64/makerhub.sh').is_file()
def test_bundle_builder_creates_expected_archives(tmp_path,monkeypatch):
    m=load_module(); image='ghcr.io/sacilave/makerhub@sha256:'+('b'*64); monkeypatch.setattr(m,'DIST',tmp_path/'dist'); m.DIST.mkdir(); work=tmp_path/'work'; work.mkdir(); w=m.build_windows(work,image,'0.16.16-h1'); l=m.build_linux(work,image,'0.16.16-h1'); m.validate_archives(w,l,image)
    with zipfile.ZipFile(w) as zf: assert 'makerhub-windows-amd64/MakerHub.cmd' in zf.namelist()
    with tarfile.open(l,'r:gz') as tf: assert tf.getmember('makerhub-linux-amd64/makerhub.sh').mode & 0o100
