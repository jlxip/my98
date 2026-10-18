"""Own Aquatic children and atomically maintain their shared access list."""
import asyncio
import ipaddress
import json
import os
from pathlib import Path
import platform
import signal
import socket
from .files import atomic_write
from .protocol import PublicationError, hash_bytes


def configuration(value):
    if type(value) is not dict or set(value)!={"binary","listen"}:
        raise PublicationError("Aquatic requires its private binary and loopback listeners")
    binary=Path(value["binary"]) if type(value["binary"]) is str else Path()
    if not binary.is_absolute():
        raise PublicationError("Aquatic binary must be an absolute private path")
    listeners=value["listen"]
    if type(listeners) is not list or not listeners:
        raise PublicationError("Configure explicit Aquatic loopback listeners")
    seen=set()
    for listener in listeners:
        if type(listener) is not dict or set(listener)!={"host","port"}:
            raise PublicationError("Invalid Aquatic listener")
        if type(listener["host"]) is not str:
            raise PublicationError("Aquatic address must be an explicit loopback string")
        try:address=ipaddress.ip_address(listener["host"])
        except (ValueError,TypeError):raise PublicationError("Invalid Aquatic address")
        if not address.is_loopback or type(listener["port"]) is not int or not 1<=listener["port"]<=65535:
            raise PublicationError("Aquatic administration must remain on loopback")
        endpoint=(str(address),listener["port"])
        if endpoint in seen:raise PublicationError("Duplicate Aquatic listener")
        seen.add(endpoint)
    return value


class Aquatic:
    def __init__(self,root,config):
        self.config=configuration(config);self.root=Path(root).resolve()
        self.access_list=self.root/"allowed.txt"
        self.children=[];self.watchers=[];self.failed=None;self.closing=False
        self.allowed=None

    @property
    def client_urls(self):
        result=[]
        for listener in self.config["listen"]:
            address=ipaddress.ip_address(listener["host"])
            host=f"[{address}]" if address.version==6 else str(address)
            result.append(f"ws://{host}:{listener['port']}")
        return tuple(result)

    def update(self,hashes):
        hashes=frozenset(hashes)
        for value in hashes:hash_bytes(value)
        if hashes==self.allowed:return
        atomic_write(self.access_list,("".join(value+"\n" for value in sorted(hashes))).encode("ascii"))
        self.allowed=hashes
        # Only signal child Process objects created by this manager. Never read
        # a PID file or signal a possibly reused/unrelated tracker PID.
        for child in self.children:
            if child.returncode is not None:
                raise PublicationError("Own Aquatic tracker stopped")
            try:child.send_signal(signal.SIGUSR1)
            except ProcessLookupError as error:
                raise PublicationError("Own Aquatic tracker stopped") from error

    async def watch(self,child):
        code=await child.wait()
        if not self.closing and not self.failed.done():
            self.failed.set_result(f"Own Aquatic tracker exited ({code}); see private tracker logs")

    async def start(self,hashes):
        if platform.system()!="Linux":
            raise PublicationError("Aquatic is supported on Linux only")
        binary=Path(self.config["binary"])
        if not binary.is_file() or not os.access(binary,os.X_OK):
            raise PublicationError("Private Aquatic binary is unavailable")
        self.root.mkdir(parents=True,exist_ok=True,mode=0o700)
        self.failed=asyncio.get_running_loop().create_future()
        # Check every listener before creating any child.
        sockets=[]
        try:
            for listener in self.config["listen"]:
                address=ipaddress.ip_address(listener["host"])
                probe=socket.socket(socket.AF_INET6 if address.version==6 else socket.AF_INET)
                sockets.append(probe)
                if address.version==6:probe.setsockopt(socket.IPPROTO_IPV6,socket.IPV6_V6ONLY,1)
                probe.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
                probe.bind((str(address),listener["port"]))
                probe.listen(1)
        finally:
            for probe in sockets:probe.close()
        self.update(hashes)
        try:
            for index,listener in enumerate(self.config["listen"]):
                address=ipaddress.ip_address(listener["host"])
                host=f"[{address}]" if address.version==6 else str(address)
                text=("socket_workers = 1\nswarm_workers = 1\n"
                    '[network]\naddress = '+json.dumps(f"{host}:{listener['port']}")+"\n"
                    +"only_ipv6 = "+str(address.version==6).lower()+"\n"
                    +"enable_http_health_checks = true\n"
                    +'[access_list]\nmode = "allow"\npath = '+json.dumps(str(self.access_list))+"\n")
                config=self.root/f"tracker-{index}.toml"
                atomic_write(config,text.encode())
                with (self.root/f"tracker-{index}.log").open("ab",buffering=0) as output:
                    child=await asyncio.create_subprocess_exec(str(binary),"-c",str(config),
                        stdin=asyncio.subprocess.DEVNULL,stdout=output,stderr=asyncio.subprocess.STDOUT)
                self.children.append(child)
                self.watchers.append(asyncio.create_task(self.watch(child)))
                await self.ready(listener,child)
        except BaseException:
            await self.stop()
            raise

    async def ready(self,listener,child):
        deadline=asyncio.get_running_loop().time()+10
        while asyncio.get_running_loop().time()<deadline:
            if child.returncode is not None:
                raise PublicationError("Own Aquatic tracker failed to start; see private tracker log")
            try:
                reader,writer=await asyncio.wait_for(asyncio.open_connection(listener["host"],listener["port"]),1)
                try:
                    writer.write(b"GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
                    await writer.drain()
                    line=await asyncio.wait_for(reader.readline(),1)
                    if line.startswith(b"HTTP/1.1 200") or line.startswith(b"HTTP/1.0 200"):return
                finally:
                    writer.close()
                    await writer.wait_closed()
            except (OSError,TimeoutError):pass
            await asyncio.sleep(.05)
        raise PublicationError("Own Aquatic tracker health check timed out")

    async def stop(self):
        owned=bool(self.children)
        self.closing=True
        for child in self.children:
            if child.returncode is None:
                try:child.terminate()
                except ProcessLookupError:pass
        for child in self.children:
            try:await asyncio.wait_for(child.wait(),10)
            except TimeoutError:
                try:child.kill()
                except ProcessLookupError:pass
                await child.wait()
        await asyncio.gather(*self.watchers,return_exceptions=True)
        self.children.clear();self.watchers.clear()
        if owned:
            # io_uring can retain an accepted socket briefly after child exit.
            # Wait for exclusive bindability; never signal another process.
            deadline=asyncio.get_running_loop().time()+3
            while True:
                try:
                    for listener in self.config["listen"]:
                        address=ipaddress.ip_address(listener["host"])
                        with socket.socket(socket.AF_INET6 if address.version==6 else socket.AF_INET) as probe:
                            if address.version==6:probe.setsockopt(socket.IPPROTO_IPV6,socket.IPV6_V6ONLY,1)
                            probe.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
                            probe.bind((str(address),listener["port"]));probe.listen(1)
                    break
                except OSError:
                    if asyncio.get_running_loop().time()>=deadline:raise
                    await asyncio.sleep(.02)

