#!/usr/bin/env python3
"""Assemble only the runtime files needed by my98, preserving their URL paths."""
from pathlib import Path
import json
import shutil

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "build/site"
# An explicit file list excludes fixtures and stale build outputs by construction.
FILES = [
    "index.html", "win98.css", "coi-serviceworker.js",
    "src/browser/bootstrap.js", "src/browser/win98.js", "src/browser/disk-ui.js",
    "build/libv86.mjs", "build/v86.wasm", "build/v86-fallback.wasm",
    "build/disk/web/client.js", "build/disk/web/worker.js",
    "build/disk/pkg/slop86_disk.js", "build/disk/pkg/slop86_disk_bg.wasm",
    "bios/seabios.bin", "bios/bochs-vgabios.bin", "bios/COPYING.LESSER",
    "slop86/src/iso9660.js", "slop86/src/log.js", "slop86/src/const.js", "slop86/src/lib.js", "slop86/LICENSE", "slop86/LICENSE.MIT",
    "licenses/coi-serviceworker.txt",
]


def package():
    for name in FILES:
        if not (ROOT / name).is_file():
            raise SystemExit("Missing site asset: " + name + "; run make all first")
    if SITE.is_symlink():
        raise SystemExit("Refusing to replace a symlink at build/site")
    if SITE.exists():
        shutil.rmtree(SITE)
    for name in FILES:
        destination = SITE / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, destination, follow_symlinks=True)
    (SITE / ".nojekyll").write_text("")
    # Evidence belongs outside the deployable tree.
    manifest = [{"path": str(p.relative_to(SITE)), "bytes": p.stat().st_size}
                for p in sorted(SITE.rglob("*")) if p.is_file()]
    (ROOT / "build/site-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Site: {SITE} ({len(manifest)} files, {sum(x['bytes'] for x in manifest)} bytes)")


if __name__ == "__main__":
    package()
