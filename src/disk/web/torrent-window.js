import {TorrentPieceStore,clearTorrentCache} from "./torrent-store.js";
import {verifyMetadata,infoHash,COMPONENT_NAMES} from "./torrent-protocol.js";
import {torrentSources,DEFAULT_TORRENT_SOURCES} from "./torrent-sources.js";
export {torrentSources} from "./torrent-sources.js";

const fail=(code,message)=>Object.assign(new Error(message),{code});
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
        this.closed=false;this.epoch=0;this.discoveries=new Set();
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
        const urls=await this.webseeds(entry);
        if(!this.closed && !entry.torrent.destroyed)
            for(const url of urls)entry.torrent.addWebSeed(url);
    }
    async initialize() {
        if(this.closed)throw fail("CANCELLED","Torrent transport is closed");
        if(!this.clientPromise)this.clientPromise=(async()=>{
            const WebTorrent=await this.clientFactory();
            if(this.closed)throw fail("CANCELLED","Torrent transport is closed");
            this.webRTC=WebTorrent.WEBRTC_SUPPORT!==false;
            this.client=new WebTorrent({dht:false,lsd:false,utp:false,maxConns:8,
                tracker:this.sources.trackers.length?{}:false});
            this.client.on("error",error=>{for(const entry of this.entries.values())this.failed(entry,error);});
            return this.client;
        })();
        return this.clientPromise;
    }
    failed(entry,error) {
        entry.error=error;
        for(const controller of entry.readers)controller.abort(error);
        entry.prefetch?.abort(error);
        if(error.code!=="CANCELLED")this.onProgress({...this.describe(entry),error:{code:error.code||"TRANSPORT_ERROR",message:error.message}});
    }
    progress(entry,force=false) {
        const now=performance.now();
        if(!force && now-(entry.progressAt??-Infinity)<250)return;
        entry.progressAt=now;this.onProgress(this.describe(entry));
    }
    async open({infoHash:hash,metadata,kind}) {
        infoHash(hash);
        if(this.closed || this.clearing)throw fail("CANCELLED","Torrent transport is closed or clearing its cache");
        if(this.entries.has(hash))return this.describe(this.entry(hash));
        if(this.opening.has(hash))return this.opening.get(hash);
        const promise=(async()=>{
            const data=metadata??await this.discoverMetadata(hash,kind);
            return this.add(hash,data,kind);
        })();
        this.opening.set(hash,promise);
        try{return await promise;}
        finally{if(this.opening.get(hash)===promise)this.opening.delete(hash);}
    }
    async discoverMetadata(hash,kind) {
        const client=await this.initialize(),controller=new AbortController(),epoch=this.epoch;
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
            const lookups=[];
            if(this.webRTC && this.sources.trackers.length)lookups.push(peers());
            if(this.sources.apis.length || this.sourcesReady)lookups.push(httpsSources());
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
            try {if(probe && !probe.destroyed)await new Promise(resolve=>probe.destroy({destroyStore:false},resolve));}
            finally {this.discoveries.delete(controller);}
        }
    }
    async webseeds(parsed,sources=this.sources) {
        const urls=sources.webseeds.map(root=>root+"/"+parsed.infoHash+"/"+parsed.filename);
        // Unreachable webseeds can stall piece scheduling despite healthy peers.
        // Only admit HTTP sources reachable for this component.
        // HEAD is a hint; WebTorrent still verifies all downloaded piece hashes.
        const available=await Promise.all(urls.map(async url=>{
            try {
                const response=await fetch(url,{method:"HEAD",credentials:"omit",redirect:"error",cache:"no-store",signal:AbortSignal.timeout(3000)});
                if([400,405,501].includes(response.status))return true;
                const length=response.headers.get("Content-Length");
                return response.ok && (length===null || Number(length)===parsed.size);
            } catch {return false;}
        }));
        return urls.filter((url,index)=>available[index]);
    }
    async add(hash,metadata,kind) {
        const epoch=this.epoch,parsed=await verifyMetadata(metadata,hash,kind),sources=this.sources;
        const urls=await this.webseeds(parsed,sources);
        const client=await this.initialize();
        if(this.closed || epoch!==this.epoch)throw fail("CANCELLED","Torrent opening was cancelled");
        return new Promise((resolve,reject)=>{
            const entry={...parsed,metadata:parsed.metadata,readers:new Set(),background:false,paused:false,rescanned:false};
            const torrent=client.add(parsed.metadata,{announce:this.sources.trackers,
                urlList:urls,
                store:this.store,storeOpts:{ramBytes:2*1024*1024},storeCacheSlots:0,
                deselect:true,skipVerify:false,
                // A state is consumed immediately: verify its persistent cache
                // before ready, so demand never races an empty startup bitfield.
                ...(kind==="state"?{}:{bitfield:new Uint8Array(Math.ceil(parsed.pieces/8))}),
                maxWebConns:3,destroyStoreOnDestroy:false});
            entry.torrent=torrent;this.entries.set(hash,entry);
            let settled=false;
            const timer=setTimeout(()=>{const error=fail("TRANSPORT_TIMEOUT","Torrent storage initialization timed out");this.failed(entry,error);reject(error);void this.remove(hash);},this.timeout);
            torrent.on("error",error=>{this.failed(entry,error);if(!settled){clearTimeout(timer);settled=true;reject(error);}});
            torrent.on("download",bytes=>{entry.receivedData=(entry.receivedData||0)+bytes;this.progress(entry);});
            torrent.on("verified",()=>this.progress(entry));
            torrent.on("done",()=>this.progress(entry,true));
            torrent.once("close",()=>{
                const error=entry.error||fail("CANCELLED","Torrent closed");
                this.failed(entry,error);
                if(!settled){clearTimeout(timer);settled=true;reject(error);}
            });
            torrent.once("ready",()=>{
                clearTimeout(timer);if(settled)return;settled=true;
                if(epoch!==this.epoch || this.closed){reject(fail("CANCELLED","Torrent opening was cancelled"));void this.remove(hash);return;}
                if(this.sources!==sources)void this.refreshWebseeds(entry).catch(()=>{});
                if(kind==="state") {
                    entry.rescanned=true;this.backgroundSelection(entry);
                } else {
                    // Keep large disks lazy. Only WebTorrent's background hash
                    // scan can mark cached disk pieces usable.
                    torrent.rescanFiles(error=>{
                        if(torrent.destroyed)return;
                        if(error){this.failed(entry,error);return;}
                        entry.rescanned=true;this.backgroundSelection(entry);
                    });
                }
                resolve(this.describe(entry));
            });
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
    async read({infoHash:hash,offset,length},signal) {
        const entry=this.entry(hash);
        if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||offset<0||length<0||
            length>1024*1024||offset+length>entry.size)throw fail("INVALID_RANGE","Invalid ciphertext range");
        if(signal?.aborted)throw signal.reason;
        if(!length)return new Uint8Array();
        entry.paused=false;entry.torrent.resume();
        const controller=new AbortController();entry.readers.add(controller);
        const abort=()=>controller.abort(signal.reason||fail("CANCELLED","Ciphertext read cancelled"));
        signal?.addEventListener("abort",abort,{once:true});
        const timer=setTimeout(()=>controller.abort(fail("TRANSPORT_TIMEOUT","Ciphertext range timed out")),this.timeout);
        // Upstream treats end=0 as unspecified. Request at least two bytes for
        // that one-byte case, but only return the exact requested ciphertext.
        const end=Math.max(offset+length-1,Math.min(1,entry.size-1));
        const reader=entry.torrent.files[0].stream({start:offset,end}).getReader();
        const cancel=()=>{void reader.cancel(controller.signal.reason).catch(()=>{});};
        controller.signal.addEventListener("abort",cancel,{once:true});
        const output=new Uint8Array(length);
        try {
            let copied=0;
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
            await reader.cancel().catch(()=>{});reader.releaseLock();entry.readers.delete(controller);
        }
    }
    backgroundSelection(entry) {
        if(entry.torrent.destroyed || entry.paused || entry.prefetch)return;
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
    cancel() {
        this.epoch++;
        for(const controller of this.discoveries)controller.abort(fail("CANCELLED","Metadata lookup cancelled"));
        for(const entry of this.entries.values()) {
            for(const controller of entry.readers)controller.abort(fail("CANCELLED","Torrent read cancelled"));
            entry.prefetch?.abort(fail("CANCELLED","Torrent prefetch cancelled"));
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
            await clearTorrentCache();
        } finally {this.clearing=false;}
    }
    async close() {
        this.closed=true;this.cancel();
        this.finishSources?.();
        await Promise.all([...this.entries.keys()].map(hash=>this.remove(hash)));
        await Promise.allSettled([...this.opening.values()]);
        if(this.client && !this.client.destroyed)await new Promise(resolve=>this.client.destroy(resolve));
    }
}
