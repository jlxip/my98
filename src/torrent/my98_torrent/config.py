"""Explicit trusted sources; publishing metadata cannot add network destinations."""
import ipaddress
import json
from pathlib import Path
from urllib.parse import urlsplit
from .protocol import PublicationError


def source_url(value,schemes):
    if type(value) is not str:raise PublicationError("Source URL must be a string")
    url=urlsplit(value)
    if url.scheme not in schemes or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise PublicationError("Invalid trusted source URL")
    if url.scheme in ("http","ws"):
        try:local=ipaddress.ip_address(url.hostname).is_loopback
        except ValueError:local=url.hostname=="localhost"
        if not local:raise PublicationError("Unencrypted source URLs are restricted to loopback fixtures")
    return value.rstrip("/")


def validate_isolated(value,*,service=False):
    """Explicit fixtures cannot contact public sources or bind public listeners."""
    endpoints=[urlsplit(node["api"]).hostname for node in value.get("nodes",[])]
    endpoints += [urlsplit(url).hostname for url in value.get("trackers",[])+value.get("webseeds",[])]
    endpoints += [node["peer"][0] for node in value.get("nodes",[])]
    if service:
        for endpoint in value.get("listen","").split(","):
            if not endpoint:raise PublicationError("An isolated service requires explicit loopback listeners")
            host,_=endpoint.rsplit(":",1);endpoints.append(host.strip("[]"))
    for host in endpoints:
        try:local=host=="localhost" or ipaddress.ip_address(host).is_loopback
        except ValueError:local=False
        if not local:raise PublicationError("Isolated fixtures require loopback sources and listeners")


def load(path):
    value=json.loads(Path(path).read_text()) if path else {}
    if type(value) is not dict or set(value)-{"nodes","trackers","webseeds","data","publisherData","follow","listen","api","aquatic"}:
        raise PublicationError("Invalid configuration fields")
    if "aquatic" in value:
        from .tracker import configuration
        configuration(value["aquatic"])
    nodes=value.get("nodes",[])
    if type(nodes) is not list:raise PublicationError("Invalid seedbox list")
    names=set()
    for node in nodes:
        if type(node) is not dict or set(node)!={"name","api","peer"} or type(node["name"]) is not str or not node["name"] or node["name"] in names:
            raise PublicationError("Each seedbox requires a unique name, API and peer endpoint")
        names.add(node["name"]);source_url(node["api"],("https","http"))
        peer=node["peer"]
        if type(peer) is not list or len(peer)!=2 or type(peer[0]) is not str or not peer[0] or type(peer[1]) is not int or not 1<=peer[1]<=65535:
            raise PublicationError("Invalid seedbox peer endpoint")
    for tracker in value.get("trackers",[]):source_url(tracker,("wss","ws"))
    for seed in value.get("webseeds",[]):source_url(seed,("https","http"))
    keys=value.get("follow",[])
    if type(keys) is not list:raise PublicationError("Invalid followed key list")
    for key in keys:
        if type(key) is not str or len(key)!=64 or key!=key.lower():raise PublicationError("Invalid followed key")
        try:bytes.fromhex(key)
        except ValueError as error:raise PublicationError("Invalid followed key") from error
    api=value.get("api",{"host":"127.0.0.1","port":17498})
    if type(api) is not dict or set(api)!={"host","port"} or type(api["port"]) is not int or not 1<=api["port"]<=65535:
        raise PublicationError("Invalid administrative API listener")
    try:local=ipaddress.ip_address(api["host"]).is_loopback
    except (ValueError,TypeError):local=False
    if not local:raise PublicationError("Administrative API must bind an explicit loopback address")
    value["api"]=api
    return value
