import init, {Vault} from "../pkg/slop86_disk.js";
const sources = new Map(), reader = new FileReaderSync();
let vault, sourceId = 0, current, prepared, nextDownload = 0;
let sequence = Promise.resolve(), cancelEpoch = 0, activeEpoch = 0, cancelView;
let readBytes = 0, readCalls = 0, progressAt = 0, initError;
const fail = (code, message) => Object.assign(new Error(message), {code});
const describe = () => JSON.parse(vault.describe());
const source = blob => { const id = `file:${++sourceId}`; sources.set(id, blob); return id; };
globalThis.slopDiskCancelled = () => activeEpoch !== cancelEpoch || !!(cancelView && Atomics.load(cancelView, 0) !== activeEpoch);
function check() { if(globalThis.slopDiskCancelled()) throw fail("CANCELLED", "Operation cancelled"); }
globalThis.slopDiskRead = (id, offset, length) => {
    check(); const blob = sources.get(id);
    if(!blob || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || offset + length > blob.size) throw fail("IO_ERROR", "Source range unavailable");
    const bytes = new Uint8Array(reader.readAsArrayBuffer(blob.slice(offset, offset + length)));
    if(bytes.length !== length) throw fail("IO_ERROR", "Short source read");
    readBytes += length; readCalls++; return bytes;
};
function progress(phase, completed, total) {
    if(performance.now() - progressAt > 100 || completed === total) {
        progressAt = performance.now(); self.postMessage({type:"progress", phase, completed, total, readBytes, readCalls});
    }
}
const yieldEvents = () => new Promise(resolve => setTimeout(resolve, 0));
const ready = init().then(() => self.postMessage({type:"ready"})).catch(error => {initError = error; self.postMessage({type:"fatal",error:"Disk WASM could not initialize"});});
async function build() {
    const parts = [vault.header()]; let count = 0, id;
    try {
        for(;;) {
            check(); const bytes = vault.next(); if(!bytes) break;
            parts.push(new Blob([bytes]));
            if(++count % 16 === 0) { progress("encrypt", count * 65536, 0); await yieldEvents(); }
        }
        check(); const blob = new Blob(parts, {type:"application/octet-stream"});
        // Accept only after Blob assembly succeeds and queued cancellation has been observed.
        await yieldEvents(); check();
        id = source(blob); vault.accept(id, blob.size);
        const previous = current; current = id;
        prepared = {id:++nextDownload, blob, size:blob.size};
        if(previous) sources.delete(previous);
        progress("encrypt", describe().size, describe().size);
        return {...describe(), outcome:"created", download:prepared};
    } catch(error) { if(id && id !== current) sources.delete(id); vault.cancel(); throw error; }
}
async function execute(op,a) {
    if(op === "unlock") {
        if(vault) throw fail("OPERATION_FAILED", "Close the previous identity first");
        vault = new Vault(a.username,a.password,a.machine); return JSON.parse(vault.identity());
    }
    if(!vault) throw fail("OPERATION_FAILED", "Identity is closed");
    switch(op) {
    case "create": {
        const id = source(a.file);
        try {vault.begin_create(id,a.file.size);return await build();}
        finally {sources.delete(id);}
    }
    case "open": {
        const id = source(a.file);
        try {vault.open(id,a.file.size);current = id;prepared = undefined;return describe();}
        catch(error) {sources.delete(id);throw error;}
    }
    case "describe": return describe();
    case "read": {
        if(!Number.isSafeInteger(a.length) || a.length < 0 || a.length > 0xffffffff) throw fail("IO_ERROR","Invalid read length");
        return vault.read(a.offset,a.length);
    }
    case "write": vault.write(a.offset,a.bytes);return describe();
    case "save": {
        if(!vault.begin_save()) {await yieldEvents();check();vault.accept_unchanged();return {...describe(),outcome:"unchanged"};}
        return build();
    }
    case "download": {
        if(describe().dirty_bytes) throw fail("OPERATION_FAILED", "Save or discard pending writes before downloading");
        if(!prepared) {const blob=sources.get(current);prepared={id:++nextDownload,blob,size:blob.size};}
        return prepared;
    }
    case "retry": if(!prepared) throw fail("OPERATION_FAILED","No prepared download");return prepared;
    case "discard": vault.discard();return describe();
    case "verify": {
        vault.verify_start();let count=0;
        try {for(;;) {check();const hash=vault.verify_step();count++;if(hash) {await yieldEvents();check();progress("verify",describe().size,describe().size);return hash;}
            if(count%16===0) {progress("verify",count*65536,describe().size);await yieldEvents();}
        }} catch(error) {vault.cancel();throw error;}
    }
    case "readStats": return {readBytes,readCalls};
    case "clearCaches": vault.clear_cache();return null;
    case "close": vault.free();vault=undefined;sources.clear();current=prepared=undefined;return null;
    default: throw fail("OPERATION_FAILED","Unknown disk operation");
    }
}
function errorInfo(error) {
    const message = String(error?.message || error);
    try {const value = JSON.parse(message);if(value.code && value.message) return value;}catch{}
    return {code:error?.code || "OPERATION_FAILED",message};
}
self.onmessage = ({data}) => {
    if(data.op === "cancel") {cancelEpoch=data.epoch;return;}
    if(data.op === "configure") {cancelView=data.buffer ? new Int32Array(data.buffer):undefined;return;}
    sequence=sequence.then(async()=>{
        const {id,op,args,epoch}=data;
        try {await ready;if(initError)throw initError;activeEpoch=epoch;progressAt=-Infinity;check();const result=await execute(op,args);
            self.postMessage({id,ok:true,result},result instanceof Uint8Array?[result.buffer]:[]);
        }catch(error) {
            if(globalThis.slopDiskCancelled()) {vault?.cancel();error=fail("CANCELLED","Operation cancelled");}
            self.postMessage({id,ok:false,error:errorInfo(error)});
        }finally {args?.password?.fill(0);args?.bytes?.fill(0);}
    }).catch(()=>self.postMessage({type:"fatal",error:"Disk Worker failed"}));
};
