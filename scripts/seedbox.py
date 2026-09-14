#!/usr/bin/env python3
"""Publish and follow IPNS disk roots using a local Kubo daemon. See --help."""

import argparse
import concurrent.futures
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import shutil
import stat
import struct
import tempfile
import subprocess
import sys
import uuid


class Failure(Exception):
    pass


class Busy(Exception):
    pass


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def atomic_write(path, data):
    path = Path(path)
    fd, temporary = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def validate_disk(path):
    # This checks the container, not its encrypted descriptor or signature.
    if not stat.S_ISREG(Path(path).stat().st_mode):
        raise Failure("Disk must be a regular file")
    with Path(path).open("rb") as handle:
        info = os.fstat(handle.fileno())
        header = handle.read(198)
    if not stat.S_ISREG(info.st_mode) or len(header) != 198:
        raise Failure("Disk must be a readable regular .my98 file")
    version, chunk, size = struct.unpack_from("<IIQ", header, 8)
    if header[:8] != b"SLOPDSK\0" or version != 1 or chunk != 65536:
        raise Failure("Unsupported .my98 header, version or chunk size")
    if not 1 <= size <= (1 << 40) or info.st_size != 198 + size + ((size + chunk - 1) // chunk) * 62:
        raise Failure("Invalid .my98 logical or physical size")


class Kubo:
    def __init__(self, binary="ipfs", api="/ip4/127.0.0.1/tcp/5001"):
        self.binary, self.api = binary, api

    def call(self, *args, timeout=45, fds=()):
        command = [self.binary, "--api", self.api, "--timeout", f"{timeout}s", *args]
        try:
            result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    text=True, timeout=timeout + 5, pass_fds=tuple(fds))
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise Failure(f"Kubo {args[0]}: {exc}") from exc
        if result.returncode:
            raise Failure(f"Kubo {' '.join(args[:2])}: {result.stderr.strip()[:2000]}")
        return result.stdout.strip()

    def canonical(self, cid, fds=()):
        value = self.call("cid", "format", "-v", "1", "-b", "base32", "--", cid, fds=fds)
        if not re.fullmatch(r"b[a-z2-7]+", value):
            raise Failure("Kubo returned an invalid CID")
        return value

    def names(self, path):
        # Normalize aliases before taking locks or recording references.
        result = set()
        for number, line in enumerate(Path(path).read_text().splitlines(), 1):
            name = line.strip()
            if not name or name.startswith("#"):
                continue
            if name.startswith("/ipns/"):
                name = name[6:]
            if not re.fullmatch(r"(?:k[0-9a-z]+|Qm[1-9A-HJ-NP-Za-km-z]+)", name):
                raise Failure(f"Invalid IPNS key on line {number}; use a bare key or /ipns/key")
            name = self.call("cid", "format", "-v", "1", "-b", "base36",
                             "--mc", "libp2p-key", "--", name)
            if not re.fullmatch(r"k[0-9a-z]+", name):
                raise Failure(f"Invalid canonical IPNS key on line {number}")
            result.add(name)
        return sorted(result)

    def identity(self):
        return self.call("id", "--format=<id>")

    def resolve(self, name, fds=()):
        target = self.call("name", "resolve", "--nocache", "--", "/ipns/" + name, fds=fds)
        match = re.fullmatch(r"/ipfs/([A-Za-z0-9]+)", target)
        if not match:
            raise Failure("IPNS must resolve to a single /ipfs/CID disk root")
        return self.canonical(match[1], fds)

    def pin_records(self, kind, fds=()):
        # Listing roots distinguishes 'not pinned' from daemon/network failure.
        raw = self.call("pin", "ls", "--type=" + kind, "--names", "--enc=json", fds=fds)
        try:
            keys = json.loads(raw).get("Keys") or {}
            if not isinstance(keys, dict):
                raise ValueError("Keys is not an object")
            if not keys:
                return []
            normalized = self.call("cid", "format", "-v", "1", "-b", "base32", "--",
                                   *keys, fds=fds).splitlines()
            if len(normalized) != len(keys):
                raise ValueError("CID count mismatch")
            return [(raw, cid, info.get("Name", "")) for (raw, info), cid in zip(keys.items(), normalized)]
        except (ValueError, KeyError, AttributeError) as exc:
            raise Failure("Invalid Kubo pin listing") from exc

    def pins(self, kind, fds=()):
        result = {}
        for raw, cid, label in self.pin_records(kind, fds):
            # CIDv0/v1 aliases are distinct Kubo pins. A mixed owner group is
            # borrowed, regardless of JSON ordering; never overwrite evidence.
            result[cid] = label if cid not in result or result[cid] == label else ""
        return result

    def relabel(self, cid, label, fds=()):
        aliases = [raw for raw, canonical, _ in self.pin_records("recursive", fds) if canonical == cid]
        for raw in aliases:
            self.add(raw, label, fds)
        if not aliases:
            raise Failure("Cannot adopt an absent recursive pin")

    def add(self, cid, label, fds=()):
        self.call("pin", "add", "--recursive", "--name=" + label, "--", "/ipfs/" + cid,
                  timeout=1800, fds=fds)

    def remove(self, cid, fds=(), label=None):
        aliases = [(raw, owner) for raw, canonical, owner in self.pin_records("recursive", fds) if canonical == cid]
        if label is not None and any(owner != label for _, owner in aliases):
            return
        if aliases:
            self.call("pin", "rm", "--", *("/ipfs/" + raw for raw, _ in aliases), fds=fds)


    def key_name(self, key, fds=()):
        for line in self.call("key", "list", "-l", fds=fds).splitlines():
            identity, alias = line.split(None, 1)
            if alias == key:
                return self.call("cid", "format", "-v", "1", "-b", "base36",
                                 "--mc", "libp2p-key", "--", identity, fds=fds)
        raise Failure("Kubo key does not exist: " + key)

    def import_disk(self, path, label=None, fds=()):
        # Explicit, identical UnixFS settings for the dry run and real import.
        args = ["add", "-Q", "--cid-version=1", "--raw-leaves=true",
                "--chunker=size-262144", "--hash=sha2-256", "--wrap-with-directory=false",
                "--pin=" + ("false" if label is None else "true")]
        if label is None:
            args.append("--only-hash")
        else:
            args.append("--pin-name=" + label)
        return self.canonical(self.call(*args, "--", str(path), timeout=1800, fds=fds), fds)

    def publish(self, key, cid, fds=()):
        self.call("name", "publish", "--key=" + key, "--", "/ipfs/" + cid,
                  timeout=120, fds=fds)


class Store:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.database = self.directory / "state.sqlite3"

    @contextlib.contextmanager
    def db(self):
        db = sqlite3.connect(self.database, timeout=30)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def initialize(self, peer):
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        (self.directory / "locks").mkdir(mode=0o700, exist_ok=True)
        with self.db() as db:
            db.executescript("""
                BEGIN IMMEDIATE;
                CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS names (
                    name TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1,
                    current TEXT, pending TEXT, last_check TEXT, error TEXT);
                CREATE TABLE IF NOT EXISTS publications (
                    name TEXT PRIMARY KEY, cid TEXT NOT NULL, key TEXT NOT NULL,
                    stage TEXT NOT NULL, error TEXT);
                CREATE TABLE IF NOT EXISTS pins (
                    cid TEXT PRIMARY KEY, owned INTEGER NOT NULL, error TEXT);
            """)
            db.execute("INSERT OR IGNORE INTO meta VALUES ('peer', ?)", (peer,))
            db.execute("INSERT OR IGNORE INTO meta VALUES ('owner', ?)", (uuid.uuid4().hex,))
            if db.execute("SELECT value FROM meta WHERE key='peer'").fetchone()[0] != peer:
                raise Failure("State belongs to another Kubo node; use a separate state directory")
            self.label = "my98-seedbox:" + db.execute(
                "SELECT value FROM meta WHERE key='owner'").fetchone()[0]

    @contextlib.contextmanager
    def lock(self, key):
        filename = hashlib.sha256(key.encode()).hexdigest() + ".lock"
        with (self.directory / "locks" / filename).open("a") as handle:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise Busy(key) from exc
            # Closing, rather than LOCK_UN, keeps the lock alive in an inherited
            # Kubo CLI fd if this process dies while its RPC is still running.
            yield handle.fileno()

    def configure(self, names):
        with self.db() as db:
            db.execute("UPDATE names SET enabled=0")
            for name in names:
                db.execute("INSERT INTO names(name) VALUES (?) ON CONFLICT(name) "
                           "DO UPDATE SET enabled=1", (name,))

    def row(self, name):
        with self.db() as db:
            row = db.execute("SELECT * FROM names WHERE name=?", (name,)).fetchone()
            return dict(row) if row else None

    def update(self, name, **fields):
        with self.db() as db:
            db.execute("UPDATE names SET " + ",".join(k + "=?" for k in fields) + " WHERE name=?",
                       [*fields.values(), name])

    def rows(self):
        # Status is read-only, including when the state directory does not exist.
        if not self.database.exists():
            return []
        db = sqlite3.connect(self.database.resolve().as_uri() + "?mode=ro", uri=True)
        db.row_factory = sqlite3.Row
        try:
            return [dict(row) for row in db.execute("SELECT * FROM names ORDER BY name")]
        finally:
            db.close()

    def status(self):
        rows = self.rows()
        if not self.database.exists():
            return {"names": [], "cleanup_pending": []}
        db = sqlite3.connect(self.database.resolve().as_uri() + "?mode=ro", uri=True)
        db.row_factory = sqlite3.Row
        try:
            has_publications = db.execute("SELECT 1 FROM sqlite_master WHERE name='publications'").fetchone()
            publications = [dict(row) for row in db.execute("SELECT * FROM publications")] if has_publications else []
            for row in rows:
                row["publication"] = next((p for p in publications if p["name"] == row["name"]), None)
            cleanup = [dict(row) for row in db.execute("SELECT cid, error FROM pins WHERE owned=1 "
                "AND NOT EXISTS (SELECT 1 FROM names WHERE current=cid OR pending=cid)")]
            cleanup = [p for p in cleanup if p["cid"] not in {v["cid"] for v in publications}]
            return {"names": rows, "cleanup_pending": cleanup}
        finally:
            db.close()


    def snapshot(self, name):
        return self.directory / (hashlib.sha256(name.encode()).hexdigest() + ".snapshot")

    def publication(self, name):
        with self.db() as db:
            row = db.execute("SELECT * FROM publications WHERE name=?", (name,)).fetchone()
            return dict(row) if row else None

    def commit_publication(self, name, cid):
        with self.db() as db:
            db.execute("UPDATE names SET current=?, pending=NULL, error=NULL WHERE name=?", (cid, name))
            db.execute("DELETE FROM publications WHERE name=?", (name,))


class Follower:
    def __init__(self, store, kubo):
        self.store, self.kubo = store, kubo

    def follow(self, name):
        try:
            with self.store.lock("name:" + name) as name_fd:
                try:
                    # A killed publisher may leave scratch data; no active importer
                    # can hold this name lock at the same time.
                    self.store.snapshot(name).unlink(missing_ok=True)
                    row = self.store.row(name)
                    publication = self.store.publication(name)
                    if publication:
                        self.store.update(name, last_check=now())
                        # An uncertain publication owns the name until it is confirmed.
                        # In particular, an older IPNS result cannot overwrite its intent.
                        cid = self.kubo.resolve(name, (name_fd,))
                        if cid != publication["cid"]:
                            raise Failure("Publication awaiting IPNS confirmation; retry the same disk")
                        with self.store.lock("cid:" + cid) as cid_fd:
                            self.ensure_pin(cid, (name_fd, cid_fd))
                            self.store.commit_publication(name, cid)
                        return True
                    if not row["enabled"]:
                        self.store.update(name, current=None, pending=None, error=None)
                        return True
                    self.store.update(name, last_check=now())
                    cid = self.kubo.resolve(name, (name_fd,))
                    self.store.update(name, pending=cid)
                    with self.store.lock("cid:" + cid) as cid_fd:
                        fds = (name_fd, cid_fd)
                        self.ensure_pin(cid, fds)
                        self.store.update(name, current=cid, pending=None, error=None)
                    return True
                except Busy:
                    return True  # Another name/process is already obtaining this CID.
                except (Failure, OSError, sqlite3.Error) as exc:
                    self.store.update(name, error=str(exc))
                    with self.store.db() as db:
                        db.execute("UPDATE publications SET error=? WHERE name=?", (str(exc), name))
                    print(f"{name}: {exc}", file=sys.stderr)
                    return False
        except Busy:
            return True

    def ensure_pin(self, cid, fds, path=None):
        recursive = self.kubo.pins("recursive", fds)
        with self.store.db() as db:
            pin = db.execute("SELECT owned FROM pins WHERE cid=?", (cid,)).fetchone()
        if cid in recursive:
            # A foreign pin, including a renamed formerly owned
            # pin, must never be removed by this follower.
            owned = bool(pin and pin[0] and recursive[cid] == self.store.label)
            with self.store.db() as db:
                db.execute("INSERT OR REPLACE INTO pins(cid,owned) VALUES (?,?)", (cid, int(owned)))
        else:
            direct = self.kubo.pins("direct", fds)
            owned = cid not in direct
            # Write intent before invoking Kubo: a lost response
            # can be reconciled using the durable label and CID.
            with self.store.db() as db:
                db.execute("INSERT OR REPLACE INTO pins(cid,owned) VALUES (?,?)", (cid, int(owned)))
            label = self.store.label if owned else direct[cid]
            if path is None:
                self.kubo.add(cid, label, fds)
            elif self.kubo.import_disk(path, label, fds) != cid:
                raise Failure("Disk CID changed during import")

    def cleanup(self):
        ok = True
        with self.store.db() as db:
            cids = [r[0] for r in db.execute("SELECT cid FROM pins")]
        for cid in cids:
            try:
                with self.store.lock("cid:" + cid) as cid_fd:
                    with self.store.db() as db:
                        referenced = db.execute("SELECT 1 FROM names WHERE current=? OR pending=?",
                                                (cid, cid)).fetchone()
                        pin = db.execute("SELECT owned FROM pins WHERE cid=?", (cid,)).fetchone()
                        publishing = db.execute("SELECT 1 FROM publications WHERE cid=?", (cid,)).fetchone()
                    if referenced or publishing or pin is None:
                        continue
                    if pin[0]:
                        recursive = self.kubo.pins("recursive", (cid_fd,))
                        if recursive.get(cid) == self.store.label:
                            self.kubo.remove(cid, (cid_fd,), label=self.store.label)
                    with self.store.db() as db:
                        db.execute("DELETE FROM pins WHERE cid=?", (cid,))
            except Busy:
                continue
            except (Failure, OSError, sqlite3.Error) as exc:
                with self.store.db() as db:
                    db.execute("UPDATE pins SET error=? WHERE cid=?", (str(exc), cid))
                print(f"Cleanup {cid}: {exc}", file=sys.stderr)
                ok = False
        return ok

    def sync(self, names):
        # Configuration and its snapshot are serialized, never downloads.
        try:
            with self.store.lock("config"):
                self.store.configure(names() if callable(names) else names)
                work = [row["name"] for row in self.store.rows()]
        except Busy:
            return True
        if not work:
            return self.cleanup()
        ok = True
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(work)) as pool:
            futures = [pool.submit(self.follow, name) for name in work]
            for future in concurrent.futures.as_completed(futures):
                ok = future.result() and ok
                # Reclaim finished disks even while another is still downloading.
                ok = self.cleanup() and ok
        return ok


    def publish(self, source, key, names_path):
        validate_disk(source)
        name = self.kubo.key_name(key)
        with self.store.lock("name:" + name) as name_fd:
            with self.store.lock("config"):
                path = Path(names_path)
                names = self.kubo.names(path)
                if name not in names:
                    original = path.read_bytes()
                    atomic_write(path, original + (b"\n" if original and not original.endswith(b"\n") else b"")
                                 + name.encode() + b"\n")
                    names.append(name)
                self.store.configure(names)
            snapshot = self.store.snapshot(name)
            if Path(source).resolve() == snapshot.resolve():
                raise Failure("Source uses the reserved snapshot path")
            try:
                # The name lock also protects this recoverable scratch filename.
                with Path(source).open("rb") as src, snapshot.open("wb") as dest:
                    before = os.fstat(src.fileno())
                    if not stat.S_ISREG(before.st_mode):
                        raise Failure("Disk must be a regular file")
                    shutil.copyfileobj(src, dest, 1024 * 1024)
                    dest.flush()
                    os.fsync(dest.fileno())
                    after = os.fstat(src.fileno())
                    if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                        raise Failure("Source disk changed while being copied")
                validate_disk(snapshot)
                cid = self.kubo.import_disk(snapshot, fds=(name_fd,))
                pending = self.store.publication(name)
                if pending and pending["cid"] != cid:
                    raise Failure("Another publication is uncertain; retry its original disk first")
                with self.store.db() as db:
                    db.execute("INSERT INTO publications VALUES (?,?,?,'adding',NULL) "
                               "ON CONFLICT(name) DO UPDATE SET error=NULL", (name, cid, key))
                with self.store.lock("cid:" + cid) as cid_fd:
                    fds = (name_fd, cid_fd)
                    self.ensure_pin(cid, fds, snapshot)
                    with self.store.db() as db:
                        db.execute("UPDATE publications SET stage='publishing' WHERE name=?", (name,))
                    self.kubo.publish(key, cid, fds)
                    with self.store.db() as db:
                        db.execute("UPDATE publications SET stage='confirming' WHERE name=?", (name,))
                    self.store.update(name, last_check=now())
                    if self.kubo.resolve(name, fds) != cid:
                        raise Failure("Publication awaiting IPNS confirmation; retry the same disk")
                    self.store.commit_publication(name, cid)
            except (Failure, OSError, sqlite3.Error, Busy) as exc:
                with self.store.db() as db:
                    db.execute("UPDATE publications SET error=? WHERE name=?", (str(exc), name))
                raise
            finally:
                snapshot.unlink(missing_ok=True)
        return self.cleanup()


    def adopt_legacy(self, legacy, key, names_path):
        """One-time adoption with cron paused; legacy must be retired afterwards.

        Saves original labels and a SQLite backup before touching pin ownership.
        On interruption, keep cron paused and call restore_legacy_adoption first.
        """
        legacy = Path(legacy)
        old_lock = legacy / "lock"
        try:
            old_lock.mkdir()
        except FileExistsError as exc:
            raise Busy("Legacy publisher is locked") from exc
        try:
            with contextlib.ExitStack() as locks:
                fds = [locks.enter_context(self.store.lock("config"))]
                name = self.kubo.key_name(key, fds)
                configured = self.kubo.names(names_path)
                if name not in configured:
                    raise Failure("Legacy identity must already be configured")
                for item in sorted({name, *(r["name"] for r in self.store.rows())}):
                    fds.append(locks.enter_context(self.store.lock("name:" + item)))
                if (legacy / "pending").exists():
                    raise Failure("Legacy publication is uncertain")
                if any(r["pending"] for r in self.store.rows()):
                    raise Failure("Follower has a pending download")
                with self.store.db() as db:
                    if db.execute("SELECT 1 FROM publications").fetchone():
                        raise Failure("Follower has an uncertain publication")
                current = self.kubo.canonical((legacy / "current").read_text().strip(), fds)
                history = {self.kubo.canonical(c, fds) for c in (legacy / "history").read_text().splitlines() if c.strip()}
                if current not in history:
                    raise Failure("Legacy current is absent from its history")
                for cid in sorted(history):
                    fds.append(locks.enter_context(self.store.lock("cid:" + cid)))
                if self.kubo.resolve(name, fds) != current:
                    raise Failure("Legacy current does not match IPNS")
                row = self.store.row(name)
                if row and row["current"] not in (None, current):
                    raise Failure("Follower and legacy current differ")
                recursive = self.kubo.pins("recursive", fds)
                if current not in recursive:
                    raise Failure("Legacy current is not recursively pinned")
                manifest = self.store.directory / "legacy-adoption.json"
                backup = self.store.directory / "legacy-adoption.sqlite3"
                if manifest.exists() or backup.exists():
                    raise Failure("Adoption backup already exists; inspect or restore it first")
                with self.store.db() as db, contextlib.closing(sqlite3.connect(backup)) as copy:
                    db.backup(copy)
                original = {cid: recursive[cid] for cid in history if cid in recursive}
                records = {raw: label for raw, cid, label in self.kubo.pin_records("recursive", fds) if cid in history}
                atomic_write(manifest, (json.dumps({"name": name, "current": current,
                    "labels": original, "records": records, "backup": str(backup), "stage": "prepared"}, indent=2) + "\n").encode())
                # All history CID locks remain held through label changes and commit.
                for cid in original:
                    self.kubo.relabel(cid, self.store.label, fds)
                with self.store.db() as db:
                    for cid in original:
                        db.execute("INSERT OR REPLACE INTO pins(cid,owned) VALUES (?,1)", (cid,))
                    db.execute("INSERT INTO names(name,current) VALUES (?,?) ON CONFLICT(name) "
                               "DO UPDATE SET current=excluded.current, pending=NULL, error=NULL, enabled=1",
                               (name, current))
                data = json.loads(manifest.read_text())
                data["stage"] = "adopted"
                atomic_write(manifest, (json.dumps(data, indent=2) + "\n").encode())
                return data
        finally:
            old_lock.rmdir()

    def restore_legacy_adoption(self):
        """Restore immediately after a failed migration, before resuming any work."""
        manifest = self.store.directory / "legacy-adoption.json"
        data = json.loads(manifest.read_text())
        with contextlib.ExitStack() as locks:
            fds = [locks.enter_context(self.store.lock("config"))]
            for name in sorted({data["name"], *(r["name"] for r in self.store.rows())}):
                fds.append(locks.enter_context(self.store.lock("name:" + name)))
            for cid in sorted(data["labels"]):
                fds.append(locks.enter_context(self.store.lock("cid:" + cid)))
            if "records" in data:
                for raw, label in data["records"].items():
                    self.kubo.add(raw, label, fds)
            else:
                # Compatibility with the first installed adoption manifest.
                for cid, label in data["labels"].items():
                    self.kubo.relabel(cid, label, fds)
            with contextlib.closing(sqlite3.connect(data["backup"])) as source, self.store.db() as dest:
                source.backup(dest)
            data["stage"] = "restored"
            atomic_write(manifest, (json.dumps(data, indent=2) + "\n").encode())


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, epilog="Run sync from cron every minute. "
        "Use one configuration and state directory per Kubo node. This tool never runs GC.")
    parser.add_argument("command", choices=("sync", "status", "publish"))
    parser.add_argument("file", nargs="?", help="Disk to publish (structural validation only)")
    parser.add_argument("--key", default="my98", help="Existing Kubo publication key (default: my98)")
    parser.add_argument("--names", help="UTF-8 file: one IPNS key per line; # comments allowed")
    parser.add_argument("--state", required=True, help="Persistent private state directory")
    parser.add_argument("--api", default="/ip4/127.0.0.1/tcp/5001", help="Kubo API multiaddress")
    parser.add_argument("--ipfs", default="ipfs", help="Kubo executable (absolute path for cron)")
    args = parser.parse_args(argv)
    os.umask(0o077)
    try:
        store = Store(args.state)
        if args.command == "status":
            print(json.dumps(store.status(), indent=2))
            return 0
        if not args.names:
            parser.error(args.command + " requires --names")
        kubo = Kubo(args.ipfs, args.api)
        store.initialize(kubo.identity())
        follower = Follower(store, kubo)
        if args.command == "publish":
            if not args.file:
                parser.error("publish requires a disk file")
            return 0 if follower.publish(args.file, args.key, args.names) else 1
        if args.file:
            parser.error("Only publish accepts a disk file")
        return 0 if follower.sync(lambda: kubo.names(args.names)) else 1
    except Busy as exc:
        print("Operation busy; retry later: " + str(exc), file=sys.stderr)
        return 1
    except (Failure, OSError, sqlite3.Error) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
