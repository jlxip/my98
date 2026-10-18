"""Local format validation retained from the existing CLI; public hints stay bounded."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import struct
from nacl.exceptions import BadSignatureError
from nacl.signing import VerifyKey
from .protocol import PublicationError

def validate_disk(path, public_key=None):
    # Encrypted descriptor and records are authenticated by the Rust core.
    if not stat.S_ISREG(Path(path).stat().st_mode):
        raise PublicationError("Disk must be a regular file")
    with Path(path).open("rb") as handle:
        info = os.fstat(handle.fileno())
        header = handle.read(198)
    if not stat.S_ISREG(info.st_mode) or len(header) != 198:
        raise PublicationError("Disk must be a readable regular .my98 file")
    version, chunk, size = struct.unpack_from("<IIQ", header, 8)
    if header[:8] != b"SLOPDSK\0" or version != 1 or chunk != 65536:
        raise PublicationError("Unsupported .my98 header, version or chunk size")
    if not 1 <= size <= (1 << 40) or info.st_size != 198 + size + ((size + chunk - 1) // chunk) * 62:
        raise PublicationError("Invalid .my98 logical or physical size")
    if public_key is not None:
        try:VerifyKey(public_key).verify(b"slop86/linear-disk/v1\0"+header[:134],header[134:])
        except (BadSignatureError,ValueError) as error:
            raise PublicationError("Disk header is not signed by the publication identity") from error
    return header


def validate_state(path, base):
    """Structural validation only; the browser authenticates the encrypted records."""
    with Path(path).open("rb") as handle:
        info = os.fstat(handle.fileno())
        prefix = handle.read(12)
        if not stat.S_ISREG(info.st_mode) or len(prefix) != 12 or prefix[:8] != b"MY98STAT":
            raise PublicationError("Unsupported .my98state file")
        length = struct.unpack_from("<I", prefix, 8)[0]
        if not 1 <= length <= 4096:
            raise PublicationError("Invalid state header length")
        try:
            header = json.loads(handle.read(length))
        except (ValueError, UnicodeError) as exc:
            raise PublicationError("Invalid state header") from exc
    limit = 1 << 30
    if (not isinstance(header, dict) or type(header.get("version")) is not int or header["version"] != 1 or
            type(header.get("raw")) is not int or not 4 <= header["raw"] <= limit or
            type(header.get("packed")) is not int or not 1 <= header["packed"] <= limit):
        raise PublicationError("Unsupported state size or version")
    for key, size in (("base", 198), ("nonce", 16)):
        value = header.get(key)
        if not isinstance(value, list) or len(value) != size or any(type(v) is not int or not 0 <= v <= 255 for v in value):
            raise PublicationError("Invalid state " + key)
    if bytes(header["base"]) != base:
        raise PublicationError("State belongs to a different base disk")
    packed = header["packed"]
    if info.st_size != 12 + length + packed + ((packed + 1048575) // 1048576) * 62 or info.st_size > limit + 65536:
        raise PublicationError("Truncated state or trailing bytes")


def validate_profiles(value, disk, header, state_hash=None):
    """Bounded, public read hints. Neither their metrics nor ranges authorize data."""
    if not isinstance(value, list) or len(value) > 2:
        raise PublicationError("Invalid load profile list")
    units = (struct.unpack_from('<Q', header, 16)[0] + 65535) // 65536
    seen = set()
    for p in value:
        if not isinstance(p, dict) or type(p.get('version')) is not int or p['version'] != 2 or p.get('infoHash') != disk or type(p.get('unitBytes')) is not int or p['unitBytes'] != 65536:
            raise PublicationError("Load profile must use version 2 and the current disk infohash")
        origin = p.get('origin')
        if not isinstance(origin, dict) or origin.get('kind') not in ('boot', 'state') or origin['kind'] in seen:
            raise PublicationError("Invalid or duplicate load profile origin")
        seen.add(origin['kind'])
        if origin['kind'] == 'state':
            if not state_hash or origin.get('sha256') != state_hash:
                raise PublicationError("Load profile does not match the published state")
        elif 'sha256' in origin:
            raise PublicationError("Boot profile cannot name a state")
        ranges = p.get('ranges')
        if not isinstance(ranges, list) or len(ranges) != 32:
            raise PublicationError("Load profiles require 32 range slots")
        ordered = []
        for r in ranges:
            if r is None:
                continue
            if not isinstance(r, list) or len(r) != 2 or any(type(n) is not int for n in r) or not 0 <= r[0] <= r[1] < units:
                raise PublicationError("Invalid load profile range")
            ordered.append(r)
        ordered.sort()
        if any(a[1] >= b[0] for a, b in zip(ordered, ordered[1:])):
            raise PublicationError("Overlapping load profile ranges")
        for field in ('observedUnits', 'coveredUnits', 'downloadUnits'):
            if field in p and (type(p[field]) is not int or not 0 <= p[field] <= units):
                raise PublicationError("Invalid load profile metric")
        if 'minUtilization' in p and (type(p['minUtilization']) not in (int, float) or not 0 < p['minUtilization'] <= 1):
            raise PublicationError("Invalid load profile utilization")
    return value


def read_profiles(data):
    if len(data) > 65536:
        raise PublicationError("Load profiles exceed 64 KiB")
    try:
        return json.loads(data)
    except (ValueError, UnicodeError) as exc:
        raise PublicationError("Invalid load profiles JSON") from exc


def snapshot_file(source, target):
    if Path(source).resolve() == target.resolve():
        raise PublicationError("Source uses the reserved snapshot path")
    with Path(source).open("rb") as src, target.open("wb") as dest:
        before = os.fstat(src.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise PublicationError("Source must be a regular file")
        shutil.copyfileobj(src, dest, 1024 * 1024)
        dest.flush()
        os.fsync(dest.fileno())
        after = os.fstat(src.fileno())
        if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise PublicationError("Source changed while being copied")


