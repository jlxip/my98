"""Mac publisher to an owned Linux fixture over private WireGuard, never public DHT."""
import argparse
import asyncio
from contextlib import suppress
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import shlex
import signal
import socket
import sys
import time
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/"src/torrent"))
from aiohttp import ClientSession,web
from nacl.signing import SigningKey
from my98_torrent.engine import Engine
from my98_torrent.publisher import Publisher
from my98_torrent.protocol import SALT
from my98_torrent.service import Node


def private_host(value):
    if not ipaddress.ip_address(value).is_private:raise ValueError("Private fixture addresses only")
    return value


async def node(args):
    host=private_host(args.bind)
    engine=Engine(listen=host+":0",isolated=True)
    witness=Engine(listen=host+":0",isolated=True)
    service=Node(args.root,[args.follow],engine=engine)
    runner=None
    try:
        port,witness_port=await asyncio.gather(engine.listening(),witness.listening())
        engine.add_node((host,witness_port));witness.add_node((host,port))
        await asyncio.gather(engine.dht_ready(),witness.dht_ready())
        await service.start()
        runner=web.AppRunner(service.app());await runner.setup()
        site=web.TCPSite(runner,"127.0.0.1",0);await site.start()
        print(json.dumps({"host":host,"peerPort":port,"witnessPort":witness_port,
            "apiPort":site._server.sockets[0].getsockname()[1]}),flush=True)
        stop=asyncio.Event();loop=asyncio.get_running_loop()
        for number in [signal.SIGTERM,signal.SIGINT]:loop.add_signal_handler(number,stop.set)
        await stop.wait()
    finally:
        if runner:await runner.cleanup()
        await service.stop();engine.close();witness.close()


async def ssh(host,*arguments):
    process=await asyncio.create_subprocess_exec("ssh","-o","BatchMode=yes","-o","ConnectTimeout=6",host,
        shlex.join(arguments),stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
    out,error=await process.communicate()
    if process.returncode:raise RuntimeError(error.decode())
    return out.decode()


def unused_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1",0));return probe.getsockname()[1]


async def client(args):
    # Frozen public compatibility fixture seed; no credentials from a user.
    seed=bytes.fromhex("c80e4484997cdd302848d0348e56e84e089089fe14e03dcf681fe9ce0ba76944")
    key=bytes(SigningKey(seed).verify_key)
    connection=(await ssh(args.ssh,"sh","-c",'printf "%s" "$SSH_CONNECTION"')).split()
    local=private_host(connection[0]);remote=private_host(connection[2])
    stamp=str(time.time_ns());args.root.mkdir(parents=True,exist_ok=True)
    output=args.root/("crosshost-"+stamp);output.mkdir()
    data=args.runtime+"/crosshost-"+stamp
    unit="my98-torrent-crosshost-fixture.service"
    remote_process=tunnel=None;publisher=engine=None
    log=(output/"ssh.log").open("wb")
    async def stop_remote():
        nonlocal remote_process,tunnel
        if tunnel:
            tunnel.terminate();await tunnel.wait();tunnel=None
        await ssh(args.ssh,"systemctl","--user","stop",unit)
        if remote_process:await remote_process.wait();remote_process=None
    async def start_remote():
        nonlocal remote_process,tunnel
        command=["systemd-run","--user","--quiet","--pipe","--wait","--collect","--unit="+unit,
            "--property=MemoryMax=512M","--property=MemorySwapMax=0","--property=CPUQuota=100%",
            "--property=Nice=19","--property=KillMode=mixed","--property=RuntimeMaxSec=600",
            args.runtime+"/venv/bin/python","-u",args.runtime+"/test-code/tests/torrent-crosshost.py",
            "node","--root",data,"--bind",remote,"--follow",key.hex()]
        remote_process=await asyncio.create_subprocess_exec("ssh","-o","BatchMode=yes",args.ssh,
            shlex.join(command),stdout=asyncio.subprocess.PIPE,stderr=log)
        ready=json.loads(await asyncio.wait_for(remote_process.stdout.readline(),45))
        api_port,peer_port=unused_port(),unused_port()
        tunnel=await asyncio.create_subprocess_exec("ssh","-o","BatchMode=yes","-o","ExitOnForwardFailure=yes","-N",
            "-L",f"127.0.0.1:{api_port}:127.0.0.1:{ready['apiPort']}",
            "-L",f"127.0.0.1:{peer_port}:{remote}:{ready['peerPort']}",args.ssh,stdout=log,stderr=log)
        url=f"http://127.0.0.1:{api_port}"
        async with ClientSession() as session:
            for _ in range(100):
                try:
                    async with session.get(url+"/v2/dht/"+key.hex()+"/"+SALT.hex()) as response:
                        if response.status in [200,404]:break
                except OSError:pass
                await asyncio.sleep(.05)
            else:raise RuntimeError("Fixture tunnel did not start")
        return ready,{"name":"nuc-fixture","api":url,"peer":["127.0.0.1",peer_port]}
    async def temporary_publisher(ready,endpoint,root):
        native=Engine(listen=local+":0",isolated=True)
        instance=Publisher(root,[endpoint],engine=native,isolated=True,lookup_timeout=30)
        native.add_node((remote,ready["peerPort"]));native.add_node((remote,ready["witnessPort"]))
        await instance.start();await native.dht_ready()
        return native,instance
    try:
        ready,endpoint=await start_remote()
        engine,publisher=await temporary_publisher(ready,endpoint,output/"publisher")
        journal=await publisher.prepare(seed,"publish",disk=args.disk)
        candidate=journal["record"];seed=None
        print("prepared",flush=True)
        copied=await publisher.transfer(journal,60)
        print("copied to one Linux seedbox",flush=True)
        assert copied=="nuc-fixture"
        assert await publisher.current(key) is None,"Transfer changed the public name before commit"
        await publisher.stop();engine.close();publisher=engine=None
        engine,publisher=await temporary_publisher(ready,endpoint,output/"publisher")
        resumed=publisher.journal(key)
        assert resumed["record"]==candidate,"Retry replaced the candidate"
        print("resuming same candidate",flush=True)
        record=await publisher.publish(resumed,60)
        print("DHT commit read back",flush=True)
        await publisher.stop();engine.close();publisher=engine=None
        # The public endpoint only returns a signed name; it is not a copy ACK.
        # Copy confirmation above came exclusively from exact native peer bits.
        async with ClientSession() as session:
            for _ in range(160):
                async with session.get(endpoint["api"]+"/v2/dht/"+key.hex()+"/"+SALT.hex()) as response:
                    if response.status==200 and (await response.json())==record.as_json():break
                await asyncio.sleep(.5)
            else:raise RuntimeError("Follower did not persist the committed public record")
        print("restarting Linux follower",flush=True)
        await stop_remote()
        ready,endpoint=await start_remote()
        engine,publisher=await temporary_publisher(ready,endpoint,output/"recovered")
        observed=await engine.resolve(key,30)
        assert observed==record,"Restart did not reannounce the accepted signature without a private key"
        description=await publisher.existing(record)
        path=publisher.catalog.path(description["disk"],"disk")
        expected=hashlib.sha256(args.disk.read_bytes()).hexdigest()
        assert hashlib.sha256(path.read_bytes()).hexdigest()==expected
        journal_text=(output/"publisher/journals"/(key.hex()+".json")).read_text()
        assert "public compatibility password" not in journal_text
        assert "c80e4484997cdd302848d0348e56e84e089089fe14e03dcf681fe9ce0ba76944" not in journal_text
        result={"macToLinux":True,"singleNodeComplete":True,"cutBeforeCommitPreservedName":True,
            "retrySameCandidate":True,"publisherClosed":True,"nodeRestart":True,
            "reannounceWithoutPrivateKey":True,"recoveredSha256":expected,"bytes":path.stat().st_size,
            "remoteData":data,"privateNetworkOnly":True}
        (output/"result.json").write_text(json.dumps(result,indent=2)+"\n")
        print(json.dumps(result),flush=True)
    finally:
        if publisher:await publisher.stop()
        if engine:engine.close()
        with suppress(Exception):await stop_remote()
        log.close()


def main():
    parser=argparse.ArgumentParser(description=__doc__);subs=parser.add_subparsers(dest="mode",required=True)
    remote=subs.add_parser("node");remote.add_argument("--root",type=Path,required=True)
    remote.add_argument("--bind",required=True);remote.add_argument("--follow",required=True)
    local=subs.add_parser("client");local.add_argument("--root",type=Path,required=True)
    local.add_argument("--ssh",required=True);local.add_argument("--runtime",required=True)
    local.add_argument("--disk",type=Path,required=True)
    args=parser.parse_args();asyncio.run(node(args) if args.mode=="node" else client(args))


if __name__=="__main__":main()
