import init, {Vault,verify} from "../pkg/slop86_disk.js";
import {BootAnalysis} from "./boot-analysis.js";
import {encodeState, decodeState} from "./state-format.js";
import {WorkerProtocol} from "./worker-protocol.js";
import {TorrentPort} from "./torrent-port.js";
import {RemotePublication} from "./torrent-remote.js";
import {hex} from "./torrent-protocol.js";
const sources = new Map();
let stateCandidate, stateSerial = 0;
function dropState() {
    if(stateCandidate?.prefetchId!==undefined)
        sources.get(stateCandidate.source)?.discardStartupPrefetch(stateCandidate.prefetchId);
    stateCandidate?.vault.free();stateCandidate=undefined;
}
let identity;
let networkBytes = 0, networkRequests = 0;
let vault, sourceId = 0, current, prepared, nextDownload = 0;
let bootAnalysis;
let restoredOrigin, freshRestore=false;
const originFor = kind => {
    if(kind==='boot')return {kind:'boot'};
    if(kind==='restored' && restoredOrigin)return {...restoredOrigin};
    throw fail('OPERATION_FAILED','Restore a state before selecting its load profile');
};
let protocol;
let torrentIO;
let readBytes = 0, readCalls = 0, progressAt = new Map(), initError;
const fail = (code, message) => Object.assign(new Error(message), {code});
const describe = () => ({...JSON.parse(vault.describe()), ...(sources.get(current)?.remote ? {remote:sources.get(current).remote} : {})});
const source = value => { const id = `source:${++sourceId}`; sources.set(id, {size:value.size, blob:value, read:async(offset,length)=>new Uint8Array(await value.slice(offset,offset+length).arrayBuffer())}); return id; };
const remove = async id => {const input=sources.get(id);sources.delete(id);await input?.close?.();};
globalThis.slopDiskCancelled = () => protocol?.cancelled() || false;
function check() { if(globalThis.slopDiskCancelled()) throw fail("CANCELLED", "Operation cancelled"); }
globalThis.slopDiskRead = async (id, offset, length) => {
    check(); const input = sources.get(id);
    if(!input || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || offset + length > input.size) throw fail("IO_ERROR", "Source range unavailable");
    const bytes = await input.read(offset, length, protocol.signal);
    check();
    if(bytes.length !== length) throw fail("IO_ERROR", "Short source read");
    readBytes += length; readCalls++; return bytes;
};
function torrentProgress(session,value) {
    for(const [id,input] of sources) {
        if(input.session!==session)continue;
        input.progress(value);
        if(id===current) {
            const stats=input.stats();networkBytes=stats.received;networkRequests=stats.rangeRequests;
            if(value.error)self.postMessage({type:"progress",phase:"download",error:value.error,
                completed:value.downloaded||0,total:input.size,readBytes,readCalls,networkBytes,networkRequests});
            if(value.infoHash===input.publication.disk)progress("download",value.coveredBytes||0,input.size);
            if(value.infoHash===input.publication.state)progress("download-state",value.coveredBytes||0,value.size);
        }
    }
}
function remoteArguments(args,owner) {
    if(Object.keys(args).some(key=>!["publicKey","infoHash","sources","readKey","prefetchScope"].includes(key)))
        throw fail("INVALID_PUBLICATION","Unknown publication argument");
    if(args.prefetchScope!==undefined && !["none","disk"].includes(args.prefetchScope))
        throw fail("INVALID_PROFILE","Initial prefetch scope must be none or disk");
    if(!torrentIO)throw fail("IO_ERROR","Ciphertext bridge is unavailable");
    return {publicKey:args.publicKey,descriptorInfoHash:args.infoHash,owner,sources:args.sources,prefetchScope:args.prefetchScope,
        verifySignature:verify,signal:protocol.signal};
}
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
        if(previous) await remove(previous);
        progress("encrypt", describe().size, describe().size);
        return {...describe(), outcome:"created", download:prepared};
    } catch(error) { if(id && id !== current) await remove(id); vault.cancel(); throw error; }
}
async function execute(op,a) {
    if(op === "close" && !vault) return null;
    if(vault && !identity && ["unlock", "create", "createEmpty", "open", "openRemote", "save", "exportReadOnlyKey", "saveState"].includes(op)) {
        throw fail("READ_ONLY", "Operation unavailable in read-only mode");
    }
    if(op === "openReadOnly") {
        if(vault) throw fail("OPERATION_FAILED", "Close the current disk or identity first");
        if(!(a.readKey instanceof Uint8Array) || a.readKey.length !== 64) throw fail("INVALID_READ_KEY", "Invalid read key");
        if(!(a.file instanceof Blob)) throw fail("IO_ERROR", "An encrypted local file is required");
        const id=source(a.file);let candidate;
        try {
            candidate=await Vault.open_read_only(id,a.file.size,a.readKey);check();
            vault=candidate;current=id;prepared=undefined;return describe();
        } catch(error) {candidate?.free();await remove(id);throw error;}
    }
    if(op==="openRemoteReadOnly") {
        if(vault)throw fail("OPERATION_FAILED","Close the current disk or identity first");
        if(!(a.readKey instanceof Uint8Array)||a.readKey.length!==64)throw fail("INVALID_READ_KEY","Invalid read key");
        const remote=await RemotePublication.open(torrentIO,remoteArguments(a,hex(a.readKey.subarray(0,32))));
        const id="source:"+(++sourceId);sources.set(id,remote);let candidate;
        try {
            candidate=await Vault.open_read_only(id,remote.size,a.readKey);check();
            vault=candidate;current=id;prepared=undefined;
            await remote.startPrefetch(protocol.signal);return describe();
        } catch(error){candidate?.free();vault=undefined;current=undefined;await remove(id);throw error;}
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
        if(bootAnalysis || !state.remote?.infoHash || (a.origin==='boot' ? state.dirty_bytes : !freshRestore))throw fail('OPERATION_FAILED','Analysis requires a clean remote boot or a freshly restored remote state');
        bootAnalysis=new BootAnalysis(state.remote.infoHash,state.size,origin);
        freshRestore=false;return null;
    }
    case "setLoadPrefetch": {
        const origin=originFor(a.origin), remote=sources.get(current);
        if(!['none','profile','disk','auto'].includes(a.scope))throw fail('OPERATION_FAILED','Invalid load prefetch scope');
        await remote?.setLoadPrefetch?.(origin,a.scope,{size:describe().size,signal:protocol.signal});return null;
    }
    case "startBootAnalysis": {
        const state = describe();
        if(bootAnalysis || !state.remote?.infoHash || state.dirty_bytes) throw fail("OPERATION_FAILED", "Boot analysis requires a clean remote disk and no existing analysis");
        bootAnalysis = new BootAnalysis(state.remote.infoHash, state.size);
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
        finally {await remove(id);}
    }
    case "create": {
        const id = source(a.file);
        try {vault.begin_create(id,a.file.size);return await build();}
        finally {await remove(id);}
    }
    case "open": {
        const id = source(a.file);
        try {await vault.open(id,a.file.size);const previous=current;current = id;prepared = undefined;restoredOrigin=undefined;freshRestore=false;if(previous)await remove(previous);return describe();}
        catch(error) {await remove(id);throw error;}
    }
    case "openRemote": {
        if(a.readKey!==undefined)throw fail("INVALID_READ_KEY","Use the read-only publication operation");
        const remote=await RemotePublication.open(torrentIO,remoteArguments(a,hex(new Uint8Array(identity.publicKey))));
        const id="source:"+(++sourceId);sources.set(id,remote);
        try {
            await vault.open(id,remote.size);check();
            const previous=current;current=id;prepared=undefined;restoredOrigin=undefined;freshRestore=false;
            if(previous)await remove(previous);
            await remote.startPrefetch(protocol.signal);return describe();
        } catch(error){await remove(id);throw error;}
    }
    case "saveState": {
        const blob=await encodeState(vault,{...a.metadata,baseInfoHash:describe().remote?.infoHash || null},a.state,{check,progress});
        check();return {blob,size:blob.size};
    }
    case "prepareState": {
        dropState();
        let input=a.input,decoded,prefetchId;
        const sourceId=current,remote=sources.get(sourceId);
        if(a.prefetch===undefined)remote?.discardStartupPrefetch?.();
        try {
            if(a.published) {
                if(!remote?.stateInput)throw fail("NO_PUBLISHED_STATE","Open a publication with a state first");
                if(a.prefetch!==undefined)prefetchId=remote.startStartupPrefetch(a.prefetch,{
                    size:describe().size,signal:protocol.signal,
                    onProgress:value=>{
                        if(current===sourceId)progress("download-startup",value.completed,value.total);
                    },
                });
                input=await remote.stateInput(protocol.signal);
            } else if(a.prefetch!==undefined)throw fail("INVALID_PROFILE","Startup prefetch requires a published state");
            decoded=await decodeState(vault,input,{check,progress,signal:protocol.signal});
            const reference=decoded.metadata.baseInfoHash;
            if(reference!==null && reference!==undefined && remote?.remote && reference!==remote.remote.infoHash)
                throw fail("INVALID_STATE","State belongs to a different published disk");
            const origin={kind:'state',sha256:decoded.stateSha256};
            if(prefetchId!==undefined)remote.validateStartupPrefetch(prefetchId,origin);
            check();const candidate=vault.fork_state(decoded.overlay);
            void input?.validated?.();
            const token=++stateSerial;
            stateCandidate={vault:candidate,token,revision:describe().revision,source:current,origin,prefetchId};
            return {token,metadata:decoded.metadata,state:decoded.state,size:describe().size,
                ...(prefetchId!==undefined?{prefetchId}:{})};
        } catch(error) {
            if(prefetchId!==undefined)remote.discardStartupPrefetch(prefetchId);
            throw error;
        } finally {decoded?.overlay.fill(0);}
    }
    case "candidateRead": {
        if(!stateCandidate || a.token!==stateCandidate.token)throw fail("INVALID_STATE","Expired state candidate");
        return stateCandidate.vault.read(a.offset,a.length);
    }
    case "discardState": if(stateCandidate?.token===a.token)dropState();return null;
    case "commitState": {
        if(!stateCandidate || a.token!==stateCandidate.token || stateCandidate.revision!==describe().revision || stateCandidate.source!==current)throw fail("INVALID_STATE","Disk changed during restoration");
        check();const old=vault,prefetchId=stateCandidate.prefetchId;
        vault=stateCandidate.vault;restoredOrigin=stateCandidate.origin;freshRestore=true;stateCandidate=undefined;old.free();prepared=undefined;
        if(prefetchId!==undefined)sources.get(current).commitStartupPrefetch(prefetchId);
        else await sources.get(current)?.setLoadPrefetch?.(restoredOrigin,'none',{size:describe().size,signal:protocol.signal});
        return describe();
    }
    case "waitLoadPrefetch": {
        if(stateCandidate?.prefetchId===a.id)
            throw fail("INVALID_STATE","Commit the state before waiting for startup prefetch");
        const remote=sources.get(current);
        if(!remote?.waitStartupPrefetch)throw fail("INVALID_PROFILE","No startup prefetch is available");
        const result=await remote.waitStartupPrefetch(a.id);check();return result;
    }
    case "relayPublicKey": return vault.relay_public_key();
    case "signRelayChallenge": {
        if(!identity) throw fail("READ_ONLY", "Relay authentication requires an unlocked identity");
        const url = new URL(a.url);
        if(url.protocol !== 'wss:' || url.username || url.password || url.hash || url.search ||
           a.origin !== self.location.origin || !Number.isSafeInteger(a.expires) ||
           a.expires * 1000 < Date.now() - 1000 || a.expires * 1000 > Date.now() + 11000) {
            throw fail("OPERATION_FAILED", "Invalid relay challenge");
        }
        return vault.sign_relay_challenge(url.href,a.origin,new Uint8Array(a.nonce),BigInt(a.expires));
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
                    check(); const bytes=await input.read(offset,Math.min(1048576,input.size-offset),protocol.signal);check();
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
    case "discard": vault.discard();restoredOrigin=undefined;freshRestore=false;await sources.get(current)?.setLoadPrefetch?.({kind:'boot'},'none',{size:describe().size,signal:protocol.signal});return describe();
    case "verify": {
        vault.verify_start();let count=0;
        try {for(;;) {check();const hash=await vault.verify_step();count++;if(hash) {await yieldEvents();check();progress("verify",describe().size,describe().size);return hash;}
            if(count%16===0) {progress("verify",count*65536,describe().size);await yieldEvents();}
        }} catch(error) {vault.cancel();throw error;}
    }
    case "readStats": return {readBytes,readCalls,networkBytes,networkRequests,blockCacheBytes:sources.get(current)?.cacheBytes||0,remote:sources.get(current)?.stats?.()};
    case "readTrace": return sources.get(current)?.trace || [];
    case "resumePrefetch": await sources.get(current)?.startPrefetch?.(protocol.signal);return null;
    case "clearCaches":
        vault.clear_cache();
        if(sources.get(current)?.clearCache)await sources.get(current).clearCache();
        else await torrentIO?.call("clearStorage",{session:"torrent:0"});
        return null;
    case "close": dropState();bootAnalysis=restoredOrigin=undefined;freshRestore=false;vault.free();vault=undefined;for(const id of [...sources.keys()])await remove(id);identity=current=prepared=undefined;return null;
    default: throw fail("OPERATION_FAILED","Unknown disk operation");
    }
}
protocol=new WorkerProtocol({ready,getInitError:()=>initError,execute,
    onCancel:()=>sources.get(current)?.cancel?.(),onCancelled:()=>vault?.cancel(),
    onRequest:()=>progressAt.clear()});
self.onmessage=({data})=>{
    if(data.op==="torrentPort") {
        torrentIO?.close();torrentIO=new TorrentPort(data.port,torrentProgress);return;
    }
    protocol.handle(data);
};
