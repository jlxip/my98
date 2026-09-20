import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
import {createServer as httpServer} from 'node:http';
import {createServer as httpsServer} from 'node:https';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {CID} from 'multiformats/cid';
import {sha256} from 'multiformats/hashes/sha2';
import {fixture,repo} from '../../src/disk/browser-tests/ipfs-fixture.mjs';
import {makeServer} from '../../src/disk/browser-tests/server.mjs';
import {build} from '../../src/disk/scripts/bundle.mjs';

const out=repo+'build/discovery';await mkdir(out,{recursive:true});
// Disposable TLS material, never installed in the user's trust store.
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',out+'/fixture.key','-out',out+'/fixture.crt','-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
const f=await fixture(),site=makeServer(repo),requests=[],results=[];
const peers=await Promise.all([0,1].map(async i=>CID.createV1(0x72,await sha256.digest(new Uint8Array([i]))).toString()));
let mode='normal',active=0;
const timers=new Set();
function later(ms,fn,res) {const timer=setTimeout(()=>{timers.delete(timer);fn();},ms);timers.add(timer);res.once('close',()=>{clearTimeout(timer);timers.delete(timer);});}
const routing=httpServer(async(req,res)=>{
    requests.push({kind:'routing',url:req.url,mode});res.setHeader('Access-Control-Allow-Origin','*');
    if(req.url.includes('/ipns/')){
        const response=await fetch(f.endpoint+'/ipns/'+f.identity.ipnsName);res.writeHead(response.status,{'Content-Type':response.headers.get('content-type')}).end(new Uint8Array(await response.arrayBuffer()));return;
    }
    res.setHeader('Content-Type','application/x-ndjson');
    if(mode==='hang-router')return;
    if(mode==='empty'){res.end();return;}
    const i=req.url.startsWith('/r1/')?1:0;
    const record={Schema:'peer',ID:peers[i],Addrs:[mode==='private'?'/ip4/127.0.0.1/tcp/443/https':`/dns4/p${i}.example.com/tcp/443/tls/http`]};
    res.write(JSON.stringify(record)+'\n');
    // An open response verifies that opening and reading need not wait for Discovery to finish.
    if(mode==='normal'||mode==='path')later(1500,()=>res.end(),res);else res.end();
});
const tls=httpsServer({key:await readFile(out+'/fixture.key'),cert:await readFile(out+'/fixture.crt')},async(req,res)=>{
    active++;res.once('close',()=>active--);
    requests.push({kind:'provider',url:req.url,mode});
    const url=new URL(req.url,'https://127.0.0.1'),parts=url.pathname.split('/'),provider=parts[1];
    if(mode!=='no-cors')res.setHeader('Access-Control-Allow-Origin','*');
    res.setHeader('Access-Control-Allow-Headers','Accept');
    if(req.method==='OPTIONS'){res.writeHead(204).end();return;}
    if(mode==='hang-probe')return;
    if(mode==='redirect'){res.writeHead(302,{Location:'/redirect-target'}).end();return;}
    const path=url.pathname.slice(provider.length+1)+url.search;
    if(mode==='root-only' && !path.startsWith('/ipfs/'+CID.parse(f.cid0).toV1())){res.writeHead(404).end();return;}
    const response=await fetch(f.endpoint+path,{headers:{Accept:req.headers.accept||'*/*'}});
    const data=new Uint8Array(await response.arrayBuffer());
    if(mode==='corrupt' && provider==='p0')data[0]^=1;
    const send=()=>res.writeHead(response.status,{'Content-Type':response.headers.get('content-type')}).end(data);
    if(provider==='p1')later(100,send,res);else send();
});
await new Promise(r=>routing.listen(0,'127.0.0.1',r));await new Promise(r=>tls.listen(0,'127.0.0.1',r));await new Promise(r=>site.listen(0,'127.0.0.1',r));
const base='http://127.0.0.1:'+routing.address().port,tlsBase='https://127.0.0.1:'+tls.address().port;
const servers=[0,1].map(i=>({url:base+'/r'+i,resolution:'routing',discovery:true}));
// Only the test transport maps advertised public names onto our disposable TLS server.
// Production address parsing, fetch options, CORS, Worker, hashing and disk code are unchanged.
const banner=`const fixtureFetch=globalThis.fetch.bind(globalThis);globalThis.fetch=(url,options)=>{const u=new URL(url);if(/^p[01]\\.example\\.com$/.test(u.hostname))return fixtureFetch(${JSON.stringify(tlsBase)}+'/'+u.hostname.slice(0,2)+u.pathname+u.search,options);if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw Error('Unexpected external request: '+u.hostname);return fixtureFetch(url,options);};`;
await build({entryPoints:['src/disk/web/worker.js'],bundle:true,format:'esm',platform:'browser',target:'es2022',external:['../pkg/slop86_disk.js'],banner:{js:banner},outfile:'build/disk/web/discovery-worker.js'});
await build({entryPoints:['src/disk/web/remote.js'],bundle:true,format:'esm',platform:'browser',target:'es2022',banner:{js:banner},outfile:'build/disk/web/discovery-remote.js'});
const args={servers,cid:f.cid0,gateway:f.endpoint,base,identity:f.identity};
try {
 for(const [name,type] of Object.entries({chromium,webkit})) {
    const browser=await type.launch();
    try {
        const context=await browser.newContext({ignoreHTTPSErrors:true}),page=await context.newPage(),errors=[],checks=[];
        page.on('pageerror',e=>errors.push(String(e)));
        const ok=label=>{checks.push(label);console.log(name+': '+label);};
        await page.goto(`http://127.0.0.1:${site.address().port}/disk/browser-tests/index.html`);
        const setup=async()=>page.evaluate(()=>{
            document.body.innerHTML='';
            globalThis.clients=[];
            globalThis.client=async()=>{
                const {Slop86Disk}=await import('/build/disk/web/client.js');
                const c=await Slop86Disk.create({workerUrl:'/build/disk/web/discovery-worker.js'});clients.push(c);return c;
            };
            globalThis.cleanup=async()=>{for(const c of clients){await c.close();c.terminate();}clients=[];};
        });
        await setup();mode='normal';f.setMode('small');requests.length=0;
        const opened=await page.evaluate(async args=>{
            const c=await client();await c.unlock('disk fixtures','public compatibility password','main');
            const state=await c.openRemote({servers:args.servers,prefetch:{enabled:false}}),stats=await c.readStats();
            const bytes=await c.read(0,512);globalThis.readKey=await c.exportReadOnlyKey();
            return {state,stats,bytes:bytes.length};
        },args);
        assert.equal(opened.state.remote.gateway,'https://p0.example.com');assert.equal(opened.state.remote.rootCid,f.cid0);
        assert.equal(opened.stats.remote.discovery.state,'running');assert.equal(opened.bytes,512);
        const rootPath='/p0/ipfs/'+CID.parse(f.cid0).toV1()+'?format=raw';
        // Probe CIDv1 and exporter CIDv0 aliases share the cached root.
        assert.equal(requests.filter(r=>r.kind==='provider'&&r.url===rootPath).length,1);
        await page.evaluate(async()=>{
            const deadline=performance.now()+6000;
            while(!['complete','limited'].includes((await clients[0].readStats()).remote.discovery.state)) {
                if(performance.now()>deadline)throw Error('Discovery did not finish');
                await new Promise(r=>setTimeout(r,40));
            }
        });
        const completed=await page.evaluate(async()=>clients[0].readStats());
        assert.equal(completed.remote.discovery.verifiedEndpoints,2,JSON.stringify({discovery:completed.remote.discovery,requests}));
        await page.evaluate(()=>cleanup());ok('real Worker opens and reads before routing finishes, root reused and second provider retained');

        mode='normal';requests.length=0;
        const readOnly=await page.evaluate(async args=>{
            const c=await client();const state=await c.openReadOnly({cid:args.cid,readKey,servers:args.servers,prefetch:{enabled:false}});
            await c.read(0,512);const stats=await c.readStats();await cleanup();return {state,stats};
        },args);
        assert(readOnly.state.readOnly);assert.equal(requests.filter(r=>r.url.includes('/ipns/')).length,0);assert.equal(readOnly.stats.remote.discovery.state,'running');ok('read-only propagates servers, discovers and reads without Resolution');

        mode='path';f.setMode('path');
        const path=await page.evaluate(async args=>{
            const c=await client();await c.unlock('disk fixtures','public compatibility password','main');
            const state=await c.openRemote({servers:args.servers,prefetch:{enabled:false}});await c.read(0,512);await cleanup();return state.remote;
        },args);
        assert.equal(path.rootCid,f.directoryCid);assert.notEqual(path.rootCid,path.cid);assert(path.path.includes('/'+f.directoryCid+'/'));f.setMode('small');ok('UnixFS path preserves directory root separately from file CID');

        mode='corrupt';
        const recovered=await page.evaluate(async args=>{
            const c=await client();const s=await c.openReadOnly({cid:args.cid,readKey,servers:args.servers,prefetch:{enabled:false}});await c.read(0,512);await cleanup();return s.remote.gateway;
        },args);
        assert.equal(recovered,'https://p1.example.com');ok('corrupt first provider cannot win selection');

        for(const value of ['empty','private','no-cors','redirect']) {
            mode=value;requests.length=0;
            const code=await page.evaluate(async args=>{
                const c=await client();try{await c.openReadOnly({cid:args.cid,readKey,servers:args.servers,prefetch:{enabled:false}});return 'unexpected';}
                catch(e){return e.code;}finally{await cleanup();}
            },args);
            assert.equal(code,'IO_ERROR',value);
            if(['empty','private'].includes(value))assert.equal(requests.filter(r=>r.kind==='provider').length,0);
            assert(!requests.some(r=>r.url==='/redirect-target'));
        }
        ok('empty discovery, private addresses, missing CORS and redirects fail explicitly without fallback');

        mode='root-only';
        const incomplete=await page.evaluate(async args=>{
            const {RemoteDisk}=await import('/build/disk/web/discovery-remote.js');const remote=new RemoteDisk({servers:args.servers,prefetch:{enabled:false}});
            try {await remote.openCid(args.cid);let code;try{await remote.read(0,512);}catch(e){code=e.code;}return {code,gateway:remote.gateway};}finally{remote.close();}
        },args);
        assert.equal(incomplete.code,'IO_ERROR');assert.equal(incomplete.gateway,'https://p0.example.com');ok('valid root does not imply available children; later read fails without changing provider');

        for(const value of ['hang-router','hang-probe']) {
            mode=value;requests.length=0;
            const code=await page.evaluate(async args=>{
                const c=await client();const pending=c.openReadOnly({cid:args.cid,readKey,servers:args.servers,prefetch:{enabled:false}});
                setTimeout(()=>c.cancel(),100);
                try{await pending;return 'unexpected';}catch(e){return e.code;}finally{await cleanup();}
            },args);
            assert.equal(code,'CANCELLED');
        }
        await new Promise(r=>setTimeout(r,100));assert.equal(active,0);ok('cancellation aborts routing and active HTTPS probes');

        mode='normal';requests.length=0;
        const direct=await page.evaluate(async args=>{
            const c=await client();const state=await c.openReadOnly({cid:args.cid,readKey,gateway:args.gateway,servers:[],onlyLocalhost:true,prefetch:{enabled:false}});
            const stats=await c.readStats();await cleanup();return {state,stats};
        },args);
        assert.equal(direct.stats.remote.discovery.state,'skipped');assert.equal(requests.length,0);ok('Only localhost and explicit gateway bypass public discovery');

        // No trust override here: the same self-signed endpoint must fail TLS validation.
        const untrusted=await browser.newContext(),untrustedPage=await untrusted.newPage();
        await untrustedPage.goto(`http://127.0.0.1:${site.address().port}/disk/browser-tests/index.html`);
        mode='tls-error';
        const tlsCode=await untrustedPage.evaluate(async args=>{
            const {RemoteDisk}=await import('/build/disk/web/discovery-remote.js');const r=new RemoteDisk({servers:args.servers,prefetch:{enabled:false}});
            try{await r.openCid(args.cid);return 'unexpected';}catch(e){return e.code;}finally{r.close();}
        },args);
        assert.equal(tlsCode,'IO_ERROR');await untrusted.close();ok('untrusted TLS certificate is rejected without production exceptions');
        assert.deepEqual(errors,[]);results.push({browser:name,version:browser.version(),checks,errors});
    } finally {await browser.close();}
 }
 await writeFile(out+'/browser-results.json',JSON.stringify({results,transport:'Advertised public names mapped to loopback TLS only in test bundles; real Worker, CORS and certificate rejection exercised.'},null,2));
} finally {
    for(const timer of timers)clearTimeout(timer);
    for(const server of [site,routing,tls]){server.closeAllConnections();await new Promise(r=>server.close(r));}
    await f.close();
}
