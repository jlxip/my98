#!/usr/bin/env python3
"""Prepare or maintain only the dedicated torrent services and their TLS copies."""
import argparse
import asyncio
import json
import logging
import os
from pathlib import Path
import signal
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/"src/torrent"))
from my98_torrent.deployment import configuration,preflight,nginx_configuration,copy_certificates,reload_nginx
from my98_torrent.files import atomic_write
from my98_torrent.protocol import PublicationError


def prepare(config,isolated):
    root=Path(config["root"]);marker=root/"installation.json"
    if root.exists() and any(root.iterdir()) and not marker.exists():
        raise PublicationError("Refusing to reuse an unmarked data directory")
    root.mkdir(parents=True,exist_ok=True,mode=0o750)
    expected={"kind":"my98-torrent-services/v2","hostname":config["hostname"],"runtime":config["runtime"]}
    if marker.exists() and json.loads(marker.read_text())!=expected:
        raise PublicationError("The data directory belongs to a different deployment")
    atomic_write(marker,json.dumps(expected,sort_keys=True).encode())
    for relative in ["config","data","nginx","nginx/logs","nginx/tmp","nginx/tmp/client","nginx/tmp/proxy"]:
        (root/relative).mkdir(parents=True,exist_ok=True,mode=0o750)
    atomic_write(root/"config/deployment.json",json.dumps(config,indent=2).encode())
    os.chmod(root/"config/deployment.json",0o600)
    atomic_write(root/"config/node.json",json.dumps(config["node"],indent=2).encode())
    os.chmod(root/"config/node.json",0o640)
    atomic_write(root/"config/nginx.conf",nginx_configuration(config,isolated=isolated).encode())
    # An internal static error-page target answers OPTIONS without a rewrite
    # module, a running API backend, or exposing any publication bytes.
    atomic_write(root/"config/cors-preflight",b"")
    os.chmod(root/"config/cors-preflight",0o640)
    return {"prepared":True,"root":str(root),"startsServices":False}


def renew(config):
    result=copy_certificates(config)
    if result["reloadRequired"]:result.update(reload_nginx(config))
    return result


async def watch(config):
    stop=asyncio.Event()
    loop=asyncio.get_running_loop()
    for number in [signal.SIGTERM,signal.SIGINT]:loop.add_signal_handler(number,stop.set)
    while not stop.is_set():
        try:logging.info(json.dumps(renew(config)))
        except (OSError,ValueError) as error:logging.error("%s",error)
        try:await asyncio.wait_for(stop.wait(),3600)
        except TimeoutError:pass


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config",type=Path,required=True)
    parser.add_argument("--isolated",action="store_true",help="Private fixtures with custom paths/ports only")
    parser.add_argument("--prefix",default="my98-torrent-v2",help="Private supervisor fixture name")
    parser.add_argument("command",choices=["prepare","render","install","activate","stop","preflight","copy-certificates","renew","reload","watch-certificates"])
    args=parser.parse_args()
    config=configuration(json.loads(args.config.read_text()),isolated=args.isolated)
    if not args.isolated and args.prefix!="my98-torrent-v2":raise PublicationError("Public service names are fixed")
    logging.basicConfig(level=logging.INFO,format="%(levelname)s %(message)s")
    if args.command=="watch-certificates":asyncio.run(watch(config));return
    if args.command=="prepare":result=prepare(config,args.isolated)
    elif args.command=="render":
        from my98_torrent.installation import render
        prepare(config,args.isolated);result=render(config,isolated=args.isolated,prefix=args.prefix)
    elif args.command=="install":
        if args.isolated:raise PublicationError("Use rendered definitions for isolated fixtures")
        from my98_torrent.installation import install
        preflight(config);prepare(config,False);result=install(config)
    elif args.command in ["activate","stop"]:
        if args.isolated:raise PublicationError("Control the rendered fixture definitions explicitly")
        from my98_torrent.installation import activate,stop_owned
        result=activate(config) if args.command=="activate" else stop_owned(config)
    elif args.command=="preflight":result=preflight(config)
    elif args.command=="copy-certificates":result=copy_certificates(config)
    elif args.command=="renew":result=renew(config)
    else:result=reload_nginx(config)
    print(json.dumps(result),flush=True)


if __name__=="__main__":
    try:main()
    except (OSError,ValueError) as error:
        print(str(error),file=sys.stderr);raise SystemExit(1)
