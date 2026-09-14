#!/usr/bin/env python3
"""Lifecycle and process-lock tests; no real Kubo or network needed."""

import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("seedbox", Path(__file__).with_name("seedbox.py"))
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)


class FakeKubo:
    def __init__(self):
        self.targets = {"one": "a", "two": "b"}
        self.recursive, self.direct = {}, {}
        self.calls = []
        self.resolve_error = set()
        self.add_error = set()
        self.remove_error = set()
        self.lost = set()
        self.before_add = lambda cid: None

    def resolve(self, name, fds=()):
        if name in self.resolve_error:
            raise s.Failure("record unavailable or expired")
        return self.targets[name]

    def pins(self, kind, fds=()):
        return dict(self.recursive if kind == "recursive" else self.direct)

    def add(self, cid, label, fds=()):
        self.calls.append(("add", cid))
        self.before_add(cid)
        if cid in self.add_error:
            raise s.Failure("download failed")
        self.recursive[cid] = label
        if cid in self.lost:
            self.lost.remove(cid)
            raise s.Failure("response lost after successful pin")

    def pin_records(self, kind, fds=()):
        return [(cid, cid, label) for cid, label in self.pins(kind, fds).items()]

    def relabel(self, cid, label, fds=()):
        self.add(cid, label, fds)

    def remove(self, cid, fds=(), label=None):
        self.calls.append(("remove", cid))
        if cid in self.remove_error:
            raise s.Failure("unpin failed")
        self.recursive.pop(cid, None)


class Lifecycle(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = s.Store(self.tmp.name)
        self.store.initialize("peer")
        self.kubo = FakeKubo()
        self.follow = s.Follower(self.store, self.kubo)

    def sync(self, names=("one",)):
        with contextlib.redirect_stderr(io.StringIO()):
            return self.follow.sync(names)

    def test_unchanged_does_not_download(self):
        self.assertTrue(self.sync())
        self.assertTrue(self.sync())
        self.assertEqual(self.kubo.calls, [("add", "a")])

    def test_pin_before_replacement(self):
        self.sync()
        self.kubo.targets["one"] = "b"
        self.kubo.before_add = lambda cid: self.assertIn("a", self.kubo.recursive)
        self.assertTrue(self.sync())
        self.assertEqual(self.store.row("one")["current"], "b")
        self.assertEqual(self.kubo.calls, [("add", "a"), ("add", "b"), ("remove", "a")])

    def test_failed_download_preserves_current_and_retries(self):
        self.sync()
        self.kubo.targets["one"] = "b"
        self.kubo.add_error.add("b")
        self.assertFalse(self.sync())
        row = self.store.row("one")
        self.assertEqual((row["current"], row["pending"]), ("a", "b"))
        self.assertIn("a", self.kubo.recursive)
        self.assertIsNotNone(row["error"])
        self.kubo.add_error.clear()
        self.assertTrue(self.sync())
        self.assertIsNone(self.store.row("one")["error"])
        self.assertNotIn("a", self.kubo.recursive)

    def test_expired_or_failed_resolution_keeps_old_pin(self):
        self.sync()
        self.kubo.resolve_error.add("one")
        self.assertFalse(self.sync())
        self.assertEqual(self.store.row("one")["current"], "a")
        self.assertIn("a", self.kubo.recursive)

    def test_lost_successful_pin_response_reconciles_without_redownload(self):
        self.kubo.lost.add("a")
        self.assertFalse(self.sync())
        self.assertIsNone(self.store.row("one")["current"])
        self.assertTrue(self.sync())
        self.assertEqual(self.kubo.calls, [("add", "a")])
        self.sync([])
        self.assertNotIn("a", self.kubo.recursive)

    def test_crash_after_current_commit_recovers_cleanup(self):
        self.sync()
        self.kubo.targets["one"] = "b"
        with mock.patch.object(self.follow, "cleanup", side_effect=RuntimeError("power loss")):
            with self.assertRaises(RuntimeError):
                self.sync()
        self.assertEqual(self.store.row("one")["current"], "b")
        self.assertIn("a", self.kubo.recursive)
        self.assertTrue(self.sync())
        self.assertNotIn("a", self.kubo.recursive)

    def test_cleanup_error_retries(self):
        self.sync()
        self.kubo.targets["one"] = "b"
        self.kubo.remove_error.add("a")
        self.assertFalse(self.sync())
        self.assertEqual(self.store.row("one")["current"], "b")
        self.assertIn("unpin failed", self.store.status()["cleanup_pending"][0]["error"])
        self.kubo.remove_error.clear()
        self.assertTrue(self.sync())
        self.assertNotIn("a", self.kubo.recursive)

    def test_missing_pin_is_repaired(self):
        self.sync()
        self.kubo.recursive.clear()
        self.assertTrue(self.sync())
        self.assertEqual(self.kubo.calls, [("add", "a"), ("add", "a")])

    def test_foreign_recursive_pin_is_never_removed(self):
        self.kubo.recursive["a"] = "someone else"
        self.sync()
        self.sync([])
        self.assertEqual(self.kubo.recursive, {"a": "someone else"})
        self.assertEqual(self.kubo.calls, [])

    def test_foreign_direct_pin_is_preserved_when_promoted(self):
        self.kubo.direct["a"] = "original label"
        self.sync()
        self.sync([])
        self.assertEqual(self.kubo.recursive["a"], "original label")
        self.assertNotIn(("remove", "a"), self.kubo.calls)

    def test_external_renaming_relinquishes_ownership(self):
        self.sync()
        self.kubo.recursive["a"] = "adopted by administrator"
        self.sync([])
        self.assertIn("a", self.kubo.recursive)

    def test_shared_cid_survives_one_subscription_removal(self):
        self.kubo.targets["two"] = "a"
        self.sync(["one", "two"])
        self.sync(["one", "two"])  # Reconcile any name that met the CID lock.
        self.sync(["two"])
        self.assertIn("a", self.kubo.recursive)
        self.assertEqual(self.kubo.calls.count(("add", "a")), 1)
        self.sync([])
        self.assertNotIn("a", self.kubo.recursive)

    def test_switch_target_after_failed_partial_pin(self):
        self.kubo.lost.add("a")
        self.sync()
        self.kubo.targets["one"] = "b"
        self.assertTrue(self.sync())
        self.assertEqual(set(self.kubo.recursive), {"b"})

    def test_slow_name_does_not_block_other_name_or_overlap(self):
        started, finish, other = threading.Event(), threading.Event(), threading.Event()
        def before(cid):
            if cid == "a":
                started.set()
                if not finish.wait(10):
                    raise s.Failure("test timed out")
            if cid == "b":
                other.set()
        self.kubo.before_add = before
        with concurrent_pool() as pool:
            future = pool.submit(self.sync, ["one", "two"])
            try:
                self.assertTrue(started.wait(5))
                self.assertTrue(other.wait(5))
                self.assertTrue(self.sync(["one", "two"]))
                self.assertEqual(self.kubo.calls.count(("add", "a")), 1)
            finally:
                finish.set()
            self.assertTrue(future.result(timeout=5))

    def test_remove_name_during_download_eventually_cleans_it(self):
        self.store.configure(["one"])
        self.kubo.before_add = lambda cid: self.store.configure([])
        self.follow.follow("one")
        self.assertTrue(self.sync([]))
        self.assertNotIn("a", self.kubo.recursive)

    def test_state_cannot_be_reused_with_another_daemon(self):
        with self.assertRaises(s.Failure):
            self.store.initialize("another peer")

    def test_status_is_read_only_and_reports_pending(self):
        self.kubo.add_error.add("a")
        self.sync()
        with contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(s.main(["status", "--state", self.tmp.name]), 0)
        row = json.loads(output.getvalue())["names"][0]
        self.assertEqual(row["pending"], "a")
        self.assertIsNotNone(row["last_check"])
        missing = Path(self.tmp.name) / "missing"
        self.assertEqual(s.Store(missing).rows(), [])
        self.assertFalse(missing.exists())

    def test_process_death_releases_lock(self):
        code = """
import importlib.util,sys,time
spec=importlib.util.spec_from_file_location('seedbox',sys.argv[1])
s=importlib.util.module_from_spec(spec); spec.loader.exec_module(s)
with s.Store(sys.argv[2]).lock('name:one'):
 print('locked',flush=True)
 time.sleep(30)
"""
        child = subprocess.Popen([sys.executable, "-c", code, str(Path(s.__file__)), self.tmp.name],
                                 stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), "locked")
            with self.assertRaises(s.Busy):
                with self.store.lock("name:one"):
                    pass
        finally:
            child.kill()
            child.wait(timeout=5)
            child.stdout.close()
        with self.store.lock("name:one"):
            pass


@contextlib.contextmanager
def concurrent_pool():
    import concurrent.futures
    with concurrent.futures.ThreadPoolExecutor() as pool:
        yield pool


class KuboAdapter(unittest.TestCase):
    def test_rpc_and_client_have_finite_deadlines_and_inherit_lock(self):
        k = s.Kubo("/ipfs", "/api")
        completed = subprocess.CompletedProcess([], 0, "ok", "")
        with mock.patch.object(s.subprocess, "run", return_value=completed) as run:
            k.add("bcid", "label", (7, 8))
        args, kwargs = run.call_args
        self.assertIn("1800s", args[0])
        self.assertEqual(kwargs["timeout"], 1805)
        self.assertEqual(kwargs["pass_fds"], (7, 8))

    def test_bad_or_missing_configuration_does_not_disable_subscriptions(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "names"
            p.write_text("k123\n../../bad\n")
            k = s.Kubo()
            with mock.patch.object(k, "call", return_value="k123"):
                with self.assertRaises(s.Failure):
                    k.names(p)

    def test_rejects_nonroot_ipns_destination(self):
        k = s.Kubo()
        with mock.patch.object(k, "call", return_value="/ipfs/bcid/path"):
            with self.assertRaises(s.Failure):
                k.resolve("k123")

    def test_pin_listing_failure_is_not_assumed_absence(self):
        k = s.Kubo()
        with mock.patch.object(k, "call", side_effect=s.Failure("daemon down")):
            with self.assertRaises(s.Failure):
                k.pins("recursive")

    def test_cid_aliases_with_different_owners_are_borrowed(self):
        k = s.Kubo()
        for records in ([('QmOld', 'bnew', 'foreign'), ('bnew', 'bnew', 'owned')],
                        [('bnew', 'bnew', 'owned'), ('QmOld', 'bnew', 'foreign')]):
            with mock.patch.object(k, 'pin_records', return_value=records):
                self.assertEqual(k.pins('recursive'), {'bnew': ''})
                with mock.patch.object(k, 'call') as call:
                    k.remove('bnew', label='owned')
                    call.assert_not_called()

    def test_owned_cid_aliases_are_both_removed(self):
        k = s.Kubo()
        with mock.patch.object(k, 'pin_records', return_value=[('QmOld', 'bnew', 'owned'), ('bnew', 'bnew', 'owned')]):
            with mock.patch.object(k, 'call') as call:
                k.remove('bnew', label='owned')
                self.assertEqual(call.call_args.args, ('pin', 'rm', '--', '/ipfs/QmOld', '/ipfs/bnew'))

    def test_adoption_relabels_original_encoding_without_creating_an_alias(self):
        k = s.Kubo()
        with mock.patch.object(k, 'pin_records', return_value=[('QmOld', 'bnew', '')]):
            with mock.patch.object(k, 'add') as add:
                k.relabel('bnew', 'owner', (7,))
                add.assert_called_once_with('QmOld', 'owner', (7,))

    def test_kubo_empty_pin_listing_is_an_empty_object(self):
        k = s.Kubo()
        with mock.patch.object(k, "call", return_value="{}"):
            self.assertEqual(k.pins("direct"), {})


def disk_bytes(version=1):
    size = 400000
    return b"SLOPDSK\0" + s.struct.pack("<IIQ", 1, 65536, size) + bytes(174) + bytes([version]) * (size + 7 * 62)


class Publishing(unittest.TestCase):
    def setUp(self):
        Lifecycle.setUp(self)
        self.disk = Path(self.tmp.name) / "disk.my98"
        self.disk.write_bytes(disk_bytes())
        self.names = Path(self.tmp.name) / "names.txt"
        self.names.write_text("# keep this comment\n")
        self.kubo.key_name = lambda key, fds=(): {"my98": "one", "other": "two"}[key]
        self.kubo.names = lambda path: sorted({l for l in Path(path).read_text().splitlines() if l and not l.startswith("#")})
        self.kubo.import_disk = self.import_disk
        self.kubo.publish = self.publish_ipns
        self.publish_error = None
        self.import_error = None
        self.published = []

    sync = Lifecycle.sync

    def import_disk(self, path, label=None, fds=()):
        cid = "a" if Path(path).read_bytes()[-1] == 1 else "b"
        if label is not None:
            self.kubo.add(cid, label, fds)
            if self.import_error:
                raise self.import_error
        return cid

    def publish_ipns(self, key, cid, fds=()):
        self.published.append((key, cid))
        if self.publish_error == "before":
            raise s.Failure("publish failed")
        self.kubo.targets[self.kubo.key_name(key)] = cid
        if self.publish_error == "after":
            raise s.Failure("publish response lost")

    def publish(self, key="my98"):
        return self.follow.publish(self.disk, key, self.names)

    def test_first_publish_and_auto_subscription(self):
        self.kubo.targets.clear()
        self.assertTrue(self.publish())
        self.assertEqual(self.names.read_text(), "# keep this comment\none\n")
        self.assertEqual(self.store.row("one")["current"], "a")
        self.assertIsNone(self.store.status()["names"][0]["publication"])
        self.assertEqual(self.disk.read_bytes(), disk_bytes())
        self.assertEqual(self.published, [("my98", "a")])

    def test_alternative_key_and_idempotent_subscription(self):
        self.publish("other")
        self.publish("other")
        self.assertEqual(self.names.read_text().count("two"), 1)
        self.assertEqual(self.store.row("two")["current"], "a")

    def test_invalid_disk_is_rejected_before_kubo(self):
        for content in (b"bad", disk_bytes()[:-1], b"BADMAGIC" + disk_bytes()[8:]):
            self.disk.write_bytes(content)
            with self.assertRaises(s.Failure):
                self.publish()
        self.assertEqual(self.kubo.calls, [])
        self.assertEqual(self.store.rows(), [])

    def test_missing_key_has_no_side_effects(self):
        with mock.patch.object(self.kubo, "key_name", side_effect=s.Failure("missing key")):
            with self.assertRaises(s.Failure):
                self.publish()
        self.assertEqual(self.store.rows(), [])
        self.assertEqual(self.kubo.calls, [])

    def test_successful_update_cleans_owned_previous(self):
        self.publish()
        self.disk.write_bytes(disk_bytes(2))
        self.assertTrue(self.publish())
        self.assertEqual(self.kubo.recursive, {"b": self.store.label})

    def test_import_failure_retains_old_and_can_retry_same(self):
        self.publish()
        self.disk.write_bytes(disk_bytes(2))
        self.import_error = s.Failure("lost import response")
        with self.assertRaises(s.Failure):
            self.publish()
        self.assertEqual(self.store.publication("one")["stage"], "adding")
        self.assertFalse(self.sync())
        self.assertEqual(set(self.kubo.recursive), {"a", "b"})
        self.import_error = None
        self.assertTrue(self.publish())
        self.assertEqual(self.kubo.calls.count(("add", "b")), 1)

    def test_failed_import_before_pin_preserves_current(self):
        self.publish()
        self.disk.write_bytes(disk_bytes(2))
        self.kubo.add_error.add("b")
        with self.assertRaises(s.Failure):
            self.publish()
        self.assertFalse(self.sync())
        self.assertEqual(self.kubo.recursive, {"a": self.store.label})
        self.assertEqual(self.store.publication("one")["cid"], "b")
        self.kubo.add_error.clear()
        self.assertTrue(self.publish())

    def test_publish_failure_blocks_stale_sync_and_different_disk(self):
        self.publish()
        self.disk.write_bytes(disk_bytes(2))
        self.publish_error = "before"
        with self.assertRaises(s.Failure):
            self.publish()
        self.assertFalse(self.sync())
        self.assertEqual(self.store.row("one")["current"], "a")
        self.assertEqual(set(self.kubo.recursive), {"a", "b"})
        self.disk.write_bytes(disk_bytes())
        with self.assertRaisesRegex(s.Failure, "Another publication"):
            self.publish()
        self.assertEqual(self.store.publication("one")["cid"], "b")

    def test_lost_publish_response_is_reconciled_without_republishing(self):
        self.publish()
        self.disk.write_bytes(disk_bytes(2))
        self.publish_error = "after"
        with self.assertRaises(s.Failure):
            self.publish()
        self.assertTrue(self.sync())
        self.assertEqual(len(self.published), 2)
        self.assertEqual(self.kubo.recursive, {"b": self.store.label})
        self.assertIsNone(self.store.publication("one"))

    def test_confirmation_failure_recovers_with_reopened_store(self):
        self.publish()
        self.disk.write_bytes(disk_bytes(2))
        self.kubo.resolve_error.add("one")
        with self.assertRaises(s.Failure):
            self.publish()
        self.assertEqual(self.store.publication("one")["stage"], "confirming")
        reopened = s.Store(self.tmp.name)
        reopened.initialize("peer")
        self.follow = s.Follower(reopened, self.kubo)
        self.kubo.resolve_error.clear()
        self.assertTrue(self.sync())
        self.assertEqual(self.store.row("one")["current"], "b")

    def test_interruption_after_publish_before_commit(self):
        self.publish()
        self.disk.write_bytes(disk_bytes(2))
        with mock.patch.object(self.store, "commit_publication", side_effect=RuntimeError("process died")):
            with self.assertRaises(RuntimeError):
                self.publish()
        self.assertEqual(set(self.kubo.recursive), {"a", "b"})
        self.assertTrue(self.sync())
        self.assertEqual(self.kubo.recursive, {"b": self.store.label})

    def test_cleanup_failure_is_reported_and_retried(self):
        self.publish()
        self.disk.write_bytes(disk_bytes(2))
        self.kubo.remove_error.add("a")
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertFalse(self.publish())
        self.assertIsNone(self.store.publication("one"))
        self.assertTrue(self.store.status()["cleanup_pending"])
        self.kubo.remove_error.clear()
        self.assertTrue(self.sync())

    def test_published_foreign_pin_and_shared_pin_survive(self):
        self.kubo.recursive["a"] = "foreign"
        self.publish()
        self.disk.write_bytes(disk_bytes(2))
        self.publish()
        self.assertEqual(self.kubo.recursive["a"], "foreign")
        self.kubo.targets["two"] = "b"
        self.sync(["one", "two"])
        self.sync(["two"])
        self.assertIn("b", self.kubo.recursive)

    def test_removed_subscription_keeps_uncertain_publication(self):
        self.publish()
        self.disk.write_bytes(disk_bytes(2))
        self.publish_error = "before"
        with self.assertRaises(s.Failure):
            self.publish()
        self.assertFalse(self.sync([]))
        self.assertEqual(set(self.kubo.recursive), {"a", "b"})

    def test_publish_lock_leaves_other_names_free(self):
        self.store.configure(["two"])
        entered, finish = threading.Event(), threading.Event()
        def before(cid):
            if cid == "a":
                entered.set()
                if not finish.wait(5):
                    raise s.Failure("test timeout")
        self.kubo.before_add = before
        self.names.write_text("two\n")
        with concurrent_pool() as pool:
            future = pool.submit(self.publish)
            try:
                self.assertTrue(entered.wait(5))
                self.assertTrue(self.sync(["one", "two"]))
                self.assertEqual(self.store.row("two")["current"], "b")
                with self.assertRaises(s.Busy):
                    self.publish()
            finally:
                finish.set()
            self.assertTrue(future.result(timeout=5))

    def test_configuration_is_read_under_lock(self):
        def read():
            with self.assertRaises(s.Busy):
                with self.store.lock("config"):
                    pass
            return ["one"]
        self.assertTrue(self.follow.sync(read))

    def test_migrate_legacy_and_restore_backup(self):
        self.sync()
        self.names.write_text("one\n")
        self.kubo.canonical = lambda cid, fds=(): cid
        self.kubo.recursive.update(a="original", b="another publisher")
        legacy = Path(self.tmp.name) / "legacy"
        legacy.mkdir()
        (legacy / "current").write_text("a\n")
        (legacy / "history").write_text("a\n")
        data = self.follow.adopt_legacy(legacy, "my98", self.names)
        self.assertEqual(data["labels"], {"a": "original"})
        self.assertEqual(self.kubo.recursive, {"a": self.store.label, "b": "another publisher"})
        self.follow.restore_legacy_adoption()
        self.assertEqual(self.kubo.recursive, {"a": "original", "b": "another publisher"})
        self.assertEqual(self.store.row("one")["current"], "a")
        self.assertFalse((legacy / "lock").exists())

    def test_migration_backup_preserves_each_raw_alias_label(self):
        self.sync()
        self.names.write_text("one\n")
        self.kubo.canonical = lambda cid, fds=(): cid
        self.kubo.recursive.update(a="original", alias="different label")
        legacy = Path(self.tmp.name) / "legacy"
        legacy.mkdir()
        (legacy / "current").write_text("a\n")
        (legacy / "history").write_text("a\n")
        with mock.patch.object(self.kubo, "pin_records", return_value=[("a", "a", "original"), ("alias", "a", "different label")]):
            data = self.follow.adopt_legacy(legacy, "my98", self.names)
        self.assertEqual(data["records"], {"a": "original", "alias": "different label"})
        self.kubo.recursive["alias"] = self.store.label
        self.follow.restore_legacy_adoption()
        self.assertEqual(self.kubo.recursive, {"a": "original", "alias": "different label"})

    def test_migration_rejects_pending_mismatch_and_missing_pin(self):
        self.sync()
        self.names.write_text("one\n")
        self.kubo.canonical = lambda cid, fds=(): cid
        legacy = Path(self.tmp.name) / "legacy"
        legacy.mkdir()
        (legacy / "current").write_text("a\n")
        (legacy / "history").write_text("a\n")
        (legacy / "pending").write_text("b\n")
        with self.assertRaisesRegex(s.Failure, "uncertain"):
            self.follow.adopt_legacy(legacy, "my98", self.names)
        (legacy / "pending").unlink()
        self.kubo.targets["one"] = "b"
        with self.assertRaisesRegex(s.Failure, "match IPNS"):
            self.follow.adopt_legacy(legacy, "my98", self.names)
        self.kubo.targets["one"] = "a"
        self.kubo.recursive.clear()
        with self.assertRaisesRegex(s.Failure, "not recursively pinned"):
            self.follow.adopt_legacy(legacy, "my98", self.names)
        self.assertFalse((Path(self.tmp.name) / "legacy-adoption.json").exists())

    def test_migration_interrupted_during_label_changes_restores(self):
        self.sync()
        self.names.write_text("one\n")
        self.kubo.canonical = lambda cid, fds=(): cid
        self.kubo.recursive.update(a="original", b="history")
        legacy = Path(self.tmp.name) / "legacy"
        legacy.mkdir()
        (legacy / "current").write_text("a\n")
        (legacy / "history").write_text("a\nb\n")
        self.kubo.lost.add("a")
        with self.assertRaises(s.Failure):
            self.follow.adopt_legacy(legacy, "my98", self.names)
        self.follow.restore_legacy_adoption()
        self.assertEqual(self.kubo.recursive, {"a": "original", "b": "history"})

    def test_actual_process_death_after_publish_recovers(self):
        self.publish()
        code = r"""
import importlib.util,sys,time
from pathlib import Path
spec=importlib.util.spec_from_file_location('tests',sys.argv[1])
t=importlib.util.module_from_spec(spec); spec.loader.exec_module(t)
store=t.s.Store(sys.argv[2]);store.initialize('peer')
k=t.FakeKubo();k.key_name=lambda key:'one'
k.names=lambda path:['one']
k.recursive={'a':store.label}
def disk(path,label=None,fds=()):
 if label is not None: k.recursive['b']=label
 return 'b'
k.import_disk=disk
def publish(key,cid,fds=()):
 print('published',flush=True)
 time.sleep(30)
k.publish=publish
t.s.Follower(store,k).publish(Path(sys.argv[2])/'disk.my98','my98',Path(sys.argv[2])/'names.txt')
"""
        self.disk.write_bytes(disk_bytes(2))
        child = subprocess.Popen([sys.executable, "-c", code, __file__, self.tmp.name], stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), "published")
            self.assertEqual(self.store.publication("one")["stage"], "publishing")
        finally:
            child.kill()
            child.wait(timeout=5)
            child.stdout.close()
        self.kubo.recursive["b"] = self.store.label
        self.kubo.targets["one"] = "b"
        self.assertTrue(self.sync())
        self.assertEqual(self.kubo.recursive, {"b": self.store.label})
        self.assertFalse(self.store.snapshot("one").exists())


class PublicationAdapter(unittest.TestCase):
    def test_default_key_cli(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(s.Kubo, "identity", return_value="peer"), mock.patch.object(s.Follower, "publish", return_value=True) as publish:
            self.assertEqual(s.main(["publish", "disk.my98", "--names", "names", "--state", tmp]), 0)
            self.assertEqual(publish.call_args.args, ("disk.my98", "my98", "names"))

    def test_key_alias_and_missing_key(self):
        k = s.Kubo()
        with mock.patch.object(k, "call", side_effect=["QmOne my98\nQmTwo other", "k123"]):
            self.assertEqual(k.key_name("other"), "k123")
        with mock.patch.object(k, "call", return_value="QmOne my98"):
            with self.assertRaises(s.Failure):
                k.key_name("absent")

    def test_publish_deadline(self):
        k = s.Kubo()
        with mock.patch.object(k, "call") as call:
            k.publish("my98", "b123", (7,))
        self.assertEqual(call.call_args.kwargs, {"timeout": 120, "fds": (7,)})

    def test_legacy_schema_status_and_upgrade(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = s.Store(tmp)
            store.initialize("peer")
            with store.db() as db:
                db.execute("DROP TABLE publications")
            self.assertEqual(store.status(), {"names": [], "cleanup_pending": []})
            store.initialize("peer")
            self.assertIsNone(store.publication("missing"))


if __name__ == "__main__":
    unittest.main()
