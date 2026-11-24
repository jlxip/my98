import {TorrentPieceStore,clearTorrentCache} from "./torrent-store.js";
import {verifyMetadata,infoHash,COMPONENT_NAMES} from "./torrent-protocol.js";
import {torrentSources,DEFAULT_TORRENT_SOURCES} from "./torrent-sources.js";
import {PublicationReplicas} from "./publication-replicas.js";
export {torrentSources} from "./torrent-sources.js";

const fail=(code,message)=>Object.assign(new Error(message),{code});
const cancelled = signal => signal?.reason || fail("CANCELLED","Torrent operation cancelled");
// Abort one caller without cancelling an immutable component recovery shared by
// another reader. The underlying promise is always observed after cancellation.
function waitFor(promise,signal) {
    if(signal?.aborted){void promise.catch(()=>{});return Promise.reject(cancelled(signal));}
    if(!signal)return promise;
    return new Promise((resolve,reject)=>{
        const abort=()=>{cleanup();reject(cancelled(signal));};
        const cleanup=()=>signal.removeEventListener("abort",abort);
        signal.addEventListener("abort",abort,{once:true});
        promise.then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
        if(signal.aborted)abort();
    });
}
const bitCounts=Uint8Array.from({length:256},(_,value)=>{
    let count=0;for(;value;value&=value-1)count++;return count;
});
let factory;
async function webTorrentFactory() {
    factory ||= import(new URL("../../torrent/webtorrent.min.js",import.meta.url).href).then(module=>{
        if(typeof module.default!=="function")throw fail("TRANSPORT_ERROR","WebTorrent could not initialize");
        return module.default;
    }).catch(cause=>{factory=undefined;throw fail("TRANSPORT_ERROR","WebTorrent could not load: "+cause.message);});
    return factory;
}

/** Window owns WebTorrent and ciphertext I/O. No identity, capability or plaintext. */
export class WindowTorrents {
    constructor({sources=DEFAULT_TORRENT_SOURCES,clientFactory=webTorrentFactory,store=TorrentPieceStore,onProgress=()=>{},timeout=60000}={}) {
        this.sources=torrentSources(sources);this.clientFactory=clientFactory;this.store=store;
        this.onProgress=onProgress;this.timeout=timeout;this.entries=new Map();this.opening=new Map();
        this.closed=false;this.epoch=0;this.discoveries=new Set();this.recovering=new Map();this.openingJobs=new Map();this.componentMetadata=new Map();this.probes=new Map();
    }
    setSources(sources) {this.sources=torrentSources(sources);}
    trackPublication(root) {
        this.replicas=new PublicationReplicas(root,replicas=>this.onProgress({replicas}));
    }
    async initialize() {
        if(this.closed)throw fail("CANCELLED","Torrent transport is closed");
        if(!this.clientPromise)this.clientPromise=(async()=>{
            const WebTorrent=await this.clientFactory();
            if(this.closed)throw fail("CANCELLED","Torrent transport is closed");
            this.webRTC=WebTorrent.WEBRTC_SUPPORT!==false;
            this.client=new WebTorrent({dht:false,lsd:false,utp:false,maxConns:8,
                webSeeds:false,tracker:this.sources.trackers.length?{}:false});
            this.client.on("error",error=>{for(const entry of this.entries.values())this.failed(entry,error);});
            return this.client;
        })();
        return this.clientPromise;
    }
    /** Seed only Worker-produced immutable bytes with their Rust-computed piece hashes.
     * This is not the remote/cache reader: that path always uses skipVerify:false.
     * Rehashing the same prepared Blob in WebTorrent duplicates preparation and
     * can strand its async verification callback in Gecko during repeated seeds. */
    async seedPrepared({metadata,blob,kind},signal) {
        if(!(blob instanceof Blob))throw fail("INVALID_PUBLICATION","Expected an immutable ciphertext snapshot");
        const client=await waitFor(this.initialize(),signal);
        const debug={reads:0,completed:0,verified:0,ready:false,preverified:true};
        (this.seedDebug||=Object.create(null))[kind]=debug;
        class BlobStore {
            constructor(length){this.length=length;this.chunkLength=length;}
            get(index,options,callback){
                if(typeof options==="function"){callback=options;options={};}
                const offset=options?.offset??0,start=index*this.length+offset,n=options?.length??Math.min(this.length-offset,blob.size-start);
                if(!Number.isSafeInteger(index)||index<0||start>=blob.size||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(n)||n<0||offset+n>this.length||start+n>blob.size){queueMicrotask(()=>callback(Error("Invalid snapshot range")));return;}
                debug.reads++;
                blob.slice(start,start+n).arrayBuffer().then(bytes=>{debug.completed++;callback(null,new Uint8Array(bytes));},error=>{debug.error=error.message;callback(error);});
            }
            put(index,bytes,callback){queueMicrotask(()=>callback(Error("Immutable seed")));}
            close(callback){queueMicrotask(()=>callback?.());}
            destroy(callback){this.close(callback);}
        }
        return await new Promise((resolve,reject)=>{
            let torrent,done=false;
            const finish=error=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener("abort",abort);if(error){torrent?.destroy({destroyStore:true},()=>{});reject(error);}else resolve({infoHash:torrent.infoHash});};
            const abort=()=>finish(cancelled(signal)),timer=setTimeout(()=>finish(fail("TRANSPORT_TIMEOUT","Snapshot verification timed out")),300000);
            signal?.addEventListener("abort",abort,{once:true});
            torrent=client.add(new Uint8Array(metadata),{announce:this.sources.trackers,urlList:[],getAnnounceOpts:()=>({numwant:1}),store:BlobStore,storeCacheSlots:0,skipVerify:true,deselect:true});
            torrent.once("error",finish);torrent.on("error",error=>this.onProgress({error:{code:"TRANSPORT_ERROR",message:error.message}}));
            const ready=()=>queueMicrotask(()=>{
                debug.ready=true;debug.verified=torrent.pieces.length;
                this.replicas?.add(kind,torrent);
                if(torrent.length!==blob.size||!torrent.done)finish(fail("CORRUPTION","Prepared snapshot length does not match its torrent"));else finish();
            });
            torrent.once("ready",ready);if(torrent.ready)ready();
            if(signal?.aborted)abort();
        });
    }
    failed(entry,error) {
        entry.error=error;
        for(const controller of entry.readers)controller.abort(error);
        entry.prefetch?.abort(error);
        for(const controller of entry.startupPrefetches||[])controller.abort(error);
        if(error.code!=="CANCELLED")this.onProgress({...this.describe(entry),error:{code:error.code||"TRANSPORT_ERROR",message:error.message}});
    }
    progress(entry,force=false) {
        const now=performance.now();
        if(!force && now-(entry.progressAt??-Infinity)<250)return;
        entry.progressAt=now;this.onProgress(this.describe(entry));
    }
    async open({infoHash:hash,metadata,kind},signal) {
        infoHash(hash);
        if(signal?.aborted)throw cancelled(signal);
        if(this.closed || this.clearing)throw fail("CANCELLED","Torrent transport is closed or clearing its cache");
        let job=this.openingJobs.get(hash);
        if(job?.controller.signal.aborted) {
            await waitFor(job.promise.catch(()=>{}),signal);
            return this.open({infoHash:hash,metadata,kind},signal);
        }
        if(!job) {
            if(this.entries.has(hash))return this.describe(this.entry(hash));
            job={controller:new AbortController(),waiters:0,settled:false};
            job.promise=Promise.resolve().then(async()=>{
                const data=metadata??await this.discoverMetadata(hash,kind,job.controller.signal);
                if(job.controller.signal.aborted)throw cancelled(job.controller.signal);
                return this.add(hash,data,kind,job.controller.signal);
            }).finally(async()=>{
                const probe=this.probes.get(hash);
                if(probe){this.probes.delete(hash);if(!probe.destroyed)await new Promise(r=>probe.destroy({destroyStore:false},r));}
                job.settled=true;
                if(this.openingJobs.get(hash)===job){this.openingJobs.delete(hash);this.opening.delete(hash);}
            });
            this.openingJobs.set(hash,job);this.opening.set(hash,job.promise);
        }
        job.waiters++;
        try{return await waitFor(job.promise,signal);}
        finally {
            job.waiters--;
            if(!job.waiters && !job.settled)job.controller.abort(fail("CANCELLED","Torrent opening has no readers"));
        }
    }
    async discoverMetadata(hash,kind,signal) {
        const client=await waitFor(this.initialize(),signal),controller=new AbortController(),epoch=this.epoch;
        const abort=()=>controller.abort(cancelled(signal));
        signal?.addEventListener("abort",abort,{once:true});
        if(signal?.aborted)abort();
        this.discoveries.add(controller);let probe,gate;
        try {
            if(!this.sources.trackers.length)throw fail("PUBLICATION_UNAVAILABLE","No WebRTC signaling is configured");
            return await new Promise((resolve,reject)=>{
                let settled=false,timer;
                const finish=fn=>value=>{
                    if(settled)return;settled=true;clearTimeout(timer);controller.signal.removeEventListener("abort",aborted);fn(value);
                };
                const aborted=()=>finish(reject)(controller.signal.reason||fail("CANCELLED","Metadata lookup cancelled"));
                if(controller.signal.aborted){aborted();return;}
                controller.signal.addEventListener("abort",aborted,{once:true});
                timer=setTimeout(()=>finish(reject)(fail("TRANSPORT_TIMEOUT","WebRTC metadata lookup timed out")),this.timeout);
                const Store=class {
                    get(index,options,callback){if(typeof options==="function")callback=options;queueMicrotask(()=>callback(Object.assign(Error("Metadata only"),{code:"ENOENT"})));}
                    put(index,bytes,callback){queueMicrotask(()=>callback(Error("Metadata discovery cannot write payload")));}
                    close(callback){queueMicrotask(()=>callback?.());}
                    destroy(callback){this.close(callback);}
                };
                // The catalog stays on its discovery wire. Store operations
                // wait until our metadata/role checks succeed; nothing is selected.
                const transport=this;
                class CatalogStore {
                    constructor(chunkLength,options){this.chunkLength=chunkLength;this.options=options;this.queue=[];this.closed=false;gate=this;}
                    perform(method,args){
                        const callback=args.at(-1);
                        if(this.closed){queueMicrotask(()=>callback(fail("CANCELLED","Catalog store closed")));return;}
                        if(this.delegate)this.delegate[method](...args);
                        else if(this.queue.length<4096)this.queue.push([method,args]);
                        else queueMicrotask(()=>callback(fail("INVALID_PUBLICATION","Too many pending catalog operations")));
                    }
                    get(...args){this.perform("get",args);}
                    put(...args){this.perform("put",args);}
                    activate(){
                        if(this.closed)throw fail("CANCELLED","Catalog store closed");
                        this.delegate=new transport.store(this.chunkLength,{...this.options,ramBytes:2*1024*1024});
                        for(const [method,args] of this.queue.splice(0))this.delegate[method](...args);
                    }
                    close(callback){
                        this.closed=true;
                        for(const [,args] of this.queue.splice(0))queueMicrotask(()=>args.at(-1)(fail("CANCELLED","Catalog store closed")));
                        if(this.delegate)this.delegate.close(callback);else queueMicrotask(()=>callback?.());
                    }
                    destroy(callback){this.close(callback);}
                }
                try {
                    probe=client.add(hash,{announce:this.sources.trackers,getAnnounceOpts:()=>({numwant:1}),urlList:[],store:kind==="catalog"?CatalogStore:Store,storeCacheSlots:0,deselect:true,skipVerify:false,destroyStoreOnDestroy:false});
                    probe.once("error",finish(reject));
                    probe.once("metadata",()=>{void verifyMetadata(new Uint8Array(probe.metadata),hash,kind).then(value=>{
                        if(this.closed || epoch!==this.epoch)throw fail("CANCELLED","Metadata lookup cancelled");
                        if(kind==="catalog"){gate.activate();this.probes.set(hash,probe);}
                        finish(resolve)(value.metadata);
                    }).catch(finish(reject));});
                }catch(error){finish(reject)(error);}
            });
        } finally {
            controller.abort(fail("CANCELLED","Metadata lookup finished"));
            signal?.removeEventListener("abort",abort);
            try{if(probe && this.probes.get(hash)!==probe && !probe.destroyed)await new Promise(resolve=>probe.destroy({destroyStore:false},resolve));}
            finally{this.discoveries.delete(controller);}
        }
    }
    async add(hash,metadata,kind,signal) {
        const epoch=this.epoch,parsed=await verifyMetadata(metadata,hash,kind);
        if(signal?.aborted)throw cancelled(signal);
        // Keep verified immutable metadata independently of a live torrent: a
        // failed reopen must not leave later demand without a recovery source.
        this.componentMetadata.set(hash,{metadata:parsed.metadata,kind});
        const client=await waitFor(this.initialize(),signal);
        if(signal?.aborted)throw cancelled(signal);
        if(this.closed || epoch!==this.epoch)throw fail("CANCELLED","Torrent opening was cancelled");
        return await new Promise((resolve,reject)=>{
            const entry={...parsed,metadata:parsed.metadata,readers:new Set(),background:false,paused:false,rescanned:false};
            const adopted=this.probes.get(hash);this.probes.delete(hash);
            if(adopted?.destroyed)throw fail("TRANSPORT_ERROR","Catalog peer disconnected before adoption");
            const torrent=adopted||client.add(parsed.metadata,{announce:this.sources.trackers,
                // Only configured WebRTC peers and verified cache provide bytes.
                urlList:[],
                getAnnounceOpts:()=>({numwant:1}),
                store:this.store,storeOpts:{ramBytes:2*1024*1024},storeCacheSlots:0,
                deselect:true,skipVerify:false,
                // A state is consumed immediately: verify its persistent cache
                // before ready, so demand never races an empty startup bitfield.
                ...(kind==="state"?{}:{bitfield:new Uint8Array(Math.ceil(parsed.pieces/8))}),
                destroyStoreOnDestroy:false});
            entry.torrent=torrent;this.entries.set(hash,entry);
            let settled=false;
            const detach=()=>{signal?.removeEventListener("abort",abortOpening);};
            const abortOpening=()=>{
                if(settled)return;settled=true;clearTimeout(timer);detach();
                reject(cancelled(signal));
                if(this.entries.get(hash)===entry)void this.remove(hash);
            };
            const timer=setTimeout(()=>{settled=true;detach();const error=fail("TRANSPORT_TIMEOUT","Torrent storage initialization timed out");this.failed(entry,error);reject(error);if(this.entries.get(hash)===entry)void this.remove(hash);},this.timeout);
            signal?.addEventListener("abort",abortOpening,{once:true});
            torrent.on("error",error=>{this.failed(entry,error);if(!settled){clearTimeout(timer);settled=true;detach();reject(error);}});
            torrent.on("download",bytes=>{entry.receivedData=(entry.receivedData||0)+bytes;this.progress(entry);});
            torrent.on("verified",()=>{this.progress(entry);});
            torrent.on("done",()=>this.progress(entry,true));
            torrent.once("close",()=>{

                const error=entry.error||fail("CANCELLED","Torrent closed");
                this.failed(entry,error);
                if(!settled){clearTimeout(timer);settled=true;detach();reject(error);}
            });
            const ready=()=>{
                clearTimeout(timer);if(settled)return;settled=true;detach();
                if(epoch!==this.epoch || this.closed){reject(fail("CANCELLED","Torrent opening was cancelled"));void this.remove(hash);return;}
                if(kind==="state") {
                    entry.rescanned=true;this.backgroundSelection(entry);
                } else {
                    // Keep large disks lazy. Hash-check the cache in the background;
                    // opt-in startup can also verify its own target pieces.
                    this.rescanCachedPieces(entry);
                }
                resolve(this.describe(entry));
            };
            torrent.once("ready",ready);
            if(torrent.ready)queueMicrotask(ready);
            if(signal?.aborted)abortOpening();
        });
    }
    entry(hash) {
        const entry=this.entries.get(hash);
        if(entry?.error)throw entry.error;
        if(!entry || entry.torrent.destroyed)throw fail("TRANSPORT_ERROR","Torrent is unavailable");
        return entry;
    }
    describe(entry) {
        const torrent=entry.torrent;
        // downloaded includes received fragments awaiting verification. Progress
        // counts only WebTorrent's verified bits, including the short last piece.
        const bits=torrent?.bitfield,bytes=bits?.buffer;
        const first=Math.floor(entry.payloadOffset/entry.pieceLength),last=Math.ceil((entry.payloadOffset+entry.size)/entry.pieceLength);
        let verified=0;
        for(let index=Math.floor(first/8);bytes && index<Math.ceil(last/8);index++) {
            let mask=255;
            if(index===Math.floor(first/8))mask&=255>>(first%8);
            if(index===Math.ceil(last/8)-1 && last%8)mask&=255<<(8-last%8);
            verified+=bitCounts[(bytes[index]||0)&mask];
        }
        const coveredBytes=verified*entry.pieceLength-
            (bits?.get(first)?entry.payloadOffset-first*entry.pieceLength:0)-
            (bits?.get(last-1)?last*entry.pieceLength-entry.payloadOffset-entry.size:0);
        return {infoHash:entry.infoHash,kind:entry.kind,filename:entry.filename,size:entry.size,
            pieces:entry.pieces,downloaded:torrent?.downloaded||0,coveredBytes,complete:coveredBytes===entry.size,
            received:entry.receivedData||0};
    }
    async recover({infoHash:hash,metadata,kind},signal) {
        if(signal?.aborted)throw cancelled(signal);
        if(this.closed || this.clearing)throw fail("CANCELLED","Torrent transport is closed or clearing its cache");
        const existing=this.recovering.get(hash);
        if(existing)return waitFor(existing,signal);
        const entry=this.entries.get(hash);
        if(entry && !entry.error && !entry.torrent.destroyed)return this.describe(entry);
        if(entry?.metadata)this.componentMetadata.set(hash,{metadata:entry.metadata,kind:entry.kind});
        const known=this.componentMetadata.get(hash);
        metadata ||= known?.metadata;kind ||= known?.kind;
        if(!metadata || !kind)throw fail("TRANSPORT_ERROR","No immutable metadata is available for recovery");
        const promise=(async()=>{
            if(entry)await this.remove(hash);
            return this.open({infoHash:hash,metadata,kind});
        })();
        this.recovering.set(hash,promise);
        void promise.finally(()=>{if(this.recovering.get(hash)===promise)this.recovering.delete(hash);}).catch(()=>{});
        return waitFor(promise,signal);
    }
    rescanCachedPieces(entry) {
        const torrent=entry.torrent,original=torrent._verifyPiece;
        const scan={targets:new Set(),versions:new Map(),active:true};entry.cacheScan=scan;
        const verified=index=>scan.versions.set(index,(scan.versions.get(index)||0)+1);
        // A background store read can finish after a foreground download. The
        // pinned rescan would otherwise mark its stale negative as unverified.
        // Protect opt-in targets only when a newer verification of that exact
        // piece occurred; a real negative without newer evidence stays invalid.
        const guarded=function(index,callback) {
            const version=scan.versions.get(index)||0;
            original.call(this,index,(error,valid)=>{
                if(!error && !valid && scan.active && scan.targets.has(index) &&
                    torrent.bitfield.get(index) && (scan.versions.get(index)||0)!==version)valid=true;
                callback(error,valid);
            });
        };
        const finish=error=>{
            scan.active=false;torrent.off("verified",verified);
            if(torrent._verifyPiece===guarded)torrent._verifyPiece=original;
            if(entry.cacheScan===scan)entry.cacheScan=undefined;
            if(torrent.destroyed)return;
            if(error){this.failed(entry,error);return;}
            entry.rescanned=true;this.backgroundSelection(entry);
        };
        torrent.on("verified",verified);torrent._verifyPiece=guarded;
        try{torrent.rescanFiles(finish);}catch(error){finish(error);}
    }
    async verifyCachedPieces(entry,indices,signal,windowPieces=8) {
        for(const index of indices)entry.cacheScan?.targets.add(index);
        const torrent=entry.torrent;let cursor=0;
        await Promise.all(Array.from({length:Math.min(windowPieces,indices.length)},async()=>{
            for(;;) {
                const position=cursor++;if(position>=indices.length)return;
                const index=indices[position];
                if(signal?.aborted)throw cancelled(signal);
                if(torrent.bitfield.get(index))continue;
                entry.cacheChecks ||= new Map();
                let check=entry.cacheChecks.get(index);
                if(!check) {
                    check=new Promise((resolve,reject)=>torrent._verifyPiece(index,(error,valid)=>error?reject(error):resolve(valid)));
                    entry.cacheChecks.set(index,check);
                    void check.finally(()=>{if(entry.cacheChecks.get(index)===check)entry.cacheChecks.delete(index);}).catch(()=>{});
                }
                const valid=await waitFor(check,signal);
                if(signal?.aborted)throw cancelled(signal);
                if(this.entries.get(entry.infoHash)!==entry || torrent.destroyed)throw fail("CANCELLED","Torrent was replaced");
                if(valid && !torrent.bitfield.get(index))torrent._markVerified(index);
            }
        }));
    }
    async read({infoHash:hash,offset,length,recover=false},signal) {
        if(recover)await this.recover({infoHash:hash},signal);
        const entry=this.entry(hash);
        if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||offset<0||length<0||
            length>1024*1024||offset+length>entry.size)throw fail("INVALID_RANGE","Invalid ciphertext range");
        if(signal?.aborted)throw signal.reason;
        if(!length)return new Uint8Array();
        const controller=new AbortController();entry.readers.add(controller);let reader;
        const abort=()=>controller.abort(signal.reason||fail("CANCELLED","Ciphertext read cancelled"));
        signal?.addEventListener("abort",abort,{once:true});
        const timer=setTimeout(()=>controller.abort(fail("TRANSPORT_TIMEOUT","Ciphertext range timed out")),this.timeout);
        const cancel=()=>{void reader?.cancel(controller.signal.reason).catch(()=>{});};
        controller.signal.addEventListener("abort",cancel,{once:true});
        try {
            if(recover) {
                const first=Math.floor((offset+entry.payloadOffset)/entry.pieceLength),last=Math.floor((offset+entry.payloadOffset+length-1)/entry.pieceLength);
                await this.verifyCachedPieces(entry,Array.from({length:last-first+1},(_,index)=>first+index),controller.signal);
            }
            if(controller.signal.aborted)throw controller.signal.reason;
            entry.paused=false;entry.torrent.resume();
            const output=new Uint8Array(length);let copied=0;
            while(copied<length) {
                const wireOffset=entry.payloadOffset+offset+copied;
                const file=entry.torrent.files.find(f=>f.offset<=wireOffset && wireOffset<f.offset+f.length);
                if(!file)throw fail("TRANSPORT_ERROR","Missing torrent range");
                const start=wireOffset-file.offset,take=Math.min(length-copied,file.length-start);
                // Upstream treats end=0 as unspecified.
                const end=Math.max(start+take-1,Math.min(1,file.length-1));
                reader=file.stream({start,end}).getReader();let consumed=0;
                try {
                    while(consumed<take) {
                        if(controller.signal.aborted)throw controller.signal.reason;
                        const {done,value}=await reader.read();
                        if(controller.signal.aborted)throw controller.signal.reason;
                        if(done)throw fail("TRANSPORT_ERROR","Short ciphertext range");
                        const count=Math.min(value.length,take-consumed);
                        output.set(value.subarray(0,count),copied+consumed);consumed+=count;
                    }
                }finally{await reader.cancel().catch(()=>{});reader.releaseLock();reader=undefined;}
                copied+=take;
            }
            return output;
        } finally {
            clearTimeout(timer);signal?.removeEventListener("abort",abort);
            controller.signal.removeEventListener("abort",cancel);
            if(reader){await reader.cancel().catch(()=>{});reader.releaseLock();}
            entry.readers.delete(controller);
        }
    }
    backgroundSelection(entry) {
        if(entry.torrent.destroyed || entry.paused || entry.prefetch || entry.startupPrefetches?.size)return;
        if(entry.background && entry.rescanned && !entry.prefetch)
            entry.torrent.select(0,entry.pieces-1,0);
        else entry.torrent.deselect(0,entry.pieces-1);
    }
    setBackground(hash,enabled) {
        const entry=this.entry(hash);entry.background=!!enabled;
        if(enabled){entry.paused=false;entry.torrent.resume();}
        this.backgroundSelection(entry);
    }
    async stopPrefetch(hash) {
        const entry=this.entry(hash);
        entry.prefetch?.abort(fail("CANCELLED","Prefetch replaced"));
        await entry.prefetchTask?.catch(()=>{});
    }
    async prefetch(hash,ranges) {
        const entry=this.entry(hash);
        entry.prefetch?.abort(fail("CANCELLED","Prefetch replaced"));
        await entry.prefetchTask?.catch(()=>{});
        entry.torrent.deselect(0,entry.pieces-1);
        const controller=new AbortController();entry.prefetch=controller;
        const timer=setTimeout(()=>controller.abort(fail("TRANSPORT_TIMEOUT","Torrent prefetch timed out")),this.timeout);
        entry.paused=false;entry.torrent.resume();this.backgroundSelection(entry);
        entry.prefetchTask=(async()=>{
            for(const [offset,length] of ranges) {
                if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||offset<0||length<1||offset+length>entry.size)
                    throw fail("INVALID_RANGE","Invalid prefetch range");
                const first=Math.floor((offset+entry.payloadOffset)/entry.pieceLength),last=Math.floor((offset+entry.payloadOffset+length-1)/entry.pieceLength);
                entry.torrent.select(first,last,0);
                try {
                    for(let index=first;index<=last;index++) {
                        if(controller.signal.aborted)throw controller.signal.reason;
                        if(entry.torrent.bitfield.get(index))continue;
                        await new Promise((resolve,reject)=>{
                            const done=i=>{if(i===index){cleanup();resolve();}};
                            const abort=()=>{cleanup();reject(controller.signal.reason);};
                            const cleanup=()=>{entry.torrent.off("verified",done);controller.signal.removeEventListener("abort",abort);};
                            entry.torrent.on("verified",done);controller.signal.addEventListener("abort",abort,{once:true});
                            if(controller.signal.aborted)abort();
                            else if(entry.torrent.bitfield.get(index)){cleanup();resolve();}
                        });
                    }
                } finally {if(!entry.torrent.destroyed)entry.torrent.deselect(first,last);}
            }
        })();
        try{await entry.prefetchTask;}
        finally {
            clearTimeout(timer);
            if(entry.prefetch===controller){entry.prefetch=undefined;this.backgroundSelection(entry);this.progress(entry,true);}
        }
    }
    // Startup owns distinct stream selections. Public select/deselect merges
    // non-stream ranges and cannot safely release just this job's ownership.
    async prefetchStartup({infoHash:hash,id,ranges,windowPieces=8},signal) {
        const entry=this.entry(hash),torrent=entry.torrent;
        if(signal?.aborted)throw cancelled(signal);
        if(!Array.isArray(ranges) || !Number.isSafeInteger(windowPieces) || windowPieces<1 || windowPieces>32)
            throw fail("INVALID_RANGE","Invalid startup prefetch window");
        const targets=new Set();
        for(const range of ranges) {
            if(!Array.isArray(range) || range.length!==2)throw fail("INVALID_RANGE","Invalid startup prefetch range");
            const [offset,length]=range;
            if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||offset<0||length<1||offset+length>entry.size)
                throw fail("INVALID_RANGE","Invalid startup prefetch range");
            for(let index=Math.floor((offset+entry.payloadOffset)/entry.pieceLength);index<=Math.floor((offset+entry.payloadOffset+length-1)/entry.pieceLength);index++)targets.add(index);
        }
        const indices=[...targets],bytes=index=>Math.max(0,Math.min((index+1)*entry.pieceLength,entry.payloadOffset+entry.size)-Math.max(index*entry.pieceLength,entry.payloadOffset));
        const total=indices.reduce((n,index)=>n+bytes(index),0);
        const snapshot=()=>({completed:indices.reduce((n,index)=>n+(torrent.bitfield.get(index)?bytes(index):0),0),total});
        let lastCompleted=-1;
        const report=()=>{
            const value=snapshot();
            if(value.completed!==lastCompleted){lastCompleted=value.completed;this.onProgress({...this.describe(entry),startupPrefetch:{id,...value}});}
            return value;
        };
        const controller=new AbortController(),abort=()=>controller.abort(cancelled(signal));
        entry.startupPrefetches ||= new Set();entry.startupPrefetches.add(controller);
        signal?.addEventListener("abort",abort,{once:true});
        const timer=setTimeout(()=>controller.abort(fail("TRANSPORT_TIMEOUT","Startup prefetch timed out")),this.timeout);
        const owned=new Map();
        const release=index=>{
            const owner=owned.get(index);if(!owner)return;
            owned.delete(index);
            if(torrent.destroyed)return;
            for(const selection of torrent._selections)if(selection.notify===owner){selection.remove();break;}
            torrent._updateSelections();
        };
        try {
            if(signal?.aborted)abort();
            report();
            // Check only target pieces before selecting them. A warm disk's
            // background scan may not yet have reached these scattered ranges.
            await this.verifyCachedPieces(entry,indices,controller.signal,windowPieces);
            if(controller.signal.aborted)throw cancelled(controller.signal);
            report();
            entry.paused=false;torrent.resume();
            return await new Promise((resolve,reject)=>{
                let finished=false,next=0,pumping=false,again=false;
                const cleanup=()=>{torrent.off("verified",verified);controller.signal.removeEventListener("abort",aborted);};
                const finish=error=>{
                    if(finished)return;finished=true;cleanup();
                    error?reject(error):resolve(report());
                };
                const pump=()=>{
                    if(finished)return;
                    if(pumping){again=true;return;}
                    pumping=true;
                    try {
                        do {
                            again=false;
                            if(controller.signal.aborted){finish(cancelled(controller.signal));break;}
                            for(const index of [...owned.keys()])if(torrent.bitfield.get(index))release(index);
                            while(owned.size<windowPieces && next<indices.length) {
                                const index=indices[next++];if(torrent.bitfield.get(index))continue;
                                const owner=()=>{};owned.set(index,owner);
                                torrent._select(index,index,0,owner,true);
                            }
                            const value=report();if(value.completed===total)finish();
                        } while(again && !finished);
                    } catch(error){finish(error);}
                    finally{pumping=false;}
                };
                const verified=index=>{if(targets.has(index))pump();};
                const aborted=()=>finish(cancelled(controller.signal));
                torrent.on("verified",verified);controller.signal.addEventListener("abort",aborted,{once:true});
                pump();
            });
        } finally {
            clearTimeout(timer);signal?.removeEventListener("abort",abort);
            for(const index of [...owned.keys()])release(index);
            entry.startupPrefetches.delete(controller);
        }
    }
    cancel() {
        this.epoch++;
        for(const job of this.openingJobs.values())job.controller.abort(fail("CANCELLED","Torrent opening cancelled"));
        for(const controller of this.discoveries)controller.abort(fail("CANCELLED","Metadata lookup cancelled"));
        for(const entry of this.entries.values()) {
            for(const controller of entry.readers)controller.abort(fail("CANCELLED","Torrent read cancelled"));
            entry.prefetch?.abort(fail("CANCELLED","Torrent prefetch cancelled"));
            for(const controller of entry.startupPrefetches||[])controller.abort(fail("CANCELLED","Startup prefetch cancelled"));
            entry.paused=true;
            if(!entry.torrent.destroyed){entry.torrent.deselect(0,entry.pieces-1);entry.torrent.pause();}
        }
    }
    async remove(hash) {
        const entry=this.entries.get(hash);if(!entry)return;

        this.entries.delete(hash);
        this.failed(entry,fail("CANCELLED","Torrent closed"));
        if(!entry.torrent.destroyed)await new Promise(resolve=>entry.torrent.destroy({destroyStore:false},resolve));
    }
    async clearCaches() {
        this.clearing=true;this.cancel();
        try {
            await Promise.all([...this.entries.keys()].map(hash=>this.remove(hash)));
            await Promise.allSettled([...this.opening.values()]);
            await clearTorrentCache();this.componentMetadata.clear();
        } finally {this.clearing=false;}
    }
    async close() {
        this.replicas?.close();
        this.closed=true;this.cancel();
        await Promise.all([...this.entries.keys()].map(hash=>this.remove(hash)));
        await Promise.allSettled([...this.opening.values()]);
        this.componentMetadata.clear();
        if(this.client && !this.client.destroyed)await new Promise(resolve=>this.client.destroy(resolve));
    }
}
