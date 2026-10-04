import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
import {createPublicKey,verify,randomBytes} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {serveSite,quietAudio} from './server.mjs';
import {diskFixture} from './fixture.mjs';
function challengeBytes(publicKey,challenge) {
    const expires=Buffer.alloc(8);expires.writeBigUInt64BE(BigInt(challenge.expires));
    return Buffer.concat([Buffer.from('my98/relay-challenge/v1\0'),...[publicKey,Buffer.from(challenge.url),Buffer.from(challenge.origin),Buffer.from(challenge.nonce,'hex'),expires].flatMap(b=>{const size=Buffer.alloc(4);size.writeUInt32BE(b.length);return [size,b];})]);
}
const fixture=await diskFixture({isolated:true}),results=[];
try {
 for(const [name,type] of Object.entries({chromium,webkit})) {
  // Keep HTTP mocks outside WebKit's unrouteable service-worker fetches.
  // Real service-worker/TLS discovery is verified separately against the pilot.
  const server=await serveSite({headers:true,relayDiscovery:true}),browser=await type.launch();
  try {
   const context=await browser.newContext();await context.addInitScript(quietAudio);
   await context.route('**/.well-known/my98-relay.json',route=>{
    const origin=new URL(route.request().url()).origin;
    return route.fulfill({contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},
        json:{version:1,relay:origin==='https://oregon.jlxip.net' ? {url:origin.replace('https:','wss:')+'/my98-relay/v1',protocol:'my98-relay.v1',authorization:'ed25519-allowlist'} : null}});
   });
   let deny=false,frames=0,signatures=0,lastSocket;
   await context.routeWebSocket('**/my98-relay/v1',socket=>{
    lastSocket=socket;let challenge,ready=false,publicKey;
    socket.onMessage(message=>{
     if(typeof message!=='string'){assert(ready);frames++;socket.send(message);return;}
     const m=JSON.parse(message);
     if(m.type==='hello') {
      if(deny){socket.close({code:1008,reason:'Authorization rejected'});return;}
      publicKey=Buffer.from(m.publicKey,'hex');
      challenge={type:'challenge',url:socket.url(),origin:new URL(server.url).origin,nonce:randomBytes(32).toString('hex'),expires:Math.floor(Date.now()/1000)+10};socket.send(JSON.stringify(challenge));
     } else {
      assert.equal(m.type,'authenticate');
      const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),publicKey]),format:'der',type:'spki'});
      assert(verify(null,challengeBytes(publicKey,challenge),key,Buffer.from(m.signature,'hex')));
      signatures++;ready=true;socket.send('{"type":"ready"}');
     }
    });
   });
   const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));page.on('dialog',d=>d.accept());
   await page.goto(server.url);await page.waitForFunction(()=>!document.body.inert);
   await page.evaluate(async gateway=>{
    const {Slop86Disk}=await import('./build/disk/web/client.js'),create=Slop86Disk.create,open=Slop86Disk.prototype.openRemote;
    Slop86Disk.create=async(...args)=>{const d=await create.apply(Slop86Disk,args);window.disk=d;return d;};
    Slop86Disk.prototype.openRemote=function(){return open.call(this,{gateway,servers:[{url:gateway,resolution:'gateway',discovery:false}],prefetch:{enabled:false}});};
    const {V86}=await import('./build/libv86.mjs'),run=V86.prototype.run;
    V86.prototype.run=function(){window.vm=this;return run.call(this);};
   },fixture.gateway);
   await page.locator('#disk-user').fill('disk fixtures');await page.locator('#disk-password').fill('public compatibility password');
   await page.locator('#disk-login button').click();
   await page.waitForFunction(()=>window.vm && document.querySelector('#relay-status').textContent==='Internet connected.',null,{timeout:60000}).catch(async error=>{
    console.log(name,await page.evaluate(()=>({status:document.querySelector('#relay-status').textContent,network:window.vm?.network_adapter?.status,url:window.vm?.network_adapter?.url})),errors);throw error;
   });
   await page.evaluate(()=>document.querySelector('#fullscreen').click());
   await page.waitForFunction(()=>!document.querySelector('#vm-view').classList.contains('expanded'));
   const key=await page.evaluate(async()=>Array.from(await disk.relayPublicKey()));assert.equal(key.length,32);
   const readKey=await page.evaluate(()=>disk.exportReadOnlyKey());
   assert.deepEqual(await page.evaluate(async({readKey,cid,gateway})=>{
    const owner=window.disk;
    const {Slop86Disk}=await import('./build/disk/web/client.js');const reader=await Slop86Disk.create();
    try {
     await reader.openReadOnly({readKey,cid,gateway,onlyLocalhost:true,prefetch:{enabled:false}});
     const denied=[];
     for(const op of [()=>reader.relayPublicKey(),()=>reader.signRelayChallenge({url:'wss://oregon.jlxip.net/my98-relay/v1',origin:location.origin,nonce:new Uint8Array(32),expires:Math.floor(Date.now()/1000)+10})]) {
      try{await op();denied.push(false);}catch(e){denied.push(e.code==='READ_ONLY');}
     }
     return denied;
    } finally {await reader.close();window.disk=owner;}
   },{readKey,cid:fixture.diskCid,gateway:fixture.gateway}),[true,true]);
   await page.evaluate(async()=>{window.originalVM=vm;await vm.stop();vm.v86.cpu.mem8[0x70000]=73;return disk.write(10000,new Uint8Array([74]));});
   lastSocket.close({code:1011,reason:'Temporary failure'});
   await page.waitForFunction(()=>document.querySelector('#relay-status').textContent==='Internet connected.');
   assert.deepEqual(await page.evaluate(async()=>[vm===originalVM,vm.v86.cpu.mem8[0x70000],(await disk.read(10000,1))[0]]),[true,73,74]);
   deny=true;lastSocket.close({code:1008,reason:'Revoked'});
   await page.waitForFunction(()=>document.querySelector('#relay-status').textContent.includes('rejected'));
   const attempts=signatures;await page.waitForTimeout(1200);assert.equal(signatures,attempts);
   deny=false;await page.locator('#relay-retry').click();
   await page.waitForFunction(()=>document.querySelector('#relay-status').textContent==='Internet connected.');
   await page.screenshot({path:'build/relay-pilot/'+name+'-connected.png',fullPage:true});
   // Closing the identity automatically closes its network without replacing the VM.
   await page.evaluate(()=>disk.close());
   assert.equal(await page.evaluate(()=>vm===originalVM),true);
   assert.equal(await page.evaluate(()=>vm.network_adapter.ready),false);
   assert.equal(await page.evaluate(async()=>{try{await disk.relayPublicKey();return false;}catch{return true;}}),true);
   assert.deepEqual(errors,[]);results.push({browser:name,signatures,reconnection:true,ramAndWrites:true,identityClose:true});
  } finally {await browser.close();await server.close();}
 }
 await writeFile('build/relay-pilot/browser-results.json',JSON.stringify(results,null,2));
 console.log(JSON.stringify(results));
} finally {await fixture.close();}
