import {openTorrentDatabase} from "./torrent-store.js";
import {resolveRecord,observeRecord,boundedBytes} from "./torrent-records.js";
import {hex,unhex,verifyRecord,PUBLICATION_SALT} from "./torrent-protocol.js";
import {torrentSources} from "./torrent-sources.js";
const fail=(code,message)=>Object.assign(new Error(message),{code});
const salt=hex(new TextEncoder().encode(PUBLICATION_SALT));
let serial=0;
/** Synchronous signing inside the transaction allocates one durable sequence across tabs.
 * Only public signed records are persisted, never the payload or private material. */
export async function reservePublication({publicKey,infoHash,known,verify,sign,now=Date.now(),expected}) {
    const db=await openTorrentDatabase();
    try {return await new Promise((resolve,reject)=>{
        const tx=db.transaction(["names","publishing"],"readwrite"),records=tx.objectStore("publishing");
        let result,error,remaining=2;const previous=[];
        tx.onabort=()=>reject(error?.name==="QuotaExceededError"||tx.error?.name==="QuotaExceededError"?fail("STORAGE_FULL","Not enough browser storage to preserve the signed publication"):error||fail("STORAGE_ERROR","Could not preserve the signed publication"));
        tx.oncomplete=()=>resolve(result);
        const accept=(value,index)=>{
            previous[index]=value?verifyRecord(value,publicKey,verify):null;
            if(--remaining)return;
            let max=BigInt(Math.floor(now))-1n;
            if(expected)for(const value of [previous[0],known].filter(Boolean))
                if(BigInt(value.sequence)>BigInt(expected.sequence)||value.sequence===expected.sequence&&value.value!==expected.value)
                    throw fail('PUBLICATION_CONFLICT','The publication changed during preparation. Review it before retrying.');
            for(const value of [...previous,...(known?[known]:[])].filter(Boolean))if(BigInt(value.sequence)>max)max=BigInt(value.sequence);
            if(max>=9223372036854775807n)throw fail("PUBLICATION_CONFLICT","Publication sequence exhausted");
            result=verifyRecord(sign(unhex(infoHash,20),(max+1n).toString()),publicKey,verify);
            records.put({...result,publicKey});
        };
        for(const [index,request] of [tx.objectStore("names").get(publicKey),records.get(publicKey)].entries())request.onsuccess=()=>{
            try{accept(request.result,index);}catch(cause){error=cause;tx.abort();}
        };
    });}finally{db.close();}
}
export class PublicationJob {
    constructor({io,sources,publicKey,verify,sign,onStatus=()=>{}}) {
        this.io=io;this.sources=torrentSources(sources);this.publicKey=publicKey;this.verify=verify;this.sign=sign;
        if(!this.sources.gateways.length||!this.sources.trackers.length)throw fail("INVALID_SOURCE","Configure a publishing gateway and WebRTC trackers");
        this.session="publication:"+(++serial);this.onStatus=onStatus;this.lifetime=new AbortController();this.active=true;this.sent=false;
    }
    status(state,error) {
        this.state=state;this.error=error;
        const value={active:this.active,state,replicas:this.replicas||{complete:0,fraction:0,connected:0,unavailable:0,label:'0'},...(this.seedError?{seedError:this.seedError}:{}),...(this.record?{sequence:this.record.sequence,magnet:`magnet:?xs=urn:btpk:${this.publicKey}&s=${salt}`,catalogMagnet:`magnet:?xt=urn:btih:${this.infoHash}`} : {}),
            ...(error?{error:{code:error.code||"PUBLICATION_UNAVAILABLE",message:error.message}}:{})};
        this.onStatus(value);return value;
    }
    async start(snapshot,signal,{previous,expected}={}) {
        this.infoHash=snapshot.infoHash;
        try {
            this.status("preparing");
            const parts=snapshot.parts||[{metadata:snapshot.diskMetadata,blob:snapshot.disk,kind:"disk"},{metadata:snapshot.catalogMetadata,blob:snapshot.catalog,kind:"catalog"}];
            await this.io.call("create",{session:this.session,sources:this.sources,root:snapshot.infoHash,kinds:parts.map(p=>p.kind)},signal);
            for(const part of parts)await this.io.call(part.blob?"seed":"reference",{session:this.session,...part},signal);
            if(previous) {this.previous=previous;await previous.suspend();}
            const known=await resolveRecord(this.publicKey,this.sources,this.verify,{signal});
            if(expected&&(!known||known.sequence!==expected.sequence||known.value!==expected.value))throw fail('PUBLICATION_CONFLICT','The publication changed during preparation. Review it before retrying.');
            this.record=await reservePublication({publicKey:this.publicKey,infoHash:this.infoHash,known,verify:this.verify,sign:this.sign,expected});
            if(signal?.aborted)throw signal.reason||fail("CANCELLED","Publication cancelled");
            this.sent=true;
            return await this.announce(signal,false);
        } catch(error) {
            if(!this.sent){this.previous=undefined;previous?.resume();await this.stop();throw error;}
            this.status("unconfirmed",error);return this.current();
        }
    }
    current(){return this.status(this.state,this.error);}
    replication(value){if(this.active){this.replicas=value;this.current();}}
    seedingError(error){if(this.active){this.seedError=error;this.current();}}
    announce(signal=this.lifetime.signal,reconcile=true) {
        if(this.flight)return this.flight;
        this.flight=this.doAnnounce(signal,reconcile).finally(()=>{this.flight=null;});return this.flight;
    }
    async doAnnounce(signal,reconcile) {
        clearTimeout(this.timer);
        this.status("announcing");
        try {
            // Reconcile a possibly accepted previous request before sending the SAME record.
            const latest=reconcile?await resolveRecord(this.publicKey,this.sources,this.verify,{signal}):null;
            if(latest&&(BigInt(latest.sequence)>BigInt(this.record.sequence)||latest.sequence===this.record.sequence&&latest.value!==this.record.value))
                throw fail("PUBLICATION_CONFLICT","A newer or conflicting publication exists. This snapshot will not be reannounced.");
            let stored=false,last;
            for(const gateway of this.sources.gateways) {
                const timeout=new AbortController(),abort=()=>timeout.abort(signal.reason);
                signal?.addEventListener("abort",abort,{once:true});
                const timer=setTimeout(()=>timeout.abort(fail("PUBLICATION_UNAVAILABLE","DHT publication timed out")),125000);
                if(signal?.aborted)abort();
                try {
                    const response=await fetch(gateway+"/dht/mutable/"+this.publicKey+"?salt="+salt,{method:"PUT",headers:{"Content-Type":"application/json"},
                        body:JSON.stringify({sequence:this.record.sequence,signature:this.record.signature,value:this.record.value}),credentials:"omit",redirect:"error",cache:"no-store",signal:timeout.signal});
                    const text=new TextDecoder("utf-8",{fatal:true}).decode(await boundedBytes(response,4096));
                    if(!response.ok)throw fail(response.status===409?"PUBLICATION_CONFLICT":"PUBLICATION_UNAVAILABLE",response.status===403?"This gateway has signed publication disabled":"DHT publication returned "+response.status);
                    const result=JSON.parse(text);
                    if(!Number.isSafeInteger(result.acknowledged_nodes)||result.acknowledged_nodes<1||result.target!==this.target)
                        throw fail("INVALID_PUBLICATION","Invalid DHT acknowledgement");
                    stored=true;break;
                }catch(error){last=error instanceof TypeError?fail('PUBLICATION_UNAVAILABLE','Could not reach the publishing gateway. Check your connection and gateway support.'):error;if(signal?.aborted||error.code==="PUBLICATION_CONFLICT"||error.code==="INVALID_PUBLICATION")throw error;}
                finally{clearTimeout(timer);signal?.removeEventListener("abort",abort);}
            }
            if(!stored)throw last||fail("PUBLICATION_UNAVAILABLE","No publishing gateway responded");
            await observeRecord(this.record,this.publicKey,this.verify);
            if(this.previous){await this.previous.stop();this.previous=undefined;}
            this.status("seeding");this.schedule(20*60*1000);
        }catch(error){
            this.status("unconfirmed",error);
            if(!signal?.aborted&&!this.lifetime.signal.aborted&&!['PUBLICATION_CONFLICT','INVALID_PUBLICATION'].includes(error.code))this.schedule(15000);
        }
        return this.current();
    }
    schedule(ms){clearTimeout(this.timer);if(this.active&&!this.suspended)this.timer=setTimeout(()=>{void this.announce().catch(error=>this.status("unconfirmed",error));},ms);}
    async suspend(){this.suspended=true;clearTimeout(this.timer);await this.flight;}
    resume(){this.suspended=false;this.schedule(20*60*1000);}
    async stop(){if(this.previous){await this.previous.stop();this.previous=undefined;}this.active=false;clearTimeout(this.timer);this.lifetime.abort(fail("CANCELLED","Seeding stopped"));await this.io.call("close",{session:this.session}).catch(()=>{});this.status("stopped");}
}
