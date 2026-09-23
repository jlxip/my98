import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {createIPNSRecord,marshalIPNSRecord,unmarshalIPNSRecord} from 'ipns';
import {serveSite} from './server.mjs';
import {diskFixture} from './fixture.mjs';
const out='build/resolution';await mkdir(out,{recursive:true});
const f=await diskFixture(),site=await serveSite({headers:true}),results=[];
const compat=resolve('build/disk-target/release/examples/compat');
const identity=JSON.parse(execFileSync(compat,['identity'],{encoding:'utf8'}));
const old=new Uint8Array(await (await fetch(f.gateway+'/ipns/'+identity.ipnsName)).arrayBuffer());
const value=unmarshalIPNSRecord(old).value;
const signer={type:'Ed25519',sign:async bytes=>new Uint8Array(Buffer.from(execFileSync(compat,['sign',Buffer.from(bytes).toString('hex')],{encoding:'utf8'}).trim(),'hex'))};
const fresh=marshalIPNSRecord(await createIPNSRecord(signer,value,9007199254740993n,3600000,{v1Compatible:false}));
const queries=[];let mode='normal';
const routing=createServer((req,res)=>{
    queries.push(req.url);res.setHeader('Access-Control-Allow-Origin','*');
    if(mode==='hang')return;
    if(req.url.startsWith('/invalid/')){res.writeHead(200,{'Content-Type':'application/vnd.ipfs.ipns-record'}).end(new Uint8Array([1,2,3]));return;}
    const delayed=req.url.startsWith('/new/');
    const timer=setTimeout(()=>res.writeHead(200,{'Content-Type':'application/vnd.ipfs.ipns-record'}).end(delayed?fresh:old),delayed?100:0);
    res.once('close',()=>clearTimeout(timer));
});
await new Promise(r=>routing.listen(0,'127.0.0.1',r));
const queryBase='http://127.0.0.1:'+routing.address().port;
try{
 for(const [name,type] of Object.entries({chromium,webkit})){
    const browser=await type.launch();
    try{
        const context=await browser.newContext(),errors=[],external=[],requests=[];
        await context.route('**/*',async route=>{
            const url=new URL(route.request().url());
            if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)){external.push(url.href);return route.abort();}
            requests.push(url.href);
            if(url.pathname==='/build/disk/web/client.js'){
                const source=await readFile('build/disk/web/client.js','utf8');
                // WebKit cannot route Worker requests. Substitute only the fixture port
                // at the public API boundary, retaining/asserting the actual UI options.
                const patch=`\nconst open=Slop86Disk.prototype.openRemote;Slop86Disk.prototype.openRemote=function(options){if(options.onlyLocalhost&&options.gateway==='http://127.0.0.1:8080'){globalThis.localUiOptions=options;return open.call(this,{...options,gateway:${JSON.stringify(f.gateway)}});}return open.call(this,options);};`;
                return route.fulfill({contentType:'text/javascript',body:source+patch});
            }
            return route.continue();
        });
        const page=await context.newPage();page.on('dialog',dialog=>dialog.accept());page.on('pageerror',e=>errors.push(String(e)));
        await page.goto(site.url);await page.waitForFunction(()=>!document.body.inert&&!document.querySelector('#disk-user').disabled);
        const checked=[],ok=label=>{checked.push(label);console.log(name+': '+label);};
        assert.equal(await page.locator('#disk-only-localhost').isChecked(),false);
        assert.equal(await page.locator('#disk-settings, #disk-gateway').count(),0);
        await page.locator('#disk-only-localhost').focus();await page.keyboard.press('Space');
        assert.equal(await page.locator('#disk-only-localhost').isChecked(),true);
        await page.keyboard.press('Space');
        assert.equal(await page.locator('#disk-only-localhost').isChecked(),false);ok('default off, visible checkbox and keyboard toggle');
        for(const viewport of [{width:1280,height:900},{width:390,height:844}]){
            await page.setViewportSize(viewport);
            assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
            await page.screenshot({path:`${out}/${name}-${viewport.width}.png`,fullPage:true});
        }
        ok('login desktop/mobile layout');
        await page.locator('#disk-only-localhost').check();
        await page.locator('#disk-autoboot').uncheck();
        await page.locator('#disk-user').fill('disk fixtures');await page.locator('#disk-password').fill('public compatibility password');
        await page.locator('#disk-login button').click();
        await page.waitForFunction(()=>!document.querySelector('#disk-remote').disabled&&!document.querySelector('#disk-workspace').hidden);
        await page.locator('#disk-remote').click();
        await page.waitForFunction(()=>!document.querySelector('#disk-boot').disabled,{},{timeout:10000}).catch(async e=>{console.log(await page.evaluate(()=>({status:document.querySelector('#disk-status').textContent,options:globalThis.localUiOptions})));console.log({external,requests,fixtureRequests:f.requests});throw e;});
        assert.equal(await page.locator('#disk-only-localhost').isDisabled(),true);
        assert.deepEqual(await page.evaluate(()=>globalThis.localUiOptions),{gateway:'http://127.0.0.1:8080',onlyLocalhost:true,prefetch:{enabled:false}});
        assert(f.requests.some(u=>u.startsWith('/ipns/')));assert(f.requests.some(u=>u.startsWith('/ipfs/')));ok('real UI resolves and downloads only through localhost, options locked');
        await page.locator('#disk-close').click();
        await page.waitForFunction(()=>!document.querySelector('#disk-login').hidden);
        await page.reload();await page.waitForFunction(()=>!document.body.inert);
        assert.equal(await page.locator('#disk-only-localhost').isChecked(),false);ok('local preference is not persisted');
        const before=f.requests.length;
        const api=await page.evaluate(async({gateway,base})=>{
            const {Slop86Disk}=await import('/build/disk/web/client.js');
            const c=await Slop86Disk.create();let ro;
            try{
                await c.unlock('disk fixtures','public compatibility password','main');
                const state=await c.openRemote({gateway,servers:[{url:base+'/old',resolution:'gateway',discovery:false},{url:base+'/new',resolution:'routing',discovery:true}],prefetch:{enabled:false}});
                const readKey=await c.exportReadOnlyKey();
                await c.close();
                ro=await Slop86Disk.create();
                const roState=await ro.openReadOnly({gateway,cid:state.remote.cid,readKey,onlyLocalhost:true,prefetch:{enabled:false}});
                await ro.read(0,512);
                return {remote:state.remote,readOnly:roState.readOnly};
            }finally{await c.close();await ro?.close();}
        },{gateway:f.gateway,base:queryBase});
        assert.equal(api.remote.sequence,'9007199254740993');assert.equal(api.remote.resolutionServer,queryBase+'/new');
        assert.equal(api.remote.rootCid,api.remote.cid);assert(api.readOnly);
        assert.deepEqual(queries.slice(-2).map(x=>x.split('/')[1]).sort(),['new','old']);
        assert(f.requests.slice(before).every(p=>p.startsWith('/ipfs/')));ok('Worker selects newest signed record across protocols; read-only never resolves');
        const recovered=await page.evaluate(async ({gateway,base})=>{
            const {Slop86Disk}=await import('/build/disk/web/client.js');const c=await Slop86Disk.create();
            try{
                await c.unlock('disk fixtures','public compatibility password','main');
                let code;
                try{await c.openRemote({onlyLocalhost:true,gateway:base+'/invalid',servers:[{url:'https://unused.invalid',resolution:'gateway',discovery:false}]});}catch(e){code=e.code;}
                if(code!=='CORRUPTION')throw Error('Expected invalid local record');
                return !!(await c.openRemote({onlyLocalhost:true,gateway,prefetch:{enabled:false}})).remote;
            }finally{await c.close();}
        },{gateway:f.gateway,base:queryBase});
        assert(recovered);ok('local failure has no public fallback; identity remains usable for retry');
        mode='hang';const beforeCancel=queries.length;
        const cancellation=await page.evaluate(async base=>{
            const {Slop86Disk}=await import('/build/disk/web/client.js');const c=await Slop86Disk.create();
            try{
                await c.unlock('disk fixtures','public compatibility password','main');
                const pending=c.openRemote({servers:[{url:base+'/hang',resolution:'routing',discovery:true}]});
                setTimeout(()=>c.cancel(),100);
                try{await pending;throw Error('unexpected open');}catch(e){return e.code;}
            }finally{await c.close();}
        },queryBase);
        assert.equal(cancellation,'CANCELLED');assert.equal(queries.length,beforeCancel+1);mode='normal';ok('Worker cancellation aborts resolution before blocks');
        assert.deepEqual(external,[]);assert.deepEqual(errors,[]);ok('no external IPFS requests or JavaScript errors');
        results.push({browser:name,checks:checked});console.log(name+': '+checked.length+' resolution checks PASS');
    }finally{await browser.close();}
 }
 await writeFile(out+'/browser-results.json',JSON.stringify(results,null,2));
}finally{routing.closeAllConnections();await new Promise(r=>routing.close(r));await site.close();await f.close();}
