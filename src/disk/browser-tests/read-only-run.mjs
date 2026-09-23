import assert from 'node:assert/strict';
import {fixture,repo} from './ipfs-fixture.mjs';
import {makeServer} from './server.mjs';
import {chromium,webkit} from 'playwright';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const out=repo+'build/read-only'; await mkdir(out,{recursive:true});
execFileSync('nasm',['-f','bin',repo+'src/disk/browser-tests/read-only-boot.asm','-o',out+'/boot.bin']);
const bytes = Buffer.alloc(3*1024*1024);
for(let i=1024;i<bytes.length;i++) bytes[i]=(i*31) & 255;
bytes.set(await readFile(out+'/boot.bin'));
await writeFile(out+'/boot.img',bytes);
const small=JSON.parse(execFileSync(repo+'build/disk-target/release/examples/compat',['pack',out+'/boot.img',out+'/boot.my98'],{cwd:repo,encoding:'utf8'}));
const hash=buffer=>createHash('sha256').update(buffer).digest('hex');
const originalEncrypted=hash(await readFile(small.file));
const f=await fixture({small}), server=makeServer(repo), results=[];
await new Promise(r=>server.listen(0,'127.0.0.1',r));
try {
    for(const [name,type] of Object.entries({chromium,webkit})) {
        const browser=await type.launch({headless:true});
        try {
            const page=await browser.newPage(),errors=[];
            page.on('pageerror',error=>errors.push(String(error)));
            await page.exposeFunction('setGatewayMode',f.setMode);
            await page.exposeFunction('gatewayRequestCount',()=>f.requests.length);
            const url=`http://127.0.0.1:${server.address().port}/disk/browser-tests/index.html`;
            const inputs=async()=>{
                await page.evaluate(()=>{document.body.innerHTML='<input id="encrypted" type="file"><input id="plain" type="file">';});
                await page.locator('#encrypted').setInputFiles(small.file);
                await page.locator('#plain').setInputFiles(small.source);
            };
            await page.goto(url); await inputs();
            const args={endpoint:f.endpoint,cid0:f.cid0,cid1:f.cid1,directoryCid:f.directoryCid,identity:f.identity,ipnsName:f.identity.ipnsName,sha256:small.sha256,original17:bytes[17]};
            const result=await page.evaluate(async f=>(await import('/disk/browser-tests/read-only.mjs')).runReadOnly(f),args);
            await page.reload(); await inputs();
            const boot=await page.evaluate(async f=>(await import('/disk/browser-tests/read-only.mjs')).bootReadOnly(f),args);
            await page.goto(url+'?no-isolation'); await inputs();
            const withoutIsolation=await page.evaluate(async f=>{
                const {Slop86Disk}=await import('/build/disk/web/client.js');
                const owner=await Slop86Disk.create(); let c;
                try {
                    await owner.unlock('disk fixtures','public compatibility password','main');
                    await owner.open(document.querySelector('#encrypted').files[0]);
                    const readKey=await owner.exportReadOnlyKey(); await owner.close();
                    c=await Slop86Disk.create();
                    await window.setGatewayMode('hang');
                    const opening=c.openReadOnly({cid:f.cid0,readKey,gateway:f.endpoint});
                    setTimeout(()=>c.cancel(),100);
                    let code;try{await opening;}catch(e){code=e.code;}
                    await window.setGatewayMode('small');
                    const state=await c.openReadOnly({cid:f.cid0,readKey,gateway:f.endpoint,prefetch:{enabled:false}});
                    return {isolated:crossOriginIsolated,code,retried:state.readOnly};
                } finally {await c?.close();await owner.close();await window.setGatewayMode('small');}
            },args);
            assert.deepEqual(withoutIsolation,{isolated:false,code:'CANCELLED',retried:true});
            assert.deepEqual(errors,[]);
            results.push({browser:name,version:browser.version(),...result,boot,withoutIsolation,errors});
            console.log(name+': '+result.checks.length+' read-only checks; '+boot.serial);
        } finally {await browser.close();}
    }
    assert.equal(f.requests.filter(r=>r.path.startsWith('/ipns/')).length,0);
    assert.equal(hash(await readFile(small.file)),originalEncrypted);
    assert.equal(hash(await readFile(small.source)),small.sha256);
    await writeFile(out+'/results.json',JSON.stringify({results,noIpnsRequests:true,sourceUnchanged:true},null,2));
} finally {await new Promise(r=>server.close(r));await f.close();}
