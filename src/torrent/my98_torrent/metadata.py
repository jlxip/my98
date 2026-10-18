"""Deterministic single-file v1 torrents; untrusted source hints are discarded."""
import hashlib
import math
from pathlib import Path
import libtorrent as lt
from .protocol import PublicationError, hash_bytes

PIECE=256*1024
NAMES={"disk":"disk.my98","state":"state.my98state","profile":"profile.json","descriptor":"publication.json"}
LIMITS={"disk":(1<<40)+(1<<30)+198,"state":(1<<30)+65536,"profile":65536,"descriptor":4096}
MAX_METADATA=96*1024*1024


def inspect(data,expected=None,kind=None):
    limit=16384 if kind=="descriptor" else MAX_METADATA
    if type(data) is not bytes or not 1<=len(data)<=limit:raise PublicationError("Invalid torrent metadata size")
    try:
        value=lt.bdecode(data)
        if type(value) is not dict or lt.bencode(value)!=data or type(value.get(b"info")) is not dict:
            raise ValueError("Noncanonical torrent")
        info=value[b"info"]
        if set(info)!={b"name",b"length",b"piece length",b"pieces"}:raise ValueError("Only flat v1 torrents are accepted")
        name=info[b"name"]
        if name not in [v.encode() for v in NAMES.values()]:raise ValueError("Invalid torrent filename")
        actual_kind=next(k for k,v in NAMES.items() if v.encode()==name)
        if kind is not None and actual_kind!=kind:raise ValueError("Wrong torrent component")
        size=info[b"length"]
        if type(size) is not int or not 1<=size<=LIMITS[actual_kind]:raise ValueError("Invalid torrent file size")
        if type(info[b"piece length"]) is not int or info[b"piece length"]!=PIECE:raise ValueError("Invalid torrent piece length")
        if type(info[b"pieces"]) is not bytes or len(info[b"pieces"])!=20*((size+PIECE-1)//PIECE):raise ValueError("Invalid torrent piece hashes")
        info_hash=hashlib.sha1(lt.bencode(info)).hexdigest()
        if expected is not None and hash_bytes(expected)!=bytes.fromhex(info_hash):raise ValueError("Torrent infohash does not match signed publication")
        return {"infoHash":info_hash,"kind":actual_kind,"filename":NAMES[actual_kind],"size":size,"pieces":(size+PIECE-1)//PIECE,"info":info}
    except (RuntimeError,TypeError,ValueError,KeyError,StopIteration) as error:
        raise PublicationError("Invalid torrent metadata: "+str(error)) from error


def trusted(data,*,expected=None,kind=None,trackers=(),webseeds=()):
    parsed=inspect(data,expected,kind)
    result={b"info":parsed["info"]}
    if trackers:
        result[b"announce"]=trackers[0].encode()
        result[b"announce-list"]=[[t.encode()] for t in trackers]
    if webseeds:result[b"url-list"]=[u.rstrip("/").encode()+b"/"+parsed["infoHash"].encode()+b"/"+parsed["filename"].encode() for u in webseeds]
    return lt.bencode(result)


def create(path,kind):
    path=Path(path);size=path.stat().st_size
    if not 1<=size<=LIMITS[kind]:raise PublicationError("Invalid component size")
    hashes=bytearray()
    with path.open("rb") as stream:
        while piece:=stream.read(PIECE):hashes.extend(hashlib.sha1(piece).digest())
    value={b"info":{b"name":NAMES[kind].encode(),b"length":size,b"piece length":PIECE,b"pieces":bytes(hashes)}}
    data=lt.bencode(value);parsed=inspect(data,kind=kind)
    return parsed["infoHash"],data
