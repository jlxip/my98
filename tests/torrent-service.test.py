import asyncio
import base64
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/"src/torrent"))
from aiohttp import ClientSession,web
from nacl.signing import SigningKey
from my98_torrent.engine import Engine
from my98_torrent.files import Catalog,atomic_write
from my98_torrent.protocol import Record,descriptor_bytes
from my98_torrent.service import Node

SEED=bytes(range(32))

class Tracker:
    def __init__(self):self.allowed=set();self.history=[]
    def update(self,hashes):
        self.allowed=set(hashes);self.history.append(self.allowed.copy())
    async def start(self,hashes):self.update(hashes)
    async def stop(self):pass


def disk_fixture(path,seed=SEED):
    key=SigningKey(seed);size=600000
    prefix=b"SLOPDSK\0"+struct.pack("<IIQ",1,65536,size)+bytes(110)
    header=prefix+key.sign(b"slop86/linear-disk/v1\0"+prefix).signature
    path.write_bytes(header+bytes(range(250))*(size//250)+bytes(((size+65535)//65536)*62))
    return header


class ServiceTest(unittest.IsolatedAsyncioTestCase):
    async def test_admission_transfer_does_not_commit_name_restart_and_reannounce(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);publisher=Catalog(root/"publisher")
            path=root/"disk";disk_fixture(path)
            key=bytes(SigningKey(SEED).verify_key)
            disk=publisher.import_file(path,"disk",public_key=key)
            desc=root/"publication";desc.write_bytes(descriptor_bytes({"version":1,"disk":disk,"state":None,"profile":None}))
            ih=publisher.import_file(desc,"descriptor")
            record=Record.sign(SEED,100,ih)
            engines=[Engine(listen="127.0.0.1:0",isolated=True) for _ in range(3)]
            tracker=Tracker()
            node=Node(root/"node",[key],engine=engines[1],poll_seconds=3600,tracker=tracker)
            runner=None;connector=None
            try:
                ports=await asyncio.gather(*(e.listening() for e in engines))
                for e in engines:
                    for port in ports:e.add_node(("127.0.0.1",port))
                await asyncio.sleep(1)  # Wait for isolated routing-table bootstrap.
                await node.start();runner=web.AppRunner(node.app());await runner.setup()
                site=web.TCPSite(runner,"127.0.0.1",0);await site.start();url="http://127.0.0.1:"+str(site._server.sockets[0].getsockname()[1])
                handles=[engines[0].add(h,publisher.directory(h),metadata=publisher.metadata(h)) for h in [disk,ih]]
                await asyncio.gather(*(engines[0].complete(h,10) for h in handles))
                async def connect():
                    while True:
                        for h in handles:h.connect_peer(("127.0.0.1",ports[1]))
                        await asyncio.sleep(.1)
                connector=asyncio.create_task(connect())
                payload={"record":record.as_json(),"torrent":base64.b64encode(publisher.metadata(ih)).decode()}
                async with ClientSession() as client:
                    # Reject arbitrary identities before writing anything.
                    bad=Record.sign(bytes(reversed(range(32))),100,ih)
                    async with client.post(url+"/v1/candidates",json={**payload,"record":bad.as_json()}) as response:self.assertEqual(response.status,400)
                    self.assertEqual(tracker.allowed,set())
                    for _ in range(2):
                        async with client.post(url+"/v1/candidates",json=payload) as response:self.assertEqual(response.status,202)
                    async with client.get(url+"/v1/names/"+key.hex()) as response:self.assertEqual(response.status,404)
                    for _ in range(200):
                        if Engine.first_complete_seedbox(handles,[("127.0.0.1",ports[1])]):break
                        await asyncio.sleep(.05)
                    self.assertEqual(Engine.first_complete_seedbox(handles,[("127.0.0.1",ports[1])]),("127.0.0.1",ports[1]))
                    self.assertIsNone(node.store.public(key))
                    self.assertIsNone(node.store.adopted(key))
                    self.assertEqual(len(node.store.candidates()),1)
                    self.assertEqual(tracker.allowed,{ih,disk})
                    self.assertIn({ih},tracker.history)  # Root before verified children.
                    # The name changes only after the publisher's separate DHT commit.
                    await engines[0].put(record)
                    await node.poll_once()
                    await asyncio.wait_for(node.jobs[(key,100)],15)
                    self.assertEqual(node.store.adopted(key)[0],record)
                    self.assertEqual(node.store.candidates(),[])
                    async with client.get(url+"/v1/names/"+key.hex()) as response:
                        self.assertEqual(Record.from_json(await response.json()),record)
                connector.cancel();await asyncio.gather(connector,return_exceptions=True);connector=None
                engines[0].close()  # Publisher is gone; persistence and name remain.
                await node.stop();await runner.cleanup();runner=None
                engines[1].close()
                engines[2].close()
                engines[1]=Engine(listen="127.0.0.1:0",isolated=True)
                engines[2]=Engine(listen="127.0.0.1:0",isolated=True)
                port,witness=await asyncio.gather(engines[1].listening(),engines[2].listening())
                engines[1].add_node(("127.0.0.1",witness));engines[2].add_node(("127.0.0.1",port))
                await asyncio.gather(engines[1].dht_ready(),engines[2].dht_ready())
                node=Node(root/"node",[key],engine=engines[1],poll_seconds=3600,tracker=tracker)
                await node.start()
                await asyncio.wait_for(node.jobs[(key,100)],15)
                self.assertEqual(node.catalog.path(disk,"disk").read_bytes(),path.read_bytes())
                self.assertTrue((node.catalog.public/disk/"disk.my98").exists())
                self.assertEqual(tracker.allowed,{ih,disk})
                # Persistent references of an identity removed from the explicit
                # follow configuration must never authorize a tracker swarm.
                removed=Node(root/"node",[],engine=engines[1])
                self.assertEqual(removed.tracker_hashes(),set())
                await engines[1].put(node.store.public(key))
                self.assertEqual(await engines[2].resolve(key,10),record)
            finally:
                if connector:connector.cancel();await asyncio.gather(connector,return_exceptions=True)
                await node.stop()
                if runner:await runner.cleanup()
                for e in engines:e.close()

if __name__=="__main__":unittest.main()
