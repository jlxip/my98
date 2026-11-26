/** Prepare additions against an authenticated immutable remote disk; no live Vault mutation. */
import {publication_piece_hash,publication_component,publication_catalog} from '../pkg/slop86_disk.js';
import {decodeState} from './state-format.js';
import {validateLoadProfiles,MAX_PROFILE_BYTES} from './load-profiles.js';
import {validateConfig} from '../../browser/machine-config.js';
import {verifyMetadata,metadataInfoHash} from './torrent-protocol.js';
const fail=(code,message)=>Object.assign(new Error(message),{code});
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
export async function copyState(file,{check}) {
    if(!(file instanceof Blob)||file.size<12||file.size>1073741824+65536)throw fail('INVALID_STATE','Invalid state file size');
    const parts=[];
    for(let offset=0;offset<file.size;offset+=1048576){check();parts.push(new Uint8Array(await file.slice(offset,offset+1048576).arrayBuffer()));await tick();}
    check();return new Blob(parts,{type:'application/octet-stream'});
}
export async function authenticateState(vault,input,{compatibility,base,check,progress,signal}) {
    let decoded;
    try {
        decoded=await decodeState(vault,input,{check,progress,signal});
        const m=decoded.metadata;
        if(m.version!==1||typeof m.running!=='boolean'||typeof compatibility!=='string'||!compatibility||m.compatibility!==compatibility)
            throw fail('INVALID_STATE','State requires the same emulator and BIOS build');
        validateConfig(m.config);
        if(m.baseInfoHash!=null&&m.baseInfoHash!==base)throw fail('INVALID_STATE','State belongs to a different published disk');
        const candidate=vault.fork_state(decoded.overlay);candidate.free();
        return decoded.stateSha256;
    } finally {decoded?.overlay.fill(0);if(decoded?.state)new Uint8Array(decoded.state).fill(0);}
}
export async function component(blob,kind,trackers,{check,progress}) {
    const hashes=new Uint8Array(Math.ceil(blob.size/262144)*20);
    progress('hash',0,blob.size);await tick();check();
    for(let offset=0,index=0;offset<blob.size;offset+=262144,index++){
        check();hashes.set(publication_piece_hash(new Uint8Array(await blob.slice(offset,offset+262144).arrayBuffer())),index*20);
        progress('hash',Math.min(offset+262144,blob.size),blob.size);await tick();
    }
    check();const metadata=publication_component(blob.size,hashes,kind,JSON.stringify(trackers));return {kind,blob,metadata,infoHash:await metadataInfoHash(metadata)};
}
export async function prepareUpdate(remote,args,context) {
    const {vault,publicKey,trackers,check,progress,signal,compatibility,logicalSize,stateHashes}=context;
    const base=remote.publication.disk,parts=new Map();
    for(const kind of ['disk','state','profile']) {
        const hash=remote.publication[kind];if(!hash)continue;
        const meta=await remote.metadataFor(hash,kind,signal);
        parts.set(kind,{kind,infoHash:hash,metadata:meta.metainfo||meta.metadata});
    }
    const profiles=await remote.profiles(Math.ceil(logicalSize/65536),signal);
    let next=profiles.map(p=>structuredClone(p)),stateHash;
    const validate=async input=>authenticateState(vault,input,{compatibility,base,check,progress,signal});
    const cacheKey=hash=>base+':'+hash+':'+compatibility;
    const remember=(hash,sha)=>{stateHashes.set(cacheKey(hash),sha);while(stateHashes.size>16)stateHashes.delete(stateHashes.keys().next().value);};
    const publishedStateHash=async()=>{
        const hash=parts.get('state')?.infoHash,key=cacheKey(hash);
        if(stateHashes.has(key))return stateHashes.get(key);
        const value=await validate(await remote.stateInput(signal));remember(hash,value);return value;
    };
    if(args.action==='state') {
        const file=await copyState(args.file,{check});stateHash=await validate(file);
        const part=await component(file,'state',trackers,{check,progress});parts.set('state',part);remember(part.infoHash,stateHash);
        next=next.filter(p=>p.origin.kind!=='state');
    } else if(args.action==='remove-state') {
        parts.delete('state');next=next.filter(p=>p.origin.kind!=='state');
    } else if(args.action==='profiles') {
        if(!Array.isArray(args.remove)||args.remove.some(k=>!['boot','state'].includes(k)))throw fail('INVALID_PROFILE','Invalid profile removal');
        if(!Array.isArray(args.profiles)||new TextEncoder().encode(JSON.stringify(args.profiles)).length>MAX_PROFILE_BYTES)throw fail('INVALID_PROFILE','Invalid load profiles');
        const incoming=validateLoadProfiles(args.profiles,base,Math.ceil(logicalSize/65536));
        if(incoming.some(p=>p.origin.kind==='state')) {
            if(!parts.has('state'))throw fail('INVALID_PROFILE','State load profile has no published state');
            stateHash=await publishedStateHash();
            if(incoming.some(p=>p.origin.kind==='state'&&p.origin.sha256!==stateHash))throw fail('INVALID_PROFILE','Profile does not match the published state');
        }
        const replaced=new Set([...args.remove,...incoming.map(p=>p.origin.kind)]);
        next=[...next.filter(p=>!replaced.has(p.origin.kind)),...incoming];
    } else throw fail('INVALID_PUBLICATION','Invalid publication update');
    if(next.some(p=>p.origin.kind==='state')) {
        if(!parts.has('state'))throw fail('INVALID_PROFILE','State load profile has no published state');
        stateHash??=await publishedStateHash();
        if(next.some(p=>p.origin.kind==='state'&&p.origin.sha256!==stateHash))throw fail('INVALID_PROFILE','Profile does not match the published state');
    }
    if(JSON.stringify(next)!==JSON.stringify(profiles)) {
        if(next.length){const blob=new Blob([JSON.stringify(next)+'\n']);if(blob.size>MAX_PROFILE_BYTES)throw fail('INVALID_PROFILE','Load profiles exceed 64 KiB');parts.set('profile',await component(blob,'profile',trackers,{check,progress}));}
        else parts.delete('profile');
    }
    const ordered=['disk','state','profile'].filter(k=>parts.has(k)).map(k=>parts.get(k));
    // Reused metadata is independently verified before it can enter a new catalog.
    for(const part of ordered)if(part.infoHash)await verifyMetadata(part.metadata,part.infoHash,part.kind);
    const catalog=JSON.parse(publication_catalog(JSON.stringify(ordered.map(({kind,metadata})=>({kind,metadata:Array.from(metadata)}))),publicKey,JSON.stringify(trackers)));
    return {infoHash:catalog.infoHash,parts:[...ordered,{kind:'catalog',metadata:new Uint8Array(catalog.catalogMetadata),blob:new Blob([new Uint8Array(catalog.catalogPayload)])}]};
}
