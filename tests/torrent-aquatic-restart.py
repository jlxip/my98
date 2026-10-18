"""Linux-only real Aquatic restart regression, on disposable loopback ports."""
import argparse
import asyncio
import json
from pathlib import Path
import socket
import sys
import tempfile
import time
import aiohttp
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'src/torrent'))
from my98_torrent.tracker import Aquatic


async def run(binary):
    with tempfile.TemporaryDirectory(prefix='my98-aquatic-restart-') as directory:
        with socket.socket() as probe:
            probe.bind(('127.0.0.1',0));port=probe.getsockname()[1]
        tracker=Aquatic(Path(directory),{'binary':str(binary.resolve()),'listen':[{'host':'127.0.0.1','port':port}]})
        results=[]
        try:
            for iteration in range(5):
                before=time.monotonic();await tracker.start(set())
                async with aiohttp.ClientSession() as client:
                    async with client.ws_connect('ws://127.0.0.1:'+str(port)) as ws:
                        await ws.send_json({'action':'announce','info_hash':'\xfe'*20,
                            'peer_id':'-MYTEST-'+'0'*12,'uploaded':0,'downloaded':0,
                            'left':1,'event':'started','numwant':0,'offers':[]})
                        response=await ws.receive_json(timeout=5)
                        assert response['failure reason']=='Info hash not allowed'
                await tracker.stop()
                # Match the exclusive deployment probe immediately after close.
                with socket.socket() as probe:
                    probe.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
                    probe.bind(('127.0.0.1',port));probe.listen(1)
                results.append({'iteration':iteration,'seconds':time.monotonic()-before})
        finally:await tracker.stop()
        print(json.dumps({'realAquatic':True,'websocketThenImmediateRestart':True,'cycles':results}),flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary',type=Path,required=True)
    asyncio.run(run(parser.parse_args().binary))
