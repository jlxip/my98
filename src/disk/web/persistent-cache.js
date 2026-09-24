import {CID} from 'multiformats/cid';
import {sha256} from 'multiformats/hashes/sha2';

export const CACHE_LIMITS=Object.freeze({bytes:128*1048576,queue:4*1048576,block:4*1048576,entries:16384,timeout:1000});
export const CACHE_DATABASE='my98-published-cache-v1';
const counters=()=>({hits:0,misses:0,readBytes:0,writtenBytes:0,writes:0,errors:0,discarded:0});
// Cache failures are misses, never disk errors. The database contains only
// immutable, independently verifiable blocks; markers are optimization hints.
export class PersistentCache {
    constructor(options={}) {
        if(!options || typeof options!=='object' || Array.isArray(options) || Object.keys(options).some(k=>!['state','loadProfile'].includes(k)) || Object.values(options).some(v=>typeof v!=='boolean'))throw new TypeError('Invalid persistent cache options');
        this.options={state:false,loadProfile:false,...options};this.keys=new Set();this.markers=new Map();
        this.counts={state:counters(),loadProfile:counters()};this.queue=[];this.queued=new Set();this.queueBytes=0;this.pendingReads=new Map();this.stateKeys=new Set();
        this.ready=this.options.state||this.options.loadProfile ? this.open() : Promise.resolve();
    }
    stats() {return {enabled:{...this.options},available:!!this.db,queuedBytes:this.queueBytes,pendingWrites:this.queue.length+(this.writing?1:0),state:{...this.counts.state},loadProfile:{...this.counts.loadProfile}};}
    async open() {
        try {
            const db=await new Promise((resolve,reject)=>{
                let expired=false;const request=indexedDB.open(CACHE_DATABASE,1);
                const timer=setTimeout(()=>{expired=true;reject(Error('Cache open timed out'));},CACHE_LIMITS.timeout);
                request.onupgradeneeded=()=>{
                    const db=request.result;const blocks=db.createObjectStore('blocks',{keyPath:'cid'});blocks.createIndex('used','used');
                    db.createObjectStore('meta');db.createObjectStore('states',{keyPath:'cid'});
                };
                request.onerror=()=>{clearTimeout(timer);reject(request.error);};
                request.onblocked=()=>{clearTimeout(timer);expired=true;reject(Error('Cache upgrade blocked'));};
                request.onsuccess=()=>{clearTimeout(timer);if(expired||this.closed){request.result.close();resolve();}else resolve(request.result);};
            });
            if(!db)return;this.db=db;db.onversionchange=()=>{db.close();this.db=undefined;};
            const records=await this.transaction(['blocks','states'],'readonly',tx=>{
                const keys=tx.objectStore('blocks').getAllKeys(),states=tx.objectStore('states').getAll();
                return ()=>({keys:keys.result,states:states.result});
            });
            this.initialKeys=new Set(records.keys);this.keys=new Set(records.keys);this.markers=new Map(records.states.map(v=>[v.cid,v]));
        }catch {for(const kind of ['state','loadProfile'])if(this.options[kind])this.counts[kind].errors++;this.disable();}
    }
    disable() {this.db?.close();this.db=undefined;this.disabled=true;}
    transaction(names,mode,start) {
        return new Promise((resolve,reject)=>{
            if(!this.db){reject(Error('Cache unavailable'));return;}
            let tx,result,timer;
            try {
                tx=this.db.transaction(names,mode);result=start(tx);
                timer=setTimeout(()=>{try{tx.abort();}catch{}reject(Error('Cache transaction timed out'));},CACHE_LIMITS.timeout);
                tx.oncomplete=()=>{clearTimeout(timer);resolve(typeof result==='function'?result():result);};
                tx.onabort=tx.onerror=()=>{clearTimeout(timer);reject(tx.error||Error('Cache transaction failed'));};
            }catch(error){clearTimeout(timer);try{tx?.abort();}catch{}reject(error);}
        });
    }
    async get(cid,kind) {
        if(!this.options[kind]||this.closed)return;
        await this.ready;const key=cid.toV1().toString(),stats=this.counts[kind];
        if(!this.db||!this.keys.has(key)){stats.misses++;return;}
        let pending=this.pendingReads.get(key);
        if(!pending) {
            pending=(async()=>{
                const record=await this.transaction(['blocks'],'readonly',tx=>{const r=tx.objectStore('blocks').get(key);return ()=>r.result;});
                if(!record)return;
                const bytes=record.bytes;
                if(!(bytes instanceof Uint8Array)||bytes.length>CACHE_LIMITS.block)return;
                const digest=cid.multihash.code===0?bytes:cid.multihash.code===sha256.code?(await sha256.digest(bytes)).digest:undefined;
                if(!digest||digest.length!==cid.multihash.digest.length||!digest.every((b,i)=>b===cid.multihash.digest[i]))return;
                return bytes;
            })().catch(()=>undefined).finally(()=>this.pendingReads.delete(key));
            this.pendingReads.set(key,pending);
        }
        const bytes=await pending;
        if(bytes){stats.hits++;stats.readBytes+=bytes.length;this.enqueue({type:'touch',key,kind},0);return bytes;}
        stats.errors++;stats.misses++;this.keys.delete(key);this.enqueue({type:'remove',key,kind},0);
    }
    put(cid,bytes,kind) {
        if(!this.options[kind]||this.closed||this.disabled)return;
        const key=cid.toV1().toString();
        if(kind==='state')this.stateKeys.add(key);
        if(this.keys.has(key)||this.queued.has(key))return;
        if(!(bytes instanceof Uint8Array)||bytes.length>CACHE_LIMITS.block)return;
        if(this.queue.length>=256||this.queueBytes+bytes.length>CACHE_LIMITS.queue){this.counts[kind].discarded++;return;}
        this.queued.add(key);this.enqueue({type:'put',key,bytes:bytes.slice(),kind},bytes.length);
    }
    enqueue(item,size) {
        if(this.closed||this.disabled)return;
        if(this.queue.length>=256){this.counts[item.kind].discarded++;return;}
        item.size=size;this.queue.push(item);this.queueBytes+=size;void this.drain();
    }
    async drain() {
        if(this.writing)return;this.writing=true;
        try {
            await this.ready;
            while(this.queue.length) {
                const items=[this.queue.shift()];
                if(items[0].type==='put')while(items.length<8&&this.queue[0]?.type==='put')items.push(this.queue.shift());
                try {
                    if(this.db&&!this.closed) {
                        if(items[0].type==='put')await this.writePuts(items);
                        else await this.write(items[0]);
                    }
                }catch{for(const item of items)this.counts[item.kind].errors++;this.disable();}
                finally{for(const item of items){this.queueBytes-=item.size;this.queued.delete(item.key);}}
            }
        }finally{this.writing=false;}
    }
    // Batch immutable inserts so fast CAR lanes do not turn every leaf into
    // a separate durable transaction. The same 4 MiB queue budget includes
    // this in-flight batch. Accounting and eviction remain atomic across tabs.
    async writePuts(items) {
        const evicted=[],inserted=[];
        await this.transaction(['blocks','meta','states'],'readwrite',tx=>{
            const blocks=tx.objectStore('blocks'),meta=tx.objectStore('meta'),states=tx.objectStore('states');
            const previous=items.map(item=>blocks.get(item.key)),usage=meta.get('usage');
            usage.onsuccess=()=>{
                const fresh=items.filter((item,i)=>!previous[i].result),used=usage.result||{bytes:0,count:0},added=fresh.reduce((n,item)=>n+item.size,0);
                const fits=()=>used.bytes+added<=CACHE_LIMITS.bytes&&used.count+fresh.length<=CACHE_LIMITS.entries;
                const save=()=>{for(const item of fresh){blocks.put({cid:item.key,bytes:item.bytes,size:item.size,used:Date.now()});inserted.push(item);}used.bytes+=added;used.count+=fresh.length;meta.put(used,'usage');};
                if(fits()){save();return;}
                const request=blocks.index('used').openCursor();request.onsuccess=()=>{
                    if(fits()){save();return;}
                    const entry=request.result;if(!entry)return;
                    used.bytes-=entry.value.size;used.count--;evicted.push(entry.primaryKey);entry.delete();states.clear();entry.continue();
                };
            };
        });
        for(const key of evicted)this.keys.delete(key);
        if(evicted.length)this.markers.clear();
        for(const item of items)this.keys.add(item.key);
        for(const item of inserted){this.counts[item.kind].writes++;this.counts[item.kind].writtenBytes+=item.size;}
    }
    async write(item) {
        let completed=false;
        await this.transaction(['blocks','meta','states'],'readwrite',tx=>{
            const blocks=tx.objectStore('blocks'),meta=tx.objectStore('meta'),states=tx.objectStore('states');
            if(item.type==='complete') {
                if(this.counts.state.discarded||this.counts.state.errors)return;
                const keys=blocks.getAllKeys(),request=states.count();request.onsuccess=()=>{
                    const present=new Set(keys.result);
                    if(!this.stateKeys.size||[...this.stateKeys].some(key=>!present.has(key)))return;
                    if(request.result>=128)states.clear();
                    states.put({cid:item.key,complete:true});completed=true;
                };return;
            }
            const old=blocks.get(item.key),usage=meta.get('usage');
            usage.onsuccess=()=>{
                const record=old.result,used=usage.result||{bytes:0,count:0};
                if(item.type==='touch') {if(record)blocks.put({...record,used:Date.now()});return;}
                if(item.type==='remove') {
                    if(record){blocks.delete(item.key);meta.put({bytes:Math.max(0,used.bytes-record.size),count:Math.max(0,used.count-1)},'usage');states.clear();}return;
                }

            };
        });
        if(completed)this.markers.set(item.key,{complete:true});
    }
    async complete(cid) {
        if(!this.options.state||this.closed)return;
        await this.ready;
        if(this.db&&!this.counts.state.discarded&&!this.counts.state.errors)this.enqueue({type:'complete',key:CID.parse(cid).toV1().toString(),kind:'state'},0);
    }
    async hasStateRoot(cid) {await this.ready;return this.options.state&&!!this.db&&this.initialKeys.has(CID.parse(cid).toV1().toString());}
    async hasState(cid) {await this.ready;return !!this.db&&this.markers.has(CID.parse(cid).toV1().toString());}
    close() {this.closed=true;this.disable();}
}
