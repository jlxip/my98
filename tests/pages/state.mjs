import assert from "node:assert/strict";
import {mkdir,readFile,writeFile} from "node:fs/promises";
import {chromium,webkit} from "playwright";
import {serveSite,quietAudio} from "./server.mjs";
import {diskFixture} from "./fixture.mjs";
import {bootEncrypted} from "./encrypted.mjs";
const dir="build/state";await mkdir(dir,{recursive:true});
const fixture=await diskFixture(),results=[];
try {for(const [name,type] of Object.entries({chromium,webkit})) {
 const server=await serveSite({headers:true}),browser=await type.launch();
 try {
  const context=await browser.newContext({acceptDownloads:true});await context.routeWebSocket("**/*",s=>s.close());await context.addInitScript(quietAudio);
  const page=await context.newPage(),errors=[];page.on("pageerror",e=>errors.push(String(e)));
  await page.goto(server.url);await page.waitForFunction(()=>!document.body.inert);
  await page.evaluate(async()=>{const {V86}=await import("./build/libv86.mjs"),run=V86.prototype.run;V86.prototype.run=function(){window.vm=this;return run.call(this);};
   const {Slop86Disk}=await import("./build/disk/web/client.js"),create=Slop86Disk.create;Slop86Disk.create=async function(...a){const d=await create.apply(this,a);window.disk=d;return d;};});
  await bootEncrypted(page,fixture.file);await page.evaluate(()=>document.querySelector("#exit-fullscreen").click());
  await page.waitForFunction(()=>!document.querySelector("#pause").disabled);
  await page.locator("#pause").click();
  await page.evaluate(async()=>{vm.v86.cpu.mem8[0x70000]=41;await disk.write(10000,new Uint8Array([42]));window.oldVM=vm;});
  let download=page.waitForEvent("download",{timeout:60000});await page.locator("#save-state").click();
  const saved=await download,path=`${dir}/${name}.my98state`;await saved.saveAs(path);
  await page.waitForFunction(()=>!document.querySelector("#save-state").disabled);
  assert.equal(await page.locator("#pause").textContent(),"Resume");
  await page.evaluate(async()=>{vm.v86.cpu.mem8[0x70000]=77;await disk.write(10000,new Uint8Array([99]));});
  page.on("dialog",d=>d.accept());
  async function load(file) {const chooser=page.waitForEvent("filechooser");await page.locator("#load-state").click();await(await chooser).setFiles(file);await page.waitForFunction(()=>!document.querySelector("#load-state").disabled);}
  const corrupt=Buffer.from(await readFile(path));corrupt[corrupt.length-1]^=1;
  await load({name:"broken.my98state",mimeType:"application/octet-stream",buffer:corrupt});
  assert.equal(await page.evaluate(()=>oldVM.v86.cpu.mem8[0x70000]),77);
  assert.equal(await page.evaluate(async()=>(await disk.read(10000,1))[0]),99);
  assert.match(await page.locator("#disk-status").textContent(),/authentication/i);
  await load(path);
  assert.match(await page.locator("#disk-status").textContent(),/State restored/);
  await page.locator("#pause").click(); // Resume to expose candidate through run hook.
  assert.equal(await page.evaluate(()=>vm.v86.cpu.mem8[0x70000]),41);
  assert.equal(await page.evaluate(async()=>(await disk.read(10000,1))[0]),42);
  await page.locator("#pause").click();
  await load(path);await page.locator("#pause").click();
  assert.equal(await page.evaluate(()=>vm.v86.cpu.mem8[0x70000]),41);
  // Media rejection does not eject or modify the running guest.
  const chooser=page.waitForEvent("filechooser");await page.locator("#insert-fda").click();await(await chooser).setFiles({name:"blank.img",mimeType:"application/octet-stream",buffer:Buffer.alloc(1440*1024)});
  await page.waitForFunction(()=>!document.querySelector("#save-state").disabled);await page.locator("#save-state").click();
  await page.waitForFunction(()=>!document.querySelector("#save-state").disabled);
  assert.match(await page.locator("#disk-status").textContent(),/Eject/);
  assert.equal(await page.locator("#fda-name").textContent(),"blank.img");
  await page.locator("#eject-fda").click();
  await page.waitForFunction(()=>!document.querySelector("#save-state").disabled);
  // Running capture preserves run state; restoration starts that saved session running.
  download=page.waitForEvent("download",{timeout:60000});await page.locator("#save-state").click();
  const runningPath=`${dir}/${name}-running.my98state`;await(await download).saveAs(runningPath);
  await page.waitForFunction(()=>!document.querySelector("#save-state").disabled);
  assert.equal(await page.locator("#pause").textContent(),"Pause");
  await load(runningPath);assert.equal(await page.locator("#pause").textContent(),"Pause");
  // Failure while constructing a candidate must resume the original running VM.
  const snapshot=await readFile(runningPath);
  const rollback=await page.evaluate(async bytes=>{
    const blob=new Blob([new Uint8Array(bytes)]),prepared=await disk.prepareState(blob);await disk.discardState(prepared.token);
    const {restoreMachineState}=await import("./src/browser/machine-state.js");
    const current=vm;let rejected=false;
    try {await restoreMachineState({disk,input:blob,compatibility:prepared.metadata.compatibility,
      current:{machine:current,adapter:current.v86.cpu.devices.ide.primary.master.buffer},createMachine:async()=>{throw Error("injected candidate failure");}});}
    catch(e){rejected=/injected candidate failure/.test(e.message);}
    return {rejected,running:current.is_running(),value:(await disk.read(10000,1))[0]};
  },Array.from(snapshot));
  assert.deepEqual(rollback,{rejected:true,running:true,value:42});
  // Hold the real capture until the UI click has requested cancellation. The
  // compressible fixture can otherwise finish before Playwright reaches Cancel.
  const cancelledDownloads=[];
  const onCancelledDownload=d=>cancelledDownloads.push(d);
  page.on("download",onCancelledDownload);
  await page.evaluate(()=>{
    const machine=vm,save=machine.save_state;
    window.captureBlocked=false;
    const released=new Promise(resolve=>{window.releaseCapture=resolve;});
    machine.save_state=async function(...args) {
      machine.save_state=save;
      const state=await save.apply(this,args);
      window.captureBlocked=true;
      await released;
      return state;
    };
  });
  try {
    await page.locator("#save-state").click();
    await page.waitForFunction(()=>window.captureBlocked);
    await page.locator("#cancel-state").click();
  } finally {await page.evaluate(()=>window.releaseCapture());}
  await page.waitForFunction(()=>!document.querySelector("#save-state").disabled);
  assert.match(await page.locator("#disk-status").textContent(),/cancelled/i);
  page.off("download",onCancelledDownload);
  assert.equal(cancelledDownloads.length,0,"Cancelled capture must not download a state");
  assert.equal(await page.locator("#pause").textContent(),"Pause");
  assert.equal(await page.evaluate(async()=>(await disk.read(10000,1))[0]),42);

  await page.screenshot({path:`${dir}/${name}-desktop.png`,fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:`${dir}/${name}-mobile.png`,fullPage:true});
  assert.deepEqual(errors,[]);results.push({name,status:"PASS",bytes:(await readFile(path)).length});console.log(name,"state PASS");
 } finally {await browser.close();await server.close();}
}} finally {await fixture.close();await writeFile(`${dir}/validation.json`,JSON.stringify(results,null,2));}
