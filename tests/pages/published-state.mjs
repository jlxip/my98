import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {chromium,webkit} from 'playwright';
import {serveSite,quietAudio} from './server.mjs';
import {diskFixture} from './fixture.mjs';
import {bootEncrypted} from './encrypted.mjs';
const results=[];
await mkdir('build/published-state',{recursive:true});
for(const [name,type] of Object.entries({chromium,webkit})) {
 const fixture=await diskFixture({isolated:true}),server=await serveSite({headers:true}),browser=await type.launch();
 try {
  const context=await browser.newContext({acceptDownloads:true});
  await context.addInitScript(quietAudio);await context.routeWebSocket('**/*',s=>s.close());
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.goto(server.url);await page.waitForFunction(()=>!document.body.inert);
  // Save a real running emulator with a RAM marker and pending disk write.
  await page.evaluate(async()=>{
   const {V86}=await import('./build/libv86.mjs'),run=V86.prototype.run;
   V86.prototype.run=function(){window.vm=this;return run.call(this);};
   const {Slop86Disk}=await import('./build/disk/web/client.js'),create=Slop86Disk.create;
   Slop86Disk.create=async function(...args){const d=await create.apply(this,args);window.disk=d;return d;};
  });
  console.log(name,'capture');
  await bootEncrypted(page,fixture.file);await page.evaluate(()=>document.querySelector('#exit-fullscreen').click());
  await page.waitForFunction(()=>!document.querySelector('#pause').disabled);
  await page.locator('#pause').click();
  const readKey=await page.evaluate(()=>disk.exportReadOnlyKey());
  await page.evaluate(async()=>{vm.v86.cpu.mem8[0x70000]=41;await disk.write(10000,new Uint8Array([42]));});
  const download=page.waitForEvent('download');await page.locator('#save-state').click();
  const path=`build/published-state/${name}.my98state`;await(await download).saveAs(path);
  console.log(name,'publish fixture');
  const publication=await fixture.publishState(await readFile(path));
  await page.close();
  const p=await context.newPage();p.on('pageerror',e=>errors.push(String(e)));p.on('dialog',d=>d.accept());
  async function prepare() {
   await p.goto(server.url);await p.waitForFunction(()=>!document.body.inert);
   await p.evaluate(async gateway=>{
    const {V86}=await import('./build/libv86.mjs'),run=V86.prototype.run;
    V86.prototype.run=function(){window.vm=this;return run.call(this);};
    const restore=V86.prototype.restore_state;V86.prototype.restore_state=async function(...args){await restore.apply(this,args);window.vm=this;};
    const {Slop86Disk}=await import('./build/disk/web/client.js'),open=Slop86Disk.prototype.openRemote,create=Slop86Disk.create;
    Slop86Disk.prototype.openRemote=function(){return open.call(this,{gateway,servers:[{url:gateway,resolution:'gateway',discovery:false}],prefetch:{enabled:false}});};
    Slop86Disk.create=async function(...args){const d=await create.apply(this,args);window.disk=d;return d;};
   },fixture.gateway);
  }
  async function login(cold=false) {
   await p.locator('#disk-user').fill('disk fixtures');await p.locator('#disk-password').fill('public compatibility password');
   if(cold)await p.locator('#disk-cold-login').check();
   await p.locator('#disk-login button').click();
   await p.waitForFunction(()=>document.querySelector('#disk-status').classList.contains('error') || (!document.querySelector('#disk-workspace').hidden && !document.querySelector('#disk-remote').disabled) || !document.querySelector('#disk-boot').disabled || !document.querySelector('#session').hidden,undefined,{timeout:60000});
  }
  console.log(name,'default restore');
  await prepare();await login();
  console.log(name,'login status',await p.locator('#disk-status').textContent());
  assert.equal(await p.locator('#disk-status').evaluate(e=>e.classList.contains('error')),false);
  await p.waitForFunction(()=>document.querySelector('#disk-status').textContent.includes('State restored'),undefined,{timeout:60000});
  assert.equal(await p.evaluate(()=>vm.v86.cpu.mem8[0x70000]),41);
  assert.equal(await p.evaluate(async()=>(await disk.read(10000,1))[0]),42);
  assert.equal((await p.evaluate(()=>disk.describe())).remote.rootCid,publication.publicationCid);
  await p.screenshot({path:`build/published-state/${name}-restored.png`});
  // Opening a remote disk discovers the state before either start action is chosen.
  await prepare();
  await p.locator('#disk-autoboot').uncheck();await login();
  assert.equal(await p.locator('#disk-resume-state').isDisabled(),true);
  await p.locator('#disk-remote').click();
  await p.waitForFunction(()=>!document.querySelector('#disk-resume-state').disabled);
  assert.equal(await p.evaluate(()=>!!window.vm),false);
  await p.screenshot({path:`build/published-state/${name}-actions.png`});
  await p.locator('#disk-resume-state').click();
  await p.waitForFunction(()=>document.querySelector('#disk-status').textContent.includes('State restored'));
  assert.equal(await p.evaluate(()=>vm.v86.cpu.mem8[0x70000]),41);
  // Record from both the exact published origin and the same local file before its first run.
  const expectedHash=createHash('sha256').update(await readFile(path)).digest('hex');
  for(const origin of ['resume','file']) {
   await p.locator('#disk-analyze').click();
   if(origin==='resume')await p.screenshot({path:`build/published-state/${name}-analysis-options.png`});
   if(origin==='file') {
    const chooser=p.waitForEvent('filechooser');await p.locator('#disk-analyze-file').click();await(await chooser).setFiles(path);
   }else await p.locator('#disk-analyze-resume').click();
   await p.waitForFunction(()=>document.querySelector('#disk-analyze').textContent==='Stop analyzing' && !document.querySelector('#disk-analyze').disabled);
   assert.equal(await p.evaluate(()=>vm.is_running()),true);
   assert.equal(await p.evaluate(()=>vm.v86.cpu.mem8[0x70000]),41);
   assert.equal(await p.evaluate(async()=>(await disk.read(10000,1))[0]),42);
   const dl=p.waitForEvent('download');await p.locator('#disk-analyze').click();
   const target=`build/published-state/${name}-${origin}-load-profile.json`;await(await dl).saveAs(target);
   const [profile]=JSON.parse(await readFile(target,'utf8'));
   assert.deepEqual(profile.origin,{kind:'state',sha256:expectedHash});assert.equal(profile.cid,publication.diskCid);
  }
  // API read-only directory root; disk-only references still work and have no state.
  console.log(name,'read-only');
  const api=await p.evaluate(async({publication,readKey,gateway})=>{
   const {Slop86Disk}=await import('./build/disk/web/client.js');const reader=await Slop86Disk.create();let checks=0;
   try {
    const info=await reader.openReadOnly({cid:publication.publicationCid,readKey,gateway,prefetch:{enabled:false}});
    if(info.remote.cid!==publication.diskCid||info.remote.stateCid!==publication.stateCid)throw Error('wrong references');checks++;
    const state=await reader.prepareState({published:true});await reader.commitState(state.token);
    if((await reader.read(10000,1))[0]!==42)throw Error('missing overlay');checks++;
    try{await reader.saveState(new ArrayBuffer(4),{});throw Error('writable');}catch(e){if(e.code!=='READ_ONLY')throw e;}checks++;
   }finally{await reader.close();}
   const plain=await Slop86Disk.create();try{
    await plain.openReadOnly({cid:publication.diskCid,readKey,gateway,prefetch:{enabled:false}});
    try{await plain.prepareState({published:true});throw Error('missing state accepted');}catch(e){if(e.code!=='INVALID_STATE')throw e;}checks++;
   }finally{await plain.close();}
   return checks;
  },{publication,readKey,gateway:fixture.gateway});
  // Explicit cold boot must not read any state blocks.
  console.log(name,'cold boot');
  await prepare();fixture.requests.length=0;await login(true);
  await p.waitForFunction(()=>!!window.vm);
  assert.notEqual(await p.evaluate(()=>vm.v86.cpu.mem8[0x70000]),41);
  // Opening the directory may read the state root to identify its type, but no payload leaves.
  assert.match(await p.locator('#disk-status').textContent(),/Windows is using/);
  // Authenticated state with wrong build: fail without starting a VM; user can choose cold boot.
  const bad=await p.evaluate(async()=>{
   const result=await disk.saveState(new ArrayBuffer(100),{version:1,compatibility:'different-build',running:true,config:{}});
   return Array.from(new Uint8Array(await result.blob.arrayBuffer()));
  });
  await fixture.publishState(Buffer.from(bad));
  await prepare();await login();
  await p.waitForFunction(()=>document.querySelector('#disk-status').textContent.includes('Retry Resume state'));
  assert.match(await p.locator('#disk-status').textContent(),/same emulator and BIOS/);
  assert.equal(await p.evaluate(()=>!!window.vm),false);
  assert.equal(await p.locator('#disk-boot').isEnabled(),true);
  await p.screenshot({path:`build/published-state/${name}-failure.png`});
  assert.equal(await p.locator('#disk-resume-state').isEnabled(),true);
  await p.locator('#disk-boot').click();
  await p.waitForFunction(()=>!!window.vm);
  assert.deepEqual(errors,[]);results.push({name,realStateRestored:true,ramAndOverlay:true,readOnlyChecks:api,coldBoot:true,explicitRecovery:true});
  console.log(results.at(-1));
 }finally{await browser.close();await server.close();await fixture.close();}
}
await writeFile('build/published-state/validation.json',JSON.stringify(results,null,2));
