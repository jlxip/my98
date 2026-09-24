import test from 'node:test';
import assert from 'node:assert/strict';
import {CID} from 'multiformats/cid';
import {sha256} from 'multiformats/hashes/sha2';
import {RemoteDisk} from '../web/remote.js';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const until=async f=>{for(let i=0;i<1000;i++){if(f())return;await sleep(2);}throw Error('Condition timeout');};
const raw='application/vnd.ipld.raw';
async function fixture(t,{count=24,endpoints=4,concurrency=8,timeoutMs=30000}={}) {
    const blocks=await Promise.all(Array.from({length:count},async(_,i)=>{const bytes=new Uint8Array(1024).fill(i+1);return {bytes,cid:CID.createV1(0x55,await sha256.digest(bytes))};}));
    const remote=new RemoteDisk({prefetch:{enabled:false,concurrency,trace:true},timeoutMs});
    for(let i=0;i<endpoints;i++)remote.addEndpoint(`https://p${i}.example`);
    let handler;const calls=[],active=new Map();let peak=0,perPeak=0;
    t.mock.method(globalThis,'fetch',async(url,options)=>{
        const u=new URL(url),key=u.pathname.split('/')[2],block=blocks.find(b=>b.cid.toString()===key);
        assert.ok(block);assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(options.referrerPolicy,'no-referrer');
        calls.push({host:u.host,key,options});active.set(u.host,(active.get(u.host)||0)+1);
        peak=Math.max(peak,[...active.values()].reduce((a,b)=>a+b,0));perPeak=Math.max(perPeak,active.get(u.host));
        try {
            await new Promise((resolve,reject)=>{
                const done=()=>{options.signal.removeEventListener('abort',abort);resolve();};
                const timer=setTimeout(done,10);const abort=()=>{clearTimeout(timer);reject(new DOMException('Aborted','AbortError'));};
                options.signal.addEventListener('abort',abort,{once:true});if(options.signal.aborted)abort();
            });
            return handler ? await handler(u,block,options) : new Response(block.bytes,{headers:{'Content-Type':raw}});
        }finally{active.set(u.host,active.get(u.host)-1);}
    });
    t.after(()=>remote.close());
    const get=async(i,priority='demand',signal)=>{for await(const b of remote.get(blocks[i].cid,{priority,signal}))return b;};
    return {remote,blocks,calls,get,setHandler:f=>handler=f,metrics:()=>({peak,perPeak})};
}
test('eight global slots, initially two per normalized endpoint, and one transfer per CID',async t=>{
    const f=await fixture(t);f.remote.addEndpoint('https://P0.example:443/');
    assert.equal(f.remote.endpoints.size,4);
    await Promise.all([...Array.from({length:20},(_,i)=>f.get(i)),f.get(0)]);
    assert.deepEqual(f.metrics(),{peak:8,perPeak:2});assert.equal(f.calls.length,20);
    assert.equal(f.remote.stats().endpoints.reduce((n,e)=>n+e.validBytes,0),20*1024);
});
test('background admission stays at eight unique blocks and cancellation drains waiters',async t=>{
    const f=await fixture(t);const controller=new AbortController();
    const reads=Array.from({length:24},(_,i)=>f.get(i,'background',controller.signal).catch(e=>e.code));
    assert.equal(f.remote.jobs.size,8);assert.ok(f.remote.admissionWaiters.size);
    controller.abort();assert.ok((await Promise.all(reads)).every(x=>x==='CANCELLED'));
    await until(()=>!f.remote.jobs.size && !f.remote.admissionWaiters.size);
});
test('demand jumps ahead of queued background work; shared cancellation leaves demand intact',async t=>{
    const f=await fixture(t,{concurrency:1,endpoints:1});const c=new AbortController();
    const a=f.get(0,'background'),b=f.get(1,'background'),shared=f.get(2,'background',c.signal).catch(e=>e.code);
    const demand=f.get(2);c.abort();
    await Promise.all([a,b,demand]);assert.equal(await shared,'CANCELLED');
    assert.deepEqual(f.calls.map(x=>x.key),[0,2,1].map(i=>f.blocks[i].cid.toString()));
    assert.equal(f.calls.filter(x=>x.key===f.blocks[2].cid.toString()).length,1);
});
test('corrupt, wrong MIME and oversized gateways are excluded; valid bytes alone enter cache',async t=>{
    const f=await fixture(t);
    f.setHandler((u,b)=>u.host==='p0.example'?new Response(new Uint8Array(1024),{headers:{'Content-Type':raw}}):u.host==='p1.example'?new Response(b.bytes):u.host==='p2.example'?new Response(b.bytes,{headers:{'Content-Type':raw,'Content-Length':5*1024*1024}}):new Response(b.bytes,{headers:{'Content-Type':raw}}));
    assert.deepEqual(await f.get(0),f.blocks[0].bytes);
    assert.deepEqual(f.remote.stats().endpoints.map(e=>e.excluded),[true,true,true,false]);
    assert.equal(f.remote.cacheBytes,1024);await f.get(1);assert.equal(f.calls.at(-1).host,'p3.example');
});
test('404 fails only this block; later requests can reuse the endpoint',async t=>{
    const f=await fixture(t,{endpoints:2});
    f.setHandler((u,b)=>u.host==='p0.example' && b===f.blocks[0]?new Response(null,{status:404}):new Response(b.bytes,{headers:{'Content-Type':raw}}));
    await f.get(0);await f.get(1);
    assert.equal(f.remote.endpoints.get('https://p0.example').excluded,false);
    assert.equal(f.remote.endpoints.get('https://p0.example').cooldownUntil,0);
    assert.equal(f.calls.filter(c=>c.key===f.blocks[0].cid.toString()).length,2);
});
test('initial Discovery may deliver a late provider; no new query round is started',async t=>{
    const f=await fixture(t,{endpoints:1});f.remote.discovery.state='running';
    f.setHandler((u,b)=>u.host==='p0.example'?new Response(null,{status:404}):new Response(b.bytes,{headers:{'Content-Type':raw}}));
    const pending=f.get(0);await until(()=>f.remote.jobs.get(f.blocks[0].cid.toString())?.state==='queued');
    f.remote.addEndpoint('https://p1.example');f.remote.schedule();await pending;
    assert.equal(f.calls.length,2);assert.equal(f.remote.discovery.state,'running');
});
test('exhaustion rejects promptly, explicit retry reuses known providers',async t=>{
    const f=await fixture(t,{endpoints:2});f.setHandler(()=>new Response(null,{status:404}));
    await assert.rejects(f.get(0),{code:'IO_ERROR'});assert.equal(f.calls.length,2);
    f.setHandler(undefined);await f.get(0);assert.equal(f.remote.endpoints.size,2);
});
test('transient failure cools the endpoint, uses another, then a valid response resets it',async t=>{
    const f=await fixture(t,{endpoints:2});f.setHandler((u,b)=>u.host==='p0.example'?new Response(null,{status:503}):new Response(b.bytes,{headers:{'Content-Type':raw}}));
    await f.get(0);const e=f.remote.endpoints.get('https://p0.example');assert.ok(e.cooldownUntil>Date.now());assert.equal(e.consecutive,1);
    f.remote.endpoints.get('https://p1.example').excluded=true;f.setHandler(undefined);
    await f.get(1);assert.equal(e.cooldownUntil,0);assert.equal(e.consecutive,0);
});
test('waiting for late discovery respects the total block deadline',async t=>{
    const f=await fixture(t,{endpoints:1,timeoutMs:80});f.remote.discovery.state='running';f.setHandler(()=>new Response(null,{status:404}));
    const start=Date.now();await assert.rejects(f.get(0),{code:'IO_ERROR'});assert.ok(Date.now()-start>=70 && Date.now()-start<500);assert.equal(f.calls.length,1);
});
test('stalled response body is rescued before the ordinary five-second timeout',async t=>{
    const f=await fixture(t,{endpoints:2});f.setHandler((u,b,options)=>u.host==='p0.example'?new Response(new ReadableStream({start(c){options.signal.addEventListener('abort',()=>c.error(new Error('aborted')),{once:true});}}),{headers:{'Content-Type':raw}}):new Response(b.bytes,{headers:{'Content-Type':raw}}));
    const start=Date.now();await f.get(0);assert.ok(Date.now()-start>=700 && Date.now()-start<2500);assert.equal(f.calls.length,2);
    assert.equal(f.remote.trace.filter(e=>e.type==='fetch-rescue').length,1);
});
test('a response making steady progress is not rescued just for lasting longer than 750ms',async t=>{
    const f=await fixture(t,{endpoints:2});
    f.setHandler((u,b,options)=>new Response(new ReadableStream({async start(c){
        for(let offset=0;offset<b.bytes.length;offset+=128){await sleep(110);if(options.signal.aborted){c.error(Error('aborted'));return;}c.enqueue(b.bytes.slice(offset,offset+128));}c.close();
    }}),{headers:{'Content-Type':raw}}));
    assert.deepEqual(await f.get(0),f.blocks[0].bytes);assert.equal(f.calls.length,1);
    assert.equal(f.remote.trace.filter(e=>e.type==='fetch-rescue').length,0);
});
test('cancelled late responses do not refill the cache or update measurements',async t=>{
    const f=await fixture(t,{endpoints:1});let release;
    f.setHandler((u,b)=>new Promise(r=>{release=()=>r(new Response(b.bytes,{headers:{'Content-Type':raw}}));}));
    const pending=f.get(0).catch(e=>e.code);await until(()=>release);f.remote.clearCache();release();assert.equal(await pending,'CANCELLED');await sleep(30);
    assert.equal(f.remote.cacheBytes,0);assert.equal(f.remote.stats().endpoints[0].validBytes,0);assert.equal(f.remote.trace.filter(e=>e.type==='fetch-end').length,0);
    f.setHandler(undefined);await f.get(0);assert.equal(f.remote.cacheBytes,1024);
});
test('supported concurrency bounds and direct modes stay exclusive',async t=>{
    for(const concurrency of [1,2,3,4,5,6,7,8]){const r=new RemoteDisk({onlyLocalhost:true,prefetch:{concurrency}});assert.equal(r.endpoints.size,1);r.close();}
    for(const concurrency of [0,9,1.5,NaN])assert.throws(()=>new RemoteDisk({prefetch:{concurrency}}));
    const f=await fixture(t,{endpoints:1});await Promise.all([0,1,2,3].map(i=>f.get(i)));assert.equal(f.metrics().peak,2);
});
test('streamed byte limit excludes an oversized provider without retaining its payload',async t=>{
    const f=await fixture(t,{endpoints:2});
    f.setHandler((u,b)=>u.host==='p0.example'?new Response(new Uint8Array(4*1024*1024+1),{headers:{'Content-Type':raw}}):new Response(b.bytes,{headers:{'Content-Type':raw}}));
    await f.get(0);assert.equal(f.remote.cacheBytes,1024);assert.equal(f.remote.stats().endpoints[0].excluded,true);
});
test('faster verified providers receive more useful work within their two slots',async t=>{
    const f=await fixture(t,{endpoints:2,count:40});
    f.setHandler(async(u,b)=>{if(u.host==='p1.example')await sleep(60);return new Response(b.bytes,{headers:{'Content-Type':raw}});});
    await Promise.all(Array.from({length:40},(_,i)=>f.get(i)));
    const [fast,slow]=f.remote.stats().endpoints;assert.ok(fast.validBytes>slow.validBytes);assert.ok(fast.bytesPerMs>slow.bytesPerMs);assert.equal(f.metrics().perPeak,2);
});
test('CIDv0 and CIDv1 aliases deduplicate the same SHA256 block',async t=>{
    const f=await fixture(t,{endpoints:1});const cid=CID.createV1(0x70,await sha256.digest(f.blocks[0].bytes));f.blocks[0].cid=cid;
    const read=async c=>{for await(const b of f.remote.get(c))return b;};
    await Promise.all([read(cid),read(cid.toV0())]);assert.equal(f.calls.length,1);assert.equal(f.remote.cacheBytes,1024);
});
test('cancelling a demand consumer restores background priority without enlarging its window',async t=>{
    const f=await fixture(t,{concurrency:1,endpoints:1});const c=new AbortController();
    const a=f.get(0,'background'),b=f.get(1,'background');const cancelled=f.get(1,'demand',c.signal).catch(e=>e.code);
    c.abort();assert.equal(await cancelled,'CANCELLED');assert.equal(f.remote.jobs.get(f.blocks[1].cid.toString()).priority,'background');
    const demand=f.get(2);await Promise.all([a,b,demand]);assert.deepEqual(f.calls.map(x=>x.key),[0,2,1].map(i=>f.blocks[i].cid.toString()));
});
