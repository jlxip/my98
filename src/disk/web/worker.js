import init, {Vault} from "../pkg/slop86_disk.js";
import {RemoteDisk} from "./remote.js";
import {BootAnalysis} from "./boot-analysis.js";
import {encodeState, decodeState} from "./state-format.js";
const sources = new Map();
let stateCandidate, stateSerial = 0;
function dropState() {stateCandidate?.vault.free();stateCandidate=undefined;}
let identity, activeRequest;
let networkBytes = 0, networkRequests = 0;
let vault, sourceId = 0, current, prepared, nextDownload = 0;
let bootAnalysis;
let restoredOrigin, freshRestore=false;
const originFor = kind => {
    if(kind==='boot')return {kind:'boot'};
    if(kind==='restored' && restoredOrigin)return {...restoredOrigin};
    throw fail('OPERATION_FAILED','Restore a state before selecting its load profile');
};
let sequence = Promise.resolve(), cancelEpoch = 0, activeEpoch = 0, cancelView;
let readBytes = 0, readCalls = 0, progressAt = new Map(), initError;
const fail = (code, message) => Object.assign(new Error(message), {code});
const describe = () => ({...JSON.parse(vault.describe()), ...(sources.get(current)?.remote ? {remote:sources.get(current).remote} : {})});
const source = value => { const id = `source:${++sourceId}`; sources.set(id, value instanceof RemoteDisk ? value : {size:value.size, blob:value, read:async(offset,length)=>new Uint8Array(await value.slice(offset,offset+length).arrayBuffer())}); return id; };
const remove = id => {sources.get(id)?.close?.();sources.delete(id);};
globalThis.slopDiskCancelled = () => activeEpoch !== cancelEpoch || !!(cancelView && Atomics.load(cancelView, 0) !== activeEpoch);
function check() { if(globalThis.slopDiskCancelled()) throw fail("CANCELLED", "Operation cancelled"); }
globalThis.slopDiskRead = async (id, offset, length) => {
    check(); const input = sources.get(id);
    if(!input || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || offset + length > input.size) throw fail("IO_ERROR", "Source range unavailable");
    const bytes = await input.read(offset, length, activeRequest?.signal);
    check();
    if(bytes.length !== length) throw fail("IO_ERROR", "Short source read");
    readBytes += length; readCalls++; return bytes;
};
function progress(phase, completed, total) {
    if(performance.now() - (progressAt.get(phase)??-Infinity) > 100 || completed === total) {
        progressAt.set(phase,performance.now()); self.postMessage({type:"progress", phase, completed, total, readBytes, readCalls, networkBytes, networkRequests});
    }
}
const yieldEvents = () => new Promise(resolve => setTimeout(resolve, 0));
const ready = init().then(() => self.postMessage({type:"ready"})).catch(error => {initError = error; self.postMessage({type:"fatal",error:"Disk WASM could not initialize"});});
async function build() {
    const parts = [vault.header()]; let count = 0, id;
    try {
        for(;;) {
            check(); const bytes = await vault.next(); if(!bytes) break;
            parts.push(new Blob([bytes]));
            if(++count % 16 === 0) { progress("encrypt", count * 65536, 0); await yieldEvents(); }
        }
        check(); const blob = new Blob(parts, {type:"application/octet-stream"});
        // Accept only after Blob assembly succeeds and queued cancellation has been observed.
        await yieldEvents(); check();
        id = source(blob); vault.accept(id, blob.size);
        const previous = current; current = id;restoredOrigin=undefined;freshRestore=false;
        prepared = {id:++nextDownload, blob, size:blob.size};
        if(previous) remove(previous);
        progress("encrypt", describe().size, describe().size);
        return {...describe(), outcome:"created", download:prepared};
    } catch(error) { if(id && id !== current) remove(id); vault.cancel(); throw error; }
}
async function execute(op,a) {
    if(op === "close" && !vault) return null;
    if(vault && !identity && ["unlock", "create", "createEmpty", "open", "openRemote", "save", "download", "retry", "exportReadOnlyKey", "saveState"].includes(op)) {
        throw fail("READ_ONLY", "Operation unavailable in read-only mode");
    }
    if(op === "openReadOnly") {
        if(vault) throw fail("OPERATION_FAILED", "Close the current disk or identity first");
        if(!(a.readKey instanceof Uint8Array) || a.readKey.length !== 64) throw fail("INVALID_READ_KEY", "Invalid read key");
        const remote = new RemoteDisk({gateway:a.gateway, servers:a.servers, onlyLocalhost:a.onlyLocalhost, prefetch:a.prefetch, preloadState:a.preloadState, stateTransport:a.stateTransport,
            onStateProgress:(received,total)=>progress("download-state",received,total), onNetwork:(bytes, calls)=>{networkBytes+=bytes;networkRequests+=calls;}});
        let id, candidate;
        try {
            progress("resolve",0,0);
            await remote.openCid(a.cid, activeRequest.signal); check();
            id = source(remote);
            candidate = await Vault.open_read_only(id, remote.size, a.readKey); check();
            vault = candidate; current = id; prepared = undefined;
            remote.startPrefetch(); return describe();
        } catch(error) {
            candidate?.free();
            if(vault === candidate) vault = current = undefined;
            if(id) remove(id); else remote.close();
            throw error;
        }
    }
    if(op === "unlock") {
        if(vault) throw fail("OPERATION_FAILED", "Close the previous identity first");
        vault = new Vault(a.username,a.password,a.machine); identity = JSON.parse(vault.identity()); return identity;
    }
    if(!vault) throw fail("OPERATION_FAILED", "Identity is closed");
    if(bootAnalysis && ["create", "createEmpty", "open", "openRemote", "save", "download", "retry", "discard", "verify", "saveState", "prepareState"].includes(op)) throw fail("OPERATION_FAILED", "Finish or cancel the boot analysis first");
    switch(op) {
    case "startLoadAnalysis": {
        const state=describe(), origin=originFor(a.origin);
        if(bootAnalysis || !state.remote?.cid || (a.origin==='boot' ? state.dirty_bytes : !freshRestore))throw fail('OPERATION_FAILED','Analysis requires a clean remote boot or a freshly restored remote state');
        bootAnalysis=new BootAnalysis(state.remote.cid,state.size,origin);
        freshRestore=false;return null;
    }
    case "setLoadPrefetch": {
        const origin=originFor(a.origin), remote=sources.get(current);
        if(!['none','profile','disk'].includes(a.scope))throw fail('OPERATION_FAILED','Invalid load prefetch scope');
        remote?.setLoadPrefetch?.(origin,a.scope);return null;
    }
    case "startBootAnalysis": {
        const state = describe();
        if(bootAnalysis || !state.remote?.cid || state.dirty_bytes) throw fail("OPERATION_FAILED", "Boot analysis requires a clean remote disk and no existing analysis");
        bootAnalysis = new BootAnalysis(state.remote.cid, state.size);
        return null;
    }
    case "finishBootAnalysis":
    case "finishLoadAnalysis": {
        if(!bootAnalysis) throw fail("OPERATION_FAILED", "No boot analysis is available");
        const profile = bootAnalysis.finish();
        bootAnalysis = undefined;
        return profile;
    }
    case "cancelBootAnalysis":
    case "cancelLoadAnalysis": bootAnalysis = undefined; return null;
    case "createEmpty": {
        const size = a.sizeBytes;
        if(!Number.isSafeInteger(size) || size <= 0 || size > 2 ** 40 || size % 512) {
            throw fail("INVALID_SIZE", "Size must be a positive whole number of 512-byte sectors, up to 1 TiB.");
        }
        // Supply only the requested block; never allocate a full plaintext image.
        const id = `source:${++sourceId}`;
        sources.set(id, {size, read:async(offset, length) => new Uint8Array(length)});
        try {vault.begin_create(id, size);return await build();}
        finally {remove(id);}
    }
    case "create": {
        const id = source(a.file);
        try {vault.begin_create(id,a.file.size);return await build();}
        finally {remove(id);}
    }
    case "open": {
        const id = source(a.file);
        try {await vault.open(id,a.file.size);current = id;prepared = undefined;restoredOrigin=undefined;freshRestore=false;return describe();}
        catch(error) {remove(id);throw error;}
    }
    case "openRemote": {
        if(current) throw fail("OPERATION_FAILED", "Close the current disk before opening another");
        const remote = new RemoteDisk({gateway:a.gateway, servers:a.servers, onlyLocalhost:a.onlyLocalhost, prefetch:a.prefetch, onNetwork:(bytes, calls)=>{networkBytes+=bytes;networkRequests+=calls;}});
        let id;
        try {
            progress("resolve",0,0);
            await remote.open(identity, activeRequest.signal); check();
            id = source(remote); await vault.open(id,remote.size);
            current = id; prepared = undefined; restoredOrigin=undefined;freshRestore=false;remote.startPrefetch(); return describe();
        } catch(error) {if(id)remove(id);else remote.close();throw error;}
    }
    case "saveState": {
        const blob=await encodeState(vault,{...a.metadata,baseCid:describe().remote?.cid || null},a.state,{check,progress});
        check();return {blob,size:blob.size};
    }
    case "prepareState": {
        dropState();
        let input=a.input;
        if(input && typeof input==='object' && input.published===true) {
            const remote=sources.get(current);
            if(!(remote instanceof RemoteDisk)) throw fail("INVALID_STATE","No published state for this disk");
            input=await remote.openStateStream(activeRequest.signal,(done,total)=>progress("download-state",done,total));check();
        }
        const decoded=await decodeState(vault,input,{check,progress,signal:activeRequest.signal});
        try {
            check();const candidate=vault.fork_state(decoded.overlay);
            const token=++stateSerial;
            stateCandidate={vault:candidate,token,revision:describe().revision,source:current,origin:{kind:'state',sha256:decoded.stateSha256}};
            return {token,metadata:decoded.metadata,state:decoded.state,size:describe().size};
        } finally {decoded.overlay.fill(0);}
    }
    case "candidateRead": {
        if(!stateCandidate || a.token!==stateCandidate.token)throw fail("INVALID_STATE","Expired state candidate");
        return stateCandidate.vault.read(a.offset,a.length);
    }
    case "discardState": if(stateCandidate?.token===a.token)dropState();return null;
    case "commitState": {
        if(!stateCandidate || a.token!==stateCandidate.token || stateCandidate.revision!==describe().revision || stateCandidate.source!==current)throw fail("INVALID_STATE","Disk changed during restoration");
        check();const old=vault;vault=stateCandidate.vault;restoredOrigin=stateCandidate.origin;freshRestore=true;stateCandidate=undefined;old.free();prepared=undefined;
        sources.get(current)?.setLoadPrefetch?.(restoredOrigin,'none');
        return describe();
    }
    case "exportReadOnlyKey": return vault.export_read_key();
    case "describe": return describe();
    case "read": {
        freshRestore=false;
        if(!Number.isSafeInteger(a.length) || a.length < 0 || a.length > 0xffffffff) throw fail("IO_ERROR","Invalid read length");
        const start=performance.now(), input=sources.get(current), before=readCalls;
        if(bootAnalysis?.observe(a.offset, a.length)) self.postMessage({type:"analysis", error:"Analysis exceeded 200,000 distinct blocks. No partial profile was exported. Windows can continue running."});
        input?.noteDemand?.(a.offset,a.length);
        try {return await vault.read(a.offset,a.length);}
        finally {input?.traceEvent?.('guest-read',{offset:a.offset,length:a.length,ms:performance.now()-start,hit:before===readCalls});}
    }
    case "write": freshRestore=false;await vault.write(a.offset,a.bytes);return describe();
    case "save": {
        if(!await vault.begin_save()) {await yieldEvents();check();vault.accept_unchanged();return {...describe(),outcome:"unchanged"};}
        return build();
    }
    case "download": {
        if(describe().dirty_bytes) throw fail("OPERATION_FAILED", "Save or discard pending writes before downloading");
        if(!prepared) {
            const input=sources.get(current); let blob=input.blob;
            if(!blob) {
                const parts=[];
                for(let offset=0;offset<input.size;offset+=1048576) {
                    check(); const bytes=await input.read(offset,Math.min(1048576,input.size-offset),activeRequest.signal);check();
                    parts.push(new Blob([bytes]));progress("download",Math.min(offset+1048576,input.size),input.size);
                }
                blob=new Blob(parts,{type:"application/octet-stream"});
                await yieldEvents();check();
            }
            prepared={id:++nextDownload,blob,size:blob.size};
        }
        return prepared;
    }
    case "retry": if(!prepared) throw fail("OPERATION_FAILED","No prepared download");return prepared;
    case "discard": vault.discard();restoredOrigin=undefined;freshRestore=false;sources.get(current)?.setLoadPrefetch?.({kind:'boot'},'none');return describe();
    case "verify": {
        vault.verify_start();let count=0;
        try {for(;;) {check();const hash=await vault.verify_step();count++;if(hash) {await yieldEvents();check();progress("verify",describe().size,describe().size);return hash;}
            if(count%16===0) {progress("verify",count*65536,describe().size);await yieldEvents();}
        }} catch(error) {vault.cancel();throw error;}
    }
    case "readStats": return {readBytes,readCalls,networkBytes,networkRequests,blockCacheBytes:sources.get(current)?.cacheBytes||0,remote:sources.get(current)?.stats?.()};
    case "readTrace": return sources.get(current)?.trace || [];
    case "resumePrefetch": sources.get(current)?.startPrefetch?.();return null;
    case "clearCaches": vault.clear_cache();sources.get(current)?.clearCache?.();return null;
    case "close": dropState();bootAnalysis=restoredOrigin=undefined;freshRestore=false;vault.free();vault=undefined;for(const id of sources.keys())remove(id);identity=current=prepared=undefined;return null;
    default: throw fail("OPERATION_FAILED","Unknown disk operation");
    }
}
function errorInfo(error) {
    const message = String(error?.message || error);
    try {const value = JSON.parse(message);if(value.code && value.message) return value;}catch{}
    return {code:error?.code || "OPERATION_FAILED",message};
}
self.onmessage = ({data}) => {
    if(data.op === "cancel") {cancelEpoch=data.epoch;activeRequest?.abort();sources.get(current)?.cancel?.();return;}
    if(data.op === "configure") {cancelView=data.buffer ? new Int32Array(data.buffer):undefined;return;}
    sequence=sequence.then(async()=>{
        const {id,op,args,epoch}=data;
        try {await ready;if(initError)throw initError;activeEpoch=epoch;activeRequest=new AbortController();progressAt.clear();check();const result=await execute(op,args);
            self.postMessage({id,ok:true,result},result instanceof Uint8Array?[result.buffer]:result?.state instanceof ArrayBuffer?[result.state]:[]);
        }catch(error) {
            if(globalThis.slopDiskCancelled()) {vault?.cancel();error=fail("CANCELLED","Operation cancelled");}
            self.postMessage({id,ok:false,error:errorInfo(error)});
        }finally {activeRequest=undefined;args?.password?.fill(0);args?.bytes?.fill(0);if(args?.readKey instanceof Uint8Array) args.readKey.fill(0);}
    }).catch(()=>self.postMessage({type:"fatal",error:"Disk Worker failed"}));
};
