import asyncio
import hashlib
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/"src/torrent"))
import libtorrent as lt
from my98_torrent.engine import Engine
from my98_torrent.metadata import create,inspect,trusted,PIECE
from my98_torrent.protocol import PublicationError

class MetadataTest(unittest.TestCase):
    def test_determinism_structure_and_untrusted_hints(self):
        with tempfile.TemporaryDirectory() as directory:
            p=Path(directory)/"source";p.write_bytes(bytes(range(256))*3000)
            ih,data=create(p,"disk")
            self.assertEqual(create(p,"disk"),(ih,data))
            original=lt.bdecode(data);original[b"url-list"]=[b"http://127.0.0.1/admin"];original[b"announce"]=b"udp://evil.invalid"
            self.assertEqual(trusted(lt.bencode(original),expected=ih),data)
            self.assertEqual(inspect(data)["pieces"],3)
            for field,replacement in [(b"name",b"../disk.my98"),(b"piece length",PIECE*2),(b"pieces",b""),(b"length",0)]:
                bad=lt.bdecode(data);bad[b"info"][field]=replacement
                with self.assertRaises(PublicationError):inspect(lt.bencode(bad))
            with self.assertRaises(PublicationError):inspect(data,expected="00"*20)
            with self.assertRaises(PublicationError):inspect(data,kind="descriptor")

class TransferTest(unittest.IsolatedAsyncioTestCase):
    async def test_production_seeder_accepts_two_readers_behind_the_same_ip(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/"source";source.mkdir()
            data=bytes(range(256))*2200
            (source/"disk.my98").write_bytes(data)
            ih,metadata=create(source/"disk.my98","disk")
            # Exercise production defaults: isolated=True used to hide this bug
            # by enabling multiple connections per IP only in test sessions.
            settings={"enable_dht":False,"dht_bootstrap_nodes":"",
                "enable_incoming_utp":False,"enable_outgoing_utp":False}
            engines=[Engine(listen="127.0.0.1:0",settings=settings) for _ in range(3)]
            try:
                ports=await asyncio.gather(*(e.listening() for e in engines))
                seed=engines[0].add(ih,source,metadata=metadata,kind="disk",direct_only=True)
                await engines[0].complete(seed,15)
                for i in [1,2]:
                    target=engines[i].add(ih,root/str(i),kind="disk",
                        peers=[("127.0.0.1",ports[0])],direct_only=True)
                    self.assertEqual(await engines[i].metadata(target,ih,kind="disk",timeout=10),metadata)
                    await engines[i].complete(target,15)
                    self.assertEqual((root/str(i)/"disk.my98").read_bytes(),data)
                peers=seed.get_peer_info()
                self.assertEqual(len(peers),2)
                self.assertEqual({peer.ip[0] for peer in peers},{"127.0.0.1"})
                self.assertEqual(len({peer.ip[1] for peer in peers}),2)
            finally:
                for engine in engines:engine.close()

    async def test_persistent_transfer_exact_same_node_and_magnet_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/"source";source.mkdir()
            data=bytes(range(256))*2200
            (source/"disk.my98").write_bytes(data)
            ih,metadata=create(source/"disk.my98","disk")
            engines=[Engine(listen="127.0.0.1:0",isolated=True) for _ in range(2)]
            try:
                ports=await asyncio.gather(*(e.listening() for e in engines))
                seed=engines[0].add(ih,source,metadata=metadata,kind="disk")
                await engines[0].complete(seed,15)
                endpoint=("127.0.0.1",ports[1])
                target=engines[1].add(ih,root/"target",kind="disk")
                seed.connect_peer(endpoint)
                received=await engines[1].metadata(target,ih,kind="disk",timeout=20)
                self.assertEqual(received,metadata)
                await engines[1].complete(target,20)
                for _ in range(50):
                    if Engine.first_complete_seedbox([seed],[endpoint]):break
                    await asyncio.sleep(.1)
                self.assertEqual(Engine.first_complete_seedbox([seed],[endpoint]),endpoint)
                self.assertIsNone(Engine.first_complete_seedbox([seed],[("127.0.0.1",ports[0])]))
                self.assertEqual((root/"target/disk.my98").read_bytes(),data)
            finally:
                for e in engines:e.close()
            # No fast-resume trust: reopen preserved files and hash them again.
            async with Engine(listen="127.0.0.1:0",isolated=True) as recovered:
                h=recovered.add(ih,root/"target",metadata=metadata,kind="disk")
                await recovered.complete(h,15)
                self.assertEqual((root/"target/disk.my98").read_bytes(),data)

if __name__=="__main__":unittest.main()
