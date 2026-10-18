"""Install only owned service definitions; existing services are never restarted."""
import grp
import json
import os
from pathlib import Path
import platform
import pwd
import socket
import ssl
import subprocess
import time
from .deployment import SERVICE_USER,preflight,copy_certificates,nginx_command,reload_nginx
from .files import atomic_write
from .protocol import PublicationError
from .supervision import MARKER,service_files


def render(config,*,isolated=False,prefix="my98-torrent"):
    root=Path(config["root"])/"supervision"
    paths=[]
    for name,content in service_files(config,platform.system(),isolated=isolated,prefix=prefix).items():
        target=root/name;atomic_write(target,content.encode())
        target.chmod(0o755 if name.startswith(("rc.d/","launchers/")) else 0o644)
        paths.append(str(target))
    return {"supervisionFiles":paths,"startsServices":False}


def account(config):
    home=str(Path(config["root"])/"data")
    try:user=pwd.getpwnam(SERVICE_USER)
    except KeyError:
        try:grp.getgrnam(SERVICE_USER)
        except KeyError:pass
        else:raise PublicationError("The dedicated group name already belongs to another installation")
        if platform.system()=="Linux":
            arguments=["/usr/sbin/useradd","--system","--user-group","--no-create-home",
                "--home-dir",home,"--shell","/usr/sbin/nologin",SERVICE_USER]
        else:
            arguments=["/usr/sbin/useradd","-g","=uid","-L","daemon","-d",home,
                "-s","/sbin/nologin","-c","my98 torrent service",SERVICE_USER]
        subprocess.run(arguments,check=True)
        user=pwd.getpwnam(SERVICE_USER)
    if user.pw_dir!=home or grp.getgrgid(user.pw_gid).gr_name!=SERVICE_USER:
        raise PublicationError("Refusing to reuse an unrelated account")
    return user


def verify_runtime(config,user):
    runtime=Path(config["runtime"])
    if config["python"]!=str(runtime/"venv/bin/python") or config["nginx"]!=str(runtime/"release/bin/nginx"):
        raise PublicationError("Public services must use the installed private runtime")
    report=json.loads((runtime/"runtime-install.json").read_text())
    if report.get("nativeCompilation") is not False or not report["probe"]["bridge"]:
        raise PublicationError("The runtime has not passed offline installation validation")
    runtime.chmod(0o755)
    def drop():
        os.setgroups([]);os.setgid(user.pw_gid);os.setuid(user.pw_uid)
    subprocess.run([config["python"],"-c",
        "import libtorrent,my98_libtorrent,aiohttp,nacl;assert libtorrent.__version__.startswith('2.1.2');assert hasattr(my98_libtorrent,'put_signed')"],
        env={**os.environ,"LD_LIBRARY_PATH":str(runtime/"release/prefix/lib")+":"+
            str(runtime/"release/prefix/lib/python3.13/site-packages"),"PYTHONDONTWRITEBYTECODE":"1"},
        preexec_fn=drop,check=True)

    aquatic=config["node"].get("aquatic")
    if aquatic:
        subprocess.run([aquatic["binary"],"-p"],preexec_fn=drop,
            stdout=subprocess.DEVNULL,check=True)


def install(config):
    if os.geteuid()!=0:raise PublicationError("Installing dedicated users and supervision requires root")
    preflight(config)
    root=Path(config["root"]);system=platform.system()
    definitions=service_files(config,system)
    destinations={}
    for name,content in definitions.items():
        if name.startswith("launchers/"):target=root/"config"/Path(name).name
        else:target=Path("/etc/systemd/system" if system=="Linux" else "/etc")/name
        if target.exists() and MARKER not in target.read_text().splitlines()[:2]:
            raise PublicationError("Refusing to replace an unrelated service definition: "+str(target))
        destinations[target]=content
    user=account(config)
    for relative in [".","config","nginx","nginx/logs","nginx/tmp"]:
        path=root/relative;path.mkdir(parents=True,exist_ok=True)
        os.chown(path,0,user.pw_gid);path.chmod(0o750)
    for relative in ["data","nginx/tmp/client","nginx/tmp/proxy"]:
        path=root/relative;path.mkdir(parents=True,exist_ok=True)
        os.chown(path,user.pw_uid,user.pw_gid);path.chmod(0o700)
    for file in (root/"config").iterdir():
        if file.is_file():os.chown(file,0,user.pw_gid)
    verify_runtime(config,user)
    certificate=copy_certificates(config)
    subprocess.run(nginx_command(config,"-t"),check=True)
    for target,content in destinations.items():
        atomic_write(target,content.encode())
        target.chmod(0o755 if system=="OpenBSD" else 0o644)
    if system=="Linux":subprocess.run(["systemctl","daemon-reload"],check=True)
    result={"installed":True,"active":False,"user":SERVICE_USER,"certificate":certificate,
        "definitions":[str(path) for path in destinations]}
    atomic_write(root/"installation-report.json",json.dumps(result,indent=2).encode())
    return result


def service_names(system):
    return ["my98-torrent","my98-torrent-https","my98-torrent-certificates.service","my98-torrent-certificates.timer"] if system=="Linux" else [
        "my98_torrent","my98_torrent_https","my98_torrent_certificates"]


def stop_owned(config):
    system=platform.system()
    names=service_names(system)
    for name in reversed(names):
        path=Path("/etc/systemd/system")/(name if name.endswith((".service",".timer")) else name+".service") if system=="Linux" else Path("/etc/rc.d")/name
        if not path.exists() or MARKER not in path.read_text().splitlines()[:2]:
            raise PublicationError("Refusing to control an unowned service definition")
    for name in reversed(names):
        subprocess.run(["systemctl","stop",name] if system=="Linux" else ["rcctl","stop",name],check=False)


def health(config):
    context=ssl.create_default_context()
    with socket.create_connection(("127.0.0.1",config["httpsPort"]),timeout=3) as raw:
        with context.wrap_socket(raw,server_hostname=config["hostname"]) as connection:
            key=config["node"]["follow"][0]
            connection.sendall(("GET /v1/names/"+key+" HTTP/1.1\r\nHost: "+config["hostname"]+
                "\r\nConnection: close\r\n\r\n").encode())
            response=connection.recv(4096)
            if not response.startswith((b"HTTP/1.1 200",b"HTTP/1.1 404")):
                raise PublicationError("The new HTTPS API did not return a name response")


def activate(config):
    if os.geteuid()!=0:raise PublicationError("Activation requires root")
    system=platform.system();names=service_names(system);preflight(config)
    if not (Path(config["root"])/"installation-report.json").exists():
        raise PublicationError("Install the reviewed dedicated definitions first")
    root=Path(config["root"])
    if json.loads((root/"config/node.json").read_text())!=config["node"]:
        raise PublicationError("The installed node configuration differs from the reviewed deployment")
    for name,content in service_files(config,system).items():
        target=root/"config"/Path(name).name if name.startswith("launchers/") else Path(
            "/etc/systemd/system" if system=="Linux" else "/etc")/name
        if target.is_symlink() or not target.is_file() or target.read_text()!=content:
            raise PublicationError("The installed supervision differs from the reviewed deployment: "+str(target))
    try:
        for name in names[:2]:
            subprocess.run(["systemctl","start",name] if system=="Linux" else ["rcctl","start",name],check=True)
        for attempt in range(60):
            try:health(config);break
            except (OSError,ValueError):
                if attempt==59:raise
                time.sleep(.5)
        reload_nginx(config)
        if system=="Linux":
            subprocess.run(["systemctl","start",names[-1]],check=True)
            subprocess.run(["systemctl","enable",names[0],names[1],names[-1]],check=True)
        else:
            subprocess.run(["rcctl","start",names[2]],check=True)
            subprocess.run(["rcctl","enable",*names],check=True)
        return {"active":True,"services":names,"httpsPort":config["httpsPort"]}
    except BaseException:
        stop_owned(config)
        enabled=[names[0],names[1],names[-1]] if system=="Linux" else names
        subprocess.run(["systemctl","disable",*enabled] if system=="Linux" else ["rcctl","disable",*enabled],check=False)
        raise
