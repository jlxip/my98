import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {setImmediate as idle} from 'node:timers/promises';
import {WindowTorrents} from '../src/disk/web/torrent-window.js';
const raw=Buffer.concat([Buffer.from('d6:lengthi1e4:name9:disk.my9812:piece lengthi262144e6:pieces20:'),Buffer.alloc(20,1),Buffer.from('e')]);
const hash=createHash('sha1').update(raw).digest('hex'),metadata=Buffer.concat([Buffer.from('d4:info'),raw,Buffer.from('e')]);
function fixture({peer='pending',apis=['http://127.0.0.1:12345'],trackers=['ws://127.0.0.1:12345/tracker'],timeout=10000}={}) {
    const probes=[];
    class Client extends EventEmitter {
        static WEBRTC_SUPPORT=true;
        add(value,options) {
            assert.equal(value,hash);assert.equal(options.deselect,true);
            const probe=new EventEmitter();probe.metadata=peer==='invalid'?Buffer.from('de'):metadata;
            probe.destroy=(options,done)=>{probe.destroyed=true;queueMicrotask(done);};probes.push(probe);
            if(peer!=='pending')queueMicrotask(()=>probe.emit('metadata'));
            return probe;
        }
        destroy(done){this.destroyed=true;queueMicrotask(done);}
    }
    return {client:new WindowTorrents({sources:{apis,trackers,webseeds:[]},clientFactory:async()=>Client,timeout}),probes};
}
async function use(options,fetcher,run) {
    const original=globalThis.fetch,{client,probes}=fixture(options);globalThis.fetch=fetcher;
    try {await run(client,probes);}
    finally {await client.close();globalThis.fetch=original;}
}

test('verified HTTP metadata does not wait for an unreachable RTC peer',async()=>{
    let requests=0;
    await use({},async()=>{requests++;return new Response(raw);},async(client,probes)=>{
        const start=performance.now();assert.deepEqual(await client.discoverMetadata(hash,'disk'),new Uint8Array(metadata));
        assert(performance.now()-start<1500,'HTTP still waits for the RTC timeout');
        assert.equal(requests,1);assert.equal(probes.length,1);assert(probes[0].destroyed);assert.equal(client.discoveries.size,0);
    });
});

test('verified RTC metadata aborts a pending HTTP request before returning',async()=>{
    let aborted=false;
    await use({peer:'valid'},(url,{signal})=>new Promise((resolve,reject)=>{
        signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true});
    }),async(client,probes)=>{
        assert.deepEqual(await client.discoverMetadata(hash,'disk'),new Uint8Array(metadata));
        assert(aborted);assert(probes[0].destroyed);assert.equal(client.discoveries.size,0);
    });
});

test('an invalid path cannot win over verified metadata; two invalid paths reject',async()=>{
    await use({peer:'valid'},async()=>new Response('de'),async(client)=>{
        assert.deepEqual(await client.discoverMetadata(hash,'disk'),new Uint8Array(metadata));
    });
    await use({peer:'invalid'},async()=>new Response('de'),async(client,probes)=>{
        await assert.rejects(client.discoverMetadata(hash,'disk'),{code:'INVALID_PUBLICATION'});
        assert(probes[0].destroyed);assert.equal(client.discoveries.size,0);
    });
});

test('WebRTC-only metadata discovery retains its independent working path',async()=>{
    await use({peer:'valid',apis:[]},async()=>{throw Error('Unexpected HTTP request');},async(client,probes)=>{
        assert.deepEqual(await client.discoverMetadata(hash,'disk'),new Uint8Array(metadata));assert(probes[0].destroyed);
    });
});

test('cancelling parallel discovery aborts HTTP and destroys the metadata-only peer',async()=>{
    let ready,aborted=false;const started=new Promise(resolve=>{ready=resolve;});
    await use({},(url,{signal})=>new Promise((resolve,reject)=>{
        ready();signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true});
    }),async(client,probes)=>{
        const opening=client.discoverMetadata(hash,'disk');await started;client.cancel();
        await assert.rejects(opening,{code:'CANCELLED'});assert(aborted);assert(probes[0].destroyed);assert.equal(client.discoveries.size,0);
    });
});


test('all HTTP sources race: a slow first source and invalid reply cannot block a later valid one',async()=>{
    const apis=['http://127.0.0.1:12345','http://127.0.0.1:12346','http://127.0.0.1:12347'];
    const called=[];let slowCompleted=false,slowAborted=false;
    await use({apis,trackers:[]},(url,{signal})=>{
        called.push(url);
        if(url.startsWith(apis[0]+'/'))return new Promise((resolve,reject)=>{
            const abort=()=>{clearTimeout(timer);slowAborted=true;reject(signal.reason);};
            const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);slowCompleted=true;resolve(new Response(raw));},200);
            signal.addEventListener('abort',abort,{once:true});
        });
        return Promise.resolve(new Response(url.startsWith(apis[1]+'/')?'de':raw));
    },async(client)=>{
        assert.deepEqual(await client.discoverMetadata(hash,'disk'),new Uint8Array(metadata));
        assert.equal(called.length,3);assert.equal(new Set(called).size,3);
        assert(slowAborted);assert(!slowCompleted);assert.equal(client.discoveries.size,0);
    });
});

test('all invalid or unavailable HTTP sources reject and release error response bodies',async()=>{
    const apis=['http://127.0.0.1:12345','http://127.0.0.1:12346','http://127.0.0.1:12347'];let called=0,cancelled=0;
    await use({apis,trackers:[]},async url=>{
        called++;
        if(url.startsWith(apis[0]+'/'))return new Response('de');
        return new Response(new ReadableStream({cancel(){cancelled++;}}),{status:503});
    },async(client)=>{
        await assert.rejects(client.discoverMetadata(hash,'disk'),{code:'INVALID_PUBLICATION'});
        assert.equal(called,3);assert.equal(cancelled,2);assert.equal(client.discoveries.size,0);
    });
});

test('cancelling discovery aborts every parallel HTTP source and the metadata-only peer',async()=>{
    const apis=['http://127.0.0.1:12345','http://127.0.0.1:12346','http://127.0.0.1:12347'];
    let ready,aborted=0,called=0;const started=new Promise(resolve=>{ready=resolve;});
    await use({apis},(url,{signal})=>new Promise((resolve,reject)=>{
        called++;ready();signal.addEventListener('abort',()=>{aborted++;reject(signal.reason);},{once:true});
    }),async(client,probes)=>{
        const opening=client.discoverMetadata(hash,'disk').then(()=>null,error=>error);
        await started;assert.equal(called,3);client.cancel();
        assert.equal((await opening).code,'CANCELLED');assert.equal(aborted,3);assert(probes[0].destroyed);assert.equal(client.discoveries.size,0);
    });
});

test('unavailable HTTPS does not shorten the WebRTC metadata deadline',async t=>{
    t.mock.timers.enable({apis:['setTimeout']});
    await use({},async()=>new Response(null,{status:503}),async(client,probes)=>{
        const opening=client.discoverMetadata(hash,'disk');await idle();
        t.mock.timers.tick(5500);await idle();assert(!probes[0].destroyed);
        probes[0].emit('metadata');assert.deepEqual(await opening,new Uint8Array(metadata));
    });
});

test('the HTTP deadline aborts only HTTP while a slower WebRTC lookup succeeds',async t=>{
    t.mock.timers.enable({apis:['setTimeout']});let aborted=false;
    await use({timeout:60000},(_url,{signal})=>new Promise((resolve,reject)=>{
        signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true});
    }),async(client,probes)=>{
        const opening=client.discoverMetadata(hash,'disk');await idle();
        t.mock.timers.tick(10001);await idle();assert(aborted);assert(!probes[0].destroyed);
        probes[0].emit('metadata');assert.deepEqual(await opening,new Uint8Array(metadata));
    });
});

test('late HTTPS sources can complete metadata discovery without WebRTC',async()=>{
    let requests=0;
    await use({apis:[],trackers:[]},async()=>{requests++;return new Response(raw);},async client=>{
        client.deferSources();const opening=client.discoverMetadata(hash,'disk');await idle();assert.equal(requests,0);
        client.setSources({apis:['http://127.0.0.1:12345'],trackers:[],webseeds:[]});
        assert.deepEqual(await opening,new Uint8Array(metadata));assert.equal(requests,1);
    });
});

test('WebRTC completes while optional HTTPS sources remain pending',async()=>{
    await use({apis:[],peer:'valid'},async()=>{throw Error('Unexpected HTTPS lookup');},async(client,probes)=>{
        client.deferSources();assert.deepEqual(await client.discoverMetadata(hash,'disk'),new Uint8Array(metadata));
        assert(probes[0].destroyed);
    });
});

test('cancelling while waiting for HTTPS sources prevents late requests',async()=>{
    let requests=0;
    await use({apis:[],trackers:[]},async()=>{requests++;return new Response(raw);},async client=>{
        client.deferSources();const opening=client.discoverMetadata(hash,'disk');await idle();client.cancel();
        await assert.rejects(opening,{code:'CANCELLED'});
        client.setSources({apis:['http://127.0.0.1:12345'],trackers:[],webseeds:[]});await idle();assert.equal(requests,0);
    });
});

test('late webseeds join existing torrents only after the reachability check',async()=>{
    const added=[];
    await use({apis:[],trackers:[]},async url=>new Response(null,{status:url.includes('/reachable/')?200:503}),async client=>{
        const entry={infoHash:hash,filename:'disk.my98',size:1,torrent:{ready:true,addWebSeed:url=>added.push(url)}};
        client.entries.set(hash,entry);
        client.setSources({apis:[],trackers:[],webseeds:['http://127.0.0.1:12345/reachable','http://127.0.0.1:12345/unavailable']});
        await idle();assert.deepEqual(added,['http://127.0.0.1:12345/reachable/'+hash+'/disk.my98']);
        client.entries.clear();
    });
});
