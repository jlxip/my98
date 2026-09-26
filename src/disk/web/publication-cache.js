import {CID} from 'multiformats/cid';
import {sha256} from 'multiformats/hashes/sha2';

export const PUBLICATION_DATABASE='my98-publication-cache-v1';
export const PUBLICATION_QUEUE_BYTES=4*1048576;
const TIMEOUT=5000, BLOCK_LIMIT=4*1048576;
const counters=()=>({hits:0,misses:0,readBytes:0,writtenBytes:0,writes:0,errors:0,discarded:0});
const keyOf=cid=>cid.toV1().toString();

// Separate from the bounded read-only cache. A generation fences all reads and
// writes, including work already queued in another tab when IPNS changes.
export class PublicationCache {
    constructor({retained,onError}={}) {
        this.options={publication:true,disk:true,state:true,loadProfile:true};
        this.counts={disk:counters(),state:counters(),loadProfile:counters()};
        this.retained=retained;this.onError=onError;
        this.queue=[];this.queued=new Set();this.known=new Set();this.missing=new Set();this.deferred=new Map();this.queueBytes=0;
        this.ready=this.open();
    }
    stats() {
        return {enabled:{...this.options},available:!!this.db&&!this.disabled,stale:!!this.stale,
            queuedBytes:this.queueBytes,pendingWrites:this.queued.size+this.deferred.size,
            disk:{...this.counts.disk},state:{...this.counts.state},loadProfile:{...this.counts.loadProfile}};
    }
    error(kind='disk') {
        this.counts[kind].errors++;
        if(!this.disabled)this.onError?.();
        this.disable();
    }
    disable(stale=false) {this.disabled=true;this.stale=stale;this.db?.close();this.db=undefined;this.deferred.clear();}
    async open() {
        try {
            const db=await new Promise((resolve,reject)=>{
                let expired=false;const request=indexedDB.open(PUBLICATION_DATABASE,1);
                const timer=setTimeout(()=>{expired=true;reject(Error('Cache open timed out'));},TIMEOUT);
                request.onupgradeneeded=()=>{
                    request.result.createObjectStore('machines',{keyPath:'name'});
                    request.result.createObjectStore('blocks',{keyPath:['machine','cid']}).createIndex('machine','machine');
                };
                request.onerror=()=>{clearTimeout(timer);reject(request.error);};
                request.onblocked=()=>{clearTimeout(timer);expired=true;reject(Error('Cache blocked'));};
                request.onsuccess=()=>{clearTimeout(timer);if(expired||this.closed){request.result.close();resolve();}else resolve(request.result);};
            });
            if(!db)return;this.db=db;db.onversionchange=()=>{this.error();};
        }catch{this.error();}
    }
    transaction(stores,mode,start) {
        return new Promise((resolve,reject)=>{
            let tx,timer,result;
            try {
                if(!this.db||this.closed||this.disabled)throw Error('Cache unavailable');
                tx=this.db.transaction(stores,mode);result=start(tx);
                timer=setTimeout(()=>{try{tx.abort();}catch{}reject(Error('Cache timed out'));},TIMEOUT);
                tx.oncomplete=()=>{clearTimeout(timer);resolve(typeof result==='function'?result():result);};
                tx.onerror=tx.onabort=()=>{clearTimeout(timer);reject(tx.error||Error('Cache transaction failed'));};
            }catch(error){clearTimeout(timer);try{tx?.abort();}catch{}reject(error);}
        });
    }
    async bind({ipnsName,path,rootCid,sequence}) {
        await this.ready;if(this.disabled||this.closed)return;
        const root=CID.parse(rootCid).toV1().toString();
        const suffix=path.slice(6).split('/').slice(1).join('/');
        const canonicalPath='/ipfs/'+root+(suffix?'/'+suffix:'');
        try {
            const selected=await this.transaction(['machines','blocks'],'readwrite',tx=>{
                let selected;
                const machines=tx.objectStore('machines'),blocks=tx.objectStore('blocks'),request=machines.get(ipnsName);
                request.onsuccess=()=>{
                    const previous=request.result;
                    // Do not let stale resolutions or equal-sequence conflicts
                    // invalidate newer work from another tab.
                    if(previous&&(BigInt(sequence)<BigInt(previous.sequence)||(BigInt(sequence)===BigInt(previous.sequence)&&previous.path!==canonicalPath)))return;
                    const same=previous?.path===canonicalPath;
                    selected={name:ipnsName,path:canonicalPath,rootCid:root,sequence,generation:same?previous.generation:crypto.randomUUID()};
                    if(previous&&!same) {
                        const cursor=blocks.index('machine').openCursor(IDBKeyRange.only(ipnsName));
                        cursor.onsuccess=()=>{const item=cursor.result;if(item){item.delete();item.continue();}};
                    }
                    machines.put(selected);
                };
                return ()=>selected;
            });
            if(!selected){this.disable(true);return;}
            this.machine=selected;
        }catch{this.error();}
    }
    matches(record) {return !!record&&record.generation===this.machine?.generation;}
    async get(cid,kind) {
        const stats=this.counts[kind],key=keyOf(cid);
        if(!this.machine||this.closed||this.disabled){stats.misses++;return;}
        try {
            const result=await this.transaction(['machines','blocks'],'readonly',tx=>{
                const machine=tx.objectStore('machines').get(this.machine.name),block=tx.objectStore('blocks').get([this.machine.name,key]);
                return ()=>({current:this.matches(machine.result),block:block.result});
            });
            if(!result.current){this.disable(true);stats.misses++;return;}
            const bytes=result.block?.bytes;
            if(bytes instanceof Uint8Array&&bytes.length<=BLOCK_LIMIT) {
                const digest=cid.multihash.code===0?bytes:cid.multihash.code===sha256.code?(await sha256.digest(bytes)).digest:undefined;
                if(digest&&digest.length===cid.multihash.digest.length&&digest.every((b,i)=>b===cid.multihash.digest[i])) {
                    this.known.add(key);stats.hits++;stats.readBytes+=bytes.length;return bytes;
                }
                stats.errors++;
            }
            this.known.delete(key);this.missing.add(key);stats.misses++;
        }catch{stats.misses++;this.error(kind);}
    }
    put(cid,bytes,kind) {
        if(!this.machine||this.closed||this.disabled)return;
        const key=keyOf(cid);
        if(this.known.has(key)||this.queued.has(key)){this.deferred.delete(key);return;}
        if(!(bytes instanceof Uint8Array)||bytes.length>BLOCK_LIMIT)return;
        if(this.queueBytes+bytes.length>PUBLICATION_QUEUE_BYTES||this.queue.length>=256) {
            // Disk/profile blocks already live in RemoteDisk's immutable map;
            // retain only identifiers here and refill the bounded queue later.
            if(kind!=='state')this.deferred.set(key,{cid,kind});
            return false;
        }
        this.deferred.delete(key);this.queued.add(key);this.queueBytes+=bytes.length;
        this.queue.push({key,bytes,kind});this.drain();return true;
    }
    async putState(cid,bytes) {
        while(this.put(cid,bytes,'state')===false&&!this.disabled&&!this.closed)await this.writing;
    }
    refill() {
        for(const [key,item] of this.deferred) {
            const bytes=this.retained?.get(key);
            if(!bytes){this.deferred.delete(key);this.counts[item.kind].discarded++;continue;}
            if(this.put(item.cid,bytes,item.kind)===false)break;
        }
    }
    drain() {
        if(this.writing)return;
        this.writing=(async()=>{
            // Assign the promise before callbacks/refill can enqueue more work.
            await Promise.resolve();
            try {
                while(this.queue.length&&!this.disabled&&!this.closed) {
                    const items=this.queue.splice(0,8);let current;
                    try {
                        current=await this.transaction(['machines','blocks'],'readwrite',tx=>{
                            let valid=false;const request=tx.objectStore('machines').get(this.machine.name);
                            request.onsuccess=()=>{
                                valid=this.matches(request.result);if(!valid)return;
                                for(const item of items)tx.objectStore('blocks').put({machine:this.machine.name,cid:item.key,bytes:item.bytes});
                            };return ()=>valid;
                        });
                        if(!current)this.disable(true);
                        else for(const item of items){this.known.add(item.key);this.counts[item.kind].writes++;this.counts[item.kind].writtenBytes+=item.bytes.length;}
                    }catch{this.error(items[0].kind);}
                    finally{for(const item of items){this.queued.delete(item.key);this.queueBytes-=item.bytes.length;}}
                    this.refill();
                }
            }finally {
                if(this.closed||this.disabled){this.queue=[];this.queued.clear();this.deferred.clear();this.queueBytes=0;}
                this.writing=undefined;
            }
        })();
    }
    async hasStateRoot(cid) {
        const parsed=CID.parse(cid);
        // A root downloaded during this attempt must not disable cold CAR.
        if(this.missing.has(keyOf(parsed)))return false;
        return !!(await this.get(parsed,'state'));
    }
    // No completeness marker is needed: every subsequent read checks the CID.
    async complete() {}
    close() {this.closed=true;this.disable();}
}
