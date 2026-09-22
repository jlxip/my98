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
    let file=input;
    if(typeof input==="string") {
        const response=await fetch(input,{signal,credentials:"omit"});
        if(!response.ok||!response.body)throw invalid("Could not download state ("+response.status+")");
        file=await collect(response.body,LIMIT+65536,check,n=>progress("download-state",n,0));
    }
    if(!(file instanceof Blob)||file.size<12||file.size>LIMIT+65536)throw invalid("Invalid state file size");
    const prefix=new Uint8Array(await file.slice(0,12).arrayBuffer());check();
    if(!MAGIC.every((n,i)=>prefix[i]===n))throw invalid("Unsupported state format");
    const length=number(prefix.subarray(8));
    if(length<1||length>4096)throw invalid("Invalid state header");
    const header=new Uint8Array(await file.slice(12,12+length).arrayBuffer());
    const h=JSON.parse(dec.decode(header));
    if(h.version!==1||!Number.isSafeInteger(h.raw)||h.raw<4||h.raw>LIMIT||!Number.isSafeInteger(h.packed)||h.packed<1||h.packed>LIMIT)throw invalid("Unsupported state size or version");
    const base=await vault.state_base();check();
    if(!Array.isArray(h.base)||h.base.length!==base.length||!base.every((v,i)=>v===h.base[i]))throw invalid("State belongs to a different base disk");
    const records=Math.ceil(h.packed/CHUNK);
    if(file.size!==12+length+h.packed+records*62)throw invalid("Truncated state or trailing bytes");
    const parts=[];let offset=12+length;
    for(let i=0;i<records;i++) {
        check();const size=Math.min(CHUNK,h.packed-i*CHUNK)+62;
        const sealed=new Uint8Array(await file.slice(offset,offset+size).arrayBuffer());
        const plain=vault.open_state(context(header,i),sealed);
        try {parts.push(new Blob([plain]));}finally {plain.fill(0);}
        offset+=size;progress("decrypt-state",offset,file.size);
        await new Promise(r=>setTimeout(r,0));check();
    }
    const raw=await collect(new Blob(parts).stream().pipeThrough(new DecompressionStream("gzip")),h.raw,check,n=>progress("decompress",n,h.raw));
    if(raw.size!==h.raw)throw invalid("Invalid uncompressed state length");
    const metaLength=number(new Uint8Array(await raw.slice(0,4).arrayBuffer()));
    if(metaLength>65536||metaLength+4>raw.size)throw invalid("Invalid state metadata");
    const metadata=JSON.parse(dec.decode(await raw.slice(4,4+metaLength).arrayBuffer()));
    const {stateLength,overlayLength}=metadata;
    if(!Number.isSafeInteger(stateLength)||stateLength<1||!Number.isSafeInteger(overlayLength)||overlayLength<0||4+metaLength+stateLength+overlayLength!==raw.size)throw invalid("Invalid state sections");
    const state=await raw.slice(4+metaLength,4+metaLength+stateLength).arrayBuffer();
    const overlay=new Uint8Array(await raw.slice(4+metaLength+stateLength).arrayBuffer());check();
    return {metadata,state,overlay};
}
