#!/usr/bin/env python3
"""Publication lifecycle in three private loopback Kubo nodes."""
import argparse
import concurrent.futures
import json
import secrets
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from seedbox_integration import Node, ROOT
import seedbox as s


def state_bytes(base, value):
    header = json.dumps(dict(version=1, base=list(base[:198]), nonce=[value]*16, raw=100, packed=100), separators=(',', ':')).encode()
    return b'MY98STAT' + struct.pack('<I', len(header)) + header + bytes([value])*162


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--ipfs', default=str(ROOT/'build/ipfs-tools/kubo/ipfs'))
    parser.add_argument('--output', default=str(ROOT/'build/seedbox-state-integration.json'))
    args = parser.parse_args()
    nodes=[]
    with tempfile.TemporaryDirectory(prefix='my98-state-integration-') as temporary:
        base=Path(temporary)
        key='/key/swarm/psk/1.0.0/\n/base16/\n'+secrets.token_hex(32)+'\n'
        try:
            for name in ['publisher','replica1','replica2']:
                node=Node(Path(args.ipfs),base/name,key);nodes.append(node);node.start()
            publisher,*replicas=nodes
            for node in nodes:
                for other in nodes:
                    if node is not other: node.cli('swarm','connect',other.address+'/p2p/'+other.peer)
            name=publisher.cli('key','gen','disk')
            namefile=publisher.base/'names.txt';namefile.write_text(name+'\n')
            kubo=s.Kubo(args.ipfs,publisher.api);store=s.Store(publisher.base/'state');store.initialize(kubo.identity())
            f=s.Follower(store,kubo)
            disk=base/'base.my98'
            disk.write_bytes(b'SLOPDSK\0'+struct.pack('<IIQ',1,65536,400000)+bytes(174)+bytes(400000+7*62))
            def wait(): time.sleep(1.05)  # Existing UTC-second publication sequence contract.
            def replicate():
                with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                    list(pool.map(lambda n:n.follow([name]),replicas))
            assert f.publish(disk,'disk',namefile)
            diskcid=store.row(name)['current'];replicate()
            assert kubo.publication_parts(diskcid)[0]==diskcid
            roots=[]
            for version in (1,2):
                state=base/f'{version}.my98state';state.write_bytes(state_bytes(disk.read_bytes(),version))
                wait()
                if version == 1:
                    result=subprocess.run([sys.executable,str(ROOT/'scripts/seedbox.py'),'publish-state',str(state),'--key','disk','--names',str(namefile),'--state',str(store.directory),'--api',publisher.api,'--ipfs',args.ipfs],capture_output=True,text=True,timeout=180)
                    assert result.returncode == 0, result.stderr
                else:
                    assert f.publish_state(state,'disk',namefile)
                root=store.row(name)['current'];roots.append(root)
                assert root!=diskcid and kubo.publication_parts(root)[0]==diskcid
                replicate()
                for node in nodes:
                    assert root in node.pins()
                    assert node.cli('cat','/ipfs/'+root+'/disk.my98',binary_output=True)==disk.read_bytes()
                    assert node.cli('cat','/ipfs/'+root+'/state.my98state',binary_output=True)==state.read_bytes()
                if version==2:
                    assert all(roots[0] not in node.pins() for node in nodes)
            # Reject wrong base/truncation before changing published root.
            for bad in (state_bytes(bytes(198),3),state.read_bytes()[:-1]):
                invalid=base/'bad.my98state';invalid.write_bytes(bad)
                try: f.publish_state(invalid,'disk',namefile)
                except s.Failure: pass
                else: raise AssertionError('invalid state accepted')
                assert store.row(name)['current']==roots[-1]
            # Explicit clearing, then idempotent clearing, and republishing state.
            wait();assert f.publish_state(None,'disk',namefile);replicate()
            assert store.row(name)['current']==diskcid
            seq=store.row(name)['seen_sequence'];assert f.publish_state(None,'disk',namefile)
            assert store.row(name)['seen_sequence']==seq
            wait();assert f.publish_state(state,'disk',namefile);replicate()
            root=store.row(name)['current']
            # Share only the fixture signing key, then renew the directory at same sequence.
            pem=base/'fixture.pem';publisher.cli('key','export','disk','-o',str(pem),daemon=False)
            replicas[0].cli('key','import','disk',str(pem),daemon=False);pem.unlink()
            publisher.stop()
            for replica in replicas:
                replica.cli('repo','gc')
                assert replica.cli('cat','/ipfs/'+root+'/disk.my98',binary_output=True)==disk.read_bytes()
                assert replica.cli('cat','/ipfs/'+root+'/state.my98state',binary_output=True)==state.read_bytes()
                replica.cli('pin','verify','--verbose')
            rk=s.Kubo(args.ipfs,replicas[0].api);rs=s.Store(replicas[0].base/'state');rs.initialize(rk.identity())
            before=rs.row(name)['seen_sequence'];rs.update(name,renewed_at='2000-01-01T00:00:00+00:00')
            assert s.Follower(rs,rk).sync([name])
            assert rs.row(name)['seen_sequence']==before and rs.row(name)['renewed_sequence']==before
            report=dict(ok=True,kubo=replicas[0].cli('version'),roots=roots,diskCid=diskcid,twoReplicas=True,offlineAfterGC=True,sameSequenceRenewal=True,replaceAndClear=True,invalidStateRejected=True)
            Path(args.output).write_text(json.dumps(report,indent=2)+'\n')
            print(json.dumps(report,indent=2))
        finally:
            for node in reversed(nodes): node.stop()

if __name__=='__main__': main()
