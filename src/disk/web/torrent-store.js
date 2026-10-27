/** Ciphertext pieces only. WebTorrent owns piece verification and selection. */
export const PIECE_LENGTH=256*1024;
export const TORRENT_DATABASE="my98-torrents-v1";
const hashPattern=/^[0-9a-f]{40}$/;
const failure=(code,message,cause)=>Object.assign(new Error(message,{cause}),{code});
const storageError=error=>error?.name==="QuotaExceededError" ?
    failure("STORAGE_FULL","Not enough browser storage for this torrent",error) :
    typeof error?.code==="string" ? error : failure("STORAGE_ERROR","Torrent storage is unavailable",error);

export function openTorrentDatabase(factory=globalThis.indexedDB) {
    return new Promise((resolve,reject)=>{
        if(!factory){reject(failure("STORAGE_ERROR","IndexedDB is unavailable"));return;}
        let request,settled=false;
        try {request=factory.open(TORRENT_DATABASE,2);}
        catch(error){reject(storageError(error));return;}
        request.onupgradeneeded=()=>{
            const db=request.result;
            if(!db.objectStoreNames.contains("pieces")) {
                const pieces=db.createObjectStore("pieces",{keyPath:["hash","index"]});
                pieces.createIndex("hash","hash",{unique:false});
            }
            if(!db.objectStoreNames.contains("metadata"))db.createObjectStore("metadata",{keyPath:"hash"});
            // Public high-water marks survive ciphertext cache cleanup.
            if(!db.objectStoreNames.contains("names"))db.createObjectStore("names",{keyPath:"publicKey"});
            if(!db.objectStoreNames.contains("locations"))db.createObjectStore("locations",{keyPath:"publicKey"});
        };
        request.onerror=()=>{settled=true;reject(storageError(request.error));};
        request.onblocked=()=>{settled=true;reject(failure("STORAGE_BLOCKED","Close other my98 tabs to update torrent storage"));};
        request.onsuccess=()=>{
            const db=request.result;
            if(settled){db.close();return;}
            settled=true;db.onversionchange=()=>db.close();resolve(db);
        };
    });
}

function transaction(db,stores,mode,work) {
    return new Promise((resolve,reject)=>{
        let tx,result,failed;
        try {
            tx=db.transaction(stores,mode);
            tx.oncomplete=()=>resolve(result);
            tx.onerror=()=>{failed ||= tx.error;};
            tx.onabort=()=>reject(storageError(failed||tx.error));
            work(tx,value=>{result=value;});
        } catch(error) {
            if(tx){try{tx.abort();}catch{}}
            reject(storageError(error));
        }
    });
}

export async function clearTorrentCache(hash) {
    if(hash!==undefined && !hashPattern.test(hash))throw failure("INVALID_TORRENT","Invalid torrent infohash");
    const db=await openTorrentDatabase();
    try {
        await transaction(db,["pieces","metadata"],"readwrite",tx=>{
            if(hash===undefined) {
                tx.objectStore("pieces").clear();tx.objectStore("metadata").clear();
            } else {
                const cursor=tx.objectStore("pieces").index("hash").openCursor(IDBKeyRange.only(hash));
                cursor.onsuccess=()=>{
                    const row=cursor.result;
                    if(row){row.delete();row.continue();}
                };
                tx.objectStore("metadata").delete(hash);
            }
        });
    } finally {db.close();}
}

/** Implements the abstract-chunk-store contract used by WebTorrent. */
export class TorrentPieceStore {
    constructor(chunkLength,options={}) {
        const hash=options.torrent?.infoHash || options.infoHash;
        if(!hashPattern.test(hash) || chunkLength!==PIECE_LENGTH ||
            !Number.isSafeInteger(options.length) || options.length<1) {
            throw failure("INVALID_TORRENT","Expected a v1 torrent with 256 KiB pieces");
        }
        this.hash=hash;this.chunkLength=chunkLength;this.length=options.length;
        this.count=Math.ceil(this.length/chunkLength);
        this.budget=options.ramBytes ?? 2*1024*1024;
        if(!Number.isSafeInteger(this.budget) || this.budget<0 || this.budget>8*1024*1024)
            throw failure("INVALID_TORRENT","Invalid torrent RAM cache budget");
        this.cache=new Map();this.memoryBytes=0;this.pending=new Set();this.closed=false;
        this.ready=openTorrentDatabase(options.indexedDB);
        void this.ready.catch(()=>{}); // Operations report the same storage failure.
    }

    size(index) {
        if(!Number.isSafeInteger(index) || index<0 || index>=this.count)
            throw failure("INVALID_RANGE","Torrent piece is out of range");
        return Math.min(this.chunkLength,this.length-index*this.chunkLength);
    }

    remember(index,data) {
        const previous=this.cache.get(index);
        if(previous){this.memoryBytes-=previous.byteLength;this.cache.delete(index);}
        if(data.byteLength>this.budget)return;
        this.cache.set(index,data);this.memoryBytes+=data.byteLength;
        while(this.memoryBytes>this.budget) {
            const [key,value]=this.cache.entries().next().value;
            this.cache.delete(key);this.memoryBytes-=value.byteLength;
        }
    }

    perform(work,callback) {
        if(this.closed) {
            queueMicrotask(()=>callback(failure("STORAGE_CLOSED","Torrent piece store is closed")));
            return;
        }
        const promise=Promise.resolve().then(work);
        this.pending.add(promise);
        promise.then(value=>{this.pending.delete(promise);callback(null,value);},
            error=>{this.pending.delete(promise);callback(storageError(error));});
    }

    put(index,input,callback) {
        this.perform(async()=>{
            const size=this.size(index);
            if(!(input instanceof Uint8Array) || input.byteLength!==size)
                throw failure("INVALID_RANGE","Incorrect torrent piece size");
            const data=new Uint8Array(input),db=await this.ready;
            await transaction(db,["pieces"],"readwrite",tx=>{
                tx.objectStore("pieces").put({hash:this.hash,index,length:this.length,
                    chunkLength:this.chunkLength,data});
            });
            // Only commit to RAM after the IndexedDB transaction succeeds.
            this.remember(index,data);
        },callback);
    }

    get(index,options,callback) {
        if(typeof options==="function"){callback=options;options={};}
        options ||= {};
        this.perform(async()=>{
            const size=this.size(index),offset=options.offset ?? 0,length=options.length ?? (size-offset);
            if(!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
                offset<0 || length<0 || offset+length>size)
                throw failure("INVALID_RANGE","Torrent piece range is out of bounds");
            let data=this.cache.get(index);
            if(data){this.cache.delete(index);this.cache.set(index,data);}
            else {
                const db=await this.ready;
                const row=await transaction(db,["pieces"],"readonly",(tx,result)=>{
                    const request=tx.objectStore("pieces").get([this.hash,index]);
                    request.onsuccess=()=>result(request.result);
                });
                if(!row || row.length!==this.length || row.chunkLength!==this.chunkLength ||
                    !(row.data instanceof Uint8Array) || row.data.byteLength!==size)
                    throw failure("ENOENT","Torrent piece is not cached");
                data=row.data;this.remember(index,data);
            }
            return data.slice(offset,offset+length);
        },callback);
    }

    close(callback=()=>{}) {
        this.closed=true;
        Promise.allSettled([...this.pending]).then(async()=>{
            this.cache.clear();this.memoryBytes=0;
            try{(await this.ready).close();callback(null);}
            catch(error){callback(storageError(error));}
        });
    }

    destroy(callback=()=>{}) {
        this.close(error=>{
            if(error){callback(error);return;}
            clearTorrentCache(this.hash).then(()=>callback(null),callback);
        });
    }
}
