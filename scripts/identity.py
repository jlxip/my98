"""Identity v2 derivation shared with the Rust core. No persistence or network IO."""
import base64
import hashlib
import hmac
import struct
import unicodedata

class Failure(ValueError):
    pass

def derive_seed(username, password, machine):
    """Identity v2, identical to src/crypto/src/lib.rs; raw Ed25519 seed."""
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
    return seed


def derive_private_key(username, password, machine):
    seed = derive_seed(username, password, machine)
    encoded = base64.b64encode(bytes.fromhex("302e020100300506032b657004220420") + seed)
    return b"-----BEGIN PRIVATE KEY-----\n" + encoded + b"\n-----END PRIVATE KEY-----\n"

