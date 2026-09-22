import test from 'node:test';
import assert from 'node:assert/strict';
import {CID} from 'multiformats/cid';
import {base58btc} from 'multiformats/bases/base58';
import {base36} from 'multiformats/bases/base36';
import {sha256} from 'multiformats/hashes/sha2';
import {create as digest} from 'multiformats/hashes/digest';
import {generateKeyPair} from '@libp2p/crypto/keys';
import {createIPNSRecord,marshalIPNSRecord} from 'ipns';
import {advertisedGateway,discoverProviders,DISCOVERY_LIMITS as L} from '../web/discovery.js';
import {discoveryServers} from '../web/network-config.js';
import {RemoteDisk} from '../web/remote.js';

const bytes = new Uint8Array(512);bytes[0]=42;
const root = CID.createV1(0x55,await sha256.digest(bytes));
const peerIds = await Promise.all(Array.from({length:120},async(_,i)=>CID.createV1(0x72,await sha256.digest(new Uint8Array([i]))).toString()));
const peer = (i,Addrs=[addr(i)]) => ({Schema:'peer',ID:peerIds[i],Addrs});
const addr = i=>`/dns4/p${i}.example.com/tcp/443/tls/http`;
const service = i=>({url:`https://r${i}.example.com`,resolution:false,discovery:true});
const json = (value,type='application/json')=>new Response(JSON.stringify(value),{headers:{'Content-Type':type}});
const raw = (body=bytes)=>new Response(body,{headers:{'Content-Type':'application/vnd.ipld.raw'}});
const pause = ms=>new Promise(r=>setTimeout(r,ms));
function stub(t, handler) {
    const seen=[];t.mock.method(globalThis,'fetch',async(url,options)=>{
        seen.push({url:String(url),options});return handler(String(url),options,seen);
    });return seen;
}
function delayed(value,ms,signal) {
    return new Promise((resolve,reject)=>{
        const stop=()=>{clearTimeout(timer);reject(new DOMException('Aborted','AbortError'));};
        const timer=setTimeout(()=>{signal?.removeEventListener('abort',stop);resolve(value);},ms);
        signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
    });
}
function stream(parts,signal,{hang=false,delay=0}={}) {
    let i=0;
    return new Response(new ReadableStream({
        start(c){signal?.addEventListener('abort',()=>{try{c.error(new DOMException('Aborted','AbortError'));}catch{}},{once:true});},
        async pull(c){if(i<parts.length){if(delay)await pause(delay);try{c.enqueue(new TextEncoder().encode(parts[i++]));}catch{}}else if(!hang)c.close();},
    }),{headers:{'Content-Type':'application/x-ndjson'}});
}

test('capability filtering, endpoint deduplication and validation precede traffic',async t=>{
    const both={...service(0),resolution:'routing'};
    const resolutionOnly={...service(1),resolution:'gateway',discovery:false};
    const inactive={...service(3),discovery:false};
    assert.deepEqual(discoveryServers([resolutionOnly,both,inactive,service(2),{...both,url:both.url+'/',resolution:'gateway'}]),
        [both,service(2)]);
    const seen=stub(t,()=>{throw Error('No traffic expected');});
    for(const servers of [[],Array(17).fill(service(0)),[{...service(0),discovery:false}],[{...service(0),discovery:'yes'}],[{...service(0),url:'http://public.example.com'}]]) {
        await assert.rejects(discoverProviders(root,{servers}),e=>e.code==='IO_ERROR');
    }
    await assert.rejects(discoverProviders('not-a-cid',{servers:[service(0)]}),e=>e.code==='INVALID_CID');
    await assert.rejects(discoverProviders(CID.createV1(0x55,digest(0x13,new Uint8Array(64))),{servers:[service(0)]}),e=>e.code==='UNSUPPORTED_FORMAT');
    assert.equal(seen.length,0);
});
test('advertised HTTPS parsing rejects private, local, ambiguous and non-HTTP addresses',()=>{
    assert.equal(advertisedGateway(addr(0)), 'https://p0.example.com');
    assert.equal(advertisedGateway('/dns/example.com/tcp/8443/https'),'https://example.com:8443');
    assert.equal(advertisedGateway('/ip4/8.8.8.8/tcp/443/tls/http'),'https://8.8.8.8');
    assert.equal(advertisedGateway('/ip6/2606:4700:4700::1111/tcp/443/https'),'https://[2606:4700:4700::1111]');
    const legacy=base58btc.encode(CID.parse(peerIds[0]).multihash.bytes).slice(1);
    assert.equal(advertisedGateway(addr(0)+'/p2p/'+legacy,peerIds[0]),'https://p0.example.com');
    assert.equal(advertisedGateway(addr(0)+'/p2p/'+legacy,peerIds[1]),undefined);
    for(const host of ['127.0.0.1','10.2.3.4','172.16.1.1','192.168.1.1','169.254.169.254','100.64.1.1','192.0.2.1','198.18.0.1','203.0.113.1','224.0.0.1','0.0.0.0'])assert.equal(advertisedGateway(`/ip4/${host}/tcp/443/https`),undefined,host);
    for(const host of ['::1','::','fc00::1','fe80::1','::ffff:127.0.0.1','2001:db8::1','2002:7f00:1::','3fff::1'])assert.equal(advertisedGateway(`/ip6/${host}/tcp/443/https`),undefined,host);
    for(const host of ['localhost','a.localhost','localhost.','a.local','a.localdomain','router','a.home.arpa','a.internal','a.test','127.1','0x7f000001','2130706433'])assert.equal(advertisedGateway(`/dns4/${host}/tcp/443/https`),undefined,host);
    for(const suffix of ['','/ws','/tls/ws','/http','/tls','/quic-v1','/https/p2p-circuit'])assert.equal(advertisedGateway('/dns4/example.com/tcp/443'+suffix),undefined,suffix);
    assert.equal(advertisedGateway('/dns4/example.com/tcp/0/https'),undefined);
});
test('streaming starts probes before routing ends and merges complementary/duplicate records',async t=>{
    const legacy=base58btc.encode(CID.parse(peerIds[0]).multihash.bytes).slice(1),delivered=[];
    const seen=stub(t,(url,{signal})=>{
        if(url.startsWith(service(0).url)) return stream([JSON.stringify(peer(0))+'\n',JSON.stringify({...peer(0),Addrs:[addr(1)]})+'\n'],signal,{delay:40});
        if(url.startsWith(service(1).url))return delayed(json({Providers:[{...peer(0),ID:legacy},{...peer(0),ID:CID.parse(peerIds[0]).toString(base36)},peer(2)]}),250,signal);
        return raw();
    });
    const start=performance.now();
    const result=await discoverProviders(root,{servers:[service(0),service(1)],onProvider:(p,b)=>delivered.push({p,b,ms:performance.now()-start})});
    assert(delivered[0].ms<200);assert.equal(result.providers.length,2);assert.equal(result.verifiedEndpoints,3);
    const p=result.providers.find(p=>p.peerId===peerIds[0]);assert.deepEqual(p.addresses,[addr(0),addr(1)]);assert.equal(p.sources.length,2);assert.equal(p.gateways.length,2);
    assert(delivered.some(e=>e.p.sources.length===2));assert.deepEqual(delivered.find(e=>e.b).b.rootBlock,bytes);
    assert.equal(seen.filter(x=>x.url.startsWith('https://p0.')).length,1);
    for(const {options:o} of seen){assert.equal(o.credentials,'omit');assert.equal(o.redirect,'error');assert.equal(o.referrerPolicy,'no-referrer');assert.equal(o.cache,'no-store');}
});
test('CIDv0 queries normalize to CIDv1 without changing requested content',async t=>{
    const cid=CID.createV0(root.multihash),seen=stub(t,url=>url.includes('/providers/')?json({Providers:[peer(0)]}):raw());
    const result=await discoverProviders(cid.toString(),{servers:[service(0)]});assert.equal(result.verifiedEndpoints,1);
    assert(seen.every(x=>x.url.includes(cid.toV1().toString())));
});
test('identity multihash roots and embedded-key Peer IDs keep existing hash semantics',async t=>{
    const key=await generateKeyPair('Ed25519'),id=base58btc.encode(key.publicKey.toCID().multihash.bytes).slice(1);
    stub(t,url=>url.includes('/providers/')?json({Providers:[{...peer(0),ID:id}]}):raw());
    const inline=CID.createV1(0x55,digest(0,bytes)),result=await discoverProviders(inline,{servers:[service(0)]});
    assert.equal(result.verifiedEndpoints,1);assert.equal(result.providers[0].peerId,key.publicKey.toCID().toString());
});
test('unknown schema, malformed rows, invalid IDs and unsupported transports never trigger probes',async t=>{
    const rows=[{...peer(0),Schema:'future'},'bad',{...peer(1),ID:'wrong'},peer(2,['/ip4/8.8.8.8/tcp/4001']),{...peer(3),Addrs:null}];
    const seen=stub(t,()=>stream(rows.map(p=>typeof p==='string'?p+'\n':JSON.stringify(p)+'\n')));
    const result=await discoverProviders(root,{servers:[service(0)]});assert.equal(result.verifiedEndpoints,0);assert.equal(result.providers.length,2);assert.equal(seen.length,1);
});
test('404 is empty, failed routers do not hide valid providers, all compatible endpoints queried',async t=>{
    const seen=stub(t,url=>url.includes('r0.')?new Response(null,{status:404}):url.includes('r1.')?new Response(null,{status:503}):url.includes('r2.')?json({Providers:[peer(0)]}):raw());
    const result=await discoverProviders(root,{servers:[service(0),service(1),service(2),{...service(3),discovery:false}]});
    assert.equal(result.verifiedEndpoints,1);assert.equal(result.failures.length,1);assert.equal(seen.length,4);
});
test('wrong MIME, invalid UTF-8/JSON, oversized declarations and bodies are bounded',async t=>{
    const seen=stub(t,url=>{
        if(url.includes('r0.'))return json({},'text/plain');
        if(url.includes('r1.'))return json({wrong:[]});
        if(url.includes('r2.'))return new Response(new Uint8Array([255]),{headers:{'Content-Type':'application/x-ndjson'}});
        if(url.includes('r3.'))return new Response('',{headers:{'Content-Type':'application/json','Content-Length':String(L.responseBytes+1)}});
        if(url.includes('r4.'))return stream([' '.repeat(L.responseBytes+1)]);
        return json({Providers:[]});
    });
    const result=await discoverProviders(root,{servers:Array.from({length:6},(_,i)=>service(i))});
    assert.equal(result.failures.length,5);assert(result.limits.includes('response-bytes'));assert.equal(seen.length,6);
});
test('record count, record size and merged address caps are observable',async t=>{
    stub(t,url=>url.includes('r0.')?json({Providers:Array.from({length:101},(_,i)=>peer(i,[]))}):
        url.includes('r1.')?json({Providers:[{...peer(0),extra:'x'.repeat(L.recordBytes)},peer(0,Array.from({length:20},(_,i)=>`/ip4/8.8.8.${i+1}/tcp/4001`))]}):raw());
    const result=await discoverProviders(root,{servers:[service(0),service(1)]});
    assert.equal(result.providers.length,100);assert.equal(result.providers[0].addresses.length,16);
    for(const name of ['records','record-bytes','addresses'])assert(result.limits.includes(name));
});
test('wrong hash, MIME, oversize, empty and failed probes cannot beat the honest provider',async t=>{
    stub(t,url=>url.includes('/providers/')?json({Providers:Array.from({length:6},(_,i)=>peer(i))}):
        url.includes('p0.')?raw(new Uint8Array([4])):url.includes('p1.')?json({}):url.includes('p2.')?raw(new Uint8Array(L.blockBytes+1)):
        url.includes('p3.')?new Response(null,{status:404}):url.includes('p4.')?raw(new Uint8Array()):raw());
    const result=await discoverProviders(root,{servers:[service(0)]});assert.equal(result.verifiedEndpoints,1);assert.equal(result.failures.length,5);
    assert.equal(result.providers.find(p=>p.gateways.length).peerId,peerIds[5]);
});
test('four queries and four probes are independent; bounded endpoint tests include a second source',async t=>{
    let queries=0,queryPeak=0,probes=0,probePeak=0;
    const seen=stub(t,async(url,{signal})=>{
        if(url.includes('/providers/')){
            queries++;queryPeak=Math.max(queryPeak,queries);
            const providers=url.includes('r0.')?Array.from({length:100},(_,i)=>peer(i)):[peer(110)];
            const response=await delayed(json({Providers:providers}),20,signal);queries--;return response;
        }
        probes++;probePeak=Math.max(probePeak,probes);const response=await delayed(raw(),10,signal);probes--;return response;
    });
    const result=await discoverProviders(root,{servers:Array.from({length:9},(_,i)=>service(i))});
    assert.equal(queryPeak,4);assert.equal(probePeak,4);assert.equal(result.endpointsTested,64);assert(result.limits.includes('endpoints'));
    assert(result.providers.find(p=>p.peerId===peerIds[110]).gateways.length);assert.equal(seen.filter(x=>x.url.includes('/providers/')).length,9);
});
test('global received-byte budget stops amplification and keeps earlier verified providers',async t=>{
    let probeCount=0;
    stub(t,url=>url.includes('/providers/')?json({Providers:Array.from({length:20},(_,i)=>peer(i))}):raw(++probeCount===1?bytes:new Uint8Array(L.blockBytes)));
    const result=await discoverProviders(root,{servers:[service(0)]});assert(result.limits.includes('total-bytes'));
    assert(result.receivedBytes<=L.totalBytes+L.blockBytes);assert(result.endpointsTested<20);
    assert(result.providers.some(p=>p.gateways.length));
});
test('5s request deadline includes a stalled stream; no automatic retry',async t=>{
    const seen=stub(t,(url,{signal})=>url.includes('r0.')?stream([JSON.stringify(peer(0))+'\n'],signal,{hang:true}):raw());
    const started=performance.now(),emitted=[];
    const result=await discoverProviders(root,{servers:[service(0)],onProvider:p=>emitted.push(performance.now()-started)});
    assert(emitted[0]<1000);assert(performance.now()-started>=4800);assert(performance.now()-started<6500);
    assert.equal(result.failures.length,1);assert.equal(result.verifiedEndpoints,1);assert.equal(seen.length,2);
});
test('external cancellation aborts routing and probes, discards late results and queued work',async t=>{
    const emitted=[],c=new AbortController();
    const seen=stub(t,(url,{signal})=>url.includes('/providers/')?stream([JSON.stringify(peer(0))+'\n'],signal,{hang:true}):delayed(raw(),10000,signal));
    const pending=discoverProviders(root,{servers:[service(0)],signal:c.signal,onProvider:p=>emitted.push(p)});
    await pause(30);c.abort();await assert.rejects(pending,e=>e.code==='CANCELLED');assert.equal(seen.length,2);assert.equal(emitted.length,0);
    await assert.rejects(discoverProviders(root,{servers:[service(0)],signal:c.signal}),e=>e.code==='CANCELLED');assert.equal(seen.length,2);
});
test('RemoteDisk opens on first verified root, reuses it, retains later providers and pins gateway',async t=>{
    const seen=stub(t,(url,{signal})=>url.includes('r0.')?stream([JSON.stringify(peer(0))+'\n',JSON.stringify(peer(1))+'\n'],signal,{delay:100}):raw());
    const remote=new RemoteDisk({servers:[service(0)],prefetch:{enabled:false}});t.after(()=>remote.close());
    await remote.openCid(root.toString());assert.equal(remote.stats().discovery.state,'running');assert.equal(remote.gateway,'https://p0.example.com');
    assert.deepEqual(await remote.read(0,16),bytes.slice(0,16));await remote.discoveryTask;
    assert.equal(remote.stats().discovery.verifiedProviders,2);assert.equal(remote.gateway,'https://p0.example.com');
    assert.equal(seen.filter(x=>x.url.includes('p0.')).length,1);assert.equal(remote.cacheBytes,bytes.length);
});
test('no providers means explicit error and zero fallback requests; retry starts a fresh round',async t=>{
    let empty=true;const seen=stub(t,url=>url.includes('/providers/')?json({Providers:empty?[]:[peer(0)]}):raw());
    const remote=new RemoteDisk({servers:[service(0)],prefetch:{enabled:false}});t.after(()=>remote.close());
    await assert.rejects(remote.openCid(root.toString()),e=>e.code==='IO_ERROR' && /No verified HTTPS provider/.test(e.message));
    assert.equal(seen.length,1);empty=false;await remote.openCid(root.toString());assert.equal(remote.gateway,'https://p0.example.com');
});
test('explicit gateway and Only localhost bypass discovery, and sha256 is still checked',async t=>{
    const seen=stub(t,()=>raw());
    for(const options of [{gateway:'https://direct.example.com'},{onlyLocalhost:true}]) {
        const remote=new RemoteDisk({...options,servers:[],prefetch:{enabled:false}});
        try{await remote.openCid(root.toString());assert.equal(remote.stats().discovery.state,'skipped');}finally{remote.close();}
    }
    assert.equal(seen.length,2);assert(seen.every(x=>x.url.includes('/ipfs/')));assert(seen[1].url.startsWith('http://127.0.0.1:8080/'));
});
test('closing RemoteDisk during or after first result cancels its remaining round',async t=>{
    let hang=false;
    stub(t,(url,{signal})=>url.includes('/providers/')?stream(hang?[]:[JSON.stringify(peer(0))+'\n'],signal,{hang:true}):raw());
    for(const waitFirst of [true,false]) {
        hang=!waitFirst;const remote=new RemoteDisk({servers:[service(0)],prefetch:{enabled:false}});
        const pending=remote.openCid(root.toString());
        if(waitFirst)await pending;else await pause(20);
        remote.close();if(!waitFirst)await assert.rejects(pending,e=>e.code==='CANCELLED');
        await remote.discoveryTask;assert.equal(remote.providers.size,0);assert.equal(remote.gateway,waitFirst?'https://p0.example.com':undefined);
    }
});
test('Resolution finishes before Discovery, preserving the chosen CID',async t=>{
    const key=await generateKeyPair('Ed25519'),identity={ipnsName:key.publicKey.toCID().toString(),publicKey:key.publicKey.raw};
    const signed=marshalIPNSRecord(await createIPNSRecord(key,'/ipfs/'+root,5n,3600000,{v1Compatible:false}));
    const seen=stub(t,url=>url.includes('/ipns/')?new Response(signed,{headers:{'Content-Type':'application/vnd.ipfs.ipns-record'}}):url.includes('/providers/')?json({Providers:[peer(0)]}):raw());
    const remote=new RemoteDisk({servers:[{...service(0),resolution:'routing'}],prefetch:{enabled:false}});t.after(()=>remote.close());
    await remote.open(identity);await remote.discoveryTask;
    assert.equal(remote.remote.rootCid,root.toString());assert.equal(remote.remote.sequence,'5');
    assert(seen[0].url.includes('/ipns/'));assert(seen[1].url.includes('/providers/'));assert(seen[2].url.includes('/ipfs/'));
});
test('30s round deadline bounds multiple probe waves and preserves prior success',async t=>{
    let count=0;
    stub(t,(url,{signal})=>url.includes('/providers/')?json({Providers:Array.from({length:100},(_,i)=>peer(i))}):++count===1?raw():delayed(raw(),10000,signal));
    const start=performance.now(),result=await discoverProviders(root,{servers:[service(0)]});
    assert(performance.now()-start>=29500);assert(performance.now()-start<32000);
    assert(result.limits.includes('round-time'));assert.equal(result.verifiedEndpoints,1);assert(result.endpointsTested<64);
});
