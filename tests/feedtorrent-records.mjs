/** Durable replay protection and concurrent generic gateway observations. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {chromium,firefox,webkit} from 'playwright';
import {browserOptions} from './browser-options.mjs';
import {key,record} from './feedtorrent-fixture.mjs';
const root=resolve('.');
const server=createServer(async(req,res)=>{
 try {
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(pathname==='/'){res.writeHead(200,{'Content-Type':'text/html'}).end('<!doctype html>');return;}
  const path=resolve(root,'.'+pathname);assert(path.startsWith(root+sep));
  const bytes=await readFile(path);res.writeHead(200,{'Content-Type':extname(path)==='.js'?'text/javascript':'application/wasm'}).end(bytes);
 }catch{res.writeHead(404).end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
try {
 for(const [name,type] of Object.entries({chromium,firefox,webkit})) {
  const browser=await type.launch(browserOptions(name));
  try {
   const context=await browser.newContext();const page=await context.newPage();await page.goto('http://127.0.0.1:'+server.address().port);
    const result=await page.evaluate(async({key,a,b,fork,c,cFork})=>{
     const {cachedRecord,observeRecord,resolveRecord}=await import('/src/disk/web/torrent-records.js');
     const {clearTorrentCache,openTorrentDatabase}=await import('/src/disk/web/torrent-store.js');
     const {default:init,verify}=await import('/build/disk/pkg/slop86_disk.js');await init();
     const check=(v,m)=>{if(!v)throw Error(m);};
     const reject=async(job,code)=>{try{await job;throw Error('Unexpected success')}catch(error){check(error.code===code,'Expected '+code+', got '+error.code);return error;}};
     const reset=async()=>{const db=await openTorrentDatabase();await new Promise((r,j)=>{const tx=db.transaction(['names'],'readwrite');tx.objectStore('names').clear();tx.oncomplete=r;tx.onabort=j;});db.close();};
     await observeRecord(a,key,verify);await observeRecord(b,key,verify);
     await reject(observeRecord(a,key,verify),'PUBLICATION_CONFLICT');
     await reject(observeRecord(fork,key,verify),'PUBLICATION_CONFLICT');
     await reject(cachedRecord(key,verify),'PUBLICATION_CONFLICT');
     await clearTorrentCache();await reject(cachedRecord(key,verify),'PUBLICATION_CONFLICT');
     await observeRecord(c,key,verify);check((await cachedRecord(key,verify)).sequence===c.sequence,'Higher signed record did not resolve older fork');
     const original=globalThis.fetch,base=location.origin,sources={gateways:[base+'/a'],trackers:[]};let finish,events=[],status=[];
     const frame=(event,data)=>new TextEncoder().encode('event: '+event+'\ndata: '+JSON.stringify(data)+'\n\n');
     const sse=data=>new Response(frame('done',data),{headers:{'Content-Type':'text/event-stream'}});
     let attempts=0;
     await reset();
     globalThis.fetch=async()=>new Response(new Uint8Array([...frame('record',c),...frame('done',{record:a,error:null})]),{headers:{'Content-Type':'text/event-stream'}});
     check((await resolveRecord(key,sources,verify)).sequence===c.sequence,'Fresh traversal regressed a higher shared signed candidate');
     await reset();
     globalThis.fetch=async()=>++attempts<3?sse({record:null,error:{status:503,message:'DHT gateway unavailable'}}):new Response(JSON.stringify(c));
     check((await resolveRecord(key,sources,verify)).sequence===c.sequence&&attempts===3,'Transient SSE503 did not recover automatically');
     for(const code of [429,502,503,504]) {
      await reset();attempts=0;
      globalThis.fetch=async()=>++attempts===1?new Response('',{status:code}):new Response(JSON.stringify(c));
      check((await resolveRecord(key,sources,verify)).sequence===c.sequence&&attempts===2,'Transient HTTP'+code+' did not recover');
     }
     await reset();attempts=0;
     globalThis.fetch=async()=>{attempts++;return sse({record:null,error:{status:503,message:'DHT gateway unavailable'}});};
     const unavailable=await reject(resolveRecord(key,sources,verify),'PUBLICATION_UNAVAILABLE');
     check(attempts===3&&unavailable.message.includes('503'),'Persistent503 lost cause or exceeded retry bound');
     for(const code of [400,401,403,409]) {
      await reset();attempts=0;
      globalThis.fetch=async()=>{attempts++;return new Response('',{status:code});};
      const error=await reject(resolveRecord(key,sources,verify),code===409?'GATEWAY_CONFLICT':'PUBLICATION_UNAVAILABLE');
      check(attempts===1&&(code===409||error.message.includes(String(code))),'Non-transient response retried or hidden');
     }
     await reset();attempts=0;
     globalThis.fetch=async()=>{attempts++;return new Response('',{status:404});};
     check(await resolveRecord(key,sources,verify)===null&&attempts===1,'Absence was retried');
     await reset();attempts=0;
     globalThis.fetch=async()=>{attempts++;return new Response(JSON.stringify({...c,signature:'00'.repeat(64)}));};
     await reject(resolveRecord(key,sources,verify),'INVALID_PUBLICATION');check(attempts===1,'Invalid signature retried');
     await reset();attempts=0;
     globalThis.fetch=async()=>++attempts===1?new Response(frame('record',a).slice(0,17),{headers:{'Content-Type':'text/event-stream'}}):new Response(JSON.stringify(c));
     check((await resolveRecord(key,sources,verify)).sequence===c.sequence&&attempts===2,'Premature empty stream did not recover');
     await reset();attempts=0;
     globalThis.fetch=async()=>{if(++attempts===1)throw TypeError('Disconnected');return new Response(JSON.stringify(c));};
     check((await resolveRecord(key,sources,verify)).sequence===c.sequence&&attempts===2,'Transient network failure did not recover');
     await reset();attempts=0;
     const backoffCancel=new AbortController();
     globalThis.fetch=async()=>{attempts++;return new Response('',{status:503});};
     const backoff=resolveRecord(key,sources,verify,{signal:backoffCancel.signal});
     while(!attempts)await new Promise(r=>setTimeout(r,0));await new Promise(r=>setTimeout(r,0));
     backoffCancel.abort(Object.assign(Error('Cancelled'),{code:'CANCELLED'}));await reject(backoff,'CANCELLED');check(attempts===1,'Cancelled backoff retried');
     attempts=0;
     await reject(resolveRecord(key,sources,verify,{timeout:40}),'PUBLICATION_UNAVAILABLE');check(attempts===1,'Retries reset the overall deadline');
     await observeRecord(c,key,verify);
     globalThis.fetch=async()=>new Promise(r=>{finish=r;});let settled=false;
     const hot=resolveRecord(key,sources,verify,{onRecord:r=>events.push(r.sequence),onStatus:s=>status.push(s)}).finally(()=>settled=true);
     while(!finish||!events.length)await new Promise(r=>setTimeout(r,0));
     check(events[0]===c.sequence&&!settled,'Cache waited for network');finish(new Response(JSON.stringify(a)));
     check((await hot).sequence===c.sequence,'Stale gateway regressed maximum');
     globalThis.fetch=async()=>new Response('',{status:409});status=[];
     check((await resolveRecord(key,sources,verify,{onStatus:s=>status.push(s)})).sequence===c.sequence,'Unsigned409 poisoned cache');
     check(status.some(s=>s.error?.code==='GATEWAY_CONFLICT'&&!s.fatal),'409 was hidden');
     globalThis.fetch=async()=>{throw TypeError('Disconnected');};
     check((await resolveRecord(key,sources,verify)).sequence===c.sequence,'Offline lost signed cache');
     await reset();let controller;events=[];status=[];
     globalThis.fetch=async()=>new Response(new ReadableStream({start(c){controller=c;}}),{headers:{'Content-Type':'text/event-stream'}});
     const cold=resolveRecord(key,sources,verify,{onRecord:r=>events.push(r.sequence),onStatus:s=>status.push(s)});
     while(!controller)await new Promise(r=>setTimeout(r,0));
     const bytes=frame('record',a);controller.enqueue(bytes.slice(0,17));controller.enqueue(bytes.slice(17));
     while(!events.length)await new Promise(r=>setTimeout(r,0));check(events[0]===a.sequence,'No first streamed candidate');
     controller.enqueue(frame('record',b));controller.enqueue(frame('done',{record:b,error:null}));controller.close();
     check((await cold).sequence===b.sequence,'Stream lost higher version');check(events.length===2,'Duplicate observation delivered');
     globalThis.fetch=async()=>new Response(frame('record',b),{headers:{'Content-Type':'text/event-stream'}});status=[];
     await resolveRecord(key,sources,verify,{onStatus:s=>status.push(s)});check(status.at(-1).state==='unavailable','PrematureEOF looked complete');
     await observeRecord(c,key,verify);
     globalThis.fetch=async()=>new Response(frame('record',cFork),{headers:{'Content-Type':'text/event-stream'}});status=[];
     await reject(resolveRecord(key,sources,verify,{onStatus:s=>status.push(s)}),'PUBLICATION_CONFLICT');
     check(status.some(s=>s.fatal),'Late signed conflict not notified');await reject(cachedRecord(key,verify),'PUBLICATION_CONFLICT');
     // A bad signature never creates a signed conflict proof.
     await reset();await observeRecord(c,key,verify);
     globalThis.fetch=async()=>new Response(JSON.stringify({...cFork,signature:'00'.repeat(64)}));await resolveRecord(key,sources,verify);
     check((await cachedRecord(key,verify)).value===c.value,'Invalid signature altered replay protection');
     await reset();let accepted=0;
     globalThis.fetch=async()=>new Response(JSON.stringify(c));
     const put=IDBObjectStore.prototype.put;
     IDBObjectStore.prototype.put=function(...args){if(this.name==='names')throw new DOMException('Fixture quota','QuotaExceededError');return put.apply(this,args);};
     try{await reject(resolveRecord(key,sources,verify,{onRecord:()=>accepted++}),'STORAGE_FULL');check(accepted===0,'Uncommitted candidate escaped');}
     finally{IDBObjectStore.prototype.put=put;}
     await observeRecord(c,key,verify);
     {const db=await openTorrentDatabase();await new Promise((r,j)=>{const tx=db.transaction(['names'],'readwrite');tx.objectStore('names').put({...c,publicKey:key,signature:'00'.repeat(64)});tx.oncomplete=r;tx.onabort=j;});db.close();}
     await reject(resolveRecord(key,sources,verify),'STORAGE_ERROR');await reset();await observeRecord(c,key,verify);
     const cancel=new AbortController();let began=false;
     globalThis.fetch=async(_url,options)=>{began=true;return new Promise((r,j)=>options.signal.addEventListener('abort',()=>j(options.signal.reason),{once:true}));};
     const cancelled=resolveRecord(key,sources,verify,{signal:cancel.signal});while(!began)await new Promise(r=>setTimeout(r,0));cancel.abort(Object.assign(Error('Cancelled'),{code:'CANCELLED'}));await reject(cancelled,'CANCELLED');
     globalThis.fetch=original;
     return {sharedCandidateStaleFinal:true,transientRetry:true,boundedRetry:true,preservedSourceError:true,noRetryInvalidOrConflict:true,cancelledBackoff:true,sharedDeadline:true,durableMaximum:true,exactSequence:c.sequence,cacheImmediate:true,streamed:true,persistentProof:true,higherRecovery:true,unsigned409:true,lateConflict:true,prematureEOF:true,invalidSignature:true,quotaGuard:true,corruptGuard:true,cancelled:true};
    },{key,a:record('aa'.repeat(20),'9007199254740994'),b:record('bb'.repeat(20),'9007199254740995'),fork:record('dd'.repeat(20),'9007199254740995'),c:record('cc'.repeat(20),'9007199254740996'),cFork:record('cc'.repeat(20),'9007199254740996',{extension:'different signed value'})});
   const second=await page.context().newPage();await second.goto('http://127.0.0.1:'+server.address().port);
   await page.evaluate(async(key)=>{const {watchRecord}=await import('/src/disk/web/torrent-records.js');const {verify}=await import('/build/disk/pkg/slop86_disk.js');window.observed=[];window.stopWatching=watchRecord(key,verify,s=>observed.push({sequence:s.record?.sequence,blocked:s.blocked}));},key);
   const racing=async(p,value)=>p.evaluate(async({key,value})=>{
    const {observeRecord}=await import('/src/disk/web/torrent-records.js');const {default:init,verify}=await import('/build/disk/pkg/slop86_disk.js');await init();
    try{await observeRecord(value,key,verify);return true;}catch(e){if(e.code!=='PUBLICATION_CONFLICT')throw e;return false;}
   },{key,value});
   await Promise.all([racing(page,record('dd'.repeat(20),'9007199254740997')),racing(second,record('ee'.repeat(20),'9007199254740998'))]);
   for(const p of [page,second])assert.equal(await p.evaluate(async(key)=>{const {cachedRecord}=await import('/src/disk/web/torrent-records.js');const {verify}=await import('/build/disk/pkg/slop86_disk.js');return (await cachedRecord(key,verify)).sequence;},key),'9007199254740998');
   await page.waitForFunction(()=>observed.some(s=>s.sequence==='9007199254740998'));
   await racing(second,record('ff'.repeat(20),'9007199254740998'));
   await page.waitForFunction(()=>observed.some(s=>s.sequence==='9007199254740998'&&s.blocked));
   await racing(second,record('aa'.repeat(20),'9007199254740999'));
   await page.waitForFunction(()=>observed.some(s=>s.sequence==='9007199254740999'&&!s.blocked));
   await page.evaluate(()=>stopWatching());
   await second.close();
   console.log(JSON.stringify({browser:name,twoTabs:true,...result}));
  }finally{await browser.close();}
 }
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
