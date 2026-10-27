#!/usr/bin/env python3
"""Publish encrypted my98 disks and follow signed BEP46 publications."""
import argparse
import asyncio
import fcntl
import getpass
import json
import logging
import os
from pathlib import Path
import signal
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/"src/torrent"))


def credentials(machine):
    from identity import derive_seed
    username=input("Username: ")
    password=getpass.getpass("Password: ")
    try:return derive_seed(username,password,machine)
    finally:password=None


def parser():
    result=argparse.ArgumentParser(description=__doc__)
    result.add_argument("--config",type=Path)
    result.add_argument("--verbose",action="store_true")
    result.add_argument("--root",type=Path,help="Private publisher cache (never an existing service data directory)")
    result.add_argument("--machine",default="main")
    result.add_argument("--isolated",action="store_true",help="Loopback fixtures only; disables public DHT bootstraps")
    result.add_argument("--timeout",type=int,default=3600,help="Seconds to wait for a complete seedbox copy")
    commands=result.add_subparsers(dest="command",required=True)
    commands.add_parser("identity")
    commands.add_parser("locations")
    status=commands.add_parser("status");status.add_argument("public_key")
    publish=commands.add_parser("publish");publish.add_argument("disk",type=Path);publish.add_argument("--state",type=Path);publish.add_argument("--profile",type=Path)
    state=commands.add_parser("state");state.add_argument("state",type=Path);state.add_argument("--clear-profile",action="store_true")
    state=commands.add_parser("clear-state");state.add_argument("--clear-profile",action="store_true")
    profile=commands.add_parser("profile");profile.add_argument("profile",type=Path)
    commands.add_parser("clear-profile");commands.add_parser("resume");commands.add_parser("serve")
    return result


async def serve(config,*,isolated=False):
    from aiohttp import web
    from my98_torrent.engine import Engine
    from my98_torrent.service import Node
    if "data" not in config:raise ValueError("Service configuration requires its own data directory")
    data=Path(config["data"]).resolve();data.mkdir(parents=True,exist_ok=True,mode=0o700)
    service_lock=(data/"service.lock").open("a")
    try:fcntl.flock(service_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:
        service_lock.close();raise ValueError("Another service is using this data directory")
    tracker=None
    if "aquatic" in config:
        from my98_torrent.tracker import Aquatic
        tracker=Aquatic(data/"tracker",config["aquatic"])
    engine=Engine(listen=config.get("listen","0.0.0.0:51414,[::]:51414"),isolated=isolated,
        webrtc_port=config.get("webrtcPort",0))
    trackers=config.get("trackers",[] if isolated else ["wss://nuc.jlxip.net:8445/tracker","wss://oregon.jlxip.net:8445/tracker"])
    node=Node(data,config.get("follow",[]),engine=engine,trackers=trackers,webseeds=config.get("webseeds",[]),tracker=tracker)
    runner=None;stop_task=None
    try:
        await node.start();runner=web.AppRunner(node.app());await runner.setup()
        await web.TCPSite(runner,config["api"]["host"],config["api"]["port"]).start()
        stop=asyncio.Event();loop=asyncio.get_running_loop()
        for sig in (signal.SIGINT,signal.SIGTERM):loop.add_signal_handler(sig,stop.set)
        stop_task=asyncio.create_task(stop.wait())
        if tracker:
            done,_=await asyncio.wait([stop_task,tracker.failed],return_when=asyncio.FIRST_COMPLETED)
            if tracker.failed in done and not stop.is_set():raise ValueError(tracker.failed.result())
        else:await stop_task
    finally:
        if stop_task:stop_task.cancel()
        if runner:await runner.cleanup()
        await node.stop()
        engine.close()
        service_lock.close()


async def run(args):
    from nacl.signing import SigningKey
    from my98_torrent.config import load
    from my98_torrent.publisher import Publisher
    from my98_torrent.protocol import PublicationError
    config=load(args.config)
    if args.command=="serve":
        if args.isolated:
            from my98_torrent.config import validate_isolated
            validate_isolated(config,service=True)
        await serve(config,isolated=args.isolated);return
    if args.command=="identity":
        seed=credentials(args.machine)
        try:print(json.dumps({"publicKey":bytes(SigningKey(seed).verify_key).hex()}))
        finally:seed=None
        return
    if not config.get("nodes"):raise PublicationError("Configure seedbox API and peer endpoints first")
    root=args.root or Path(config.get("publisherData",str(Path.home()/".local/share/my98/torrent-publisher-v2")))
    root.mkdir(parents=True,exist_ok=True,mode=0o700)
    with (root/"publisher.lock").open("a") as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise PublicationError("Another publisher is using this cache")
        if args.isolated:
            from my98_torrent.config import validate_isolated
            validate_isolated(config)
        publisher=Publisher(root,config["nodes"],trackers=config.get("trackers",[]),webseeds=config.get("webseeds",[]),isolated=args.isolated)
        try:
            await publisher.start()
            if args.command=="status":
                try:key=bytes.fromhex(args.public_key)
                except ValueError:raise PublicationError("Invalid public key")
                if len(key)!=32:raise PublicationError("Invalid public key")
                record=await publisher.current(key)
                journal=publisher.journal(key)
                print(json.dumps({"public":record.as_json() if record else None,"localCandidate":journal}))
                return
            seed=credentials(args.machine)
            try:
                key=bytes(SigningKey(seed).verify_key)
                if args.command=="locations":
                    record=await publisher.publish_locations(seed)
                    print(json.dumps({"locations":record.as_json()}));return
                if args.command=="resume":
                    journal=publisher.journal(key)
                    if journal is None:raise PublicationError("No candidate to resume for this identity")
                else:
                    journal=await publisher.prepare(seed,args.command,disk=getattr(args,"disk",None),state=getattr(args,"state",None),profile=getattr(args,"profile",None),clear_profile=getattr(args,"clear_profile",False))
            finally:seed=None
            last_progress=None
            def progress(handles,nodes):
                nonlocal last_progress
                import libtorrent as lt
                observed=[]
                for name,endpoints in nodes.items():
                    counts=[]
                    for handle in handles.values():
                        total=handle.torrent_file().num_pieces();have=0
                        for peer in handle.get_peer_info():
                            if tuple(peer.ip) in endpoints:
                                have=max(have,total if peer.flags & lt.peer_info.seed else sum(peer.pieces))
                        counts.append((have,total))
                    observed.append((name,sum(n for n,_ in counts),sum(n for _,n in counts)))
                if observed!=last_progress:
                    for name,have,total in observed:print(f"{name}: {have}/{total} pieces",file=sys.stderr)
                    last_progress=observed
            record=await publisher.publish(journal,timeout=args.timeout,progress=progress)
            print(json.dumps({"published":record.as_json()}))
        finally:await publisher.stop()


def main():
    args=parser().parse_args()
    if args.timeout<1:parser().error("Timeout must be positive")
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,format="%(levelname)s %(message)s")
    try:asyncio.run(run(args))
    except KeyboardInterrupt:
        print("Interrupted. Candidate and torrents retained; use resume.",file=sys.stderr);return 130
    except (OSError,ValueError,TimeoutError) as error:
        print(str(error),file=sys.stderr);return 1
    return 0


if __name__=="__main__":raise SystemExit(main())
