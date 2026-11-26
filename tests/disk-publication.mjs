/** Worker export invariants and atomic publication sequences; no external network. */
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium,firefox,webkit} from 'playwright';
import {browserOptions} from './browser-options.mjs';
import {serveSite} from './pages/server.mjs';
const output='build/pages-tests/publication';await mkdir(output,{recursive:true});
const server=await serveSite({headers:true});
try{for(const [name,engine] of Object.entries({chromium,firefox,webkit}).filter(([name])=>!process.env.MY98_PUBLISH_BROWSERS||process.env.MY98_PUBLISH_BROWSERS.split(',').includes(name))){
 const browser=await engine.launch(browserOptions(name));
 try{
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.route('**/src/disk/web/**',async route=>{const path=new URL(route.request().url()).pathname;await route.fulfill({body:await readFile(resolve('.'+path)),contentType:'text/javascript'});});
  await page.goto(server.url);await page.waitForFunction(()=>!document.body.inert);
  const checks=await page.evaluate(async()=>{
   const {Slop86Disk}=await import('/build/disk/web/client.js');
   const {reservePublication}=await import('/src/disk/web/publication-publisher.js');
   const {openTorrentDatabase}=await import('/src/disk/web/torrent-store.js');
   const {default:init,Vault,verify}=await import('/build/disk/pkg/slop86_disk.js');await init();
   const checks=[],check=(b,text)=>{if(!b)throw Error(text);checks.push(text);};
   const reject=async(work,code)=>{try{await work;throw Error('Unexpected success');}catch(e){check(e.code===code,'reject '+code+': '+e.message);}};
   const events=[];let cancelAt;
   const c=await Slop86Disk.create({onProgress:p=>{events.push(p);if(cancelAt===p.phase&&(p.phase==='encrypt'||p.completed===p.total))c.cancel();}}),credentials=['publication fixtures','public test password','main'];
   const progress=(phase,total)=>{
    const values=events.filter(p=>p.phase===phase);
    check(values[0]?.completed===0&&values.at(-1)?.completed===total,phase+' starts and completes');
    check(values.every((p,i)=>p.total===total&&p.completed>=0&&p.completed<=total&&(!i||p.completed>=values[i-1].completed)),phase+' exact bounded progress');
   };
   try{
    await c.unlock(...credentials);const bytes=new Uint8Array(65536+512);bytes[0]=12;bytes[510]=85;bytes[511]=170;
    const original=(await c.createFromImage(new Blob([bytes]))).download.blob;progress("encrypt",bytes.length);events.length=0;
    await c.write(10,new Uint8Array([99]));const before=await c.describe();
    const raw=(await c.exportDisk('raw')).blob;
    check(new Uint8Array(await raw.arrayBuffer())[10]===99,'raw export includes overlay');
    const encrypted=(await c.exportDisk()).blob;progress('encrypt',bytes.length);events.length=0;
    const reader=await Slop86Disk.create();await reader.unlock(...credentials);await reader.open(encrypted);
    check((await reader.read(10,1))[0]===99,'encrypted snapshot authenticates and includes overlay');await reader.close();
    check(JSON.stringify(await c.describe())===JSON.stringify(before),'exports preserve original disk, overlay and revision');
    const capability=await c.exportReadOnlyKey(),ro=await Slop86Disk.create();
    await ro.openReadOnly({file:original,readKey:capability});await ro.write(12,new Uint8Array([77]));
    await reject(ro.publishUpdate({action:'remove-state',sources:{gateways:[location.origin],trackers:['ws://127.0.0.1:1']}}),'READ_ONLY');
    await reject(c.publishUpdate({action:'state',file:new Blob(['not a state']),sources:{gateways:[location.origin],trackers:['ws://127.0.0.1:1']}}),'INVALID_PUBLICATION');
    check(new Uint8Array(await (await ro.exportDisk('raw')).blob.arrayBuffer())[12]===77,'read-only raw includes session writes');
    const a=new Uint8Array(await (await ro.exportDisk()).blob.arrayBuffer()),b=new Uint8Array(await original.arrayBuffer());
    check(a.length===b.length&&a.every((v,i)=>v===b[i]),'read-only encrypted export is byte-identical original');await ro.close();
    const foreign=await Slop86Disk.create();await foreign.unlock('other','public test password','main');const wrong=(await foreign.createFromImage(new Blob([bytes]))).download.blob;await foreign.close();
    const sources={gateways:[location.origin],trackers:['ws://127.0.0.1:1']};
    cancelAt='encrypt';await reject(c.publishDisk({kind:'raw',file:new Blob([bytes]),sources}),'CANCELLED');
    check(!events.some(p=>p.phase==='encrypt'&&p.completed===p.total),'cancelled candidate never completes');events.length=0;
    cancelAt='hash';await reject(c.publishDisk({kind:'raw',file:new Blob([bytes]),sources}),'CANCELLED');
    progress('encrypt',bytes.length);progress('hash',original.size);events.length=0;cancelAt=undefined;
    check(JSON.stringify(await c.describe())===JSON.stringify(before),'cancelled raw publication preserves current disk');
    await reject(c.publishDisk({format:'raw',sources}),'INVALID_PUBLICATION');
    await reject(c.publishDisk({kind:'encrypted',file:wrong,sources}),'AUTHENTICATION_FAILED');
    const damaged=new Uint8Array(await original.arrayBuffer());damaged[damaged.length-1]^=1;
    await reject(c.publishDisk({kind:'encrypted',file:new Blob([damaged]),sources}),'CORRUPTION');
    check(JSON.stringify(await c.describe())===JSON.stringify(before),'failed candidates preserve current disk');
    const signer=new Vault('publication fixtures',new TextEncoder().encode('public test password'),'main');
    const key=JSON.parse(signer.identity()).publicKey.map(v=>v.toString(16).padStart(2,'0')).join('');
    const sign=(hash,seq)=>JSON.parse(signer.sign_publication(hash,seq));
    const jobs=await Promise.all(Array.from({length:6},(_,i)=>reservePublication({publicKey:key,infoHash:(i+1).toString(16).padStart(40,'0'),known:null,verify,sign,now:1000})));
    check(new Set(jobs.map(v=>v.sequence)).size===6,'concurrent publishers reserve distinct durable sequences');
    check(jobs.every(v=>BigInt(v.sequence)>=1000n),'sequence lower bound');
    const db=await openTorrentDatabase();const row=await new Promise((r,j)=>{const q=db.transaction(['publishing']).objectStore('publishing').get(key);q.onsuccess=()=>r(q.result);q.onerror=j;});
    const stored=JSON.stringify(row);check(!stored.includes('password')&&!stored.includes('private')&&!stored.includes('blob'),'journal contains public signed metadata only');db.close();signer.free();
   }finally{await c.close();}
   return checks;
  });
  assert.deepEqual(errors,[]);console.log(name+': '+checks.length+' publication checks PASS');
 }finally{await browser.close();}
}}finally{await server.close();}
