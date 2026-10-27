"""Reader latency must not discard signed state or weaken DHT conflict checks."""
import asyncio
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/"src/torrent"))
from aiohttp import ClientSession,web
from my98_torrent.protocol import Record,Locations,SALT,LOCATIONS_SALT,Conflict,PublicationError
from my98_torrent.resolver import Resolver
from my98_torrent.service import Node
SEED=bytes(range(32))


class ResolverLatencyTest(unittest.IsolatedAsyncioTestCase):
    async def test_known_record_serves_during_shared_refresh_and_never_rolls_back(self):
        old=Record.sign(SEED,2,"12"*20);new=Record.sign(SEED,3,"34"*20)
        gate=asyncio.Event();started=asyncio.Event();calls=[]
        class Engine:
            result=new
            async def resolve(self,key,timeout,**options):
                calls.append((key,options));started.set();await gate.wait();return self.result
        engine=Engine();resolver=Resolver(engine)
        try:
            # A 20-second native lookup remains blocked; readers must still finish.
            self.assertEqual(await asyncio.wait_for(resolver.resolve(old.public_key,SALT,known=old),.2),old)
            await started.wait()
            poll=asyncio.create_task(resolver.resolve(old.public_key,SALT,known=old,refresh=True))
            self.assertEqual(await asyncio.wait_for(resolver.resolve(old.public_key,SALT,known=old),.2),old)
            self.assertFalse(poll.done());self.assertEqual(len(calls),1)
            gate.set();self.assertEqual(await poll,new)
            self.assertEqual(await resolver.resolve(old.public_key,SALT,known=old),new)
            engine.result=old
            self.assertEqual(await resolver.resolve(old.public_key,SALT,known=old,refresh=True),new)
            engine.result=None
            self.assertEqual(await resolver.resolve(old.public_key,SALT,known=old,refresh=True),new)
        finally:await resolver.close()

    async def test_conflict_blocks_fast_reads_until_a_full_refresh_succeeds(self):
        first=Record.sign(SEED,2,"12"*20);conflict=Record.sign(SEED,2,"34"*20)
        class Engine:
            result=conflict
            async def resolve(self,*args,**options):return self.result
        engine=Engine();resolver=Resolver(engine,negative_ttl=.01)
        try:
            await resolver.resolve(first.public_key,SALT,known=first)
            with self.assertRaises(Conflict):await resolver.resolve(first.public_key,SALT,known=first,refresh=True)
            with self.assertRaises(Conflict):await resolver.resolve(first.public_key,SALT,known=first)
            engine.result=Record.sign(SEED,3,"56"*20)
            await asyncio.sleep(.02)
            self.assertEqual(await resolver.resolve(first.public_key,SALT,known=first),engine.result)
        finally:await resolver.close()

    async def test_wrong_identity_or_salt_cannot_seed_fast_path(self):
        record=Record.sign(SEED,1,"12"*20)
        class Engine:
            async def resolve(self,*args,**options):raise AssertionError("Unverified seed started a lookup")
        resolver=Resolver(Engine())
        try:
            for key,salt in [(bytes(32),SALT),(record.public_key,LOCATIONS_SALT)]:
                with self.subTest(key=key,salt=salt),self.assertRaises(PublicationError):
                    await resolver.resolve(key,salt,known=record)
            self.assertFalse(resolver.pending)
        finally:await resolver.close()


class NodeLatencyTest(unittest.IsolatedAsyncioTestCase):
    async def test_each_record_is_applied_when_the_other_lookup_fails(self):
        publication=Record.sign(SEED,1,"12"*20)
        locations=Locations.sign(SEED,1,["https://seedbox.example:8445"])
        records={SALT:publication,LOCATIONS_SALT:locations};key=publication.public_key
        for failed in records:
            for error in (Conflict("Conflicting record"),TimeoutError("Timed out"),PublicationError("Invalid record")):
                with self.subTest(failed=failed,error=type(error).__name__),tempfile.TemporaryDirectory() as directory:
                    class Engine:
                        async def resolve(self,public_key,timeout,*,salt,**options):
                            if salt==failed:raise error
                            return records[salt]
                    node=Node(directory,[key],engine=Engine());scheduled=[];node.schedule=scheduled.append
                    try:
                        await node.poll_once()
                        self.assertEqual(node.store.public(key),None if failed==SALT else publication)
                        self.assertEqual(scheduled,[] if failed==SALT else [publication])
                        self.assertEqual(node.store.locations(key),None if failed==LOCATIONS_SALT else locations)
                    finally:await node.stop()

    async def test_each_record_is_applied_before_the_other_lookup_finishes(self):
        publication=Record.sign(SEED,1,"12"*20)
        locations=Locations.sign(SEED,1,["https://seedbox.example:8445"])
        records={SALT:publication,LOCATIONS_SALT:locations};key=publication.public_key
        for slow in records:
            with self.subTest(slow=slow),tempfile.TemporaryDirectory() as directory:
                release=asyncio.Event();started=asyncio.Event();applied=asyncio.Event()
                class Engine:
                    async def resolve(self,public_key,timeout,*,salt,**options):
                        if salt==slow:started.set();await release.wait()
                        return records[salt]
                node=Node(directory,[key],engine=Engine());scheduled=[];node.schedule=scheduled.append
                fast=LOCATIONS_SALT if slow==SALT else SALT
                original=node.store.set_locations if fast==LOCATIONS_SALT else node.store.set_public
                def remember(record):original(record);applied.set()
                if fast==SALT:node.store.set_public=remember
                else:node.store.set_locations=remember
                poll=asyncio.create_task(node.poll_once())
                try:
                    await started.wait();await asyncio.wait_for(applied.wait(),.2)
                    self.assertFalse(poll.done())
                    if fast==SALT:self.assertEqual(scheduled,[publication])
                    else:self.assertEqual(node.store.locations(key),locations)
                    release.set();await poll
                    self.assertEqual(node.store.public(key),publication);self.assertEqual(node.store.locations(key),locations)
                finally:
                    release.set();poll.cancel();await asyncio.gather(poll,return_exceptions=True);await node.stop()

    async def test_persisted_records_remain_readable_while_both_polls_refresh(self):
        publication=Record.sign(SEED,1,"12"*20)
        locations=Locations.sign(SEED,1,["https://seedbox.example:8445"])
        records={SALT:publication,LOCATIONS_SALT:locations};key=publication.public_key
        started={salt:asyncio.Event() for salt in records};release=asyncio.Event();calls=[]
        class Engine:
            async def resolve(self,public_key,timeout,*,salt,**options):
                calls.append(salt);started[salt].set();await release.wait();return records[salt]
        with tempfile.TemporaryDirectory() as directory:
            node=Node(directory,[key],engine=Engine());node.schedule=lambda record:None
            node.store.set_public(publication);node.store.set_locations(locations)
            runner=web.AppRunner(node.app());await runner.setup()
            site=web.TCPSite(runner,"127.0.0.1",0);await site.start()
            origin="http://127.0.0.1:"+str(site._server.sockets[0].getsockname()[1])
            poll=asyncio.create_task(node.poll_once())
            try:
                await started[SALT].wait()
                async with ClientSession() as client:
                    for salt,expected in records.items():
                        async def lookup():
                            async with client.get(origin+"/v2/dht/"+key.hex()+"/"+salt.hex()) as response:
                                self.assertEqual(response.status,200);return await response.json()
                        self.assertEqual(await asyncio.wait_for(lookup(),.2),expected.as_json())
                    self.assertFalse(poll.done())
                    release.set();await poll
                self.assertEqual(calls.count(SALT),1);self.assertEqual(calls.count(LOCATIONS_SALT),1)
                self.assertEqual(node.store.public(key),publication);self.assertEqual(node.store.locations(key),locations)
                self.assertFalse(node.handles);self.assertFalse(node.store.candidates())
            finally:
                release.set();poll.cancel();await asyncio.gather(poll,return_exceptions=True)
                await node.stop();await runner.cleanup()

if __name__=="__main__":unittest.main()
