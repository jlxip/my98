import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium,firefox,webkit} from 'playwright';
import {serveSite} from './pages/server.mjs';
import {browserOptions} from './browser-options.mjs';
const server=await serveSite({headers:true});
try{for(const [name,engine] of Object.entries({chromium,firefox,webkit})){
 const browser=await engine.launch(browserOptions(name));
 try{
  const page=await browser.newPage();await page.route('**/src/disk/web/**',async route=>{await route.fulfill({body:await readFile(resolve('.'+new URL(route.request().url()).pathname)),contentType:'text/javascript'});});
  await page.goto(server.url);await page.waitForFunction(()=>!document.body.inert);
  const checks=await page.evaluate(async()=>{
   const {PublicationJob,reservePublication}=await import('/src/disk/web/publication-publisher.js');
   const {hex,unhex,PUBLICATION_SALT}=await import('/src/disk/web/torrent-protocol.js');
   const {default:init,Vault,verify,publication_piece_hash}=await import('/build/disk/pkg/slop86_disk.js');await init();
   const signer=new Vault('recovery fixture',new TextEncoder().encode('public password'),'main');
   const publicKey=hex(new Uint8Array(JSON.parse(signer.identity()).publicKey)),sign=(hash,seq)=>JSON.parse(signer.sign_publication(hash,seq));
   const checks=[],check=(v,m)=>{if(!v)throw Error(m);checks.push(m);};
   const sources={gateways:[location.origin],trackers:['ws://127.0.0.1:1']},calls=[],io={async call(op,args,signal){if(signal?.aborted)throw signal.reason;calls.push(op);}};
   const target=hex(publication_piece_hash(new Uint8Array([...unhex(publicKey,32),...new TextEncoder().encode(PUBLICATION_SALT)])));
   const originalFetch=globalThis.fetch;let stored=null,puts=[],lost=true;
   const job=new PublicationJob({io,sources,publicKey,verify,sign});job.target=target;
   globalThis.fetch=async(url,options={})=>{
    if(options.method!=='PUT')return stored?new Response(JSON.stringify(stored),{headers:{'Content-Type':'application/json'}}):new Response('{}',{status:404});
    puts.push(JSON.parse(options.body));stored={...JSON.parse(options.body),key:publicKey,salt:hex(new TextEncoder().encode(PUBLICATION_SALT))};
    if(lost){lost=false;throw TypeError('Response lost after accepting write');}
    return new Response(JSON.stringify({target,acknowledged_nodes:2}));
   };
   try{
    const snapshot={infoHash:'11'.repeat(20),disk:new Blob(['ciphertext']),diskMetadata:new Uint8Array([1]),catalog:new Blob(['catalog']),catalogMetadata:new Uint8Array([2])};
    const first=await job.start(snapshot,new AbortController().signal);
    check(first.state==='unconfirmed'&&job.active&&!calls.includes('close'),'lost response preserves the active seed');
    const result=await job.announce();check(result.state==='seeding'&&puts.length===2,'retry reconciles and obtains acknowledgement');
    check(JSON.stringify(puts[0])===JSON.stringify(puts[1]),'retry reuses exact signature and sequence');
    stored=sign(unhex('22'.repeat(20),20),(BigInt(job.record.sequence)+1n).toString());
    const conflict=await job.announce();check(conflict.error.code==='PUBLICATION_CONFLICT'&&puts.length===2&&job.active,'newer publication prevents reannouncement and retains seed');
    await job.stop();check(calls.at(-1)==='close'&&!job.active,'explicit stop releases transport');
    // Automatic handover retains the old seed across a lost response, then closes only its own session.
    stored=null;lost=false;
    const old=new PublicationJob({io,sources,publicKey,verify,sign});old.target=target;
    await old.start({...snapshot,infoHash:'44'.repeat(20)},new AbortController().signal);
    stored=old.record;const baseline=stored;
    const replacement=new PublicationJob({io,sources,publicKey,verify,sign});replacement.target=target;
    lost=true;
    const uncertain=await replacement.start({...snapshot,infoHash:'55'.repeat(20)},new AbortController().signal,{previous:old,expected:baseline});
    check(uncertain.state==='unconfirmed'&&old.active&&old.suspended&&replacement.active,'uncertain handover retains both seeds and suspends old renewal');
    stored=replacement.record;
    await replacement.announce();
    check(replacement.state==='seeding'&&!old.active&&!replacement.previous,'acknowledged handover releases old transport');
    const aborted=new PublicationJob({sources,publicKey,verify,sign,io:{async call(op){if(op==='seed')throw Object.assign(Error('Seed failure'),{code:'TRANSPORT_ERROR'});}}});
    try{await aborted.start(snapshot,new AbortController().signal,{previous:replacement,expected:replacement.record});throw Error('Seed failure accepted');}
    catch(e){check(e.code==='TRANSPORT_ERROR'&&replacement.active&&!replacement.suspended,'pre-send failure preserves previous publication');}
    const baseline2=replacement.record;stored=baseline2;const putsBefore=puts.length;
    const racing=new PublicationJob({sources,publicKey,verify,sign,io:{async call(op,args){calls.push(op);if(op==='seed')stored=sign(unhex('66'.repeat(20),20),(BigInt(baseline2.sequence)+1n).toString());}}});
    try{await racing.start({...snapshot,infoHash:'77'.repeat(20)},new AbortController().signal,{previous:replacement,expected:baseline2});throw Error('Concurrent update accepted');}
    catch(e){check(e.code==='PUBLICATION_CONFLICT'&&puts.length===putsBefore&&replacement.active&&!replacement.suspended,'a version change during preparation blocks the send and preserves previous seed');}
    await replacement.stop();
    const put=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(...args){if(this.name==='publishing')throw new DOMException('Quota full','QuotaExceededError');return put.apply(this,args);};
    try{await reservePublication({publicKey,infoHash:'33'.repeat(20),known:null,verify,sign});throw Error('Quota accepted');}catch(e){check(e.code==='STORAGE_FULL','quota failure blocks publication before send');}finally{IDBObjectStore.prototype.put=put;}
    const controller=new AbortController(),cancelled=new PublicationJob({sources,publicKey,verify,sign,io:{async call(op){if(op==='seed'){controller.abort(Object.assign(Error('Cancelled'),{code:'CANCELLED'}));throw controller.signal.reason;}calls.push(op);}}});
    try{await cancelled.start(snapshot,controller.signal);throw Error('Cancelled seed accepted');}catch(e){check(e.code==='CANCELLED'&&!cancelled.active,'cancellation before announcement releases candidate');}
   }finally{await job.stop();globalThis.fetch=originalFetch;signer.free();}
   return checks;
  });
  console.log(name+': '+checks.length+' recovery checks PASS');assert(checks.length>=7);
 }finally{await browser.close();}
}}finally{await server.close();}
