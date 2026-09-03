#!/usr/bin/env python3
from __future__ import annotations
import argparse, hashlib, json, shutil, stat, tarfile, tempfile, zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]; PACKAGING=ROOT/'packaging'; DIST=ROOT/'dist'; WINDOWS_NAME='makerhub-windows-amd64'; LINUX_NAME='makerhub-linux-amd64'
def sha256(path:Path)->str:
    d=hashlib.sha256();
    with path.open('rb') as h:
        for c in iter(lambda:h.read(1024*1024),b''): d.update(c)
    return d.hexdigest()
def render_compose(image:str)->str:
    t=(PACKAGING/'compose.release.yaml').read_text(encoding='utf-8')
    if '__MAKERHUB_IMAGE__' not in t: raise RuntimeError('release compose template is missing image placeholder')
    if '@sha256:' not in image: raise RuntimeError('release image must be immutable and use @sha256:<digest>')
    return t.replace('__MAKERHUB_IMAGE__',image)
def write_common(target:Path,image:str,release_version:str)->None:
    target.mkdir(parents=True,exist_ok=True); (target/'compose.yaml').write_text(render_compose(image),encoding='utf-8'); (target/'VERSION.txt').write_text(f'MakerHub release: {release_version}\nContainer image: {image}\n',encoding='utf-8'); (target/'README.md').write_text(f'''# MakerHub {release_version}\n\n这个包是 MakerHub 的可运行 Release，不需要克隆源码。\n\n## 前置条件\n\n- 64 位 x86-64 / amd64 机器\n- Docker Engine + Docker Compose v2\n- Windows 使用 Docker Desktop（WSL2 后端）\n\n## 首次启动\n\nWindows：`\\makerhub.ps1 start`\n\nLinux：`./makerhub.sh start`\n\n启动器会自动生成本地数据库密码、CloakBrowser Token 和 AES-256 状态加密密钥，然后拉取本 Release 对应的不可变容器镜像。\n\n默认地址：http://127.0.0.1:9042\n\n常用命令：start / stop / restart / status / logs / doctor / password / update\n''',encoding='utf-8')
def build_windows(workdir:Path,image:str,release_version:str)->Path:
    target=workdir/WINDOWS_NAME; write_common(target,image,release_version); shutil.copy2(PACKAGING/'windows-amd64'/'makerhub.ps1',target/'makerhub.ps1'); shutil.copy2(PACKAGING/'windows-amd64'/'MakerHub.cmd',target/'MakerHub.cmd'); archive=DIST/f'{WINDOWS_NAME}.zip';
    with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as zf:
        for p in sorted(target.rglob('*')):
            if p.is_file(): zf.write(p,p.relative_to(workdir).as_posix())
    return archive
def build_linux(workdir:Path,image:str,release_version:str)->Path:
    target=workdir/LINUX_NAME; write_common(target,image,release_version); launcher=target/'makerhub.sh'; shutil.copy2(PACKAGING/'linux-amd64'/'makerhub.sh',launcher); launcher.chmod(launcher.stat().st_mode|stat.S_IXUSR|stat.S_IXGRP|stat.S_IXOTH); archive=DIST/f'{LINUX_NAME}.tar.gz';
    with tarfile.open(archive,'w:gz',compresslevel=9) as tf: tf.add(target,arcname=LINUX_NAME)
    return archive
def validate_archives(windows:Path,linux:Path,expected_image:str)->None:
    with zipfile.ZipFile(windows) as zf:
        names=set(zf.namelist()); required={f'{WINDOWS_NAME}/compose.yaml',f'{WINDOWS_NAME}/makerhub.ps1',f'{WINDOWS_NAME}/MakerHub.cmd',f'{WINDOWS_NAME}/README.md',f'{WINDOWS_NAME}/VERSION.txt'}
        if not required.issubset(names): raise RuntimeError(f'Windows bundle missing files: {sorted(required-names)}')
        if expected_image not in zf.read(f'{WINDOWS_NAME}/compose.yaml').decode(): raise RuntimeError('Windows bundle does not reference the tested image')
    with tarfile.open(linux,'r:gz') as tf:
        members={m.name:m for m in tf.getmembers()}; required={f'{LINUX_NAME}/compose.yaml',f'{LINUX_NAME}/makerhub.sh',f'{LINUX_NAME}/README.md',f'{LINUX_NAME}/VERSION.txt'}
        if not required.issubset(members): raise RuntimeError(f'Linux bundle missing files: {sorted(required-set(members))}')
        if not (members[f'{LINUX_NAME}/makerhub.sh'].mode & stat.S_IXUSR): raise RuntimeError('Linux launcher is not executable in the tarball')
        f=tf.extractfile(members[f'{LINUX_NAME}/compose.yaml']);
        if f is None or expected_image not in f.read().decode(): raise RuntimeError('Linux bundle does not reference the tested image')
def main()->int:
    parser=argparse.ArgumentParser(); parser.add_argument('--image',required=True); parser.add_argument('--release-version',default=(ROOT/'RELEASE_VERSION').read_text().strip()); a=parser.parse_args(); image=a.image.strip(); rv=a.release_version.strip(); DIST.mkdir(parents=True,exist_ok=True)
    for p in DIST.glob('makerhub-*-amd64.*'): p.unlink()
    for p in (DIST/'SHA256SUMS',DIST/'release-manifest.json'): p.unlink(missing_ok=True)
    with tempfile.TemporaryDirectory(prefix='makerhub-release-') as temp:
        w=build_windows(Path(temp),image,rv); l=build_linux(Path(temp),image,rv); validate_archives(w,l,image)
    assets=[w,l]; (DIST/'SHA256SUMS').write_text('\n'.join(f'{sha256(p)}  {p.name}' for p in assets)+'\n'); manifest={'release_version':rv,'base_version':(ROOT/'VERSION').read_text().strip(),'image':image,'maintainer':{'name':'Sacilave','email':'sacilave@gmail.com'},'assets':{p.name:{'sha256':sha256(p),'bytes':p.stat().st_size} for p in assets}}; (DIST/'release-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n'); print(json.dumps(manifest,ensure_ascii=False,indent=2)); return 0
if __name__=='__main__': raise SystemExit(main())
