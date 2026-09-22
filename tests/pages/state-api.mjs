import assert from "node:assert/strict";
import {readFile,writeFile,mkdir} from "node:fs/promises";
import {chromium,webkit} from "playwright";
import {serveSite} from "./server.mjs";
import {diskFixture} from "./fixture.mjs";
import {CID} from "multiformats/cid";
import {sha256} from "multiformats/hashes/sha2";
const f=await diskFixture(),cid=CID.createV1(0x55,await sha256.digest(await readFile(f.file))).toString();
const results=[];await mkdir("build/state",{recursive:true});
try {for(const [name,type] of Object.entries({chromium,webkit})) {
 const server=await serveSite({headers:true}),browser=await type.launch();
 try {
  const page=await browser.newPage(),errors=[];page.on("pageerror",e=>errors.push(String(e)));
  await page.goto(server.url);await page.waitForFunction(()=>!document.body.inert);
  const result=await page.evaluate(async({gateway,cid})=>{
   const {Slop86Disk,DiskBuffer}=await import("./build/disk/web/client.js");
   let checks=0;const ok=(v,m)=>{if(!v)throw Error(m);checks++;};
   const fails=async(work,pattern)=>{try{await work();}catch(e){ok(pattern.test(e.message+e.code),String(e));return;}throw Error("Expected rejection");};
   const owner=await Slop86Disk.create(),reader=await Slop86Disk.create(),other=await Slop86Disk.create();
   try {
    await owner.unlock("disk fixtures","public compatibility password","main");
    const info=await owner.openRemote({gateway,servers:[{url:gateway,resolution:"gateway",discovery:false}],prefetch:{enabled:false}});const readKey=await owner.exportReadOnlyKey();
    await owner.write(10000,new Uint8Array([42]));
    const random=new Uint8Array(3*1024*1024);for(let i=0;i<random.length;i+=65536)crypto.getRandomValues(random.subarray(i,i+65536));
    const expected=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",random)));
    const snapshot=await owner.saveState(random.buffer,{version:1,compatibility:"fixture",config:{},running:false});
    ok(snapshot.size>3*1024*1024,"multiple encrypted records");
    await owner.write(10000,new Uint8Array([99]));
    const url=URL.createObjectURL(snapshot.blob);
    let state=await owner.prepareState(url);URL.revokeObjectURL(url);
    ok(JSON.stringify(Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",state.state))))===JSON.stringify(expected),"URL state exact");
    ok(state.metadata.baseCid===info.remote.cid,"immutable base CID");
    let view=owner.stateDisk(state.token);ok((await view.read(10000,1))[0]===42,"candidate overlay");
    ok((await owner.read(10000,1))[0]===99,"original preserved before commit");
    await owner.write(10000,new Uint8Array([98]));
    await fails(()=>owner.commitState(state.token),/changed/);await owner.discardState(state.token);
    state=await owner.prepareState(snapshot.blob);await owner.commitState(state.token);ok((await owner.read(10000,1))[0]===42,"replace original writes");
    await reader.openReadOnly({cid,readKey,gateway,prefetch:{enabled:false}});
    state=await reader.prepareState(snapshot.blob);await reader.commitState(state.token);
    ok((await reader.read(10000,1))[0]===42,"read-only restore");
    await reader.write(10000,new Uint8Array([43]));
    await fails(()=>reader.saveState(new ArrayBuffer(8),{}),/READ_ONLY/);
    await fails(()=>reader.save(),/READ_ONLY/);
    await other.unlock("other state fixture","public password","main");await other.createEmpty(512*1024);
    await fails(()=>other.prepareState(snapshot.blob),/different base/);
    const bytes=new Uint8Array(await snapshot.blob.arrayBuffer());
    const header=12+new DataView(bytes.buffer).getUint32(8,true),record=1048576+62;
    const swapped=bytes.slice();swapped.set(bytes.subarray(header+record,header+2*record),header);swapped.set(bytes.subarray(header,header+record),header+record);
    await fails(()=>owner.prepareState(new Blob([swapped])),/authentication/);
    await fails(()=>owner.prepareState(snapshot.blob.slice(0,snapshot.size-1)),/Truncated/);
    await fails(()=>owner.prepareState(new Blob([snapshot.blob,new Uint8Array([0])])),/trailing/);
    const aborted=owner.prepareState(snapshot.blob);setTimeout(()=>owner.cancel(),5);
    await fails(()=>aborted,/CANCELLED/);ok((await owner.read(10000,1))[0]===42,"cancel preserves disk");
    // A pending write callback must finish before the barrier completes.
    const order=[],adapter=new DiskBuffer({write:async()=>{await new Promise(r=>setTimeout(r,20));order.push("write");}},512);
    adapter.set(0,new Uint8Array([1]),()=>order.push("callback"));await adapter.drain();order.push("drained");
    ok(order.join(",")==="write,callback,drained","drain order");
    return {checks,bytes:snapshot.size};
   } finally {await owner.close();await reader.close();await other.close();}
  },{gateway:f.gateway,cid});
  assert.deepEqual(errors,[]);results.push({name,...result});console.log(name,result);
 } finally {await browser.close();await server.close();}
}} finally {await f.close();await writeFile("build/state/api-validation.json",JSON.stringify(results,null,2));}
