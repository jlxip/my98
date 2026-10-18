"""Follow explicitly configured identities; candidate admission is not an acknowledgement."""
import asyncio
import base64
from collections import defaultdict
from contextlib import suppress
import errno
import json
import logging
from pathlib import Path
import shutil
import time
from aiohttp import ClientSession,ClientTimeout,ClientError,web
from .engine import Engine
from .files import Catalog
from .metadata import inspect,NAMES
from .protocol import Record,PublicationError,Conflict,hash_bytes
from .store import Store

log=logging.getLogger("my98.torrent")


async def bounded(response,limit):
    if response.content_length is not None and response.content_length>limit:raise PublicationError("Response exceeds size limit")
    result=bytearray()
    async for chunk in response.content.iter_chunked(65536):
        result.extend(chunk)
        if len(result)>limit:raise PublicationError("Response exceeds size limit")
    return bytes(result)


class Node:
    def __init__(self,root,keys,*,engine=None,trackers=(),webseeds=(),apis=(),poll_seconds=60,reannounce_seconds=3600,tracker=None):
        self.catalog=Catalog(root);self.store=Store(Path(root)/"database")
        self.keys={bytes.fromhex(key) if type(key) is str else key for key in keys}
        for key in self.keys:self.store.follow(key)
        self.engine=engine or Engine();self.owns_engine=engine is None
        # Announce on both own loopback tracker families. A browser reaching the
        # IPv6 proxy must find the seeder even if an external WSS DNS connection
        # selected IPv4. These hints never enter published torrent metadata.
        self.trackers=tuple(dict.fromkeys((*trackers,*getattr(tracker,"client_urls",()))))
        self.webseeds=tuple(webseeds);self.apis=tuple(apis)
        self.poll_seconds=poll_seconds;self.reannounce_seconds=reannounce_seconds
        self.handles={};self.jobs={};self.verified={};self.download_locks=defaultdict(asyncio.Lock)
        self.active=defaultdict(set);self.reservations={};self.gc_tasks={};self.tasks=[];self.client=None
        self.tracker=tracker;self.descriptors={}

    def tracker_hashes(self):
        hashes=set()
        for record,value in self.store.adopted_records():
            if record.public_key not in self.keys:continue
            hashes.add(record.info_hash.hex())
            hashes.update(v for k,v in value.items() if k in NAMES and v)
        for record in self.store.public_records()+[r for r,_ in self.store.candidates()]:
            if record.public_key not in self.keys:continue
            ih=record.info_hash.hex();hashes.add(ih)
            # Child references enter the list only after native piece verification
            # of the descriptor, or from an already validated adopted publication.
            value=self.descriptors.get(ih,{})
            hashes.update(v for k,v in value.items() if k in NAMES and v)
        return hashes

    def refresh_tracker(self):
        if self.tracker:self.tracker.update(self.tracker_hashes())

    async def start(self):
        self.client=ClientSession(timeout=ClientTimeout(total=15))
        await self.engine.listening()
        if self.tracker:await self.tracker.start(self.tracker_hashes())
        # Revalidate persistent objects before exposing them after a restart.
        for directory in self.catalog.public.iterdir():
            if directory.is_dir():shutil.rmtree(directory)
        for record,metadata in self.store.candidates():
            if record.public_key in self.keys:self.schedule(record,metadata)
        for record in self.store.public_records():
            if record.public_key in self.keys:self.schedule(record)
        self.tasks=[asyncio.create_task(self.poll_loop()),asyncio.create_task(self.reannounce_loop())]

    async def stop(self):
        tasks=list(self.tasks)+list(self.jobs.values())+list(self.gc_tasks.values())
        for task in tasks:task.cancel()
        await asyncio.gather(*tasks,return_exceptions=True)
        if self.client:await self.client.close()
        if self.tracker:await self.tracker.stop()
        if self.owns_engine:self.engine.close()

    def schedule(self,record,metadata=None):
        self.refresh_tracker()
        key=(record.public_key,record.sequence)
        if key in self.verified:
            value=self.verified[key]
            needed={record.info_hash.hex(),*(v for k,v in value.items() if k in NAMES and v)}
            if all(ih in self.handles and self.handles[ih].status().is_seeding for ih in needed):
                if self.store.public(record.public_key)==record:
                    self.store.adopt(record,value);self.collect()
                return
        if key not in self.jobs or self.jobs[key].done():
            self.jobs[key]=asyncio.create_task(self.replicate(record,metadata))

    async def fetch_metadata(self,info_hash,kind):
        for api in self.apis:
            try:
                async with self.client.get(api.rstrip("/")+"/v1/torrents/"+info_hash+".torrent",allow_redirects=False) as response:
                    response.raise_for_status();data=await bounded(response,16384 if kind=="descriptor" else 96*1024*1024)
                    return self.catalog.remember(data,info_hash,kind)
            except (ClientError,OSError,ValueError,TimeoutError,PublicationError) as error:log.debug("Metadata source unavailable: %s",error)
        return None

    async def download(self,info_hash,kind,job):
        self.active[job].add(info_hash)
        async with self.download_locks[info_hash]:
            if info_hash in self.handles:
                await self.engine.complete(self.handles[info_hash]);return
            try:data=self.catalog.metadata(info_hash);inspect(data,info_hash,kind)
            except FileNotFoundError:
                await self.fetch_metadata(info_hash,kind)
                try:data=self.catalog.metadata(info_hash)
                except FileNotFoundError:data=None
            handle=self.engine.add(info_hash,self.catalog.directory(info_hash),metadata=data,kind=kind,trackers=self.trackers,webseeds=self.webseeds)
            self.handles[info_hash]=handle
            try:
                if data is None:
                    data=await self.engine.metadata(handle,info_hash,kind=kind,trackers=self.trackers,webseeds=self.webseeds)
                    self.catalog.remember(data,info_hash,kind)
                parsed=inspect(data,info_hash,kind)
                # Existing sparse files do not count as fully allocated storage.
                path=self.catalog.path(info_hash,kind)
                allocated=path.stat().st_blocks*512 if path.exists() else 0
                needed=max(0,parsed["size"]-allocated)
                others=sum(n for h,n in self.reservations.items() if h!=info_hash)
                if shutil.disk_usage(self.catalog.root).free<needed+others+1024*1024:
                    raise PublicationError("Not enough free space for this candidate; current publication retained")
                self.reservations[info_hash]=needed
                await self.engine.complete(handle)
            except BaseException:
                self.handles.pop(info_hash,None)
                self.engine.session.remove_torrent(handle)
                raise
            finally:self.reservations.pop(info_hash,None)

    async def replicate(self,record,metadata=None):
        job=(record.public_key,record.sequence)
        try:
            if metadata:self.catalog.remember(metadata,record.info_hash.hex(),"descriptor")
            await self.download(record.info_hash.hex(),"descriptor",job)
            value=self.catalog.descriptor(record.info_hash.hex())
            self.descriptors[record.info_hash.hex()]=value
            self.refresh_tracker()
            await asyncio.gather(*(self.download(ih,kind,job) for kind,ih in value.items() if kind in NAMES and ih is not None))
            value=await asyncio.to_thread(self.catalog.validate_publication,record)
            self.verified[job]=value
            for kind,ih in value.items():
                if kind in NAMES and ih:self.catalog.expose(ih,kind)
            self.catalog.expose(record.info_hash.hex(),"descriptor")
            if self.store.public(record.public_key)==record:
                self.store.adopt(record,value)
                self.active.pop(job,None)
                self.collect()
        except asyncio.CancelledError:raise
        except Exception as error:log.error("Candidate %s/%s retained for retry: %s",record.public_key.hex(),record.sequence,error)
        finally:self.active.pop(job,None)

    def references(self):
        references=set()
        for record,value in self.store.adopted_records():
            references.add(record.info_hash.hex());references.update(v for k,v in value.items() if k in NAMES and v)
        for record in self.store.public_records()+[r for r,_ in self.store.candidates()]:
            references.add(record.info_hash.hex())
            try:references.update(v for k,v in self.catalog.descriptor(record.info_hash.hex()).items() if k in NAMES and v)
            except (OSError,PublicationError):return None  # Unknown child references: retain everything.
        for active in self.active.values():references.update(active)
        return references

    async def retire(self,info_hash):
        async with self.download_locks[info_hash]:
            references=self.references()
            if references is None or info_hash in references:return
            handle=self.handles.pop(info_hash,None)
            if handle:await self.engine.remove(handle)
            references=self.references()
            if references is not None and info_hash not in references:self.catalog.remove(info_hash)

    async def wait_gc(self):
        await asyncio.gather(*list(self.gc_tasks.values()))

    def collect(self):
        self.refresh_tracker()
        references=self.references()
        if references is None:return
        retained={(r.public_key,r.sequence) for r in self.store.public_records()+[r for r,_ in self.store.candidates()]+[r for r,_ in self.store.adopted_records()]}
        self.verified={key:value for key,value in self.verified.items() if key in retained or key in self.active}
        roots={r.info_hash.hex() for r in self.store.public_records()+[r for r,_ in self.store.candidates()]+[r for r,_ in self.store.adopted_records()]}
        self.descriptors={key:value for key,value in self.descriptors.items() if key in roots}
        for path in self.catalog.metainfo.glob("*.torrent"):
            ih=path.stem
            if ih in references:continue
            if ih not in self.gc_tasks or self.gc_tasks[ih].done():
                self.gc_tasks[ih]=asyncio.create_task(self.retire(ih))

    async def poll_once(self):
        async def poll(key):
            try:
                record=await self.engine.resolve(key,require_authoritative=False)
                if record:
                    self.store.set_public(record);self.schedule(record)
            except (PublicationError,OSError,TimeoutError) as error:log.warning("Name lookup %s failed: %s",key.hex(),error)
        await asyncio.gather(*(poll(key) for key in self.keys))

    async def poll_loop(self):
        while True:
            started=time.monotonic();await self.poll_once()
            await asyncio.sleep(max(0,self.poll_seconds-(time.monotonic()-started)))

    async def reannounce_loop(self):
        last={}
        while True:
            started=time.monotonic()
            records=self.store.public_records()
            for record in records:
                identity=(record.public_key,record.sequence)
                if record.public_key not in self.keys or started-last.get(identity,float("-inf"))<self.reannounce_seconds:continue
                try:
                    await self.engine.put(record)
                    last[identity]=time.monotonic()
                except (PublicationError,OSError,TimeoutError) as error:log.warning("Public record reannouncement failed: %s",error)
            identities={(r.public_key,r.sequence) for r in records}
            last={k:v for k,v in last.items() if k in identities}
            # Failed attempts retry on the next name-poll interval; successes
            # retain their original sequence/signature and wait a full hour.
            await asyncio.sleep(max(0,min(self.poll_seconds,self.reannounce_seconds)-(time.monotonic()-started)))

    def app(self):
        @web.middleware
        async def errors(request,handler):
            try:return await handler(request)
            except Conflict as error:return web.json_response({"error":str(error)},status=409)
            except (PublicationError,ValueError,TypeError) as error:return web.json_response({"error":str(error)},status=400)
            except OSError as error:
                if error.errno==errno.ENOSPC:return web.json_response({"error":"Storage is full; current publication retained"},status=507)
                raise
        app=web.Application(client_max_size=32768,middlewares=[errors])
        async def name(request):
            value=request.match_info["key"]
            if len(value)!=64 or value.lower()!=value:raise web.HTTPNotFound()
            try:key=bytes.fromhex(value)
            except ValueError:raise web.HTTPNotFound()
            if key not in self.keys:raise web.HTTPNotFound()
            record=self.store.public(key)
            if record is None:raise web.HTTPNotFound()
            return web.json_response(record.as_json(),headers={"Cache-Control":"no-store","Access-Control-Allow-Origin":"*"})
        async def metadata(request):
            ih=request.match_info["ih"];hash_bytes(ih)
            try:data=self.catalog.metadata(ih)
            except FileNotFoundError:raise web.HTTPNotFound()
            return web.Response(body=data,content_type="application/x-bittorrent",headers={"Access-Control-Allow-Origin":"*"})
        async def candidate(request):
            value=await request.json()
            if type(value) is not dict or set(value)!={"record","torrent"}:raise PublicationError("Invalid candidate request")
            record=Record.from_json(value["record"])
            if record.public_key not in self.keys:raise PublicationError("Publication identity is not followed")
            try:data=base64.b64decode(value["torrent"],validate=True)
            except (ValueError,TypeError) as error:raise PublicationError("Invalid torrent encoding") from error
            from .metadata import trusted
            data=trusted(data,expected=record.info_hash.hex(),kind="descriptor")
            self.store.accept_candidate(record,data)
            self.catalog.remember(data,record.info_hash.hex(),"descriptor")
            self.schedule(record,data)
            return web.json_response({"accepted":True},status=202)
        app.router.add_get("/v1/names/{key}",name)
        app.router.add_get("/v1/torrents/{ih}.torrent",metadata)
        app.router.add_post("/v1/candidates",candidate)
        return app
