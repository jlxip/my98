import assert from "node:assert/strict";
import {mkdir, stat, writeFile} from "node:fs/promises";
import {chromium, webkit} from "playwright";
import {serveSite} from "./server.mjs";
import {unlockIdentity} from "./encrypted.mjs";

const output = "build/empty-disk";
await mkdir(output, {recursive:true});
const results = [];
for(const [name, type] of Object.entries({chromium, webkit})) {
    const server = await serveSite({headers:true}), browser = await type.launch();
    try {
        const page = await browser.newPage({viewport:{width:1280,height:900}}), errors = [], downloads = [];
        page.on("pageerror", error => errors.push(String(error)));
        page.on("download", download => downloads.push(download));
        await page.goto(server.url);
        await page.waitForFunction(() => !document.body.inert);
        const core = await page.evaluate(async () => {
            const {Slop86Disk} = await import("./build/disk/web/client.js");
            const checks=[], clients=[];
            const check=(label,ok)=>{if(!ok)throw Error(label);checks.push(label);};
            const rejects=async(label,fn,code)=>{
                try {await fn();} catch(error) {check(label, !code || error.code===code);return;}
                throw Error(label+" unexpectedly succeeded");
            };
            const make=async(options,password="public compatibility password")=>{
                const c=await Slop86Disk.create(options);clients.push(c);
                await c.unlock("disk fixtures",password,"main");return c;
            };
            try {
                const c=await make();
                for(const size of [undefined,null,"1048576",NaN,Infinity,-512,0,1,513,1.5,2**40+512,Number.MAX_SAFE_INTEGER+1]) {
                    await rejects("invalid size "+String(size),()=>c.createEmpty(size),"INVALID_SIZE");
                }
                check("invalid sizes leave no disk",await c.describe().then(()=>false,()=>true));
                const size=65536+512, saved=await c.createEmpty(size);
                check("partial final block and full encrypted length",saved.size===size && saved.download.size===198+size+2*62);
                check("all plaintext bytes zero",(await c.read(0,size)).every(byte=>byte===0));
                const identity=(await c.describe()).disk_id.join();
                await c.write(0,new Uint8Array([42]));
                await rejects("active disk cannot be replaced",()=>c.createEmpty(512),"OPERATION_FAILED");
                check("failed replacement preserves identity and writes",(await c.describe()).disk_id.join()===identity && (await c.read(0,1))[0]===42);
                const original=saved.download.blob;
                await c.close();
                const d=await make();await d.open(original);
                check("reopened empty disk exact",(await d.read(0,size)).every(byte=>byte===0));
                await d.write(65535,new Uint8Array([1,2,3]));await d.write(size-1,new Uint8Array([9]));
                const changed=(await d.save()).download.blob;await d.close();
                const e=await make();await e.open(changed);
                const expected=new Uint8Array(size);expected.set([1,2,3],65535);expected[size-1]=9;
                check("write/save/reopen preserves all bytes",(await e.read(0,size)).every((byte,i)=>byte===expected[i]));
                await e.close();
                const wrong=await make({},"wrong password");
                await rejects("wrong credentials",()=>wrong.open(original),"AUTHENTICATION_FAILED");await wrong.close();
                let armed=false,cancel;
                cancel=await make({onProgress:()=>{if(armed){armed=false;cancel.cancel();}}});
                armed=true;
                await rejects("cancel at valid 1 TiB maximum",()=>cancel.createEmpty(2**40),"CANCELLED");
                check("cancel leaves no partial disk",await cancel.describe().then(()=>false,()=>true));
                const retried=await cancel.createEmpty(512);
                check("retry after cancellation creates minimum sector",retried.size===512 && (await cancel.read(0,512)).every(byte=>byte===0));
                await cancel.close();
                const workerURL=URL.createObjectURL(new Blob([`
                    const NativeBlob=Blob;let fail=true;
                    globalThis.Blob=class extends NativeBlob {
                        constructor(parts,options) {
                            if(parts.length>1 && fail) {fail=false;throw Error("Injected assembly failure");}
                            super(parts,options);
                        }
                    };
                    await import(${JSON.stringify(new URL("./build/disk/web/worker.js",location.href).href)});
                `],{type:"text/javascript"}));
                try {
                    const failure=await make({workerUrl:workerURL});
                    await rejects("assembly failure",()=>failure.createEmpty(1048576));
                    check("assembly failure leaves no partial disk",await failure.describe().then(()=>false,()=>true));
                    check("assembly failure retry",(await failure.createEmpty(512)).size===512);
                    await failure.close();
                } finally {URL.revokeObjectURL(workerURL);}
                return checks;
            } finally {await Promise.all(clients.map(client=>client.close()));}
        });
        console.log(name+": "+core.length+" empty disk API checks PASS");
        await unlockIdentity(page);
        await page.locator("#disk-empty").click();
        assert.equal(await page.locator("#disk-empty-size").inputValue(), "1024");
        assert.equal(await page.evaluate(()=>document.activeElement.id), "disk-empty-size");
        const tabKey=name==="webkit" && process.platform==="darwin" ? "Alt+Tab" : "Tab";
        await page.keyboard.press(tabKey);
        assert.equal(await page.evaluate(()=>document.activeElement.id), "disk-empty-submit");
        await page.keyboard.press(tabKey);
        assert.equal(await page.evaluate(()=>document.activeElement.id), "disk-empty-cancel");
        await page.keyboard.press("Enter");
        assert.equal(await page.locator("#disk-empty-form").isVisible(), false);
        assert.equal(await page.evaluate(()=>document.activeElement.id), "disk-empty");
        assert.equal(downloads.length,0);
        await page.locator("#disk-empty").click();
        for(const size of ["","0","-1","1.5","1048577"]) {
            await page.locator("#disk-empty-size").fill(size);
            await page.locator("#disk-empty-submit").click();
            assert.equal(await page.locator("#disk-empty-size").evaluate(e=>e.validity.valid),false);
            assert.equal(downloads.length,0);
            assert.equal(await page.locator("#disk-boot").isDisabled(),true);
        }
        await page.locator("#disk-empty-size").fill("1024");
        for(const viewport of [{width:1280,height:900},{width:390,height:844},{width:320,height:568}]) {
            await page.setViewportSize(viewport);
            assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
            await page.screenshot({path:`${output}/${name}-form-${viewport.width}.png`,fullPage:true});
        }
        // A large capacity makes the real Worker operation cancellable even on fast hosts.
        await page.locator("#disk-empty-submit").click();
        await page.locator("#disk-cancel").click();
        await page.waitForFunction(()=>document.querySelector("#disk-status").textContent.includes("cancelled") && !document.querySelector("#disk-empty-submit").disabled);
        assert.equal(downloads.length,0);
        assert.equal(await page.locator("#disk-empty-form").isVisible(),true);
        assert.equal(await page.locator("#disk-boot").isDisabled(),true);
        await page.locator("#disk-empty-size").fill("1");
        const downloadEvent=page.waitForEvent("download");
        await page.locator("#disk-empty-size").press("Enter");
        // Even a direct duplicate event must not queue another creation.
        await page.evaluate(()=>document.querySelector("#disk-empty-form").dispatchEvent(new Event("submit",{cancelable:true})));
        const download=await downloadEvent;
        await page.waitForFunction(()=>!document.querySelector("#disk-boot").disabled);
        assert.match(download.suggestedFilename(),/^[a-f0-9]{8}\.my98$/);
        const file=`${output}/${name}-empty.my98`;await download.saveAs(file);
        assert.equal((await stat(file)).size,198+1048576+16*62);
        assert.equal(downloads.length,1);
        assert.equal(await page.locator("#disk-empty-form").isVisible(),false);
        assert.equal(await page.locator("#disk-empty").isDisabled(),true);
        assert.equal(await page.locator("#disk-create").isDisabled(),true);
        assert.equal(await page.locator("#session").isVisible(),false);
        await page.screenshot({path:`${output}/${name}-created.png`,fullPage:true});
        page.on("dialog",dialog=>dialog.accept());
        await page.locator("#disk-close").click();
        await page.waitForFunction(()=>!document.querySelector("#disk-login").hidden && !document.querySelector("#disk-user").disabled);
        await unlockIdentity(page);
        const chooser=page.waitForEvent("filechooser");await page.locator("#disk-open").click();await(await chooser).setFiles(file);
        await page.waitForFunction(()=>!document.querySelector("#disk-boot").disabled);
        await page.locator("#disk-verify").click();
        await page.waitForFunction(()=>document.querySelector("#disk-status").textContent.startsWith("Disk verified."));
        const {createHash}=await import("node:crypto");
        assert((await page.locator("#disk-status").textContent()).includes(createHash("sha256").update(Buffer.alloc(1048576)).digest("hex")));
        let large;
        if(process.env.MY98_EMPTY_LARGE==="1") {
            await page.locator("#disk-close").click();
            await page.waitForFunction(()=>!document.querySelector("#disk-login").hidden && !document.querySelector("#disk-user").disabled);
            await unlockIdentity(page);await page.locator("#disk-empty").click();
            assert.equal(await page.locator("#disk-empty-size").inputValue(),"1024");
            const started=Date.now(),event=page.waitForEvent("download",{timeout:240000});
            await page.locator("#disk-empty-submit").click();
            const full=await event,creationMs=Date.now()-started;
            const fullPath=`${output}/${name}-1024MiB.my98`;await full.saveAs(fullPath);
            const bytes=(await stat(fullPath)).size;
            assert.equal(bytes,198+2**30+16384*62);
            assert.equal(await page.locator("#session").isVisible(),false);
            large={capacityMiB:1024,creationMs,totalDownloadMs:Date.now()-started,bytes,path:fullPath};
            console.log(name+": 1024 MiB downloaded "+JSON.stringify(large));
        }
        assert.deepEqual(errors,[]);
        results.push({browser:name,version:browser.version(),core,ui:"keyboard, validation, cancellation, duplicate submit, download, reopen, full verification, no auto-boot, 3 viewport sizes PASS",large,errors});
        await writeFile(`${output}/results${process.env.MY98_EMPTY_LARGE==="1"?"-large":""}.json`,JSON.stringify(results,null,2));
        console.log(name+": empty disk UI PASS");
    } finally {await browser.close();await server.close();}
}
