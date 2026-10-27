"""Disposable encrypted publication, private seedbox and unrelated DHT resolver."""
import argparse
import asyncio
import json
import importlib.util
import subprocess
from urllib.parse import urlsplit
from pathlib import Path
import signal
import sys
sys.path[:0]=[str(Path(__file__).resolve().parent.parent/"src/torrent"),str(Path(__file__).resolve().parent.parent/"scripts")]
from aiohttp import web
from identity import derive_seed
from nacl.signing import SigningKey
from my98_torrent.engine import Engine
from my98_torrent.service import Node
from my98_torrent.publisher import Publisher
from my98_torrent.protocol import Locations

async def main(args):
    # Public fixture credentials, identical to the Rust compat test vector.
    seed=derive_seed("disk fixtures","public compatibility password","main")
    key=bytes(SigningKey(seed).verify_key)
    engines=[Engine(listen="127.0.0.1:0",isolated=True) for _ in range(4)]
    seedbox=Node(args.root/"seedbox",[key],engine=engines[1],poll_seconds=3600)
    broker=Node(args.root/"broker",[],engine=engines[2],poll_seconds=3600)
    runners=[];publisher=None;paths=[];nginx=None;nginx_log=None
    async def serve(node):
        app=node.app()
        @web.middleware
        async def cors(request,handler):
            paths.append(request.path)
            if ".torrent" in request.path:raise RuntimeError("Unexpected torrent-file request")
            response=web.Response(status=204) if request.method=="OPTIONS" else await handler(request)
            response.headers.update({"Access-Control-Allow-Origin":"*","Cross-Origin-Resource-Policy":"cross-origin",
                "Access-Control-Expose-Headers":"Content-Length, Content-Range, Accept-Ranges",
                "Access-Control-Allow-Methods":"GET, HEAD, OPTIONS","Access-Control-Allow-Headers":"Range, Cache-Control, User-Agent"})
            return response
        app.middlewares.append(cors)
        if node is seedbox:app.router.add_static("/content",node.catalog.public)
        runner=web.AppRunner(app);await runner.setup();runners.append(runner)
        site=web.TCPSite(runner,"127.0.0.1",0);await site.start()
        return "http://127.0.0.1:"+str(site._server.sockets[0].getsockname()[1])
    try:
        ports=await asyncio.gather(*(engine.listening() for engine in engines))
        for engine in engines:
            for port in ports:engine.add_node(("127.0.0.1",port))
        await asyncio.gather(*(engine.dht_ready() for engine in engines))
        await seedbox.start();await broker.start()
        origin=await serve(seedbox);resolver=await serve(broker)
        public_origin=origin
        if args.nginx:
            spec=importlib.util.spec_from_file_location("https_fixture",Path(__file__).with_name("torrent-https.test.py"))
            helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
            source=helper.certificates(args.root/"certificates")
            config=helper.configuration({"hostname":"fixture.my98.invalid","root":str(args.root/"https"),
                "runtime":str(args.root),"python":sys.executable,"nginx":str(args.nginx),
                "certificateSource":str(source/"cert.pem"),"keySource":str(source/"key.pem"),
                "trustCA":str(args.root/"certificates/ca.pem"),"httpsPort":helper.free_port(),
                "node":{"follow":[key.hex()],"listen":"127.0.0.1:0,[::1]:0",
                    "api":{"host":"127.0.0.1","port":urlsplit(origin).port}}},isolated=True)
            helper.commands.prepare(config,True);helper.copy_certificates(config)
            (Path(config["root"])/"data/webseed").symlink_to(seedbox.catalog.public,target_is_directory=True)
            subprocess.run(helper.nginx_command(config,"-t"),check=True)
            nginx_log=(args.root/"nginx.log").open("ab")
            nginx=subprocess.Popen(helper.nginx_command(config,"-g","daemon off;"),stdout=nginx_log,stderr=nginx_log)
            for _ in range(100):
                if nginx.poll() is not None:raise RuntimeError("Private HTTPS exited")
                try:await helper.request(config,"/health");break
                except OSError:await asyncio.sleep(.05)
            else:raise RuntimeError("Private HTTPS did not become ready")
            public_origin="https://127.0.0.1:"+str(config["httpsPort"])
        publisher=Publisher(args.root/"publisher",[{"name":"foreign","api":origin,"peer":["127.0.0.1",ports[1]]}],engine=engines[0])
        await publisher.start()
        journal=await publisher.prepare(seed,"publish",disk=args.disk)
        if args.nginx:
            # The publisher uses the private loopback admission socket; its public
            # HTTPS origin is signed with the same disposable fixture identity.
            locations=Locations.from_json(journal["locations"])
            journal["locations"]=Locations.sign(seed,locations.sequence,[public_origin]).as_json()
        record=await publisher.publish(journal,timeout=30)
        await seedbox.poll_once();await seedbox.jobs[(key,record.sequence)]
        await publisher.stop();publisher=None
        seed=None;engines[0].close()
        print(json.dumps({"resolver":resolver,"seedbox":public_origin,"publicKey":key.hex(),"descriptor":record.info_hash.hex(),"fixtureCertificate":bool(args.nginx)}),flush=True)
        stop=asyncio.Event()
        for name in (signal.SIGTERM,signal.SIGINT):asyncio.get_running_loop().add_signal_handler(name,stop.set)
        await stop.wait()
        assert not broker.handles and not broker.store.followed() and not list(broker.catalog.metainfo.iterdir())
        (args.root/"result.json").write_text(json.dumps({"resolverStoresNoTorrents":True,"unknownIdentityResolved":True,"noTorrentFilesRequested":not any(".torrent" in path for path in paths),"paths":paths},indent=2))
    finally:
        if publisher:await publisher.stop()
        await seedbox.stop();await broker.stop()
        for runner in runners:await runner.cleanup()
        for engine in engines:engine.close()
        if nginx:
            nginx.terminate()
            try:await asyncio.to_thread(nginx.wait,timeout=10)
            except subprocess.TimeoutExpired:nginx.kill();await asyncio.to_thread(nginx.wait)
        if nginx_log:nginx_log.close()

if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument("--root",type=Path,required=True);parser.add_argument("--disk",type=Path,required=True)
    parser.add_argument("--nginx",type=Path)
    asyncio.run(main(parser.parse_args()))
