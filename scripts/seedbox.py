#!/usr/bin/env python3
"""Publish and follow IPNS disk roots using a local Kubo daemon. See --help."""

import argparse
import base64
import getpass
import hmac
import unicodedata
import warnings
import concurrent.futures
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import pwd
import shlex
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


def validate_state(path, base):
    """Structural validation only; the browser authenticates the encrypted records."""
    with Path(path).open("rb") as handle:
        info = os.fstat(handle.fileno())
        prefix = handle.read(12)
        if not stat.S_ISREG(info.st_mode) or len(prefix) != 12 or prefix[:8] != b"MY98STAT":
            raise Failure("Unsupported .my98state file")
        length = struct.unpack_from("<I", prefix, 8)[0]
        if not 1 <= length <= 4096:
            raise Failure("Invalid state header length")
        try:
            header = json.loads(handle.read(length))
        except (ValueError, UnicodeError) as exc:
            raise Failure("Invalid state header") from exc
    limit = 1 << 30
    if (not isinstance(header, dict) or type(header.get("version")) is not int or header["version"] != 1 or
            type(header.get("raw")) is not int or not 4 <= header["raw"] <= limit or
            type(header.get("packed")) is not int or not 1 <= header["packed"] <= limit):
        raise Failure("Unsupported state size or version")
    for key, size in (("base", 198), ("nonce", 16)):
        value = header.get(key)
        if not isinstance(value, list) or len(value) != size or any(type(v) is not int or not 0 <= v <= 255 for v in value):
            raise Failure("Invalid state " + key)
    if bytes(header["base"]) != base:
        raise Failure("State belongs to a different base disk")
    packed = header["packed"]
    if info.st_size != 12 + length + packed + ((packed + 1048575) // 1048576) * 62 or info.st_size > limit + 65536:
        raise Failure("Truncated state or trailing bytes")


def validate_profiles(value, disk, header, state_hash=None):
    """Bounded, public read hints. Neither their metrics nor ranges authorize data."""
    if not isinstance(value, list) or len(value) > 2:
        raise Failure("Invalid load profile list")
    units = (struct.unpack_from('<Q', header, 16)[0] + 65535) // 65536
    seen = set()
    for p in value:
        if not isinstance(p, dict) or type(p.get('version')) is not int or p['version'] != 2 or p.get('cid') != disk or type(p.get('unitBytes')) is not int or p['unitBytes'] != 65536:
            raise Failure("Load profile must use version 2 and the current disk CID")
        origin = p.get('origin')
        if not isinstance(origin, dict) or origin.get('kind') not in ('boot', 'state') or origin['kind'] in seen:
            raise Failure("Invalid or duplicate load profile origin")
        seen.add(origin['kind'])
        if origin['kind'] == 'state':
            if not state_hash or origin.get('sha256') != state_hash:
                raise Failure("Load profile does not match the published state")
        elif 'sha256' in origin:
            raise Failure("Boot profile cannot name a state")
        ranges = p.get('ranges')
        if not isinstance(ranges, list) or len(ranges) != 32:
            raise Failure("Load profiles require 32 range slots")
        ordered = []
        for r in ranges:
            if r is None:
                continue
            if not isinstance(r, list) or len(r) != 2 or any(type(n) is not int for n in r) or not 0 <= r[0] <= r[1] < units:
                raise Failure("Invalid load profile range")
            ordered.append(r)
        ordered.sort()
        if any(a[1] >= b[0] for a, b in zip(ordered, ordered[1:])):
            raise Failure("Overlapping load profile ranges")
        for field in ('observedUnits', 'coveredUnits', 'downloadUnits'):
            if field in p and (type(p[field]) is not int or not 0 <= p[field] <= units):
                raise Failure("Invalid load profile metric")
        if 'minUtilization' in p and (type(p['minUtilization']) not in (int, float) or not 0 < p['minUtilization'] <= 1):
            raise Failure("Invalid load profile utilization")
    return value


def read_profiles(data):
    if len(data) > 65536:
        raise Failure("Load profiles exceed 64 KiB")
    try:
        return json.loads(data)
    except (ValueError, UnicodeError) as exc:
        raise Failure("Invalid load profiles JSON") from exc


def snapshot_file(source, target):
    if Path(source).resolve() == target.resolve():
        raise Failure("Source uses the reserved snapshot path")
    with Path(source).open("rb") as src, target.open("wb") as dest:
        before = os.fstat(src.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise Failure("Source must be a regular file")
        shutil.copyfileobj(src, dest, 1024 * 1024)
        dest.flush()
        os.fsync(dest.fileno())
        after = os.fstat(src.fileno())
        if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise Failure("Source changed while being copied")


def find_ipfs(explicit=None):
    if explicit:
        return os.path.expanduser(explicit)
    candidates = [shutil.which("ipfs")]
    if sys.platform == "darwin":
        bundled = "IPFS Desktop.app/Contents/Resources/app.asar.unpacked/node_modules/kubo/kubo/ipfs"
        candidates += [str(Path("/Applications") / bundled),
                       str(Path.home() / "Applications" / bundled)]
    candidates += ["/opt/homebrew/bin/ipfs", "/usr/local/bin/ipfs", "/usr/bin/ipfs"]
    seen = set()
    for candidate in candidates:
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        try:
            result = subprocess.run([candidate, "version"], capture_output=True,
                                    text=True, timeout=5)
            if result.returncode == 0 and result.stdout.strip().startswith("ipfs version "):
                return candidate
        except (OSError, subprocess.TimeoutExpired):
            continue
    raise Failure("Kubo executable not found. Install Kubo/IPFS Desktop or use --ipfs PATH.")


def derive_private_key(username, password, machine):
    """Identity v2, identical to src/crypto/src/lib.rs; PKCS8 Ed25519 seed."""
    from argon2.low_level import Type, hash_secret_raw
    fields = [username, password, machine]
    if any(not field or len(field.encode("utf-8")) > 4096 for field in fields):
        raise Failure("Credentials must contain between 1 and 4096 UTF-8 bytes")
    username = unicodedata.normalize("NFC", username).encode("utf-8")
    machine = unicodedata.normalize("NFC", machine).encode("utf-8")
    if len(username) > 4096 or len(machine) > 4096:
        raise Failure("Normalized credential exceeds 4096 UTF-8 bytes")
    framed = b"slop86/identity/v2\0"
    for field in (username, machine):
        framed += struct.pack("<I", len(field)) + field
    salt = hashlib.sha256(framed).digest()[:16]
    master = hash_secret_raw(password.encode("utf-8"), salt, time_cost=3,
                             memory_cost=65536, parallelism=4, hash_len=32,
                             type=Type.ID, version=19)
    prk = hmac.new(b"slop86/keys/v1", master, hashlib.sha256).digest()
    seed = hmac.new(prk, b"slop86/signing/v1\x01", hashlib.sha256).digest()
    encoded = base64.b64encode(bytes.fromhex("302e020100300506032b657004220420") + seed)
    return b"-----BEGIN PRIVATE KEY-----\n" + encoded + b"\n-----END PRIVATE KEY-----\n"


def login_python(store):
    # Only login needs Argon2. Keep its dependencies out of the system Python.
    runtime = store.directory / "login-python"
    python = runtime / "bin" / "python"
    with store.lock("login-runtime"):
        if not python.exists():
            print("Preparing login dependencies...", flush=True)
            try:
                subprocess.run([sys.executable, "-m", "venv", str(runtime)], check=True)
            except subprocess.CalledProcessError as exc:
                raise Failure("Cannot create the login environment; install Python's venv support and retry") from exc
        try:
            probe = subprocess.run([str(python), "-c", "from argon2.low_level import hash_secret_raw"],
                                   capture_output=True, timeout=15)
        except subprocess.TimeoutExpired as exc:
            raise Failure("Login dependency check timed out; retry login") from exc
        if probe.returncode:
            print("Installing Argon2 for login...", flush=True)
            try:
                subprocess.run([str(python), "-m", "pip", "install", "--disable-pip-version-check",
                                "argon2-cffi==25.1.0"], check=True, timeout=300)
            except subprocess.TimeoutExpired as exc:
                raise Failure("Argon2 installation exceeded 300 seconds; check the build output above") from exc
            except subprocess.CalledProcessError as exc:
                raise Failure("Cannot install Argon2 for login; see the pip error above") from exc
    return str(python)


def login(store, kubo, key, names_path):
    if key == "self":
        raise Failure("Use a publication key name such as my98, not the daemon's self key")
    python = login_python(store)
    with store.lock("key:" + key) as key_fd:
        username = input("Username: ")
        # Refuse getpass's echoing fallback rather than exposing a password.
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            try:
                password = getpass.getpass("Password: ")
            except getpass.GetPassWarning as exc:
                raise Failure("A terminal with hidden password input is required for login") from exc
        machine = input("Machine: ")
        credentials = {"username": username, "password": password, "machine": machine}
        if any(not value or len(value.encode("utf-8")) > 4096 for value in credentials.values()):
            raise Failure("Credentials must contain between 1 and 4096 UTF-8 bytes")
        helper = ("import json,runpy,sys; "
                  "module=runpy.run_path(sys.argv[1]); "
                  "sys.stdout.buffer.write(module['derive_private_key'](**json.load(sys.stdin)))")
        print("Deriving identity...", flush=True)
        try:
            result = subprocess.run([python, "-c", helper, str(Path(__file__).resolve())],
                                    input=json.dumps(credentials).encode("utf-8"),
                                    capture_output=True, timeout=120, pass_fds=(key_fd,))
        except subprocess.TimeoutExpired as exc:
            raise Failure("Identity derivation timed out") from exc
        finally:
            password = None
            credentials.clear()
        if result.returncode or not result.stdout.startswith(b"-----BEGIN PRIVATE KEY-----"):
            # Never echo helper output: it handles credentials and private material.
            raise Failure("Identity derivation failed; check credentials and the login environment")
        temporary_key = "my98-login-" + uuid.uuid4().hex
        try:
            # A private temporary file is required by Kubo's key import command.
            # It is removed immediately after import, including on ordinary errors.
            with tempfile.TemporaryDirectory(prefix=".login-", dir=store.directory) as temp:
                pem = Path(temp) / "key.pem"
                fd = os.open(pem, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "wb") as handle:
                    handle.write(result.stdout)
                del result
                imported = kubo.call("key", "import", "--format=pem-pkcs8-cleartext", "--",
                                     temporary_key, str(pem), fds=(key_fd,))
            name = kubo.name(imported)
            existing = {}
            for line in kubo.call("key", "list", "-l", fds=(key_fd,)).splitlines():
                identity, alias = line.strip().split(None, 1)
                existing[alias] = identity
            if key in existing:
                if kubo.name(existing[key]) != name:
                    raise Failure(f"Key '{key}' already belongs to another identity. Use login --key ANOTHER_NAME")
            else:
                kubo.call("key", "rename", "--", temporary_key, key, fds=(key_fd,))
            Follower(store, kubo).add_name(name, names_path)
            print(f"Logged in: {name} (key: {key})")
            print("Ready to publish" + ("." if key == "my98" else f" with --key {key}."))
        finally:
            # Remove only our temporary alias; never replace/remove an existing key.
            try:
                kubo.call("key", "rm", "--", temporary_key, fds=(key_fd,))
            except Failure:
                pass  # Already renamed, or daemon unavailable; the durable key is preserved.


class Kubo:
    def __init__(self, binary="ipfs", api="/ip4/127.0.0.1/tcp/5001"):
        self.binary, self.api = binary, api

    def call(self, *args, timeout=45, fds=(), binary=False, input_data=None):
        command = [self.binary, "--api", self.api, "--timeout", f"{timeout}s", *args]
        try:
            result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    text=not binary, input=input_data, timeout=timeout + 5, pass_fds=tuple(fds))
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise Failure(f"Kubo {args[0]}: {exc}") from exc
        if result.returncode:
            error = result.stderr.decode("utf-8", errors="replace") if binary else result.stderr
            raise Failure(f"Kubo {' '.join(args[:2])}: {error.strip()[:2000]}")
        return result.stdout if binary else result.stdout.strip()

    def canonical(self, cid, fds=(), timeout=45):
        value = self.call("cid", "format", "-v", "1", "-b", "base32", "--", cid, fds=fds, timeout=timeout)
        if not re.fullmatch(r"b[a-z2-7]+", value):
            raise Failure("Kubo returned an invalid CID")
        return value

    def name(self, value):
        name = value.strip()
        if name.startswith("/ipns/"):
            name = name[6:]
        if not re.fullmatch(r"(?:k[0-9a-z]+|Qm[1-9A-HJ-NP-Za-km-z]+)", name):
            raise Failure("Invalid public IPNS key; use k51... or /ipns/k51...")
        name = self.call("cid", "format", "-v", "1", "-b", "base36",
                         "--mc", "libp2p-key", "--", name)
        if not re.fullmatch(r"k[0-9a-z]+", name):
            raise Failure("Invalid canonical IPNS key")
        return name

    def names(self, path):
        result = set()
        for number, line in enumerate(Path(path).read_text().splitlines(), 1):
            value = line.strip()
            if not value or value.startswith("#"):
                continue
            try:
                result.add(self.name(value))
            except Failure as exc:
                raise Failure(f"Line {number}: {exc}") from exc
        return sorted(result)

    def identity(self):
        return self.call("id", "--format=<id>")

    def resolve(self, name, fds=()):
        return self.resolve_record(name, fds)["cid"]

    def resolve_record(self, name, fds=()):
        # name resolve --nocache can still return this daemon's own publication
        # instead of the newer network record when it holds the same signing key.
        record = self.call("routing", "get", "--", "/ipns/" + name,
                           timeout=24, fds=fds, binary=True)
        raw = self.call("name", "inspect", "--dump=false", "--enc=json", "--verify=" + name,
                        timeout=3, fds=fds, binary=True, input_data=record)
        try:
            info = json.loads(raw)
            if info["Validation"]["Valid"] is not True:
                raise Failure("Invalid or expired IPNS record")
            entry = info["Entry"]
            expires = datetime.datetime.fromisoformat(entry["Validity"].replace("Z", "+00:00"))
            if entry["ValidityType"] != 0 or expires.tzinfo is None or expires <= datetime.datetime.now(datetime.timezone.utc):
                raise Failure("Invalid or expired IPNS record")
            sequence = entry["Sequence"]
            if type(sequence) is not int or not 0 <= sequence < 1 << 64:
                raise Failure("Invalid IPNS sequence")
            target = entry["Value"]
            match = re.fullmatch(r"/ipfs/([A-Za-z0-9]+)", target)
        except (ValueError, KeyError, TypeError) as exc:
            raise Failure("Invalid IPNS record inspection") from exc
        if not match:
            raise Failure("IPNS must resolve to a single /ipfs/CID disk root")
        return {"cid": self.canonical(match[1], fds, timeout=3),
                "sequence": str(sequence)}

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
            identity, alias = line.strip().split(None, 1)
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

    def publication_parts(self, cid, fds=(), profiles=False):
        try:
            return self._publication_parts(cid, fds, profiles)
        except (ValueError, KeyError, TypeError, AttributeError) as exc:
            raise Failure("Invalid publication metadata returned by Kubo") from exc

    def _publication_parts(self, cid, fds=(), profiles=False):
        path = "/ipfs/" + cid
        profiles_cid = None
        info = json.loads(self.call("files", "stat", "--enc=json", "--", path, fds=fds))
        if info["Type"] == "directory":
            links = json.loads(self.call("dag", "get", "--", path, fds=fds)).get("Links") or []
            names = {link["Name"] for link in links}
            if not 1 <= len(links) <= 3 or len(names) != len(links) or 'disk.my98' not in names or not names <= {'disk.my98', 'state.my98state', 'load-profiles.json'}:
                raise Failure("Unsupported publication directory")
            parts = {link["Name"]: self.canonical(link["Hash"]["/"], fds) for link in links}
            for child in parts.values():
                if json.loads(self.call("files", "stat", "--enc=json", "--", "/ipfs/" + child, fds=fds))["Type"] != "file":
                    raise Failure("Publication entries must be files")
            disk, state = parts["disk.my98"], parts.get("state.my98state")
            profiles_cid = parts.get('load-profiles.json')
        elif info["Type"] == "file":
            disk, state = cid, None
        else:
            raise Failure("Unsupported publication root")
        header = self.call("cat", "--length=198", "--", "/ipfs/" + disk, fds=fds, binary=True)
        if len(header) != 198 or header[:8] != b"SLOPDSK\0":
            raise Failure("Publication does not contain a my98 disk")
        version, chunk, size = struct.unpack_from("<IIQ", header, 8)
        actual = json.loads(self.call("files", "stat", "--enc=json", "--", "/ipfs/" + disk, fds=fds))["Size"]
        if version != 1 or chunk != 65536 or not 1 <= size <= 1 << 40 or actual != 198 + size + ((size + chunk - 1) // chunk) * 62:
            raise Failure("Invalid published disk")
        return (disk, state, header, profiles_cid) if profiles else (disk, state, header)

    def state_hash(self, cid, fds=()):
        if cid is None:
            return None
        size = json.loads(self.call('files', 'stat', '--enc=json', '--', '/ipfs/' + cid, fds=fds))['Size']
        if type(size) is not int or not 12 <= size <= (1 << 30) + 65536:
            raise Failure('Invalid published state size')
        digest = hashlib.sha256()
        for offset in range(0, size, 8 * 1024 * 1024):
            length = min(size-offset, 8 * 1024 * 1024)
            data = self.call('cat', '--offset=' + str(offset), '--length=' + str(length), '--', '/ipfs/' + cid, fds=fds, binary=True)
            if len(data) != length:
                raise Failure('Incomplete published state')
            digest.update(data)
        return digest.hexdigest()

    def remove_staging(self, path, fds=()):
        # ls of the parent distinguishes an already removed path from RPC failure.
        parent, leaf = path.rsplit("/", 1)
        self.call("files", "mkdir", "-p", "--", parent, fds=fds)
        entries = json.loads(self.call("files", "ls", "--enc=json", "--", parent, fds=fds)).get("Entries") or []
        if any(entry["Name"] == leaf for entry in entries):
            self.call("files", "rm", "-r", "--", path, fds=fds)

    def publish(self, key, cid, fds=()):
        sequence = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d%H%M%S")
        self.call("name", "publish", "--key=" + key, "--sequence=" + sequence,
                  "--", "/ipfs/" + cid, timeout=120, fds=fds)


    def renew(self, name, record, fds=()):
        # Only key holders can extend validity. Never create a newer sequence for
        # an automatic renewal: a disconnected replica must not outrank updates.
        key = None
        for line in self.call("key", "list", "-l", fds=fds).splitlines():
            identity, alias = line.strip().split(None, 1)
            if self.name(identity) == name:
                key = alias
                break
        if key is None:
            return False
        args = ("name", "publish", "--key=" + key)
        try:
            self.call(*args, "--sequence=" + record["sequence"],
                      "--", "/ipfs/" + record["cid"], timeout=120, fds=fds)
        except Failure as exc:
            # Kubo rejects an explicit sequence equal to its local publication.
            # Omission preserves the sequence ONLY if its local value matches.
            if "sequence number must be greater than the current record sequence" not in str(exc):
                raise
            local = self.call("name", "resolve", "--nocache", "--", name, timeout=24, fds=fds)
            if not local.startswith("/ipfs/") or self.canonical(local[6:], fds) != record["cid"]:
                raise Failure("Local Kubo publication differs; refusing automatic renewal") from exc
            self.call(*args, "--", local, timeout=120, fds=fds)
        return True


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
                CREATE TABLE IF NOT EXISTS staging (name TEXT PRIMARY KEY, path TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS pins (
                    cid TEXT PRIMARY KEY, owned INTEGER NOT NULL, error TEXT);
            """)
            # TEXT preserves the full IPNS uint64 range in SQLite. Existing
            # installations establish their baseline on the first verified record.
            columns = {r[1] for r in db.execute("PRAGMA table_info(names)")}
            for column in ("seen_sequence", "seen_cid", "renewed_sequence", "renewed_at"):
                if column not in columns:
                    db.execute("ALTER TABLE names ADD COLUMN " + column + " TEXT")
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


    def observe(self, name, record):
        # Called under the name lock, before downloading or replacing any pin.
        # Remember even a newer record whose download subsequently fails.
        row = self.row(name)
        previous = row["seen_sequence"]
        sequence = record["sequence"]
        if previous is not None:
            if int(sequence) < int(previous):
                raise Failure("IPNS rollback refused: sequence " + sequence + " < " + previous)
            if int(sequence) == int(previous) and record["cid"] != row["seen_cid"]:
                raise Failure("Conflicting IPNS values at the same sequence")
        self.update(name, seen_sequence=sequence, seen_cid=record["cid"])

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

    def clear_staging(self, name, fds=()):
        with self.store.db() as db:
            row = db.execute("SELECT path FROM staging WHERE name=?", (name,)).fetchone()
        if row:
            self.kubo.remove_staging(row[0], fds)
            with self.store.db() as db:
                db.execute("DELETE FROM staging WHERE name=?", (name,))

    def renew_current(self, name, fds):
        row = self.store.row(name)
        if (not row["enabled"] or row["seen_sequence"] is None or
                row["current"] != row["seen_cid"] or self.store.publication(name)):
            return False
        if row["renewed_sequence"] == row["seen_sequence"] and row["renewed_at"]:
            elapsed = datetime.datetime.now(datetime.timezone.utc) - datetime.datetime.fromisoformat(row["renewed_at"])
            if datetime.timedelta(0) <= elapsed < datetime.timedelta(hours=12):
                return False
        with self.store.lock("cid:" + row["current"]) as cid_fd:
            inherited = (*fds, cid_fd)
            self.ensure_pin(row["current"], inherited)
            record = {"cid": row["current"], "sequence": row["seen_sequence"]}
            if not self.kubo.renew(name, record, inherited):
                return False
            self.store.update(name, renewed_sequence=row["seen_sequence"], renewed_at=now())
            return True

    def resolve(self, name, fds):
        try:
            record = self.kubo.resolve_record(name, fds)
            self.store.observe(name, record)
        except Failure:
            # The accepted disk stays pinned on expired/unavailable/older records.
            # A key holder may restore availability at the SAME known sequence.
            if not self.renew_current(name, fds):
                raise
            record = self.kubo.resolve_record(name, fds)
            self.store.observe(name, record)
        return record["cid"]

    def follow(self, name):
        try:
            with self.store.lock("name:" + name) as name_fd:
                try:
                    # A killed publisher may leave scratch data; no active importer
                    # can hold this name lock at the same time.
                    self.store.snapshot(name).unlink(missing_ok=True)
                    self.store.snapshot(name).with_suffix('.profiles.json').unlink(missing_ok=True)
                    row = self.store.row(name)
                    publication = self.store.publication(name)
                    if publication:
                        self.store.update(name, last_check=now())
                        # An uncertain publication owns the name until it is confirmed.
                        # In particular, an older IPNS result cannot overwrite its intent.
                        cid = self.resolve(name, (name_fd,))
                        if cid != publication["cid"]:
                            raise Failure("Publication awaiting IPNS confirmation; retry the same disk")
                        with self.store.lock("cid:" + cid) as cid_fd:
                            self.ensure_pin(cid, (name_fd, cid_fd))
                            self.store.commit_publication(name, cid)
                        self.clear_staging(name, (name_fd,))
                        self.renew_current(name, (name_fd,))
                        return True
                    self.clear_staging(name, (name_fd,))
                    if not row["enabled"]:
                        self.store.update(name, current=None, pending=None, error=None)
                        return True
                    self.store.update(name, last_check=now())
                    cid = self.resolve(name, (name_fd,))
                    self.store.update(name, pending=cid)
                    with self.store.lock("cid:" + cid) as cid_fd:
                        fds = (name_fd, cid_fd)
                        self.ensure_pin(cid, fds)
                        self.store.update(name, current=cid, pending=None, error=None)
                    self.renew_current(name, (name_fd,))
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


    def add_name(self, name, names_path):
        with self.store.lock("config"):
            path = Path(names_path)
            names = self.kubo.names(path)
            added = name not in names
            if added:
                original = path.read_bytes()
                atomic_write(path, original + (b"\n" if original and not original.endswith(b"\n") else b"")
                             + name.encode() + b"\n")
                names.append(name)
            self.store.configure(names)
            return added

    def publish(self, source, key, names_path):
        validate_disk(source)
        name = self.kubo.key_name(key)
        with self.store.lock("name:" + name) as name_fd:
            self.add_name(name, names_path)
            snapshot = self.store.snapshot(name)
            if source is not None and Path(source).resolve() == snapshot.resolve():
                raise Failure("Source uses the reserved snapshot path")
            try:
                snapshot_file(source, snapshot)
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
                    if self.resolve(name, fds) != cid:
                        raise Failure("Publication awaiting IPNS confirmation; retry the same disk")
                    self.store.commit_publication(name, cid)
                    self.store.update(name, renewed_sequence=self.store.row(name)["seen_sequence"], renewed_at=now())
                    print("Published: " + cid, flush=True)
            except (Failure, OSError, sqlite3.Error, Busy) as exc:
                with self.store.db() as db:
                    db.execute("UPDATE publications SET error=? WHERE name=?", (str(exc), name))
                raise
            finally:
                snapshot.unlink(missing_ok=True)
        return self.cleanup()


    def publish_state(self, source, key, names_path):
        return self.publish_component(source, key, names_path, 'state')

    def publish_profile(self, source, key, names_path):
        return self.publish_component(source, key, names_path, 'profile')

    def publish_component(self, source, key, names_path, component):
        name = self.kubo.key_name(key)
        with self.store.lock("name:" + name) as name_fd:
            fds = (name_fd,)
            self.add_name(name, names_path)
            snapshot = self.store.snapshot(name)
            profile_snapshot = snapshot.with_suffix('.profiles.json')
            if source is not None and Path(source).resolve() in (snapshot.resolve(), profile_snapshot.resolve()):
                raise Failure("Source uses the reserved snapshot path")
            try:
                pending = self.store.publication(name)
                root = pending["cid"] if pending else self.resolve(name, fds)
                # Retain the resolved base while preparing a new root, also after failure.
                if not pending:
                    self.store.update(name, pending=root)
                with self.store.lock("cid:" + root) as root_fd:
                    self.ensure_pin(root, (*fds, root_fd))
                disk, old_state, header, old_profiles = self.kubo.publication_parts(root, fds, profiles=True)
                profiles = []
                state_hash = None
                if old_profiles:
                    try:
                        profiles = read_profiles(self.kubo.call('cat', '--length=65537', '--', '/ipfs/' + old_profiles, fds=fds, binary=True))
                        if any(isinstance(p, dict) and isinstance(p.get('origin'), dict) and p['origin'].get('kind') == 'state' for p in profiles):
                            state_hash = self.kubo.state_hash(old_state, fds)
                        validate_profiles(profiles, disk, header, state_hash)
                    except (Failure, TypeError) as exc:
                        print('Ignoring unusable published load profiles: ' + str(exc), file=sys.stderr)
                        profiles = []
                state_cid = old_state
                if source is not None:
                    if component == 'profile' and Path(source).stat().st_size > 65536:
                        raise Failure('Load profiles exceed 64 KiB')
                    snapshot_file(source, snapshot)
                if component == 'state':
                    state_cid = None
                    if source is not None:
                        validate_state(snapshot, header)
                        state_cid = self.kubo.import_disk(snapshot, fds=fds)
                        with snapshot.open('rb') as handle:
                            state_hash = hashlib.file_digest(handle, 'sha256').hexdigest()
                    profiles = [p for p in profiles if p['origin']['kind'] == 'boot' or state_cid and p['origin']['sha256'] == state_hash]
                elif source is None:
                    profiles = []
                else:
                    with snapshot.open('rb') as handle:
                        incoming = read_profiles(handle.read(65537))
                    if old_state and state_hash is None:
                        state_hash = self.kubo.state_hash(old_state, fds)
                    validate_profiles(incoming, disk, header, state_hash)
                    if not incoming:
                        raise Failure('Supply at least one profile, or use clear-profiles')
                    kinds = {p['origin']['kind'] for p in incoming}
                    profiles = [p for p in profiles if p['origin']['kind'] not in kinds] + incoming
                profiles.sort(key=lambda p: p['origin']['kind'])
                entries = {'disk.my98': disk}
                if state_cid:
                    entries['state.my98state'] = state_cid
                if profiles:
                    data = (json.dumps(profiles, sort_keys=True, separators=(',', ':')) + '\n').encode()
                    if len(data) > 65536:
                        raise Failure('Combined load profiles exceed 64 KiB')
                    profile_snapshot.write_bytes(data)
                    entries['load-profiles.json'] = self.kubo.import_disk(profile_snapshot, fds=fds)
                # Reconstruct the deterministic wrapper without releasing pending root protection.
                self.clear_staging(name, fds)
                cid = disk
                if len(entries) > 1:
                    path = "/my98-seedbox-" + self.store.label.split(":", 1)[1] + "/" + hashlib.sha256(name.encode()).hexdigest()
                    with self.store.db() as db:
                        db.execute("INSERT OR REPLACE INTO staging VALUES (?,?)", (name, path))
                    self.kubo.call("files", "mkdir", "-p", "--", path, fds=fds)
                    for entry, child in entries.items():
                        with self.store.lock('cid:' + child) as child_fd:
                            inherited = (*fds, child_fd)
                            content = profile_snapshot if entry == 'load-profiles.json' else snapshot if entry == 'state.my98state' and component == 'state' and source else None
                            self.ensure_pin(child, inherited, content)
                            self.kubo.call('files', 'cp', '--', '/ipfs/' + child, path + '/' + entry, fds=inherited)
                    cid = self.kubo.canonical(self.kubo.call("files", "stat", "--hash", "--", path, fds=fds), fds)
                if not pending and cid == root:
                    self.store.update(name, current=root, pending=None, error=None)
                    self.clear_staging(name, fds)
                    print('Publication unchanged.')
                    return self.cleanup()
                if pending and pending["cid"] != cid:
                    raise Failure("Another publication is uncertain; retry its original content first")
                with self.store.db() as db:
                    db.execute("INSERT INTO publications VALUES (?,?,?,'adding',NULL) "
                               "ON CONFLICT(name) DO UPDATE SET error=NULL", (name, cid, key))
                with self.store.lock("cid:" + cid) as cid_fd:
                    inherited = (*fds, cid_fd)
                    self.ensure_pin(cid, inherited)
                    with self.store.db() as db:
                        db.execute("UPDATE publications SET stage='publishing' WHERE name=?", (name,))
                    self.kubo.publish(key, cid, inherited)
                    with self.store.db() as db:
                        db.execute("UPDATE publications SET stage='confirming' WHERE name=?", (name,))
                    self.store.update(name, last_check=now())
                    if self.resolve(name, inherited) != cid:
                        raise Failure("Publication awaiting IPNS confirmation; retry the same content")
                    self.store.commit_publication(name, cid)
                    self.store.update(name, renewed_sequence=self.store.row(name)["seen_sequence"], renewed_at=now())
                self.clear_staging(name, fds)
                print("Published: " + cid, flush=True)
            except (Failure, OSError, sqlite3.Error, Busy) as exc:
                self.store.update(name, error=str(exc))
                with self.store.db() as db:
                    db.execute("UPDATE publications SET error=? WHERE name=?", (str(exc), name))
                raise
            finally:
                snapshot.unlink(missing_ok=True)
                profile_snapshot.unlink(missing_ok=True)
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


CRON_MARKER = "# my98-seedbox setup-cron "


def cron_call(binary, *args, data=None):
    try:
        return subprocess.run([binary, *args], input=data, capture_output=True,
                              timeout=15, env={**os.environ, "LC_ALL": "C"})
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise Failure(f"crontab {' '.join(args)} failed: {exc}") from exc


def read_crontab(binary):
    result = cron_call(binary, "-l")
    if result.returncode == 0:
        return result.stdout
    user = pwd.getpwuid(os.getuid()).pw_name
    # Vixie/Cronie, macOS and OpenBSD use these C-locale diagnostics.
    absent = {f"no crontab for {user}", f"crontab: no crontab for {user}"}
    if result.returncode == 1 and not result.stdout and result.stderr.decode(
            "utf-8", "replace").strip() in absent:
        return None
    raise Failure("Cannot read crontab: " + result.stderr.decode("utf-8", "replace").strip())


def cron_block(store, kubo, names_path):
    # Preserve the Python executable's symlink: resolving a venv interpreter
    # would silently select the base interpreter instead.
    python = os.path.abspath(sys.executable)
    script = str(Path(__file__).resolve())
    binary = shutil.which(kubo.binary)
    if not binary:
        raise Failure("Kubo executable not found: " + kubo.binary)
    binary = os.path.abspath(binary)
    for path in (python, binary):
        if not Path(path).is_file() or not os.access(path, os.X_OK):
            raise Failure("Executable unavailable: " + path)
    if not Path(script).is_file() or not os.access(script, os.R_OK):
        raise Failure("Script is not readable: " + script)
    state = str(store.directory.resolve())
    names = str(Path(names_path).resolve())
    if not Path(names).is_file() or not os.access(names, os.R_OK):
        raise Failure("Names file is not readable: " + names)
    # This also validates an explicit --ipfs, which find_ipfs does not probe.
    if not kubo.call("version").startswith("ipfs version "):
        raise Failure("The selected executable is not Kubo")
    arguments = [python, script, "sync", "--state", state, "--names", names,
                 "--api", kubo.api, "--ipfs", binary]
    log = str(Path(state) / "sync.log")
    if any(any(char in value for char in ("\n", "\r", "%", "\0")) for value in [*arguments, log]):
        raise Failure("setup-cron cannot use paths/options containing newlines, NUL or % (cron syntax)")
    key = hashlib.sha256(os.fsencode(state)).hexdigest()
    command = shlex.join(arguments) + " >> " + shlex.quote(log) + " 2>&1"
    # Use a known shell for redirection, independent of interactive shell setup.
    line = "* * * * * /bin/sh -c " + shlex.quote(command) + "\n"
    return key, (CRON_MARKER + key + " BEGIN\n" + line +
                 CRON_MARKER + key + " END\n").encode("utf-8", "surrogateescape")


def merge_crontab(original, key, block):
    lines = (original or b"").splitlines(keepends=True)
    blocks, opened = {}, None
    for number, raw in enumerate(lines):
        line = raw.decode("utf-8", "surrogateescape").rstrip("\r\n")
        if "my98-seedbox setup-cron" in line:
            match = re.fullmatch(re.escape(CRON_MARKER) + r"([0-9a-f]{64}) (BEGIN|END)", line)
            if not match:
                raise Failure(f"Damaged setup-cron marker on line {number + 1}; crontab unchanged")
            found, kind = match.groups()
            if kind == "BEGIN":
                if opened or found in blocks:
                    raise Failure("Duplicate or nested setup-cron blocks; crontab unchanged")
                opened = (found, number)
            else:
                if not opened or opened[0] != found:
                    raise Failure("Unmatched setup-cron marker; crontab unchanged")
                blocks[found] = (opened[1], number + 1)
                opened = None
        elif opened is None and line.strip() and not line.lstrip().startswith("#"):
            # Conservative detection, not a shell/wrapper interpreter.
            if re.search(r"seedbox|my98[^\s]*\s+(?:sync|follow)", line, re.I):
                raise Failure(f"Manual seedbox entry on line {number + 1}: {line}\n"
                              "Remove or resolve it manually; crontab unchanged. Arbitrary wrappers cannot be detected.")
    if opened:
        raise Failure("Unclosed setup-cron block; crontab unchanged")
    # Do not let a damaged block accidentally turn unrelated entries into ours.
    for start, end in blocks.values():
        if end - start != 3 or not lines[start + 1].startswith(b"* * * * * /bin/sh -c "):
            raise Failure("Damaged setup-cron block body; crontab unchanged")
    if key in blocks:
        start, end = blocks[key]
        return b"".join(lines[:start]) + block + b"".join(lines[end:])
    prefix = original or b""
    if prefix and not prefix.endswith(b"\n"):
        # Avoid changing the final bytes of an unrelated entry.
        raise Failure("Existing crontab has no final newline; fix it manually before setup-cron")
    return prefix + block


@contextlib.contextmanager
def cron_setup_lock():
    # One inode per account, independent of --state. Never unlink a flock file.
    home = Path(pwd.getpwuid(os.getuid()).pw_dir)
    path = home / ".my98-setup-cron.lock"
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise Failure("Unsafe setup-cron lock file: " + str(path))
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise Busy("another setup-cron is running for this user") from exc
        yield
    finally:
        os.close(fd)


def cron_service_status():
    probes = []
    if sys.platform.startswith("linux") and shutil.which("systemctl"):
        probes = [[shutil.which("systemctl"), "is-active", name] for name in ("cron", "crond")]
    elif sys.platform.startswith("openbsd") and Path("/usr/sbin/rcctl").exists():
        probes = [["/usr/sbin/rcctl", "check", "cron"]]
    for command in probes:
        try:
            result = subprocess.run(command, capture_output=True, timeout=5)
            if result.returncode == 0:
                return "Cron service confirmed active."
        except (OSError, subprocess.TimeoutExpired):
            pass
    return "Cron service activity could not be confirmed; check it before relying on scheduled sync."


def setup_cron(store, kubo, names_path):
    binary = shutil.which("crontab")
    if not binary:
        raise Failure("crontab is not installed or not in PATH; install/enable cron manually and retry")
    key, block = cron_block(store, kubo, names_path)
    with cron_setup_lock():
        original = read_crontab(binary)
        updated = merge_crontab(original, key, block)
        if original == updated:
            print("Cron entry already up to date (sync every minute).")
        else:
            fd, backup = tempfile.mkstemp(prefix="crontab-before-", suffix=".txt", dir=store.directory)
            with os.fdopen(fd, "wb") as handle:
                handle.write(original or b"")
                handle.flush()
                os.fsync(handle.fileno())
            print("Previous crontab backup: " + backup +
                  (" (no previous crontab)" if original is None else ""), flush=True)
            try:
                if read_crontab(binary) != original:
                    raise Failure("Crontab changed concurrently; installation cancelled")
                result = cron_call(binary, "-", data=updated)
                if result.returncode:
                    raise Failure("Crontab installation failed: " + result.stderr.decode("utf-8", "replace").strip())
                if read_crontab(binary) != updated:
                    raise Failure("Installed crontab differs from expected content")
            except Failure as exc:
                raise Failure(f"{exc}. Inspect crontab; backup: {backup}. No automatic rollback was attempted.") from exc
            print("Cron entry installed and verified (sync every minute).")
    print(cron_service_status())
    print("Log: " + str(store.directory.resolve() / "sync.log"))
    print("Keep this script and Python/Kubo at their installed paths. Arbitrary manual wrappers cannot be detected.")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, epilog="Examples: seedbox.py login; seedbox.py add k51...; "
        "seedbox.py sync; seedbox.py publish disk.my98; seedbox.py publish-state session.my98state; seedbox.py clear-state. Run sync from cron every minute. "
        "Use one state directory per Kubo node. This tool never runs GC. "
        "setup-cron installs sync every minute for the current user, preserves unrelated entries, "
        "and refuses manual seedbox entries. It cannot detect arbitrary wrappers or atomically "
        "exclude other crontab editors. Paths/options cannot contain newlines or %. "
        "It does not install/start cron or Kubo; keep the script and executables at their current paths.")
    parser.add_argument("command", choices=("login", "add", "sync", "status", "publish", "publish-state", "clear-state", "publish-profile", "clear-profiles", "setup-cron"))
    parser.add_argument("target", nargs="?", help="Public IPNS key for add; disk file for publish; state file for publish-state; profile JSON for publish-profile")
    parser.add_argument("--key", default="my98", help="Existing Kubo publication key (default: my98)")
    parser.add_argument("--names", help="Names file (default: STATE/names.txt)")
    parser.add_argument("--state", default="~/.local/my98", help="State directory (default: ~/.local/my98)")
    parser.add_argument("--api", default="/ip4/127.0.0.1/tcp/5001", help="Kubo API multiaddress")
    parser.add_argument("--ipfs", help="Kubo executable (default: automatic, including IPFS Desktop)")
    args = parser.parse_args(argv)
    if args.command in ("add", "publish", "publish-state", "publish-profile") and not args.target:
        parser.error(args.command + " requires " + {"add":"a public IPNS key", "publish":"a disk file", "publish-state":"a state file", "publish-profile":"a profile JSON file"}[args.command])
    if args.command in ("login", "sync", "status", "clear-state", "clear-profiles", "setup-cron") and args.target:
        parser.error(args.command + " does not accept a target")
    os.umask(0o077)
    try:
        store = Store(Path(args.state).expanduser())
        store.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        if args.command == "status":
            print(json.dumps(store.status(), indent=2))
            return 0
        kubo = Kubo(find_ipfs(args.ipfs), args.api)
        name = kubo.name(args.target) if args.command == "add" else None
        store.initialize(kubo.identity())
        names_path = str(Path(args.names).expanduser()) if args.names else str(store.directory / "names.txt")
        if not args.names:
            with store.lock("config"):
                if not Path(names_path).exists():
                    atomic_write(names_path, b"")
        if args.command == "setup-cron":
            setup_cron(store, kubo, names_path)
            return 0
        follower = Follower(store, kubo)
        if args.command == "login":
            login(store, kubo, args.key, names_path)
            return 0
        if args.command == "add":
            added = follower.add_name(name, names_path)
            print(("Added: " if added else "Already following: ") + name)
            print("Run sync to replicate now; otherwise the next scheduled sync will pick it up.")
            return 0
        if args.command in ("publish-state", "clear-state"):
            return 0 if follower.publish_state(args.target, args.key, names_path) else 1
        if args.command in ("publish-profile", "clear-profiles"):
            return 0 if follower.publish_profile(args.target, args.key, names_path) else 1
        if args.command == "publish":
            return 0 if follower.publish(args.target, args.key, names_path) else 1
        return 0 if follower.sync(lambda: kubo.names(names_path)) else 1
    except (EOFError, KeyboardInterrupt):
        print("Cancelled.", file=sys.stderr)
        return 1
    except Busy as exc:
        print("Operation busy; retry later: " + str(exc), file=sys.stderr)
        return 1
    except (Failure, OSError, sqlite3.Error) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
