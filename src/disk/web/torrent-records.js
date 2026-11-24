import {openTorrentDatabase} from "./torrent-store.js";
import {verifyRecord,parseRecord,PUBLICATION_SALT,hex,unhex,sequence} from "./torrent-protocol.js";
import {torrentSources} from "./torrent-sources.js";
const fail=(code,message)=>Object.assign(new Error(message),{code});
const conflict=()=>Object.assign(fail("PUBLICATION_CONFLICT","Conflicting signed publications have the same sequence"),{verifiedConflict:true});
function rowState(row,key,verify) {
    if(!row)return {record:null,proof:null,blocked:false};
    const record=verifyRecord(row,key,verify);let proof=null;
    if(row.conflictProof!==undefined) {
        if(!Array.isArray(row.conflictProof)||row.conflictProof.length!==2)throw fail("STORAGE_ERROR","Publication replay protection is corrupt");
        proof=row.conflictProof.map(value=>verifyRecord(value,key,verify));
        if(proof[0].sequence!==proof[1].sequence||proof[0].value===proof[1].value||sequence(proof[0].sequence)>sequence(record.sequence))throw fail("STORAGE_ERROR","Publication conflict evidence is corrupt");
    }
    return {record,proof,blocked:proof?.[0].sequence===record.sequence};
}
async function cachedState(key,verify) {
    unhex(key,32);const db=await openTorrentDatabase();
    try {return await new Promise((resolve,reject)=>{
        const request=db.transaction(["names"]).objectStore("names").get(key);
        request.onsuccess=()=>{try{resolve(rowState(request.result,key,verify));}catch{reject(fail("STORAGE_ERROR","Publication replay protection is corrupt; explicit recovery is required"));}};
        request.onerror=()=>reject(request.error);
    });}finally{db.close();}
}
const OBSERVATIONS="my98-publication-observations-v1";
function announce(key) {
    if(typeof BroadcastChannel!=="function")return;
    try {const channel=new BroadcastChannel(OBSERVATIONS);channel.postMessage({publicKey:key});channel.close();}catch{}
}
// Notifications contain no trusted data. Always re-read and authenticate the
// committed row, including both signed proofs, before affecting another session.
export function watchRecord(key,verify,onChange,onError=()=>{}) {
    let closed=false,running=false,again=false;
    const refresh=async()=>{
        if(running){again=true;return;}running=true;
        try{do{again=false;const state=await cachedState(key,verify);if(!closed)onChange(state);}while(again&&!closed);}
        catch(error){if(!closed)onError(error);}finally{running=false;}
    };
    let channel=null;try{if(typeof BroadcastChannel==="function")channel=new BroadcastChannel(OBSERVATIONS);}catch{}
    if(channel)channel.onmessage=event=>{if(event.data?.publicKey===key)void refresh();};
    const timer=channel?null:setInterval(()=>void refresh(),1000);
    void refresh();
    return ()=>{closed=true;channel?.close();if(timer!==null)clearInterval(timer);};
}
export async function cachedRecord(key,verify) {
    const state=await cachedState(key,verify);if(state.blocked)throw conflict();return state.record;
}
// Selection and the durable high-water mark share one transaction. A stale
// gateway cannot race another tab into returning an obsolete local candidate.
async function acceptRecord(value,key,verify,{strict=false,proof:extraProof}={}) {
    const candidate=verifyRecord(value,key,verify),db=await openTorrentDatabase();
    try {return await new Promise((resolve,reject)=>{
        const tx=db.transaction(["names"],"readwrite"),store=tx.objectStore("names");let state,error,logical,changed=false;
        tx.onabort=()=>{
            const cause=error||tx.error;
            reject(cause?.name==="QuotaExceededError"?fail("STORAGE_FULL","Not enough browser storage to preserve the publication sequence"):
                typeof cause?.code==="string"?cause:fail("STORAGE_ERROR","Could not preserve publication replay protection"));
        };
        tx.oncomplete=()=>{if(changed)announce(key);logical?reject(logical):resolve(state);};
        const request=store.get(key);
        request.onsuccess=()=>{try{
            const previous=rowState(request.result,key,verify);let record=previous.record,proof=previous.proof;
            if(!record||sequence(candidate.sequence)>sequence(record.sequence))record=candidate;
            else if(candidate.sequence===record.sequence&&candidate.value!==record.value)extraProof=[record,candidate];
            else if(strict&&sequence(candidate.sequence)<sequence(record.sequence))logical=fail("PUBLICATION_CONFLICT","Publication is older than the highest observed version");
            if(extraProof) {
                const pair=extraProof.map(v=>verifyRecord(v,key,verify));
                if(pair.length!==2||pair[0].sequence!==pair[1].sequence||pair[0].value===pair[1].value)throw fail("INVALID_PUBLICATION","Invalid conflict evidence");
                if(!proof||sequence(pair[0].sequence)>=sequence(proof[0].sequence))proof=pair;
            }
            changed=!previous.record||record.sequence!==previous.record.sequence||record.value!==previous.record.value||
                proof?.[0].sequence!==previous.proof?.[0].sequence||
                !!proof&&proof.some(v=>!previous.proof?.some(old=>old.value===v.value));
            if(changed)store.put({...record,publicKey:key,...(proof?{conflictProof:proof}:{})});
            state={record,proof,blocked:proof?.[0].sequence===record.sequence};
            if(strict&&state.blocked)logical=conflict();
        }catch(cause){error=cause;tx.abort();}};
    });}finally{db.close();}
}
export async function observeRecord(value,key,verify) {
    return (await acceptRecord(value,key,verify,{strict:true})).record;
}
export async function boundedBytes(response,limit) {
    const length=response.headers.get("Content-Length");
    if(length!==null&&(!/^[0-9]+$/.test(length)||Number(length)>limit))throw fail("INVALID_PUBLICATION","Publication response is too large");
    if(!response.body)throw fail("PUBLICATION_UNAVAILABLE","Publication response has no body");
    const reader=response.body.getReader(),parts=[];let size=0;
    try {
        for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit)throw fail("INVALID_PUBLICATION","Publication response exceeds its size limit");parts.push(value);}
        const result=new Uint8Array(size);let offset=0;for(const part of parts){result.set(part,offset);offset+=part.length;}return result;
    }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
function unavailable(message) {
    return Object.assign(fail("PUBLICATION_UNAVAILABLE",message),{retryable:true});
}
function gatewayError(status) {
    const error=fail(status===409?"GATEWAY_CONFLICT":"PUBLICATION_UNAVAILABLE",status===409?"A gateway reported a conflict without signed evidence":"Publication source returned "+status);
    error.retryable=[429,502,503,504].includes(status);return error;
}
const RETRY_DELAYS=[250,750];
function retryDelay(ms,signal) {
    if(signal.aborted)return Promise.reject(signal.reason);
    return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{signal.removeEventListener("abort",abort);resolve();},ms);
        const abort=()=>{clearTimeout(timer);signal.removeEventListener("abort",abort);reject(signal.reason);};
        signal.addEventListener("abort",abort,{once:true});
    });
}
async function streamRecords(response,accept) {
    if(!response.body)throw fail("PUBLICATION_UNAVAILABLE","Publication stream has no body");
    const reader=response.body.getReader(),decoder=new TextDecoder("utf-8",{fatal:true});
    let buffer="",event="",data=[],total=0,count=0,ended=false;
    async function line(value) {
        if(value.endsWith("\r"))value=value.slice(0,-1);
        if(!value) {
            if(!data.length){event="";return;}
            if(++count>128)throw fail("INVALID_PUBLICATION","Too many publication observations");
            let message;try{message=JSON.parse(data.join("\n"));}catch{throw fail("INVALID_PUBLICATION","Invalid publication event");}
            if(event==="record")await accept(message);
            else if(event==="done") {
                if(!message||!Object.hasOwn(message,"record")||!Object.hasOwn(message,"error"))throw fail("INVALID_PUBLICATION","Invalid terminal publication event");
                if(message.error!==null) {
                    const status=message.error?.status;
                    if(message.record!==null||!Number.isInteger(status)||status<400||status>599)throw fail("INVALID_PUBLICATION","Invalid publication error");
                    if(status!==404)throw gatewayError(status);
                }else if(message.record!==null)await accept(message.record);
                ended=true;
            }
            event="";data=[];return;
        }
        if(value.length>8192)throw fail("INVALID_PUBLICATION","Publication event is too large");
        if(value.startsWith(":"))return;
        const colon=value.indexOf(":"),name=colon<0?value:value.slice(0,colon);let text=colon<0?"":value.slice(colon+1);if(text.startsWith(" "))text=text.slice(1);
        if(name==="event")event=text;
        if(name==="data"){data.push(text);if(data.join("\n").length>8192)throw fail("INVALID_PUBLICATION","Publication event is too large");}
    }
    try {
        while(!ended) {
            const {done,value}=await reader.read();if(done)break;
            total+=value.byteLength;if(total>1024*1024)throw fail("INVALID_PUBLICATION","Publication stream exceeds its limit");
            buffer+=decoder.decode(value,{stream:true});
            let newline;while(!ended&&(newline=buffer.indexOf("\n"))>=0){const text=buffer.slice(0,newline);buffer=buffer.slice(newline+1);await line(text);}
            if(buffer.length>8192)throw fail("INVALID_PUBLICATION","Publication line is too large");
        }
        if(!ended)throw unavailable("Publication stream ended before its final result");
    }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function resolveRecord(publicKey,sources,verifySignature,{signal,timeout=125000,onRecord,onStatus=()=>{}}={}) {
    unhex(publicKey,32);const config=torrentSources(sources),initial=await cachedState(publicKey,verifySignature);
    if(signal?.aborted)throw signal.reason;
    const controller=new AbortController(),abort=()=>controller.abort(signal.reason||fail("CANCELLED","Publication lookup cancelled"));
    signal?.addEventListener("abort",abort,{once:true});
    const timer=setTimeout(()=>controller.abort(fail("PUBLICATION_UNAVAILABLE","Publication lookup timed out")),timeout);
    let best=initial.record,blocked=initial.blocked,delivered=null,fatal,observations=Promise.resolve(),reportedConflict=false;
    const seen=new Map();if(best)seen.set(best.sequence,best);
    const status=(state,error)=>onStatus({state,sequence:best?.sequence??null,infoHash:best?.infoHash??null,...(error?{error:{code:error.code||"PUBLICATION_UNAVAILABLE",message:error.message},fatal:!!error.verifiedConflict}:{})});
    async function deliver() {
        if(signal?.aborted)throw signal.reason;
        if(best&&!blocked&&delivered!==best.sequence+":"+best.value) {
            delivered=best.sequence+":"+best.value;await onRecord?.(best);status("checking");
        }
    }
    function accept(value) {
        const job=observations.then(async()=>{
            if(controller.signal.aborted)throw controller.signal.reason;
            const record=verifyRecord(value,publicKey,verifySignature),previous=seen.get(record.sequence);
            const proof=previous&&previous.value!==record.value?[previous,record]:undefined;
            seen.set(record.sequence,record);
            let state;
            try {state=await acceptRecord(record,publicKey,verifySignature,{proof});}
            catch(error) {
                if(proof&&delivered){fatal=conflict();fatal.message+=". Could not preserve conflict evidence: "+error.message;status("conflict",fatal);controller.abort(fatal);throw fatal;}
                throw error;
            }
            best=state.record;blocked=state.blocked;
            if(blocked) {
                if(delivered){fatal=conflict();status("conflict",fatal);controller.abort(fatal);throw fatal;}
                return;
            }
            await deliver();
        });
        observations=job.catch(()=>{});return job;
    }
    try {
        status("checking");await deliver();
        const responses=await Promise.allSettled(config.gateways.map(async api=>{
            for(let attempt=0;;attempt++) {
                try {
                    let response;
                    try {response=await fetch(api+"/dht/mutable/"+publicKey+"?salt="+hex(new TextEncoder().encode(PUBLICATION_SALT)),{
                        headers:{Accept:"text/event-stream, application/json"},signal:controller.signal,credentials:"omit",redirect:"error",cache:"no-store"});}
                    catch(error) {if(controller.signal.aborted)throw controller.signal.reason;throw Object.assign(unavailable("Could not reach publication source"),{cause:error});}
                    if(response.status===404)return;
                    if(!response.ok){await response.body?.cancel().catch(()=>{});throw gatewayError(response.status);}
                    if(response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase()==="text/event-stream")await streamRecords(response,accept);
                    else await accept(parseRecord(new TextDecoder("utf-8",{fatal:true}).decode(await boundedBytes(response,4096)),publicKey,verifySignature));
                    return;
                }catch(error) {
                    if(controller.signal.aborted)throw controller.signal.reason;
                    // Recover cold transient failures only. Never replay callbacks,
                    // retry verification/storage/conflict errors or extend the deadline.
                    if(!error.retryable||delivered||attempt>=RETRY_DELAYS.length)throw error;
                    await retryDelay(RETRY_DELAYS[attempt],controller.signal);
                }
            }
        }));
        await observations;
        if(signal?.aborted)throw signal.reason;
        if(fatal)throw fatal;
        // Re-read the durable winner: another tab may have advanced or proved a
        // fork while every response here was stale, absent or unavailable.
        const latest=await cachedState(publicKey,verifySignature);best=latest.record;blocked=latest.blocked;
        if(blocked)throw conflict();
        await deliver();
        const errors=responses.filter(r=>r.status==="rejected").map(r=>r.reason);
        reportedConflict=errors.some(e=>e.code==="GATEWAY_CONFLICT");
        status(errors.length?"unavailable":"complete",reportedConflict?errors.find(e=>e.code==="GATEWAY_CONFLICT"):errors[0]);
        if(best)return best;
        const storage=errors.find(error=>/^STORAGE_/.test(error.code||""));if(storage)throw storage;
        if(responses.some(r=>r.status==="fulfilled"))return null;
        throw (reportedConflict?errors.find(e=>e.code==="GATEWAY_CONFLICT"):errors[0])||fail("PUBLICATION_UNAVAILABLE","No signed publication source is available");
    }catch(error){status(error.verifiedConflict?"conflict":"unavailable",error);throw error;}
    finally{clearTimeout(timer);signal?.removeEventListener("abort",abort);}
}
