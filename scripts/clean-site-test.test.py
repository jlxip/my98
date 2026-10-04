#!/usr/bin/env python3
import importlib.util
import hashlib
import io
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('clean_ci', Path(__file__).with_name('clean-site-test.py'))
ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci)


class DownloadTest(unittest.TestCase):
    def test_timeout_uses_official_mirror_and_checks_hash(self):
        payload = b'verified archive'
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / 'kubo_v0.43.0_darwin-arm64.tar.gz'
            with patch.object(ci.urllib.request, 'urlopen', side_effect=[
                ci.urllib.error.URLError(TimeoutError('connection timed out')), io.BytesIO(payload),
            ]) as request:
                ci.download_kubo(archive, hashlib.sha512(payload).hexdigest())
            self.assertEqual(archive.read_bytes(), payload)
            self.assertEqual(request.call_count, 2)
            self.assertTrue(request.call_args.args[0].startswith('https://github.com/ipfs/kubo/releases/download/v0.43.0/'))
            self.assertEqual(request.call_args.kwargs['timeout'], 30)
            self.assertFalse(archive.with_suffix('.gz.download').exists())

    def test_bad_hash_fails_without_using_mirror(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / 'kubo.tar.gz'
            with patch.object(ci.urllib.request, 'urlopen', return_value=io.BytesIO(b'corrupt')) as request:
                with self.assertRaisesRegex(RuntimeError, 'checksum mismatch'):
                    ci.download_kubo(archive, hashlib.sha512(b'expected').hexdigest())
            self.assertEqual(request.call_count, 1)
            self.assertFalse(archive.exists())
            self.assertFalse(archive.with_suffix('.gz.download').exists())

    def test_all_sources_fail_with_diagnostic_and_no_archive(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / 'kubo.tar.gz'
            with patch.object(ci.urllib.request, 'urlopen', side_effect=ci.urllib.error.URLError('offline')) as request:
                with self.assertRaisesRegex(RuntimeError, 'all official sources'):
                    ci.download_kubo(archive, 'unused')
            self.assertEqual(request.call_count, 2)
            self.assertFalse(archive.exists())


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
