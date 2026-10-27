"""Exact BEP44/46 wire values. Does not access the network or persist secrets."""
from dataclasses import dataclass
import json
import re
import time
import ipaddress
from urllib.parse import urlsplit
from nacl.exceptions import BadSignatureError
from nacl.signing import SigningKey, VerifyKey

SALT = b"my98/publication/v1"
LOCATIONS_SALT = b"my98/locations/v1"
MAX_SEQUENCE = 2**53 - 1
INFOHASH = re.compile(r"[0-9a-f]{40}\Z")

class PublicationError(ValueError):
    pass

class Conflict(PublicationError):
    pass


def sequence(value):
    if type(value) is not int or not 1 <= value <= MAX_SEQUENCE:
        raise PublicationError("Sequence must be a positive safe integer")
    return value


def next_sequence(maximum=0, now_ms=None):
    if type(maximum) is not int or not 0 <= maximum <= MAX_SEQUENCE:
        raise PublicationError("Invalid known sequence")
    current = time.time_ns() // 1_000_000 if now_ms is None else now_ms
    if type(current) is not int or not 0 <= current <= MAX_SEQUENCE:
        raise PublicationError("Invalid publication time")
    return sequence(max(current, maximum + 1))


def hash_bytes(value):
    if type(value) is not str or not INFOHASH.fullmatch(value):
        raise PublicationError("Infohash must be 40 lowercase hexadecimal digits")
    return bytes.fromhex(value)


def value_bytes(info_hash):
    if type(info_hash) is not bytes or len(info_hash) != 20:
        raise PublicationError("Invalid binary infohash")
    return b"d2:ih20:" + info_hash + b"e"


def mutable_payload(salt, seq, value):
    return b"4:salt" + str(len(salt)).encode() + b":" + salt + b"3:seqi" + str(sequence(seq)).encode() + b"e1:v" + value


def signing_payload(seq, info_hash):
    return mutable_payload(SALT, seq, value_bytes(info_hash))


@dataclass(frozen=True)
class Record:
    public_key: bytes
    sequence: int
    info_hash: bytes
    signature: bytes

    @property
    def salt(self):return SALT

    @property
    def value(self):return value_bytes(self.info_hash)

    def verify(self):
        if type(self.public_key) is not bytes or len(self.public_key) != 32 or type(self.signature) is not bytes or len(self.signature) != 64:
            raise PublicationError("Invalid key or signature size")
        try:
            VerifyKey(self.public_key).verify(signing_payload(self.sequence, self.info_hash), self.signature)
        except (BadSignatureError, ValueError) as error:
            raise PublicationError("Invalid publication signature") from error
        return self

    def as_json(self):
        self.verify()
        return {"publicKey":self.public_key.hex(), "sequence":self.sequence, "infoHash":self.info_hash.hex(), "signature":self.signature.hex(), "salt":SALT.hex()}

    @classmethod
    def from_json(cls, value, expected_key=None):
        if type(value) is not dict or set(value) != {"publicKey", "sequence", "infoHash", "signature", "salt"} or value["salt"] != SALT.hex():
            raise PublicationError("Invalid signed publication record")
        try:
            for name, size in [("publicKey",64),("signature",128)]:
                if type(value[name]) is not str or len(value[name]) != size or re.fullmatch(r"[0-9a-f]+",value[name]) is None:
                    raise ValueError("Noncanonical key or signature")
            record=cls(bytes.fromhex(value["publicKey"]), sequence(value["sequence"]), hash_bytes(value["infoHash"]), bytes.fromhex(value["signature"])).verify()
        except (ValueError,TypeError) as error:
            raise PublicationError("Invalid signed publication record") from error
        if expected_key is not None and record.public_key != expected_key:
            raise PublicationError("Publication belongs to a different identity")
        return record

    @classmethod
    def sign(cls, seed, seq, info_hash):
        key=SigningKey(seed)
        value=hash_bytes(info_hash) if type(info_hash) is str else info_hash
        payload=signing_payload(seq,value)
        return cls(bytes(key.verify_key),seq,value,key.sign(payload).signature).verify()


def compare(previous, candidate):
    candidate.verify()
    if previous is None:
        return True
    previous.verify()
    if previous.public_key != candidate.public_key or previous.salt != candidate.salt:
        raise PublicationError("Cannot compare different identities")
    if candidate.sequence < previous.sequence:
        raise Conflict("Publication is older than the highest observed version")
    if candidate.sequence == previous.sequence:
        if candidate.value != previous.value:
            raise Conflict("Conflicting publications have the same sequence")
        return False
    return True


def descriptor(value):
    if type(value) is not dict or set(value) != {"version","disk","state","profile"} or type(value["version"]) is not int or value["version"] != 1:
        raise PublicationError("Invalid publication descriptor")
    hash_bytes(value["disk"])
    for field in ["state","profile"]:
        if value[field] is not None:
            hash_bytes(value[field])
    return dict(value)


def descriptor_bytes(value):
    return json.dumps(descriptor(value),sort_keys=True,separators=(",", ":")).encode()


def parse_descriptor(data):
    if type(data) not in (str,bytes) or len(data) > 4096:
        raise PublicationError("Publication descriptor exceeds 4096 bytes")
    try:
        def unique(pairs):
            result={}
            for key,value in pairs:
                if key in result: raise PublicationError("Duplicate descriptor field")
                result[key]=value
            return result
        return descriptor(json.loads(data,object_pairs_hook=unique))
    except (UnicodeError,json.JSONDecodeError) as error:
        raise PublicationError("Invalid publication descriptor") from error


def location_origins(origins):
    if type(origins) not in (list,tuple) or not origins:
        raise PublicationError("Configure at least one seedbox origin")
    result=[]
    for origin in origins:
        if type(origin) is not str or not origin.isascii():raise PublicationError("Invalid seedbox origin")
        try:
            url=urlsplit(origin);port=url.port
            host=url.hostname
            if not host or url.username or url.password or url.query or url.fragment or url.path not in ("","/") or url.scheme not in ("https","http"):
                raise ValueError()
            try:
                address=ipaddress.ip_address(host)
                local=address.is_loopback;host=address.compressed
                if address.version==6:host="["+host+"]"
            except ValueError:
                host=host.lower();local=host=="localhost"
                if not re.fullmatch(r"[a-z0-9_.-]+",host) or host.rsplit(".",1)[-1].isdigit():raise ValueError()
            if url.scheme=="http" and not local:raise ValueError()
            suffix=":"+str(port) if port is not None and port!={"https":443,"http":80}[url.scheme] else ""
            result.append(url.scheme+"://"+host+suffix)
        except (ValueError,TypeError):raise PublicationError("Use an HTTPS seedbox origin without a path")
    return tuple(sorted(set(result)))


def locations_value(origins):
    values=location_origins(origins)
    value=b"d7:originsl"+b"".join(str(len(origin.encode())).encode()+b":"+origin.encode() for origin in values)+b"e7:versioni1ee"
    if len(value)>1000:raise PublicationError("Seedbox locations exceed the BEP44 1000-byte limit")
    return value


@dataclass(frozen=True)
class Locations:
    public_key: bytes
    sequence: int
    origins: tuple
    signature: bytes

    @property
    def salt(self):return LOCATIONS_SALT

    @property
    def value(self):return locations_value(self.origins)

    def verify(self):
        if type(self.public_key) is not bytes or len(self.public_key)!=32 or type(self.signature) is not bytes or len(self.signature)!=64 or self.origins!=location_origins(self.origins):
            raise PublicationError("Invalid locations record")
        try:VerifyKey(self.public_key).verify(mutable_payload(self.salt,self.sequence,self.value),self.signature)
        except (BadSignatureError,ValueError) as error:raise PublicationError("Invalid locations signature") from error
        return self

    def as_json(self):
        self.verify()
        return {"publicKey":self.public_key.hex(),"sequence":self.sequence,"origins":list(self.origins),"signature":self.signature.hex(),"salt":self.salt.hex()}

    @classmethod
    def from_json(cls,value,expected_key=None):
        if type(value) is not dict or set(value)!={"publicKey","sequence","origins","signature","salt"} or value["salt"]!=LOCATIONS_SALT.hex() or type(value["origins"]) is not list:
            raise PublicationError("Invalid signed locations")
        try:
            for field,length in [("publicKey",64),("signature",128)]:
                if type(value[field]) is not str or not re.fullmatch("[0-9a-f]{"+str(length)+"}",value[field]):raise ValueError()
            result=cls(bytes.fromhex(value["publicKey"]),sequence(value["sequence"]),tuple(value["origins"]),bytes.fromhex(value["signature"])).verify()
        except (ValueError,TypeError) as error:raise PublicationError("Invalid signed locations") from error
        if expected_key is not None and result.public_key!=expected_key:raise PublicationError("Locations belong to another identity")
        return result

    @classmethod
    def sign(cls,seed,seq,origins):
        origins=location_origins(origins);key=SigningKey(seed)
        signature=key.sign(mutable_payload(LOCATIONS_SALT,seq,locations_value(origins))).signature
        return cls(bytes(key.verify_key),seq,origins,signature).verify()
