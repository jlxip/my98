import {fixture,repo} from './ipfs-fixture.mjs';
import {makeServer} from './server.mjs';
import {chromium,webkit} from 'playwright';
import {writeFile,readFile,copyFile,open} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const uiOnly=process.argv.includes('--ui-only');
const f=await fixture(),server=makeServer(repo),results=[];
await new Promise(r=>server.listen(0,'127.0.0.1',r));
try {
    for(const [name,type] of Object.entries({chromium,webkit})) {
        console.log(name+': remote suite');
        const browser=await type.launch({headless:true});
        try {
            const page=await browser.newPage(),errors=[];
            page.on('pageerror',e=>errors.push(String(e)));
            await page.exposeFunction('setGatewayMode',f.setMode);
            await page.goto(`http://127.0.0.1:${server.address().port}/disk/browser-tests/index.html`);
            if(!uiOnly) {
            const result=await page.evaluate(async f=>{const {runRemote}=await import('/disk/browser-tests/remote.mjs');return runRemote(f);},{endpoint:f.endpoint,small:f.small,cid0:f.cid0});
            for(const [variable,suffix] of [['remoteOriginal','original'],['remoteSaved','saved']]) {
                const event=page.waitForEvent('download');
                await page.evaluate(variable=>{const a=document.createElement('a');a.href=URL.createObjectURL(window[variable]);a.download='disk.my98';a.click();},variable);
                await(await event).saveAs(f.out+`/${name}-${suffix}.my98`);
            }
            const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
            if(hash(await readFile(f.out+`/${name}-original.my98`))!==hash(await readFile(repo+f.small.file)))throw Error('Full download differs from original');
            const expected=f.out+`/${name}-expected.img`;await copyFile(repo+f.small.source,expected);const file=await open(expected,'r+');await file.write(Buffer.from([211]),0,1,17);await file.close();
            execFileSync(repo+'build/disk-target/release/examples/compat',['verify',f.out+`/${name}-saved.my98`,expected],{cwd:repo,stdio:'inherit'});
            if(errors.length)throw Error(errors.join('\n'));
            results.push({browser:name,version:browser.version(),...result,errors});
            console.log(name+': '+result.checks.length+' checks; '+JSON.stringify(result.cold));
            // Network cancellation must work without cross-origin isolation too.
            await page.goto(`http://127.0.0.1:${server.address().port}/disk/browser-tests/index.html?no-isolation`);
            f.setMode('hang');
            const cancellation=await page.evaluate(async gateway=>{const {Slop86Disk}=await import('/build/disk/web/client.js');const c=await Slop86Disk.create();await c.unlock('disk fixtures','public compatibility password','main');const p=c.openRemote({gateway});setTimeout(()=>c.cancel(),100);let code;try{await p;}catch(e){code=e.code;}await c.close();return {code,isolated:crossOriginIsolated};},f.endpoint);
            if(cancellation.code!=='CANCELLED'||cancellation.isolated)throw Error('Non-isolated cancellation failed');
            results.at(-1).cancellationWithoutIsolation=cancellation;
            } else {results.push({browser:name,version:browser.version()});}
            await page.goto(`http://127.0.0.1:${server.address().port}/disk/browser-tests/index.html`);
            results.at(-1).ui=await page.evaluate(async gateway=>{const {runRemoteUi}=await import('/disk/browser-tests/remote-ui.mjs');return runRemoteUi(gateway);},f.endpoint);
            await page.screenshot({path:f.out+`/${name}-remote-ui.png`,fullPage:true});
            await page.setViewportSize({width:390,height:844});
            if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Remote UI overflows mobile viewport');
            await page.screenshot({path:f.out+`/${name}-remote-mobile.png`,fullPage:true});
            await page.evaluate(()=>window.closeRemoteUi());
            if(errors.length)throw Error(errors.join('\n'));
        } finally {await browser.close();}
    }
    await writeFile(f.out+(uiOnly?'/ui-results.json':'/browser-results.json'),JSON.stringify(results,null,2));
} finally {await new Promise(r=>server.close(r));await f.close();}
