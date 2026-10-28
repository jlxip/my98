/** Worker-side publication verification and encrypted sources for the Rust Vault. */
import {openTorrentDatabase} from "./torrent-store.js";
import {resolveRecord,boundedBytes} from "./torrent-records.js";
import {verifyMetadata,parseDescriptor,infoHash,unhex} from "./torrent-protocol.js";
import {torrentSources} from "./torrent-sources.js";
import {validateLoadProfiles,sameOrigin} from "./load-profiles.js";
import {StartupPrefetch,startupPrefetchOptions} from "./startup-prefetch.js";

const fail=(code,message)=>Object.assign(new Error(message),{code});
let serial=0;
async function metadataCache(hash,value) {
    const db=await openTorrentDatabase();
    try {
        return await new Promise((resolve,reject)=>{
            const tx=db.transaction(["metadata"],value?"readwrite":"readonly");let result;
            const store=tx.objectStore("metadata"),request=value?store.put({hash,data:value}):store.get(hash);
            request.onsuccess=()=>{result=value||request.result?.data;};
            tx.oncomplete=()=>resolve(result);
            tx.onabort=()=>reject(fail(tx.error?.name==="QuotaExceededError"?"STORAGE_FULL":"STORAGE_ERROR","Could not access torrent metadata storage"));
        });
    } finally {db.close();}
}

export class RemotePublication {
    static async open(io,{publicKey,descriptorInfoHash,owner,sources,prefetchScope="disk",verifySignature,signal}) {
        unhex(owner,32);
        if(publicKey && descriptorInfoHash)throw fail("INVALID_PUBLICATION","Choose a public key or descriptor infohash");
        if(publicKey!==undefined && publicKey!==owner)throw fail("INVALID_PUBLICATION","Publication belongs to a different identity");
        let config=torrentSources(sources);
        let record=null,locationsTask,locationsController;
        const abortLocations=()=>locationsController?.abort(signal?.reason||fail("CANCELLED","Locations lookup cancelled"));
        if(descriptorInfoHash!==undefined)infoHash(descriptorInfoHash);
        else {
            locationsController=new AbortController();
            signal?.addEventListener("abort",abortLocations,{once:true});
            if(signal?.aborted)abortLocations();
            locationsTask=resolveRecord(publicKey||owner,config,verifySignature,
                {signal:locationsController.signal,locations:true}).catch(()=>null);
            try {
                record=await resolveRecord(publicKey||owner,config,verifySignature,{signal});
                if(!record)throw fail("NO_PUBLICATION","No publication was found for this identity");
            } catch(error) {
                abortLocations();signal?.removeEventListener("abort",abortLocations);
                await locationsTask;throw error;
            }
            config=torrentSources({apis:[],trackers:config.trackers,webseeds:[]});
            descriptorInfoHash=record.infoHash;
        }
        const remote=new RemotePublication(io,config);
        remote.scope=prefetchScope;
        remote.locationsTask=locationsTask;
        remote.abortLocations=()=>{abortLocations();signal?.removeEventListener("abort",abortLocations);};
        try {
            await io.call("create",{session:remote.session,sources:config,sourcesPending:!!locationsTask},signal);
            if(locationsTask)remote.locationsTask=locationsTask.then(async locations=>{
                if(remote.closed)return;
                const origins=locationsController.signal.aborted?[]:locations?.origins??[];
                const sources=torrentSources({apis:origins,trackers:config.trackers,webseeds:origins.map(origin=>origin+"/content")});
                await io.call("sources",{session:remote.session,sources});
                remote.sources=sources;
            }).catch(()=>{}).finally(()=>signal?.removeEventListener("abort",abortLocations));
            const root=await remote.torrent(descriptorInfoHash,"descriptor",signal);
            const bytes=await remote.bytes(descriptorInfoHash,0,root.size,signal);
            remote.publication=parseDescriptor(bytes);
            const disk=await remote.torrent(remote.publication.disk,"disk",signal);
            remote.size=disk.size;
            remote.remote={infoHash:disk.infoHash,publicationInfoHash:descriptorInfoHash,publicKey:owner,
                sequence:record?.sequence??null,stateInfoHash:remote.publication.state,profileInfoHash:remote.publication.profile};
            return remote;
        } catch(error) {await remote.close();throw error;}
    }
    constructor(io,sources) {
        this.io=io;this.sources=sources;this.session="torrent:"+(++serial);
        this.metadata=new Map();this.opened=new Set();this.network=new Map();
        this.scope="disk";this.trace=[];this.rangeRequests=0;this.closed=false;
        this.startupJobs=new Map();this.startupSerial=0;
    }
    async metadataFor(hash,kind,signal,startup=false) {
        if(this.metadata.has(hash))return this.metadata.get(hash);
        const cached=await metadataCache(hash);
        if(cached) {
            try {
                const parsed=await verifyMetadata(cached,hash,kind);this.metadata.set(hash,parsed);return parsed;
            } catch {} // Immutable metadata can be safely refetched after cache corruption.
        }
        const data=await this.io.call("metadata",{session:this.session,infoHash:hash,kind,...(startup?{startup:true}:{})},signal);
        const parsed=await verifyMetadata(data,hash,kind);
        await metadataCache(hash,parsed.metadata);this.metadata.set(hash,parsed);return parsed;
    }

    async torrent(hash,kind,signal,startup=false) {
        const parsed=await this.metadataFor(hash,kind,signal,startup);
        if(!this.opened.has(hash)) {
            await this.io.call("open",{session:this.session,infoHash:hash,kind,metadata:parsed.metadata,...(startup?{startup:true}:{})},signal);
            this.opened.add(hash);
        }
        return parsed;
    }
    async bytes(hash,offset,length,signal) {
        if(this.closed)throw fail("CANCELLED","Publication is closed");
        this.rangeRequests++;
        return this.io.call("read",{session:this.session,infoHash:hash,offset,length,
            ...(this.startupRecovery && hash===this.publication.disk?{recover:true}:{})},signal);
    }
    read(offset,length,signal) {return this.bytes(this.publication.disk,offset,length,signal);}
    noteDemand() {}
    traceEvent(type,value) {
        this.trace.push({type,...value});
        if(this.trace.length>2048)this.trace.splice(0,this.trace.length-2048);
    }
    progress(value) {
        if(value?.infoHash)this.network.set(value.infoHash,value);
        this.startupJob?.progress(value);
    }
    startStartupPrefetch(value,{size,signal,onProgress}={}) {
        const options=startupPrefetchOptions(value);
        this.discardStartupPrefetch(this.startupJob?.id);this.startupJobs.clear();
        this.scope="none";this.logicalSize=size;this.startupRecovery=true;
        const id=this.session+":startup:"+(++this.startupSerial);
        const job=new StartupPrefetch({id,options,logicalSize:size,diskSize:this.size,
            stateHash:this.publication.state,profileHash:this.publication.profile,signal,onProgress,
            prepare:async(jobSignal)=>{
                await this.io.call("background",{session:this.session,infoHash:this.publication.disk,enabled:false},jobSignal);
                await this.io.call("stopPrefetch",{session:this.session,infoHash:this.publication.disk},jobSignal);
            },
            loadProfiles:(units,jobSignal)=>this.profiles(units,jobSignal,true),
            prefetch:(args,jobSignal)=>this.io.call("prefetchStartup",{session:this.session,infoHash:this.publication.disk,...args},jobSignal),
            recover:async(kind,jobSignal)=>{
                const hash=this.publication[kind],metadata=this.metadata.get(hash);
                // No verified metadata means the next normal lookup owns opening.
                if(!metadata){this.opened.delete(hash);return;}
                await this.io.call("recover",{session:this.session,infoHash:hash,kind,metadata:metadata.metadata},jobSignal);
            },
            onOutcome:result=>{
                if(this.startupJob!==job || this.closed)return;
                this.scope=result.outcome==="complete"?"profile":"none";
            },
        });
        this.startupJob=job;this.startupJobs.set(id,job);
        for(const snapshot of this.network.values())job.progress(snapshot);
        return id;
    }
    validateStartupPrefetch(id,origin) {
        const job=this.startupJobs.get(id);if(!job)throw fail("INVALID_STATE","Expired startup prefetch");
        this.origin=origin;job.validate(origin);
    }
    commitStartupPrefetch(id) {
        const job=this.startupJobs.get(id);if(!job)throw fail("INVALID_STATE","Expired startup prefetch");
        job.commit();
    }
    waitStartupPrefetch(id) {
        const job=this.startupJobs.get(id);if(!job)return Promise.reject(fail("INVALID_STATE","Expired startup prefetch"));
        return job.result;
    }
    discardStartupPrefetch(id=this.startupJob?.id) {this.startupJobs.get(id)?.cancel();}
    stats() {
        const disk=this.network.get(this.publication?.disk);
        return {infoHash:this.publication?.disk,received:[...this.network.values()].reduce((n,value)=>n+(value.received||0),0),
            rangeRequests:this.rangeRequests,coveredBytes:disk?.coveredBytes||0,totalBytes:this.size,downloaded:disk?.downloaded||0,complete:!!disk?.complete,scope:this.scope};
    }
    async profiles(units,signal,startup=false) {
        const hash=this.publication.profile;
        if(!hash)return [];
        if(this.profileCache?.units===units)return this.profileCache.value;
        const meta=await this.torrent(hash,"profile",signal,startup);
        const bytes=await this.bytes(hash,0,meta.size,signal);
        let value;
        try{value=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}
        catch{throw fail("INVALID_PROFILE","Invalid published load profiles");}
        value=validateLoadProfiles(value,this.publication.disk,units);
        if(!this.publication.state && value.some(profile=>profile.origin.kind==="state"))
            throw fail("INVALID_PROFILE","State load profile has no published state");
        this.profileCache={units,value};return value;
    }
    async setLoadPrefetch(origin,scope,{size,signal}={}) {
        if(!["none","profile","disk","auto"].includes(scope))throw fail("INVALID_PROFILE","Invalid load prefetch scope");
        this.discardStartupPrefetch(this.startupJob?.id);
        this.scope=scope;this.origin=origin;this.logicalSize=size;
        await this.io.call("background",{session:this.session,infoHash:this.publication.disk,enabled:false},signal);
        await this.io.call("stopPrefetch",{session:this.session,infoHash:this.publication.disk},signal);
        if(scope==="none")return;
        if(scope==="auto") {
            try {
                const profiles=await this.profiles(Math.ceil(size/65536),signal);
                scope=profiles.some(value=>sameOrigin(value.origin,origin))?"profile":"disk";
            } catch(error) {
                if(!["INVALID_PROFILE","PUBLICATION_UNAVAILABLE","TRANSPORT_TIMEOUT"].includes(error.code))throw error;
                scope="disk"; // Optional hints cannot prevent reading the disk.
            }
            this.scope=scope;
        }
        if(scope==="profile") {
            const units=Math.ceil(size/65536),profiles=await this.profiles(units,signal);
            const profile=profiles.find(value=>sameOrigin(value.origin,origin));
            if(!profile)throw fail("INVALID_PROFILE","No load profile matches this disk/state");
            const ranges=profile.ranges.filter(Boolean).map(([first,last])=>{
                const begin=198+first*(65536+62);
                return [begin,Math.min(this.size,198+(last+1)*(65536+62))-begin];
            });
            await this.io.call("prefetch",{session:this.session,infoHash:this.publication.disk,ranges},signal);
        }
        if(scope==="disk")await this.io.call("background",{session:this.session,infoHash:this.publication.disk,enabled:true},signal);
    }
    startPrefetch(signal) {
        if(this.scope==="profile")return this.setLoadPrefetch(this.origin,this.scope,{size:this.logicalSize,signal});
        return this.io.call("background",{session:this.session,infoHash:this.publication.disk,enabled:this.scope!=="none"},signal);
    }
    cancel() {
        for(const job of this.startupJobs.values())job.cancel();
        this.io.notify("cancel",{session:this.session});
    }
    async clearCache() {
        this.discardStartupPrefetch(this.startupJob?.id);
        await this.io.call("clear",{session:this.session});this.opened.clear();this.network.clear();
        await this.torrent(this.publication.disk,"disk");
        this.scope="none";
    }
    async stateInput(signal) {
        const hash=this.publication.state;
        if(!hash)throw fail("NO_PUBLISHED_STATE","This publication has no state");
        const meta=await this.torrent(hash,"state",signal),controller=new AbortController();
        const remote=this,pending=[];
        let offset=0,next=0,active=0,stopped=false;
        const finish=()=>signal?.removeEventListener("abort",abort);
        const stop=reason=>{
            if(stopped)return;
            stopped=true;controller.abort(reason);pending.length=0;finish();
        };
        const abort=()=>stop(signal.reason||fail("CANCELLED","Published state cancelled"));
        if(signal?.aborted)throw signal.reason;
        signal?.addEventListener("abort",abort,{once:true});
        // Refill when a request finishes, independently of ordered consumption.
        // Four requests may run at once; retain at most sixteen 256 KiB ranges
        // (4 MiB, including in-flight ranges) so a stalled head stays bounded.
        const fill=()=>{
            while(!stopped && active<4 && pending.length<16 && next<meta.size) {
                const start=next,count=Math.min(262144,meta.size-start);next+=count;active++;
                const read=Promise.resolve().then(()=>remote.bytes(hash,start,count,controller.signal)).then(bytes=>{
                    if(!(bytes instanceof Uint8Array) || bytes.length!==count)
                        throw fail("TRANSPORT_ERROR","Short published state range");
                    return {bytes};
                }).catch(error=>{stop(error);return {error};}).finally(()=>{active--;fill();});
                // Observe every rejection immediately, including reads ahead of
                // the consumer. All pending RPCs share the abort controller.
                pending.push(read);
            }
        };
        return {size:meta.size,stream:new ReadableStream({
            async pull(output) {
                try {
                    if(controller.signal.aborted)throw controller.signal.reason;
                    if(offset===meta.size){finish();output.close();return;}
                    fill();const result=await pending[0];
                    if(controller.signal.aborted)throw controller.signal.reason;
                    if(result.error)throw result.error;
                    pending.shift();offset+=result.bytes.length;output.enqueue(result.bytes);
                    fill();
                } catch(error){stop(error);output.error(error);}
            },
            cancel(reason){stop(reason||fail("CANCELLED","Published state cancelled"));}
        },{highWaterMark:0})};
    }

    async close() {
        if(this.closed)return;
        this.closed=true;this.abortLocations?.();this.cancel();
        try{await this.io.call("close",{session:this.session});}catch{}
        await this.locationsTask;
        this.opened.clear();this.metadata.clear();
    }
}
