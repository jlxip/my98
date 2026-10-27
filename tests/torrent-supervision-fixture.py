"""Actual user-systemd lifecycle, or rc.d syntax before the root-only rc gate."""
import argparse
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import platform
import shlex
import shutil
import socket
import subprocess
import sys
import time
ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT/"src/torrent"))
from my98_torrent.deployment import configuration,copy_certificates
from my98_torrent.installation import render
spec=importlib.util.spec_from_file_location("https_fixture",ROOT/"tests/torrent-https.test.py")
https=importlib.util.module_from_spec(spec);spec.loader.exec_module(https)


async def main(args):
    args.root.mkdir(parents=True,exist_ok=True)
    source=https.certificates(args.root/"certificates")
    runtime=args.root/"runtime";runtime.mkdir()
    (runtime/"venv").symlink_to(args.native/"venv",target_is_directory=True)
    (runtime/"release").symlink_to(ROOT,target_is_directory=True)
    (runtime/"bin").mkdir()
    for name in ["my98-torrent","my98-torrent-services"]:
        launcher=runtime/"bin"/name
        launcher.write_text("#!/bin/sh\nexport LD_LIBRARY_PATH="+shlex.quote(str(args.native/"prefix/lib"))+
            "\nexec "+shlex.join([str(runtime/"venv/bin/python"),str(runtime/"release/scripts"/(name+".py"))])+' "$@"\n')
        launcher.chmod(0o755)
    state=args.root/"service"
    config=configuration({"hostname":"fixture.my98.invalid","root":str(state),
        "runtime":str(runtime),"python":str(runtime/"venv/bin/python"),"nginx":str(args.nginx),
        "certificateSource":str(source/"cert.pem"),"keySource":str(source/"key.pem"),
        "trustCA":str(args.root/"certificates/ca.pem"),"httpsPort":https.free_port(),
        "node":{"follow":["01"*32],"listen":"127.0.0.1:0,[::1]:0",
            "api":{"host":"127.0.0.1","port":https.free_port()}}},isolated=True)
    service_spec=importlib.util.spec_from_file_location("service_commands",ROOT/"scripts/my98-torrent-services.py")
    service=importlib.util.module_from_spec(service_spec);service_spec.loader.exec_module(service)
    service.prepare(config,True);copy_certificates(config)
    prefix="my98-torrent-fixture-"+str(time.time_ns())
    rendered=render(config,isolated=True,prefix=prefix)
    (args.root/"fixture.json").write_text(json.dumps({"prefix":prefix,"config":config,"rendered":rendered},indent=2))
    if platform.system()=="OpenBSD":
        scripts=list((state/"supervision/rc.d").iterdir())
        for path in scripts:subprocess.run(["/bin/ksh","-n",str(path)],check=True)
        if args.root_lifecycle:
            assert os.geteuid()==0,"The actual rc.subr lifecycle requires root"
            for path in (state/"supervision/launchers").iterdir():
                shutil.copy2(path,state/"config"/path.name)
            def control(role,action,check=True):
                name=prefix.replace("-","_")+("_"+role if role else "")
                return subprocess.run(["/bin/ksh",str(state/"supervision/rc.d"/name),action],check=check)
            async def ready():
                for attempt in range(200):
                    try:
                        if (await https.request(config,"/health"))[0]==200:return
                    except OSError:pass
                    await asyncio.sleep(.05)
                raise RuntimeError("Private rc.d HTTPS did not become ready")
            try:
                for role in ["","https","certificates"]:control(role,"start")
                await ready()
                checkpoint=state/"data/lifecycle.bin";checkpoint.write_bytes(b"persistent rc.d fixture")
                node_script=state/"supervision/rc.d"/prefix.replace("-","_")
                pattern=shlex.split(next(line[5:] for line in node_script.read_text().splitlines() if line.startswith("pexp=")))[0]
                before=subprocess.check_output(["pgrep","-f",pattern],text=True)
                control("https","reload");control("","restart");await ready()
                after=subprocess.check_output(["pgrep","-f",pattern],text=True)
                assert before!=after and checkpoint.read_bytes()==b"persistent rc.d fixture"
                result={"rcLifecycle":True,"rootLifecyclePending":False,"restartRetainedFiles":True,
                    "ownHTTPSReload":True,"certificateWatcher":True,"loopbackOnly":True,"prefix":prefix}
                (args.root/"result.json").write_text(json.dumps(result,indent=2));print(json.dumps(result),flush=True)
            finally:
                for role in ["certificates","https",""]:control(role,"stop",False)
            return
        result={"rcSyntax":True,"rootLifecyclePending":True}
        (args.root/"result.json").write_text(json.dumps(result,indent=2));print(json.dumps(result));return
    units=list((state/"supervision").glob("*.service"))+list((state/"supervision").glob("*.timer"))
    unit_directory=Path.home()/".config/systemd/user";unit_directory.mkdir(parents=True,exist_ok=True)
    links=[]
    try:
        for path in units:
            link=unit_directory/path.name
            if link.exists() or link.is_symlink():raise RuntimeError("Fixture unit name already exists")
            link.symlink_to(path);links.append(link)
        subprocess.run(["systemctl","--user","daemon-reload"],check=True)
        subprocess.run(["systemctl","--user","start",prefix+".service",prefix+"-https.service"],check=True)
        async def ready():
            for _ in range(200):
                try:
                    response=await https.request(config,"/health")
                    if response[0]==200:return
                except OSError:pass
                await asyncio.sleep(.05)
            raise RuntimeError("Supervised private API did not become ready")
        await ready()
        checkpoint=state/"data/lifecycle.bin";checkpoint.write_bytes(b"retained across service restart")
        before=subprocess.check_output(["systemctl","--user","show",prefix,"-p","MainPID","--value"],text=True).strip()
        subprocess.run(["systemctl","--user","start",prefix+"-certificates.service"],check=True)
        subprocess.run(["systemctl","--user","restart",prefix+".service"],check=True)
        await ready()
        after=subprocess.check_output(["systemctl","--user","show",prefix,"-p","MainPID","--value"],text=True).strip()
        assert before!=after and after!="0"
        assert checkpoint.read_bytes()==b"retained across service restart"
        result={"systemdLifecycle":True,"separateProcesses":True,"restartRetainedFiles":True,
            "certificateOneshot":True,"loopbackOnly":True,"prefix":prefix}
        (args.root/"result.json").write_text(json.dumps(result,indent=2));print(json.dumps(result),flush=True)
    finally:
        subprocess.run(["systemctl","--user","stop",*[path.name for path in units]],check=False)
        for link in links:
            if link.is_symlink() and link.resolve().is_relative_to(state/"supervision"):link.unlink()
        subprocess.run(["systemctl","--user","daemon-reload"],check=True)


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root",type=Path,required=True);parser.add_argument("--native",type=Path,required=True)
    parser.add_argument("--nginx",type=Path,required=True)
    parser.add_argument("--root-lifecycle",action="store_true")
    asyncio.run(main(parser.parse_args()))
