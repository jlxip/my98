#!/usr/bin/env python3
"""Build only a private Nginx binary; never activate or change a system service."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request

REPO=Path(__file__).resolve().parent.parent


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root",type=Path,required=True)
    parser.add_argument("--archive",type=Path)
    args=parser.parse_args()
    root=args.root.resolve()
    root.mkdir(parents=True,exist_ok=True)
    lock=json.loads((REPO/"src/torrent/nginx.lock.json").read_text())
    archive=args.archive or root/("nginx-"+lock["version"]+".tar.gz")
    if not archive.exists():
        with urllib.request.urlopen(lock["url"],timeout=60) as response:
            data=response.read(lock["bytes"]+1)
        if len(data)!=lock["bytes"] or hashlib.sha256(data).hexdigest()!=lock["sha256"]:
            raise ValueError("Nginx source archive does not match the lock")
        archive.write_bytes(data)
    if archive.stat().st_size!=lock["bytes"] or hashlib.sha256(archive.read_bytes()).hexdigest()!=lock["sha256"]:
        raise ValueError("Nginx source archive does not match the lock")
    source=root/("nginx-"+lock["version"])
    if not source.exists():
        with tempfile.TemporaryDirectory(dir=root,prefix="extract-") as temporary:
            with tarfile.open(archive) as bundle:
                expected=source.name+"/"
                if any(member.name!=source.name and not member.name.startswith(expected) for member in bundle.getmembers()):
                    raise ValueError("Unexpected source archive path")
                bundle.extractall(temporary,filter="data")
            os.replace(Path(temporary)/source.name,source)
    prefix=root/"prefix"
    flags=["--prefix="+str(prefix),"--with-http_ssl_module",
        "--without-http_rewrite_module","--without-pcre","--without-http_gzip_module",
        "--without-http_autoindex_module","--without-http_fastcgi_module",
        "--without-http_uwsgi_module","--without-http_scgi_module",
        "--without-http_grpc_module","--without-http_memcached_module",
        "--with-cc-opt=-O2"]
    environment={**os.environ,"LC_ALL":"C"}
    subprocess.run(["sh","configure",*flags],cwd=source,env=environment,check=True)
    subprocess.run(["make","-j1"],cwd=source,env=environment,check=True)
    subprocess.run(["make","install"],cwd=source,env=environment,check=True)
    binary=prefix/"sbin/nginx"
    info=subprocess.run([str(binary),"-V"],capture_output=True,text=True,check=True)
    shutil.copyfile(source/"LICENSE",prefix/"LICENSE")
    manifest={"source":lock,"platform":platform.platform(),"machine":platform.machine(),
        "configure":flags,"compiler":subprocess.check_output([os.environ.get("CC","cc"),"--version"],text=True).splitlines()[0],
        "binary":str(binary),"binarySha256":hashlib.sha256(binary.read_bytes()).hexdigest(),
        "version":info.stderr.strip(),"startsServices":False}
    (root/"nginx-build.json").write_text(json.dumps(manifest,indent=2)+"\n")
    print(json.dumps(manifest),flush=True)


if __name__=="__main__":
    main()
