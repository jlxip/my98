#!/usr/bin/env python3
"""Package verified Linux/OpenBSD native builds and hashed binary Python wheels."""
import argparse
import hashlib
import json
import os
import email.parser
from pathlib import Path
import platform
import re
import shutil
import subprocess
import tarfile
import urllib.request
import zipfile


def digest(path):
    with path.open("rb") as stream:return hashlib.file_digest(stream,"sha256").hexdigest()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--native",type=Path,required=True)
    parser.add_argument("--aquatic",type=Path)
    parser.add_argument("--nginx",type=Path,required=True)
    parser.add_argument("--output",type=Path,required=True)
    parser.add_argument("--source",type=Path,default=Path(__file__).resolve().parent.parent)
    args=parser.parse_args()
    system=platform.system()
    if (system,platform.machine()) not in [("Linux","x86_64"),("OpenBSD","amd64")]:
        parser.error("Create this artifact natively on compatible Linux/OpenBSD amd64")
    source=args.source.resolve();output=args.output.resolve()
    if output.exists():parser.error("Use a fresh artifact directory")
    native=json.loads((args.native/"native-build.json").read_text())
    aquatic=json.loads((args.aquatic/"aquatic-build.json").read_text()) if args.aquatic else None
    nginx=json.loads((args.nginx/"nginx-build.json").read_text())
    if native["libtorrent"]!="2.1.2" or native["webrtc"]!=("on" if system=="Linux" else "off"):
        parser.error("Complete the agreed native build first")
    if system=="Linux" and (not aquatic or aquatic.get("preparedOnly")):
        parser.error("Complete the Linux Aquatic build first")
    if system=="OpenBSD" and aquatic:parser.error("OpenBSD must not include WebRTC/Aquatic dependencies")
    if nginx["source"]!=json.loads((source/"src/torrent/nginx.lock.json").read_text()):
        parser.error("Unexpected private Nginx build")
    python=args.native/"venv/bin/python"
    probe=subprocess.check_output([python,"-c",
        "import libtorrent,my98_libtorrent,sys,json;print(json.dumps({'libtorrent':libtorrent.__version__,'python':list(sys.version_info[:2]),'bridge':hasattr(my98_libtorrent,'put_signed')}))"],text=True)
    probe=json.loads(probe)
    if probe["python"]!=[3,13] or not probe["libtorrent"].startswith("2.1.2") or not probe["bridge"]:
        parser.error("Unexpected native runtime")
    output.mkdir(parents=True)
    release=output/"release";lib=release/"prefix/lib";lib.mkdir(parents=True)
    for pattern in ["libtorrent-rasterbar.so*","libboost_python313.so*"]:
        files=list((args.native/"prefix/lib").glob(pattern))
        if not files:raise RuntimeError("Missing runtime library: "+pattern)
        for file in files:
            if file.is_file():shutil.copy2(file,lib/file.name)
    site=lib/"python3.13/site-packages";site.mkdir(parents=True)
    native_site=args.native/"prefix/lib/python3.13/site-packages"
    for name in ["libtorrent","my98_libtorrent"]:
        modules=list(native_site.glob(name+"*.so"))
        if len(modules)!=1:raise RuntimeError("Review native module: "+name)
        shutil.copy2(modules[0],site/modules[0].name)
    binaries=release/"bin";binaries.mkdir()
    for name,build in [("nginx",nginx),*([("aquatic_ws",aquatic)] if aquatic else [])]:
        binary=binaries/name;shutil.copy2(build["binary"],binary)
        binary.chmod(0o755)
        if digest(binary)!=build["binarySha256"]:raise RuntimeError("Native binary changed after build")
    licenses=release/"licenses";licenses.mkdir()
    for name,path in [
        ("libtorrent",args.native/"sources/libtorrent-rasterbar-2.1.2/LICENSE"),
        ("libtorrent-copying",args.native/"sources/libtorrent-rasterbar-2.1.2/COPYING"),
        ("boost",args.native/"sources/boost_1_92_0/LICENSE_1_0.txt"),
        ("nginx",args.nginx/"prefix/LICENSE")]:
        shutil.copy2(path,licenses/(name+".txt"))
    if aquatic:
        for path in (args.aquatic/"sources").glob("*/LICENSE*"):
            if path.is_file():shutil.copy2(path,licenses/("aquatic-"+path.name))
    shutil.copytree(source/"src/torrent/my98_torrent",release/"src/torrent/my98_torrent",
        ignore=shutil.ignore_patterns("__pycache__","*.pyc"))
    scripts=release/"scripts";scripts.mkdir()
    for name in ["identity.py","my98-torrent.py","my98-torrent-services.py","install-torrent-runtime.py","install-torrent-services.py"]:
        shutil.copy2(source/"scripts"/name,scripts/name)
    for name in ["requirements.lock","python-bootstrap.json"]:
        shutil.copy2(source/"src/torrent"/name,output/name)
    wheels=output/"wheelhouse";wheels.mkdir()
    operation=["download","--only-binary=:all:","--dest",str(wheels)] if system=="Linux" else [
        "wheel","--no-build-isolation","--no-deps","--wheel-dir",str(wheels)]
    subprocess.run([python,"-m","pip","--isolated","--cache-dir",str(args.native/"venv/.cache/pip"),
        *operation,"--require-hashes","-r",str(output/"requirements.lock")],
        env={**os.environ,"MAKEFLAGS":"-j1","CMAKE_BUILD_PARALLEL_LEVEL":"1","MAX_JOBS":"1"},check=True)
    # Source hashes above authenticate OpenBSD builds. The platform wheel hashes
    # below make installation offline and forbid any compilation on the target.
    canonical=lambda name:re.sub(r"[-_.]+","-",name).lower()
    expected={canonical(name):version for name,version in re.findall(
        r"^([A-Za-z0-9_.-]+)==([^\s\\]+)",(output/"requirements.lock").read_text(),re.M)}
    observed={};locked=[]
    for file in sorted(wheels.glob("*.whl")):
        with zipfile.ZipFile(file) as package:
            metadata=[name for name in package.namelist() if name.endswith(".dist-info/METADATA")]
            if len(metadata)!=1:raise RuntimeError("Invalid wheel metadata")
            values=email.parser.BytesParser().parsebytes(package.read(metadata[0]))
        name=canonical(values["Name"]);version=values["Version"]
        if name in observed:raise RuntimeError("Duplicate runtime wheel")
        observed[name]=version;locked.append(name+"=="+version+" --hash=sha256:"+digest(file))
    if observed!=expected:raise RuntimeError("Binary wheels do not match the source dependency lock")
    (output/"requirements-wheels.lock").write_text("\n".join(locked)+"\n")
    pip=json.loads((output/"python-bootstrap.json").read_text())["pip"]
    wheel=wheels/pip["filename"]
    with urllib.request.urlopen(pip["url"],timeout=60) as response,wheel.open("wb") as stream:
        shutil.copyfileobj(response,stream)
    if digest(wheel)!=pip["sha256"]:raise RuntimeError("pip artifact checksum mismatch")
    (output/"build-provenance.json").write_text(json.dumps({"native":native,"aquatic":aquatic,"nginx":nginx,
        "probe":probe,"platform":platform.platform(),"libc":platform.libc_ver()},indent=2)+"\n")
    files=[{"path":str(path.relative_to(output)),"size":path.stat().st_size,"sha256":digest(path)}
        for path in sorted(output.rglob("*")) if path.is_file()]
    manifest={"version":2,"protocol":2,"system":system,"machine":platform.machine(),"python":[3,13],"files":files}
    (output/"artifact.json").write_text(json.dumps(manifest,indent=2)+"\n")
    archive=output.with_name(output.name+".tar.gz")
    if archive.exists():raise RuntimeError("Artifact archive already exists")
    with tarfile.open(archive,"w:gz") as package:package.add(output,arcname=output.name)
    print(json.dumps({"directory":str(output),"archive":str(archive),"sha256":digest(archive),
        "bytes":archive.stat().st_size,"files":len(files)}))


if __name__=="__main__":main()
