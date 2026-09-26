import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {chromium,webkit} from 'playwright';
import {serveSite,quietAudio} from './server.mjs';
import {diskFixture} from './fixture.mjs';
import {unlockIdentity,bootEncrypted} from './encrypted.mjs';

const output='build/disk-progress';
await mkdir(output,{recursive:true});
const html=(await readFile('build/site/index.html','utf8')).replace(/<script type="module">[\s\S]*?<\/script>/,'').replace('<body inert>','<body>');
const fixture=await diskFixture({isolated:true,sizeBytes:2*65536+512}),results=[];
const bootFixture=await diskFixture({isolated:true});
try {for(const [engine,type] of Object.entries({chromium,webkit})) {
    const server=await serveSite({headers:true}),browser=await type.launch();
    try {
        const context=await browser.newContext({viewport:{width:1280,height:900}});
        await context.routeWebSocket('**/*',socket=>socket.close());
        await context.addInitScript(quietAudio);
        const page=await context.newPage(),errors=[];
        page.on('pageerror',e=>errors.push(String(e)));
        page.on('dialog',d=>d.accept());
        await page.route('**/progress-test',route=>route.fulfill({contentType:'text/html',body:html}));
        await page.goto(server.url+'progress-test');
        const cases=await page.evaluate(async()=>{
            const {setupDiskProgress}=await import('./src/browser/disk-progress.js');
            const ring=document.querySelector('#disk-progress'),checks=[];
            const check=(name,ok)=>{if(!ok)throw Error(name);checks.push(name);};
            const sleep=ms=>new Promise(r=>setTimeout(r,ms));
            let session=null,data={remote:{coveredBytes:0,totalBytes:1000}},calls=0,release;
            const client={async readStats(){calls++;return data;}};
            const controller=setupDiskProgress(ring,()=>session);
            const refresh=async()=>{controller.update();await sleep(30);};
            await refresh();check('hidden without remote session',ring.hidden&&calls===0);
            session={client,adapter:{},cid:'a',busy:false};await refresh();
            check('zero coverage',!ring.hidden&&ring.textContent.trim()==='0%');
            data.remote.coveredBytes=429;await refresh();
            check('integer floor and precise arc',ring.textContent.trim()==='42%'&&ring.querySelector('circle:last-child').getAttribute('stroke-dasharray')==='42.9 100');
            check('accessible without live announcements',ring.getAttribute('role')==='progressbar'&&ring.getAttribute('aria-label')==='Disk downloaded'&&ring.getAttribute('aria-valuenow')==='42'&&!ring.hasAttribute('aria-live'));
            data.remote.coveredBytes=999;await refresh();check('incomplete never 100',ring.textContent.trim()==='99%');
            data.remote.coveredBytes=1000;await refresh();check('complete remains visible',!ring.hidden&&ring.textContent.trim()==='100%');
            for(const remote of [undefined,{coveredBytes:1,totalBytes:0},{coveredBytes:-1,totalBytes:100},{coveredBytes:101,totalBytes:100},{coveredBytes:NaN,totalBytes:100}]) {
                data={remote};await refresh();check('invalid stats hidden '+checks.length,ring.hidden);
            }
            client.readStats=async()=>{calls++;throw Error('unavailable');};await refresh();check('query failure hidden',ring.hidden);
            client.readStats=async()=>{calls++;return {remote:{coveredBytes:10,totalBytes:100}};};await refresh();
            check('recovers after failure',ring.textContent.trim()==='10%'&&!ring.hidden);
            client.readStats=()=>{calls++;return new Promise(r=>release=r);};controller.update();
            const before=calls;await sleep(1100);check('only one pending query',calls===before);
            const oldRelease=release;session=null;controller.update();
            session={client,adapter:{},cid:'b',busy:false};controller.update();
            oldRelease({remote:{coveredBytes:100,totalBytes:100}});await sleep(30);
            check('old session response ignored',ring.hidden);
            await sleep(520);check('new session query resumes',calls===before+1);
            release({remote:{coveredBytes:20,totalBytes:100}});await sleep(30);check('new session coverage',ring.textContent.trim()==='20%');
            let hidden=true;Object.defineProperty(document,'hidden',{configurable:true,get:()=>hidden});
            document.dispatchEvent(new Event('visibilitychange'));const hiddenCalls=calls;await sleep(600);
            check('hidden tab suspends polling',calls===hiddenCalls);
            hidden=false;document.dispatchEvent(new Event('visibilitychange'));
            check('visible tab refreshes immediately',calls===hiddenCalls+1);
            hidden=true;document.dispatchEvent(new Event('visibilitychange'));
            release({remote:{coveredBytes:80,totalBytes:100}});await sleep(30);
            check('inflight hidden response ignored',ring.textContent.trim()==='20%');
            session.busy=true;hidden=false;document.dispatchEvent(new Event('visibilitychange'));const busyCalls=calls;await sleep(600);
            check('busy operation does not queue stats',calls===busyCalls);
            delete document.hidden;session=null;controller.update();
            window.progressController=controller;
            window.setProgressSession=value=>{session=value;controller.update();};
            return checks;
        });
        // Actual encrypted ranges, including a short final record and persistent-cache reuse.
        const coverage=[];
        for(const warm of [false,true]) {
            const requestStart=fixture.requests.length;
            const measured=await page.evaluate(async gateway=>{
                const {Slop86Disk}=await import('./build/disk/web/client.js');
                const disk=await Slop86Disk.create(),ring=document.querySelector('#disk-progress');
                const refresh=async()=>{window.progressController.update();await new Promise(r=>setTimeout(r,80));return ring.textContent.trim();};
                try {
                    await disk.unlock('disk fixtures','public compatibility password','main');
                    const state=await disk.openRemote({gateway,servers:[{url:gateway,resolution:'gateway',discovery:false}],prefetch:{enabled:false},persistentCache:{publication:true}});
                    window.setProgressSession({client:disk,adapter:{},cid:state.remote.cid,busy:false});
                    await new Promise(r=>setTimeout(r,80));
                    await disk.read(0,65536);const first=(await disk.readStats()).remote,firstLabel=await refresh();
                    await disk.read(0,65536);const repeated=(await disk.readStats()).remote;
                    await disk.read(65536,65536);const partial=(await disk.readStats()).remote,partialLabel=await refresh();
                    await disk.read(2*65536,512);const complete=(await disk.readStats()).remote,completeLabel=await refresh();
                    for(let n=0;n<200;n++){if(!(await disk.readStats()).remote.persistentCache.pendingWrites)break;await new Promise(r=>setTimeout(r,10));}
                    return {first,repeated,partial,complete,firstLabel,partialLabel,completeLabel};
                } finally {window.setProgressSession(null);await disk.close();}
            },fixture.gateway);
            assert(measured.first.coveredBytes>0&&measured.first.coveredBytes<measured.first.totalBytes);
            assert.equal(measured.firstLabel,Math.floor(100*measured.first.coveredBytes/measured.first.totalBytes)+'%');
            assert.equal(measured.first.coveredBytes,measured.repeated.coveredBytes);
            assert(measured.partial.coveredBytes<measured.partial.totalBytes);assert.notEqual(measured.partialLabel,'100%');
            assert.equal(measured.complete.coveredBytes,measured.complete.totalBytes);assert.equal(measured.completeLabel,'100%');
            const requests=fixture.requests.slice(requestStart).filter(p=>p.startsWith('/ipfs/'));
            if(warm)assert.deepEqual(requests,[]);else assert(requests.length>0);
            coverage.push({warm,...measured,requests});
        }
        // Layout uses the actual page markup and component, independently of the VM.
        await page.evaluate(()=>{
            document.querySelector('#welcome').hidden=true;document.querySelector('#session').hidden=false;
            document.querySelector('#disk-name').textContent='Encrypted disk';
            window.setProgressSession({client:{async readStats(){return {remote:{coveredBytes:429,totalBytes:1000}};}},adapter:{},cid:'layout',busy:false});
        });
        await page.waitForFunction(()=>document.querySelector('#disk-progress span').textContent==='42%');
        for(const width of [1280,390,320]) {
            await page.setViewportSize({width,height:900});
            assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
            const box=await page.locator('#disk-progress').boundingBox();assert.equal(box.width,40);assert.equal(box.height,40);
            assert(await page.evaluate(()=>{const a=document.querySelector('#disk-progress').getBoundingClientRect(),b=document.querySelector('#ips').getBoundingClientRect();return a.right<=b.left&&Math.abs(a.y+a.height/2-b.y-b.height/2)<1;}));
            await page.locator('.session-title').screenshot({path:`${output}/${engine}-${width}.png`});
        }
        await page.setViewportSize({width:1280,height:900});
        // Real controller and emulator: remote indicator, fullscreen, reload and local disk.
        await page.goto(server.url);await page.waitForFunction(()=>!document.body.inert);
        await page.evaluate(async gateway=>{
            const {Slop86Disk}=await import('./build/disk/web/client.js');const open=Slop86Disk.prototype.openRemote;
            Slop86Disk.prototype.openRemote=function(options){return open.call(this,{...options,gateway,servers:[{url:gateway,resolution:'gateway',discovery:false}]});};
        },bootFixture.gateway);
        await unlockIdentity(page);await page.locator('#disk-remote').click();
        await page.waitForFunction(()=>!document.querySelector('#disk-boot').disabled);
        assert.equal(await page.locator('#disk-progress').isVisible(),false);
        await page.locator('#disk-boot').click();
        await page.waitForFunction(()=>!document.querySelector('#session').hidden&&!document.querySelector('#pause').disabled);
        await page.waitForFunction(()=>document.querySelector('#disk-progress span').textContent==='100%');
        assert(await page.locator('#vm-view').evaluate(e=>e.classList.contains('expanded')));
        assert(await page.evaluate(()=>{const r=document.querySelector('#disk-progress').getBoundingClientRect();return !document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('#disk-progress');}));
        await page.evaluate(()=>document.querySelector('#fullscreen').click());
        await page.waitForFunction(()=>!document.querySelector('#vm-view').classList.contains('expanded'));
        assert(await page.locator('#disk-progress').isVisible());
        // Close/reopen invalidation is covered above; integration.mjs covers the
        // Close identity UI. Navigate this isolated VM to test a fresh local session.
        await page.goto(server.url);await page.waitForFunction(()=>!document.body.inert);
        assert.equal(await page.locator('#disk-progress').getAttribute('aria-valuenow'),null);
        await bootEncrypted(page,bootFixture.file);await page.waitForTimeout(600);
        assert.equal(await page.locator('#disk-progress').getAttribute('aria-valuenow'),null);
        assert.equal(await page.locator('#disk-progress').isVisible(),false);
        assert.deepEqual(errors,[]);
        results.push({engine,cases,coverage,layout:[1280,390,320],remoteBoot:true,fullscreen:true,reload:true,localBoot:true,errors});
        console.log(engine,`${cases.length} lifecycle checks, cold/warm ranges, remote/local boot and layout PASS`);
    } finally {await browser.close();await server.close();}
}} finally {await fixture.close();await bootFixture.close();}
await writeFile(`${output}/results.json`,JSON.stringify(results,null,2));
