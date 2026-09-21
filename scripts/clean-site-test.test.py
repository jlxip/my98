#!/usr/bin/env python3
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('clean_ci', Path(__file__).with_name('clean-site-test.py'))
ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci)


class SnapshotTest(unittest.TestCase):
    def test_exact_index_and_pinned_dependency_without_local_artifacts(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / 'repo'; module = base / 'module'

            def git(path, *args, env=None):
                return subprocess.check_output(['git', '-C', str(path), *args], env=env, text=True, stderr=subprocess.DEVNULL).strip()

            for path in (root, module):
                path.mkdir()
                git(path, 'init', '--quiet')
                git(path, 'config', 'user.name', 'Fixture')
                git(path, 'config', 'user.email', 'fixture@example.invalid')
                git(path, 'config', 'commit.gpgsign', 'false')
                git(path, 'config', 'core.hooksPath', '/dev/null')
                (path / 'tracked').write_text('committed')
                git(path, 'add', 'tracked')
                git(path, 'commit', '--quiet', '-m', 'Fixture')
            git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', str(module), 'vendor/slop86')
            pinned = git(root, 'rev-parse', ':vendor/slop86')
            git(root, 'commit', '--quiet', '-m', 'Dependency')
            (root / 'tracked').write_text('staged')
            (root / 'new').write_text('staged addition')
            git(root, 'add', 'tracked', 'new')
            index_before = (root / '.git/index').read_bytes()
            alternate = base / 'alternate-index'
            alternate.write_bytes(index_before)
            selected_env = {**os.environ, 'GIT_INDEX_FILE': str(alternate)}
            (root / 'new').unlink()
            git(root, 'add', '-u', env=selected_env)
            tree = git(root, 'write-tree', env=selected_env)
            (root / 'tracked').write_text('unstaged')
            (root / 'untracked').write_text('must not leak')
            for name in ('build', 'node_modules', 'vendor/slop86/build'):
                path = root / name; path.mkdir(parents=True, exist_ok=True)
                (path / 'sentinel').write_text('preserve me')
            (root / 'vendor/slop86/tracked').write_text('dirty dependency')
            destination = base / 'snapshot'
            ci.snapshot(root, destination, tree)
            self.assertEqual((destination / 'tracked').read_text(), 'staged')
            self.assertFalse((destination / 'new').exists())
            for name in ('untracked', 'build', 'node_modules', 'vendor/slop86/build'):
                self.assertFalse((destination / name).exists(), name)
            self.assertEqual(git(destination / 'vendor/slop86', 'rev-parse', 'HEAD'), pinned)
            self.assertEqual((destination / 'vendor/slop86/tracked').read_text(), 'committed')
            self.assertEqual((root / 'tracked').read_text(), 'unstaged')
            self.assertEqual((root / '.git/index').read_bytes(), index_before)
            self.assertEqual((root / 'build/sentinel').read_text(), 'preserve me')


if __name__ == '__main__':
    unittest.main()
