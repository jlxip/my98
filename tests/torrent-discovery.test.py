"""A foreign seedbox is discovered through a resolver that never hosts its data."""
import asyncio
import hashlib
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/"src/torrent"))
from aiohttp import ClientSession,web
from my98_torrent.engine import Engine
from my98_torrent.service import Node
from my98_torrent.publisher import Publisher
from my98_torrent.protocol import Record,Locations,SALT,LOCATIONS_SALT,PublicationError,compare
from my98_torrent.resolver import Resolver,ResolverBusy
from nacl.signing import SigningKey
spec=importlib.util.spec_from_file_location("fixtures",Path(__file__).with_name("torrent-service.test.py"))
fixtures=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixtures)
SEED=fixtures.SEED

class LocationsTest(unittest.TestCase):
    def test_signed_origins_bind_identity_sequence_and_exact_value(self):
        record=Locations.sign(SEED,123,["https://seedbox.example:8445/","https://other.example:8445"])
        self.assertEqual(Locations.from_json(record.as_json()),record)
        self.assertEqual(Locations.sign(SEED,1,["https://EXAMPLE.org:443/"]).origins,("https://example.org",))
        self.assertLessEqual(len(record.value),1000)
        for changes in [{"origins":["https://attacker.example"]},{"sequence":124},{"publicKey":"00"*32},{"salt":SALT.hex()}]:
            with self.subTest(changes=changes),self.assertRaises(PublicationError):Locations.from_json({**record.as_json(),**changes})
        with self.assertRaises(PublicationError):Locations.sign(SEED,1,["http://example.org"])
        with self.assertRaises(PublicationError):Locations.sign(SEED,1,["https://example.org/path"])
        with self.assertRaises(PublicationError):Locations.sign(SEED,1,["https://"+"a"*120+str(i)+".example" for i in range(10)])
        with self.assertRaises(PublicationError):compare(record,Locations.sign(SEED,122,record.origins))

class ResolverTest(unittest.IsolatedAsyncioTestCase):
    async def test_coalescing_limits_cache_and_disconnect(self):
        event=asyncio.Event();calls=[]
        record=Record.sign(SEED,1,"12"*20)
        class EngineFixture:
            async def resolve(self,key,timeout,**options):calls.append((key,options));await event.wait();return record
        resolver=Resolver(EngineFixture(),capacity=1,timeout=1)
        key=record.public_key
        one=asyncio.create_task(resolver.resolve(key,SALT));two=asyncio.create_task(resolver.resolve(key,SALT))
        await asyncio.sleep(.01)
        with self.assertRaises(ResolverBusy):await resolver.resolve(bytes(32),SALT)
        one.cancel();await asyncio.gather(one,return_exceptions=True)
        event.set();self.assertEqual(await two,record)
        self.assertEqual(await resolver.resolve(key,SALT),record)
        self.assertEqual(len(calls),1)
        self.assertFalse(resolver.pending)
        await resolver.close()

class PollResolverTest(unittest.IsolatedAsyncioTestCase):
    async def test_poll_and_http_share_native_lookups_before_resolver_deadline(self):
        record=Record.sign(SEED,1,"12"*20)
        locations=Locations.sign(SEED,2,["https://seedbox.example:8445"])
        records={SALT:record,LOCATIONS_SALT:locations};key=record.public_key
        started={salt:asyncio.Event() for salt in records}
        release={salt:asyncio.Event() for salt in records}
        requested={salt:asyncio.Event() for salt in records}
        calls={salt:0 for salt in records};locks={salt:asyncio.Lock() for salt in records}
        duplicate=asyncio.Event();scheduled=[]
        class EngineFixture:
            async def resolve(self,public_key,timeout=20,*,require_authoritative=True,salt=SALT):
                self_test.assertEqual(public_key,key)
                self_test.assertFalse(require_authoritative)
                async with locks[salt]:
                    calls[salt]+=1;started[salt].set()
                    # A duplicate native request needs another network reply;
                    # the single reply to the original lookup cannot finish it.
                    await (release[salt] if calls[salt]==1 else duplicate).wait()
                    return records[salt]
        self_test=self
        with tempfile.TemporaryDirectory() as directory:
            node=Node(directory,[key],engine=EngineFixture());node.schedule=scheduled.append
            node.resolver.timeout=.1
            app=node.app()
            @web.middleware
            async def incoming(request,handler):
                requested[bytes.fromhex(request.path.rsplit("/",1)[-1])].set()
                return await handler(request)
            app.middlewares.append(incoming)
            runner=web.AppRunner(app);await runner.setup()
            site=web.TCPSite(runner,"127.0.0.1",0);await site.start()
            origin="http://127.0.0.1:"+str(site._server.sockets[0].getsockname()[1])
            poll=asyncio.create_task(node.poll_once());requests=[]
            try:
                async with ClientSession() as client:
                    async def lookup(salt):
                        async with client.get(origin+"/v2/dht/"+key.hex()+"/"+salt.hex()) as response:
                            self.assertEqual(response.status,200)
                            return await response.json()
                    for salt,expected in records.items():
                        await asyncio.wait_for(started[salt].wait(),1)
                        request=asyncio.create_task(lookup(salt));requests.append(request)
                        await asyncio.wait_for(requested[salt].wait(),1)
                        release[salt].set()
                        result=await asyncio.wait_for(request,node.resolver.timeout+1)
                        self.assertEqual(result,expected.as_json())
                    await asyncio.wait_for(poll,node.resolver.timeout+1)
                self.assertEqual(calls,{SALT:1,LOCATIONS_SALT:1})
                self.assertEqual(scheduled,[record])
                self.assertEqual(node.store.public(key),record)
                self.assertEqual(node.store.highest(key),record)
                self.assertEqual(node.store.locations(key),locations)
                self.assertEqual(node.store.candidates(),[])
                self.assertEqual(node.store.adopted_records(),[])
            finally:
                poll.cancel()
                for request in requests:request.cancel()
                await asyncio.gather(poll,*requests,return_exceptions=True)
                await node.stop();await runner.cleanup()

    async def test_explicit_poll_refreshes_negative_and_positive_cache(self):
        key=bytes(SigningKey(SEED).verify_key);records={SALT:None,LOCATIONS_SALT:None};calls=[];scheduled=[]
        class EngineFixture:
            async def resolve(self,public_key,timeout=20,*,salt=SALT,**options):
                calls.append((public_key,salt));return records[salt]
        with tempfile.TemporaryDirectory() as directory:
            node=Node(directory,[key],engine=EngineFixture());node.schedule=scheduled.append
            try:
                await node.poll_once()
                self.assertIsNone(node.store.public(key));self.assertIsNone(node.store.locations(key))
                for sequence in (1,2):
                    records[SALT]=Record.sign(SEED,sequence,("12" if sequence==1 else "34")*20)
                    records[LOCATIONS_SALT]=Locations.sign(SEED,sequence,[f"https://seedbox{sequence}.example:8445"])
                    await node.poll_once()
                    self.assertEqual(node.store.public(key),records[SALT])
                    self.assertEqual(node.store.locations(key),records[LOCATIONS_SALT])
                self.assertEqual(calls,[(key,SALT),(key,LOCATIONS_SALT)]*3)
                self.assertEqual([record.sequence for record in scheduled],[1,2])
                self.assertEqual(node.store.candidates(),[])
                self.assertEqual(node.store.adopted_records(),[])
            finally:await node.stop()

class DiscoveryTest(unittest.IsolatedAsyncioTestCase):
    async def test_hash_only_publication_and_unfollowed_public_resolution(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);key=bytes(SigningKey(SEED).verify_key)
            engines=[Engine(listen="127.0.0.1:0",isolated=True) for _ in range(4)]
            seedbox=Node(root/"seedbox",[key],engine=engines[1],poll_seconds=3600)
            broker=Node(root/"broker",[],engine=engines[2],poll_seconds=3600)
            runners=[];publisher=None;requests=[]
            async def serve(node):
                app=node.app()
                @web.middleware
                async def inspect(request,handler):
                    requests.append(request.path)
                    self.assertNotIn(".torrent",request.path)
                    if request.method=="POST":self.assertEqual(set(await request.json()),{"record"})
                    return await handler(request)
                app.middlewares.append(inspect)
                runner=web.AppRunner(app);await runner.setup();runners.append(runner)
                site=web.TCPSite(runner,"127.0.0.1",0);await site.start()
                return "http://127.0.0.1:"+str(site._server.sockets[0].getsockname()[1])
            try:
                ports=await asyncio.gather(*(engine.listening() for engine in engines))
                for engine in engines:
                    for port in ports:engine.add_node(("127.0.0.1",port))
                await asyncio.gather(*(engine.dht_ready() for engine in engines))
                await seedbox.start();await broker.start()
                origin=await serve(seedbox);resolver=await serve(broker)
                publisher=Publisher(root/"publisher",[{"name":"foreign","api":origin,"peer":["127.0.0.1",ports[1]]}],engine=engines[0])
                await publisher.start()
                disk=root/"disk.my98";fixtures.disk_fixture(disk)
                journal=await publisher.prepare(SEED,"publish",disk=disk)
                record=await publisher.publish(journal,timeout=30)
                await seedbox.poll_once();await seedbox.jobs[(key,record.sequence)]
                async with ClientSession() as client:
                    async with client.get(resolver+"/v2/dht/"+key.hex()+"/"+SALT.hex()) as response:
                        self.assertEqual(response.status,200);self.assertEqual(Record.from_json(await response.json()),record)
                    async with client.get(resolver+"/v2/dht/"+key.hex()+"/"+LOCATIONS_SALT.hex()) as response:
                        self.assertEqual(response.status,200);locations=Locations.from_json(await response.json(),key)
                    self.assertEqual(locations.origins,(origin,))
                    self.assertEqual(seedbox.store.locations(key),locations)
                    component=seedbox.catalog.descriptor(record.info_hash.hex())["disk"]
                    async with client.get(origin+"/v2/info/"+component) as response:
                        self.assertEqual(response.status,200);raw=await response.read()
                        self.assertEqual(hashlib.sha1(raw).hexdigest(),component)
                    async with client.get(resolver+"/v2/info/"+component) as response:self.assertEqual(response.status,404)
                    async with client.get(origin+"/v1/names/"+key.hex()) as response:self.assertEqual(response.status,404)
                self.assertEqual(broker.store.followed(),[])
                self.assertEqual(broker.store.candidates(),[])
                self.assertEqual(broker.handles,{})
                self.assertEqual(broker.engine.locks,{})
                self.assertEqual(list(broker.catalog.metainfo.iterdir()),[])
                before=await publisher.current(key)
                moved=await publisher.publish_locations(SEED)
                self.assertGreater(moved.sequence,locations.sequence)
                self.assertEqual(await publisher.current(key),before,"Location update republished the disk")
                await seedbox.poll_once()
                self.assertEqual(seedbox.store.locations(key),moved)
                self.assertIn("/v2/candidates",requests)
                self.assertNotIn(SEED.hex(),publisher.journal_path(key).read_text())
            finally:
                if publisher:await publisher.stop()
                await seedbox.stop();await broker.stop()
                for runner in runners:await runner.cleanup()
                for engine in engines:engine.close()

if __name__=="__main__":unittest.main()
