#!/usr/bin/env python3
"""Install pinned Python dependencies into a dedicated venv, never the system."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import urllib.request


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python",type=Path,required=True)
    parser.add_argument("--requirements",type=Path,default=Path(__file__).resolve().parent.parent/"src/torrent")
    args=parser.parse_args()
    # Do not resolve a venv symlink before executing it: sys.prefix is derived
    # from the original interpreter path and its adjacent pyvenv.cfg.
    python=args.python.absolute()
    info=json.loads(subprocess.check_output([python,"-c","import sys,json;print(json.dumps([sys.prefix,sys.base_prefix]))"],text=True))
    if info[0]==info[1]:parser.error("The selected Python must be in a dedicated venv")
    cache=Path(info[0])/".cache/pip"
    lock=args.requirements.resolve();pip=json.loads((lock/"python-bootstrap.json").read_text())["pip"]
    environment=os.environ.copy();environment.update(CMAKE_BUILD_PARALLEL_LEVEL="1",CMAKE_GENERATOR="Unix Makefiles",SKBUILD_BUILD_TOOL_ARGS="-j1")
    def run(command):
        print("+ "+" ".join(map(str,command)),flush=True)
        subprocess.run(list(map(str,command)),check=True,env=environment)
    with tempfile.TemporaryDirectory(prefix="my98-python-",dir=info[0]) as temporary:
        wheel=Path(temporary)/pip["filename"]
        with urllib.request.urlopen(pip["url"],timeout=60) as source,wheel.open("wb") as output:
            import shutil
            shutil.copyfileobj(source,output)
        with wheel.open("rb") as stream:digest=hashlib.file_digest(stream,"sha256").hexdigest()
        if digest!=pip["sha256"]:raise RuntimeError("pip bootstrap checksum mismatch")
        entry="import sys;sys.path.insert(0,sys.argv.pop(1));from pip._internal.cli.main import main;raise SystemExit(main())"
        run([python,"-c",entry,wheel,"--isolated","--cache-dir",cache,"install","--no-deps","--no-index",wheel])
    pip_command=[python,"-m","pip","--isolated","--cache-dir",cache,"install","--require-hashes"]
    run(pip_command+["--only-binary=:all:","-r",lock/"build-requirements.lock"])
    run(pip_command+["--no-build-isolation","-r",lock/"cffi-bootstrap.lock"])
    run(pip_command+["--no-build-isolation","-r",lock/"requirements.lock"])
    run([python,"-m","pip","check"])


if __name__=="__main__":main()
