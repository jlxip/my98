import {CID} from 'multiformats/cid';
import {exporter} from 'ipfs-unixfs-exporter';
import {parallelCarState} from './state-car.js';
import {cachedStateContent} from './cached-state.js';

export const BLOCK_LIMIT = 4 * 1024 * 1024;
const STATE_WINDOW = 2 * 1024 * 1024;
const STATE_RANGE = 4 * 1024 * 1024;
const fail = (code, message) => Object.assign(new Error(message), {code});
const check = signal => { if(signal?.aborted) throw fail('CANCELLED', 'Operation cancelled'); };

/** Owns the optional published-state transfer; all network slots remain on RemoteDisk. */
export class PublishedStateTransport {
    constructor(remote) {this.remote=remote;this.pendingState=undefined;this.stateDownloads=0;this.stateTransfer=undefined;}
    cancel() {this.pendingState?.controller.abort();this.pendingState=undefined;}
    async openStateStream(signal, progress) {
        const remote=this.remote;
        check(signal);
        const pending=this.pendingState;
        if(!pending)return this.createStateStream(signal,progress);
        this.pendingState=undefined;pending.progress=progress;pending.priority='demand';
        for(const job of remote.jobs.values())if(job.priority==='state') {
            job.priority='demand';for(const waiter of job.waiters)if(waiter.priority==='state')waiter.priority='demand';
        }
        remote.schedule();
        const abort=()=>pending.controller.abort();
        signal?.addEventListener('abort',abort,{once:true});
        const cleanup=()=>signal?.removeEventListener('abort',abort);
        pending.controller.signal.addEventListener('abort',cleanup,{once:true});
        try {
            const result=await pending.promise;check(signal);
            progress?.(pending.received||0,result.size);
            if(pending.controller.signal.aborted)cleanup();
            return result;
        } catch(error) {abort();cleanup();throw error;}
    }
    beginStatePrefetch(signal) {
        const remote=this.remote;
        const controller=new AbortController(),abort=()=>controller.abort();
        signal?.addEventListener('abort',abort,{once:true});
        const pending=this.pendingState={controller,priority:'state',progress:remote.onStateProgress};
        pending.promise=this.createStateStream(controller.signal,(received,total)=>{
            pending.received=received;pending.progress?.(received,total);
        },()=>{signal?.removeEventListener('abort',abort);controller.abort();},()=>pending.priority);
        // The disk can still open when optional state data is invalid. Its
        // error belongs to prepareState, which takes ownership of this promise.
        pending.promise.catch(()=>{});
    }
    async createStateStream(signal, progress, onFinish, priority=()=> 'demand') {
        const remote=this.remote;
        check(signal);
        if(!remote.stateCid) throw fail('INVALID_STATE','No state is published for this disk.');
        const resume = remote.prefetchState === 'running';
        const controller=new AbortController(), external=signal;
        const abort=()=>finish();external?.addEventListener('abort',abort,{once:true});
        signal=controller.signal;
        remote.readControllers.add(controller);
        this.stateDownloads = (this.stateDownloads || 0) + 1;
        if(resume) remote.prefetchState = 'suspended';
        let iterator,finished=false,blockBytes=0;
        const stateBlocks=new Map();
        const finish=(resumeAllowed=false)=>{
            if(finished)return;finished=true;controller.abort();
            external?.removeEventListener('abort',abort);this.stateDownloads--;
            stateBlocks.clear();blockBytes=0;
            remote.readControllers.delete(controller);onFinish?.();
            if(resume && resumeAllowed)remote.startPrefetch();
        };
        signal.addEventListener('abort',()=>finish(),{once:true});
        try {
            await remote.prefetchLoop;
            check(signal);
            // Do not retain another full encrypted state in the disk block cache.
            const store = {async *get(cid, options) {
                const key=cid.toV1().toString(), retained=remote.blocks.has(key);
                if(stateBlocks.has(key)) {yield stateBlocks.get(key);return;}
                try {for await(const bytes of remote.get(cid,{...options,signal,priority:priority(),cacheKind:'state'})) {
                    // A range traversal can touch the boundary leaf twice.
                    // Keep a small local cache instead of redownloading it or
                    // retaining the complete encrypted file in the disk cache.
                    if(!stateBlocks.has(key)) {stateBlocks.set(key,bytes);blockBytes+=bytes.length;}
                    while(blockBytes>BLOCK_LIMIT) {const first=stateBlocks.keys().next().value;blockBytes-=stateBlocks.get(first).length;stateBlocks.delete(first);}
                    yield bytes;
                }}
                finally {if(!retained && remote.blocks.has(key)) {remote.cacheBytes-=remote.blocks.get(key).length;remote.blocks.delete(key);}}
            }};
            // Capture before reading the root: a partial previous transfer is
            // useful without a complete marker. Fetch only its missing blocks.
            const cachedState=await remote.persistent.hasStateRoot(remote.stateCid);check(signal);
            const entry=await exporter(remote.stateCid,store,{signal,blockReadConcurrency:1});
            if(!['file','raw','identity'].includes(entry.type)) throw fail('INVALID_STATE','Published state is not a file.');
            const total=Number(entry.type==='file'?entry.unixfs.fileSize():entry.size);
            if(!Number.isSafeInteger(total) || total<12 || total>1024*1024*1024+65536) throw fail('INVALID_STATE','Invalid published state size.');
            // UnixFS's exporter has an internal push queue. Bound each traversal
            // too, so a slow/absent consumer cannot accumulate the whole file.
            // Exporter concurrency also counts completed out-of-order blocks.
            // Give it bounded lookahead beyond the actual network budget so a
            // slow head block does not leave the other download slots idle.
            const concurrency=2*remote.concurrency;
            this.stateTransfer={mode:'blocks',lanes:0,bytes:0,fallback:false};
            const transfer=this.stateTransfer;
            iterator=(async function*() {
                let received=0;
                if(cachedState) {yield* cachedStateContent(remote.stateCid,total,store,signal);return;}
                if(!cachedState&&remote.stateTransport==='auto'&&remote.concurrency>1&&total>=1048576&&entry.type==='file'&&entry.node?.Links?.length) {
                    try {
                        for await(const bytes of parallelCarState({cid:CID.parse(remote.stateCid),size:total,signal,
                            prefixBytes:!entry.unixfs.data?.length&&entry.node.Links.every((link,i)=>link.Hash.code===0x55&&Number(entry.unixfs.blockSizes[i])>0&&Number(entry.unixfs.blockSizes[i])<=262144)?1048576:0,
                            lanes:Math.min(4,remote.concurrency-1),candidates:()=>remote.carCandidates(),
                            discovering:()=>remote.discovery.state==='running',acquire:s=>remote.acquireCarRequest(s),
                            timeoutMs:remote.timeoutMs,onNetwork:remote.onNetwork,
                            onBlock:remote.persistent.options.state ? async(cid,bytes)=>{
                                if(signal.aborted)return;
                                if(remote.persistent.options.publication)await remote.persistent.putState(cid,bytes);
                                else remote.persistent.put(cid,bytes,'state');
                                // Let IDB callbacks run between buffered CAR bursts.
                                // The bounded read-only cache remains best-effort;
                                // full publication caching applies backpressure above.
                                if(remote.persistent.queueBytes>=1048576)await new Promise(resolve=>setTimeout(resolve,0));
                            } : undefined,
                            onEvent:(type,detail)=>remote.traceEvent(type,detail),
                            failed:(gateway,error)=>{
                                const endpoint=remote.endpoints.get(gateway);if(endpoint)endpoint.carDisabled=true;
                                remote.traceEvent('car-error',{gateway,code:error.code||'IO_ERROR'});
                            },
                            onSelected:(gateway,lanes)=>{
                                const endpoint=remote.endpoints.get(gateway);if(endpoint)endpoint.carVerified=true;
                                Object.assign(transfer,{mode:'car',gateway,lanes});
                            },
                        })) {received+=bytes.length;transfer.bytes=received;yield bytes;}
                        return;
                    } catch(error) {
                        check(signal);
                        Object.assign(transfer,{mode:'blocks',fallback:true,fallbackAt:received,reason:error.code||'IO_ERROR'});
                        remote.traceEvent('car-fallback',{offset:received,code:transfer.reason});
                    }
                }
                // Only bytes already emitted count as a checkpoint. Discard
                // unconsumed CAR queues, then resume the verified raw reader at
                // that exact offset without restarting decryption or gzip.
                for(let offset=received;offset<total;offset+=STATE_RANGE) {
                    check(signal);
                    yield* entry.content({signal,offset,length:Math.min(STATE_RANGE,total-offset),blockReadConcurrency:concurrency});
                }
            })();
            let size=0;
            const stream=new ReadableStream({
                async pull(output) {
                    try {
                        check(signal);const {done,value}=await iterator.next();check(signal);
                        if(done) {
                            if(size!==total)throw fail('INVALID_STATE','Incomplete published state.');
                            finish(true);output.close();return;
                        }
                        size+=value.length;
                        if(size>total)throw fail('INVALID_STATE','Published state exceeds its declared size.');
                        progress?.(size,total);output.enqueue(value);
                    } catch(error) {finish();output.error(error);await iterator.return?.().catch(()=>{});}
                },
                async cancel() {finish();await iterator.return?.().catch(()=>{});},
            },new ByteLengthQueuingStrategy({highWaterMark:STATE_WINDOW}));
            return {size:total,stream,validated:()=>remote.persistent.complete(remote.stateCid)};
        } catch(error) {finish();throw error;}
    }
    // Preserve the collecting API for callers explicitly asking for a file.
    async downloadState(signal, progress) {
        const {stream}=await this.openStateStream(signal,progress),reader=stream.getReader(),parts=[];
        try {for(;;) {const {done,value}=await reader.read();if(done)break;parts.push(new Blob([value]));}
            return new Blob(parts,{type:'application/octet-stream'});
        } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
    }
}
