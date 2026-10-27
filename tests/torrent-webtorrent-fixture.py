"""Explicit Linux-only libtorrent/Aquatic fixture; all control stays on loopback."""
import argparse
import asyncio
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import sys
import subprocess
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/"src/torrent"))
from aiohttp import web
from my98_torrent.engine import Engine
from my98_torrent.metadata import create
from my98_torrent.tracker import Aquatic
from my98_torrent.files import atomic_write


def unused_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1",0));return probe.getsockname()[1]


async def main(args):
    args.root.mkdir(parents=True,exist_ok=True)
    port=args.tracker_port or unused_port()
    tracker=Aquatic(args.root/"tracker",{"binary":str(args.aquatic.resolve()),
        "listen":[{"host":host,"port":port} for host in (["127.0.0.1","::1"] if args.nginx else ["127.0.0.1"])]})
    data=bytes(range(251))*2500
    content=args.root/"content";content.mkdir(exist_ok=True)
    path=content/"disk.my98";atomic_write(path,data)
    ih,metadata=create(path,"disk")
    engine=Engine(listen="127.0.0.1:0",isolated=True,settings={
        "enable_incoming_tcp":False,"enable_outgoing_tcp":False,
        "enable_incoming_utp":False,"enable_outgoing_utp":False,
        **({"upload_rate_limit":131072} if args.webseed else {})})
    runner=None;stop_task=None;nginx=None;nginx_log=None
    try:
        await tracker.start()
        handle=engine.add(ih,content,metadata=metadata,kind="disk",trackers=[f"ws://127.0.0.1:{port}"])
        await engine.complete(handle,20)
        info={"infoHash":ih,"size":len(data),"sha256":hashlib.sha256(data).hexdigest(),
            "trackerPort":port,"libtorrent":engine.session.get_settings().get("user_agent"),
            "conventionalPeerTransportsEnabled":False,"webseedConfigured":args.webseed}
        async def describe(request):return web.json_response(info)
        async def info_dictionary(request):
            import libtorrent as lt
            if request.match_info["ih"]!=ih:raise web.HTTPNotFound()
            return web.Response(body=lt.bencode(lt.bdecode(metadata)[b"info"]),content_type="application/octet-stream")
        async def health(request):return web.json_response({"ready":True})
        app=web.Application()
        app.router.add_get("/fixture.json",describe)
        app.router.add_get("/v2/info/{ih}",info_dictionary)
        app.router.add_get("/health",health)
        runner=web.AppRunner(app);await runner.setup()
        site=web.TCPSite(runner,"127.0.0.1",args.http_port);await site.start()
        info["httpPort"]=site._server.sockets[0].getsockname()[1]
        if args.nginx:
            root=Path(__file__).resolve().parent.parent
            spec=importlib.util.spec_from_file_location("https_fixture",root/"tests/torrent-https.test.py")
            helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
            source=helper.certificates(args.root/"certificates")
            config=helper.configuration({"hostname":"fixture.my98.invalid","root":str(args.root/"https"),
                "runtime":str(args.root),"python":sys.executable,"nginx":str(args.nginx),
                "certificateSource":str(source/"cert.pem"),"keySource":str(source/"key.pem"),
                "trustCA":str(args.root/"certificates/ca.pem"),"httpsPort":args.https_port or unused_port(),
                "node":{"follow":["01"*32],"listen":"127.0.0.1:0,[::1]:0",
                    "api":{"host":"127.0.0.1","port":info["httpPort"]},
                    "aquatic":{"binary":str(args.aquatic),"listen":[{"host":host,"port":port} for host in ["127.0.0.1","::1"]]}}},isolated=True)
            helper.commands.prepare(config,True);helper.copy_certificates(config)
            if args.webseed:
                public=Path(config["root"])/"data/webseed"/ih;public.mkdir(parents=True)
                os.link(path,public/"disk.my98")
                # Comparable fixture bandwidth makes both normal sources
                # observable without introducing application scheduling policy.
                conf=Path(config["root"])/"config/nginx.conf"
                conf.write_text(conf.read_text().replace("location /content/ {", "location /content/ {\nlimit_rate 16k;"))
            subprocess.run(helper.nginx_command(config,"-t"),check=True)
            nginx_log=(args.root/"https-process.log").open("ab")
            nginx=subprocess.Popen(helper.nginx_command(config,"-g","daemon off;"),stdout=nginx_log,stderr=nginx_log)
            for attempt in range(100):
                if nginx.poll() is not None:raise RuntimeError("Private WSS Nginx exited")
                try:await helper.request(config,"/health");break
                except OSError:
                    if attempt==99:raise
                    await asyncio.sleep(.05)
            info.update({"httpsPort":config["httpsPort"],"trackerTLS":True,"fixtureCertificate":True})
        atomic_write(args.root/"ready.json",json.dumps(info,indent=2).encode())
        print(json.dumps(info),flush=True)
        stop=asyncio.Event();loop=asyncio.get_running_loop()
        for sig in (signal.SIGTERM,signal.SIGINT):loop.add_signal_handler(sig,stop.set)
        stop_task=asyncio.create_task(stop.wait())
        done,_=await asyncio.wait([stop_task,tracker.failed],return_when=asyncio.FIRST_COMPLETED)
        if tracker.failed in done and not stop.is_set():raise RuntimeError(tracker.failed.result())
    finally:
        if stop_task:stop_task.cancel()
        if runner:await runner.cleanup()
        engine.close();await tracker.stop()
        if nginx and nginx.poll() is None:
            nginx.send_signal(signal.SIGQUIT)
            try:await asyncio.to_thread(nginx.wait,timeout=10)
            except subprocess.TimeoutExpired:nginx.kill();await asyncio.to_thread(nginx.wait)
        if nginx_log:nginx_log.close()
        (args.root/"ready.json").unlink(missing_ok=True)


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root",type=Path,required=True)
    parser.add_argument("--aquatic",type=Path,required=True)
    parser.add_argument("--http-port",type=int,default=0)
    parser.add_argument("--tracker-port",type=int,default=0)
    parser.add_argument("--nginx",type=Path)
    parser.add_argument("--https-port",type=int,default=0)
    parser.add_argument("--webseed",action="store_true")
    args=parser.parse_args()
    if args.webseed and not args.nginx:parser.error("The mixed-source fixture requires private HTTPS")
    asyncio.run(main(args))
