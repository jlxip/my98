import {sha256} from '@noble/hashes/sha2.js';
// Encrypted, bounded, independently authenticated records. No disk keys leave WASM.
const MAGIC = new TextEncoder().encode("MY98STAT");
const CHUNK = 1024 * 1024, LIMIT = 1024 * 1024 * 1024;
const enc = new TextEncoder(), dec = new TextDecoder("utf-8", {fatal:true});
const invalid = message => Object.assign(new Error(message), {code:"INVALID_STATE"});
const u32 = n => {const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,n,true);return b;};
const number = b => new DataView(b.buffer,b.byteOffset,b.byteLength).getUint32(0,true);
const context = (header,index) => {const a=new Uint8Array(header.length+4);a.set(header);a.set(u32(index),header.length);return a;};
async function collect(stream, max, check, progress) {
    const reader=stream.getReader(), parts=[];let size=0;
    try {for(;;) {check();const {done,value}=await reader.read();check();if(done)break;
        size+=value.length;if(size>max)throw invalid("State exceeds the supported size");
        parts.push(new Blob([value]));progress?.(size);
    }} catch(error) {await reader.cancel().catch(()=>{});throw error;}
    finally {reader.releaseLock();}
    return new Blob(parts);
}
// Only the current input chunk is retained. Reads may cross arbitrary transport
// boundaries, including the header and encrypted record authentication tags.
class StateReader {
    constructor(stream, max, check, progress) {
        this.reader=stream.getReader();this.max=max;this.check=check;this.progress=progress;
        this.chunk=new Uint8Array(0);this.offset=0;this.received=0;this.copied=0;
    }
    async available() {
        this.check();
        while(this.offset===this.chunk.length) {
            const {done,value}=await this.reader.read();this.check();
            if(done)return false;
            if(!(value instanceof Uint8Array))throw invalid("Invalid state stream");
            this.received+=value.length;
            if(this.received>this.max)throw invalid("State exceeds its declared size");
            this.chunk=value;this.offset=0;this.progress?.(this.received);
        }
        return true;
    }
    async into(bytes) {
        for(let offset=0;offset<bytes.length;) {
            if(!await this.available())throw invalid("Truncated state");
            const count=Math.min(bytes.length-offset,this.chunk.length-this.offset);
            bytes.set(this.chunk.subarray(this.offset,this.offset+count),offset);
            this.offset+=count;offset+=count;this.copied+=count;
            if(this.copied>=8*CHUNK) {this.copied=0;await new Promise(r=>setTimeout(r,0));this.check();}
        }
        return bytes;
    }
    read(size) {this.check();return this.into(new Uint8Array(size));}
    async end() {if(await this.available())throw invalid("Trailing state bytes");}
    async close(reason) {await this.reader.cancel(reason).catch(()=>{});}
}
export async function encodeState(vault, metadata, state, {check,progress}) {
    if(!(state instanceof ArrayBuffer) || !state.byteLength || state.byteLength>LIMIT)throw invalid("Invalid machine state");
    const overlay=vault.state_overlay();
    let raw;
    try {
        const meta=enc.encode(JSON.stringify({...metadata,stateLength:state.byteLength,overlayLength:overlay.length}));
        if(meta.length>65536)throw invalid("State metadata exceeds the supported size");
        raw=new Blob([u32(meta.length),meta,state,overlay]);
    } finally {overlay.fill(0);}
    if(raw.size>LIMIT)throw invalid("State exceeds 1 GiB uncompressed");
    check();
    const compressed=await collect(raw.stream().pipeThrough(new CompressionStream("gzip")),LIMIT,check,n=>progress("compress",n,0));
    const base=await vault.state_base();check();
    const header=enc.encode(JSON.stringify({version:1,base:Array.from(base),nonce:Array.from(crypto.getRandomValues(new Uint8Array(16))),raw:raw.size,packed:compressed.size}));
    const parts=[MAGIC,u32(header.length),header];
    for(let offset=0,index=0;offset<compressed.size;offset+=CHUNK,index++) {
        check();const plain=new Uint8Array(await compressed.slice(offset,offset+CHUNK).arrayBuffer());
        try {parts.push(new Blob([vault.seal_state(context(header,index),plain)]));}finally {plain.fill(0);}
        progress("encrypt-state",Math.min(offset+CHUNK,compressed.size),compressed.size);
        await new Promise(r=>setTimeout(r,0));check();
    }
    return new Blob(parts,{type:"application/octet-stream"});
}
export async function decodeState(vault, input, {check,progress,signal}) {
    check();
    let file=input;
    if(typeof input==="string") {
        const response=await fetch(input,{signal,credentials:"omit"});
        if(!response.ok||!response.body)throw invalid("Could not download state ("+response.status+")");
        file={stream:response.body};
    }
    if(file instanceof Blob)file={size:file.size,stream:file.stream()};
    if(!file?.stream?.getReader || (file.size!==undefined && (!Number.isSafeInteger(file.size)||file.size<12||file.size>LIMIT+65536))) {
        await file?.stream?.cancel?.().catch(()=>{});throw invalid("Invalid state file size");
    }
    const source=new StateReader(file.stream,LIMIT+65536,check,typeof input==='string'?n=>progress('download-state',n,file.size||0):undefined);
    let raw,state,overlay,complete=false;
    const abort=()=>{void source.close();void raw?.close();};
    signal?.addEventListener('abort',abort,{once:true});
    try {
    check();
    const prefix=await source.read(12);check();
    if(!MAGIC.every((n,i)=>prefix[i]===n))throw invalid("Unsupported state format");
    const length=number(prefix.subarray(8));
    if(length<1||length>4096)throw invalid("Invalid state header");
    const header=await source.read(length);
    const hash=sha256.create().update(prefix).update(header);
    const h=JSON.parse(dec.decode(header));
    if(h.version!==1||!Number.isSafeInteger(h.raw)||h.raw<4||h.raw>LIMIT||!Number.isSafeInteger(h.packed)||h.packed<1||h.packed>LIMIT)throw invalid("Unsupported state size or version");
    const base=await vault.state_base();check();
    if(!Array.isArray(h.base)||h.base.length!==base.length||!base.every((v,i)=>v===h.base[i]))throw invalid("State belongs to a different base disk");
    const records=Math.ceil(h.packed/CHUNK);
    const expected=12+length+h.packed+records*62;
    if(expected>LIMIT+65536 || (file.size!==undefined && file.size!==expected))throw invalid("Truncated state or trailing bytes");
    source.max=expected;
    let index=0,offset=12+length,pending,position=0;
    const discard=()=>{pending?.fill(0);pending=undefined;position=0;};
    const compressed=new ReadableStream({
        async pull(controller) {
            try {
                check();
                if(!pending) {
                    if(index===records) {await source.end();controller.close();return;}
                    const size=Math.min(CHUNK,h.packed-index*CHUNK)+62;
                    const sealed=await source.read(size);hash.update(sealed);
                    const plain=vault.open_state(context(header,index++),sealed);
                    try {
                        if(plain.length!==size-62)throw invalid('Invalid decrypted record length');
                        pending=plain.slice();
                    } finally {plain.fill(0);}
                    offset+=size;progress('decrypt-state',offset,expected);
                    await new Promise(r=>setTimeout(r,0));check();
                }
                // WebKit may emit the whole expansion of an input chunk in one
                // allocation. Feed gzip small pieces even for highly compressible RAM.
                const end=Math.min(position+16384,pending.length);
                controller.enqueue(pending.slice(position,end));position=end;
                if(position===pending.length)discard();
            } catch(error) {discard();controller.error(error);await source.close(error);}
        },
        cancel(reason) {discard();return source.close(reason);},
    },new ByteLengthQueuingStrategy({highWaterMark:16384}));
    raw=new StateReader(compressed.pipeThrough(new DecompressionStream('gzip')),h.raw,check,n=>progress('decompress',n,h.raw));
    const metaLength=number(await raw.read(4));
    if(metaLength>65536||metaLength+4>h.raw)throw invalid("Invalid state metadata");
    const metadata=JSON.parse(dec.decode(await raw.read(metaLength)));
    const {stateLength,overlayLength}=metadata;
    if(!Number.isSafeInteger(stateLength)||stateLength<1||!Number.isSafeInteger(overlayLength)||overlayLength<0||4+metaLength+stateLength+overlayLength!==h.raw)throw invalid("Invalid state sections");
    check();state=new Uint8Array(stateLength);overlay=new Uint8Array(overlayLength);
    await raw.into(state);await raw.into(overlay);await raw.end();check();
    if(raw.received!==h.raw || source.received!==expected)throw invalid('Invalid state length');
    const stateSha256=Array.from(hash.digest(),b=>b.toString(16).padStart(2,'0')).join('');
    complete=true;return {metadata,state:state.buffer,overlay,stateSha256};
    } finally {
        signal?.removeEventListener('abort',abort);
        await Promise.all([source.close(),raw?.close()]);
        if(!complete) {state?.fill(0);overlay?.fill(0);}
    }
}
