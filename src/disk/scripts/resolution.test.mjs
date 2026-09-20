import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {generateKeyPair} from '@libp2p/crypto/keys';
import {createIPNSRecordWithExpiration, marshalIPNSRecord} from 'ipns';
import {resolveIpns} from '../web/resolution.js';
import {DEFAULT_SERVERS, resolutionServers, dataGateway} from '../web/network-config.js';
import {RemoteDisk} from '../web/remote.js';
const key = await generateKeyPair('Ed25519');
const identity = {publicKey:key.publicKey.raw, ipnsName:key.publicKey.toCID().toString()};
const cid = 'bafkqaaa', other = 'bafkqaalb';
const future = () => new Date(Date.now()+3600000).toISOString();
async function record(seq=1n, value='/ipfs/'+cid, expires=future(), signer=key) {
    return marshalIPNSRecord(await createIPNSRecordWithExpiration(signer,value,seq,expires,{v1Compatible:false}));
}
async function fixture(t, plans) {
    const seen=[];let active=0, peak=0;
    const server=createServer((req,res)=>{
        const i=Number(req.url.split('/')[1]), plan=plans[i];
        seen.push({i,url:req.url,headers:req.headers});active++;peak=Math.max(peak,active);
        let timer;res.once('close',()=>{active--;clearTimeout(timer);});
        if(!plan){res.writeHead(404).end();return;}
        if(plan.hang)return;
        const send=()=>{
            res.writeHead(plan.status||200,{'Content-Type':plan.type||'application/vnd.ipfs.ipns-record',...plan.headers});
            if(plan.stall){res.write(new Uint8Array([1]));return;}
            res.end(plan.bytes);
        };
        if(plan.delay)timer=setTimeout(send,plan.delay);else send();
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
    const base='http://127.0.0.1:'+server.address().port;
    return {base,seen,get active(){return active;},get peak(){return peak;},servers:plans.map((p,i)=>({url:base+'/'+i,resolution:p.routing?'routing':'gateway',discovery:!!p.routing}))};
}
const rejected=(p,code)=>assert.rejects(p,e=>e.code===code);

test('all servers, mixed protocols, BigInt sequence and response order',async t=>{
    const f=await fixture(t,[{bytes:await record(9007199254740992n),delay:90},{bytes:await record(9007199254740993n),routing:true},{status:503}]);
    const result=await resolveIpns(identity,{servers:f.servers});
    assert.equal(result.sequence,'9007199254740993');assert.equal(result.resolutionServer,f.servers[1].url);
    assert.equal(f.seen.length,3);assert(f.seen[1].url.includes('/routing/v1/ipns/'));
    assert.equal(result.rootCid,cid);assert.equal(result.path,'/ipfs/'+cid);
    for(const req of f.seen){assert.equal(req.headers.accept,'application/vnd.ipfs.ipns-record');assert.equal(req.headers.cookie,undefined);assert.equal(req.headers.referer,undefined);}
});
test('renewals retain nanosecond precision; equal records use config order',async t=>{
    const second=new Date(Date.now()+3600000).toISOString().split('.')[0];
    const bytes=await record(2n,'/ipfs/'+other,second+'.123456789Z');
    const f=await fixture(t,[{bytes:await record(2n,'/ipfs/'+cid,second+'.123456788Z')},{bytes,delay:40},{bytes}]);
    const result=await resolveIpns(identity,{servers:f.servers});assert.equal(result.rootCid,other);assert.equal(result.resolutionServer,f.servers[1].url);
});
test('tied signed records with different targets fail',async t=>{
    const expires=future();const f=await fixture(t,[{bytes:await record(2n,'/ipfs/'+cid,expires)},{bytes:await record(2n,'/ipfs/'+other,expires)}]);
    await rejected(resolveIpns(identity,{servers:f.servers}),'CORRUPTION');
});
test('bad signatures, expired, MIME, malformed, huge and error responses do not hide a valid record',async t=>{
    const f=await fixture(t,[{bytes:await record(99n,'/ipfs/'+cid,future(),await generateKeyPair('Ed25519'))},{bytes:await record(98n,'/ipfs/'+cid,new Date(Date.now()-10000).toISOString())},{bytes:await record(),type:'text/plain'},{bytes:new Uint8Array([1,2,3])},{bytes:new Uint8Array(10241)},{status:404},{bytes:await record(3n)}]);
    const result=await resolveIpns(identity,{servers:f.servers});assert.equal(result.sequence,'3');assert.equal(f.seen.length,7);
});
test('streamed and declared oversize responses are rejected',async t=>{
    const f=await fixture(t,[{bytes:new Uint8Array(10241),headers:{'Transfer-Encoding':'chunked'}},{bytes:new Uint8Array(10241),headers:{'Content-Length':'10241'}}]);
    await rejected(resolveIpns(identity,{servers:f.servers}),'CORRUPTION');
});
test('expired at round completion is discarded',async t=>{
    const f=await fixture(t,[{bytes:await record(9n,'/ipfs/'+other,new Date(Date.now()+200).toISOString())},{bytes:await record(1n),delay:350}]);
    assert.equal((await resolveIpns(identity,{servers:f.servers})).sequence,'1');
});
test('latest unsupported target fails rather than rolling back',async t=>{
    const f=await fixture(t,[{bytes:await record(1n)},{bytes:await record(2n,'/ipns/'+identity.ipnsName)}]);
    await rejected(resolveIpns(identity,{servers:f.servers}),'UNSUPPORTED_FORMAT');
});
test('CIDv0 and UnixFS subpath are preserved without block requests',async t=>{
    const root='QmTTKGJmBPjcdSV5fmG843xBEQjdRhEywvxUFp7E7yjYST',path='/ipfs/'+root+'/folder/disk.my98';
    const f=await fixture(t,[{bytes:await record(1n,path)}]);
    const result=await resolveIpns(identity,{servers:f.servers});assert.equal(result.rootCid,root);assert.equal(result.path,path);assert.equal(f.seen.length,1);
});
test('deduplication and four-request concurrency ceiling cover all endpoints',async t=>{
    const bytes=await record(),f=await fixture(t,Array.from({length:9},()=>({bytes,delay:40})));
    const servers=[...f.servers,{...f.servers[0],url:f.servers[0].url+'/'}];
    await resolveIpns(identity,{servers});assert.equal(f.seen.length,9);assert.equal(f.peak,4);
});
test('5s deadline includes headers and body; no retries, later queued servers still queried',async t=>{
    const bytes=await record(),f=await fixture(t,[{hang:true},{stall:true},{bytes},{bytes},{bytes}]);
    const start=performance.now();await resolveIpns(identity,{servers:f.servers});
    assert(performance.now()-start>=4800);assert(performance.now()-start<6500);assert.equal(f.seen.length,5);
});
test('cancellation aborts all in-flight work and does not start queued servers',async t=>{
    const f=await fixture(t,Array.from({length:8},()=>({hang:true}))),controller=new AbortController();
    const result=resolveIpns(identity,{servers:f.servers,signal:controller.signal});
    await new Promise(r=>setTimeout(r,80));controller.abort();
    await rejected(result,'CANCELLED');await new Promise(r=>setTimeout(r,80));
    assert.equal(f.seen.length,4);assert.equal(f.active,0);
});
test('pre-aborted and mismatched identities send no traffic',async t=>{
    const f=await fixture(t,[{bytes:await record()}]),c=new AbortController();c.abort();
    await rejected(resolveIpns(identity,{servers:f.servers,signal:c.signal}),'CANCELLED');
    await rejected(resolveIpns({...identity,publicKey:(await generateKeyPair('Ed25519')).publicKey.raw},{servers:f.servers}),'CORRUPTION');
    assert.equal(f.seen.length,0);
});
test('local mode ignores supplied servers and keeps only the loopback gateway',async t=>{
    const f=await fixture(t,[{bytes:await record(1n)},{bytes:await record(2n)}]);
    const result=await resolveIpns(identity,{onlyLocalhost:true,gateway:f.servers[0].url,servers:[{url:'https://should-not-be-contacted.invalid',resolution:'routing',discovery:true}]});
    assert.equal(result.sequence,'1');assert.equal(f.seen.length,1);
    await rejected(resolveIpns(identity,{onlyLocalhost:true,gateway:'https://example.com',servers:f.servers}),'IO_ERROR');
});
test('local redirect cannot fall back to another endpoint',async t=>{
    const f=await fixture(t,[{status:302,headers:{Location:'https://should-not-be-contacted.invalid'}}]);
    await rejected(resolveIpns(identity,{onlyLocalhost:true,gateway:f.servers[0].url}),'IO_ERROR');assert.equal(f.seen.length,1);
});
test('configuration validates before network and default capabilities are explicit',()=>{
    assert.equal(DEFAULT_SERVERS.length,4);assert.equal(DEFAULT_SERVERS.filter(s=>s.discovery).length,2);
    assert.equal(dataGateway(undefined,true),'http://127.0.0.1:8080');
    for(const servers of [[],Array(17).fill(DEFAULT_SERVERS[0]),[{resolution:'gateway',discovery:false}],[{url:'http://example.com',resolution:'gateway',discovery:false}],[{url:'https://x/?foo',resolution:'gateway',discovery:false}],[{url:'https://x',resolution:false,discovery:true}]]) assert.throws(()=>resolutionServers(servers));
    assert.throws(()=>dataGateway('http://127.0.0.1.example.com',true));
});
test('RemoteDisk cancellation while resolving prevents any block read',async t=>{
    const f=await fixture(t,[{hang:true}]),remote=new RemoteDisk({gateway:f.servers[0].url,onlyLocalhost:true});
    const p=remote.open(identity);await new Promise(r=>setTimeout(r,50));remote.close();await rejected(p,'CANCELLED');assert.equal(f.seen.length,1);
});
