import {openTorrentDatabase} from "./torrent-store.js";
import {verifyRecord,parseRecord,compareRecords,unhex} from "./torrent-protocol.js";
import {torrentSources} from "./torrent-sources.js";
const fail=(code,message)=>Object.assign(new Error(message),{code});

export async function cachedRecord(publicKey,verifySignature) {
    unhex(publicKey,32);const db=await openTorrentDatabase();
    try {
        const record=await new Promise((resolve,reject)=>{
            const request=db.transaction(["names"]).objectStore("names").get(publicKey);
            request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
        });
        return record?verifyRecord(record,publicKey,verifySignature):null;
    } finally {db.close();}
}

export async function observeRecord(value,publicKey,verifySignature) {
    const record=verifyRecord(value,publicKey,verifySignature),db=await openTorrentDatabase();
    try {
        await new Promise((resolve,reject)=>{
            const tx=db.transaction(["names"],"readwrite");let error;
            tx.oncomplete=resolve;
            tx.onabort=()=>{
                const cause=error||tx.error;
                reject(cause?.name==="QuotaExceededError" ?
                    fail("STORAGE_FULL","Not enough browser storage to preserve the publication sequence") :
                    cause||fail("STORAGE_ERROR","Could not preserve the publication sequence"));
            };
            const store=tx.objectStore("names"),request=store.get(publicKey);
            request.onsuccess=()=>{
                try {
                    const previous=request.result?verifyRecord(request.result,publicKey,verifySignature):null;
                    if(compareRecords(previous,record))store.put(record);
                } catch(cause){error=cause;tx.abort();}
            };
        });
        return record;
    } finally {db.close();}
}

export async function boundedBytes(response,limit) {
    const length=response.headers.get("Content-Length");
    if(length!==null && (!/^[0-9]+$/.test(length) || Number(length)>limit))
        throw fail("INVALID_PUBLICATION","Publication response is too large");
    if(!response.body)throw fail("PUBLICATION_UNAVAILABLE","Publication response has no body");
    const reader=response.body.getReader(),parts=[];let size=0;
    try {
        for(;;) {
            const {done,value}=await reader.read();if(done)break;
            size+=value.byteLength;
            if(size>limit)throw fail("INVALID_PUBLICATION","Publication response exceeds its size limit");
            parts.push(value);
        }
        const result=new Uint8Array(size);let offset=0;
        for(const part of parts){result.set(part,offset);offset+=part.length;}
        return result;
    } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
}

export async function resolveRecord(publicKey,sources,verifySignature,{signal,timeout=10000}={}) {
    unhex(publicKey,32);const config=torrentSources(sources);
    let best=await cachedRecord(publicKey,verifySignature);
    const controller=new AbortController();
    const abort=()=>controller.abort(signal.reason||fail("CANCELLED","Publication lookup cancelled"));
    if(signal?.aborted)throw signal.reason;
    signal?.addEventListener("abort",abort,{once:true});
    const timer=setTimeout(()=>controller.abort(fail("PUBLICATION_UNAVAILABLE","Publication lookup timed out")),timeout);
    try {
        const responses=await Promise.allSettled(config.apis.map(async api=>{
            const response=await fetch(api+"/v1/names/"+publicKey,{signal:controller.signal,
                credentials:"omit",redirect:"error",cache:"no-store"});
            if(response.status===404)return null;
            if(!response.ok)throw fail("PUBLICATION_UNAVAILABLE","Publication source returned "+response.status);
            const bytes=await boundedBytes(response,4096);
            return parseRecord(new TextDecoder("utf-8",{fatal:true}).decode(bytes),publicKey,verifySignature);
        }));
        if(signal?.aborted)throw signal.reason;
        const seen=new Map();if(best)seen.set(best.sequence,best.infoHash);
        for(const result of responses) {
            if(result.status!=="fulfilled" || !result.value)continue;
            const candidate=result.value,previous=seen.get(candidate.sequence);
            if(previous!==undefined && previous!==candidate.infoHash)
                throw fail("PUBLICATION_CONFLICT","Sources returned conflicting publications with the same sequence");
            seen.set(candidate.sequence,candidate.infoHash);
            if(!best || candidate.sequence>best.sequence)best=candidate;
        }
        if(best)return await observeRecord(best,publicKey,verifySignature);
        if(responses.some(result=>result.status==="fulfilled"))return null;
        throw fail("PUBLICATION_UNAVAILABLE","No signed publication source is available");
    } finally {
        clearTimeout(timer);signal?.removeEventListener("abort",abort);
    }
}
