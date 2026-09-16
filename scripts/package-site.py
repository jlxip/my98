#!/usr/bin/env python3
"""Assemble only the runtime files needed by my98, preserving their URL paths."""
from pathlib import Path
import json
import shutil

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "build/site"
# Public URLs are independent of the source layout.
FILES = json.loads((ROOT / "scripts/site-assets.json").read_text())


def package():
    for name, source in FILES.items():
        if not (ROOT / source).is_file():
            raise SystemExit("Missing site asset: " + name + "; run make all first")
    if SITE.is_symlink():
        raise SystemExit("Refusing to replace a symlink at build/site")
    if SITE.exists():
        shutil.rmtree(SITE)
    for name, source in FILES.items():
        destination = SITE / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / source, destination, follow_symlinks=True)
    (SITE / ".nojekyll").write_text("")
    # Evidence belongs outside the deployable tree.
    manifest = [{"path": str(p.relative_to(SITE)), "bytes": p.stat().st_size}
                for p in sorted(SITE.rglob("*")) if p.is_file()]
    (ROOT / "build/site-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Site: {SITE} ({len(manifest)} files, {sum(x['bytes'] for x in manifest)} bytes)")


if __name__ == "__main__":
    package()
