#!/usr/bin/env python3
"""Install a verified native artifact offline, with no native compilation."""
import argparse
import hashlib
import json
import os
from pathlib import Path,PurePosixPath
import platform
import re
import shutil
import subprocess
import sys
import venv


def digest(path):
    with path.open("rb") as stream:return hashlib.file_digest(stream,"sha256").hexdigest()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact",type=Path,required=True)
    parser.add_argument("--root",type=Path,required=True)
    args=parser.parse_args()
    artifact=args.artifact.resolve();root=args.root.resolve()
    manifest=json.loads((artifact/"artifact.json").read_text())
    if manifest.get("version") not in [1,2] or platform.system()!=manifest["system"] or platform.machine()!=manifest["machine"] or list(sys.version_info[:2])!=manifest["python"]:
        parser.error("Artifact does not match the target architecture/Python ABI")
    if root in (Path("/"),Path.home()) or root.is_relative_to(artifact) or artifact.is_relative_to(root) or (root.exists() and any(root.iterdir())):
        parser.error("Choose a fresh dedicated runtime root")
    expected=set()
    for entry in manifest["files"]:
        name=entry["path"];path=artifact/name
        if PurePosixPath(name).is_absolute() or ".." in PurePosixPath(name).parts or path.is_symlink() or not path.is_file():
            raise RuntimeError("Invalid artifact path")
        if path.stat().st_size!=entry["size"] or digest(path)!=entry["sha256"]:
            raise RuntimeError("Artifact checksum mismatch: "+name)
        expected.add(name)
    actual={str(path.relative_to(artifact)) for path in artifact.rglob("*") if path.is_file() and path.name!="artifact.json"}
    if actual!=expected:raise RuntimeError("Unexpected artifact files")
    root.mkdir(parents=True,mode=0o700,exist_ok=True)
    shutil.copytree(artifact/"release",root/"release")
    # Service accounts must execute private binaries even under a root umask.
    for binary in (root/"release/bin").iterdir():binary.chmod(0o755)
    runtime=root/"venv";venv.EnvBuilder(with_pip=False).create(runtime)
    python=runtime/"bin/python";pip=json.loads((artifact/"python-bootstrap.json").read_text())["pip"]
    wheel=artifact/"wheelhouse"/pip["filename"]
    if digest(wheel)!=pip["sha256"]:raise RuntimeError("pip bootstrap checksum mismatch")
    cache=runtime/".cache/pip"
    entry="import sys;sys.path.insert(0,sys.argv.pop(1));from pip._internal.cli.main import main;raise SystemExit(main())"
    subprocess.run([python,"-c",entry,wheel,"--isolated","--cache-dir",cache,"install",
        "--no-index","--no-deps",wheel],check=True)
    subprocess.run([python,"-m","pip","--isolated","--cache-dir",cache,"install",
        "--no-index","--only-binary=:all:","--require-hashes","--find-links",artifact/"wheelhouse",
        "-r",artifact/("requirements-wheels.lock" if manifest["version"]==2 else "requirements.lock")],check=True)
    site=subprocess.check_output([python,"-c","import sysconfig;print(sysconfig.get_path('platlib'))"],text=True).strip()
    native=root/"release/prefix/lib/python3.13/site-packages"
    Path(site,"my98-native.pth").write_text(str(native)+"\n")
    environment={**os.environ,"LD_LIBRARY_PATH":str(root/"release/prefix/lib")+":"+str(native)}
    subprocess.run([python,"-m","pip","--isolated","--cache-dir",cache,"check"],env=environment,check=True)
    probe=json.loads(subprocess.check_output([python,"-c",
        "import libtorrent,my98_libtorrent,json;assert libtorrent.__version__.startswith('2.1.2');print(json.dumps({'libtorrent':libtorrent.__version__,'bridge':hasattr(my98_libtorrent,'put_signed'),'modules':[libtorrent.__file__,my98_libtorrent.__file__]}))"],env=environment,text=True))
    if not probe["bridge"]:raise RuntimeError("Presigned record bridge is unavailable")
    if any(not Path(path).resolve().is_relative_to(native.resolve()) for path in probe["modules"]):
        raise RuntimeError("A native module loaded from outside the new runtime")
    dependencies={}
    for path in [*native.glob("*.so"),*(root/"release/prefix/lib").glob("*.so*"),*(root/"release/bin").iterdir()]:
        result=subprocess.run(["ldd",str(path)],env=environment,text=True,capture_output=True)
        if result.returncode or "not found" in result.stdout+result.stderr:
            raise RuntimeError("Native dependency validation failed: "+str(path))
        for line in result.stdout.splitlines():
            if "libtorrent-rasterbar.so" in line or "libboost_python313.so" in line:
                paths=[Path(value.rstrip(":")) for value in re.findall(r"/[^\s]+",line)]
                if not paths or any(not value.resolve().is_relative_to((root/"release/prefix/lib").resolve()) for value in paths):
                    raise RuntimeError("A native dependency resolved to the original build prefix")
        dependencies[str(path.relative_to(root))]=result.stdout
    # Printing configuration exercises the copied ELF without opening listeners.
    if (root/"release/bin/aquatic_ws").exists():
        config=subprocess.check_output([str(root/"release/bin/aquatic_ws"),"-p"],env=environment,text=True)
        import tomllib
        if "access_list" not in tomllib.loads(config):raise RuntimeError("Invalid Aquatic runtime")
    if manifest["version"]==2:
        version=subprocess.run([str(root/"release/bin/nginx"),"-V"],env=environment,text=True,capture_output=True,check=True)
        if "nginx/1.30.6" not in version.stderr:raise RuntimeError("Unexpected Nginx runtime")
    launchers=root/"bin";launchers.mkdir()
    for name in ["my98-torrent",*(["my98-torrent-services"] if manifest["version"]==2 else [])]:
        launcher=launchers/name
        launcher.write_text('#!/bin/sh\nset -eu\nruntime_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\n'
            'export LD_LIBRARY_PATH="$runtime_root/release/prefix/lib:$runtime_root/release/prefix/lib/python3.13/site-packages"\n'
            'exec "$runtime_root/venv/bin/python" "$runtime_root/release/scripts/'+name+'.py" "$@"\n')
        launcher.chmod(0o755)
    report={"artifactSha256":digest(artifact/"artifact.json"),"probe":probe,"dependencies":dependencies,
        "nativeCompilation":False,"publicListenersActivated":False}
    (root/"runtime-install.json").write_text(json.dumps(report,indent=2)+"\n")
    print(json.dumps({"runtime":str(root),"libtorrent":probe["libtorrent"],"bridge":probe["bridge"],"offline":True}))


if __name__=="__main__":main()
