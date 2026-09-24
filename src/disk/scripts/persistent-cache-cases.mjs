import {PersistentCache,CACHE_DATABASE,CACHE_LIMITS} from '../web/persistent-cache.js';
import {RemoteDisk} from '../web/remote.js';
import {ProfileCacheSelection} from '../web/profile-cache.js';
import {carFixture,carBytes} from './car-fixture.mjs';
import {CID} from 'multiformats/cid';
import {sha256} from 'multiformats/hashes/sha2';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const check=(ok,label)=>{if(!ok)throw Error(label);};
async function settled(cache){for(let n=0;n<2000;n++){await cache.ready;if(!cache.writing&&!cache.queue.length)return;await delay(5);}throw Error('cache writes stalled');}
async function reset(){await new Promise((resolve,reject)=>{const r=indexedDB.deleteDatabase(CACHE_DATABASE);r.onsuccess=resolve;r.onerror=()=>reject(r.error);r.onblocked=()=>reject(Error('test database still open'));});}
async function database(fn){const c=new PersistentCache({state:true,loadProfile:true});await c.ready;try{return await fn(c);}finally{c.close();}}
const collect=async stream=>{const reader=stream.getReader();let count=0,hash=0;try{for(;;){const {value,done}=await reader.read();if(done)break;count+=value.length;for(const b of value)hash=(hash+b)>>>0;}}finally{reader.releaseLock();}return {count,hash};};
export async function runPersistentCacheCases(){
 const checks=[],ok=(value,label)=>{check(value,label);checks.push(label);console.log('PASS',label);};await reset();
 const block=new Uint8Array([1,2,3,4]),cid=CID.createV1(0x55,await sha256.digest(block));
 let c=new PersistentCache();await c.ready;c.put(cid,block,'state');await settled(c);ok(!c.db&&!c.stats().state.writes,'disabled by default');c.close();
 c=new PersistentCache({state:true});c.put(cid,block,'state');await settled(c);ok(c.stats().state.writes===1,'verified candidate persisted');c.close();
 c=new PersistentCache({state:true});ok((await c.get(cid,'state'))?.join(',')==='1,2,3,4','new cache instance restores exact bytes');await settled(c);c.close();
 await database(async cache=>cache.transaction(['blocks'],'readwrite',tx=>{const store=tx.objectStore('blocks'),r=store.get(cid.toString());r.onsuccess=()=>{const v=r.result;v.bytes[0]^=1;store.put(v);};}));
 c=new PersistentCache({state:true});ok(await c.get(cid,'state')===undefined,'corrupt stored block is a miss');await settled(c);c.put(cid,block,'state');await settled(c);ok((await c.get(cid,'state'))?.[0]===1,'corrupt entry can be repaired');await settled(c);c.close();
 c=new PersistentCache({state:true});await c.ready;const original=c.transaction.bind(c);c.transaction=()=>Promise.reject(Error('simulated storage loss'));ok(await c.get(cid,'state')===undefined,'read failure falls back');await settled(c);c.close();
 await reset();c=new PersistentCache({state:true});await c.ready;c.transaction=()=>Promise.reject(Object.assign(Error('quota'),{name:'QuotaExceededError'}));c.put(cid,block,'state');await settled(c);ok(!c.db&&c.stats().state.errors===1,'quota failure disables only optional cache');c.close();
 await reset();c=new PersistentCache({state:true});await c.ready;
 let release;const gate=new Promise(r=>release=r),write=c.writePuts.bind(c);c.writePuts=async items=>{await gate;await write(items);};
 const full=new Uint8Array(CACHE_LIMITS.queue);const fullCid=CID.createV1(0x55,await sha256.digest(full));c.put(fullCid,full,'state');c.put(cid,block,'state');ok(c.queueBytes===CACHE_LIMITS.queue&&c.stats().state.discarded===1,'slow writer stays inside 4 MiB budget');release();await settled(c);await c.complete(cid.toString());await settled(c);ok(!await c.hasState(cid.toString()),'dropped writes cannot mark a state complete');c.close();
 await reset();c=new PersistentCache({state:true});await c.ready;c.put(cid,block,'state');await settled(c);
 const fill=new Uint8Array(4*1048576);
 for(let n=0;n<32;n++){fill[0]=n;const id=CID.createV1(0x55,await sha256.digest(fill));c.put(id,fill,'state');await settled(c);}
 const budget=await c.transaction(['meta'],'readonly',tx=>{const r=tx.objectStore('meta').get('usage');return ()=>r.result;});
 ok(budget.bytes===CACHE_LIMITS.bytes&&!c.keys.has(cid.toString()),'actual 128 MiB limit evicts oldest blocks');
 await c.complete(cid.toString());await settled(c);ok(!await c.hasState(cid.toString()),'evicted state blocks prevent complete marker');c.close();
 const other=new Uint8Array([5,6,7,8]),otherCid=CID.createV1(0x55,await sha256.digest(other));
 await reset();const a=new PersistentCache({state:true}),b=new PersistentCache({loadProfile:true});await Promise.all([a.ready,b.ready]);a.put(cid,block,'state');b.put(otherCid,other,'loadProfile');await Promise.all([settled(a),settled(b)]);
 const usage=await a.transaction(['meta'],'readonly',tx=>{const r=tx.objectStore('meta').get('usage');return ()=>r.result;});ok(usage.bytes===8&&usage.count===2,'concurrent connections update budget atomically');a.close();b.close();
 const idb=Object.getOwnPropertyDescriptor(globalThis,'indexedDB');
 Object.defineProperty(globalThis,'indexedDB',{configurable:true,value:{open(){throw Error('storage unavailable');}}});
 try{c=new PersistentCache({state:true});await c.ready;ok(!c.db&&await c.get(cid,'state')===undefined&&c.stats().state.errors===1,'unavailable storage remains optional');c.close();}finally{if(idb)Object.defineProperty(globalThis,'indexedDB',idb);else delete globalThis.indexedDB;}
 let f=await carFixture({nested:true,inline:true});const native=globalThis.fetch;
 async function transfer({transport='auto',cancel=false,complete=true}={}){
  const r=new RemoteDisk({gateway:'https://cache.example',prefetch:{enabled:false},stateTransport:transport,persistentCache:{state:true}});r.stateCid=f.cid.toString();let raw=0,car=0;
  r.request=async path=>{raw++;await delay(2);return f.blocks.get(path.split('/')[2].split('?')[0]).slice();};
  globalThis.fetch=async url=>{car++;const u=new URL(url),[start,end]=u.searchParams.get('entity-bytes').split(':').map(Number);const bytes=carBytes(f.blocks,f.cid,start,end-start+1);let offset=0;return new Response(new ReadableStream({async pull(out){await delay(2);if(offset===bytes.length){out.close();return;}const next=Math.min(bytes.length,offset+65536);out.enqueue(bytes.slice(offset,next));offset=next;}}),{headers:{'Content-Type':'application/vnd.ipld.car'}});};
  const controller=new AbortController(),timer=setTimeout(()=>{console.log('timeout stats',JSON.stringify(r.stats()));controller.abort();},15000);
  try{const info=await r.openStateStream(controller.signal);if(cancel){const reader=info.stream.getReader();await reader.read();await reader.cancel();}else{const got=await collect(info.stream);ok(got.count===f.size&&got.hash===f.bytes.reduce((s,v)=>(s+v)>>>0,0),'exact state via '+transport);if(complete)await info.validated();}await settled(r.persistent);return {raw,car,stats:r.stats().persistentCache,marked:await r.persistent.hasState(f.cid.toString())};}finally{clearTimeout(timer);r.close();globalThis.fetch=native;}
 }
 await reset();let cold=await transfer();ok(cold.car>0&&cold.marked&&cold.stats.state.discarded===0,'CAR saves state and completion');let warm=await transfer();ok(warm.car===0&&warm.raw===0&&warm.stats.state.hits>0,'warm CAR state performs no network requests');
 await reset();f=await carFixture({nested:true});cold=await transfer({transport:'blocks'});warm=await transfer({transport:'blocks'});ok(cold.raw>0&&warm.raw===0,'raw transport persists and reuses state');
 await reset();await transfer({cancel:true});c=new PersistentCache({state:true});ok(!await c.hasState(f.cid.toString()),'cancellation does not mark state complete');await c.ready;ok(c.keys.size>0,'verified blocks survive an interrupted transfer');c.close();
 const resumed=await transfer();ok(resumed.car===0&&resumed.stats.state.hits>0&&resumed.marked,'partial state resumes from cached blocks without CAR redownload');
 await reset();await transfer({complete:false});c=new PersistentCache({state:true});ok(!await c.hasState(f.cid.toString()),'unvalidated stream never marks complete');c.close();
 await reset();const selected=new Map(),memory=new Map(f.blocks),selection=new ProfileCacheSelection(f.cid.toString(),f.size,[[7,8]],memory,(cid,bytes)=>selected.set(cid.toString(),bytes));
 ok(selected.has(f.leaves[1].cid.toString())&&selected.has(f.leaves[2].cid.toString()),'early demand blocks promoted by profile ranges');
 ok(!selected.has(f.leaves[3].cid.toString())&&selected.size<f.blocks.size,'profile excludes unrelated disk blocks');const before=selected.size;
 for(const [key,bytes] of f.blocks)selection.observe(CID.parse(key),bytes);ok(selected.size===before,'full disk reads do not expand profile eligibility');
 return {checks};
}
