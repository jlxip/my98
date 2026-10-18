"""Private persistent files; staging is never served by the webseed."""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
from .formats import snapshot_file,validate_disk,validate_state,read_profiles,validate_profiles
from .metadata import create,inspect,trusted,NAMES
from .protocol import PublicationError,hash_bytes,parse_descriptor


def atomic_write(path,data):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    fd,name=tempfile.mkstemp(prefix="."+path.name+".",dir=path.parent)
    try:
        with os.fdopen(fd,"wb") as output:
            output.write(data);output.flush();os.fsync(output.fileno())
        os.replace(name,path)
        sync_directory(path.parent)
    finally:
        Path(name).unlink(missing_ok=True)


def sync_directory(path):
    fd=os.open(path,os.O_RDONLY)
    try:os.fsync(fd)
    finally:os.close(fd)


def file_hash(path):
    with Path(path).open("rb") as stream:return hashlib.file_digest(stream,"sha256").hexdigest()


class Catalog:
    def __init__(self,root):
        self.root=Path(root).resolve();self.root.mkdir(parents=True,exist_ok=True,mode=0o700)
        self.objects=self.root/"objects";self.metainfo=self.root/"metainfo";self.staging=self.root/"staging"
        self.public=self.root/"webseed"
        for directory in [self.objects,self.metainfo,self.staging,self.public]:directory.mkdir(exist_ok=True,mode=0o700)

    def directory(self,info_hash):
        hash_bytes(info_hash)
        path=self.objects/info_hash;path.mkdir(exist_ok=True)
        return path

    def metadata(self,info_hash):
        hash_bytes(info_hash)
        return (self.metainfo/(info_hash+".torrent")).read_bytes()

    def remember(self,data,expected=None,kind=None):
        data=trusted(data,expected=expected,kind=kind)
        parsed=inspect(data,kind=kind)
        atomic_write(self.metainfo/(parsed["infoHash"]+".torrent"),data)
        return parsed

    def path(self,info_hash,kind):
        parsed=inspect(self.metadata(info_hash),info_hash,kind)
        return self.directory(info_hash)/parsed["filename"]

    def import_file(self,source,kind,*,public_key=None,base=None,disk=None,state_hash=None):
        source=Path(source)
        if shutil.disk_usage(self.root).free<source.stat().st_size+1024*1024:
            raise PublicationError("Not enough space to snapshot the publication component")
        with tempfile.TemporaryDirectory(prefix="import-",dir=self.staging) as temporary:
            target=Path(temporary)/NAMES[kind]
            snapshot_file(source,target)
            if kind=="disk":validate_disk(target,public_key)
            elif kind=="state":validate_state(target,base)
            elif kind=="profile":
                if target.stat().st_size>65536:raise PublicationError("Load profiles exceed 64 KiB")
                validate_profiles(read_profiles(target.read_bytes()),disk,base,state_hash)
            elif kind=="descriptor":parse_descriptor(target.read_bytes())
            info_hash,data=create(target,kind)
            path=self.directory(info_hash)/NAMES[kind]
            os.replace(target,path);sync_directory(path.parent)
            self.remember(data,info_hash,kind)
            return info_hash

    def descriptor(self,info_hash):
        path=self.path(info_hash,"descriptor")
        if path.stat().st_size>4096:raise PublicationError("Descriptor too large")
        return parse_descriptor(path.read_bytes())

    def validate_publication(self,record):
        value=self.descriptor(record.info_hash.hex())
        disk=self.path(value["disk"],"disk")
        header=validate_disk(disk,record.public_key)
        state_hash=None
        if value["state"]:
            state=self.path(value["state"],"state");validate_state(state,header)
            state_hash=file_hash(state)
        if value["profile"]:
            path=self.path(value["profile"],"profile")
            if path.stat().st_size>65536:raise PublicationError("Load profiles exceed 64 KiB")
            validate_profiles(read_profiles(path.read_bytes()),value["disk"],header,state_hash)
        return value

    def expose(self,info_hash,kind):
        # Called only after the engine has verified every piece and format checks
        # have passed. Incomplete objects stay outside this directory.
        path=self.path(info_hash,kind)
        with path.open("rb") as stream:os.fsync(stream.fileno())
        directory=self.public/info_hash;directory.mkdir(exist_ok=True)
        destination=directory/path.name
        if not destination.exists():
            fd,temporary=tempfile.mkstemp(prefix=".link-",dir=directory);os.close(fd);os.unlink(temporary)
            try:os.link(path,temporary);os.replace(temporary,destination);sync_directory(directory)
            finally:Path(temporary).unlink(missing_ok=True)
        return destination

    def remove(self,info_hash):
        hash_bytes(info_hash)
        shutil.rmtree(self.public/info_hash,ignore_errors=True)
        shutil.rmtree(self.objects/info_hash,ignore_errors=True)
        (self.metainfo/(info_hash+".torrent")).unlink(missing_ok=True)
