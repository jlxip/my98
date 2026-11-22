/** Late discovery failures must also stop cached/in-flight source reads. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {chromium,firefox,webkit} from 'playwright';
import {browserOptions} from './browser-options.mjs';
import {key,record,catalog,torrent} from './feedtorrent-fixture.mjs';
const root=resolve('.'),server=createServer(async(req,res)=>{
 try{if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html>');return;}
 const path=resolve(root,'.'+new URL(req.url,'http://localhost').pathname);assert(path.startsWith(root+sep));res.setHeader('Content-Type',extname(path)==='.js'?'text/javascript':'application/wasm');res.end(await readFile(path));}catch{res.writeHead(404).end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
try{for(const [name,type]of Object.entries({chromium,firefox,webkit})){
 const browser=await type.launch(browserOptions(name));
 try{const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port);
 const result=await page.evaluate(async({key,a,b,cat})=>{
  const {RemotePublication}=await import('/src/disk/web/torrent-remote.js');const {default:init,verify}=await import('/build/disk/pkg/slop86_disk.js');await init();
  const check=(v,m)=>{if(!v)throw Error(m);};let cancelled=0;
  const io={call:async op=>op==='read'?new Uint8Array([1,2,3]):null,notify:op=>{if(op==='cancel')cancelled++;}};
  const remote=new RemotePublication(io,{gateways:[],trackers:[]});remote.publication={disk:'aa'.repeat(20)};
  const inFlight=remote.read(0,3);remote.discovered({state:'conflict',fatal:true,error:{code:'PUBLICATION_CONFLICT',message:'Signed fork'}});
  for(const job of [inFlight,remote.read(0,3)]){try{await job;throw Error('Conflicted bytes escaped');}catch(error){check(error.code==='PUBLICATION_CONFLICT','Wrong read error');}}
  check(cancelled===1,'Source work not cancelled');await remote.close();
  const {WindowTorrents}=await import('/src/disk/web/torrent-window.js');
  let stores=0,reads=0,adds=0,hold=false,last;
  class Events {
   constructor(){this.events=new Map();}
   on(n,f){const list=this.events.get(n)||[];list.push(f);this.events.set(n,list);return this;}
   once(n,f){const one=(...a)=>{this.off(n,one);f(...a);};return this.on(n,one);}
   off(n,f){this.events.set(n,(this.events.get(n)||[]).filter(x=>x!==f));return this;}
   emit(n,...a){for(const f of [...(this.events.get(n)||[])])f(...a);}
  }
  class Store {
   constructor(){stores++;}
   get(_i,_o,callback){reads++;queueMicrotask(()=>callback(Object.assign(Error('Cache miss'),{code:'ENOENT'})));}
   close(callback){queueMicrotask(()=>callback?.());}
  }
  class Client extends Events {
   add(hash,options){
    adds++;check(options.deselect&&!options.skipVerify,'Catalog verification/selection weakened');
    const t=new Events();last=t;Object.assign(t,{infoHash:hash,metadata:Uint8Array.from(cat.metadata),pieces:[{}],bitfield:{buffer:new Uint8Array(1),get:()=>false},ready:false,destroyed:false,deselect(){},pause(){}});
    t.store=new options.store(16384,{torrent:t,length:cat.length});
    t.destroy=(_options,callback)=>{if(t.destroyed){callback?.();return;}t.destroyed=true;t.store.close(()=>{t.emit('close');callback?.();});};
    t.store.get(0,{},()=>{if(!t.destroyed){t.ready=true;t.emit('ready');}});
    if(!hold)queueMicrotask(()=>t.emit('metadata'));return t;
   }
   destroy(callback){this.destroyed=true;if(last&&!last.destroyed)last.destroy({},callback);else callback?.();}
  }
  const transport=()=>{const t=new WindowTorrents({sources:{gateways:[],trackers:['wss://fixture.test']},clientFactory:async()=>Client,store:Store});t.rescanCachedPieces=()=>{};return t;};
  let t=transport();await t.open({infoHash:cat.hash,kind:'catalog'});check(adds===1&&stores===1&&reads===1,'Discovery was not adopted or store gate failed');await t.close();
  stores=reads=adds=0;t=transport();
  try{await t.open({infoHash:'00'.repeat(20),kind:'catalog'});throw Error('Bad hash adopted');}catch(e){check(e.code==='INVALID_PUBLICATION','Wrong metadata rejection');}
  check(stores===0&&reads===0,'Unverified metadata reached persistent store');await t.close();
  hold=true;t=transport();const cancel=new AbortController(),opening=t.open({infoHash:cat.hash,kind:'catalog'},cancel.signal);
  while(!last||last.destroyed)await new Promise(r=>setTimeout(r,0));cancel.abort(Object.assign(Error('Cancelled'),{code:'CANCELLED'}));
  try{await opening;throw Error('Cancelled discovery succeeded');}catch(e){check(e.code==='CANCELLED','Wrong cancellation');}await t.close();check(stores===0&&reads===0,'Cancelled gate touched storage');
  const oldFetch=globalThis.fetch;let stream;
  globalThis.fetch=async()=>new Response(new ReadableStream({start(c){stream=c;}}),{headers:{'Content-Type':'text/event-stream'}});
  const frame=(event,data)=>new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const failedIO={call:async op=>{if(op==='create')throw Object.assign(Error('First snapshot has no source'),{code:'TRANSPORT_TIMEOUT'});return null;},notify:()=>{}};
  try{
   const opening=RemotePublication.open(failedIO,{owner:key,publicKey:key,sources:{gateways:[location.origin],trackers:[]},verifySignature:verify});
   while(!stream)await new Promise(r=>setTimeout(r,0));stream.enqueue(frame('record',a));
   setTimeout(()=>{stream.enqueue(frame('record',b));stream.enqueue(frame('done',{record:b,error:null}));stream.close();},10);
   try{await opening;throw Error('Expected source failure');}catch(error){check(error.code==='TRANSPORT_TIMEOUT'&&error.newerPublication===true,'Failed source lost newer signed candidate');}
   return {lateConflict:true,inFlightGuard:true,cachedGuard:true,workCancelled:true,newerCandidateRetry:true,catalogAdopted:true,metadataGate:true,catalogCancellation:true};
  }finally{globalThis.fetch=oldFetch;}
 },{key,a:record('aa'.repeat(20),'9007199254740994'),b:record('bb'.repeat(20),'9007199254740995'),cat:(()=>{const c=catalog([['disk.torrent',torrent(Buffer.alloc(10))]]);return {hash:c.hash,metadata:Array.from(c.metadata),length:c.bytes.length};})()});console.log(JSON.stringify({browser:name,...result}));
 }finally{await browser.close();}
}}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
