"""Asyncio adapter. All networking, requests and piece hashes belong to libtorrent."""
import asyncio
import logging
import ipaddress
from collections import defaultdict
from contextlib import suppress
from pathlib import Path
import socket
import libtorrent as lt
import my98_libtorrent as native
from .protocol import Record, SALT, PublicationError, Conflict, value_bytes


def check_listeners(options):
    """Fail before creating a session if any requested TCP/UDP port is occupied."""
    probes=[]
    try:
        for endpoint in options["listen_interfaces"].split(","):
            try:
                host,port=endpoint.strip().rsplit(":",1)
                address=ipaddress.ip_address(host.removeprefix("[").removesuffix("]"))
                port=int(port)
                if not 0<=port<=65535:raise ValueError()
            except (ValueError,TypeError):
                raise PublicationError("Native listeners require explicit IP addresses and ports")
            family=socket.AF_INET6 if address.version==6 else socket.AF_INET
            kinds=[]
            if options.get("enable_incoming_tcp",True):kinds.append(socket.SOCK_STREAM)
            if options.get("enable_dht",True) or options.get("enable_incoming_utp",True) or options.get("enable_outgoing_utp",True):
                kinds.append(socket.SOCK_DGRAM)
            for kind in kinds:
                probe=socket.socket(family,kind);probes.append(probe)
                if address.version==6:probe.setsockopt(socket.IPPROTO_IPV6,socket.IPV6_V6ONLY,1)
                if kind==socket.SOCK_STREAM:probe.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
                probe.bind((str(address),port))
                if kind==socket.SOCK_STREAM:probe.listen(1)
    finally:
        for probe in probes:probe.close()


def record_from_alert(alert):
    if bytes(alert.salt) != SALT or type(alert.item) is not dict or set(alert.item) != {b"ih"}:
        raise PublicationError("Wrong DHT publication salt or value")
    return Record(bytes(alert.key), alert.seq, alert.item[b"ih"], bytes(alert.signature)).verify()


class Engine:
    def __init__(self, *, listen="0.0.0.0:51413,[::]:51413", isolated=False, settings=None):
        self.loop=asyncio.get_running_loop()
        options={"listen_interfaces":listen,"enable_dht":True,"enable_lsd":False,
            "enable_upnp":False,"enable_natpmp":False,"connections_limit":128,
            "close_redundant_connections":False,"max_retry_port_bind":0,"listen_system_port_fallback":False,
            "alert_mask":int(lt.alert_category.error|lt.alert_category.storage|lt.alert_category.status|lt.alert_category.dht|lt.alert_category.dht_operation|lt.alert_category.stats),
            "max_metadata_size":96*1024*1024}
        if isolated:
            options.update(dht_bootstrap_nodes="",dht_restrict_routing_ips=False,
                dht_restrict_search_ips=False,dht_ignore_dark_internet=False,dht_enforce_node_id=False,dht_block_ratelimit=10000,dht_block_timeout=1,dht_upload_rate_limit=1024*1024,min_reconnect_time=1,allow_multiple_connections_per_ip=True)
        if logging.getLogger("my98.torrent").isEnabledFor(logging.DEBUG):
            options["alert_mask"] |= int(lt.alert_category.peer|lt.alert_category.connect)
        if settings:options.update(settings)
        check_listeners(options)
        self.listen_errors=[]
        self.session=lt.session(options)
        self.reader,self.writer=socket.socketpair()
        self.reader.setblocking(False);self.writer.setblocking(False)
        self.waiters=[];self.listeners=set();self.locks=defaultdict(asyncio.Lock)
        self.closed=False
        self.loop.add_reader(self.reader.fileno(),self._drain)
        self.session.set_alert_fd(self.writer.fileno())
        self._drain()

    def _drain(self):
        with suppress(BlockingIOError):
            while self.reader.recv(65536):pass
        for alert in self.session.pop_alerts():
            if isinstance(alert,lt.listen_failed_alert):self.listen_errors.append(alert.message())
            if logging.getLogger("my98.torrent").isEnabledFor(logging.DEBUG):
                logging.getLogger("my98.torrent").debug("%s",alert.message())
            for predicate,future in list(self.waiters):
                if not future.done() and predicate(alert):future.set_result(alert)
            for callback in tuple(self.listeners):
                try:callback(alert)
                except Exception as error:self.loop.call_exception_handler({"message":"Torrent alert listener failed","exception":error})

    async def wait(self,predicate,action=None,timeout=30):
        if self.closed:raise RuntimeError("Torrent engine is closed")
        future=self.loop.create_future();entry=(predicate,future);self.waiters.append(entry)
        try:
            if action:action()
            return await asyncio.wait_for(future,timeout)
        finally:self.waiters.remove(entry)

    async def listening(self,timeout=10):
        async def ready():
            while not self.session.is_listening():
                if self.listen_errors:raise PublicationError("Native listener failed: "+self.listen_errors[0])
                await asyncio.sleep(.02)
            # Let bind alerts from all configured families/protocols arrive:
            # one successful socket must not conceal a concurrent bind failure.
            await asyncio.sleep(.05)
            if self.listen_errors:raise PublicationError("Native listener failed: "+self.listen_errors[0])
            return self.session.listen_port()
        return await asyncio.wait_for(ready(),timeout)

    async def dht_ready(self,timeout=30):
        async def ready():
            while True:
                alert=await self.wait(lambda a:isinstance(a,lt.dht_stats_alert),self.session.post_dht_stats,5)
                if sum(bucket["num_nodes"] for bucket in alert.routing_table)>0:return
                await asyncio.sleep(.1)
        try:await asyncio.wait_for(ready(),timeout)
        except TimeoutError as error:raise PublicationError("DHT has no reachable routing neighbors") from error

    def add_node(self,endpoint):
        self.session.add_dht_node(tuple(endpoint))

    async def resolve(self,key,timeout=20,*,require_authoritative=True):
        if type(key) is not bytes or len(key)!=32:raise PublicationError("Invalid publication public key")
        # One lookup per key. Non-authoritative replies must not terminate an
        # ongoing search before libtorrent has queried the closest DHT nodes.
        async with self.locks[("get",key)]:
            best=None
            def received(alert):
                nonlocal best
                if not isinstance(alert,lt.dht_mutable_item_alert) or bytes(alert.key)!=key or bytes(alert.salt)!=SALT:return False
                # A completed empty lookup has no signature/value and sequence0.
                # It is an absence result, never a signed version to persist.
                if alert.authoritative and alert.seq==0 and alert.item in (None,b""):return True
                try:record=record_from_alert(alert)
                except PublicationError:return False
                if best is not None and record.sequence==best.sequence and record.info_hash!=best.info_hash:
                    raise Conflict("Conflicting DHT records have the same sequence")
                if best is None or record.sequence>best.sequence:best=record
                return bool(alert.authoritative)
            # Predicate exceptions are delivered by this listener to the caller.
            error=None
            def guarded(alert):
                nonlocal error
                try:return received(alert)
                except PublicationError as exc:error=exc;return True
            try:
                await self.wait(guarded,lambda:self.session.dht_get_mutable_item(key,SALT),timeout)
            except TimeoutError:
                if best is None:return None
                # Followers may retain the highest signature-verified record
                # seen before a slow public lookup finishes. Publisher conflict
                # checks and commit readback still require the completed lookup.
                if not require_authoritative:return best
                raise PublicationError("DHT lookup did not reach an authoritative result")
            if error:raise error
            return best

    async def put(self,record,timeout=30):
        record.verify()
        async with self.locks[("put",record.public_key)]:
            await self.dht_ready(min(timeout,30))
            result=None
            def start():
                nonlocal result
                result=native.put_signed(self.session,record.public_key,SALT,value_bytes(record.info_hash),record.sequence,record.signature)
            def done(alert):
                return (isinstance(alert,lt.dht_put_alert) and bytes(alert.public_key)==record.public_key and bytes(alert.salt)==SALT)
            alert=await self.wait(done,start,timeout)
            if result.conflict:raise Conflict("A newer or conflicting publication was found during DHT put")
            if not result.invoked or alert.seq!=record.sequence or bytes(alert.signature)!=record.signature or alert.num_success<1:
                raise PublicationError("DHT did not store the signed publication")
            return alert.num_success

    def add(self,info_hash,directory,*,metadata=None,kind=None,trackers=(),webseeds=(),peers=(),direct_only=False):
        from .metadata import trusted
        from .protocol import hash_bytes
        params=lt.add_torrent_params()
        params.save_path=str(Path(directory).resolve())
        Path(params.save_path).mkdir(parents=True,exist_ok=True)
        params.flags &= ~(lt.torrent_flags.paused|lt.torrent_flags.auto_managed|lt.torrent_flags.seed_mode)
        params.flags |= lt.torrent_flags.override_trackers|lt.torrent_flags.override_web_seeds
        # Metadata must pass our single-file/schema checks before requesting any
        # payload. Trusted source hints are configuration, never publisher input.
        if metadata is None:
            params.info_hashes=lt.info_hash_t(lt.sha1_hash(hash_bytes(info_hash)))
            params.flags |= lt.torrent_flags.default_dont_download
        else:
            data=trusted(metadata,expected=info_hash,kind=kind,trackers=trackers,webseeds=webseeds)
            params.ti=lt.torrent_info(lt.bdecode(data))
        params.trackers=list(trackers)
        if direct_only:
            # Temporary publishers connect to known seedbox listeners. Do not
            # announce an unreachable Mac listener or invite reverse connections.
            params.flags |= lt.torrent_flags.disable_dht|lt.torrent_flags.disable_lsd|lt.torrent_flags.disable_pex
            params.trackers=[]
        handle=self.session.add_torrent(params)
        if metadata is not None:
            for source in lt.bdecode(data).get(b"url-list",[]):handle.add_url_seed(source.decode())
        for peer in peers:handle.connect_peer(tuple(peer))
        return handle

    async def metadata(self,handle,info_hash,*,kind=None,trackers=(),webseeds=(),timeout=60):
        from .metadata import trusted
        async def ready():
            while not handle.status().has_metadata:await asyncio.sleep(.05)
        await asyncio.wait_for(ready(),timeout)
        data=lt.bencode({b"info":lt.bdecode(bytes(handle.torrent_file().info_section()))})
        try:data=trusted(data,expected=info_hash,kind=kind,trackers=trackers,webseeds=webseeds)
        except PublicationError:
            self.session.remove_torrent(handle)
            raise
        handle.unset_flags(lt.torrent_flags.default_dont_download)
        handle.prioritize_files([4])
        for source in lt.bdecode(data).get(b"url-list",[]):handle.add_url_seed(source.decode())
        return data

    async def remove(self,handle):
        # Wait until the old infohash has left the session before readding the
        # same swarm. Disk tasks may still hold the weak handle afterwards.
        await self.wait(lambda a:isinstance(a,lt.torrent_removed_alert) and a.handle==handle,
            lambda:self.session.remove_torrent(handle),30)

    async def complete(self,handle,timeout=3600):
        async def ready():
            while True:
                status=handle.status()
                if status.errc.value():raise PublicationError("Torrent storage failed: "+status.errc.message())
                if status.is_seeding:return
                await asyncio.sleep(.1)
        await asyncio.wait_for(ready(),timeout)

    @staticmethod
    def peer_complete(handle,endpoint):
        info=handle.torrent_file()
        if info is None:return False
        count=info.num_pieces()
        for peer in handle.get_peer_info():
            if tuple(peer.ip)!=tuple(endpoint):continue
            # libtorrent sets seed only from a complete bitfield/HAVE_ALL. Some
            # engines optimize that exact state by omitting the bitfield array.
            if len(peer.pieces)==count and all(peer.pieces):return True
            if peer.flags & lt.peer_info.seed:return True
        return False

    @classmethod
    def first_complete_seedbox(cls,handles,endpoints):
        handles=list(handles)
        if not handles:return None
        return next((tuple(endpoint) for endpoint in endpoints if all(cls.peer_complete(h,endpoint) for h in handles)),None)

    def close(self):
        if self.closed:return
        self.closed=True
        self.loop.remove_reader(self.reader.fileno())
        self.session.set_alert_fd(-1)
        for _,future in self.waiters:
            if not future.done():future.cancel()
        self.listeners.clear()
        self.session.pause()
        self.session=None
        self.reader.close();self.writer.close()

    async def __aenter__(self):return self
    async def __aexit__(self,*args):self.close()
