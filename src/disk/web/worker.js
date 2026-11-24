import init, {Vault,verify,publication_piece_hash,publication_metadata} from "../pkg/slop86_disk.js";
import {BootAnalysis} from "./boot-analysis.js";
import {encodeState, decodeState} from "./state-format.js";
import {WorkerProtocol} from "./worker-protocol.js";
import {TorrentPort} from "./torrent-port.js";
import {RemotePublication,transportFailure} from "./torrent-remote.js";
import {hex,PUBLICATION_SALT} from "./torrent-protocol.js";
import {torrentSources} from "./torrent-sources.js";
import {PublicationJob} from "./publication-publisher.js";
import {prepareUpdate} from "./publication-update.js";
import {cachedRecord} from "./torrent-records.js";
const sources = new Map();
let stateCandidate, stateSerial = 0;
let remoteCandidate,remoteSerial=0,readCapability;
async function dropRemoteCandidate() {
    const candidate=remoteCandidate;remoteCandidate=undefined;
    if(candidate){candidate.vault.free();await remove(candidate.source);}
}
const publicationEvent=status=>self.postMessage({type:'publication',...status});
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
let publisher;
const stateHashes=new Map();
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
    if(publisher?.session===session&&value.replicas)publisher.replication(value.replicas);
    if(publisher?.session===session&&value.error)publisher.seedingError(value.error);
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
    if(Object.keys(args).some(key=>!["publicKey","infoHash","sources","readKey","prefetchScope","waitForFinal"].includes(key)))
        throw fail("INVALID_PUBLICATION","Unknown publication argument");
    if(args.prefetchScope!==undefined && !["none","disk"].includes(args.prefetchScope))
        throw fail("INVALID_PROFILE","Initial prefetch scope must be none or disk");
    if(args.waitForFinal!==undefined&&typeof args.waitForFinal!=="boolean")throw fail("INVALID_PUBLICATION","Invalid publication consistency option");
    if(!torrentIO)throw fail("IO_ERROR","Ciphertext bridge is unavailable");
    return {publicKey:args.publicKey,descriptorInfoHash:args.infoHash,owner,sources:args.sources,prefetchScope:args.prefetchScope,
        verifySignature:verify,signal:protocol.signal,waitForFinal:args.waitForFinal,onDiscovery:publicationEvent};
}
// One bounded retry is allowed only before exposing a disk, and only when
// discovery has authenticated a higher sequence than the failed snapshot.
async function prepareRemote(args,owner,readKey) {
    for(let attempt=0;attempt<2;attempt++) {
        let remote,id,candidate;
        try {
            remote=await RemotePublication.open(torrentIO,remoteArguments(args,owner));
            id="source:"+(++sourceId);sources.set(id,remote);
            if(readKey)candidate=await Vault.open_read_only(id,remote.size,readKey);
            else await vault.open(id,remote.size);
            check();remote.check();return {remote,id,candidate};
        }catch(error) {
            let newer=error.newerPublication;
            if(remote&&transportFailure(error)&&!protocol.signal.aborted) {
                await remote.lookupSettled.catch(()=>{});
                if(remote.discoveryError)error=remote.discoveryError;
                const selected=remote.remote?.sequence,latest=remote.discovery?.sequence;
                newer=!remote.discoveryError&&selected&&latest&&BigInt(latest)>BigInt(selected);
            }
            candidate?.free();if(id)await remove(id);else await remote?.close();
            if(attempt||!newer||protocol.signal.aborted)throw error;
        }
    }
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
async function verifyCandidate(candidate) {
    candidate.verify_start();
    for(let count=0;;count++) {
        check();const hash=await candidate.verify_step();if(hash)return;
        if(count%16===0){progress("verify",count*65536,JSON.parse(candidate.describe()).size);await yieldEvents();}
    }
}
async function candidateBlob(candidate) {
    const parts=[candidate.header()];
    for(let count=0;;count++) {
        check();const bytes=await candidate.next();if(!bytes)break;
        parts.push(new Blob([bytes]));
        if(count%16===0){progress("encrypt",count*65536,0);await yieldEvents();}
    }
    await yieldEvents();check();return new Blob(parts,{type:"application/octet-stream"});
}
async function copyCiphertext(input) {
    const parts=[];
    for(let offset=0;offset<input.size;offset+=1048576){
        check();const length=Math.min(1048576,input.size-offset),bytes=await input.read(offset,length,protocol.signal);check();
        if(bytes.length!==length)throw fail("IO_ERROR","Short ciphertext snapshot read");
        parts.push(new Blob([bytes]));progress("download",offset+length,input.size);
    }
    check();return new Blob(parts,{type:"application/octet-stream"});
}
async function prepareSnapshot({kind="current",file,format="encrypted"}={}) {
    if(!["current","encrypted","raw"].includes(kind)||!["encrypted","raw"].includes(format))throw fail("OPERATION_FAILED","Invalid disk export");
    let candidate,id,detached;
    try {
        if(kind!=="current") {
            if(!identity)throw fail("READ_ONLY","Publishing requires the owner identity");
            if(!(file instanceof Blob)||!file.size)throw fail("IO_ERROR","Choose a nonempty disk file");
            id=source(file);candidate=vault.fresh();
            if(kind==="raw") {candidate.begin_create(id,file.size);return await candidateBlob(candidate);}
            detached=await copyCiphertext(sources.get(id));await remove(id);id=source(detached);
            await candidate.open(id,detached.size);
        } else candidate=vault.snapshot(!identity&&format==="encrypted");
        if(format==="raw") {
            const size=JSON.parse(candidate.describe()).size,parts=[];
            for(let offset=0;offset<size;offset+=65536){check();const bytes=await candidate.read(offset,Math.min(65536,size-offset));parts.push(new Blob([bytes]));bytes.fill(0);if(offset%1048576===0){progress("decrypt",offset,size);await yieldEvents();}}
            check();return new Blob(parts,{type:"application/octet-stream"});
        }
        if(identity&&JSON.parse(candidate.describe()).dirty_bytes&&await candidate.begin_save())return await candidateBlob(candidate);
        await verifyCandidate(candidate);
        return detached||await copyCiphertext(sources.get(current));
    } finally {candidate?.free();if(id)await remove(id);}
}
async function publishDisk(args) {
    if(Object.keys(args).some(key=>!["kind","file","sources"].includes(key)))throw fail("INVALID_PUBLICATION","Unknown publication argument");
    if(!identity)throw fail("READ_ONLY","Publishing requires the owner identity");
    if(publisher?.active)throw fail("OPERATION_FAILED","Stop the current seed before publishing another disk");
    const config=torrentSources(args.sources);
    if(!config.gateways.length||!config.trackers.length)throw fail("INVALID_SOURCE","Configure a publishing gateway and WebRTC trackers");
    const disk=await prepareSnapshot({...args,format:"encrypted"}),pieces=[];
    for(let offset=0;offset<disk.size;offset+=262144){check();pieces.push(publication_piece_hash(new Uint8Array(await disk.slice(offset,offset+262144).arrayBuffer())));progress("hash",Math.min(offset+262144,disk.size),disk.size);}
    const hashes=new Uint8Array(pieces.length*20);pieces.forEach((p,i)=>hashes.set(p,i*20));
    await yieldEvents();check();
    const publicKey=new Uint8Array(identity.publicKey);
    const metadata=JSON.parse(publication_metadata(disk.size,hashes,publicKey,JSON.stringify(config.trackers)));
    const job=new PublicationJob({io:torrentIO,sources:config,publicKey:hex(publicKey),verify,
        sign:(hash,sequence)=>JSON.parse(vault.sign_publication(hash,sequence)),
        onStatus:value=>{if(publisher===job)self.postMessage({type:"publishing",...value});}});
    job.target=hex(publication_piece_hash(new Uint8Array([...publicKey,...new TextEncoder().encode(PUBLICATION_SALT)])));
    publisher=job;
    return await job.start({infoHash:metadata.infoHash,disk,diskMetadata:new Uint8Array(metadata.diskMetadata),
        catalog:new Blob([new Uint8Array(metadata.catalogPayload)]),catalogMetadata:new Uint8Array(metadata.catalogMetadata)},protocol.signal);
}
async function editablePublication(args,{requireBase=true}={}) {
    if(!identity)throw fail('READ_ONLY','Publishing requires the owner identity');
    const base=sources.get(current);
    if(requireBase&&!base?.remote)throw fail('INVALID_PUBLICATION','Open the published base disk first');
    const publicKey=hex(new Uint8Array(identity.publicKey));
    const remote=await RemotePublication.open(torrentIO,{owner:publicKey,publicKey,sources:args.sources,verifySignature:verify,
        prefetchScope:'none',waitForFinal:true,signal:protocol.signal});
    if(requireBase&&remote.publication.disk!==base.publication.disk){await remote.close();throw fail('PUBLICATION_CONFLICT','The published disk has changed. Reopen the publication before updating it.');}
    return remote;
}
async function publicationDetails(args) {
    let remote;
    try {
        remote=await editablePublication(args,{requireBase:args.requireBase!==false});
        const profiles=args.requireBase===false?[]:await remote.profiles(Math.ceil(describe().size/65536),protocol.signal);
        return {hasState:!!remote.publication.state,hasProfiles:!!remote.publication.profile,profiles,
            diskInfoHash:remote.publication.disk,publicationInfoHash:remote.remote.publicationInfoHash};
    } catch(error) {if(args.requireBase===false&&error.code==='NO_PUBLICATION')return {hasState:false,hasProfiles:false,profiles:[]};throw error;}
    finally {await remote?.close();}
}
async function publishUpdate(args) {
    if(Object.keys(args).some(k=>!['action','file','profiles','remove','sources','compatibility'].includes(k)))throw fail('INVALID_PUBLICATION','Unknown publication update argument');
    if(bootAnalysis)throw fail('OPERATION_FAILED','Finish the load analysis first');
    if(publisher?.active&&publisher.state!=='seeding')throw fail('OPERATION_FAILED','Resolve the current announcement or stop seeding before another update');
    const remote=await editablePublication(args);
    try {
        const config=torrentSources(args.sources),publicKey=new Uint8Array(identity.publicKey);
        const snapshot=await prepareUpdate(remote,args,{vault,publicKey,trackers:config.trackers,check,progress,signal:protocol.signal,
            compatibility:args.compatibility,logicalSize:describe().size,stateHashes});
        const previous=publisher;
        const job=new PublicationJob({io:torrentIO,sources:config,publicKey:hex(publicKey),verify,
            sign:(hash,sequence)=>JSON.parse(vault.sign_publication(hash,sequence)),
            onStatus:value=>{if(publisher===job)self.postMessage({type:'publishing',...value});}});
        job.target=hex(publication_piece_hash(new Uint8Array([...publicKey,...new TextEncoder().encode(PUBLICATION_SALT)])));
        publisher=job;
        try {return await job.start(snapshot,protocol.signal,{previous,expected:remote.record});}
        catch(error){publisher=previous;if(previous?.active)previous.current();throw error;}
    } finally {await remote.close();}
}
function getRemoteCandidate(token) {
    if(!remoteCandidate||token!==remoteCandidate.token||remoteCandidate.parent!==current||remoteCandidate.parentVault!==vault)
        throw fail('INVALID_PUBLICATION','Expired publication candidate');
    return remoteCandidate;
}
function remoteDescription(candidate) {
    return {...JSON.parse(candidate.vault.describe()),remote:sources.get(candidate.source).remote};
}
async function prepareRemoteUpdate(args) {
    const previous=sources.get(current);
    if(!previous?.remote?.following)throw fail('INVALID_PUBLICATION','This disk is not following a publication identity');
    if(bootAnalysis&&args.automatic)throw fail('OPERATION_FAILED','Finish the load analysis before updating');
    const record=await cachedRecord(previous.remote.publicKey,verify);
    if(!record||BigInt(record.sequence)<BigInt(args.minimumSequence||previous.remote.sequence))throw fail('PUBLICATION_UNAVAILABLE','The requested signed version is not available');
    if(record.infoHash===previous.remote.publicationInfoHash) {
        await dropRemoteCandidate();check();previous.record=record;previous.remote.sequence=record.sequence;
        return {unchanged:true,description:describe()};
    }
    await dropRemoteCandidate();let candidate,id,remote;
    try {
        remote=await RemotePublication.open(torrentIO,{owner:previous.remote.publicKey,sources:previous.sources,selectedRecord:record,
            prefetchScope:'none',verifySignature:verify,signal:protocol.signal});
        id='source:'+(++sourceId);sources.set(id,remote);
        if(identity){candidate=vault.fresh();await candidate.open(id,remote.size);}
        else {if(!readCapability)throw fail('INVALID_READ_KEY','Reader identity is unavailable');candidate=await Vault.open_read_only(id,remote.size,readCapability);}
        await candidate.read(0,Math.min(512,JSON.parse(candidate.describe()).size));check();remote.check();
        const latest=await cachedRecord(previous.remote.publicKey,verify);
        if(!latest||BigInt(latest.sequence)<BigInt(record.sequence))throw fail('PUBLICATION_UNAVAILABLE','The signed publication could not be confirmed');
        if(latest.sequence===record.sequence&&latest.value!==record.value)throw fail('PUBLICATION_CONFLICT','Conflicting signed publications');
        if(latest.sequence!==record.sequence) {
            candidate.free();await remove(id);return {changed:true,sequence:latest?.sequence,infoHash:latest?.infoHash};
        }
        remoteCandidate={token:++remoteSerial,vault:candidate,source:id,parent:current,parentVault:vault,record};
        return {token:remoteCandidate.token,description:remoteDescription(remoteCandidate)};
    }catch(error){candidate?.free();if(id)await remove(id);else await remote?.close();throw error;}
}
async function prepareRemoteState(candidate) {
    const remote=sources.get(candidate.source);
    if(!remote.publication.state)throw fail('NO_PUBLISHED_STATE','The new publication has no state. Choose Boot latest version to start it in cold boot.');
    let decoded;
    try {
        const input=await remote.stateInput(protocol.signal);
        decoded=await decodeState(candidate.vault,input,{check,progress,signal:protocol.signal});
        if(decoded.metadata.baseInfoHash!=null&&decoded.metadata.baseInfoHash!==remote.publication.disk)throw fail('INVALID_STATE','State belongs to a different published disk');
        check();remote.check();const next=candidate.vault.fork_state(decoded.overlay);candidate.vault.free();candidate.vault=next;
        void input.validated?.();candidate.origin={kind:'state',sha256:decoded.stateSha256};
        return {token:candidate.token,metadata:decoded.metadata,state:decoded.state,size:JSON.parse(candidate.vault.describe()).size};
    } finally {decoded?.overlay.fill(0);}
}
async function commitRemoteUpdate(args) {
    const candidate=getRemoteCandidate(args.token),remote=sources.get(candidate.source);
    const latest=await cachedRecord(remote.remote.publicKey,verify);
    if(!latest||BigInt(latest.sequence)<BigInt(candidate.record.sequence))throw fail('PUBLICATION_UNAVAILABLE','The signed publication could not be confirmed');
    if(latest.sequence===candidate.record.sequence&&latest.value!==candidate.record.value)throw fail('PUBLICATION_CONFLICT','Conflicting signed publications');
    if(latest.sequence!==candidate.record.sequence)throw fail('PUBLICATION_CHANGED','A newer publication was discovered during preparation');
    if(!args.discardChanges&&describe().dirty_bytes)throw fail('DIRTY_DISK','Pending writes require confirmation before updating');
    check();remote.check();dropState();
    const oldVault=vault,oldSource=current;vault=candidate.vault;current=candidate.source;remoteCandidate=undefined;
    prepared=bootAnalysis=undefined;restoredOrigin=candidate.origin;freshRestore=!!candidate.origin;
    remote.onDiscovery=publicationEvent;oldVault.free();await remove(oldSource).catch(()=>{});
    return describe();
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
        const {remote,id,candidate}=await prepareRemote(a,hex(a.readKey.subarray(0,32)),a.readKey);
        try {
            vault=candidate;current=id;prepared=undefined;
            await remote.startPrefetch(protocol.signal);readCapability=a.readKey.slice();return describe();
        } catch(error){candidate?.free();vault=undefined;current=undefined;await remove(id);throw error;}
    }
    if(op === "unlock") {
        if(vault) throw fail("OPERATION_FAILED", "Close the previous identity first");
        vault = new Vault(a.username,a.password,a.machine); identity = JSON.parse(vault.identity()); return identity;
    }
    if(!vault) throw fail("OPERATION_FAILED", "Identity is closed");
    if(bootAnalysis && ["create", "createEmpty", "open", "openRemote", "save", "download", "retry", "discard", "verify", "saveState", "prepareState"].includes(op)) throw fail("OPERATION_FAILED", "Finish or cancel the boot analysis first");
    switch(op) {
    case "prepareRemoteUpdate": return prepareRemoteUpdate(a);
    case "remoteUpdateRead": return getRemoteCandidate(a.token).vault.read(a.offset,a.length);
    case "remoteUpdateDescribe": return remoteDescription(getRemoteCandidate(a.token));
    case "remoteUpdateState": return prepareRemoteState(getRemoteCandidate(a.token));
    case "remoteUpdatePrefetch": {
        const candidate=getRemoteCandidate(a.token),remote=sources.get(candidate.source);
        await remote.setLoadPrefetch(a.origin==='boot'?{kind:'boot'}:candidate.origin,a.scope,{size:JSON.parse(candidate.vault.describe()).size,signal:protocol.signal});return null;
    }
    case "commitRemoteUpdate": return commitRemoteUpdate(a);
    case "discardRemoteUpdate": if(remoteCandidate?.token===a.token)await dropRemoteCandidate();return null;
    case "exportDisk": return {blob:await prepareSnapshot(a),format:a.format};
    case "publishDisk": if(bootAnalysis)throw fail("OPERATION_FAILED","Finish the load analysis first");return publishDisk(a);
    case "publicationDetails": return publicationDetails(a);
    case "publishUpdate": return publishUpdate(a);
    case "publicationStatus": return publisher?.current()||{active:false,state:"stopped"};
    case "publicationRetry": if(!publisher?.active)throw fail("OPERATION_FAILED","No active publication");return publisher.announce(protocol.signal);
    case "stopSeeding": await publisher?.stop();publisher=undefined;return null;
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
        const {remote,id}=await prepareRemote(a,hex(new Uint8Array(identity.publicKey)));
        try {
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
    case "close": await dropRemoteCandidate();readCapability?.fill(0);readCapability=undefined;stateHashes.clear();await publisher?.stop();publisher=undefined;dropState();bootAnalysis=restoredOrigin=undefined;freshRestore=false;vault.free();vault=undefined;for(const id of [...sources.keys()])await remove(id);identity=current=prepared=undefined;return null;
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
