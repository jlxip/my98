import asyncio
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
ROOT=Path(__file__).resolve().parent.parent
sys.path[:0]=[str(ROOT/"src/torrent"),str(ROOT/"scripts")]
from aiohttp import web
from identity import derive_seed
from nacl.signing import SigningKey
from my98_torrent.engine import Engine
from my98_torrent.service import Node
from my98_torrent.protocol import Record
helper=importlib.util.spec_from_file_location("fixtures",ROOT/"tests/torrent-service.test.py")
fixtures=importlib.util.module_from_spec(helper);helper.loader.exec_module(fixtures)

class CliTest(unittest.IsolatedAsyncioTestCase):
    async def test_real_cli_publication_with_prompted_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            seed=derive_seed("café","public compatibility test password ","main")
            key=bytes(SigningKey(seed).verify_key)
            self.assertEqual(key.hex(),"07d2860c1066244fa0d7973545b4dd822466d8b2c9fd83fb84331716949b3a54")
            engine=Engine(listen="127.0.0.1:0",isolated=True)
            witness=Engine(listen="127.0.0.1:0",isolated=True)
            node=Node(root/"node",[key],engine=engine,poll_seconds=3600)
            runner=None;process=None
            try:
                port,other=await asyncio.gather(engine.listening(),witness.listening())
                engine.add_node(("127.0.0.1",other));witness.add_node(("127.0.0.1",port))
                await asyncio.gather(engine.dht_ready(),witness.dht_ready())
                await node.start()
                runner=web.AppRunner(node.app());await runner.setup()
                site=web.TCPSite(runner,"127.0.0.1",0);await site.start()
                api="http://127.0.0.1:"+str(site._server.sockets[0].getsockname()[1])
                config=root/"config.json";config.write_text(json.dumps({"nodes":[{"name":"fixture","api":api,"peer":["127.0.0.1",port]}]}))
                disk=root/"disk.my98";fixtures.disk_fixture(disk,seed)
                process=await asyncio.create_subprocess_exec(sys.executable,str(ROOT/"scripts/my98-torrent.py"),"--config",str(config),"--root",str(root/"publisher"),"--isolated","--verbose","--timeout","20","publish",str(disk),stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
                stdout,stderr=await asyncio.wait_for(process.communicate("café\npublic compatibility test password \n".encode()),60)
                self.assertEqual(process.returncode,0,stderr.decode()+stdout.decode())
                self.assertIn(b"Username:",stdout)
                # getpass always prompts; this noninteractive public fixture uses
                # its documented stdin fallback, never a real secret.
                self.assertIn(b"Password:",stderr)
                payload=json.loads(stdout.decode().splitlines()[-1].split("Username: ")[-1])
                record=Record.from_json(payload["published"],key)
                await node.poll_once();await node.jobs[(key,record.sequence)]
                self.assertEqual(node.store.adopted(key)[0],record)
                self.assertEqual(node.catalog.descriptor(record.info_hash.hex())["state"],None)
                journal=(root/"publisher/journals"/(key.hex()+".json")).read_text()
                self.assertNotIn("public compatibility test password",journal)
                self.assertNotIn(seed.hex(),journal)
            finally:
                if process and process.returncode is None:process.terminate();await process.wait()
                await node.stop()
                if runner:await runner.cleanup()
                engine.close();witness.close()

if __name__=="__main__":unittest.main()
