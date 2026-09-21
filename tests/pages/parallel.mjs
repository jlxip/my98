import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium,webkit} from 'playwright';
import {CID} from 'multiformats/cid';
import {sha256} from 'multiformats/hashes/sha2';
import * as dagPb from '@ipld/dag-pb';
import {UnixFS} from 'ipfs-unixfs';
import {build} from '../../src/disk/scripts/bundle.mjs';
import {makeServer} from '../../src/disk/browser-tests/server.mjs';
import {fileURLToPath} from 'node:url';
const repo=fileURLToPath(new URL('../../',import.meta.url)),out=repo+'build/parallel';await mkdir(out,{recursive:true});
const blocks=new Map(),chunks=[];
for(let i=0;i<32;i++) {
    const bytes=new Uint8Array(256*1024);for(let j=0;j<bytes.length;j++)bytes[j]=(j*17+i*23+(j>>>8))%251;
    const cid=CID.createV1(0x55,await sha256.digest(bytes));blocks.set(cid.toString(),bytes);chunks.push({cid,bytes});
}
const rootBytes=dagPb.encode(dagPb.prepare({Data:new UnixFS({type:'file',blockSizes:chunks.map(x=>BigInt(x.bytes.length))}).marshal(),Links:chunks.map(x=>({Hash:x.cid,Name:'',Tsize:x.bytes.length}))}));
const root=CID.createV1(0x70,await sha256.digest(rootBytes));blocks.set(root.toString(),rootBytes);
const whole=new Uint8Array(chunks.length*chunks[0].bytes.length);chunks.forEach((c,i)=>whole.set(c.bytes,i*c.bytes.length));
const expected=Buffer.from((await sha256.digest(whole)).digest).toString('hex');
const peers=await Promise.all([0,1].map(async i=>CID.createV1(0x72,await sha256.digest(new Uint8Array([i]))).toString()));
let mode='normal',providers=2,requests=[],active=[0,0],peak=[0,0],next=[0,0];const timers=new Set();
const gateway=createServer((req,res)=>{
    res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','Accept');
    if(req.method==='OPTIONS'){res.end();return;}
    if(req.url.startsWith('/routing/')) {res.setHeader('Content-Type','application/x-ndjson');res.end(peers.slice(0,providers).map((ID,i)=>JSON.stringify({Schema:'peer',ID,Addrs:[`/dns4/p${i}.example.com/tcp/443/https`]})).join('\n'));return;}
    const match=/^\/p([01])\/ipfs\/([^?]+)/.exec(req.url);if(!match){res.writeHead(404).end();return;}
    const p=Number(match[1]),cid=match[2],source=blocks.get(cid);requests.push({p,cid});
    active[p]++;peak[p]=Math.max(peak[p],active[p]);let timer;
    res.once('close',()=>{active[p]--;clearTimeout(timer);timers.delete(timer);});
    const isRoot=cid===root.toString();
    if(!source || (!isRoot && (mode==='missing' || (mode==='partial' && p===0)))) {res.writeHead(404).end();return;}
    const bytes=source.slice();if(!isRoot && mode==='corrupt' && p===0)bytes[0]^=1;
    // Independent 8 MiB/s endpoint links. Two requests share each link's byte budget.
    const now=performance.now();next[p]=Math.max(now,next[p])+bytes.length/(8*1024*1024)*1000;
    timer=setTimeout(()=>{timers.delete(timer);res.writeHead(200,{'Content-Type':'application/vnd.ipld.raw'}).end(bytes);},Math.max(0,next[p]-now)+8);timers.add(timer);
});
const site=makeServer(repo);await new Promise(r=>gateway.listen(0,'127.0.0.1',r));await new Promise(r=>site.listen(0,'127.0.0.1',r));
const base='http://127.0.0.1:'+gateway.address().port;
// Remap only fixture public names. Discovery filtering, hashes and fetch options remain production code.
const banner=`const realFetch=globalThis.fetch.bind(globalThis);globalThis.fetch=(url,options)=>{const u=new URL(url);if(/^p[01]\\.example\\.com$/.test(u.hostname))return realFetch(${JSON.stringify(base)}+'/'+u.hostname.slice(0,2)+u.pathname+u.search,options);if(u.hostname!=='127.0.0.1')throw Error('Unexpected external request');return realFetch(url,options);};`;
await build({entryPoints:['src/disk/web/remote.js'],bundle:true,format:'esm',platform:'browser',target:'es2022',banner:{js:banner},outfile:repo+'build/disk/web/parallel-remote.js'});
const results=[];
const reset=(n,m='normal')=>{providers=n;mode=m;requests=[];next=[0,0];peak=[0,0];};
try {
 for(const [name,type] of Object.entries({chromium,webkit})) {
    const browser=await type.launch();
    try {
        const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));
        await page.goto(`http://127.0.0.1:${site.address().port}/disk/browser-tests/index.html`);
        const args={cid:root.toString(),servers:[{url:base,resolution:false,discovery:true}],expected};
        const runs=[];
        for(const n of [1,2])for(let repeat=0;repeat<5;repeat++) {
            reset(n);
            const result=await page.evaluate(async args=>{
                const {RemoteDisk}=await import('/build/disk/web/parallel-remote.js');
                const r=new RemoteDisk({servers:args.servers,prefetch:{trace:true}});
                try {
                    await r.openCid(args.cid);await r.discoveryTask;await r.read(0,198);
                    const start=performance.now();r.startPrefetch();
                    while(r.prefetchState!=='complete') {if(r.prefetchState==='paused')throw Error(JSON.stringify(r.prefetchError));if(performance.now()-start>15000)throw Error('Download timeout');await new Promise(r=>setTimeout(r,5));}
                    const ms=performance.now()-start,stats=r.stats();
                    const bytes=await r.read(0,r.size);const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
                    if(hash!==args.expected)throw Error('File mismatch');if(stats.coveredBytes!==r.size)throw Error('Coverage mismatch');
                    return {ms,stats,hash};
                }finally{r.close();}
            },args);
            assert.ok(peak.every(x=>x<=2));assert.ok(result.stats.endpoints.filter(e=>e.validBytes>0).length===n);
            runs.push({providers:n,repeat,...result,peak:[...peak]});
        }
        const median=n=>runs.filter(r=>r.providers===n).map(r=>r.ms).sort((a,b)=>a-b)[2];const speedup=median(1)/median(2);assert.ok(speedup>=1.5,`${name} speedup ${speedup}`);
        const faults=[];
        for(const m of ['corrupt','partial','missing']) {
            reset(2,m);
            faults.push(await page.evaluate(async args=>{
                const {RemoteDisk}=await import('/build/disk/web/parallel-remote.js');const r=new RemoteDisk({servers:args.servers});
                try {await r.openCid(args.cid);await r.discoveryTask;r.startPrefetch();const start=performance.now();
                    while(!['complete','paused'].includes(r.prefetchState)){if(performance.now()-start>10000)throw Error('Fault timeout');await new Promise(r=>setTimeout(r,5));}
                    return {mode:args.mode,state:r.prefetchState,stats:r.stats()};
                }finally{r.close();}
            },{...args,mode:m}));
            assert.equal(faults.at(-1).state,m==='missing'?'paused':'complete');
            if(m==='corrupt')assert.ok(faults.at(-1).stats.endpoints[0].excluded);
        }
        reset(2);
        const demand=await page.evaluate(async args=>{
            const {RemoteDisk}=await import('/build/disk/web/parallel-remote.js');const r=new RemoteDisk({servers:args.servers,prefetch:{trace:true}});
            try {await r.openCid(args.cid);await r.discoveryTask;await r.read(0,198);r.startPrefetch();
                const deadline=performance.now()+5000;while(r.stats().inFlight<4){if(performance.now()>deadline)throw Error('No parallel prefetch');await new Promise(r=>setTimeout(r,1));}
                const start=performance.now(),traceStart=r.trace.length;await r.read(r.size-65536,65536);const ms=performance.now()-start;
                const starts=r.trace.slice(traceStart).filter(e=>e.type==='fetch-start');if(starts[0]?.priority!=='demand')throw Error('Background passed demand');
                return {ms,starts,stats:r.stats()};
            }finally{r.close();}
        },args);
        assert.equal(errors.length,0,errors.join('\n'));
        results.push({browser:name,speedup,oneMedianMs:median(1),twoMedianMs:median(2),runs,faults,demand,errors});
        await writeFile(out+'/browser-results.json',JSON.stringify(results,null,2));
        console.log(`${name}: speedup ${speedup.toFixed(2)}x; demand ${demand.ms.toFixed(1)} ms; 10 downloads and 4 fault/priority scenarios PASS`);
    }finally{await browser.close();}
 }
}finally{for(const t of timers)clearTimeout(t);gateway.closeAllConnections();site.closeAllConnections();await Promise.all([new Promise(r=>gateway.close(r)),new Promise(r=>site.close(r))]);}
