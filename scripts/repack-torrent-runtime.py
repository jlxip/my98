#!/usr/bin/env python3
"""Repackage verified native binaries with the current protocol, without compiling.

The base artifact supplies pinned native libraries and offline wheels. Its complete
manifest is checked before use; current dependency locks must match. Archive bytes
are deterministic for identical input files (ownership, timestamps and gzip header
are normalized). Run twice with the same output basename in different parents to
verify reproducibility.
"""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import shutil
import tarfile

SOURCE=Path(__file__).resolve().parent.parent
SCRIPTS=("identity.py","my98-torrent.py","my98-torrent-services.py",
    "install-torrent-runtime.py","install-torrent-services.py")

def digest(path):
    with path.open("rb") as stream:return hashlib.file_digest(stream,"sha256").hexdigest()

def verify(root):
    manifest=json.loads((root/"artifact.json").read_text())
    if manifest.get("version")!=2:raise ValueError("Expected a complete offline wheel artifact")
    expected=set()
    for entry in manifest["files"]:
        name=entry["path"];path=root/name
        if PurePosixPath(name).is_absolute() or ".." in PurePosixPath(name).parts or path.is_symlink():
            raise ValueError("Invalid artifact member")
        if path.stat().st_size!=entry["size"] or digest(path)!=entry["sha256"]:
            raise ValueError("Artifact checksum mismatch: "+name)
        expected.add(name)
    actual={str(path.relative_to(root)) for path in root.rglob("*") if path.is_file() and path.name!="artifact.json"}
    if actual!=expected:raise ValueError("Unexpected artifact files")
    return manifest

def archive(root,target):
    with target.open("xb") as stream,gzip.GzipFile(fileobj=stream,mode="wb",filename="",mtime=0) as zipped:
        with tarfile.open(fileobj=zipped,mode="w",format=tarfile.PAX_FORMAT) as package:
            for path in [root,*sorted(root.rglob("*"))]:
                name=root.name+("/"+str(path.relative_to(root)) if path!=root else "")
                info=package.gettarinfo(str(path),arcname=name)
                info.uid=info.gid=info.mtime=0;info.uname=info.gname="";info.pax_headers={}
                info.mode=0o755 if path.is_dir() or path.stat().st_mode&0o111 else 0o644
                if path.is_file():
                    with path.open("rb") as content:package.addfile(info,content)
                else:package.addfile(info)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base",type=Path,required=True)
    parser.add_argument("--output",type=Path,required=True)
    args=parser.parse_args();base=args.base.resolve();output=args.output.resolve()
    manifest=verify(base)
    if output.exists() or output.is_relative_to(base):parser.error("Choose a fresh output directory outside the base")
    for name in ("requirements.lock","python-bootstrap.json"):
        if (base/name).read_bytes()!=(SOURCE/"src/torrent"/name).read_bytes():
            parser.error("Dependency locks changed; perform a fresh native package build")
    shutil.copytree(base,output)
    module=output/"release/src/torrent/my98_torrent";shutil.rmtree(module)
    shutil.copytree(SOURCE/"src/torrent/my98_torrent",module,ignore=shutil.ignore_patterns("__pycache__","*.pyc"))
    for name in SCRIPTS:shutil.copy2(SOURCE/"scripts"/name,output/"release/scripts"/name)
    source_files={str(path.relative_to(output/"release")):digest(path)
        for folder in (module,output/"release/scripts") for path in sorted(folder.rglob("*")) if path.is_file()}
    provenance=json.loads((output/"build-provenance.json").read_text())
    provenance["repack"]={"baseArtifactSha256":digest(base/"artifact.json"),"protocol":2,
        "nativeCompilation":False,"sourceFiles":source_files}
    (output/"build-provenance.json").write_text(json.dumps(provenance,indent=2)+"\n")
    manifest["protocol"]=2
    manifest["files"]=[{"path":str(path.relative_to(output)),"size":path.stat().st_size,"sha256":digest(path)}
        for path in sorted(output.rglob("*")) if path.is_file() and path.name!="artifact.json"]
    (output/"artifact.json").write_text(json.dumps(manifest,indent=2)+"\n")
    verify(output);target=output.with_name(output.name+".tar.gz");archive(output,target)
    print(json.dumps({"archive":str(target),"sha256":digest(target),"nativeCompilation":False,"protocol":2}))

if __name__=="__main__":main()
