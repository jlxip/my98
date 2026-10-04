#!/usr/bin/env python3
"""Copy the pinned, clean submodule into an isolated build directory."""
import io
import re
import shutil
import subprocess
import tarfile
from pathlib import Path

root = Path(__file__).resolve().parent.parent
source = root / "vendor/slop86"
output = root / "build/slop86"

def git(*args):
    return subprocess.check_output(["git", "-C", str(source), *args])

if git("status", "--porcelain", "--untracked-files=no").strip():
    raise SystemExit("The slop86 submodule must be clean; make changes in its own repository and update the pin")
revision = git("rev-parse", "HEAD").decode().strip()
fingerprint = revision + "\n"
stamp = output / ".my98-source"
previous = None
if output.exists() or output.is_symlink():
    if output.is_symlink() or stamp.is_symlink() or not stamp.is_file():
        raise SystemExit("Refusing to replace an unrecognized build/slop86 directory")
    previous = stamp.read_text()
    # Older recognized caches stored a revision and a second SHA-256 field.
    if not re.fullmatch(r"[0-9a-f]{40}(?: [0-9a-f]{64})?\n", previous):
        raise SystemExit("Refusing to replace an unrecognized build/slop86 directory")
if previous != fingerprint:
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    with tarfile.open(fileobj=io.BytesIO(git("archive", revision))) as archive:
        archive.extractall(output, filter="data")
    stamp.write_text(fingerprint)
for name in ("libv86.js", "libv86.mjs", "v86_all.js", "v86.wasm"):
    link = root / "build" / name
    target = "slop86/build/" + name
    if link.is_symlink() and str(link.readlink()) == target:
        continue
    if link.exists() or link.is_symlink():
        raise SystemExit("Unexpected build output: " + str(link))
    link.symlink_to(target)
print("Emulator sources: " + revision)
