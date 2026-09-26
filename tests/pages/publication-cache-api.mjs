import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {chromium,webkit} from 'playwright';
import {serveSite} from './server.mjs';
import {diskFixture} from './fixture.mjs';
const results=[];await mkdir('build/publication-cache',{recursive:true});
const database='my98-publication-cache-v1';
for(const [engine,type] of Object.entries({chromium,webkit})) {
 const fixture=await diskFixture({isolated:true,car:true}),server=await serveSite({headers:true}),dir=await mkdtemp(process.cwd()+'/build/publication-cache/browser-');let context;
 try {
  context=await type.launchPersistentContext(dir,{headless:true});let page=await context.newPage();await page.goto(server.url);
  const saved=await page.evaluate(async gateway=>{
   const {Slop86Disk}=await import('./build/disk/web/client.js');const d=await Slop86Disk.create();
   try {await d.unlock('disk fixtures','public compatibility password','main');await d.openRemote({gateway,servers:[{url:gateway,resolution:"gateway",discovery:false}],prefetch:{enabled:false}});
    const disabled=(await d.readStats()).remote.persistentCache;
    const databases=await indexedDB.databases();
    const ram=new Uint8Array(2*1048576);for(let i=0;i<ram.length;i+=65536)crypto.getRandomValues(ram.subarray(i,i+65536));
    await d.write(10000,new Uint8Array([42]));const {blob}=await d.saveState(ram.buffer,{version:1});
    return {disabled,databases,bytes:Array.from(new Uint8Array(await blob.arrayBuffer()))};
   }finally{await d.close();}
  },fixture.gateway);
  assert.equal(saved.disabled.available,false);assert(!saved.databases.some(d=>d.name===database));
  const bytes=Buffer.from(saved.bytes),hash=createHash('sha256').update(bytes).digest('hex');
  const profile={version:2,cid:fixture.diskCid,origin:{kind:'state',sha256:hash},unitBytes:65536,ranges:[[1,2],...Array(31).fill(null)]};
  const publication=await fixture.publishState(bytes,undefined,[profile]);
  async function load(target=page,{keep=false,enabled=true}={}) {
   await target.goto(server.url);const start=fixture.requests.length;
   const stats=await target.evaluate(async({gateway,enabled,keep})=>{
    const {Slop86Disk}=await import('./build/disk/web/client.js');const d=await Slop86Disk.create();window.publicationDisk=d;
    async function flush(){for(let n=0;n<2000;n++){const s=(await d.readStats()).remote;if(!s.persistentCache.pendingWrites&&s.prefetchState==='complete')return s;await new Promise(r=>setTimeout(r,5));}throw Error('cache did not settle');}
    try {
     await d.unlock('disk fixtures','public compatibility password','main');
     await d.openRemote({gateway,servers:[{url:gateway,resolution:"gateway",discovery:false}],prefetch:{enabled:false},persistentCache:{publication:enabled}});
     const state=await d.prepareState({published:true});assert(state.state.byteLength===2*1048576,'state RAM size');await d.commitState(state.token);
     assert((await d.read(10000,1))[0]===42,'authenticated state overlay');
     await d.setLoadPrefetch({origin:'restored',scope:'disk'});const before=await flush();
     await d.write(20000,new Uint8Array([91]));assert((await d.read(20000,1))[0]===91,'session write works');
     const after=(await d.readStats()).remote;
     assert(after.persistentCache.disk?.writtenBytes===before.persistentCache.disk?.writtenBytes,'session write not persisted');return after;
    } finally {if(!keep)await d.close();}
    function assert(value,message){if(!value)throw Error(message);}
   },{gateway:fixture.gateway,enabled,keep});
   return {stats,requests:fixture.requests.slice(start).filter(p=>p.startsWith('/ipfs/'))};
  }
  const cold=await load();assert(cold.stats.persistentCache.disk.writes>0);assert(cold.stats.persistentCache.state.writes>0);assert(cold.stats.persistentCache.loadProfile.writes>0);assert.equal(cold.stats.stateTransport.mode,'car');
  const warm=await load();assert.deepEqual(warm.requests,[]);assert(warm.stats.persistentCache.disk.hits>0);
  // Reopen the entire browser with the same on-disk profile.
  await page.locator('#disk-cache-publication').check();await context.close();context=await type.launchPersistentContext(dir,{headless:true});page=await context.newPage();
  const restart=await load();assert.deepEqual(restart.requests,[]);await page.waitForFunction(()=>!document.body.inert);assert(await page.locator('#disk-cache-publication').isChecked());
  const inspect=async(target=page)=>target.evaluate(async database=>{
   const db=await new Promise((resolve,reject)=>{const r=indexedDB.open(database,1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
   try{return await new Promise((resolve,reject)=>{const tx=db.transaction(['machines','blocks'],'readonly'),m=tx.objectStore('machines').getAll(),b=tx.objectStore('blocks').getAll();tx.oncomplete=()=>resolve({machines:m.result,blocks:b.result.map(v=>({cid:v.cid,machine:v.machine,size:v.bytes.length,fields:Object.keys(v)}))});tx.onabort=()=>reject(tx.error);});}finally{db.close();}
  },database);
  const inventory=await inspect();assert.equal(inventory.machines.length,1);assert(inventory.blocks.length>4);
  for(const row of inventory.blocks){assert(fixture.blocks.has(row.cid),'only original published blocks persisted');assert.equal(row.size,fixture.blocks.get(row.cid).length);assert.deepEqual(row.fields.sort(),['bytes','cid','machine']);}
  const stateLeaf=inventory.blocks.find(row=>row.cid!==publication.diskCid&&row.cid!==publication.publicationCid&&row.cid!==publication.profilesCid&&row.cid!==publication.stateCid).cid;
  async function damage(corrupt) {await page.evaluate(async({database,cid,corrupt})=>{
   const db=await new Promise(resolve=>{const r=indexedDB.open(database,1);r.onsuccess=()=>resolve(r.result);});
   try{await new Promise((resolve,reject)=>{const tx=db.transaction('blocks','readwrite'),store=tx.objectStore('blocks'),r=store.getAll();r.onsuccess=()=>{const value=r.result.find(v=>v.cid===cid);if(corrupt){value.bytes[0]^=1;store.put(value);}else store.delete([value.machine,value.cid]);};tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});}finally{db.close();}
  },{database,cid:stateLeaf,corrupt});}
  await damage(false);const repaired=await load();assert.deepEqual(repaired.requests,['/ipfs/'+stateLeaf]);
  await damage(true);const corruption=await load();assert.deepEqual(corruption.requests,['/ipfs/'+stateLeaf]);
  await damage(false);fixture.delays.set(stateLeaf,500);
  let interruption;
  try {
   interruption=await page.evaluate(async gateway=>{
    const {Slop86Disk}=await import('./build/disk/web/client.js');const d=await Slop86Disk.create();let timer;
    try{await d.unlock('disk fixtures','public compatibility password','main');await d.openRemote({gateway,servers:[{url:gateway,resolution:'gateway',discovery:false}],prefetch:{enabled:false},persistentCache:{publication:true}});
     timer=setTimeout(()=>d.cancel(),100);await d.prepareState({published:true});return null;
    }catch(e){return e.code;}finally{clearTimeout(timer);await d.close();}
   },fixture.gateway);
  }finally{fixture.delays.delete(stateLeaf);}
  assert.equal(interruption,'CANCELLED');const resumed=await load();assert.deepEqual(resumed.requests,['/ipfs/'+stateLeaf]);
  const beforeDisabled=await inspect();
  const disabled=await load(page,{enabled:false});assert(disabled.requests.length>0);assert.equal(disabled.stats.persistentCache.available,false);assert.deepEqual(await inspect(),beforeDisabled);
  const old=await load(page,{keep:true});assert.deepEqual(old.requests,[]);
  const newPublication=await fixture.publishState(bytes,undefined,[{...profile,ranges:[[3,4],...Array(31).fill(null)]}]);
  const peer=await context.newPage();let changed,oldStats;
  try {
   changed=await load(peer);assert(changed.requests.includes('/ipfs/'+publication.diskCid));assert(changed.requests.includes('/ipfs/'+publication.stateCid));
   assert.equal((await inspect(peer)).machines[0].rootCid,newPublication.publicationCid);
   oldStats=await page.evaluate(async()=>{const d=window.publicationDisk;await d.discardWrites();await d.clearCaches();const candidate=await d.prepareState({published:true});await d.discardState(candidate.token);await d.verifyImage();const s=(await d.readStats()).remote;await d.close();return s;});
   assert.equal(oldStats.persistentCache.stale,true);
   assert(!(await inspect(peer)).blocks.some(b=>b.cid===publication.profilesCid),'old tab cannot restore old publication data');
  }finally{await peer.close();}
  // Deleting a publication is committed even if the new disk cannot authenticate.
  const invalid=await fixture.publishState(bytes,Buffer.alloc(512*1024),[profile]);
  const rejected=await page.evaluate(async gateway=>{
   const {Slop86Disk}=await import('./build/disk/web/client.js');const d=await Slop86Disk.create();try{await d.unlock('disk fixtures','public compatibility password','main');await d.openRemote({gateway,servers:[{url:gateway,resolution:"gateway",discovery:false}],persistentCache:{publication:true}});return null;}catch(e){return e.code;}finally{await d.close();}
  },fixture.gateway);
  assert(rejected);const invalidInventory=await inspect();assert.equal(invalidInventory.machines[0].rootCid,invalid.publicationCid);assert(!invalidInventory.blocks.some(b=>b.cid===publication.diskCid));
  results.push({engine,cold,warm,restart,repaired,corruption,disabled,changed,oldStats,rejected,inventory,interruption,resumed});
  console.log(engine,'Worker cold/warm/restart, CAR, corruption, changes, concurrent tabs and opt-out PASS');
 }finally{await context?.close();await server.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
}
// A real encrypted disk above the old 128 MiB budget, streamed as UnixFS leaves.
const large=await diskFixture({isolated:true,sizeBytes:129*1048576});
try {for(const [engine,type] of Object.entries({chromium,webkit})) {
 const server=await serveSite({headers:true}),browser=await type.launch();
 try {
  const page=await browser.newPage();await page.goto(server.url);
  const run=async()=>page.evaluate(async gateway=>{
   const {Slop86Disk}=await import('./build/disk/web/client.js');const d=await Slop86Disk.create();
   try {await d.unlock('disk fixtures','public compatibility password','main');await d.openRemote({gateway,servers:[{url:gateway,resolution:"gateway",discovery:false}],prefetch:{enabled:false},persistentCache:{publication:true}});
    const hash=Array.from(await d.verifyImage());
    for(let n=0;n<2000;n++){const s=(await d.readStats()).remote;if(!s.persistentCache.pendingWrites)return {hash,stats:s};await new Promise(r=>setTimeout(r,5));}throw Error('large writer stuck');
   }finally{await d.close();}
  },large.gateway);
  const cold=await run();assert(cold.stats.persistentCache.disk.writtenBytes>128*1048576);await page.reload();const start=large.requests.length,warm=await run();
  assert.deepEqual(warm.hash,cold.hash);assert.deepEqual(large.requests.slice(start).filter(p=>p.startsWith('/ipfs/')),[]);
  results.push({engine,large:{cold,warm}});console.log(engine,'129 MiB encrypted disk: no eviction and zero warm content downloads PASS');
 }finally{await browser.close();await server.close();}
}}finally{await large.close();}
await writeFile('build/publication-cache/api.json',JSON.stringify(results,null,2));
