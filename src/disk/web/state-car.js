import {CID} from 'multiformats/cid';
import {sha256} from 'multiformats/hashes/sha2';
import {decode as decodePB} from '@ipld/dag-pb';
import {decode as decodeCBOR} from '@ipld/dag-cbor';
import {UnixFS} from 'ipfs-unixfs';

export const CAR_LIMITS=Object.freeze({block:4*1048576,header:65536,proof:8*1048576,
    depth:64,blocks:16384,queue:1048576,lanes:4,idleMs:2000,selectionMs:2500});
const L=CAR_LIMITS;
const fail=(code,message)=>Object.assign(new Error(message),{code});
const check=signal=>{if(signal?.aborted)throw fail('CANCELLED','Operation cancelled');};
const invalid=message=>fail('CORRUPTION',message);

// Own one browser chunk and one bounded CAR section; never concatenate the
// unread response. Browser-internal buffering is outside this application bound.
class CarReader {
    constructor(reader,read,limit) {this.reader=reader;this.read=read;this.limit=limit;this.chunk=new Uint8Array();this.offset=0;this.received=0;}
    async available() {
        while(this.offset===this.chunk.length) {
            const {done,value}=await this.read(()=>this.reader.read());
            if(done)return false;
            if(!(value instanceof Uint8Array))throw invalid('Invalid CAR response chunk');
            this.received+=value.length;
            if(this.received>this.limit)throw invalid('CAR response exceeds its byte budget');
            this.chunk=value;this.offset=0;
        }
        return true;
    }
    async byte() {if(!await this.available())throw invalid('Truncated CAR');return this.chunk[this.offset++];}
    async section(limit,optional=false) {
        if(optional&&!await this.available())return;
        let length=0,scale=1,count=0;
        for(;;) {
            const value=await this.byte();length+=(value&127)*scale;count++;
            if(count>5||length>limit)throw invalid('CAR section exceeds its limit');
            if(!(value&128)) {if(count>1&&value===0)throw invalid('Noncanonical CAR length');break;}
            scale*=128;
        }
        if(!length)throw invalid('Empty CAR section');
        const result=new Uint8Array(length);
        for(let offset=0;offset<length;) {
            if(!await this.available())throw invalid('Truncated CAR');
            const take=Math.min(length-offset,this.chunk.length-this.offset);
            result.set(this.chunk.subarray(this.offset,this.offset+take),offset);this.offset+=take;offset+=take;
        }
        return result;
    }
}

// Each visited child is named by its authenticated parent. Walk only the range
// requested, in DFS order, and verify whole leaves before exposing their slices.
// This handles raw leaves, protobuf leaves, inline data and nested UnixFS files.
export async function* verifiedCarRange(source,{cid,size,offset,length,signal,onBlock}) {
    const header=decodeCBOR(await source.section(L.header));
    if(header.version!==1||header.roots?.length!==1||!CID.asCID(header.roots[0])?.equals(cid))throw invalid('CAR root does not match the state');
    let blocks=0,proof=0,delivered=0;
    async function* visit(expected,total,start,end,depth) {
        check(signal);
        if(depth>L.depth||++blocks>L.blocks)throw invalid('CAR traversal exceeds its limit');
        const section=await source.section(L.block+512);
        const [actual,bytes]=CID.decodeFirst(section);
        if(!actual.equals(expected)||bytes.length>L.block)throw invalid('CAR block does not match the requested DAG');
        const digest=actual.multihash.code===0?bytes:actual.multihash.code===sha256.code?(await sha256.digest(bytes)).digest:undefined;
        check(signal);
        if(!digest||digest.length!==actual.multihash.digest.length||!digest.every((b,i)=>b===actual.multihash.digest[i]))throw invalid('CAR block does not match its CID');
        if(onBlock)await onBlock(actual,bytes);
        if(actual.code===0x55) {
            if(bytes.length!==total)throw invalid('Invalid UnixFS leaf size');
            if(end>start)yield bytes.subarray(start,end);
            return;
        }
        if(actual.code!==0x70)throw fail('UNSUPPORTED_FORMAT','Unsupported state DAG codec');
        proof+=bytes.length;if(proof>L.proof)throw invalid('CAR proof exceeds its limit');
        const node=decodePB(bytes),file=UnixFS.unmarshal(node.Data);
        if(!['file','raw'].includes(file.type)||node.Links.length!==file.blockSizes.length)throw invalid('Invalid UnixFS state node');
        const data=file.data||new Uint8Array(),sizes=file.blockSizes.map(Number);
        if(sizes.some(n=>!Number.isSafeInteger(n)||n<=0)||!Number.isSafeInteger(total)||
           data.length+sizes.reduce((a,b)=>a+b,0)!==total||BigInt(total)!==file.fileSize())throw invalid('Invalid UnixFS state length');
        if(start<data.length)yield data.subarray(start,Math.min(end,data.length));
        let position=data.length;
        for(let i=0;i<node.Links.length;i++) {
            const next=position+sizes[i];
            if(next>start&&position<end)yield* visit(node.Links[i].Hash,sizes[i],Math.max(0,start-position),Math.min(sizes[i],end-position),depth+1);
            position=next;
        }
    }
    for await(const bytes of visit(cid,size,offset,offset+length,0)) {delivered+=bytes.length;yield bytes;}
    if(delivered!==length)throw invalid('Incomplete CAR range');
    if(await source.section(L.block+512,true))throw invalid('Unexpected trailing CAR block');
}

export async function* fetchCarRange({cid,size,offset,length,gateway,signal,acquire,onNetwork,timeoutMs=30000,onEvent,onBlock}) {
    check(signal);
    const controller=new AbortController(),abort=()=>controller.abort();
    signal?.addEventListener('abort',abort,{once:true});
    let reader,release,waited=0;
    // Arm timeouts only while awaiting I/O, not while a bounded output queue
    // applies backpressure. A dripping response also has a total I/O budget.
    async function io(operation) {
        check(signal);check(controller.signal);
        const start=performance.now(),remaining=timeoutMs-waited;
        if(remaining<=0)throw fail('IO_ERROR','CAR transfer timed out');
        let timer,stop;
        try {
            return await Promise.race([operation(),new Promise((_,reject)=>{
                stop=()=>reject(fail('CANCELLED','Operation cancelled'));
                controller.signal.addEventListener('abort',stop,{once:true});
                timer=setTimeout(()=>{reject(fail('IO_ERROR','CAR transfer stalled'));controller.abort();},Math.min(L.idleMs,remaining));
                if(controller.signal.aborted)stop();
            })]);
        } finally {waited+=performance.now()-start;clearTimeout(timer);controller.signal.removeEventListener('abort',stop);}
    }
    try {
        release=await acquire(signal);check(signal);
        const url=gateway+'/ipfs/'+cid+'?format=car&dag-scope=entity&car-order=dfs&car-dups=y&entity-bytes='+offset+':'+(offset+length-1);
        onNetwork?.(0,1);onEvent?.('car-start',{gateway,offset,length});
        const response=await io(()=>fetch(url,{headers:{Accept:'application/vnd.ipld.car;version=1;order=dfs;dups=y'},signal:controller.signal,
            credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer'}));
        if(!response.ok||response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/vnd.ipld.car'||!response.body)
            throw fail('IO_ERROR','Provider does not support CAR ranges');
        const budget=length+2*L.block+L.proof+L.header+L.blocks*512;
        if(Number(response.headers.get('content-length'))>budget)throw invalid('CAR response exceeds its byte budget');
        reader=response.body.getReader();
        const source=new CarReader(reader,async operation=>{const item=await io(operation);check(signal);if(!item.done)onNetwork?.(item.value.length,0);return item;},budget);
        yield* verifiedCarRange(source,{cid,size,offset,length,signal,onBlock});
        onEvent?.('car-end',{gateway,offset,length});
    } finally {
        controller.abort();signal?.removeEventListener('abort',abort);
        await reader?.cancel().catch(()=>{});reader?.releaseLock();release?.();
    }
}

const wait=(ms,signal)=>new Promise((resolve,reject)=>{
    const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(fail('CANCELLED','Operation cancelled'));};
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
});

export async function* parallelCarState({cid,size,signal,lanes,candidates,discovering,failed,acquire,onNetwork,onEvent,timeoutMs,onSelected,onBlock}) {
    const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
    const selectedSignal=controller.signal,probes=new Map(),tried=new Set(),readers=[];
    const count=Math.min(L.lanes,lanes,Math.ceil(size/1048576));
    const stride=Math.ceil(size/count/262144)*262144;
    const ranges=Array.from({length:count},(_,i)=>({offset:i*stride,length:Math.min(stride,size-i*stride)})).filter(r=>r.length>0);
    let failure,winner;
    const make=(gateway,range,localSignal)=>fetchCarRange({cid,size,...range,gateway,signal:localSignal,acquire,onNetwork,onEvent,timeoutMs,onBlock});
    try {
        check(signal);
        const deadline=Date.now()+Math.min(L.selectionMs,timeoutMs);
        while(!winner) {
            check(signal);
            for(const gateway of candidates()) {
                if(probes.size>=2||tried.size>=4)break;
                if(tried.has(gateway))continue;tried.add(gateway);
                const local=new AbortController(),cancel=()=>local.abort();selectedSignal.addEventListener('abort',cancel,{once:true});
                const iterator=make(gateway,ranges[0],local.signal);
                const probe={gateway,local,iterator,cancel};
                probe.promise=iterator.next().then(first=>({probe,first}),error=>({probe,error}));probes.set(gateway,probe);
            }
            if(!probes.size&&(!discovering()||Date.now()>=deadline||tried.size>=4))throw fail('IO_ERROR','No CAR provider available');
            if(Date.now()>=deadline)throw fail('IO_ERROR','CAR provider selection timed out');
            const result=await Promise.race([...probes.values()].map(p=>p.promise).concat(wait(Math.min(100,deadline-Date.now()),signal)));
            if(!result)continue;
            probes.delete(result.probe.gateway);
            if(result.error||result.first.done) {
                const error=result.error||invalid('Empty CAR range');failed(result.probe.gateway,error);
                result.probe.local.abort();selectedSignal.removeEventListener('abort',result.probe.cancel);
                await result.probe.iterator.return?.().catch(()=>{});continue;
            }
            winner={...result.probe,first:result.first};
        }
        for(const probe of probes.values()) {probe.local.abort();selectedSignal.removeEventListener('abort',probe.cancel);void probe.iterator.return?.().catch(()=>{});}
        probes.clear();onSelected?.(winner.gateway,ranges.length);
        const first=winner;
        const iterators=ranges.map((range,i)=>i===0?(async function*(){yield first.first.value;yield* first.iterator;})():make(winner.gateway,range,selectedSignal));
        for(const iterator of iterators) {
            const stream=new ReadableStream({async pull(output) {
                try {check(selectedSignal);const item=await iterator.next();if(item.done)output.close();else output.enqueue(item.value);}
                catch(error) {failure??=error;controller.abort();output.error(error);}
            },async cancel(){await iterator.return?.().catch(()=>{});}},new ByteLengthQueuingStrategy({highWaterMark:L.queue}));
            readers.push(stream.getReader());
        }
        for(const reader of readers) for(;;) {
            check(signal);if(failure)throw failure;
            const item=await reader.read();check(signal);if(failure)throw failure;if(item.done)break;yield item.value;
        }
    } catch(error) {
        error=failure||error;
        if(winner&&!signal?.aborted)failed(winner.gateway,error);
        throw error;
    } finally {
        controller.abort();signal?.removeEventListener('abort',abort);
        if(winner) {winner.local.abort();selectedSignal.removeEventListener('abort',winner.cancel);}
        for(const probe of probes.values()) {probe.local.abort();selectedSignal.removeEventListener('abort',probe.cancel);void probe.iterator.return?.().catch(()=>{});}
        await Promise.all(readers.map(async reader=>{await reader.cancel().catch(()=>{});reader.releaseLock();}));
        if(winner)await winner.iterator.return?.().catch(()=>{});
    }
}
