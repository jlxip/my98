#!/usr/bin/env python3
"""Build the clean FeedTorrent submodule in an isolated checkout."""
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "vendor/feedtorrent"
BUILD = ROOT / "build/feedtorrent"

def git(path, *args):
    return subprocess.check_output(["git", "-C", str(path), *args], text=True).strip()

def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)

def prepare():
    if not (SOURCE / ".git").exists():
        raise SystemExit("Initialize vendor/feedtorrent with git submodule update --init --recursive")
    if git(SOURCE, "status", "--porcelain", "--untracked-files=no"):
        raise SystemExit("The FeedTorrent submodule must be clean; update it in its own repository")
    revision = git(SOURCE, "rev-parse", "HEAD")
    if not BUILD.exists():
        BUILD.parent.mkdir(parents=True, exist_ok=True)
        run("git", "clone", "--no-checkout", str(SOURCE), str(BUILD))
        run("git", "-C", str(BUILD), "checkout", "--detach", revision)
    if BUILD.is_symlink() or not (BUILD / ".git").exists():
        raise SystemExit("Refusing to replace an unrecognized build/feedtorrent directory")
    if git(BUILD, "status", "--porcelain", "--untracked-files=no"):
        raise SystemExit("The build/feedtorrent checkout has local changes; preserve them before updating")
    if git(BUILD, "rev-parse", "HEAD") != revision:
        run("git", "-C", str(BUILD), "fetch", str(SOURCE), revision)
        run("git", "-C", str(BUILD), "checkout", "--detach", revision)
    # Reconfigure on every preparation so native changes in a new pin cannot
    # reuse an installation built with the previous CMake inputs.
    run("sh", "dev/scripts/native-deps.sh", cwd=BUILD)
    print("FeedTorrent source: " + revision)

if __name__ == "__main__":
    prepare()
