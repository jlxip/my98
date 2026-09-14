#!/usr/bin/env python3
"""Three private loopback Kubo nodes; never uses a user's repository or public DHT."""

import argparse
import concurrent.futures
import contextlib
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import struct
import tempfile
import time
import seedbox as seedbox_tool

ROOT = Path(__file__).resolve().parent.parent
FOLLOWER = ROOT / "scripts" / "seedbox.py"


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Node:
    def __init__(self, binary, base, key):
        self.binary, self.base = binary, base
        self.repo = base / "repo"
        self.env = dict(os.environ, IPFS_PATH=str(self.repo), LIBP2P_FORCE_PNET="1")
        self.env.pop("IPFS_API", None)
        self.process = None
        base.mkdir()
        self.cli("init", "--profile=test", daemon=False)
        config_path = self.repo / "config"
        config = json.loads(config_path.read_text())
        api_port, swarm_port = free_port(), free_port()
        while swarm_port == api_port:
            swarm_port = free_port()
        self.api = f"/ip4/127.0.0.1/tcp/{api_port}"
        self.address = f"/ip4/127.0.0.1/tcp/{swarm_port}"
        config["Addresses"].update(API=self.api, Gateway="", Swarm=[self.address],
                                   Announce=[self.address], AppendAnnounce=[], NoAnnounce=[])
        config["Bootstrap"] = []
        config["Routing"] = {"Type": "dhtserver"}
        config["Discovery"]["MDNS"]["Enabled"] = False
        config.setdefault("Peering", {})["Peers"] = []
        config.setdefault("Swarm", {})["DisableNatPortMap"] = True
        config.setdefault("Ipns", {})["UsePubsub"] = False
        config.setdefault("AutoTLS", {})["Enabled"] = False
        config_path.write_text(json.dumps(config))
        (self.repo / "swarm.key").write_text(key)
        self.peer = config["Identity"]["PeerID"]

    def cli(self, *args, daemon=True, binary_output=False, timeout=45):
        command = [str(self.binary)]
        if daemon:
            command += ["--api", self.api]
        command += ["--timeout", f"{timeout}s", *args]
        result = subprocess.run(command, env=self.env, capture_output=True, timeout=timeout + 5)
        if result.returncode:
            raise RuntimeError(f"{self.base.name}: {' '.join(args)}: {result.stderr.decode()}")
        return result.stdout if binary_output else result.stdout.decode().strip()

    def start(self):
        self.log = (self.base / "daemon.log").open("w")
        self.process = subprocess.Popen([str(self.binary), "daemon"], env=self.env,
                                        stdout=self.log, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise RuntimeError((self.base / "daemon.log").read_text())
            try:
                self.cli("id", "--format=<id>", timeout=1)
                return
            except RuntimeError:
                time.sleep(.1)
        raise RuntimeError("Daemon startup timed out")

    def stop(self):
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        if hasattr(self, "log"):
            self.log.close()

    def follow(self, names):
        config = self.base / "names.txt"
        config.write_text("\n".join(names) + "\n")
        result = subprocess.run([sys.executable, str(FOLLOWER), "sync", "--names", str(config),
                                 "--state", str(self.base / "state"), "--api", self.api,
                                 "--ipfs", str(self.binary)], env=self.env, capture_output=True,
                                text=True, timeout=120)
        if result.returncode:
            raise RuntimeError(f"Follower {self.base.name}: {result.stderr}")

    def publish(self, disk):
        config = self.base / "names.txt"
        if not config.exists():
            config.write_text("# publisher subscriptions\n")
        result = subprocess.run([sys.executable, str(FOLLOWER), "publish", str(disk), "--key", "disk",
                                 "--names", str(config), "--state", str(self.base / "state"),
                                 "--api", self.api, "--ipfs", str(self.binary)], env=self.env,
                                 capture_output=True, text=True, timeout=180)
        if result.returncode:
            raise RuntimeError("Publisher: " + result.stderr)
        return None

    def pins(self):
        return (json.loads(self.cli("pin", "ls", "--type=recursive", "--names", "--enc=json")).get("Keys") or {})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ipfs", default=os.environ.get("KUBO_BINARY", str(ROOT / "build/ipfs-tools/kubo/ipfs")))
    parser.add_argument("--output", default=str(ROOT / "build/seedbox-integration.json"))
    args = parser.parse_args()
    binary = Path(args.ipfs).resolve()
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    nodes = []
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="my98-seedbox-") as temp:
        base = Path(temp)
        key = "/key/swarm/psk/1.0.0/\n/base16/\n" + secrets.token_hex(32) + "\n"
        try:
            for name in ("publisher", "follower1", "follower2"):
                node = Node(binary, base / name, key)
                nodes.append(node)
                node.start()
            publisher, *followers = nodes
            for node in nodes:
                for other in nodes:
                    if other is not node:
                        node.cli("swarm", "connect", other.address + "/p2p/" + other.peer)
            name = publisher.cli("key", "gen", "disk")
            # Exercise the installed legacy CIDv0 case, including cleanup of
            # its exact Kubo pin rather than only the equivalent CIDv1 spelling.
            legacy_disk = base / "legacy.my98"
            legacy_disk.write_bytes(b"SLOPDSK\0" + struct.pack("<IIQ", 1, 65536, 1) + bytes(174) + bytes(63))
            legacy_cid = publisher.cli("add", "-Q", "--cid-version=0", str(legacy_disk))
            publisher.cli("name", "publish", "--key=disk", "/ipfs/" + legacy_cid)
            legacy = publisher.base / "legacy"
            legacy.mkdir()
            (legacy / "current").write_text(legacy_cid + "\n")
            (legacy / "history").write_text(legacy_cid + "\n")
            names_path = publisher.base / "names.txt"
            names_path.write_text(name + "\n")
            kubo = seedbox_tool.Kubo(str(binary), publisher.api)
            store = seedbox_tool.Store(publisher.base / "state")
            store.initialize(kubo.identity())
            seedbox_tool.Follower(store, kubo).adopt_legacy(legacy, "disk", names_path)
            assert publisher.pins()[legacy_cid]["Name"] == store.label
            versions = []
            for version in (1, 2):
                data = b"SLOPDSK\0" + struct.pack("<IIQ", 1, 65536, 400000) + bytes(174) + bytes([version]) * (400000 + 7 * 62)
                disk = base / f"version{version}.my98"
                disk.write_bytes(data)
                publisher.publish(disk)
                cid = publisher.cli("name", "resolve", "--nocache", "/ipns/" + name).removeprefix("/ipfs/")
                assert cid in publisher.pins()
                assert legacy_cid not in publisher.pins()
                if versions:
                    assert versions[-1] not in publisher.pins()
                print(f"Published version {version}: {cid}", flush=True)
                with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                    list(pool.map(lambda node: node.follow([name]), followers))
                for follower in followers:
                    pins = follower.pins()
                    assert cid in pins, pins
                    assert pins[cid]["Name"].startswith("my98-seedbox:"), pins
                    if versions:
                        assert versions[-1] not in pins, pins
                versions.append(cid)
                print(f"Both followers pinned version {version}", flush=True)
            publisher.stop()
            for follower in followers:
                assert follower.cli("cat", versions[-1], binary_output=True) == data
                # A disconnected publisher cannot affect a fully pinned local DAG.
                follower.cli("pin", "verify", "--verbose")
                follower.follow([])
                assert versions[-1] not in follower.pins()
            report = {"ok": True, "kubo": followers[0].cli("version"), "followers": 2,
                      "versions": versions, "publisherOfflineRead": True, "publicationCLI": True, "publisherRetention": True, "legacyCidV0Migration": True,
                      "removedSubscriptions": True, "privateLoopbackNetwork": True,
                      "seconds": round(time.monotonic() - started, 2)}
            output.write_text(json.dumps(report, indent=2) + "\n")
            print(json.dumps(report, indent=2))
        except Exception:
            for node in nodes:
                path = node.base / "daemon.log"
                if path.exists():
                    (output.parent / f"seedbox-{node.base.name}.log").write_text(path.read_text())
            raise
        finally:
            for node in reversed(nodes):
                node.stop()


if __name__ == "__main__":
    main()
