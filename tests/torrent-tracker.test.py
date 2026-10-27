import asyncio
from pathlib import Path
import socket
import sys
import tempfile
import textwrap
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/"src/torrent"))
from my98_torrent.tracker import Aquatic,configuration
from my98_torrent.protocol import PublicationError


def unused_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1",0));return listener.getsockname()[1]


class TrackerTest(unittest.IsolatedAsyncioTestCase):
    async def test_owned_children_reload_and_failure_are_observable(self):
        # The process fixture exercises lifecycle/signals, not Aquatic protocol
        # compatibility. The latter has a separate real Linux/WebRTC fixture.
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);binary=root/"process-fixture"
            binary.write_text("#!"+sys.executable+"\n"+textwrap.dedent("""
                import asyncio,pathlib,signal,sys,tomllib
                config_path=pathlib.Path(sys.argv[2])
                config=tomllib.loads(config_path.read_text())
                path=pathlib.Path(config['access_list']['path'])
                def reload():
                    config_path.with_suffix('.seen').write_bytes(path.read_bytes())
                async def health(reader,writer):
                    await reader.read(1024)
                    writer.write(b'HTTP/1.1 200 OK\\r\\nContent-Length: 0\\r\\n\\r\\n')
                    await writer.drain();writer.close();await writer.wait_closed()
                async def main():
                    reload()
                    asyncio.get_running_loop().add_signal_handler(signal.SIGUSR1,reload)
                    address=config['network']['address']
                    host,port=address.rsplit(':',1)
                    server=await asyncio.start_server(health,host,int(port))
                    async with server:await server.serve_forever()
                asyncio.run(main())
            """));binary.chmod(0o700)
            tracker=Aquatic(root/"tracker",{"binary":str(binary),"listen":[{"host":"127.0.0.1","port":unused_port()}]})
            children=[]
            try:
                with patch("my98_torrent.tracker.platform.system",return_value="Linux"):
                    await tracker.start()
                children=list(tracker.children)
                seen=root/"tracker/tracker-0.seen"
                self.assertEqual(seen.read_text(),"")
                self.assertEqual(tracker.access_list.read_text(),"")
                config=(root/"tracker/tracker-0.toml").read_text()
                self.assertIn('mode = "deny"',config)
                children[0].terminate()
                self.assertIn("exited",await asyncio.wait_for(tracker.failed,5))
            finally:await tracker.stop()
            self.assertTrue(all(child.returncode is not None for child in children))

    async def test_listener_conflict_does_not_start_any_child(self):
        with tempfile.TemporaryDirectory() as directory,socket.socket() as busy:
            busy.bind(("127.0.0.1",0));busy.listen()
            tracker=Aquatic(Path(directory)/"tracker",{"binary":sys.executable,
                "listen":[{"host":"127.0.0.1","port":busy.getsockname()[1]}]})
            with patch("my98_torrent.tracker.platform.system",return_value="Linux"):
                with self.assertRaises(OSError):await tracker.start()
            self.assertEqual(tracker.children,[])
            await tracker.stop()

    async def test_configuration_keeps_listeners_local(self):
        for host in ["0.0.0.0","::","example.com"]:
            with self.assertRaises(PublicationError):
                configuration({"binary":"/private/aquatic_ws","listen":[{"host":host,"port":3000}]})
        configuration({"binary":"/private/aquatic_ws","listen":[{"host":"127.0.0.1","port":3000},{"host":"::1","port":3000}]})
        tracker=Aquatic("/private/tracker",{"binary":"/private/aquatic_ws","listen":[{"host":"127.0.0.1","port":3000},{"host":"::1","port":3000}]})
        self.assertEqual(tracker.client_urls,("ws://127.0.0.1:3000","ws://[::1]:3000"))


if __name__=="__main__":unittest.main()
