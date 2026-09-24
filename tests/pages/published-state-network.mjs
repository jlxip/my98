import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {writeFile,mkdir} from 'node:fs/promises';
import {chromium,webkit} from 'playwright';
import {serveSite} from './server.mjs';
import {diskFixture} from './fixture.mjs';
const results=[];await mkdir('build/published-state',{recursive:true});
for(const [name,type] of Object.entries({chromium,webkit})) {
 const f=await diskFixture({isolated:true,car:true}),server=await serveSite({headers:true}),browser=await type.launch();
 try {
  const p=await browser.newPage();await p.goto(server.url);await p.waitForFunction(()=>!document.body.inert);
  const snapshot=await p.evaluate(async gateway=>{
   const {Slop86Disk}=await import('./build/disk/web/client.js');window.client=await Slop86Disk.create();
   await client.unlock('disk fixtures','public compatibility password','main');await client.openRemote({gateway,prefetch:{enabled:false},servers:[{url:gateway,resolution:'gateway',discovery:false}]});
   const readKey=await client.exportReadOnlyKey();await client.write(10000,new Uint8Array([42]));
   const bytes=new Uint8Array(5*1024*1024);for(let i=0;i<bytes.length;i+=65536)crypto.getRandomValues(bytes.subarray(i,i+65536));
   const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)));
   const result=await client.saveState(bytes.buffer,{version:1,compatibility:'network-fixture',running:false,config:{}});
   const chunks=[];for(let i=0;i<result.blob.size;i+=65536)chunks.push(String.fromCharCode(...new Uint8Array(await result.blob.slice(i,i+65536).arrayBuffer())));
   await client.close();return {encoded:btoa(chunks.join('')),readKey,hash};
  },f.gateway);
  const stateBytes=Buffer.from(snapshot.encoded,'base64');assert(stateBytes.length>5*1024*1024);
  const publication=await f.publishState(stateBytes);
  async function open() {await p.evaluate(async args=>{
   const {Slop86Disk}=await import('./build/disk/web/client.js');window.reader=await Slop86Disk.create();
   await reader.openReadOnly({...args,prefetch:{enabled:true}});
  },{cid:publication.publicationCid,readKey:snapshot.readKey,gateway:f.gateway});}
  await open();
  f.delays.set(publication.stateCid,10000);f.requests.length=0;
  await p.evaluate(()=>{window.pending=reader.prepareState({published:true}).then(()=>({unexpected:true}),e=>({code:e.code}));});
  const start=Date.now();while(!f.requests.includes('/ipfs/'+publication.stateCid)){
   if(Date.now()-start>10000)throw Error('state download did not start');await new Promise(r=>setTimeout(r,20));
  }
  assert.equal(await p.evaluate(async()=>{await reader.cancel();return (await pending).code;}),'CANCELLED');
  assert.equal(await p.evaluate(async()=>(await reader.read(10000,1))[0]),0);
  f.delays.clear();
  const hash=await p.evaluate(async()=>{
   const prepared=await reader.prepareState({published:true});const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',prepared.state)));
   await reader.commitState(prepared.token);if((await reader.read(10000,1))[0]!==42)throw Error('overlay');const transport=(await reader.readStats()).remote.stateTransport;if(transport.mode!=='car'||transport.fallback||transport.lanes!==4)throw Error('CAR not used');await reader.close();return hash;
  });assert.deepEqual(hash,snapshot.hash);
  // Cancel in-flight CAR negotiation, then retry on the same client.
  await open();f.carBehavior.delay=10000;f.carRequests.length=0;
  await p.evaluate(()=>{window.pending=reader.prepareState({published:true}).then(()=>({unexpected:true}),e=>({code:e.code}));});
  const carStart=Date.now();while(!f.carRequests.length){if(Date.now()-carStart>10000)throw Error('CAR did not start');await new Promise(r=>setTimeout(r,20));}
  assert.equal(await p.evaluate(async()=>{await reader.cancel();return (await pending).code;}),'CANCELLED');f.carBehavior.delay=0;
  const retryHash=await p.evaluate(async()=>{const state=await reader.prepareState({published:true});const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',state.state)));await reader.close();return hash;});assert.deepEqual(retryHash,snapshot.hash);
  // Corrupt only CAR in transit: verified raw fallback feeds the same decoder.
  await open();f.carBehavior.corrupt=true;
  const fallback=await p.evaluate(async()=>{const state=await reader.prepareState({published:true});const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',state.state)));await reader.commitState(state.token);const overlay=(await reader.read(10000,1))[0],transport=(await reader.readStats()).remote.stateTransport;await reader.close();return {hash,overlay,transport};});
  assert.deepEqual(fallback.hash,snapshot.hash);assert.equal(fallback.overlay,42);assert.equal(fallback.transport.fallback,true);f.carBehavior.corrupt=false;
  // Same CID, altered bytes: the block verifier must fail before decrypting.
  const block=f.blocks.get(publication.stateCid),corrupt=Buffer.from(block);corrupt[0]^=1;f.blocks.set(publication.stateCid,corrupt);
  await open();
  const rejected=await p.evaluate(async()=>{try{await reader.prepareState({published:true});return false;}catch(e){return /CID|provider|gateway/i.test(e.message);}finally{await reader.close();}});
  assert(rejected);f.blocks.set(publication.stateCid,block);
  // Valid CID containing corrupted encrypted data: authentication must fail too.
  const damaged=Buffer.from(stateBytes);damaged[damaged.length-1]^=1;const damagedPublication=await f.publishState(damaged);
  const authentication=await p.evaluate(async args=>{
   const {Slop86Disk}=await import('./build/disk/web/client.js');const d=await Slop86Disk.create();
   try{await d.openReadOnly(args);await d.prepareState({published:true});return false;}catch(e){return /authentication/i.test(e.message);}finally{await d.close();}
  },{cid:damagedPublication.publicationCid,readKey:snapshot.readKey,gateway:f.gateway,prefetch:{enabled:false}});assert(authentication);
  // The wrapper CLI keeps its old disk field and exposes the publication root.
  await f.publishState(stateBytes);
  if(name==='chromium') {
   await new Promise((resolve,reject)=>{
    const child=spawn('python3',['scripts/read-only-key-test.py',f.gateway,'success-publication'],{stdio:['ignore','pipe','pipe']});let output='';
    child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
    child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(output)));
   });
  }
  results.push({name,multiBlockBytes:stateBytes.length,cancellationAndRetry:true,hashVerified:true,car:true,carCancelRetry:true,carCorruptionFallback:true,cidCorruptionRejected:true,authenticationRejected:true,cli:name==='chromium'});console.log(results.at(-1));
 }finally{await browser.close();await server.close();await f.close();}
}
await writeFile('build/published-state/network-validation.json',JSON.stringify(results,null,2));
