"""Prepare/copy/commit are separate durable steps. Secrets are never serialized."""
import asyncio
from contextlib import suppress
import json
import ipaddress
from pathlib import Path
import socket
import tempfile
import time
from aiohttp import ClientSession,ClientTimeout,ClientError
from nacl.signing import SigningKey
from .engine import Engine
from .files import Catalog,atomic_write,file_hash
from .formats import validate_disk
from .metadata import inspect,NAMES
from .protocol import Record,Locations,SALT,LOCATIONS_SALT,PublicationError,Conflict,next_sequence,descriptor_bytes
from .service import bounded
from .store import Store


class Publisher:
    def __init__(self,root,nodes,*,engine=None,trackers=(),webseeds=(),lookup_timeout=30,isolated=False):
        self.catalog=Catalog(root);self.store=Store(Path(root)/"database")
        self.nodes=nodes;self.trackers=tuple(trackers);self.webseeds=tuple(webseeds)
        # Confirmation identifies outgoing connections to the configured seeder
        # listener. Incoming ephemeral source ports cannot identify that node.
        self.engine=engine or Engine(listen="127.0.0.1:0" if isolated else "0.0.0.0:0",isolated=isolated,settings={"enable_incoming_tcp":False,"enable_incoming_utp":False,"enable_outgoing_utp":False,"min_reconnect_time":1,"allow_multiple_connections_per_ip":True})
        self.owns_engine=engine is None;self.client=None;self.handles={};self.endpoints={}
        self.lookup_timeout=lookup_timeout;self.isolated=isolated
        self.journals=self.catalog.root/"journals";self.journals.mkdir(exist_ok=True)

    async def start(self):
        self.client=ClientSession(timeout=ClientTimeout(total=15))
        await self.engine.listening()
        self.engine.session.apply_settings({"enable_incoming_tcp":False,"enable_incoming_utp":False,"enable_outgoing_utp":False,"min_reconnect_time":1,"allow_multiple_connections_per_ip":True})
        for node in self.nodes:
            host,port=node["peer"]
            addresses=await asyncio.get_running_loop().getaddrinfo(host,port,type=socket.SOCK_STREAM)
            self.endpoints[node["name"]]=list(dict.fromkeys((entry[4][0],entry[4][1]) for entry in addresses))
            for endpoint in self.endpoints[node["name"]]:
                if self.isolated and not ipaddress.ip_address(endpoint[0]).is_loopback:
                    raise PublicationError("Isolated fixtures require loopback seedboxes")
                self.engine.add_node(endpoint)

    async def stop(self):
        if self.client:await self.client.close()
        if self.owns_engine:self.engine.close()

    def journal_path(self,key):return self.journals/(key.hex()+".json")

    def journal(self,key):
        try:value=json.loads(self.journal_path(key).read_text())
        except FileNotFoundError:return None
        Record.from_json(value["record"],key)
        if value["base"] is not None:Record.from_json(value["base"],key)
        Locations.from_json(value["locations"],key)
        return value

    def save(self,journal):
        key=Record.from_json(journal["record"]).public_key
        atomic_write(self.journal_path(key),json.dumps(journal,sort_keys=True).encode()+b"\n")

    async def current(self,key):
        async def http(node):
            try:
                async with self.client.get(node["api"].rstrip("/")+"/v2/dht/"+key.hex()+"/"+SALT.hex(),allow_redirects=False) as response:
                    if response.status==404:return None
                    response.raise_for_status()
                    return Record.from_json(json.loads(await bounded(response,4096)),key)
            except (ClientError,OSError,TimeoutError):return None
        records=await asyncio.gather(self.engine.resolve(key,self.lookup_timeout),*(http(node) for node in self.nodes))
        records=[r for r in records if r is not None]
        previous=self.store.highest(key)
        if previous:records.append(previous)
        if not records:return None
        by_sequence={}
        for record in sorted(records,key=lambda r:r.sequence):
            if record.sequence in by_sequence and by_sequence[record.sequence].info_hash!=record.info_hash:
                raise Conflict("Sources disagree about a publication with the same sequence")
            by_sequence[record.sequence]=record
        highest=max(records,key=lambda r:r.sequence);self.store.observe(highest)
        return highest

    async def metadata(self,info_hash,kind):
        try:return self.catalog.metadata(info_hash)
        except FileNotFoundError:pass
        for node in self.nodes:
            try:
                async with self.client.get(node["api"].rstrip("/")+"/v2/info/"+info_hash,allow_redirects=False) as response:
                    response.raise_for_status();raw=await bounded(response,16384 if kind=="descriptor" else 96*1024*1024)
                    data=b"d4:info"+raw+b"e"
                    self.catalog.remember(data,info_hash,kind)
                    return self.catalog.metadata(info_hash)
            except (ClientError,OSError,TimeoutError):continue
        return None

    def connect(self):
        for handle in self.handles.values():
            for endpoints in self.endpoints.values():
                for endpoint in endpoints:handle.connect_peer(endpoint)

    async def ensure(self,info_hash,kind,timeout=3600,connect=True):
        if info_hash not in self.handles:
            data=await self.metadata(info_hash,kind)
            handle=self.engine.add(info_hash,self.catalog.directory(info_hash),metadata=data,kind=kind,trackers=self.trackers,webseeds=self.webseeds,direct_only=True)
            self.handles[info_hash]=handle
            if connect:self.connect()
            if data is None:
                data=await self.engine.metadata(handle,info_hash,kind=kind,trackers=self.trackers,webseeds=self.webseeds)
                self.catalog.remember(data,info_hash,kind)
        await self.engine.complete(self.handles[info_hash],timeout)

    async def existing(self,record):
        await self.ensure(record.info_hash.hex(),"descriptor")
        value=self.catalog.descriptor(record.info_hash.hex())
        await asyncio.gather(*(self.ensure(ih,kind) for kind,ih in value.items() if kind in NAMES and ih))
        await asyncio.to_thread(self.catalog.validate_publication,record)
        return value

    async def prepare(self,seed,operation,*,disk=None,state=None,profile=None,clear_profile=False):
        key=bytes(SigningKey(seed).verify_key);self.store.follow(key)
        old=self.journal(key)
        if old and old["phase"] not in ("complete","conflict"):raise PublicationError("An interrupted candidate exists; use resume to reuse its torrents and sequence")
        base=await self.current(key)
        if operation=="publish":
            if disk is None:raise PublicationError("A new publication requires a disk")
            ih=await asyncio.to_thread(self.catalog.import_file,disk,"disk",public_key=key)
            value={"version":1,"disk":ih,"state":None,"profile":None}
        else:
            if base is None:raise PublicationError("No existing publication to update")
            value=dict(await self.existing(base))
        header=validate_disk(self.catalog.path(value["disk"],"disk"),key)
        if operation=="clear-state":value["state"]=None
        if state is not None:value["state"]=await asyncio.to_thread(self.catalog.import_file,state,"state",base=header)
        if operation=="clear-profile" or clear_profile:value["profile"]=None
        if profile is not None:
            state_hash=await asyncio.to_thread(file_hash,self.catalog.path(value["state"],"state")) if value["state"] else None
            value["profile"]=await asyncio.to_thread(self.catalog.import_file,profile,"profile",disk=value["disk"],base=header,state_hash=state_hash)
        with tempfile.TemporaryDirectory(dir=self.catalog.staging) as temporary:
            path=Path(temporary)/"publication.json";path.write_bytes(descriptor_bytes(value))
            descriptor_hash=self.catalog.import_file(path,"descriptor")
        candidate=Record.sign(seed,next_sequence(self.store.maximum(key)),descriptor_hash)
        # Keeping an existing state-bound profile during a state update must
        # validate; it is never silently dropped or changed.
        await asyncio.to_thread(self.catalog.validate_publication,candidate)
        self.store.accept_candidate(candidate,self.catalog.metadata(descriptor_hash))
        locations=await self.prepare_locations(seed)
        journal={"record":candidate.as_json(),"locations":locations.as_json(),"base":base.as_json() if base else None,"phase":"prepared","notified":[]}
        self.save(journal)
        return journal

    def complete_node(self):
        handles=list(self.handles.values())
        if not handles:return None
        return next((name for name,endpoints in self.endpoints.items() if all(any(Engine.peer_complete(h,e) for e in endpoints) for h in handles)),None)

    async def transfer(self,journal,timeout=3600,progress=None):
        record=Record.from_json(journal["record"])
        # Limit the confirmation to this descriptor and its components, rather
        # than any old handles used while preparing an update.
        value=self.catalog.descriptor(record.info_hash.hex())
        wanted={record.info_hash.hex(),*(v for k,v in value.items() if k in NAMES and v)}
        for ih,handle in list(self.handles.items()):
            if ih not in wanted:
                await self.engine.remove(handle);del self.handles[ih]
        await asyncio.gather(self.ensure(record.info_hash.hex(),"descriptor",connect=False),*(self.ensure(ih,kind,connect=False) for kind,ih in value.items() if kind in NAMES and ih))
        journal["phase"]="transferring";self.save(journal)
        payload={"record":record.as_json()}
        for node in self.nodes:
            try:
                async with self.client.post(node["api"].rstrip("/")+"/v2/candidates",json=payload,allow_redirects=False) as response:
                    if response.status==409:
                        journal["phase"]="conflict";self.save(journal)
                        raise Conflict((await bounded(response,4096)).decode())
                    response.raise_for_status()
                    if response.status!=202:raise PublicationError("Seedbox did not admit the candidate")
                    if node["name"] not in journal["notified"]:journal["notified"].append(node["name"]);self.save(journal)
            except (ClientError,OSError,TimeoutError):continue
        if not journal["notified"]:raise PublicationError("No configured seedbox admitted this candidate; public name unchanged")
        started=time.monotonic()
        while time.monotonic()-started<timeout:
            self.connect()
            node=self.complete_node()
            if progress:progress(self.handles,self.endpoints)
            if node:
                journal["phase"]="copied";self.save(journal);return node
            await asyncio.sleep(.25)
        raise PublicationError("No single seedbox announced every piece; public name unchanged. Use resume")

    async def commit(self,journal):
        record=Record.from_json(journal["record"])
        base=Record.from_json(journal["base"]) if journal["base"] is not None else None
        if self.complete_node() is None:raise PublicationError("A complete copy must be observed on one seedbox before committing")
        current=await self.current(record.public_key)
        if current not in (base,record):
            journal["phase"]="conflict";self.save(journal)
            raise Conflict("A different publication appeared after this candidate was prepared; prepare a new publication")
        journal["phase"]="committing";self.save(journal)
        try:
            await self.commit_locations(Locations.from_json(journal["locations"],record.public_key))
            await self.engine.put(record)
        except Conflict:
            journal["phase"]="conflict";self.save(journal);raise
        readback=await self.engine.resolve(record.public_key,self.lookup_timeout)
        if readback is None:raise PublicationError("DHT readback is unavailable; publication is not confirmed. Use resume")
        if readback!=record:
            journal["phase"]="conflict";self.save(journal)
            raise Conflict("DHT readback does not match the candidate; publication is not confirmed")
        self.store.set_public(record);self.store.adopt(record,self.catalog.descriptor(record.info_hash.hex()))
        journal["phase"]="complete";self.save(journal)
        return record

    async def publish(self,journal,timeout=3600,progress=None):
        await self.transfer(journal,timeout,progress)
        return await self.commit(journal)


    async def prepare_locations(self,seed):
        key=bytes(SigningKey(seed).verify_key)
        current=await self.engine.resolve(key,self.lookup_timeout,salt=LOCATIONS_SALT)
        previous=self.store.locations(key)
        maximum=max([record.sequence for record in (current,previous) if record is not None],default=0)
        return Locations.sign(seed,next_sequence(maximum),[node["api"] for node in self.nodes])

    async def commit_locations(self,record):
        await self.engine.put(record)
        actual=await self.engine.resolve(record.public_key,self.lookup_timeout,salt=LOCATIONS_SALT)
        if actual!=record:raise Conflict("DHT locations readback does not match the candidate")
        self.store.set_locations(record)
        return record

    async def publish_locations(self,seed):
        return await self.commit_locations(await self.prepare_locations(seed))
