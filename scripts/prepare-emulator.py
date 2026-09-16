#!/usr/bin/env python3
"""Build from the pinned, clean submodule plus the application's small patch."""
import hashlib
import io
import shutil
import subprocess
import tarfile
from pathlib import Path

root = Path(__file__).resolve().parent.parent
source = root / "vendor/slop86"
output = root / "build/slop86"
patch = root / "vendor/patches/slop86.patch"

def git(*args):
    return subprocess.check_output(["git", "-C", str(source), *args])

if git("status", "--porcelain", "--untracked-files=no").strip():
    raise SystemExit("The slop86 submodule must be clean; keep application changes in vendor/patches/slop86.patch")
revision = git("rev-parse", "HEAD").decode().strip()
fingerprint = revision + " " + hashlib.sha256(patch.read_bytes()).hexdigest() + "\n"
stamp = output / ".my98-source"
if not stamp.exists() or stamp.read_text() != fingerprint:
    if output.exists():
        if not stamp.exists():
            raise SystemExit("Refusing to replace an unrecognized build/slop86 directory")
        shutil.rmtree(output)
    output.mkdir(parents=True)
    with tarfile.open(fileobj=io.BytesIO(git("archive", revision))) as archive:
        archive.extractall(output, filter="data")
    subprocess.run(["git", "apply", "--directory=build/slop86", "--check", str(patch)], cwd=root, check=True)
    subprocess.run(["git", "apply", "--directory=build/slop86", str(patch)], cwd=root, check=True)
    stamp.write_text(fingerprint)
for name in ("libv86.js", "libv86.mjs", "v86_all.js", "v86.wasm"):
    link = root / "build" / name
    target = "slop86/build/" + name
    if link.is_symlink() and str(link.readlink()) == target:
        continue
    if link.exists() or link.is_symlink():
        raise SystemExit("Unexpected build output: " + str(link))
    link.symlink_to(target)
print("Emulator sources: " + revision + " + vendor/patches/slop86.patch")
