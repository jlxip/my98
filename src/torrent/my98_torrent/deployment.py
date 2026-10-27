"""Owned HTTPS configuration and validated atomic TLS copies; no system updates."""
from contextlib import ExitStack
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import shlex
import signal
import socket
import ssl
import subprocess
import tempfile
from .files import atomic_write,sync_directory
from .protocol import PublicationError

SERVICE_USER="my98torrentv2"


def path_value(value):
    if type(value) is not str or not re.fullmatch(r"/[A-Za-z0-9_./+-]+",value):
        raise PublicationError("Deployment paths must be explicit absolute paths")
    return Path(os.path.abspath(value))


def configuration(value,*,isolated=False):
    if type(value) is not dict:raise PublicationError("Invalid deployment configuration")
    allowed={"hostname","root","runtime","python","nginx","certificateSource","keySource","trustCA","node","httpsPort"}
    if set(value)-allowed:raise PublicationError("Unknown deployment configuration field")
    value=dict(value)
    host=value.get("hostname")
    if type(host) is not str or not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?",host):
        raise PublicationError("Invalid TLS hostname")
    for key in ["root","runtime","python","nginx","certificateSource","keySource"]:
        value[key]=str(path_value(value.get(key)))
    if "trustCA" in value:value["trustCA"]=str(path_value(value["trustCA"]))
    if not isolated:
        if value["root"]!="/var/lib/my98-torrent-v2" or value["runtime"]!="/opt/my98-torrent-v2/runtime":
            raise PublicationError("Public deployment requires its dedicated runtime/data roots")
        if "trustCA" in value:raise PublicationError("Public TLS must use the system certificate trust store")
    if Path(value["root"]).is_symlink():raise PublicationError("The dedicated data root cannot be a symlink")
    port=value.setdefault("httpsPort",8445)
    if type(port) is not int or not 1024<=port<=65535 or (not isolated and port!=8445):
        raise PublicationError("Invalid dedicated HTTPS listener")
    node=value.get("node")
    if type(node) is not dict or not node.get("follow"):
        raise PublicationError("Configure followed public keys explicitly")
    expected_data=Path(value["root"])/"data"
    if "data" in node and Path(node["data"]).resolve()!=expected_data:
        raise PublicationError("Node data must use the dedicated data root")
    node=dict(node);node["data"]=str(expected_data)
    if not isolated:
        expected_rtc=51415 if node.get("aquatic") else 0
        if "webrtcPort" in node and node["webrtcPort"]!=expected_rtc:
            raise PublicationError("Public Linux WebRTC requires dedicated UDP port 51415")
        if expected_rtc:node["webrtcPort"]=expected_rtc
    api=node.get("api",{"host":"127.0.0.1","port":17598})
    if type(node.get("listen")) is not str:raise PublicationError("Configure the native listener explicitly")
    if type(api) is not dict:raise PublicationError("Invalid administrative listener")
    if api.get("host")!="127.0.0.1" or type(api.get("port")) is not int or not 1024<=api["port"]<=65535:
        raise PublicationError("The deployment API must use its own IPv4 loopback listener")
    node["api"]=api
    if not isolated and node.get("listen")!="0.0.0.0:51414,[::]:51414":
        raise PublicationError("Public torrents require dedicated TCP and UDP port 51414")
    value["node"]=node
    # Reuse the service's strict followed-key and trusted-source validation.
    from .config import load
    with tempfile.TemporaryDirectory() as directory:
        filename=Path(directory)/"node.json";filename.write_text(json.dumps(node));load(filename)
    return value


def preflight(config):
    """Probe every requested listener together; never choose a replacement port."""
    ports=[("0.0.0.0",config["httpsPort"],socket.SOCK_STREAM),
           ("::",config["httpsPort"],socket.SOCK_STREAM)]
    api=config["node"]["api"];ports.append((api["host"],api["port"],socket.SOCK_STREAM))
    for listener in config["node"].get("aquatic",{}).get("listen",[]):
        ports.append((listener["host"],listener["port"],socket.SOCK_STREAM))
    from .engine import check_listeners
    # Native engine performs the full BitTorrent TCP/UDP check as well.
    check_listeners({"listen_interfaces":config["node"]["listen"],"enable_dht":True,
        "webtorrent_ice_udp_port":config["node"].get("webrtcPort",0)})
    with ExitStack() as stack:
        for host,port,kind in ports:
            address=ipaddress.ip_address(host)
            probe=stack.enter_context(socket.socket(socket.AF_INET6 if address.version==6 else socket.AF_INET,kind))
            if address.version==6:probe.setsockopt(socket.IPPROTO_IPV6,socket.IPV6_V6ONLY,1)
            probe.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
            probe.bind((host,port))
            probe.listen(1)
    return {"listenersAvailable":True,"https":config["httpsPort"],"administration":"loopback"}


def nginx_configuration(config,*,isolated=False):
    root=Path(config["root"]);prefix=root/"nginx";node=config["node"];api=node["api"]
    user="" if isolated else "user "+SERVICE_USER+";\n"
    common=(
        "ssl_certificate "+str(root/"tls/current/cert.pem")+";\n"
        "ssl_certificate_key "+str(root/"tls/current/key.pem")+";\n"
        "ssl_protocols TLSv1.2 TLSv1.3;\nssl_session_tickets off;\n"
        "server_name "+config["hostname"]+";\n"
        'proxy_hide_header Access-Control-Allow-Origin;\n'
        'add_header Access-Control-Allow-Origin "*" always;\n'
        'add_header Access-Control-Expose-Headers "Content-Length, Content-Range, Accept-Ranges" always;\n'
        'add_header Access-Control-Allow-Methods "GET, HEAD, OPTIONS" always;\n'
        'add_header Access-Control-Allow-Headers "Range, Cache-Control, User-Agent" always;\n'
        'add_header Access-Control-Max-Age "86400" always;\n'
        'add_header Cross-Origin-Resource-Policy "cross-origin" always;\n'
        "client_max_body_size 64k;\n"
        "location /content/ {\n"
        "alias "+str(root/"data/webseed")+"/;\n"
        "limit_except GET OPTIONS { deny all; }\n"
        "error_page 405 =204 /__my98_preflight;\n}\n"
        "location = /__my98_preflight {\ninternal;\n"
        "alias "+str(root/"config/cors-preflight")+";\n}\n"
        "location /v2/dht/ {\nlimit_except GET { deny all; }\n"
        "proxy_pass http://127.0.0.1:"+str(api["port"])+";\n}\n"
        "location /v2/info/ {\nlimit_except GET { deny all; }\n"
        "proxy_pass http://127.0.0.1:"+str(api["port"])+";\n}\n"
        "location = /v2/candidates {\nlimit_except POST { deny all; }\n"
        "proxy_pass http://127.0.0.1:"+str(api["port"])+";\n}\n"
        "location = /health {\nlimit_except GET { deny all; }\n"
        "proxy_pass http://127.0.0.1:"+str(api["port"])+";\n}\n"
        "location / { deny all; }\n")
    trackers={str(ipaddress.ip_address(item["host"]).version):item for item in node.get("aquatic",{}).get("listen",[])}
    if trackers and set(trackers)!={"4","6"}:
        raise PublicationError("WSS deployment requires both IPv4 and IPv6 Aquatic listeners")
    servers=[]
    listeners=[("4","127.0.0.1"),("6","[::1]")] if isolated else [("4","0.0.0.0"),("6","[::]")]
    for family,host in listeners:
        tracker=""
        if trackers:
            item=trackers[family];address=item["host"] if family=="4" else "["+item["host"]+"]"
            tracker=("location = /tracker {\nproxy_http_version 1.1;\n"
                "proxy_set_header Upgrade $http_upgrade;\n"
                'proxy_set_header Connection "upgrade";\n'
                "proxy_set_header X-Forwarded-For $remote_addr;\n"
                "proxy_read_timeout 3600s;\nproxy_send_timeout 3600s;\nproxy_buffering off;\n"
                "proxy_pass http://"+address+":"+str(item["port"])+";\n}\n")
        servers.append("server {\nlisten "+host+":"+str(config["httpsPort"])+" ssl"+(" ipv6only=on" if family=="6" else "")+";\n"+common+tracker+"}\n")
    return (user+"worker_processes 1;\npid "+str(prefix/"nginx.pid")+";\n"
        "error_log "+str(prefix/"logs/error.log")+" warn;\n"
        "events { worker_connections 256; }\nhttp {\n"
        "default_type application/octet-stream;\nserver_tokens off;\nsendfile on;\n"
        "access_log "+str(prefix/"logs/access.log")+";\n"
        "client_body_temp_path "+str(prefix/"tmp/client")+";\n"
        "proxy_temp_path "+str(prefix/"tmp/proxy")+";\n"+"".join(servers)+"}\n")


def openssl(*arguments):
    result=subprocess.run(["/usr/bin/openssl",*map(str,arguments)],capture_output=True)
    if result.returncode:raise PublicationError("Certificate validation failed ("+str(arguments[0])+")")
    return result.stdout


def validate_pair(cert,key,hostname,trust=None):
    openssl("x509","-in",cert,"-noout","-checkend","3600")
    # The stdlib TLS verifier is portable to LibreSSL as well as OpenSSL.
    # An in-memory handshake checks the chain, hostname and matching private key
    # without any temporary listener or platform-specific X509 CLI flags.
    try:
        server_context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        server_context.minimum_version=ssl.TLSVersion.TLSv1_2
        server_context.load_cert_chain(cert,key)
        client_context=ssl.create_default_context(cafile=trust)
        incoming=[ssl.MemoryBIO(),ssl.MemoryBIO()];outgoing=[ssl.MemoryBIO(),ssl.MemoryBIO()]
        peers=[client_context.wrap_bio(incoming[0],outgoing[0],server_hostname=hostname),
            server_context.wrap_bio(incoming[1],outgoing[1],server_side=True)]
        done=[False,False]
        for _ in range(32):
            for index,peer in enumerate(peers):
                if not done[index]:
                    try:peer.do_handshake();done[index]=True
                    except ssl.SSLWantReadError:pass
                data=outgoing[index].read()
                if data:incoming[1-index].write(data)
            if all(done):return
        raise PublicationError("Certificate validation handshake did not complete")
    except (OSError,ssl.SSLError) as error:
        raise PublicationError("TLS certificate/key validation failed: "+str(error)) from error


def copy_certificates(config):
    """Select a complete validated pair with one atomic symlink replacement."""
    root=Path(config["root"])/"tls";root.mkdir(parents=True,exist_ok=True,mode=0o700)
    with (root/"certificate.lock").open("a") as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        return _copy_certificates(config)


def _copy_certificates(config):
    root=Path(config["root"])/"tls";root.mkdir(parents=True,exist_ok=True,mode=0o700)
    copies=root/"copies";copies.mkdir(exist_ok=True,mode=0o700)
    with tempfile.TemporaryDirectory(dir=root,prefix=".validate-") as directory:
        stage=Path(directory);cert=stage/"cert.pem";key=stage/"key.pem"
        for name,path in [("cert.pem",config["certificateSource"]),("key.pem",config["keySource"])]:
            with Path(path).open("rb") as source:data=source.read(1024*1024+1)
            if len(data)>1024*1024:raise PublicationError("Certificate/key source exceeds its size limit")
            atomic_write(stage/name,data)
        os.chmod(cert,0o600);os.chmod(key,0o600)
        validate_pair(cert,key,config["hostname"],config.get("trustCA"))
        identity=hashlib.sha256(cert.read_bytes()).hexdigest()
        target=copies/identity
        if not target.exists():
            sync_directory(stage)
            os.replace(stage,target)
            sync_directory(copies)
        else:validate_pair(target/"cert.pem",target/"key.pem",config["hostname"],config.get("trustCA"))
        current=root/"current"
        changed=not current.is_symlink() or current.resolve()!=target
        if changed:
            link=root/".next"
            link.unlink(missing_ok=True);link.symlink_to("copies/"+identity)
            os.replace(link,current);sync_directory(root)
        return {"changed":changed,"certificateSha256":identity,
            "reloadRequired":not (root/"reloaded").exists() or (root/"reloaded").read_text().strip()!=identity}


def nginx_command(config,*arguments):
    return [config["nginx"],"-p",str(Path(config["root"])/"nginx")+"/",
        "-c",str(Path(config["root"])/"config/nginx.conf"),*arguments]


def reload_nginx(config):
    """Never signal another Nginx, even if an unrelated PID is in our PID file."""
    prefix=Path(config["root"])/"nginx"
    subprocess.run(nginx_command(config,"-t"),check=True,capture_output=True)
    try:pid=int((prefix/"nginx.pid").read_text().strip())
    except (OSError,ValueError) as error:raise PublicationError("Own Nginx is not running") from error
    if pid<=1:raise PublicationError("Invalid own Nginx PID")
    args=subprocess.check_output(["ps","-ww","-p",str(pid),"-o","args="],text=True).strip()
    expected=nginx_command(config)
    if "nginx: master process" not in args or any(shlex.quote(arg) not in args for arg in expected):
        raise PublicationError("PID does not belong to the configured private Nginx")
    os.kill(pid,signal.SIGHUP)
    identity=hashlib.sha256((Path(config["root"])/"tls/current/cert.pem").read_bytes()).hexdigest()
    atomic_write(Path(config["root"])/"tls/reloaded",(identity+"\n").encode())
    return {"reloadedOwnNginx":True,"pid":pid}
