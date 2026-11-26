import {autoConfirm} from './confirmations.mjs';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium,firefox,webkit} from 'playwright';
import {serveSite,quietAudio} from './server.mjs';
import {diskFixture} from './fixture.mjs';
import {bootEncrypted} from './encrypted.mjs';
import {browserOptions} from '../browser-options.mjs';
const output='build/pages-tests/publish-controls';await mkdir(output,{recursive:true});
const fixture=await diskFixture(),server=await serveSite({headers:true});
try{for(const [name,engine] of Object.entries({chromium,firefox,webkit}).filter(([name])=>!process.env.MY98_PUBLISH_BROWSERS||process.env.MY98_PUBLISH_BROWSERS.split(',').includes(name))){
 const browser=await engine.launch(browserOptions(name));
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',e=>errors.push(String(e)));await page.addInitScript(quietAudio);
  await page.goto(server.url);await page.waitForFunction(()=>!document.body.inert);
  await page.evaluate(async()=>{const {V86}=await import('/build/libv86.mjs'),run=V86.prototype.run;V86.prototype.run=function(...a){window.fixtureVm=this;return run.apply(this,a);};});
  await page.evaluate(async()=>{const {Slop86Disk}=await import('/build/disk/web/client.js'),create=Slop86Disk.create;Slop86Disk.create=async function(events){window.fixturePublishingStatus=events.onPublishing;const client=await create.call(this,events);window.fixtureDiskClient=client;return client;};});
  await bootEncrypted(page,fixture.file);await page.evaluate(()=>{if(document.querySelector('#vm-view').classList.contains('expanded'))document.querySelector('#fullscreen').click();});
  await page.waitForFunction(()=>!document.querySelector('#disk-publish').disabled);
  assert.equal(await page.locator('#ips').textContent(),'0.0 MIPS');
  await page.locator('#pause').click();await page.waitForFunction(()=>!document.querySelector('#pause').disabled);assert(await page.locator('#disk-publish').isDisabled());assert(!await page.locator('#disk-menu-trigger').isDisabled());
  await page.locator('#pause').click();await page.waitForFunction(()=>!document.querySelector('#disk-publish').disabled);
  await page.evaluate(()=>{window.originalCounter=fixtureVm.get_instruction_counter.bind(fixtureVm);let n=originalCounter();fixtureVm.get_instruction_counter=()=>n+=50000000;});
  await page.waitForFunction(()=>document.querySelector('#disk-publish').disabled);assert.notEqual(await page.locator('#ips').textContent(),'0.0 MIPS');
  await page.evaluate(()=>{fixtureVm.get_instruction_counter=originalCounter;});await page.waitForFunction(()=>!document.querySelector('#disk-publish').disabled);
  for(const width of [1280,390,320]){
   await page.setViewportSize({width,height:900});await page.locator('#disk-menu-trigger').focus();await page.keyboard.press('ArrowDown');
   assert.equal(await page.locator('#disk-menu-trigger').getAttribute('aria-expanded'),'true');
   assert.equal(await page.locator('#disk-menu-trigger').getAttribute('aria-activedescendant'),'disk-publish');
   const rect=await page.locator('#disk-menu-disk [data-popover]').boundingBox();assert(rect&&rect.x>=0&&rect.x+rect.width<=width+1,JSON.stringify({width,rect}));
   await page.screenshot({path:output+'/'+name+'-'+width+'.png'});
   await page.keyboard.press('Escape');assert.equal(await page.locator('#disk-menu-trigger').getAttribute('aria-expanded'),'false');
   assert.equal(await page.locator('#disk-menu-trigger').evaluate(e=>e===document.activeElement),true);
  }
  await page.locator('#disk-menu-trigger').click();const download=page.waitForEvent('download');await page.locator('#disk-download-raw').click();await (await download).saveAs(output+'/'+name+'.img');
  const {readFile}=await import('node:fs/promises');assert.deepEqual(await readFile(output+'/'+name+'.img'),await readFile(fixture.source));
  for(const [label,complete] of [['0.51',0],['1.30',1]]){
   await page.evaluate(({label,complete})=>fixturePublishingStatus({active:true,state:'announcing',replicas:{label,complete,unavailable:0}}),{label,complete});
   assert.equal(await page.locator('#disk-replica-count').textContent(),label);
   assert.equal(await page.locator('#disk-replica-notice').isHidden(),complete>0);
   assert.equal(await page.evaluate(()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented;}),complete===0);
   await page.locator('#disk-menu-trigger').click();await page.locator('#disk-download-raw').waitFor({state:'visible'});assert(await page.locator('#disk-download-raw').isVisible());assert(await page.locator('#disk-publish').isHidden());await page.keyboard.press('Escape');
  }
  await page.locator('#disk-replica-info').focus();assert(await page.locator('#disk-replica-help').isVisible());await page.keyboard.press('Escape');assert(await page.locator('#disk-replica-help').isHidden());
  await page.screenshot({path:output+'/'+name+'-replicas.png',animations:'disabled'});
  assert.equal(await page.locator('#disk-publish-group').count(),0);
  const readKey=await page.evaluate(async()=>{fixturePublishingStatus({active:false,state:'stopped'});return fixtureDiskClient.exportReadOnlyKey();});
  await autoConfirm(page);await page.locator('#disk-close').click();await page.waitForFunction(()=>!document.querySelector('#disk-login').hidden);
  // Exercise real reader permissions, replacing only remote discovery with the
  // local compatibility file; WAN discovery has its own integration acceptance.
  await page.evaluate(async()=>{const input=document.createElement('input');input.type='file';input.id='fixture-reader';input.hidden=true;document.body.append(input);const {Slop86Disk}=await import('/build/disk/web/client.js');Slop86Disk.prototype.openRemoteReadOnly=function({readKey}){return this.openReadOnly({file:document.querySelector('#fixture-reader').files[0],readKey});};});
  await page.locator('#fixture-reader').setInputFiles(fixture.file);
  await page.locator('#disk-auth-switch').click();await page.locator('#disk-read-key').fill(readKey);await page.locator('#disk-reader button').click();
  await page.waitForFunction(()=>document.querySelector('#disk-download').textContent==='Download original encrypted disk'&&!document.querySelector('#disk-download').disabled);
  await page.locator('#disk-menu-trigger').click();await page.locator('#disk-download').waitFor({state:'visible'});
  for(const id of ['disk-publish','disk-publish-file','disk-publish-raw'])assert(await page.locator('#'+id).isHidden());
  assert(await page.locator('#disk-download-raw').isVisible());assert(!await page.locator('#disk-download').isDisabled());
  assert.deepEqual(errors,[]);console.log(name+': unified menu, shared MIPS gating, replicas, unload guard, 3 viewports and raw download PASS');
 }finally{await browser.close();}
}}finally{await server.close();await fixture.close();}
