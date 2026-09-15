#!/usr/bin/env python3
"""Isolated cron installation tests. Never reads or installs a real crontab."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("seedbox", Path(__file__).with_name("seedbox.py"))
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)


class FakeCrontab:
    def __init__(self, content=None):
        self.content = content
        self.writes = []
        self.reads = 0
        self.before_read = lambda: None
        self.install_error = False
        self.read_error = None

    def __call__(self, binary, *args, data=None):
        assert binary == "/fake/crontab"
        if args == ("-l",):
            self.reads += 1
            self.before_read()
            if self.read_error:
                return subprocess.CompletedProcess([], 1, b"", self.read_error)
            if self.content is None:
                return subprocess.CompletedProcess([], 1, b"", b"no crontab for test-user\n")
            return subprocess.CompletedProcess([], 0, self.content, b"")
        assert args == ("-",)
        self.writes.append(data)
        if self.install_error:
            return subprocess.CompletedProcess([], 1, b"", b"installation denied")
        self.content = data
        return subprocess.CompletedProcess([], 0, b"", b"")


class CronTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="seedbox-cron-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.store = s.Store(self.root / "state ' with spaces")
        self.store.initialize("peer")
        self.names = self.store.directory / "names.txt"
        self.names.write_text("")
        self.kubo = mock.Mock(binary=sys.executable, api="/ip4/127.0.0.1/tcp/5001")
        self.kubo.call.return_value = "ipfs version 0.43.0"
        self.fake = FakeCrontab()
        original_which = s.shutil.which
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(mock.patch.object(s.shutil, "which", side_effect=lambda name:
            "/fake/crontab" if name == "crontab" else original_which(name)))
        self.stack.enter_context(mock.patch.object(s, "cron_call", side_effect=self.fake))
        self.stack.enter_context(mock.patch.object(s.pwd, "getpwuid", return_value=types.SimpleNamespace(
            pw_name="test-user", pw_dir=str(self.root))))
        self.stack.enter_context(mock.patch.object(s, "cron_service_status", return_value="Service not checked."))
        self.output = io.StringIO()
        self.stack.enter_context(contextlib.redirect_stdout(self.output))
        self.stack.enter_context(contextlib.redirect_stderr(self.output))

    def setup(self):
        s.setup_cron(self.store, self.kubo, self.names)

    def test_first_install_and_private_backup(self):
        self.setup()
        self.assertEqual(len(self.fake.writes), 1)
        self.assertIn(b"* * * * * /bin/sh -c ", self.fake.content)
        backup, = self.store.directory.glob("crontab-before-*")
        self.assertEqual(backup.read_bytes(), b"")
        self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
        self.assertIn("installed and verified", self.output.getvalue())

    def test_preserves_all_foreign_bytes(self):
        original = b'# comments \xff\nMAILTO=""\n17 * * * * /opt/quartz/update.sh\n@reboot /opt/quartz/start\n'
        self.fake.content = original
        self.setup()
        self.assertTrue(self.fake.content.startswith(original))
        backup, = self.store.directory.glob("crontab-before-*")
        self.assertEqual(backup.read_bytes(), original)

    def test_repeat_is_noop_then_options_update_same_block(self):
        self.setup()
        first = self.fake.content
        self.setup()
        self.assertEqual(len(self.fake.writes), 1)
        self.kubo.api = "/ip4/127.0.0.1/tcp/5999"
        self.setup()
        self.assertEqual(len(self.fake.writes), 2)
        self.assertNotEqual(first, self.fake.content)
        self.assertEqual(self.fake.content.count(b" BEGIN\n"), 1)

    def test_other_managed_state_is_preserved(self):
        self.setup()
        old = self.fake.content
        other = s.Store(self.root / "other")
        other.initialize("peer")
        s.setup_cron(other, self.kubo, self.names)
        self.assertTrue(self.fake.content.startswith(old))
        self.assertEqual(self.fake.content.count(b" BEGIN\n"), 2)

    def test_manual_entries_abort(self):
        for line in (b"* * * * * python3 ~/seedbox.py sync\n",
                     b"* * * * * /home/user/bin/my98 sync\n"):
            with self.subTest(line=line):
                self.fake.content = line
                with self.assertRaisesRegex(s.Failure, "Manual seedbox"):
                    self.setup()
                self.assertEqual(self.fake.content, line)
        self.assertEqual(self.fake.writes, [])

    def test_malformed_or_duplicate_markers_abort(self):
        key, block = s.cron_block(self.store, self.kubo, self.names)
        cases = [block + block, block.replace(b" END", b" BROKEN"),
                 block.splitlines(keepends=True)[0], block.replace(b"* * * * *", b"unrelated"),
                 b"# my98-seedbox setup-cron damaged\n"]
        for content in cases:
            with self.subTest(content=content), self.assertRaises(s.Failure):
                s.merge_crontab(content, key, block)

    def test_permission_error_is_not_empty_crontab(self):
        self.fake.read_error = b"permission denied"
        with self.assertRaisesRegex(s.Failure, "Cannot read crontab"):
            self.setup()
        self.assertEqual(self.fake.writes, [])
        self.assertEqual(list(self.store.directory.glob("crontab-before-*")), [])

    def test_unknown_absence_diagnostic_is_rejected(self):
        self.fake.read_error = b"no crontab for someone-else"
        with self.assertRaises(s.Failure):
            self.setup()
        self.assertEqual(self.fake.writes, [])

    def test_known_prefixed_absence_is_accepted(self):
        self.fake.read_error = b"crontab: no crontab for test-user\n"
        self.assertIsNone(s.read_crontab("/fake/crontab"))

    def test_concurrent_change_before_install_is_preserved(self):
        def concurrent():
            if self.fake.reads == 2:
                self.fake.content = b"# concurrently edited\n"
        self.fake.before_read = concurrent
        with self.assertRaisesRegex(s.Failure, "changed concurrently"):
            self.setup()
        self.assertEqual(self.fake.writes, [])
        self.assertEqual(self.fake.content, b"# concurrently edited\n")

    def test_verification_failure_never_rolls_back(self):
        def concurrent():
            if self.fake.reads == 3:
                self.fake.content += b"# later change\n"
        self.fake.before_read = concurrent
        with self.assertRaisesRegex(s.Failure, "No automatic rollback"):
            self.setup()
        self.assertEqual(len(self.fake.writes), 1)
        self.assertTrue(self.fake.content.endswith(b"# later change\n"))

    def test_install_failure_reports_backup(self):
        self.fake.install_error = True
        with self.assertRaisesRegex(s.Failure, "backup:"):
            self.setup()
        self.assertIsNone(self.fake.content)

    def test_missing_crontab(self):
        with mock.patch.object(s.shutil, "which", return_value=None):
            with self.assertRaisesRegex(s.Failure, "crontab is not installed"):
                self.setup()
        self.assertEqual(self.fake.writes, [])

    def test_missing_binary_and_names_and_invalid_version(self):
        self.kubo.binary = str(self.root / "missing")
        with self.assertRaisesRegex(s.Failure, "Kubo executable not found"):
            self.setup()
        self.kubo.binary = sys.executable
        self.names.unlink()
        with self.assertRaisesRegex(s.Failure, "Names file"):
            self.setup()
        self.names.write_text("")
        self.kubo.call.return_value = "not Kubo"
        with self.assertRaisesRegex(s.Failure, "not Kubo"):
            self.setup()
        self.assertEqual(self.fake.writes, [])

    def test_invalid_cron_values_are_rejected(self):
        for character in ("%", "\n", "\r", "\0"):
            self.kubo.api = "test" + character
            with self.subTest(character=character), self.assertRaisesRegex(s.Failure, "cron syntax"):
                self.setup()
        self.assertEqual(self.fake.writes, [])

    def test_actual_shell_command_works_without_cwd_or_path(self):
        script = self.root / "script ' with spaces.py"
        script.write_text("import json,sys; print(json.dumps(sys.argv[1:]))\n")
        self.kubo.api = "/dns/test'host/tcp/5001"
        with mock.patch.object(s, "__file__", str(script)):
            key, block = s.cron_block(self.store, self.kubo, self.names)
        command = block.decode().splitlines()[1].removeprefix("* * * * * ")
        result = subprocess.run(["/bin/sh", "-c", command], cwd="/", env={"PATH": "/nonexistent"},
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        args = json.loads((self.store.directory / "sync.log").read_text())
        self.assertEqual(args, ["sync", "--state", str(self.store.directory.resolve()),
            "--names", str(self.names.resolve()), "--api", self.kubo.api,
            "--ipfs", os.path.abspath(sys.executable)])

    def test_global_lock_blocks_another_setup(self):
        with s.cron_setup_lock():
            with self.assertRaises(s.Busy):
                with s.cron_setup_lock():
                    self.fail("lock acquired twice")
        with s.cron_setup_lock():
            pass

    def test_symlink_lock_is_rejected(self):
        (self.root / ".my98-setup-cron.lock").symlink_to(self.names)
        with self.assertRaises(OSError):
            with s.cron_setup_lock():
                self.fail("unsafe lock")

    def test_no_final_newline_is_not_modified(self):
        self.fake.content = b"# missing final newline"
        with self.assertRaisesRegex(s.Failure, "final newline"):
            self.setup()
        self.assertEqual(self.fake.writes, [])

    def test_main_checks_identity_and_does_not_sync(self):
        self.kubo.identity.return_value = "peer"
        with mock.patch.object(s, "find_ipfs", return_value=sys.executable), \
             mock.patch.object(s, "Kubo", return_value=self.kubo), \
             mock.patch.object(s, "Follower") as follower:
            self.assertEqual(s.main(["setup-cron", "--state", str(self.store.directory)]), 0)
            follower.assert_not_called()
        self.assertEqual(len(self.fake.writes), 1)
        self.kubo.identity.assert_called_once()

    def test_main_rejects_other_node_or_offline_daemon(self):
        for identity in ("other-peer", s.Failure("daemon unreachable")):
            self.kubo.identity.side_effect = identity if isinstance(identity, Exception) else None
            self.kubo.identity.return_value = identity
            with mock.patch.object(s, "find_ipfs", return_value=sys.executable), \
                 mock.patch.object(s, "Kubo", return_value=self.kubo):
                self.assertEqual(s.main(["setup-cron", "--state", str(self.store.directory)]), 1)
        self.assertEqual(self.fake.writes, [])

    def test_main_rejects_positional_target(self):
        with self.assertRaises(SystemExit) as exc:
            s.main(["setup-cron", "unexpected"])
        self.assertEqual(exc.exception.code, 2)
        self.assertEqual(self.fake.writes, [])


if __name__ == "__main__":
    unittest.main()
