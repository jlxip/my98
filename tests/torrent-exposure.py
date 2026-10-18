"""Bounded nonce echo on NEW ports only, before activating torrent services."""
import argparse
import ipaddress
import json
import secrets
import selectors
import signal
import socket
import time


def serve(args):
    selector=selectors.DefaultSelector();sockets=[];stopping=False
    def stop(*_):
        nonlocal stopping
        stopping=True
    for number in [signal.SIGTERM,signal.SIGINT]:signal.signal(number,stop)
    try:
        for host,family in [("0.0.0.0",socket.AF_INET),("::",socket.AF_INET6)]:
            for port,kind in [(8444,socket.SOCK_STREAM),(51413,socket.SOCK_STREAM),(51413,socket.SOCK_DGRAM)]:
                listener=socket.socket(family,kind);sockets.append(listener)
                if family==socket.AF_INET6:listener.setsockopt(socket.IPPROTO_IPV6,socket.IPV6_V6ONLY,1)
                if kind==socket.SOCK_STREAM:listener.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
                listener.bind((host,port))
                if kind==socket.SOCK_STREAM:listener.listen(8)
                listener.setblocking(False);selector.register(listener,selectors.EVENT_READ,(port,kind))
        print(json.dumps({"ready":True,"ports":["8444/tcp","51413/tcp","51413/udp"]}),flush=True)
        deadline=time.monotonic()+args.seconds
        while not stopping and time.monotonic()<deadline:
            for key,_ in selector.select(.25):
                port,kind=key.data;listener=key.fileobj
                response=(args.token+":"+str(port)+":"+("tcp" if kind==socket.SOCK_STREAM else "udp")).encode()
                if kind==socket.SOCK_DGRAM:
                    data,address=listener.recvfrom(128)
                    if secrets.compare_digest(data,args.token.encode()):listener.sendto(response,address)
                else:
                    connection,_=listener.accept()
                    with connection:
                        connection.settimeout(1)
                        try:
                            data=connection.recv(128)
                            if secrets.compare_digest(data,args.token.encode()):connection.sendall(response)
                        except OSError:pass
    finally:
        selector.close()
        for listener in sockets:listener.close()


def check(args):
    addresses=sorted({item[4][0] for item in socket.getaddrinfo(args.host,None,type=socket.SOCK_STREAM)})
    assert addresses and all(ipaddress.ip_address(address).is_global for address in addresses),"Use public DNS addresses from an external node"
    results=[]
    for address in addresses:
        family=socket.AF_INET6 if ipaddress.ip_address(address).version==6 else socket.AF_INET
        for port,kind in [(8444,socket.SOCK_STREAM),(51413,socket.SOCK_STREAM),(51413,socket.SOCK_DGRAM)]:
            protocol="tcp" if kind==socket.SOCK_STREAM else "udp"
            with socket.socket(family,kind) as probe:
                probe.settimeout(5);probe.connect((address,port));probe.sendall(args.token.encode())
                response=probe.recv(128)
            assert response==(args.token+":"+str(port)+":"+protocol).encode(),"Wrong forwarding destination"
            results.append({"address":address,"port":port,"protocol":protocol,"verified":True})
    print(json.dumps({"externalExposure":True,"host":args.host,"results":results}),flush=True)


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command",choices=["serve","check"])
    parser.add_argument("--token",required=True)
    parser.add_argument("--host")
    parser.add_argument("--seconds",type=int,default=120)
    args=parser.parse_args()
    assert len(args.token)==64 and all(c in "0123456789abcdef" for c in args.token)
    assert 1<=args.seconds<=300
    if args.command=="check":
        assert args.host;check(args)
    else:serve(args)
