#!/usr/bin/env python3
"""Exercise clean source preparation and safe migration of recognized caches."""
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent


class PrepareEmulatorTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="my98-prepare-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / "scripts").mkdir()
        (self.root / "vendor").mkdir()
        shutil.copyfile(ROOT / "scripts/prepare-emulator.py", self.root / "scripts/prepare-emulator.py")
        self.source = self.root / "vendor/slop86"
        subprocess.run(["git", "clone", "--quiet", "--shared", "--no-checkout",
                        str(ROOT / "vendor/slop86"), str(self.source)], check=True)
        self.revision = subprocess.check_output(
            ["git", "-C", str(ROOT / "vendor/slop86"), "rev-parse", "HEAD"], text=True).strip()
        subprocess.run(["git", "-C", str(self.source), "checkout", "--quiet", "--detach", self.revision],
                       check=True)
        self.output = self.root / "build/slop86"
        self.stamp = self.output / ".my98-source"

    def prepare(self, expected=0):
        result = subprocess.run([sys.executable, "scripts/prepare-emulator.py"], cwd=self.root,
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def cache(self, stamp=None):
        self.output.mkdir(parents=True)
        marker = self.output / "marker"
        marker.write_text("preserve")
        if stamp is not None:
            self.stamp.write_text(stamp)
        return marker

    def test_fresh_copy_is_clean_and_identified_only_by_revision(self):
        self.prepare()
        self.assertEqual(self.stamp.read_text(), self.revision + "\n")
        for name in ("src/main.js", "src/buffer.js", "src/browser/main.js"):
            self.assertEqual((self.output / name).read_bytes(), (self.source / name).read_bytes())
        for name in ("libv86.js", "libv86.mjs", "v86_all.js", "v86.wasm"):
            link = self.root / "build" / name
            self.assertTrue(link.is_symlink())
            self.assertEqual(str(link.readlink()), "slop86/build/" + name)

    def test_matching_cache_is_retained(self):
        self.prepare()
        marker = self.output / "marker"
        marker.write_text("preserve")
        self.prepare()
        self.assertEqual(marker.read_text(), "preserve")

    def test_legacy_cache_is_rebuilt_even_at_the_same_revision(self):
        marker = self.cache(self.revision + " " + "a" * 64 + "\n")
        (self.output / "src/browser").mkdir(parents=True)
        (self.output / "src/browser/main.js").write_text("old adapted source")
        self.prepare()
        self.assertFalse(marker.exists())
        self.assertEqual(self.stamp.read_text(), self.revision + "\n")
        self.assertEqual((self.output / "src/browser/main.js").read_bytes(),
                         (self.source / "src/browser/main.js").read_bytes())

    def test_old_clean_revision_cache_is_rebuilt(self):
        marker = self.cache("0" * 40 + "\n")
        self.prepare()
        self.assertFalse(marker.exists())
        self.assertEqual(self.stamp.read_text(), self.revision + "\n")

    def test_unknown_directory_is_preserved(self):
        marker = self.cache()
        result = self.prepare(expected=1)
        self.assertIn("unrecognized", result.stderr)
        self.assertEqual(marker.read_text(), "preserve")

    def test_unknown_stamp_is_preserved(self):
        marker = self.cache("unknown\n")
        result = self.prepare(expected=1)
        self.assertIn("unrecognized", result.stderr)
        self.assertEqual(marker.read_text(), "preserve")
        self.assertEqual(self.stamp.read_text(), "unknown\n")

    def test_symlink_directory_is_preserved(self):
        external = self.root / "external"
        external.mkdir()
        (external / ".my98-source").write_text(self.revision + "\n")
        (external / "marker").write_text("preserve")
        self.output.parent.mkdir()
        self.output.symlink_to(external, target_is_directory=True)
        self.prepare(expected=1)
        self.assertTrue(self.output.is_symlink())
        self.assertEqual((external / "marker").read_text(), "preserve")

    def test_symlink_stamp_is_preserved(self):
        marker = self.cache()
        external = self.root / "external-stamp"
        external.write_text(self.revision + "\n")
        self.stamp.symlink_to(external)
        self.prepare(expected=1)
        self.assertTrue(self.stamp.is_symlink())
        self.assertEqual(marker.read_text(), "preserve")

    def test_dirty_dependency_is_rejected_before_changing_cache(self):
        marker = self.cache(self.revision + "\n")
        target = self.source / "src/main.js"
        target.write_text(target.read_text() + "\n// local modification\n")
        result = self.prepare(expected=1)
        self.assertIn("must be clean", result.stderr)
        self.assertEqual(marker.read_text(), "preserve")


if __name__ == "__main__":
    unittest.main()
