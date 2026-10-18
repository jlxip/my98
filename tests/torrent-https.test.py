"""Real private Nginx/TLS/ranges/proxy/renewal, without touching public listeners."""
import asyncio
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import unittest
from aiohttp import ClientSession,web
ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT/"src/torrent"))
from my98_torrent.deployment import configuration,copy_certificates,nginx_command,reload_nginx,preflight
from my98_torrent.protocol import PublicationError
spec=importlib.util.spec_from_file_location("service_commands",ROOT/"scripts/my98-torrent-services.py")
commands=importlib.util.module_from_spec(spec);spec.loader.exec_module(commands)


def command(*args):
    result=subprocess.run(["/usr/bin/openssl",*map(str,args)],capture_output=True)
    if result.returncode:raise RuntimeError(result.stderr.decode())


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1",0));return probe.getsockname()[1]


def certificates(root):
    root.mkdir()
    config=root/"ca.conf"
    config.write_text("[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n"
        "[dn]\nCN=my98 isolated fixture CA\n[ca]\nbasicConstraints=critical,CA:true\n"
        "keyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n")
    command("req","-new","-x509","-newkey","rsa:2048","-nodes","-keyout",root/"ca.key",
        "-out",root/"ca.pem","-days","2","-config",config)
    extension=root/"leaf.conf"
    extension.write_text("basicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\n"
        "extendedKeyUsage=serverAuth\nsubjectAltName=DNS:fixture.my98.invalid\n"
        "subjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n")
    for index in [1,2]:
        target=root/str(index);target.mkdir()
        command("req","-new","-newkey","rsa:2048","-nodes","-keyout",target/"key.pem",
            "-out",target/"request.pem","-subj","/CN=fixture.my98.invalid")
        command("x509","-req","-in",target/"request.pem","-CA",root/"ca.pem","-CAkey",root/"ca.key",
            "-set_serial",index,"-out",target/"cert.pem","-days","2","-extfile",extension)
    source=root/"live";source.mkdir()
    (source/"cert.pem").symlink_to("../1/cert.pem")
    (source/"key.pem").symlink_to("../1/key.pem")
    return source


async def request(config,path,*,host="127.0.0.1",headers="",method="GET",body=b""):
    context=ssl.create_default_context(cafile=config["trustCA"])
    reader,writer=await asyncio.open_connection(host,config["httpsPort"],ssl=context,server_hostname=config["hostname"])
    try:
        certificate=writer.get_extra_info("ssl_object").getpeercert(binary_form=True)
        writer.write((method+" "+path+" HTTP/1.1\r\nHost: "+config["hostname"]+
            "\r\nConnection: close\r\n"+headers+("Content-Length: "+str(len(body))+"\r\n" if body else "")+"\r\n").encode()+body)
        await writer.drain();data=await asyncio.wait_for(reader.read(),10)
        head,content=data.split(b"\r\n\r\n",1)
        return int(head.split()[1]),head.lower(),content,hashlib.sha256(certificate).hexdigest()
    finally:writer.close();await writer.wait_closed()


class HTTPS(unittest.IsolatedAsyncioTestCase):
    async def test_owned_https_ranges_family_proxy_and_atomic_certificate_renewal(self):
        binary=Path(os.environ["MY98_NGINX_BINARY"])
        with tempfile.TemporaryDirectory(prefix="my98-https-") as temporary:
            root=Path(temporary);source=certificates(root/"source")
            state=root/"owned";nginx=None;runner=None;log=None
            app=web.Application()
            async def record(request):return web.json_response({"signed":"fixture"},headers={"Access-Control-Allow-Origin":"*"})
            async def metadata(request):return web.Response(body=b"torrent-fixture",headers={"Access-Control-Allow-Origin":"*"})
            async def candidate(request):return web.json_response({"admitted":True},status=202)
            async def websocket(request):
                stream=web.WebSocketResponse();await stream.prepare(request)
                family=request.transport.get_extra_info("socket").family
                async for item in stream:
                    await stream.send_json({"family":6 if family==socket.AF_INET6 else 4,"forwarded":request.headers.get("X-Forwarded-For")})
                return stream
            app.router.add_get("/v1/names/{key}",record);app.router.add_post("/v1/candidates",candidate)
            app.router.add_get("/v1/torrents/{ih}.torrent",metadata)
            app.router.add_get("/tracker",websocket)
            runner=web.AppRunner(app);await runner.setup()
            sites=[]
            for host in ["127.0.0.1","::1"]:
                site=web.TCPSite(runner,host,0);await site.start();sites.append(site)
            ports=[site._server.sockets[0].getsockname()[1] for site in sites]
            config=configuration({"hostname":"fixture.my98.invalid","root":str(state),
                "runtime":str(ROOT/"build/torrent-native"),"python":sys.executable,"nginx":str(binary),
                "certificateSource":str(source/"cert.pem"),"keySource":str(source/"key.pem"),
                "trustCA":str(root/"source/ca.pem"),"httpsPort":free_port(),
                "node":{"follow":["01"*32],"listen":"127.0.0.1:0,[::1]:0",
                    "api":{"host":"127.0.0.1","port":free_port()},
                    "aquatic":{"binary":str(binary),"listen":[{"host":"127.0.0.1","port":ports[0]},{"host":"::1","port":ports[1]}]}}},isolated=True)
            try:
                # Occupied requested ports fail before a new process is created.
                with socket.socket() as probe:
                    probe.bind(("127.0.0.1",config["httpsPort"]));probe.listen()
                    with self.assertRaises(OSError):preflight(config)
                commands.prepare(config,True)
                first=copy_certificates(config);self.assertTrue(first["changed"])
                # Backends deliberately use a separate port from the preflight API.
                config["node"]["api"]["port"]=ports[0]
                from my98_torrent.deployment import nginx_configuration
                (state/"config/nginx.conf").write_text(nginx_configuration(config,isolated=True))
                public=state/"data/webseed"/("ab"*20);public.mkdir(parents=True)
                data=bytes(range(251))*3000;(public/"disk.my98").write_bytes(data)
                staging=state/"data/staging";staging.mkdir();(staging/"partial").write_bytes(b"NEVER EXPOSE PARTIAL")
                log=(root/"nginx.log").open("wb")
                nginx=await asyncio.create_subprocess_exec(*nginx_command(config,"-g","daemon off;"),stdout=log,stderr=log)
                for _ in range(100):
                    if nginx.returncode is not None:raise RuntimeError((root/"nginx.log").read_text())
                    try:response=await request(config,"/content/"+("ab"*20)+"/disk.my98",headers="Range: bytes=100-199\r\n");break
                    except (OSError,ssl.SSLError):await asyncio.sleep(.05)
                else:raise RuntimeError("Own HTTPS fixture did not start")
                status,headers,content,fingerprint=response
                self.assertEqual(status,206);self.assertEqual(content,data[100:200])
                self.assertIn(b"access-control-allow-origin: *",headers)
                self.assertIn(b"cross-origin-resource-policy: cross-origin",headers)
                self.assertIn(b"content-range: bytes 100-199/"+str(len(data)).encode(),headers)
                status,headers,body,_=await request(config,"/content/"+("ab"*20)+"/disk.my98",method="OPTIONS",
                    headers="Origin: https://reader.invalid\r\nAccess-Control-Request-Method: GET\r\nAccess-Control-Request-Headers: cache-control,range,user-agent\r\n")
                self.assertEqual(status,204);self.assertEqual(body,b"")
                self.assertIn(b"access-control-allow-headers: range, cache-control, user-agent",headers)
                self.assertIn(b"access-control-allow-methods: get, head, options",headers)
                status,_,_,_=await request(config,"/content/"+("ab"*20)+"/disk.my98",method="POST",body=b"no")
                self.assertEqual(status,403)
                status,_,_,_=await request(config,"/__my98_preflight");self.assertEqual(status,404)
                status,headers,body,_=await request(config,"/v1/names/"+("01"*32))
                self.assertEqual(status,200);self.assertEqual(json.loads(body),{"signed":"fixture"})
                self.assertEqual(headers.count(b"access-control-allow-origin:"),1)
                status,headers,body,_=await request(config,"/v1/torrents/"+("ab"*20)+".torrent")
                self.assertEqual(status,200);self.assertEqual(body,b"torrent-fixture")
                self.assertEqual(headers.count(b"access-control-allow-origin:"),1)
                status,_,body,_=await request(config,"/v1/candidates",method="POST",body=b"{}")
                self.assertEqual(status,202);self.assertEqual(json.loads(body),{"admitted":True})
                for path in ["/data/staging/partial","/content/../staging/partial","/config/node.json","/tls/current/key.pem"]:
                    status,_,body,_=await request(config,path);self.assertNotEqual(status,200);self.assertNotIn(b"NEVER EXPOSE",body)
                context=ssl.create_default_context(cafile=config["trustCA"])
                async with ClientSession() as client:
                    for host,family in [("127.0.0.1",4),("[::1]",6)]:
                        async with client.ws_connect("wss://"+host+":"+str(config["httpsPort"])+"/tracker",
                                ssl=context,server_hostname=config["hostname"]) as stream:
                            await stream.send_str("probe")
                            result=await stream.receive_json()
                            self.assertEqual(result["family"],family)
                            self.assertEqual(result["forwarded"],"127.0.0.1" if family==4 else "::1")
                reload_nginx(config)
                self.assertFalse(copy_certificates(config)["reloadRequired"])
                pidfile=state/"nginx/nginx.pid";original=pidfile.read_text()
                dummy=subprocess.Popen([sys.executable,"-c","import time;time.sleep(30)"])
                try:
                    pidfile.write_text(str(dummy.pid))
                    with self.assertRaisesRegex(PublicationError,"does not belong"):reload_nginx(config)
                    self.assertIsNone(dummy.poll(),"An unrelated process was signalled")
                finally:
                    pidfile.write_text(original);dummy.terminate();dummy.wait()
                # Certbot-style live symlinks change independently. An unmatched
                # pair is rejected without changing the previously selected copy.
                previous=(state/"tls/current").readlink()
                (source/"cert.pem").unlink();(source/"cert.pem").symlink_to("../2/cert.pem")
                with self.assertRaises(PublicationError):copy_certificates(config)
                self.assertEqual((state/"tls/current").readlink(),previous)
                self.assertEqual((await request(config,"/v1/names/test"))[3],fingerprint)
                (source/"key.pem").unlink();(source/"key.pem").symlink_to("../2/key.pem")
                second=copy_certificates(config);self.assertTrue(second["changed"]);reload_nginx(config)
                for _ in range(100):
                    replacement=(await request(config,"/v1/names/test"))[3]
                    if replacement!=fingerprint:break
                    await asyncio.sleep(.05)
                self.assertNotEqual(replacement,fingerprint)
                self.assertEqual(len(list((state/"tls/copies").iterdir())),2)
                self.assertEqual((root/"source/1/cert.pem").read_bytes(),(state/"tls/copies"/first["certificateSha256"]/"cert.pem").read_bytes())
                result={"httpsRanges":True,"singleCORSOrigin":True,"privatePathsRejected":True,"apiAdmissionOnly":True,
                    "wssIPv4IPv6":True,"unrelatedPidRejected":True,"atomicTLSRenewal":True,"liveSymlinksPreserved":True}
                output=Path(os.environ.get("MY98_HTTPS_REPORT",str(root/"result.json")))
                output.write_text(json.dumps(result,indent=2)+"\n");print(json.dumps(result),flush=True)
            finally:
                if nginx and nginx.returncode is None:nginx.send_signal(signal.SIGQUIT);await asyncio.wait_for(nginx.wait(),15)
                if log:log.close()
                if runner:await runner.cleanup()


if __name__=="__main__":unittest.main()
