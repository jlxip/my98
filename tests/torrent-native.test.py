"""Isolated native DHT: never contacts public bootstraps or production services."""
import asyncio
from pathlib import Path
import sys
import socket
import unittest
from collections import defaultdict
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/"src/torrent"))
from my98_torrent.engine import Engine,check_listeners
from my98_torrent.protocol import Record, Conflict, PublicationError, SALT

class NativeTest(unittest.IsolatedAsyncioTestCase):
    async def test_fixed_webrtc_udp_conflicts_fail_without_fallback(self):
        for value in [True,-1,65536,"51415"]:
            with self.subTest(value=value),self.assertRaises(PublicationError):
                Engine(listen="127.0.0.1:0",isolated=True,webrtc_port=value)
        with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as busy:
            busy.bind(("127.0.0.1",0));port=busy.getsockname()[1]
            with self.assertRaises(OSError):
                check_listeners({"listen_interfaces":"127.0.0.1:0","webtorrent_ice_udp_port":port})
            with self.assertRaises(PublicationError):
                check_listeners({"listen_interfaces":"127.0.0.1:"+str(port),"webtorrent_ice_udp_port":port})
        check_listeners({"listen_interfaces":"127.0.0.1:0","webtorrent_ice_udp_port":port})

    async def test_slow_lookup_follower_keeps_only_verified_highest_but_publisher_requires_completion(self):
        first=Record.sign(bytes(range(32)),100,"12"*20)
        highest=Record.sign(bytes(range(32)),101,"34"*20)
        class Alert:
            def __init__(self,record):
                self.key=record.public_key;self.salt=SALT;self.seq=record.sequence
                self.item={b"ih":record.info_hash};self.signature=record.signature;self.authoritative=False
        engine=Engine.__new__(Engine)
        engine.locks=defaultdict(asyncio.Lock)
        engine.session=SimpleNamespace(dht_get_mutable_item=lambda *_:None)
        alerts=[Alert(highest),Alert(first)]
        async def incomplete(predicate,action,timeout):
            action()
            for alert in alerts:
                if predicate(alert):return alert
            raise TimeoutError()
        engine.wait=incomplete
        with patch("my98_torrent.engine.lt.dht_mutable_item_alert",Alert):
            with self.assertRaisesRegex(PublicationError,"authoritative"):
                await engine.resolve(first.public_key)
            self.assertEqual(await engine.resolve(first.public_key,require_authoritative=False),highest)
            invalid=Alert(highest);invalid.signature=bytes(64);alerts[:]=[invalid]
            self.assertIsNone(await engine.resolve(first.public_key,require_authoritative=False))
            conflict=Alert(Record.sign(bytes(range(32)),101,"56"*20))
            alerts[:]=[Alert(highest),conflict]
            with self.assertRaises(Conflict):
                await engine.resolve(first.public_key,require_authoritative=False)

    async def test_restart_reuses_time_wait_but_still_rejects_a_live_listener(self):
        with socket.socket() as listener:
            listener.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
            listener.bind(("127.0.0.1",0));listener.listen()
            port=listener.getsockname()[1]
            with socket.create_connection(("127.0.0.1",port)) as client:
                accepted,_=listener.accept();accepted.close()
                self.assertEqual(client.recv(1),b"")
            with self.assertRaises(OSError):Engine(listen="127.0.0.1:"+str(port),isolated=True)
        engine=Engine(listen="127.0.0.1:"+str(port),isolated=True)
        try:self.assertEqual(await engine.listening(),port)
        finally:engine.close()

    async def test_busy_tcp_or_udp_does_not_move_to_a_different_port(self):
        for kind in [socket.SOCK_STREAM,socket.SOCK_DGRAM]:
            with socket.socket(socket.AF_INET,kind) as busy:
                busy.bind(("127.0.0.1",0))
                if kind==socket.SOCK_STREAM:busy.listen()
                port=busy.getsockname()[1]
                with self.assertRaises(OSError):
                    Engine(listen="127.0.0.1:"+str(port),isolated=True)

    async def test_presigned_put_readback_reannounce_and_conflicts(self):
        nodes=[Engine(listen="127.0.0.1:0",isolated=True) for _ in range(3)]
        try:
            ports=await asyncio.gather(*(n.listening() for n in nodes))
            for n in nodes:
                for port in ports:n.add_node(("127.0.0.1",port))
            await asyncio.sleep(1)
            self.assertIsNone(await nodes[0].resolve(bytes(reversed(range(32))),2))
            first=Record.sign(bytes(range(32)),100,"12"*20)
            self.assertGreaterEqual(await nodes[0].put(first),1)
            received=await nodes[1].resolve(first.public_key,10)
            self.assertEqual(received,first)
            # Only public record fields cross to the second node; no signing seed.
            self.assertGreaterEqual(await nodes[1].put(received),1)
            self.assertEqual(await nodes[2].resolve(first.public_key,10),first)
            with self.assertRaises(Conflict):
                await nodes[2].put(Record.sign(bytes(range(32)),100,"34"*20))
            next_record=Record.sign(bytes(range(32)),101,"56"*20)
            await nodes[2].put(next_record)
            with self.assertRaises(Conflict):await nodes[0].put(first)
            self.assertEqual(await nodes[0].resolve(first.public_key,10),next_record)
        finally:
            for node in nodes:node.close()

if __name__=="__main__":unittest.main()
