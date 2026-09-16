import {build} from '../scripts/bundle.mjs';
import {chromium,webkit} from 'playwright';
import {writeFile} from 'node:fs/promises';
import {fixture,repo} from './ipfs-fixture.mjs';
import {makeServer} from './server.mjs';

await build({entryPoints:[repo+'src/disk/browser-tests/prefetch.mjs'],bundle:true,format:'esm',platform:'browser',target:'es2022',outfile:repo+'build/disk/web/prefetch-test.js'});
const f=await fixture(),server=makeServer(repo),results=[];
await new Promise(r=>server.listen(0,'127.0.0.1',r));
try {for(const [name,type] of Object.entries({chromium,webkit})) {
    const browser=await type.launch({headless:true});
    try {
        const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));
        await page.goto(`http://127.0.0.1:${server.address().port}/disk/browser-tests/index.html`);
        const checks=await page.evaluate(async()=>{const {runPrefetch}=await import('/build/disk/web/prefetch-test.js');return runPrefetch();});
        console.log(name+': '+checks.length+' scheduler checks');
        await page.exposeFunction('setGatewayMode',f.setMode);
        const integration=[];
        for(const policy of ['demand','fresh-demand','nearby','streams','ranges','auto']) {
            f.setMode('small');
            integration.push(await page.evaluate(async({endpoint,small,policy})=>{
                const {Slop86Disk}=await import('/build/disk/web/client.js');
                const c=await Slop86Disk.create();
                const until=async fn=>{const start=performance.now();while(!await fn()){if(performance.now()-start>180000)throw Error('Download timeout');await new Promise(r=>setTimeout(r,20));}};
                const hex=b=>Array.from(b,v=>v.toString(16).padStart(2,'0')).join('');
                try {
                    await c.unlock('disk fixtures','public compatibility password','main');
                    const usesProfile=['ranges','auto'].includes(policy);
                    const bootProfile=usesProfile?{version:1,cid:small.rootCid,unitBytes:65536,ranges:[[2,3],[0,1],...Array(30).fill(null)]}:undefined;
                    await c.openRemote({gateway:endpoint,prefetch:{policy,bootProfile}});
                    await until(async()=>(await c.readStats()).remote.prefetchState==='complete');
                    const downloaded=await c.readStats();
                    if(usesProfile && !downloaded.remote.rangeProfile)throw Error('Range profile did not match');
                    await window.setGatewayMode('missing');
                    if(hex(await c.verifyImage())!==small.sha256)throw Error('Offline source hash');
                    await c.write(17,new Uint8Array([211]));
                    const expected=new Uint8Array(await(await fetch('/'+small.source)).arrayBuffer());expected[17]=211;
                    const saved=await c.save();
                    if(saved.remote || hex(await c.verifyImage())!==hex(new Uint8Array(await crypto.subtle.digest('SHA-256',expected))))throw Error('Offline save mismatch');
                    if((await c.readStats()).networkRequests!==downloaded.networkRequests)throw Error('Offline operations attempted network');
                    return {policy,downloaded,offlineVerifyAndSave:true};
                }finally{await c.close();}
            },{endpoint:f.endpoint,small:{...f.small,rootCid:f.cid0},policy}));
        }
        // Download a real encrypted 1 GiB fixture, then prove all plaintext can be read offline.
        f.setMode('large');
        const large=await page.evaluate(async({endpoint,sha256})=>{
            const {Slop86Disk}=await import('/build/disk/web/client.js');const c=await Slop86Disk.create();
            try {
                await c.unlock('disk fixtures','public compatibility password','main');const started=performance.now();
                await c.openRemote({gateway:endpoint});
                for(;;){const s=await c.readStats();if(s.remote.prefetchState==='complete')break;if(s.remote.prefetchState==='paused')throw Error(JSON.stringify(s));if(performance.now()-started>240000)throw Error('1 GiB timeout');await new Promise(r=>setTimeout(r,50));}
                const downloaded=await c.readStats(),ms=performance.now()-started;
                await window.setGatewayMode('missing');
                const hash=Array.from(await c.verifyImage(),b=>b.toString(16).padStart(2,'0')).join('');
                if(hash!==sha256 || (await c.readStats()).networkRequests!==downloaded.networkRequests)throw Error('1 GiB offline verification');
                return {ms,downloaded,offlineHash:hash};
            }finally{await c.close();}
        },{endpoint:f.endpoint,sha256:f.large.sha256});
        if(errors.length)throw Error(errors.join('\n'));
        results.push({browser:name,checks,integration,large,errors});
        console.log(name+': offline save and 1 GiB PASS, '+large.ms.toFixed(0)+' ms, '+large.downloaded.blockCacheBytes+' bytes retained');
        await writeFile(repo+'build/ipfs/prefetch-results.json',JSON.stringify(results,null,2));
    }finally{await browser.close();}
}}finally{server.closeAllConnections();await new Promise(r=>server.close(r));await f.close();}
