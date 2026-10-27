"""Bounded public name resolution. Never admits torrents or follows identities."""
import asyncio
from collections import OrderedDict
from dataclasses import dataclass
import time
from .protocol import PublicationError,Conflict


class ResolverBusy(PublicationError):pass


@dataclass(frozen=True)
class Cached:
    expires: float
    record: object
    conflict: object=None


class Resolver:
    def __init__(self,engine,*,timeout=20,capacity=128,concurrency=8,ttl=30,negative_ttl=5):
        self.engine=engine;self.timeout=timeout;self.capacity=capacity
        self.ttl=ttl;self.negative_ttl=negative_ttl
        self.cache=OrderedDict();self.pending={};self.slots=asyncio.Semaphore(concurrency)

    @staticmethod
    def newest(previous,record,key,salt):
        for value in (previous,record):
            if value is not None:
                value.verify()
                if value.public_key!=key or value.salt!=salt:raise PublicationError("DHT record belongs to a different identity or salt")
        if previous is None:return record
        if record is None:return previous
        if previous.sequence==record.sequence and previous.value!=record.value:
            raise Conflict("Conflicting DHT records have the same sequence")
        return record if record.sequence>previous.sequence else previous

    def remember(self,identity,entry):
        self.cache.pop(identity,None);self.cache[identity]=entry
        while len(self.cache)>self.capacity:self.cache.popitem(last=False)

    def start_lookup(self,key,salt,floor):
        identity=(key,salt)
        task=self.pending.get(identity)
        if task is not None:return task
        if len(self.pending)>=self.capacity:raise ResolverBusy("DHT resolver is busy; retry shortly")
        async def lookup():
            try:
                async def run():
                    async with self.slots:
                        return await self.engine.resolve(key,self.timeout,require_authoritative=False,salt=salt)
                record=await asyncio.wait_for(run(),self.timeout+1)
                latest=self.cache.get(identity)
                record=self.newest(self.newest(floor,latest.record if latest else None,key,salt),record,key,salt)
                self.remember(identity,Cached(time.monotonic()+(self.ttl if record is not None else self.negative_ttl),record))
                return record
            except Conflict as error:
                latest=self.cache.get(identity)
                self.remember(identity,Cached(time.monotonic()+self.negative_ttl,latest.record if latest else floor,error))
                raise
            finally:self.pending.pop(identity,None)
        task=asyncio.create_task(lookup());self.pending[identity]=task
        # Disconnected callers and background refreshes must observe exceptions.
        task.add_done_callback(lambda task:None if task.cancelled() else task.exception())
        return task

    async def resolve(self,key,salt,*,known=None,refresh=False):
        identity=(key,salt);now=time.monotonic();entry=self.cache.get(identity)
        # Only the node's already-published, verified record may seed this fast
        # path. Unknown identities still wait for a complete public DHT lookup.
        if known is not None:
            try:record=self.newest(entry.record if entry else None,known,key,salt)
            except Conflict as error:
                self.remember(identity,Cached(now+self.negative_ttl,entry.record if entry else None,error));raise
            entry=Cached(entry.expires if entry and record==entry.record else 0,record,entry.conflict if entry else None)
            self.remember(identity,entry)
        elif entry is not None:self.remember(identity,entry)
        if entry is not None and entry.conflict is not None and entry.expires>now:raise entry.conflict
        if not refresh and entry is not None and entry.conflict is None and entry.expires>now:return entry.record
        if known is not None and not refresh and entry.conflict is None:
            try:self.start_lookup(key,salt,entry.record)
            except ResolverBusy:pass  # Keep serving the verified record under load.
            return entry.record
        task=self.start_lookup(key,salt,entry.record if entry else None)
        return await asyncio.shield(task)

    def invalidate(self,key):
        for identity in list(self.cache):
            if identity[0]==key:self.cache.pop(identity,None)

    async def close(self):
        tasks=list(self.pending.values())
        for task in tasks:task.cancel()
        await asyncio.gather(*tasks,return_exceptions=True)
