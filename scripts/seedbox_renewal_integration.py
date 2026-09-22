#!/usr/bin/env python3
"""Shared-key renewal and rollback regression on private loopback Kubo nodes."""
import argparse
import json
import os
from pathlib import Path
import secrets
import tempfile
import time
from unittest import mock
import seedbox as s
from seedbox_integration import Node


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ipfs", default=os.environ.get("KUBO_BINARY", str(Path(__file__).resolve().parent.parent / "build/ipfs-tools/kubo/ipfs")))
    args = parser.parse_args()
    nodes = []
    with tempfile.TemporaryDirectory(prefix="my98-renewal-") as temporary:
        root = Path(temporary)
        secret = "/key/swarm/psk/1.0.0/\n/base16/\n" + secrets.token_hex(32) + "\n"
        try:
            for label in ("publisher", "replica"):
                node = Node(Path(args.ipfs), root / label, secret)
                config_path = node.repo / "config"
                config = json.loads(config_path.read_text())
                config["Ipns"]["DelegatedPublishers"] = []
                config_path.write_text(json.dumps(config))
                nodes.append(node)
                node.start()
            publisher, replica = nodes
            for a, b in ((publisher, replica), (replica, publisher)):
                a.cli("swarm", "connect", b.address + "/p2p/" + b.peer)
            name = publisher.cli("key", "gen", "disk")
            private = root / "key"
            publisher.cli("key", "export", "disk", "--output=" + str(private), daemon=False)
            os.chmod(private, 0o600)
            replica.cli("key", "import", "disk", str(private))
            private.unlink()
            old = root / "old"
            old.write_bytes(b"old disk")
            old_cid = replica.cli("add", "-Q", "--cid-version=1", str(old))
            replica.cli("name", "publish", "--key=disk", "/ipfs/" + old_cid)
            old_record = replica.cli("routing", "get", "/ipns/" + name, binary_output=True)
            new = root / "new"
            new.write_bytes(b"new disk" * 10000)
            new_cid = publisher.cli("add", "-Q", "--cid-version=1", str(new))
            # The original publisher expires quickly. The replica must take over
            # renewal at exactly this sequence, not publish a fresh update.
            publisher.cli("name", "publish", "--key=disk", "--sequence=20260915121758",
                          "--lifetime=8s", "/ipfs/" + new_cid)
            kubo = s.Kubo(str(args.ipfs), replica.api)
            store = s.Store(replica.base / "state")
            store.initialize(replica.peer)
            follower = s.Follower(store, kubo)
            assert follower.sync([name]), store.status()
            assert store.row(name)["seen_sequence"] == "20260915121758"
            assert store.row(name)["current"] == new_cid
            assert replica.cli("name", "resolve", "--nocache", name) == "/ipfs/" + new_cid
            publisher.stop()
            time.sleep(9)
            record = kubo.resolve_record(name)
            assert record == {"cid": new_cid, "sequence": "20260915121758"}, record
            # Reopen state and force a scheduled renewal. It must remain the same
            # version even when Kubo rejects an explicit equal sequence.
            store = s.Store(replica.base / "state")
            store.initialize(replica.peer)
            follower = s.Follower(store, kubo)
            store.update(name, renewed_at="2000-01-01T00:00:00+00:00")
            assert follower.sync([name]), store.status()
            assert kubo.resolve_record(name) == record
            # Present the actual older signed, unexpired record to the adapter.
            # Real signature validation remains active; only network lookup is replaced.
            original = kubo.call
            def call(*a, **kw):
                if a[:2] == ("routing", "get"):
                    return old_record
                return original(*a, **kw)
            with mock.patch.object(kubo, "call", side_effect=call):
                assert not follower.sync([name])
            assert store.row(name)["current"] == new_cid
            assert "rollback" in store.row(name)["error"]
            assert new_cid in replica.pins()
            assert follower.sync([name]), store.status()
            replica.stop()
            replica.start()
            assert kubo.resolve_record(name) == record
            replica.cli("pin", "verify")
            print(json.dumps({"sharedKeyAlignment": True, "publisherOfflinePastExpiry": True,
                "sameSequenceRenewal": True, "signedRollbackRejected": True,
                "restart": True, "pinVerified": True, "sequence": record["sequence"]}))
        finally:
            for node in nodes:
                node.stop()


if __name__ == "__main__":
    main()
