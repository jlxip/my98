import assert from "node:assert/strict";
import {readFile, writeFile} from "node:fs/promises";
import {chromium, webkit} from "playwright";
import {serveSite} from "./server.mjs";

const html = await readFile("build/site/index.html", "utf8");
const panel = html.slice(html.indexOf('<main id="welcome">'), html.indexOf('<main id="session"'));
const results = [];
for(const [name, type] of Object.entries({chromium, webkit})) {
    const server = await serveSite({headers:true}), browser = await type.launch();
    try {
        const page = await browser.newPage({viewport:{width:1280,height:900}}), errors = [];
        page.on("pageerror", error => errors.push(String(error)));
        await page.goto(server.url);
        await page.waitForFunction(() => !document.body.inert);
        assert.equal(await page.locator("#disk-autoboot").isChecked(), true);
        assert.equal(await page.locator("#disk-cold-login").isChecked(), false);
        assert.equal(await page.locator("#disk-machine").inputValue(), "main");
        assert.equal(await page.locator("#disk-only-localhost").isChecked(), false);
        assert.equal(await page.locator("#disk-settings, #disk-gateway").count(), 0);
        assert.equal(await page.locator("#choose-disk, #show-resume, #resume-form, #download-disk").count(), 0);
        assert.equal(await page.locator("#disk-workspace").isVisible(), false);
        for(const id of ["save-state","load-state","disk-load-state"]) assert.equal(await page.locator("#"+id).isVisible(),false);
        // macOS WebKit uses Option+Tab to include non-text form controls.
        const tabKey = name === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab";
        // Logical tab order, including checkbox and submit by keyboard.
        await page.locator("#disk-user").focus();
        for(const id of ["disk-password", "disk-machine", "disk-only-localhost", "disk-cold-login", "disk-autoboot"]) {
            await page.keyboard.press(tabKey);
            assert.equal(await page.evaluate(() => document.activeElement.id), id);
        }
        await page.keyboard.press("Space");
        assert.equal(await page.locator("#disk-autoboot").isChecked(), false);
        await page.keyboard.press(tabKey);
        assert.equal(await page.evaluate(() => document.activeElement.textContent), "Log in");
        await page.locator("#disk-autoboot").check();
        await page.locator("#disk-user").focus();
        for(const viewport of [{width:1280,height:900}, {width:390,height:844}, {width:320,height:300}]) {
            await page.setViewportSize(viewport);
            await page.screenshot({path:`build/pages-tests/${name}-login-${viewport.width}.png`,fullPage:true});
            assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            const box = await page.locator("#disk-panel").boundingBox();
            assert(Math.abs(box.x + box.width/2 - viewport.width/2) < 1);
            if(viewport.height > 500) assert(Math.abs(box.y + box.height/2 - viewport.height/2) < 1);
            await page.locator("#disk-login button").scrollIntoViewIfNeeded();
            assert(await page.locator("#disk-login button").evaluate(e => {const r=e.getBoundingClientRect();return r.top>=0 && r.bottom<=innerHeight;}));
        }
        // Controlled failures at the actual controller/client boundary; no production test hooks.
        await page.route("**/login-controls-test", route => route.fulfill({contentType:"text/html",body:panel}));
        await page.goto(server.url + "login-controls-test");
        const checks = await page.evaluate(async () => {
            const {setupDisk} = await import("./src/browser/disk-ui.js");
            const {Slop86Disk} = await import("./build/disk/web/client.js");
            const $ = id => document.getElementById("disk-" + id);
            const checks = [], check = (label, ok) => {if(!ok)throw Error(label);checks.push(label);};
            let busy=false, controller, session=false, failAt="", calls=[], options, unlockRelease, remoteReject;
            const state={size:524288,disk_id:[1,2,3,4],dirty_bytes:0,remote:{cid:"test"}};
            const client={
                async unlock(...args) {
                    calls.push(["unlock", ...args]);
                    if(failAt==="unlock")throw Error("Unlock failed");
                    if(failAt==="wait-unlock")await new Promise(resolve=>unlockRelease=resolve);
                    return {ipnsName:"test identity"};
                },
                async openRemote(value) {
                    calls.push(["open",value.gateway]);
                    if(failAt==="open")throw Error("Remote unavailable");
                    if(failAt==="wait-remote") {
                        options.onProgress({phase:"resolve"});
                        await new Promise((resolve,reject)=>remoteReject=reject);
                    }
                    return state;
                },
                async read() {calls.push(["read"]);return new Uint8Array(512);},
                async close() {calls.push(["close"]);},
                cancel() {calls.push(["cancel"]);remoteReject(Object.assign(Error("Cancelled"),{code:"CANCELLED"}));},
                async resumePrefetch() {},
            };
            Slop86Disk.create=async value=>{options=value;return client;};
            window.confirm=()=>true;
            controller=setupDisk({
                busy:()=>busy,setBusy:value=>{busy=value;controller?.syncControls(value);},
                hasSession:()=>session,
                boot:async()=>{calls.push(["boot"]);if(failAt==="boot")throw Error("Boot failed");session=true;},
                stop:async()=>{},close:async()=>{session=false;},
            });
            controller.syncControls(false);
            const wait = async predicate => {for(let i=0;!predicate();i++){if(i>1000)throw Error("UI stuck");await new Promise(r=>setTimeout(r,1));}};
            const idle=()=>wait(()=>!busy);
            const submit=()=>$('login').dispatchEvent(new Event('submit',{cancelable:true}));
            const fill=auto=>{$('user').value='User';$('password').value='secret';$('machine').value='other';$('autoboot').checked=auto;};
            const close=async()=>{$('close').onclick();await idle();calls=[];};
            const sequence=()=>calls.map(c=>c[0]).join(',');
            fill(false);submit();await idle();
            check('unchecked unlocks only, with exact identity inputs',sequence()==='unlock' && JSON.stringify(calls[0])===JSON.stringify(['unlock','User','secret','other']));
            check('management visible, password cleared, no disk to boot',!$('workspace').hidden && $('login').hidden && $('password').value==='' && $('boot').disabled);
            await close();
            check('logout restores login and default boot',!$('login').hidden && $('workspace').hidden && $('autoboot').checked);
            fill(true);submit();await idle();
            check('checked opens and boots exactly once in order',sequence()==='unlock,open,read,boot' && calls[1][1]===undefined && session);
            await close();
            failAt='unlock';fill(true);submit();await idle();
            check('unlock failure disposes candidate and retains login',sequence()==='unlock,close' && !$('login').hidden && $('status').textContent==='Unlock failed');
            calls=[];failAt='open';fill(true);submit();await idle();
            check('remote failure preserves identity without boot',sequence()==='unlock,open' && !$('workspace').hidden && !$('remote').disabled && $('boot').disabled && $('status').textContent==='Remote unavailable');
            failAt='';$('remote').onclick();await idle();
            check('remote failure can be retried without logging in',sequence()==='unlock,open,open' && !$('boot').disabled);
            check('disk without published state keeps resume disabled',$('resume-state').disabled);
            await close();
            failAt='boot';fill(true);submit();await idle();
            check('boot failure preserves authenticated disk',sequence()==='unlock,open,read,boot' && !$('boot').disabled && $('remote').disabled && $('status').textContent==='Boot failed');
            failAt='';$('boot').onclick();await idle();
            check('boot retry reuses opened disk',sequence()==='unlock,open,read,boot,read,boot' && session);
            await close();
            failAt='wait-unlock';fill(true);submit();await wait(()=>!!unlockRelease);
            submit();check('duplicate submit does not unlock twice',sequence()==='unlock' && $('user').disabled);
            unlockRelease();await idle();check('one full boot after duplicate',sequence()==='unlock,open,read,boot');
            await close();
            failAt='wait-remote';fill(true);submit();await wait(()=>!!remoteReject);
            check('remote progress and cancellation exposed',!$('cancel').hidden && !$('cancel').disabled && $('status').textContent==='Finding remote disk…');
            $('cancel').onclick();await idle();
            check('cancel preserves identity, stops before boot and releases controls',sequence()==='unlock,open,cancel' && !$('workspace').hidden && !$('remote').disabled && $('boot').disabled && $('cancel').hidden && $('status').textContent.includes('cancelled'));
            failAt='';$('remote').onclick();await idle();$('boot').onclick();await idle();
            check('cancelled open can be retried and booted',session && sequence()==='unlock,open,cancel,open,read,boot');
            await close();
            return checks;
        });
        assert.deepEqual(errors, []);
        results.push({browser:name,checks,errors});
        console.log(`${name}: login layout, keyboard and ${checks.length} flow/failure checks PASS`);
    } finally {await browser.close();await server.close();}
}
await writeFile("build/pages-tests/login.json",JSON.stringify(results,null,2));
