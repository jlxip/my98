import asyncio
import importlib.util
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/"src/torrent"))
from aiohttp import web
from nacl.signing import SigningKey
from my98_torrent.engine import Engine
from my98_torrent.files import file_hash
from my98_torrent.protocol import Record,PublicationError,Conflict
from my98_torrent.publisher import Publisher
from my98_torrent.service import Node

helper=importlib.util.spec_from_file_location("fixtures",Path(__file__).with_name("torrent-service.test.py"))
fixtures=importlib.util.module_from_spec(helper);helper.loader.exec_module(fixtures)
SEED=fixtures.SEED


def state_fixture(path,base):
    header=json.dumps({"version":1,"base":list(base),"nonce":[0]*16,"raw":4,"packed":16},separators=(",", ":")).encode()
    path.write_bytes(b"MY98STAT"+struct.pack("<I",len(header))+header+bytes(16+62))


def profile_fixture(path,disk,state=None):
    origin={"kind":"state","sha256":file_hash(state)} if state else {"kind":"boot"}
    path.write_text(json.dumps([{"version":2,"infoHash":disk,"unitBytes":65536,"origin":origin,"ranges":[[0,0]]+[None]*31}]))


class PublisherTest(unittest.IsolatedAsyncioTestCase):
    async def test_cut_retry_independent_components_conflict_and_retention(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);key=bytes(SigningKey(SEED).verify_key)
            engines=[Engine(listen="127.0.0.1:0",isolated=True) for _ in range(3)]
            tracker=fixtures.Tracker()
            node=Node(root/"node",[key],engine=engines[1],poll_seconds=3600,tracker=tracker)
            publisher=None;runner=None
            try:
                ports=await asyncio.gather(*(e.listening() for e in engines))
                for e in engines:
                    for port in ports:e.add_node(("127.0.0.1",port))
                await asyncio.gather(*(e.dht_ready() for e in engines))
                await node.start();runner=web.AppRunner(node.app());await runner.setup()
                site=web.TCPSite(runner,"127.0.0.1",0);await site.start()
                nodes=[{"name":"fixture","api":"http://127.0.0.1:"+str(site._server.sockets[0].getsockname()[1]),"peer":["127.0.0.1",ports[1]]}]
                publisher=Publisher(root/"publisher",nodes,engine=engines[0],lookup_timeout=30);await publisher.start()
                disk=root/"disk";header=fixtures.disk_fixture(disk)
                journal=await publisher.prepare(SEED,"publish",disk=disk)
                candidate=Record.from_json(journal["record"])
                await publisher.transfer(journal,15)
                self.assertIsNone(node.store.public(key))
                self.assertIsNone(await engines[2].resolve(key,5))
                self.assertEqual(publisher.journal(key)["phase"],"copied")
                first_hash=candidate.info_hash.hex();first_desc=publisher.catalog.descriptor(first_hash)
                self.assertIsNone(first_desc["state"]);self.assertIsNone(first_desc["profile"])
                # A process cut closes the temporary seeder but retains candidate,
                # files and signature; the pending record never became public.
                await publisher.stop();engines[0].close()
                engines[0]=Engine(listen="127.0.0.1:0",isolated=True)
                new_port=await engines[0].listening()
                for i in (1,2):engines[0].add_node(("127.0.0.1",ports[i]));engines[i].add_node(("127.0.0.1",new_port))
                await engines[0].dht_ready()
                publisher=Publisher(root/"publisher",nodes,engine=engines[0],lookup_timeout=30);await publisher.start()
                journal=publisher.journal(key)
                self.assertEqual(Record.from_json(journal["record"]),candidate)
                published=await publisher.publish(journal,15)
                self.assertEqual(published,candidate)
                await node.poll_once();await node.jobs[(key,published.sequence)]
                self.assertEqual(node.store.adopted(key)[0],published)
                disk_hash=first_desc["disk"]
                async def update(operation,**kwargs):
                    journal=await publisher.prepare(SEED,operation,**kwargs)
                    record=Record.from_json(journal["record"])
                    prior=node.store.adopted(key)[0]
                    await publisher.transfer(journal,15)
                    self.assertEqual(node.store.adopted(key)[0],prior)
                    self.assertIn(prior.info_hash.hex(),node.owned_hashes())
                    self.assertTrue((node.catalog.public/prior.info_hash.hex()/"publication.json").exists())
                    await publisher.commit(journal)
                    await node.poll_once();await node.jobs[(key,record.sequence)]
                    await node.wait_gc()
                    self.assertEqual(node.store.adopted(key)[0],record)
                    value=publisher.catalog.descriptor(record.info_hash.hex())
                    self.assertEqual(value["disk"],disk_hash)
                    self.assertTrue((node.catalog.public/disk_hash/"disk.my98").exists())
                    self.assertEqual(node.owned_hashes(),{record.info_hash.hex(),*(v for k,v in value.items() if k in ("disk","state","profile") and v)})
                    return record,value
                state=root/"state";state_fixture(state,header)
                state_record,state_desc=await update("state",state=state)
                self.assertIsNotNone(state_desc["state"])
                self.assertFalse((node.catalog.public/first_hash).exists())
                profile=root/"profile";profile_fixture(profile,disk_hash,state)
                _,profile_desc=await update("profile",profile=profile)
                self.assertEqual(profile_desc["state"],state_desc["state"])
                with self.assertRaises(PublicationError):await publisher.prepare(SEED,"clear-state")
                _,cleared=await update("clear-profile")
                self.assertEqual(cleared["state"],state_desc["state"])
                self.assertIsNone(cleared["profile"])
                _,cleared=await update("clear-state")
                self.assertIsNone(cleared["state"])
                # A concurrent signed commit after preparing must block our name
                # update even when our candidate carries a larger sequence.
                pending=await publisher.prepare(SEED,"state",state=state)
                await publisher.transfer(pending,15)
                own=Record.from_json(pending["record"])
                concurrent=Record.sign(SEED,own.sequence+1,"ab"*20)
                await engines[2].put(concurrent)
                with self.assertRaises(Conflict):await publisher.commit(pending)
                self.assertEqual(await engines[2].resolve(key,30),concurrent)
                serialized=json.dumps(publisher.journal(key))
                self.assertNotIn(SEED.hex(),serialized)
                self.assertEqual(Record.from_json(publisher.journal(key)["record"]),own)
            finally:
                if publisher:await publisher.stop()
                await node.stop()
                if runner:await runner.cleanup()
                for engine in engines:engine.close()

if __name__=="__main__":unittest.main()
