import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {chromium,webkit} from 'playwright';
import {serveSite} from './server.mjs';
import {diskFixture} from './fixture.mjs';
const results=[];await mkdir('build/persistent-cache',{recursive:true});
for(const [engine,type] of Object.entries({chromium,webkit})) {
 const fixture=await diskFixture({isolated:true,car:true}),server=await serveSite({headers:true}),dir=await mkdtemp(process.cwd()+'/build/persistent-cache/browser-');let context;
 try {
  context=await type.launchPersistentContext(dir,{headless:true});let page=await context.newPage();await page.goto(server.url);
  const saved=await page.evaluate(async gateway=>{
   const {Slop86Disk}=await import('./build/disk/web/client.js');const d=await Slop86Disk.create();
   try{await d.unlock('disk fixtures','public compatibility password','main');await d.openRemote({gateway,servers:[{url:gateway,resolution:'gateway',discovery:false}],prefetch:{enabled:false}});const readKey=await d.exportReadOnlyKey();
    const ram=new Uint8Array(2*1048576);for(let i=0;i<ram.length;i+=65536)crypto.getRandomValues(ram.subarray(i,i+65536));await d.write(10000,new Uint8Array([42]));const {blob}=await d.saveState(ram.buffer,{version:1});return {readKey,bytes:Array.from(new Uint8Array(await blob.arrayBuffer()))};
   }finally{await d.close();}
  },fixture.gateway);
  const bytes=Buffer.from(saved.bytes),hash=createHash('sha256').update(bytes).digest('hex');
  const profile={version:2,cid:fixture.diskCid,origin:{kind:'state',sha256:hash},unitBytes:65536,ranges:[[1,2],...Array(31).fill(null)]};
  const publication=await fixture.publishState(bytes,undefined,[profile]);
  const stateBlocks=new Set([...fixture.blocks.keys()].filter(cid=>![fixture.diskCid,publication.publicationCid,publication.profilesCid].includes(cid)));
  async function load(options={},target=page) {
   await target.goto(server.url);const start=fixture.requests.length;
   const out=await target.evaluate(async({publication,readKey,gateway,options})=>{
    const {Slop86Disk}=await import('./build/disk/web/client.js');const d=await Slop86Disk.create();window.cacheDisk=d;
    const checks=[],ok=(condition,label)=>{if(!condition)throw Error(label);checks.push(label);};
    async function flush(){for(let n=0;n<1000;n++){const s=(await d.readStats()).remote;if(!s.persistentCache.pendingWrites&&s.prefetchState==='complete')return s;await new Promise(r=>setTimeout(r,10));}throw Error('cache/profile did not settle');}
    try{
     await d.openReadOnly({cid:publication.publicationCid,readKey,gateway,prefetch:{enabled:false},preloadState:true,persistentCache:options.flags||{state:true,loadProfile:true},stateTransport:options.transport||'auto'});
     const p=await d.prepareState({published:true});ok(p.state.byteLength===2*1048576,'full RAM restored');await d.commitState(p.token);ok((await d.read(10000,1))[0]===42,'authenticated overlay preserved');
     await d.read(65536,32);await d.setLoadPrefetch({origin:'restored',scope:'profile'});const profile=await flush();ok(profile.loadProfile.status==='complete','profile completed');
     await d.setLoadPrefetch({origin:'restored',scope:'disk'});const exit=await flush();ok(exit.persistentCache.loadProfile.writtenBytes===profile.persistentCache.loadProfile.writtenBytes,'Exit does not increase persistent bytes');
     await d.write(20000,new Uint8Array([91]));await d.read(20000,1);const last=(await d.readStats()).remote;
     ok(last.persistentCache.loadProfile.writtenBytes===exit.persistentCache.loadProfile.writtenBytes,'session writes are not persisted');
     return {checks,profile,exit};
    }finally{await d.close();}
   },{publication:options.publication||publication,readKey:saved.readKey,gateway:fixture.gateway,options});
   const stateRequests=fixture.requests.slice(start).filter(path=>stateBlocks.has(path.slice(6)));
   return {...out,stateRequests};
  }
  const cold=await load();assert.equal(cold.profile.stateTransport.mode,'car','cold load retains CAR transport');assert(cold.stateRequests.length);assert(cold.profile.persistentCache.state.writes);assert(cold.profile.persistentCache.loadProfile.writes);
  const warm=await load();assert.equal(warm.stateRequests.length,0);assert.equal(warm.profile.persistentCache.state.writes,0);assert(warm.profile.persistentCache.state.hits);assert(warm.profile.persistentCache.loadProfile.hits);
  await context.close();context=await type.launchPersistentContext(dir,{headless:true});page=await context.newPage();const restart=await load();assert.equal(restart.stateRequests.length,0);
  const newProfile={...profile,ranges:[[3,4],...Array(31).fill(null)]},newPublication=await fixture.publishState(bytes,undefined,[newProfile]);
  const changed=await load({publication:newPublication});assert.equal(changed.stateRequests.length,0);assert.equal(changed.profile.rangeProfile.units,2);
  const stateOnly=await load({flags:{state:true,loadProfile:false}});assert.equal(stateOnly.stateRequests.length,0);assert.equal(stateOnly.profile.persistentCache.loadProfile.hits,0);
  const lost=[...stateBlocks].find(cid=>cid!==publication.stateCid);
  await page.evaluate(async cid=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('my98-published-cache-v1');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});try{await new Promise((resolve,reject)=>{const tx=db.transaction('blocks','readwrite');tx.objectStore('blocks').delete(cid);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});}finally{db.close();}},lost);
  const repaired=await load();assert.deepEqual(repaired.stateRequests,['/ipfs/'+lost],'only the missing state leaf is refetched');
  // Independent Workers in two real tabs share transactional accounting.
  await page.evaluate(()=>new Promise((resolve,reject)=>{const r=indexedDB.deleteDatabase('my98-published-cache-v1');r.onsuccess=resolve;r.onerror=()=>reject(r.error);r.onblocked=()=>reject(Error('cache still open'));}));
  const peer=await context.newPage();let twoTabs;
  try{twoTabs=await Promise.all([load(),load({},peer)]);}finally{await peer.close();}
  const sharedUsage=await page.evaluate(async()=>{const db=await new Promise(resolve=>{const r=indexedDB.open('my98-published-cache-v1');r.onsuccess=()=>resolve(r.result);});try{return await new Promise((resolve,reject)=>{const tx=db.transaction(['blocks','meta'],'readonly'),blocks=tx.objectStore('blocks').getAll(),usage=tx.objectStore('meta').get('usage');tx.oncomplete=()=>resolve({actual:blocks.result.reduce((n,b)=>n+b.size,0),count:blocks.result.length,...usage.result});tx.onabort=()=>reject(tx.error);});}finally{db.close();}});
  assert.equal(sharedUsage.bytes,sharedUsage.actual);assert(sharedUsage.bytes<=128*1048576);assert(twoTabs.every(r=>r.profile.persistentCache.state.writes+r.profile.persistentCache.state.hits>0));
  const broken=Buffer.from(bytes);broken[broken.length-1]^=1;const changedState=await fixture.publishState(broken,undefined,[profile]);
  const rejection=await page.evaluate(async({changedState,gateway,readKey})=>{const {Slop86Disk}=await import('./build/disk/web/client.js');const d=await Slop86Disk.create();try{await d.openReadOnly({cid:changedState.publicationCid,readKey,gateway,prefetch:{enabled:false},persistentCache:{state:true,loadProfile:true}});try{await d.prepareState({published:true});return 'accepted';}catch(e){return e.code;}}finally{await d.close();}},{changedState,gateway:fixture.gateway,readKey:saved.readKey});
  assert(['CORRUPTION','INVALID_STATE'].includes(rejection),'changed state is authenticated, never replaced by cached older state');
  const otherDisk=await page.evaluate(async()=>{const {Slop86Disk}=await import('./build/disk/web/client.js');const d=await Slop86Disk.create();try{await d.unlock('disk fixtures','public compatibility password','main');const created=await d.createEmpty(512*1024);return {bytes:Array.from(new Uint8Array(await created.download.blob.arrayBuffer())),readKey:await d.exportReadOnlyKey()};}finally{await d.close();}});
  const changedDisk=await fixture.publishState(bytes,Buffer.from(otherDisk.bytes),[profile]);
  const diskRejection=await page.evaluate(async({publication,gateway,readKey})=>{const {Slop86Disk}=await import('./build/disk/web/client.js');const d=await Slop86Disk.create();try{await d.openReadOnly({cid:publication.publicationCid,readKey,gateway,prefetch:{enabled:false},persistentCache:{state:true,loadProfile:true}});await d.prepareState({published:true});return 'accepted';}catch(e){return e.code;}finally{await d.close();}},{publication:changedDisk,gateway:fixture.gateway,readKey:otherDisk.readKey});
  assert.notEqual(diskRejection,'accepted','cached state must reject a changed base disk');
  results.push({engine,cold,warm,restart,changed,stateOnly,repaired,twoTabs,sharedUsage,rejection,diskRejection});console.log(engine,'real Worker, authenticated state, cache reload/restart, changed profile and Exit PASS');
 }finally{await context?.close();await server.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
}
await writeFile('build/persistent-cache/api.json',JSON.stringify(results,null,2));
