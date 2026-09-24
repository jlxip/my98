import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {encodeState,decodeState} from '../web/state-format.js';
const noop=()=>{},digest=(...parts)=>createHash('sha256').update(Buffer.concat(parts)).digest();
const overlay=new Uint8Array(randomBytes(9001)),state=new Uint8Array(randomBytes(3*1024*1024+13));
const vault={state_base:async()=>new Uint8Array([1,2,3]),state_overlay:()=>overlay.slice(),
 seal_state:(context,plain)=>{const b=new Uint8Array(plain.length+62);b.set(digest(context,plain));b.set(plain,62);return b;},
 open_state:(context,sealed)=>{assert.deepEqual(sealed.slice(0,32),new Uint8Array(digest(context,sealed.slice(62))),'authentication');return sealed.slice(62);},
};
const blob=await encodeState(vault,{version:1,fixture:true},state.buffer.slice(state.byteOffset,state.byteOffset+state.length),{check:noop,progress:noop});
const bytes=new Uint8Array(await blob.arrayBuffer());
const hash=createHash('sha256').update(bytes).digest('hex');
function source(data=bytes,{stride=731,delay=0,onRead=noop}={}) {
 let offset=0,cancelled=false;
 return {size:data.length,get cancelled(){return cancelled;},stream:new ReadableStream({
 async pull(c) {if(delay)await new Promise(r=>setTimeout(r,delay));if(offset===data.length){c.close();return;}
 const end=Math.min(data.length,offset+stride);c.enqueue(data.slice(offset,end));offset=end;onRead(offset);},
 cancel(){cancelled=true;},
 },{highWaterMark:0})};
}
async function verify(input,options={}) {
 const decoded=await decodeState(vault,input,{check:noop,progress:noop,...options});
 assert.deepEqual(new Uint8Array(decoded.state),new Uint8Array(state));assert.deepEqual(decoded.overlay,new Uint8Array(overlay));
 assert.equal(decoded.metadata.fixture,true);assert.equal(decoded.stateSha256,hash);
}
test('Blob and fragmented streams preserve all sections and encrypted-file fingerprint',async()=>{
 await verify(blob);await verify(source());await verify(source(bytes,{stride:1<<20}));
});
test('decryption and decompression overlap network delivery',async()=>{
 let received=0,overlap=false,authenticated=false;
 await verify(source(bytes,{stride:65536,delay:1,onRead:n=>received=n}),{progress:phase=>{
 if(phase==='decrypt-state'&&received<bytes.length)authenticated=true;
 if(phase==='decompress'&&received<bytes.length)overlap=true;
 }});assert(authenticated);assert(overlap);
});
test('truncation, extra bytes, wrong size and authentication errors reject and cancel',async()=>{
 const bad=bytes.slice();bad[1000]^=1;
 const cases=[source(bytes.slice(0,-1)),source(new Uint8Array([...bytes,1])),source(bad),{...source(),size:1}];
 for(const input of cases)await assert.rejects(decodeState(vault,input,{check:noop,progress:noop}));
 // Unknown-length transport must also validate EOF, not just its declared size.
 for(const b of [bytes.slice(0,-1),new Uint8Array([...bytes,1])]) {
 const input=source(b);delete input.size;await assert.rejects(decodeState(vault,input,{check:noop,progress:noop}));
 }
 await verify(blob);
});
test('cancellation interrupts a blocked source and every processing phase; later load succeeds',async()=>{
 for(const phase of ['decrypt-state','decompress']) {
 const c=new AbortController(),input=source(bytes,{stride:65536});
 await assert.rejects(decodeState(vault,input,{signal:c.signal,check:()=>{if(c.signal.aborted)throw Error('cancelled');},progress:p=>{if(p===phase)c.abort();}}));
 assert(input.cancelled);
 }
 const c=new AbortController();let cancelled=false;
 const pending=decodeState(vault,{stream:new ReadableStream({cancel(){cancelled=true;}})},{signal:c.signal,check:()=>{if(c.signal.aborted)throw Error('cancelled');},progress:noop});
 setTimeout(()=>c.abort(),20);await assert.rejects(pending);assert(cancelled);await verify(blob);
});
test('invalid gzip, metadata and inflated limits are rejected',async()=>{
 const headerLength=new DataView(bytes.buffer).getUint32(8,true),header=bytes.slice(12,12+headerLength);
 const broken=bytes.slice(),recordStart=12+headerLength,plain=broken.slice(recordStart+62,recordStart+62+1024*1024);
 plain[0]=0;const ctx=new Uint8Array(header.length+4);ctx.set(header);
 broken.set(vault.seal_state(ctx,plain),recordStart);
 await assert.rejects(decodeState(vault,new Blob([broken]),{check:noop,progress:noop}));
 const large=bytes.slice();const text=new TextDecoder().decode(header).replace('"raw":','"raw":9');
 assert(text.length===header.length+1); // Rebuild the prefix rather than corrupt offsets accidentally.
 const h=new TextEncoder().encode(text),prefix=bytes.slice(0,12);new DataView(prefix.buffer).setUint32(8,h.length,true);
 await assert.rejects(decodeState(vault,new Blob([prefix,h,large.slice(recordStart)]),{check:noop,progress:noop}));
});
