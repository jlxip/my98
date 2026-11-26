import {autoConfirm} from './confirmations.mjs';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium,firefox,webkit} from 'playwright';
import {serveSite,quietAudio} from './server.mjs';
import {diskFixture} from './fixture.mjs';
import {bootEncrypted,diskAction} from './encrypted.mjs';
import {browserOptions} from '../browser-options.mjs';
const output='build/pages-tests/state-publication';await mkdir(output,{recursive:true});
const fixture=await diskFixture(),server=await serveSite({headers:true});
try{for(const [name,engine] of Object.entries({chromium,firefox,webkit}).filter(([name])=>!process.env.MY98_PUBLISH_BROWSERS||process.env.MY98_PUBLISH_BROWSERS.split(',').includes(name))){
 const browser=await engine.launch(browserOptions(name));
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',e=>errors.push(String(e)));await autoConfirm(page);await page.addInitScript(quietAudio);
  await page.goto(server.url);await page.waitForFunction(()=>!document.body.inert);
  await page.evaluate(async()=>{
   const {V86}=await import('/build/libv86.mjs'),run=V86.prototype.run;V86.prototype.run=function(...a){window.fixtureVm=this;return run.apply(this,a);};
   const {Slop86Disk}=await import('/build/disk/web/client.js'),create=Slop86Disk.create,open=Slop86Disk.prototype.open;
   const base='ab'.repeat(20);window.publishedProfiles=[];window.updates=[];
   window.profile={version:2,infoHash:base,unitBytes:65536,origin:{kind:'boot'},ranges:Array(32).fill(null)};profile.ranges[0]=[0,0];
   // UI contract fixture only; Worker validation and real transport are covered by the private chain.
   Slop86Disk.create=async function(events){
    window.stateProgress=[];window.fixtureProgress=p=>{events.onProgress(p);if(p.phase==='encrypt-state')stateProgress.push({completed:p.completed,total:p.total,disk:document.querySelector('#disk-status').textContent,session:document.querySelector('#session-status').textContent});};
    const client=await create.call(this,{...events,onProgress:fixtureProgress});window.client=client;
    const describe=client.describe.bind(client);client.describe=async()=>({...await describe(),remote:{infoHash:base,stateInfoHash:'cd'.repeat(20)}});
    client.publicationDetails=async()=>({hasState:true,hasProfiles:publishedProfiles.length>0,profiles:publishedProfiles});
    client.publishUpdate=async options=>{if(window.failPublication)throw Error('Injected announcement failure');if(window.holdPublication)await new Promise(resolve=>window.finishPublication=resolve);updates.push(options);if(options.action==='profiles')publishedProfiles=options.profiles;events.onPublishing({active:true,state:'seeding',replicas:{complete:1,label:'1'}});return {active:true,state:'seeding'};};
    client.startLoadAnalysis=async()=>{};client.finishLoadAnalysis=async()=>[structuredClone(profile)];return client;};
   Slop86Disk.prototype.open=async function(file){const state=await open.call(this,file);return {...state,remote:{infoHash:base,stateInfoHash:'cd'.repeat(20)}};};
  });
  await bootEncrypted(page,fixture.file);await page.evaluate(()=>{if(document.querySelector('#vm-view').classList.contains('expanded'))document.querySelector('#fullscreen').click();});
  await page.waitForFunction(()=>!document.querySelector('#disk-publish-state').disabled);
  // Capture while manually paused, a condition which still forbids disk publication.
  await page.locator('#pause').click();await page.waitForFunction(()=>!document.querySelector('#pause').disabled);
  assert(await page.locator('#disk-publish').isDisabled());assert(!await page.locator('#disk-publish-state').isDisabled());
  const runningBefore=await page.evaluate(()=>fixtureVm.is_running());
  await diskAction(page,'disk-publish-state');await page.waitForFunction(()=>updates.length===1&&!document.querySelector('#disk-publish-state').disabled);
  assert.equal(await page.evaluate(()=>fixtureVm.is_running()),runningBefore);assert.equal(await page.evaluate(()=>updates[0].file instanceof Blob),true);
  const stateProgress=await page.evaluate(()=>window.stateProgress);
  assert.equal(stateProgress[0]?.disk,'Encrypting state: 0%…');assert.equal(stateProgress.at(-1)?.disk,'Encrypting state: 100%…');
  assert(stateProgress.every(p=>p.disk===p.session&&/^Encrypting state: \d+%…$/.test(p.disk)));
  const mediaChooser=page.waitForEvent('filechooser');await page.locator('#insert-fda').click();await (await mediaChooser).setFiles({name:'blank.img',mimeType:'application/octet-stream',buffer:Buffer.alloc(1440*1024)});
  await page.waitForFunction(()=>!document.querySelector('#disk-publish-state').disabled);await diskAction(page,'disk-publish-state');
  await page.waitForFunction(()=>document.querySelector('#disk-status').textContent.includes('Eject'));assert.equal(await page.evaluate(()=>updates.length),1);
  assert.equal(await page.locator('#fda-name').textContent(),'blank.img');await page.locator('#insert-fda').click();
  await page.waitForFunction(()=>!document.querySelector('#disk-publish-state').disabled);
  // A held update keeps working=true without capturing: all target phases must render.
  await page.waitForFunction(()=>!document.querySelector('#disk-remove-state').disabled);
  await page.evaluate(()=>window.holdPublication=true);await diskAction(page,'disk-remove-state');
  await page.waitForFunction(()=>typeof finishPublication==='function');
  for(const [phase,label] of [['encrypt','Encrypting'],['hash','Hashing'],['encrypt-state','Encrypting state']]) {
   for(const [completed,total,expected] of [[0,1000,'0%'],[427,1000,'42%'],[999,1000,'99%'],[1000,1000,'100%'],[1,0,null],[1,NaN,null],[-1,10,null],[11,10,'100%']]) {
    await page.evaluate(p=>fixtureProgress(p),{phase,completed,total});
    assert.equal(await page.locator('#disk-status').textContent(),expected===null?label+'…':label+': '+expected+'…');
   }
  }
  for(const width of [1280,390,320]) {
   await page.setViewportSize({width,height:900});await page.evaluate(()=>fixtureProgress({phase:'hash',completed:427,total:1000}));
   await page.locator('#disk-status').scrollIntoViewIfNeeded();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   await page.screenshot({path:output+'/'+name+'-percentage-'+width+'.png',animations:'disabled'});
  }
  await page.evaluate(()=>{fixtureProgress({error:{message:'Injected progress error'}});fixtureProgress({phase:'hash',completed:1000,total:1000});});
  assert.equal(await page.locator('#disk-status').textContent(),'Injected progress error');assert(await page.locator('#disk-status').evaluate(e=>e.classList.contains('error')));
  await page.evaluate(()=>{window.holdPublication=false;finishPublication();});
  await page.waitForFunction(()=>!document.querySelector('#disk-remove-state').disabled);
  const finalStatus=await page.locator('#disk-status').textContent();await page.evaluate(()=>fixtureProgress({phase:'hash',completed:1,total:2}));
  assert.equal(await page.locator('#disk-status').textContent(),finalStatus,'late progress does not replace the result');
  await page.evaluate(()=>{window.holdPublication=true;window.finishPublication=undefined;});await diskAction(page,'disk-remove-state');
  await page.waitForFunction(()=>typeof finishPublication==='function');await page.evaluate(()=>fixtureProgress({phase:'hash',completed:0,total:1}));
  assert.equal(await page.locator('#disk-status').textContent(),'Hashing: 0%…','new operation resets progress errors');
  await page.evaluate(()=>{window.holdPublication=false;finishPublication();});await page.waitForFunction(()=>!document.querySelector('#disk-remove-state').disabled);
  // State dropdown uses the same Basecoat keyboard and viewport behavior as Disk.
  for(const width of [1280,390,320]){
   await page.setViewportSize({width,height:900});await page.locator('#disk-state-trigger').focus();await page.keyboard.press('ArrowDown');
   assert.equal(await page.locator('#disk-state-trigger').getAttribute('aria-expanded'),'true');
   const rect=await page.locator('#disk-menu-state [data-popover]').boundingBox();assert(rect&&rect.x>=0&&rect.x+rect.width<=width+1,JSON.stringify(rect));
   await page.keyboard.press('Escape');assert(await page.locator('#disk-state-trigger').evaluate(e=>document.activeElement===e));
  }
  await diskAction(page,'disk-analyze');await page.locator('#disk-analyze-boot').click();await page.waitForFunction(()=>document.querySelector('#disk-analyze').textContent==='Stop analyzing'&&!document.querySelector('#disk-analyze').disabled);
  const download=page.waitForEvent('download');await diskAction(page,'disk-analyze');await download;
  await diskAction(page,'disk-profiles');await page.locator('#disk-profiles-dialog > div').waitFor({state:'visible'});
  assert.equal(await page.locator('#disk-profile-boot option[value=generated]').isDisabled(),false);
  await page.locator('#disk-profile-boot').selectOption('generated');await page.keyboard.press('Escape');
  await diskAction(page,'disk-profiles');assert.equal(await page.locator('#disk-profile-boot').inputValue(),'generated');
  await page.locator('#disk-profile-file').setInputFiles({name:'profiles.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify([{version:2,infoHash:'ab'.repeat(20),unitBytes:65536,origin:{kind:'state',sha256:'ef'.repeat(32)},ranges:Array(32).fill(null)}]))});
  await page.waitForFunction(()=>document.querySelector('#disk-profile-state').value==='file');
  // A drag from inside to the backdrop does not close the dialog.
  const dialog=page.locator('#disk-profiles-dialog > div'),form=page.locator('#disk-profiles-form');
  const box=await form.boundingBox();await page.mouse.move(box.x+10,box.y+10);await page.mouse.down();await page.mouse.move(1,1);await page.mouse.up();assert(await dialog.isVisible());
  // A backdrop click and × preserve the draft as Escape does.
  await page.mouse.click(1,1);await page.waitForFunction(()=>!document.querySelector('#disk-profiles-dialog').open);
  await diskAction(page,'disk-profiles');assert.equal(await page.locator('#disk-profile-state').inputValue(),'file');
  await page.locator('#disk-profiles-close').click();await diskAction(page,'disk-profiles');assert.equal(await page.locator('#disk-profile-boot').inputValue(),'generated');
  await page.evaluate(()=>window.failPublication=true);await page.locator('#disk-profiles-submit').click();await page.waitForFunction(()=>document.querySelector('#disk-profiles-status').textContent.includes('Injected'));
  assert(await dialog.isVisible());assert.equal(await page.locator('#disk-profile-state').inputValue(),'file');
  await page.evaluate(()=>window.failPublication=false);await page.locator('#disk-profiles-submit').click();await page.waitForFunction(()=>!document.querySelector('#disk-profiles-dialog').open);
  assert.equal(await page.evaluate(()=>updates.at(-1).profiles.length),2);
  await diskAction(page,'disk-profiles');await page.waitForFunction(()=>document.querySelector('#disk-profiles-dialog').open&&!document.querySelector('#disk-profiles-submit').disabled);assert.equal(await page.locator('#disk-profile-state').inputValue(),'keep');
  await page.screenshot({path:output+'/'+name+'-320.png',animations:'disabled'});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.setViewportSize({width:320,height:220});
  const short=await dialog.boundingBox();assert(short&&short.y>=0&&short.y+short.height<=221,JSON.stringify(short));
  await page.locator('#disk-profile-file').scrollIntoViewIfNeeded();
  const fileBox=await page.locator('#disk-profile-file').boundingBox();assert(fileBox&&fileBox.y>=short.y&&fileBox.y+fileBox.height<=short.y+short.height+1,JSON.stringify({short,fileBox}));
  await page.locator('#disk-profiles-submit').scrollIntoViewIfNeeded();
  await page.screenshot({path:output+'/'+name+'-320-short.png',animations:'disabled'});
  await page.keyboard.press('Escape');assert.deepEqual(errors,[]);console.log(name+': state capture, Basecoat keyboard, profiles draft/error/success and 3 widths PASS');
 }finally{await browser.close();}
}}finally{await server.close();await fixture.close();}
