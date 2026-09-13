import assert from 'node:assert/strict';
import {build} from '../scripts/bundle.mjs';
import {chromium,webkit} from 'playwright';
import {writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {makeServer} from './server.mjs';
import {gatewayURL,DEFAULT_GATEWAY} from '../web/remote.js';
const repo=fileURLToPath(new URL('../../',import.meta.url));
assert.equal(DEFAULT_GATEWAY,'https://trustless-gateway.net');
assert.equal(gatewayURL('https://trustless-gateway.link/'),DEFAULT_GATEWAY);
assert.equal(gatewayURL('https://example.com/prefix'),'https://example.com/prefix');
assert.throws(()=>gatewayURL('http://example.com'));
await build({entryPoints:[repo+'disk/web/remote.js'],bundle:true,format:'esm',platform:'browser',target:'es2022',outfile:repo+'build/disk/web/remote-test.js'});
const server=makeServer(repo),results=[];
await new Promise(r=>server.listen(0,'127.0.0.1',r));
try {for(const [name,type] of Object.entries({chromium,webkit})) {
    const browser=await type.launch({headless:true});
    try {
        const page=await browser.newPage(),requests=[];let mode='ok',hits=0;
        page.on('request',r=>{if(r.url().startsWith('https://trustless-gateway.'))requests.push(r.url());});
        await page.route('https://trustless-gateway.net/**',async route=>{
            hits++;
            if(mode==='network')return route.abort('failed');
            if(mode==='slow')await new Promise(r=>setTimeout(r,250));
            return route.fulfill({status:mode==='missing'?404:mode==='server'?500:mode==='slow'||mode==='unavailable'||mode==='flaky'&&hits<3?504:200,headers:{'access-control-allow-origin':'*','content-type':mode==='bad-type'?'text/html':'application/vnd.ipld.raw'},body:''}).catch(()=>{});
        });
        await page.goto(`http://127.0.0.1:${server.address().port}/disk/browser-tests/index.html`);
        const checks=[];
        const request=()=>page.evaluate(async()=>{const {RemoteDisk}=await import('/build/disk/web/remote-test.js');const remote=new RemoteDisk({gateway:'https://trustless-gateway.link'});try{return {size:(await remote.request('/ipns/test?format=ipns-record','application/vnd.ipld.raw',10240)).length};}catch(e){return {code:e.code,message:e.message};}});
        assert.equal((await request()).size,0);assert(requests.length>0&&requests.every(url=>url.startsWith(DEFAULT_GATEWAY+'/')));checks.push('legacy default bypasses non-CORS redirect');
        mode='missing';hits=0;let r=await request();assert.equal(r.code,'IO_ERROR');assert.match(r.message,/No published disk reference is available/);assert.equal(hits,1);checks.push('404 describes missing reference without retry');
        mode='server';hits=0;r=await request();assert.match(r.message,/HTTP 500/);assert.doesNotMatch(r.message,/No published disk reference/);assert.equal(hits,3);checks.push('persistent 500 stops after three attempts');
        mode='flaky';hits=0;r=await request();assert.equal(r.size,0);assert.equal(hits,3);checks.push('two transient 504 responses recover automatically');
        mode='bad-type';hits=0;r=await request();assert.equal(r.code,'CORRUPTION');assert.equal(hits,1);checks.push('invalid response is not retried');
        mode='unavailable';hits=0;
        const cancelled=page.evaluate(async()=>{const {RemoteDisk}=await import('/build/disk/web/remote-test.js');const c=new AbortController();window.cancelGateway=()=>c.abort();try{await new RemoteDisk({}).request('/ipfs/test','application/vnd.ipld.raw',10240,c.signal);}catch(e){return e.code;}});
        while(hits===0)await new Promise(r=>setTimeout(r,5));
        await page.evaluate(()=>window.cancelGateway());assert.equal(await cancelled,'CANCELLED');await new Promise(r=>setTimeout(r,300));assert.equal(hits,1);checks.push('cancellation prevents retry during backoff');
        mode='slow';hits=0;
        r=await page.evaluate(async()=>{const {RemoteDisk}=await import('/build/disk/web/remote-test.js');const start=performance.now();try{await new RemoteDisk({timeoutMs:650}).request('/ipfs/test','application/vnd.ipld.raw',10240);}catch(e){return {code:e.code,ms:performance.now()-start};}});
        assert.equal(r.code,'IO_ERROR');assert(r.ms>=600&&r.ms<1200);assert.equal(hits,2);checks.push('retries share the original timeout budget');
        mode='network';r=await request();assert.match(r.message,/network, CORS, or a redirect/);checks.push('fetch failure does not assert missing data');
        let live;
        if(process.argv.includes('--public')) {
            await page.unroute('https://trustless-gateway.net/**');
            live=await page.evaluate(async()=>{
                const {RemoteDisk}=await import('/build/disk/web/remote-test.js');
                const remote=new RemoteDisk({});
                const bytes=await remote.request('/ipfs/bafkqaaa?format=raw','application/vnd.ipld.raw',10240);
                return {gateway:remote.gateway,size:bytes.length};
            });
            assert.equal(live.size,0);checks.push('real public gateway CORS and verifiable response');
        }
        results.push({browser:name,checks,live});console.log(name+': '+checks.length+' gateway checks');
    } finally {await browser.close();}
}
await mkdir(repo+'build/ipfs',{recursive:true});await writeFile(repo+'build/ipfs/gateway-results.json',JSON.stringify(results,null,2));
} finally {await new Promise(r=>server.close(r));}
