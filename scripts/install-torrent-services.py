#!/usr/bin/env python3
"""Root bootstrap for reviewed, dedicated services; no dependency compilation."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys


def digest(path):
    with path.open("rb") as stream:return hashlib.file_digest(stream,"sha256").hexdigest()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact",type=Path,required=True)
    parser.add_argument("--config",type=Path,required=True)
    parser.add_argument("--activate",action="store_true",help="Start after the isolated/exposure gates have passed")
    args=parser.parse_args()
    if os.geteuid()!=0:parser.error("Dedicated accounts and system supervision require root")
    artifact=args.artifact.resolve();config=args.config.resolve()
    value=json.loads(config.read_text());runtime=Path(value["runtime"])
    if str(runtime)!="/opt/my98-torrent-v2/runtime" or value.get("root")!="/var/lib/my98-torrent-v2" or runtime.is_symlink():
        parser.error("Use the dedicated runtime/data roots")
    manifest=json.loads((artifact/"artifact.json").read_text())
    if manifest.get("version")!=2 or manifest.get("protocol")!=2:parser.error("Use an artifact with Nginx and the service installer")
    if not runtime.exists():
        subprocess.run([sys.executable,str(artifact/"release/scripts/install-torrent-runtime.py"),
            "--artifact",str(artifact),"--root",str(runtime)],check=True)
    report=json.loads((runtime/"runtime-install.json").read_text())
    if report["artifactSha256"]!=digest(artifact/"artifact.json"):
        parser.error("The installed runtime belongs to a different artifact")
    for entry in manifest["files"]:
        if entry["path"].startswith("release/"):
            installed=runtime/entry["path"]
            if installed.is_symlink() or digest(installed)!=entry["sha256"]:
                parser.error("Installed code/native binary differs from the verified artifact")
    # The generated wrapper scopes library lookup to this runtime on OpenBSD.
    helper=runtime/"bin/my98-torrent-services"
    subprocess.run([str(helper),"--config",str(config),"install"],check=True)
    if args.activate:subprocess.run([str(helper),"--config",str(config),"activate"],check=True)
    else:print(json.dumps({"installed":True,"active":False,"runtime":str(runtime)}))


if __name__=="__main__":main()
