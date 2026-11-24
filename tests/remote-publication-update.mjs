/** Real Worker/Vault publication transactions over deterministic ciphertext transports. */
import assert from 'node:assert/strict';
import {chromium,firefox,webkit} from 'playwright';
import {serveSite,quietAudio} from './pages/server.mjs';
import {browserOptions} from './browser-options.mjs';
import {publicationFixture,installPublicationFixture,makePublishedState} from './pages/publication-fixture.mjs';
const server=await serveSite({headers:true}),fixture=await publicationFixture();
try {for(const [name,engine] of Object.entries({chromium,firefox,webkit})) {
 const browser=await engine.launch(browserOptions(name));
 try {
  const page=await browser.newPage();await page.addInitScript(quietAudio);await page.goto(server.url);await page.waitForFunction(()=>!document.body.inert);
  const state=await makePublishedState(page,fixture),cs=fixture.addState(state.bytes);
  await installPublicationFixture(page,fixture);
  const checks=await page.evaluate(async({key,b,cs,recordB,recordState,nextRecord,readKey})=>{
   const {Slop86Disk}=await import('/build/disk/web/client.js');
   const checks=[],check=(v,m)=>{if(!v)throw Error(m);checks.push(m);};
   const reject=async(p,code)=>{try{await p;throw Error('Unexpected success');}catch(e){check(e.code===code,'rejected '+code+': '+e.message);}};
   const options={publicKey:key,sources:{gateways:[location.origin],trackers:[]},prefetchScope:'none'};
   const owner=await Slop86Disk.create();await owner.unlock('disk fixtures','public compatibility password','main');
   await owner.openRemote(options);await owner.write(1024,new Uint8Array([77]));await announcePublication(recordB);
   let candidate=await owner.prepareRemoteUpdate({minimumSequence:recordB.sequence}),view=owner.remoteUpdateDisk(candidate.token);
   check((await owner.read(1024,1))[0]===77&&(await view.read(1024,1))[0]===42,'candidate and current overlays stay isolated');
   await reject(owner.commitRemoteUpdate(candidate.token),'DIRTY_DISK');
   await owner.discardRemoteUpdate(candidate.token);check((await owner.read(1024,1))[0]===77,'discard preserves previous writes');
   window.fixtureError=true;await reject(owner.prepareRemoteUpdate(), 'TRANSPORT_ERROR');window.fixtureError=false;
   check((await owner.read(1024,1))[0]===77,'source failure preserves opened disk');
   let release;window.fixtureHold=()=>{window.updateHeld=true;return new Promise(r=>release=r);};
   const opening=owner.prepareRemoteUpdate();while(!window.updateHeld)await new Promise(r=>setTimeout(r,0));
   const oldRead=owner.read(1024,1);owner.cancelRemoteUpdate();await reject(opening,'CANCELLED');window.fixtureHold=null;release();
   check((await oldRead)[0]===77,'cancelling the candidate preserves queued guest reads');
   candidate=await owner.prepareRemoteUpdate();await announcePublication(recordState);
   await reject(owner.commitRemoteUpdate(candidate.token,{discardChanges:true}),'PUBLICATION_CHANGED');await owner.discardRemoteUpdate(candidate.token);
   candidate=await owner.prepareRemoteUpdate();view=owner.remoteUpdateDisk(candidate.token);
   const restored=await view.prepareState({publication:true});check(restored.metadata.config.memory_size===32*1048576,'candidate authenticates new published state and its RAM configuration');
   await owner.commitRemoteUpdate(candidate.token,{discardChanges:true});view.committed=true;
   check((await view.read(1024,1))[0]===42&&(await owner.describe()).remote.publicationInfoHash===cs,'commit replaces disk/state/catalog together');
   const sessions=owner.torrentHost.sessions.size;await announcePublication({...recordState});
   const {Vault}=await import('/build/disk/pkg/slop86_disk.js');const signer=new Vault('disk fixtures',new TextEncoder().encode('public compatibility password'),'main');
   const newer=JSON.parse(signer.sign_publication(Uint8Array.from(cs.match(/../g),x=>parseInt(x,16)),'104'));signer.free();await announcePublication(newer);
   const same=await owner.prepareRemoteUpdate();check(same.unchanged&&same.description.remote.sequence==='104'&&owner.torrentHost.sessions.size===sessions,'same catalog advances only version metadata');
   const reader=await Slop86Disk.create();await reader.openRemoteReadOnly({...options,infoHash:undefined,readKey});
   // Read-only refresh must retain the stable capability inside Worker; no second credential call.
   await announcePublication(nextRecord);
   candidate=await reader.prepareRemoteUpdate();check(candidate.description.readOnly,'reader candidate retains read-only permissions');
   await reader.commitRemoteUpdate(candidate.token);check((await reader.describe()).readOnly,'reader commit retains read-only permissions');
   await reject(reader.exportReadOnlyKey(),'READ_ONLY');
   await reader.close();
   const pinned=await Slop86Disk.create();await pinned.unlock('disk fixtures','public compatibility password','main');await pinned.openRemote({infoHash:cs,sources:options.sources,prefetchScope:'none'});await reject(pinned.prepareRemoteUpdate(),'INVALID_PUBLICATION');await pinned.close();
   await owner.close();return checks;
  },{key:fixture.key,b:fixture.b.hash,cs:cs.hash,recordB:fixture.record(fixture.cb.hash,'101'),recordState:fixture.record(cs.hash,'103'),nextRecord:fixture.record(fixture.cb.hash,'105'),readKey:state.readKey});
  assert(checks.length>=10);console.log(name+': '+checks.length+' publication transaction checks PASS');
 } finally {await browser.close();}
}} finally {await server.close();await fixture.close();}
