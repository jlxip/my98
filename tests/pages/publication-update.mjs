/** General UI follows signed identities; real V86 is replaced only after preparation. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir} from 'node:fs/promises';
import {chromium,firefox,webkit} from 'playwright';
import {serveSite,quietAudio} from './server.mjs';
import {diskAction} from './encrypted.mjs';
import {browserOptions} from '../browser-options.mjs';
import {publicationFixture,installPublicationFixture,makePublishedState} from './publication-fixture.mjs';
const output='build/pages-tests/publication-update';await mkdir(output,{recursive:true});
// Keep lookup genuinely in flight while the cached A is opened and Boot is pressed.
const gateway=createServer((_q,r)=>{r.writeHead(200,{'Content-Type':'text/event-stream','Access-Control-Allow-Origin':'*','Cross-Origin-Resource-Policy':'cross-origin'});r.flushHeaders();});
await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
const server=await serveSite({headers:true,sources:{gateways:['http://127.0.0.1:'+gateway.address().port],trackers:[]}}),fixture=await publicationFixture();
const announce=(page,hash,seq)=>page.evaluate(record=>announcePublication(record),fixture.record(hash,String(seq)));
const selected=async(page,hash)=>{await page.waitForFunction(hash=>window.fixtureSession?.description?.remote.publicationInfoHash===hash,hash);assert.equal(await page.evaluate(async()=>(await fixtureClient.describe()).remote.publicationInfoHash),hash);};
const idle=page=>page.waitForFunction(()=>!document.querySelector('#disk-close').disabled);
async function login(page){await page.locator('#disk-user').fill('disk fixtures');await page.locator('#disk-password').fill('public compatibility password');await page.locator('#disk-login button').click();await page.waitForFunction(()=>!document.querySelector('#disk-boot').disabled);}
try {for(const [name,engine] of Object.entries({chromium,firefox,webkit}).filter(([name])=>!process.env.MY98_PUBLISH_BROWSERS||process.env.MY98_PUBLISH_BROWSERS.split(',').includes(name))) {
 const browser=await engine.launch(browserOptions(name));
 try {
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',e=>errors.push(String(e)));await page.addInitScript(quietAudio);
  let accept=true;page.on('dialog',d=>accept?d.accept():d.dismiss());await page.goto(server.url);await page.waitForFunction(()=>!document.body.inert);
  const state=await makePublishedState(page,fixture),cs=fixture.addState(state.bytes),cs2=fixture.addState(state.bytes,true);await installPublicationFixture(page,fixture);
  await page.evaluate(async()=>{const {DiskSession}=await import('/src/browser/disk-session.js'),update=DiskSession.prototype.updatePublication;window.refreshTrace=[];DiskSession.prototype.updatePublication=function(options){refreshTrace.push({options,mode:this.remoteMode,used:this.usedForVm,pending:this.pendingPublication});return update.call(this,options);};const {V86}=await import('/build/libv86.mjs'),run=V86.prototype.run;V86.prototype.run=function(...args){window.fixtureVm=this;return run.apply(this,args);};});
  await login(page);
  await announce(page,fixture.cb.hash,101);await selected(page,fixture.cb.hash);await idle(page);
  assert(await page.locator('#session').isHidden());assert(await page.locator('#disk-resume-state').isHidden());
  await announce(page,cs.hash,102);await selected(page,cs.hash);await idle(page);assert(await page.locator('#disk-resume-state').isVisible());
  await page.locator('#disk-resume-state').click();await page.waitForFunction(()=>window.fixtureVm&&!document.querySelector('#pause').disabled);
  assert.equal(await page.evaluate(()=>fixtureVm.v86.cpu.mem8.length),32*1048576);
  await page.evaluate(()=>{window.originalVm=fixtureVm;document.querySelector('#display').focus();});
  await announce(page,fixture.cb.hash,103);await page.locator('#disk-update-publication').waitFor({state:'visible'});
  assert(await page.locator('#display').evaluate(e=>document.activeElement===e));assert(await page.evaluate(()=>fixtureVm===originalVm));
  accept=false;await page.locator('#disk-update-publication').click();assert(await page.evaluate(()=>fixtureVm===originalVm));accept=true;
  await page.locator('#disk-update-publication').click();await page.waitForFunction(()=>document.querySelector('#disk-update-publication').textContent==='Boot latest version'&&!document.querySelector('#disk-update-publication').disabled);
  assert(await page.evaluate(()=>fixtureVm===originalVm));await selected(page,cs.hash);
  // New C supersedes missing-state B; preserve Resume rather than keeping B's fallback.
  await announce(page,cs2.hash,104);await page.waitForFunction(()=>document.querySelector('#disk-update-publication').textContent==='Restart with latest version');
  await page.locator('#disk-update-publication').click();await selected(page,cs2.hash);await idle(page);
  assert(await page.evaluate(()=>fixtureVm!==originalVm));assert.equal(await page.evaluate(()=>fixtureVm.v86.cpu.mem8.length),32*1048576);
  await page.evaluate(()=>window.originalVm=fixtureVm);await announce(page,cs2.hash,105);
  // Identical catalog: metadata only, even though Windows has been used.
  await page.waitForFunction(()=>fixtureSession.description?.remote.sequence==='105');assert(await page.evaluate(()=>fixtureVm===originalVm));
  // Force C's metadata-only update to observe a different catalog before preparation.
  await idle(page);await page.evaluate(()=>{const prepare=fixtureClient.prepareRemoteUpdate;window.originalPrepare=prepare;fixtureClient.prepareRemoteUpdate=async function(options){if(options.automatic){window.metadataHeld=true;await new Promise(r=>window.releaseMetadata=r);}return prepare.call(this,options);};});
  await announce(page,cs2.hash,106);await page.waitForFunction(()=>window.metadataHeld);await announce(page,fixture.cb.hash,107);await page.evaluate(()=>releaseMetadata());await idle(page);
  await page.evaluate(()=>fixtureClient.prepareRemoteUpdate=originalPrepare);await selected(page,cs2.hash);
  assert(await page.evaluate(()=>fixtureVm===originalVm));assert.equal(await page.locator('#disk-update-publication').textContent(),'Restart with latest version');
  await page.locator('#disk-update-publication').waitFor({state:'visible'});
  // Cancel a prepared transport; old RAM/disk remains installed.
  await page.evaluate(()=>{window.fixtureHold=()=>{window.held=true;return new Promise(r=>window.releaseFixture=r);};});
  await page.locator('#disk-update-publication').click();await page.waitForFunction(()=>window.held);
  await page.locator('#vm-cancel-publication').click();await idle(page);assert(await page.evaluate(()=>fixtureVm===originalVm));await selected(page,cs2.hash);
  assert.match(await page.locator('#disk-publication-status').textContent(),/cancelled/i);
  assert.equal(await page.evaluate(()=>refreshTrace.at(-1).options.mode),'resume');
  await page.evaluate(()=>{window.fixtureHold=null;window.releaseFixture();});
  // Missing published state is an explicit fallback, available in expanded mobile view.
  await page.locator('#disk-update-publication').click();
  try {await page.waitForFunction(()=>document.querySelector('#disk-update-publication').textContent==='Boot latest version'&&!document.querySelector('#disk-update-publication').disabled);}catch(error){console.error('Fallback diagnostic',await page.evaluate(()=>({status:document.querySelector('#disk-status').textContent,publication:document.querySelector('#disk-publication-status').textContent,button:document.querySelector('#disk-update-publication').outerHTML,held:window.held,requests:fixtureClient.torrentHost.requests.size,sessions:[...fixtureClient.torrentHost.sessions.keys()],trace:window.refreshTrace})));throw error;}
  assert.equal(await page.evaluate(()=>refreshTrace.at(-1).options.mode),'resume');
  await page.setViewportSize({width:320,height:740});
  await page.evaluate(()=>document.querySelector('#vm-view').requestFullscreen=()=>Promise.reject(Error('Mobile fullscreen unavailable')));await page.locator('#fullscreen').click();
  await page.locator('#vm-update-publication').waitFor({state:'visible'});
  const button=await page.locator('#vm-update-publication').boundingBox();assert(button.x>=0&&button.x+button.width<=321,JSON.stringify(button));
  await page.screenshot({path:output+'/'+name+'-mobile-expanded.png'});
  await page.locator('#vm-update-publication').focus();await page.keyboard.press('Enter');await selected(page,fixture.cb.hash);await idle(page);
  assert(await page.evaluate(()=>fixtureVm!==originalVm));assert.equal(await page.evaluate(()=>fixtureVm.v86.cpu.mem8.length),512*1048576);
  await page.keyboard.press('Escape');await page.locator('#disk-close').click();await page.locator('#disk-login').waitFor({state:'visible'});
  await page.evaluate(()=>fixtureEvents.onPublication({state:'checking',sequence:'999',sourceId:'retired'}));assert(await page.locator('#disk-publication-status').isHidden());
  assert.deepEqual(errors,[]);await page.close();
  // Drafts are deferred with the dialog open and remain attached to their base.
  const draft=await browser.newPage();await draft.goto(server.url);await draft.waitForFunction(()=>!document.body.inert);await installPublicationFixture(draft,fixture);await login(draft);
  await draft.evaluate(()=>fixtureClient.publicationDetails=async()=>({profiles:[]}));await diskAction(draft,'disk-profiles');
  await draft.locator('#disk-profile-file').setInputFiles({name:'profile.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify([{version:2,infoHash:fixture.a.hash,unitBytes:65536,origin:{kind:'boot'},ranges:Array(8).fill(null)}]))});
  await draft.waitForFunction(()=>document.querySelector('#disk-profile-boot').value==='file');
  await announce(draft,fixture.cb.hash,101);await draft.waitForFunction(()=>document.querySelector('#disk-publication-status').textContent.includes('101'));await selected(draft,fixture.ca.hash);
  await draft.locator('#disk-profiles-close').click();await selected(draft,fixture.cb.hash);await idle(draft);await diskAction(draft,'disk-profiles');await draft.locator('#disk-profiles-dialog > div').waitFor({state:'visible'});
  assert.equal(await draft.locator('#disk-profile-boot').inputValue(),'keep');assert.equal(await draft.locator('#disk-profile-file').evaluate(e=>e.files.length),0);
  await draft.keyboard.press('Escape');await announce(draft,fixture.ca.hash,102);await selected(draft,fixture.ca.hash);await idle(draft);await diskAction(draft,'disk-profiles');await draft.locator('#disk-profiles-dialog > div').waitFor({state:'visible'});
  assert.equal(await draft.locator('#disk-profile-boot').inputValue(),'file');assert.equal(await draft.locator('#disk-profile-file').evaluate(e=>e.files.length),1);await draft.close();
  // The opposite race: Boot has already started when B arrives.
  const cold=await browser.newPage({viewport:{width:1280,height:900}});await cold.addInitScript(quietAudio);cold.on('dialog',d=>d.accept());
  await cold.goto(server.url);await cold.waitForFunction(()=>!document.body.inert);await installPublicationFixture(cold,fixture);await login(cold);
  assert((await cold.locator('#disk-publication-status').textContent()).includes('Checking'));
  await cold.locator('#disk-boot').click();await announce(cold,fixture.cb.hash,101);await cold.locator('#vm-update-publication').waitFor({state:'visible'});await idle(cold);
  await selected(cold,fixture.ca.hash);assert.equal(await cold.locator('#vm-update-publication').textContent(),'Restart with latest version');
  await cold.locator('#vm-update-publication').click();await selected(cold,fixture.cb.hash);await idle(cold);
  await cold.evaluate(()=>{if(document.querySelector('#vm-view').classList.contains('expanded'))document.querySelector('#fullscreen').click();});await cold.locator('#disk-close').click();await cold.locator('#disk-login').waitFor({state:'visible'});await cold.close();
  console.log(name+': automatic A/B, published Resume, missing state, cancelled replacement, focus, keyboard, mobile/fullscreen and Boot race PASS');
 } finally {await browser.close();}
}} finally {await server.close();gateway.closeAllConnections();await new Promise(r=>gateway.close(r));await fixture.close();}
