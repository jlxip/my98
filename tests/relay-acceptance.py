"""Disposable Ethernet guest against a real relay; no passwords or seeds on disk.

Use Python with tests/relay-requirements.txt. MY98_RELAY_ADMIN is a trusted
shell-quoted command prefix for seedbox.py (executed without a shell). Tests
authorize a random Ed25519 key and always revoke it in finally.
"""
import argparse
import asyncio
import hashlib
import json
import os
import secrets
import shlex
import socket
import ssl
import struct
import subprocess
import time
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

MAC = bytes.fromhex('002215000001')
IP = socket.inet_aton('10.5.0.100')
GATEWAY = socket.inet_aton('10.5.0.1')
BODY = (b'my98 relay transfer fixture\n' * 21000)[:512*1024]

def checksum(data):
    if len(data) % 2: data += b'\0'
    value = sum(struct.unpack('!' + 'H'*(len(data)//2), data))
    while value >> 16: value = (value & 65535) + (value >> 16)
    return (~value) & 65535

def ipv4(protocol, source, target, data):
    header = struct.pack('!BBHHHBBH4s4s', 0x45, 0, 20+len(data), secrets.randbelow(65536), 0, 64, protocol, 0, source, target)
    return header[:10] + struct.pack('!H', checksum(header)) + header[12:] + data

def udp(source, target, sport, dport, data):
    header = struct.pack('!HHHH', sport, dport, len(data)+8, 0)
    pseudo = source + target + struct.pack('!BBH', 0, 17, len(data)+8)
    value = checksum(pseudo+header+data) or 65535
    return header[:6] + struct.pack('!H', value) + data

def signed_bytes(public, challenge):
    fields = [public, challenge['url'].encode(), challenge['origin'].encode(), bytes.fromhex(challenge['nonce']), struct.pack('!Q', challenge['expires'])]
    return b'my98/relay-challenge/v1\0' + b''.join(struct.pack('!I', len(b))+b for b in fields)

def admin(command, public=None):
    prefix = shlex.split(os.environ.get('MY98_RELAY_ADMIN', 'python3 scripts/seedbox.py --relay-socket build/relay-pilot/admin.sock'))
    result = subprocess.run(prefix + ['relay-'+command] + ([public] if public else []), check=True, stdout=subprocess.PIPE, text=True)
    return json.loads(result.stdout)

class Guest:
    def __init__(self, ws):
        self.ws=ws; self.gateway_mac=bytes.fromhex('52550a050001')
    async def ethernet(self, kind, payload, target=None):
        await self.ws.send((target or self.gateway_mac)+MAC+struct.pack('!H',kind)+payload)
    async def receive(self, protocol, predicate=lambda p: True, wait=10):
        until=time.monotonic()+wait
        while time.monotonic()<until:
            frame=await asyncio.wait_for(self.ws.recv(),max(0.001,until-time.monotonic()))
            if not isinstance(frame,bytes) or len(frame)<34: continue
            kind=struct.unpack('!H',frame[12:14])[0]
            if kind==0x0806:
                arp=frame[14:42]
                if len(arp)!=28: continue
                if arp[6:8]==b'\0\1' and arp[24:28]==IP:
                    await self.ethernet(0x0806,arp[:6]+b'\0\2'+MAC+IP+arp[8:18],arp[8:14])
                if arp[14:18]==GATEWAY: self.gateway_mac=arp[8:14]
                if protocol==0x0806 and predicate(arp): return arp
                continue
            if kind!=0x0800: continue
            p=frame[14:]; length=struct.unpack('!H',p[2:4])[0]; p=p[:length]
            if p[9]==protocol and predicate(p): return p
        raise TimeoutError('Guest response timed out')
    async def arp(self):
        p=struct.pack('!HHBBH',1,0x800,6,4,1)+MAC+IP+bytes(6)+GATEWAY
        await self.ethernet(0x0806,p,bytes.fromhex('ffffffffffff'))
        await self.receive(0x0806,lambda p:p[6:8]==b'\0\2' and p[14:18]==GATEWAY)
    async def send_udp(self,target,sport,dport,data,source=IP):
        await self.ethernet(0x800,ipv4(17,source,target,udp(source,target,sport,dport,data)),bytes.fromhex('ffffffffffff') if target==b'\xff'*4 else None)
    async def recv_udp(self,sport,dport,wait=10):
        p=await self.receive(17,lambda p:len(p)>=28 and p[20:24]==struct.pack('!HH',sport,dport),wait)
        return p[28:]
    async def dhcp(self):
        xid=secrets.randbits(32)
        base=struct.pack('!BBBBIHH4s4s4s4s16s64s128s',1,1,6,0,xid,0,0x8000,bytes(4),bytes(4),bytes(4),bytes(4),MAC+bytes(10),bytes(64),bytes(128))+bytes.fromhex('63825363')
        await self.send_udp(b'\xff'*4,68,67,base+b'\x35\x01\x01\x37\x04\x01\x03\x06\x1a\xff',bytes(4))
        offer=await self.recv_udp(67,68); assert struct.unpack('!I',offer[4:8])[0]==xid
        offered=offer[16:20]; assert offered==IP
        await self.send_udp(b'\xff'*4,68,67,base+b'\x35\x01\x03\x32\x04'+offered+b'\x36\x04'+GATEWAY+b'\x37\x03\x01\x03\x06\xff',bytes(4))
        ack=await self.recv_udp(67,68); options={}; i=240
        while i<len(ack) and ack[i]!=255:
            k=ack[i]; i+=1
            if not k: continue
            n=ack[i]; i+=1; options[k]=ack[i:i+n]; i+=n
        assert options[53]==b'\x05' and options[1]==socket.inet_aton('255.255.0.0') and options[3]==GATEWAY and options[6]==GATEWAY
        await self.arp()
    @staticmethod
    def dns_query(host):
        ident=secrets.randbelow(65536)
        return ident,struct.pack('!HHHHHH',ident,0x100,1,0,0,0)+b''.join(bytes([len(p)])+p.encode() for p in host.split('.'))+b'\0\0\1\0\1'
    async def dns(self,host):
        ident,query=self.dns_query(host); port=secrets.randbelow(10000)+20000
        await self.send_udp(GATEWAY,port,53,query); reply=await self.recv_udp(53,port)
        assert reply[:2]==struct.pack('!H',ident) and reply[3]&15==0
        # A records encoded as type/class/TTL/RDLENGTH/RDATA after a name.
        candidates=[]
        for i in range(12,len(reply)-14):
            if reply[i:i+4]==b'\0\1\0\1' and reply[i+8:i+10]==b'\0\4': candidates.append(reply[i+10:i+14])
        assert candidates, 'DNS returned no IPv4 A record'
        return candidates[0]
    async def tcp(self,target,port):
        tcp=TCP(self,target,port); await tcp.connect(); return tcp

class TCP:
    def __init__(self,guest,target,port):
        self.guest=guest; self.target=target; self.port=port; self.local=secrets.randbelow(20000)+30000
        self.seq=secrets.randbits(31);self.ack=0;self.eof=False
    async def packet(self,flags,data=b''):
        h=struct.pack('!HHIIBBHHH',self.local,self.port,self.seq,self.ack,0x50,flags,65535,0,0)
        pseudo=IP+self.target+struct.pack('!BBH',0,6,len(h)+len(data)); h=h[:16]+struct.pack('!H',checksum(pseudo+h+data))+h[18:]
        await self.guest.ethernet(0x800,ipv4(6,IP,self.target,h+data))
    async def next(self):
        p=await self.guest.receive(6,lambda p:len(p)>=40 and p[12:16]==self.target and p[20:24]==struct.pack('!HH',self.port,self.local),20)
        return p[20:]
    async def connect(self):
        await self.packet(2); p=await self.next(); assert p[13]&0x12==0x12
        assert struct.unpack('!I',p[8:12])[0]==self.seq+1
        self.seq+=1;self.ack=struct.unpack('!I',p[4:8])[0]+1; await self.packet(16)
    async def write(self,data):
        for i in range(0,len(data),1400):
            chunk=data[i:i+1400]; await self.packet(24,chunk); self.seq=(self.seq+len(chunk))&0xffffffff
    async def read(self):
        while not self.eof:
            p=await self.next(); flags=p[13];seq=struct.unpack('!I',p[4:8])[0];data=p[(p[12]>>4)*4:]
            if flags&4: raise ConnectionError('Guest TCP reset')
            if seq!=self.ack:
                await self.packet(16);continue
            if data or flags&1:
                self.ack=(self.ack+len(data)+bool(flags&1))&0xffffffff;self.eof=bool(flags&1);await self.packet(16)
                return data
        return b''
    async def all(self):
        chunks=[]
        while not self.eof:
            chunks.append(await self.read())
        return b''.join(chunks)
    async def close(self):
        if not self.eof: await self.packet(20)

async def https(guest,target,host):
    tcp=await guest.tcp(target,443); incoming=ssl.MemoryBIO();outgoing=ssl.MemoryBIO()
    tls=ssl.create_default_context().wrap_bio(incoming,outgoing,server_side=False,server_hostname=host)
    async def exchange():
        data=outgoing.read()
        if data: await tcp.write(data)
        received=await tcp.read()
        if received: incoming.write(received)
        else: incoming.write_eof()
    while True:
        try: tls.do_handshake();break
        except ssl.SSLWantReadError: await exchange()
    data=outgoing.read()
    if data: await tcp.write(data)
    tls.write(f'GET / HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n'.encode())
    await tcp.write(outgoing.read());chunks=[]
    while True:
        try:
            data=tls.read(65536)
            if not data: break
            chunks.append(data)
        except ssl.SSLWantReadError: await exchange()
        except ssl.SSLZeroReturnError: break
    await tcp.close();result=b''.join(chunks);assert b'HTTP/1.1 200' in result[:100] and b'Example Domain' in result

async def main(args):
    private=Ed25519PrivateKey.generate();public=private.public_key().public_bytes(Encoding.Raw,PublicFormat.Raw)
    authorized=False;checks=[]
    try:
        if args.external:
            print(json.dumps({'authorizePublicKey':public.hex()}),flush=True)
            assert await asyncio.to_thread(input)=='GO'
        else:
            admin('allow',public.hex());authorized=True
        async with connect(args.relay,origin=args.origin,subprotocols=['my98-relay.v1'],max_size=4096) as ws:
            assert ws.subprotocol=='my98-relay.v1'
            await ws.send(json.dumps({'type':'hello','publicKey':public.hex()}));c=json.loads(await ws.recv())
            assert c['type']=='challenge' and c['url']==args.public_url and c['origin']==args.origin and len(bytes.fromhex(c['nonce']))==32
            await ws.send(json.dumps({'type':'authenticate','signature':private.sign(signed_bytes(public,c)).hex()}));assert json.loads(await ws.recv())['type']=='ready'
            checks.append('authenticated WSS' if args.relay.startswith('wss:') else 'authenticated WS')
            guest=Guest(ws);await guest.dhcp();checks.append('DHCP + ARP')
            # Same identity, saved Ethernet MAC and IPv4 address; independent DHCP/ARP/DNS state.
            async with connect(args.relay,origin=args.origin,subprotocols=['my98-relay.v1'],max_size=4096) as other:
                await other.send(json.dumps({'type':'hello','publicKey':public.hex()}));challenge=json.loads(await other.recv())
                await other.send(json.dumps({'type':'authenticate','signature':private.sign(signed_bytes(public,challenge)).hex()}))
                assert json.loads(await other.recv())['type']=='ready'
                second=Guest(other);await second.dhcp()
                await asyncio.gather(guest.dns('example.com'),second.dns('example.org'))
            checks.append('two stacks isolated with identical MAC/IP')
            target=await guest.dns('example.com');checks.append('DNS UDP')
            tcp=await guest.tcp(GATEWAY,53);ident,q=guest.dns_query('example.com');await tcp.write(struct.pack('!H',len(q))+q)
            reply=b''
            while len(reply)<2 or len(reply)<struct.unpack('!H',reply[:2])[0]+2:reply+=await tcp.read()
            assert reply[2:4]==struct.pack('!H',ident);await tcp.close();checks.append('DNS TCP')
            tcp=await guest.tcp(target,80);await tcp.write(b'GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n');response=await tcp.all();assert b'Example Domain' in response;checks.append('HTTP')
            await https(guest,target,'example.com');checks.append('HTTPS verified TLS')
            if args.echo_host:
                ip=socket.inet_aton(args.echo_host);nonce=secrets.token_bytes(64);port=secrets.randbelow(10000)+20000
                await guest.send_udp(ip,port,32123,nonce);assert await guest.recv_udp(32123,port)==nonce;checks.append('UDP echo')
                tcp=await guest.tcp(ip,80);await tcp.write(b'GET / HTTP/1.1\r\nHost: fixture\r\nConnection: close\r\n\r\n');data=(await tcp.all()).split(b'\r\n\r\n',1)[1]
                assert hashlib.sha256(data).digest()==hashlib.sha256(BODY).digest();checks.append('TCP 512 KiB transfer SHA256')
            if not args.external:
                before=admin('status')['counters']['blocked']
                for ip in ['127.0.0.1','10.0.0.1','169.254.169.254','192.168.1.1',args.host_ip]:
                    await guest.send_udp(socket.inet_aton(ip),20000,80,b'fixture')
                await asyncio.sleep(0.2);assert admin('status')['counters']['blocked']>=before+5;checks.append('private + metadata + host blocked')
                admin('revoke',public.hex());authorized=False
                try:
                    async with asyncio.timeout(3):
                        while True: await ws.recv() # drain frames already queued before revocation
                except ConnectionClosed as closed: assert closed.rcvd.code==1008
                checks.append('revocation closes session')
    finally:
        if authorized: admin('revoke',public.hex())
    print(json.dumps({'ok':True,'checks':checks}))

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--relay',required=True);parser.add_argument('--public-url',required=True)
    parser.add_argument('--origin',default='http://127.0.0.1:8686');parser.add_argument('--host-ip',required=True)
    parser.add_argument('--echo-host')
    parser.add_argument('--external',action='store_true',help='Print public key and wait for GO; caller authorizes/revokes it locally. Never transfer admin keys.')
    asyncio.run(main(parser.parse_args()))
