import {TorrentPieceStore,clearTorrentCache} from "./torrent-store.js";
import {verifyMetadata,infoHash,COMPONENT_NAMES} from "./torrent-protocol.js";
import {torrentSources,DEFAULT_TORRENT_SOURCES} from "./torrent-sources.js";
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
        this.closed=false;this.epoch=0;this.discoveries=new Set();this.seedProbes=new Set();this.recovering=new Map();this.openingJobs=new Map();this.componentMetadata=new Map();
    }
    deferSources() {
        this.sourcesReady=new Promise(resolve=>{this.finishSources=resolve;});
    }
    setSources(sources) {
        if(this.closed)return;
        this.sources=torrentSources(sources);this.finishSources?.();
        for(const entry of this.entries.values())if(entry.torrent.ready)
            void this.refreshWebseeds(entry).catch(()=>{});
    }
    async refreshWebseeds(entry) {
        entry.seedController?.abort(fail("CANCELLED","Webseed sources changed"));
        const controller=entry.seedController=new AbortController();
        await this.webseeds(entry,this.sources,controller.signal,url=>{
            if(!this.closed && !entry.torrent.destroyed && !controller.signal.aborted)
                this.offerWebseed(entry,url);
        });
    }
    offerWebseed(entry,url) {
        entry.seedCandidates ||= [];
        if(!entry.seedCandidates.includes(url))entry.seedCandidates.push(url);
        // client.add parses metadata asynchronously. A warm HEAD/cache can win
        // before the torrent has an infohash for the connection handshake.
        if(!entry.torrent.ready)return;
        if(!entry.activeSeed) {
            entry.activeSeed=url;entry.lastVerified=performance.now();
            this.addWebseed(entry,url);
        }
    }
    addWebseed(entry,url) {
        entry.torrent.addWebSeed(this.seedConnectionFactory?this.seedConnectionFactory(url,entry.torrent):url);
    }
    enablePeerBackup(entry) {
        if(entry.rtcEnabled)return;
        entry.rtcEnabled=true;
        entry.torrent.discovery?.tracker?.update({numwant:5});
    }
    monitorWebseeds(entry) {
        if(!entry.seedTimer) {
            entry.seedTimer=setInterval(()=>this.checkWebseed(entry),250);
            entry.seedTimer.unref?.();
        }
    }
    checkWebseed(entry,now=performance.now()) {
        const torrent=entry.torrent;
        if(this.closed || torrent.destroyed || entry.error || entry.paused || !torrent.ready)return;
        if(torrent.done){entry.lastVerified=now;return;}
        const pending=entry.readers?.size || entry.prefetch || entry.startupPrefetches?.size || entry.background;
        if(!pending){entry.lastVerified=now;return;}
        if(now-entry.lastVerified<1000)return;
        // Avoid speculative ICE negotiation while HTTPS makes progress. Keep
        // the tracker connection and request WebRTC peers on a real stall.
        this.enablePeerBackup(entry);
        if((entry.seedCandidates?.length||0)<2)return;
        // A successful HEAD is only a reachability hint. If verified payload
        // stalls, release that source's requests and promote the next backup.
        const previous=entry.activeSeed,next=entry.seedCandidates.find(url=>url!==previous);
        entry.seedCandidates=entry.seedCandidates.filter(url=>url!==previous).concat(previous?[previous]:[]);
        if(previous)torrent.removePeer(previous);
        entry.activeSeed=next;entry.lastVerified=now;this.addWebseed(entry,next);
    }
    async initialize() {
        if(this.closed)throw fail("CANCELLED","Torrent transport is closed");
        if(!this.clientPromise)this.clientPromise=(async()=>{
            const WebTorrent=await this.clientFactory();
            if(this.closed)throw fail("CANCELLED","Torrent transport is closed");
            this.webRTC=WebTorrent.WEBRTC_SUPPORT!==false;
            this.seedConnectionFactory=WebTorrent.createWebSeed;
            this.client=new WebTorrent({dht:false,lsd:false,utp:false,maxConns:8,
                tracker:this.sources.trackers.length?{}:false});
            this.client.on("error",error=>{for(const entry of this.entries.values())this.failed(entry,error);});
            return this.client;
        })();
        return this.clientPromise;
    }
    failed(entry,error) {
        clearInterval(entry.seedTimer);entry.seedTimer=null;
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
            }).finally(()=>{
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
        const abortDiscovery=()=>controller.abort(cancelled(signal));
        signal?.addEventListener("abort",abortDiscovery,{once:true});
        if(signal?.aborted)abortDiscovery();
        this.discoveries.add(controller);let probe;
        // HTTP has its own deadline; optional HTTPS sources must not shorten
        // the independent WebRTC lookup. Session cancellation stops both.
        const http=new AbortController(),abortHTTP=()=>http.abort(controller.signal.reason);
        controller.signal.addEventListener("abort",abortHTTP,{once:true});
        const peers=async()=>new Promise((resolve,reject)=>{
            let settled=false,timer;
            const finish=fn=>value=>{
                if(settled)return;settled=true;
                clearTimeout(timer);controller.signal.removeEventListener("abort",aborted);fn(value);
            };
            const aborted=()=>finish(reject)(controller.signal.reason||fail("CANCELLED","Metadata lookup cancelled"));
            if(controller.signal.aborted){aborted();return;}
            controller.signal.addEventListener("abort",aborted,{once:true});
            timer=setTimeout(()=>finish(reject)(fail("TRANSPORT_TIMEOUT","Peer metadata lookup timed out")),this.timeout);
            // Metadata only: no payload selections or persistent piece store.
            const Store=class {
                get(index,options,callback) {if(typeof options==="function")callback=options;queueMicrotask(()=>callback(Object.assign(new Error("Metadata only"),{code:"ENOENT"})));}
                put(index,bytes,callback) {queueMicrotask(()=>callback(new Error("Metadata discovery cannot write payload")));}
                close(callback) {queueMicrotask(()=>callback?.());}
                destroy(callback) {this.close(callback);}
            };
            try {
                probe=client.add(hash,{announce:this.sources.trackers,store:Store,storeCacheSlots:0,deselect:true,skipVerify:false,destroyStoreOnDestroy:false});
                probe.once("error",finish(reject));
                probe.once("metadata",()=>{void verifyMetadata(new Uint8Array(probe.metadata),hash,kind).then(value=>finish(resolve)(value.metadata),finish(reject));});
            } catch(error){finish(reject)(error);}
        });
        const https=async api=>{
            if(controller.signal.aborted || this.closed || epoch!==this.epoch)throw fail("CANCELLED","Metadata lookup cancelled");
            try {
                const response=await fetch(api+"/v2/info/"+hash,{signal:http.signal,credentials:"omit",redirect:"error",cache:"no-store"});
                if(!response.ok) {
                    if(response.body)await response.body.cancel().catch(()=>{});
                    throw fail("PUBLICATION_UNAVAILABLE","Torrent info source returned "+response.status);
                }
                const limit=kind==="descriptor"?16384:96*1024*1024;
                if(Number(response.headers.get("Content-Length"))>limit) {
                    if(response.body)await response.body.cancel().catch(()=>{});
                    throw fail("INVALID_PUBLICATION","Torrent info exceeds size limit");
                }
                const reader=response.body.getReader(),parts=[];let size=0;
                try {
                    for(;;) {
                        const {done,value}=await reader.read();if(done)break;
                        size+=value.length;if(size>limit)throw fail("INVALID_PUBLICATION","Torrent info exceeds size limit");parts.push(value);
                    }
                } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
                const metadata=new Uint8Array(8+size),prefix=new TextEncoder().encode("d4:info");
                metadata.set(prefix);let offset=prefix.length;
                for(const part of parts){metadata.set(part,offset);offset+=part.length;}
                metadata[offset]=101;
                return (await verifyMetadata(metadata,hash,kind)).metadata;
            } catch(error) {
                if(http.signal.aborted)throw http.signal.reason;
                if(error.code==="INVALID_PUBLICATION")throw error;
                throw fail("PUBLICATION_UNAVAILABLE","No verified torrent info is available from this seedbox");
            }
        };
        const httpsSources=async()=>{
            if(this.sourcesReady)await new Promise((resolve,reject)=>{
                const abort=()=>{cleanup();reject(controller.signal.reason);};
                const cleanup=()=>controller.signal.removeEventListener("abort",abort);
                controller.signal.addEventListener("abort",abort,{once:true});
                this.sourcesReady.then(()=>{cleanup();resolve();});
                if(controller.signal.aborted)abort();
            });
            if(controller.signal.aborted)throw controller.signal.reason;
            if(!this.sources.apis.length)throw fail("PUBLICATION_UNAVAILABLE","No HTTPS metadata sources are available");
            const timer=setTimeout(()=>http.abort(fail("TRANSPORT_TIMEOUT","HTTPS metadata lookup timed out")),10000);
            try{return await Promise.any(this.sources.apis.map(https));}
            catch(error) {
                if(error instanceof AggregateError)throw error.errors.find(cause=>cause.code==="INVALID_PUBLICATION")||error.errors[0];
                throw error;
            } finally {
                clearTimeout(timer);http.abort(fail("CANCELLED","HTTPS metadata lookup finished"));
            }
        };
        try {
            // Every source authenticates the same infohash. Canonical origin order
            // is a signature encoding, never a sequential network preference.
            const lookups=[],httpsLookup=this.sources.apis.length || this.sourcesReady?httpsSources():null;
            if(httpsLookup)lookups.push(httpsLookup);
            if(this.webRTC && this.sources.trackers.length) {
                if(!httpsLookup)lookups.push(peers());
                else lookups.push(new Promise((resolve,reject)=>{
                    let started=false;
                    const cleanup=()=>{clearTimeout(timer);controller.signal.removeEventListener('abort',abort);};
                    const start=()=>{if(started || controller.signal.aborted)return;started=true;cleanup();peers().then(resolve,reject);};
                    const abort=()=>{cleanup();reject(cancelled(controller.signal));};
                    const timer=setTimeout(start,250);
                    controller.signal.addEventListener('abort',abort,{once:true});
                    // Unavailable HTTPS needs no grace period. A healthy fast
                    // response wins before unnecessary peer offers are created.
                    void httpsLookup.catch(start);
                    if(controller.signal.aborted)abort();
                }));
            }
            if(!lookups.length)throw fail("PUBLICATION_UNAVAILABLE","No torrent metadata sources are configured");
            try {
                const data=await Promise.any(lookups);
                if(controller.signal.aborted || this.closed || epoch!==this.epoch)throw fail("CANCELLED","Metadata lookup cancelled");
                return data;
            } catch(error) {
                if(controller.signal.aborted || this.closed || epoch!==this.epoch)throw controller.signal.reason||fail("CANCELLED","Metadata lookup cancelled");
                if(error instanceof AggregateError)throw error.errors.find(cause=>cause.code==="INVALID_PUBLICATION")||error.errors[0];
                throw error;
            }
        } finally {
            // Stop the losing HTTP/BEP9 path before adding the lazy payload
            // reader: WebTorrent must never retain two torrents for one hash.
            controller.abort(fail("CANCELLED","Metadata lookup finished"));
            controller.signal.removeEventListener("abort",abortHTTP);
            signal?.removeEventListener("abort",abortDiscovery);
            try {if(probe && !probe.destroyed)await new Promise(resolve=>probe.destroy({destroyStore:false},resolve));}
            finally {this.discoveries.delete(controller);}
        }
    }
    async webseeds(parsed,sources=this.sources,signal,onAvailable=()=>{}) {
        if(signal?.aborted)throw cancelled(signal);
        const urls=sources.webseeds.map(root=>root+"/"+parsed.infoHash+"/"+parsed.filename);
        // Unreachable webseeds can stall piece scheduling despite healthy peers.
        // Only admit HTTP sources reachable for this component.
        // HEAD is a hint; WebTorrent still verifies all downloaded piece hashes.
        const available=urls.map(async url=>{
            const controller=new AbortController(),abort=()=>controller.abort(cancelled(signal));
            this.seedProbes.add(controller);
            signal?.addEventListener("abort",abort,{once:true});
            if(signal?.aborted)abort();
            const timer=setTimeout(()=>controller.abort(fail("TRANSPORT_TIMEOUT","Webseed probe timed out")),3000);
            try {
                const response=await fetch(url,{method:"HEAD",credentials:"omit",redirect:"error",cache:"no-store",signal:controller.signal});
                const length=response.headers.get("Content-Length");
                if(![400,405,501].includes(response.status) &&
                    !(response.ok && (length===null || Number(length)===parsed.size)))throw fail("PUBLICATION_UNAVAILABLE","Webseed is unavailable");
                if(controller.signal.aborted)throw cancelled(controller.signal);
                onAvailable(url);return url;
            } finally {clearTimeout(timer);signal?.removeEventListener("abort",abort);this.seedProbes.delete(controller);}
        });
        // Leave slow probes running as bounded backup discovery. Their errors
        // remain observed by Promise.any, and session cancellation stops them.
        const first=await Promise.any(available).catch(()=>null);
        if(signal?.aborted)throw cancelled(signal);
        return first?[first]:[];
    }
    async add(hash,metadata,kind,signal) {
        const epoch=this.epoch,parsed=await verifyMetadata(metadata,hash,kind),sources=this.sources;
        if(signal?.aborted)throw cancelled(signal);
        // Keep verified immutable metadata independently of a live torrent: a
        // failed reopen must not leave later demand without a recovery source.
        this.componentMetadata.set(hash,{metadata:parsed.metadata,kind});
        const candidates=[],seedController=new AbortController(),abortSeeds=()=>seedController.abort(cancelled(signal));
        signal?.addEventListener("abort",abortSeeds,{once:true});
        if(signal?.aborted)abortSeeds();
        let live;
        try {
        const probing=this.webseeds(parsed,sources,seedController.signal,url=>{
            candidates.push(url);
            if(live && !this.closed && !live.torrent.destroyed && !seedController.signal.aborted)
                this.offerWebseed(live,url);
        });
        void probing.catch(()=>{});
        const client=await waitFor(this.initialize(),signal);
        if(signal?.aborted)throw cancelled(signal);
        if(this.closed || epoch!==this.epoch)throw fail("CANCELLED","Torrent opening was cancelled");
        return await new Promise((resolve,reject)=>{
            const entry={...parsed,metadata:parsed.metadata,readers:new Set(),background:false,paused:false,rescanned:false,
                seedCandidates:candidates,seedController,lastVerified:performance.now(),rtcEnabled:!sources.webseeds.length};
            const torrent=client.add(parsed.metadata,{announce:this.sources.trackers,
                // WebRTC and verified cache need not wait for any HEAD reply.
                urlList:[],
                getAnnounceOpts:()=>({numwant:entry.rtcEnabled?5:0}),
                store:this.store,storeOpts:{ramBytes:2*1024*1024},storeCacheSlots:0,
                deselect:true,skipVerify:false,
                // A state is consumed immediately: verify its persistent cache
                // before ready, so demand never races an empty startup bitfield.
                ...(kind==="state"?{}:{bitfield:new Uint8Array(Math.ceil(parsed.pieces/8))}),
                maxWebConns:3,destroyStoreOnDestroy:false});
            entry.torrent=torrent;live=entry;this.entries.set(hash,entry);
            void probing.then(urls=>{if(!urls.length && !torrent.destroyed)this.enablePeerBackup(entry);}).catch(()=>{});
            if(candidates.length)this.offerWebseed(entry,candidates[0]);
            // Probes that completed between the first result and client.add are
            // backups too; the first reachable source alone owns initial work.
            this.monitorWebseeds(entry);
            let settled=false;
            const detach=()=>{signal?.removeEventListener("abort",abortOpening);signal?.removeEventListener("abort",abortSeeds);};
            const abortOpening=()=>{
                if(settled)return;settled=true;clearTimeout(timer);detach();
                reject(cancelled(signal));
                if(this.entries.get(hash)===entry)void this.remove(hash);
            };
            const timer=setTimeout(()=>{settled=true;detach();const error=fail("TRANSPORT_TIMEOUT","Torrent storage initialization timed out");this.failed(entry,error);reject(error);if(this.entries.get(hash)===entry)void this.remove(hash);},this.timeout);
            signal?.addEventListener("abort",abortOpening,{once:true});
            torrent.on("error",error=>{this.failed(entry,error);if(!settled){clearTimeout(timer);settled=true;detach();reject(error);}});
            torrent.on("download",bytes=>{entry.receivedData=(entry.receivedData||0)+bytes;this.progress(entry);});
            torrent.on("verified",()=>{entry.lastVerified=performance.now();this.progress(entry);});
            torrent.on("done",()=>this.progress(entry,true));
            torrent.once("close",()=>{
                clearInterval(entry.seedTimer);entry.seedTimer=null;entry.seedController?.abort(fail("CANCELLED","Torrent closed"));
                const error=entry.error||fail("CANCELLED","Torrent closed");
                this.failed(entry,error);
                if(!settled){clearTimeout(timer);settled=true;detach();reject(error);}
            });
            torrent.once("ready",()=>{
                clearTimeout(timer);if(settled)return;settled=true;detach();
                if(epoch!==this.epoch || this.closed){reject(fail("CANCELLED","Torrent opening was cancelled"));void this.remove(hash);return;}
                if(entry.seedCandidates.length && !entry.activeSeed)this.offerWebseed(entry,entry.seedCandidates[0]);
                if(this.sources!==sources)void this.refreshWebseeds(entry).catch(()=>{});
                if(kind==="state") {
                    entry.rescanned=true;this.backgroundSelection(entry);
                } else {
                    // Keep large disks lazy. Hash-check the cache in the background;
                    // opt-in startup can also verify its own target pieces.
                    this.rescanCachedPieces(entry);
                }
                resolve(this.describe(entry));
            });
            if(signal?.aborted)abortOpening();
        });
        } finally {
            signal?.removeEventListener("abort",abortSeeds);
            if(!live)seedController.abort(fail("CANCELLED","Torrent opening finished"));
        }
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
        const bits=torrent?.bitfield,bytes=bits?.buffer;let verified=0;
        for(let index=0;bytes && index<Math.ceil(entry.pieces/8);index++) {
            const mask=index===Math.ceil(entry.pieces/8)-1 && entry.pieces%8 ?
                255<<(8-entry.pieces%8):255;
            verified+=bitCounts[(bytes[index]||0)&mask];
        }
        const coveredBytes=verified*262144-(bits?.get(entry.pieces-1)?entry.pieces*262144-entry.size:0);
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
                const first=Math.floor(offset/262144),last=Math.floor((offset+length-1)/262144);
                await this.verifyCachedPieces(entry,Array.from({length:last-first+1},(_,index)=>first+index),controller.signal);
            }
            if(controller.signal.aborted)throw controller.signal.reason;
            entry.paused=false;this.monitorWebseeds(entry);entry.torrent.resume();
            // Upstream treats end=0 as unspecified. Request at least two bytes
            // for that case, but return only the requested ciphertext.
            const end=Math.max(offset+length-1,Math.min(1,entry.size-1));
            reader=entry.torrent.files[0].stream({start:offset,end}).getReader();
            const output=new Uint8Array(length);let copied=0;
            while(copied<length) {
                if(controller.signal.aborted)throw controller.signal.reason;
                const {done,value}=await reader.read();
                if(controller.signal.aborted)throw controller.signal.reason;
                if(done)throw fail("TRANSPORT_ERROR","Short ciphertext range");
                const take=Math.min(value.length,length-copied);
                output.set(value.subarray(0,take),copied);copied+=take;
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
        if(enabled){entry.paused=false;this.monitorWebseeds(entry);entry.torrent.resume();}
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
        entry.paused=false;this.monitorWebseeds(entry);entry.torrent.resume();this.backgroundSelection(entry);
        entry.prefetchTask=(async()=>{
            for(const [offset,length] of ranges) {
                if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||offset<0||length<1||offset+length>entry.size)
                    throw fail("INVALID_RANGE","Invalid prefetch range");
                const first=Math.floor(offset/262144),last=Math.floor((offset+length-1)/262144);
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
            for(let index=Math.floor(offset/262144);index<=Math.floor((offset+length-1)/262144);index++)targets.add(index);
        }
        const indices=[...targets],bytes=index=>Math.min(262144,entry.size-index*262144);
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
            entry.paused=false;this.monitorWebseeds(entry);torrent.resume();
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
        for(const controller of this.seedProbes)controller.abort(fail("CANCELLED","Webseed lookup cancelled"));
        for(const entry of this.entries.values()) {
            clearInterval(entry.seedTimer);entry.seedTimer=null;entry.seedController?.abort(fail("CANCELLED","Torrent cancelled"));
            for(const controller of entry.readers)controller.abort(fail("CANCELLED","Torrent read cancelled"));
            entry.prefetch?.abort(fail("CANCELLED","Torrent prefetch cancelled"));
            for(const controller of entry.startupPrefetches||[])controller.abort(fail("CANCELLED","Startup prefetch cancelled"));
            entry.paused=true;
            if(!entry.torrent.destroyed){entry.torrent.deselect(0,entry.pieces-1);entry.torrent.pause();}
        }
    }
    async remove(hash) {
        const entry=this.entries.get(hash);if(!entry)return;
        clearInterval(entry.seedTimer);entry.seedTimer=null;entry.seedController?.abort(fail("CANCELLED","Torrent closed"));
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
        this.closed=true;this.cancel();
        this.finishSources?.();
        await Promise.all([...this.entries.keys()].map(hash=>this.remove(hash)));
        await Promise.allSettled([...this.opening.values()]);
        this.componentMetadata.clear();
        if(this.client && !this.client.destroyed)await new Promise(resolve=>this.client.destroy(resolve));
    }
}
