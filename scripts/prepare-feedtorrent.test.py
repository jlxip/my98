#!/usr/bin/env python3
"""Verify pinned source preparation without downloading or building dependencies."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("prepare_ft", Path(__file__).with_name("prepare-feedtorrent.py"))
prepare_ft = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare_ft)

class PreparationTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="my98-ft-prepare-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "vendor/feedtorrent"
        self.build = self.root / "build/feedtorrent"
        self.source.mkdir(parents=True)
        self.git(self.source, "init", "--quiet")
        self.git(self.source, "config", "user.name", "Fixture")
        self.git(self.source, "config", "user.email", "fixture@example.invalid")
        self.git(self.source, "config", "commit.gpgsign", "false")
        self.git(self.source, "config", "core.hooksPath", "/dev/null")
        (self.source / ".gitignore").write_text(".tools/\n")
        script = self.source / "dev/scripts/native-deps.sh"
        script.parent.mkdir(parents=True)
        script.write_text("#!/bin/sh\nset -eu\nmkdir -p .tools\ncp tracked .tools/native-source\n")
        (self.source / "tracked").write_text("first")
        self.commit()
        prepare_ft.SOURCE = self.source
        prepare_ft.BUILD = self.build

    def git(self, path, *args):
        return subprocess.check_output(["git", "-C", str(path), *args], text=True, stderr=subprocess.DEVNULL).strip()

    def commit(self):
        self.git(self.source, "add", ".")
        self.git(self.source, "commit", "--quiet", "-m", "Fixture")
        return self.git(self.source, "rev-parse", "HEAD")

    def test_fresh_clone_and_updated_pin_rebuild_native_inputs(self):
        first = self.git(self.source, "rev-parse", "HEAD")
        prepare_ft.prepare()
        self.assertEqual(self.git(self.build, "rev-parse", "HEAD"), first)
        self.assertEqual((self.build / ".tools/native-source").read_text(), "first")
        (self.source / "tracked").write_text("second")
        second = self.commit()
        prepare_ft.prepare()
        self.assertEqual(self.git(self.build, "rev-parse", "HEAD"), second)
        self.assertEqual((self.build / ".tools/native-source").read_text(), "second")

    def test_dirty_source_preserved(self):
        (self.source / "tracked").write_text("user work")
        with self.assertRaisesRegex(SystemExit, "submodule must be clean"):
            prepare_ft.prepare()
        self.assertEqual((self.source / "tracked").read_text(), "user work")
        self.assertFalse(self.build.exists())

    def test_dirty_build_preserved(self):
        prepare_ft.prepare()
        (self.build / "tracked").write_text("local experiment")
        with self.assertRaisesRegex(SystemExit, "local changes"):
            prepare_ft.prepare()
        self.assertEqual((self.build / "tracked").read_text(), "local experiment")

if __name__ == "__main__":
    unittest.main()
