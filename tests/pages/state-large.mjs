import assert from "node:assert/strict";
import {mkdir,writeFile} from "node:fs/promises";
import {chromium,webkit} from "playwright";
import {serveSite} from "./server.mjs";
import {encodeState} from "../../src/disk/web/state-format.js";
import {build} from 'esbuild';

// Exercise the format in a real Worker. Crypto authentication has separate API
// coverage; this vault fixture isolates large emulator AND overlay Blob reads.
async function makeFixture() {
    const size=100*1024*1024+1;
    const state=new Uint8Array(size),overlay=new Uint8Array(size);
    state.fill(0x5a);overlay.fill(0xa5);
    for(let i=0;i<size;i+=4093) {state[i]=i%251;overlay[i]=i%239;}
    state[size-1]=17;overlay[size-1]=93;
    const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))).join(",");
    const expected=[await hash(state),await hash(overlay)];
    const vault={
        state_base:async()=>new Uint8Array([1,2,3]),
        state_overlay:()=>overlay.slice(),
        seal_state:(_context,plain)=>{const record=new Uint8Array(plain.length+62);record.set(plain,62);return record;},
    };
    // Build on Node so this tests browser decoding independently of browser
    // export/CompressionStream limits on large in-memory Blob inputs.
    const file=await encodeState(vault,{fixture:"large sections"},state.buffer,{check:()=>{},progress:()=>{}});
    await writeFile("build/state/large.my98state",new Uint8Array(await file.arrayBuffer()));
    return {size,expected,fileHash:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('')};
}
async function roundtrip(moduleURL,{size,expected,fileHash}) {
    const {decodeState}=await import(moduleURL);
    const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))).join(",");
    const file=await (await fetch(new URL("/build/state/large.my98state",moduleURL))).blob();
    const vault={state_base:async()=>new Uint8Array([1,2,3]),open_state:(_context,record)=>record.slice(62)};
    const noop=()=>{};
    let checks=0;
    const ok=(condition,label)=>{if(!condition)throw Error(label);checks++;};
    const verify=async()=>{
        const decoded=await decodeState(vault,file,{check:noop,progress:noop});
        ok(decoded.state.byteLength===size && decoded.overlay.length===size,"section lengths");
        ok(await hash(decoded.state)===expected[0],"all emulator bytes");
        ok(await hash(decoded.overlay)===expected[1],"all overlay bytes");
        ok(decoded.metadata.fixture==="large sections","metadata preserved");
        ok(decoded.stateSha256===fileHash,'incremental encrypted file fingerprint');
    };
    await verify();
    // Cancel/fail while the decompressor feeds the final state/overlay buffers.
    // These checks follow the public stream/progress contract, not Blob internals.
    for(const section of ["state","overlay"]) for(const kind of ["cancel","read-error"]) {
        let produced=0,triggered=false;
        const failure=Object.assign(new Error(kind),{code:kind==="cancel"?"CANCELLED":"READ_FAILED"});
        let caught;
        try {await decodeState(vault,file,{
            check:()=>{if(triggered)throw failure;},
            progress:(phase,bytes)=>{
                if(phase!=="decompress")return;produced=bytes;
                if(bytes>(section==="state"?65536:size+65536)) {
                    triggered=true;if(kind==="read-error")throw failure;
                }
            },
        });} catch(error) {caught=error;}
        ok(caught===failure,section+" "+kind+" propagated: "+caught?.message);
        ok(triggered && produced<2*size,section+" "+kind+" stops before completing sections: "+produced);
    }
    await verify();
    return {checks,stateBytes:size,overlayBytes:size,packedBytes:file.size};
}

const results=[];
await mkdir("build/state",{recursive:true});
await build({entryPoints:['src/disk/web/state-format.js'],bundle:true,format:'esm',platform:'browser',target:'es2022',outfile:'build/state/state-format.js'});
await writeFile("build/state/large.html","<!doctype html><title>Large state worker test</title>");
const fixture=await makeFixture();
const server=await serveSite({root:".",headers:true});
try {for(const [name,type] of Object.entries({chromium,webkit})) {
    const browser=await type.launch();
    try {
        const page=await browser.newPage();
        await page.goto(server.url+"build/state/large.html");
        const result=await page.evaluate(async ({source,fixture})=>{
            const moduleURL=new URL("/build/state/state-format.js",location.href).href;
            const url=URL.createObjectURL(new Blob([
                `(${source})(${JSON.stringify(moduleURL)},${JSON.stringify(fixture)}).then(result=>postMessage({result}),error=>postMessage({error:String(error.message)+"\\n"+String(error.stack||error)}));`,
            ],{type:"text/javascript"}));
            const worker=new Worker(url,{type:"module"});
            try {return await new Promise((resolve,reject)=>{
                worker.onmessage=({data})=>data.error?reject(Error(data.error)):resolve(data.result);
                worker.onerror=event=>reject(Error(event.message));
            });} finally {worker.terminate();URL.revokeObjectURL(url);}
        },{source:roundtrip.toString(),fixture});
        assert.equal(result.checks,18);
        results.push({name,...result});console.log(name,result);
    } finally {await browser.close();}
}} finally {await server.close();await writeFile("build/state/large-validation.json",JSON.stringify(results,null,2));}
