// Failure paths of the shipped UI, with a controlled disk client and VM host.
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {chromium, webkit} from 'playwright';
import {serveSite} from './server.mjs';

const html = await readFile('build/site/index.html', 'utf8');
const panel = html.slice(html.indexOf('<main id="welcome">'), html.indexOf('<main id="session"'));
const results = [];
for(const [name, type] of Object.entries({chromium, webkit})) {
    const server = await serveSite({prefix:'/my98/'}), browser = await type.launch();
    try {
        const page = await browser.newPage(), errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        await page.route('**/analysis-controls-test', route => route.fulfill({contentType:'text/html', body:panel}));
        await page.goto(server.url + 'analysis-controls-test');
        const checks = await page.evaluate(async () => {
            const {setupDisk} = await import('./src/browser/disk-ui.js');
            const {Slop86Disk} = await import('./build/disk/web/client.js');
            const $ = id => document.getElementById('disk-' + id);
            const checks = [], check = (label, ok) => {if(!ok) throw Error(label); checks.push(label);};
            let controller, busy = false, session = true, approved = false, failedBoot = true;
            let vmAdapter, started = 0, cancelled = 0, stopped = 0, resumed = 0, closed = 0, downloaded;
            let generationFails = true, generationCalls = 0, options;
            const state = {size:655360, disk_id:[1,2,3,4], dirty_bytes:0, remote:{cid:'snapshot'}};
            const client = {
                unlock:async()=>({ipnsName:'test'}), openRemote:async()=>state,
                startLoadAnalysis:async()=>{started++;}, cancelLoadAnalysis:async()=>{cancelled++;},
                read:async()=>new Uint8Array(512), resumePrefetch:async()=>{}, setLoadPrefetch:async()=>{},
                finishLoadAnalysis:async()=>{generationCalls++;if(generationFails) {generationFails=false;throw Error('Generation failed');}return [{version:2,origin:{kind:'boot'},cid:'snapshot',unitBytes:65536,ranges:[[0,0],...Array(31).fill(null)]}];},
                close:async()=>{closed++;},
            };
            Slop86Disk.create = async value => {options=value;return client;};
            window.confirm = () => approved;
            controller = setupDisk({
                busy:()=>busy, setBusy:value=>{busy=value;controller?.syncControls(value);},
                hasSession:()=>session, boot:async adapter=>{if(failedBoot) {failedBoot=false;throw Error('Boot failed');}vmAdapter=adapter;session=true;},
                fail:async()=>{stopped++;}, stop:async()=>{stopped++;},
                resume:async()=>{resumed++;}, close:async()=>{session=false;},
                download:(blob,name)=>{downloaded={blob,name};},
            });
            const idle = async () => {for(let i=0;busy;i++){if(i>1000)throw Error('UI stuck');await new Promise(r=>setTimeout(r,1));}};
            const click = async id => {$(id).onclick();await idle();};
            $('autoboot').checked=false;$('login').dispatchEvent(new Event('submit', {cancelable:true}));await idle();await click('remote');
            await click('analyze');await click('analyze-boot');check('declining replacement starts no analysis', started===0);
            approved=true;await click('analyze');await click('analyze-boot');
            check('failed boot cancels recording and allows retry', started===1 && cancelled===1 && !$('analyze').disabled && $('analyze').textContent==='Analyze loads');
            await click('analyze');await click('analyze-boot');
            check('successful boot enables Stop analyzing', $('analyze').textContent==='Stop analyzing' && !$('analyze').disabled);
            vmAdapter.fail(new Error('Transient disk access'));
            await new Promise(r=>setTimeout(r,0));
            check('disk failure preserves analysis and exposes recovery', !$('resume').hidden && $('analyze').textContent==='Stop analyzing');
            await click('resume');check('recovery resumes the same analysis', resumed===1 && cancelled===1);
            await click('analyze');
            check('generation failure can be retried', !downloaded && $('analyze').textContent==='Stop analyzing' && !$('analyze').disabled && $('save').disabled);
            const before=stopped;await click('analyze');
            check('retry exports without stopping VM', generationCalls===2 && stopped===before && downloaded.name==='01020304-load-profile.json');
            check('download is JSON', downloaded.blob.type==='application/json' && JSON.parse(await downloaded.blob.text())[0].cid==='snapshot');
            check('finished session can choose a fresh starting point', !$('analyze').disabled);
            await click('close');check('closing identity resets controls', closed===1 && $('workspace').hidden);
            $('autoboot').checked=false;$('login').dispatchEvent(new Event('submit', {cancelable:true}));await idle();await click('remote');await click('analyze');await click('analyze-boot');
            options.onAnalysis({error:'Analysis exceeded 200,000 distinct blocks. No partial profile was exported.'});
            await new Promise(r=>setTimeout(r,0));
            check('overflow reports failure and releases analysis controls', $('status').textContent.includes('200,000') && $('analyze').textContent==='Analyze loads' && cancelled===2 && !$('save').disabled);
            await click('close');
            $('autoboot').checked=false;$('login').dispatchEvent(new Event('submit', {cancelable:true}));await idle();await click('remote');await click('analyze');await click('analyze-boot');await click('close');
            check('identity can close during analysis', closed===3 && $('workspace').hidden);
            return checks;
        });
        assert.deepEqual(errors, []);
        results.push({browser:name,checks,errors});
        console.log(`${name}: ${checks.length} boot analysis UI failure checks PASS`);
    } finally {await browser.close();await server.close();}
}
await writeFile('build/pages-tests/boot-analysis.json', JSON.stringify(results,null,2));
