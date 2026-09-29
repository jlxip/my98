import {sha256} from 'multiformats/hashes/sha2';
import {gatewayURL} from './network-config.js';
import {BLOCK_LIMIT} from './state-transport.js';

const fail = (code, message) => Object.assign(new Error(message), {code});
const check = signal => { if(signal?.aborted) throw fail('CANCELLED', 'Operation cancelled'); };
export const retryDelay = failures => failures < 3 ? 0 : failures === 3 ? 1000 : failures === 4 ? 5000 : 10000;

/** Owns provider windows, block jobs and CAR admission under one global limit. */
export class BlockScheduler {
    constructor(remote) {
        this.remote=remote;
        this.endpoints=new Map();
        this.jobs=new Map();
        this.admissionWaiters=new Set();
        this.carActive=0;
    }
    cancel() {
        clearTimeout(this.scheduleTimer);
        for(const wake of this.admissionWaiters)wake();
        for(const job of this.jobs.values()) {
            job.controller.abort();
            job.reject(fail('CANCELLED','Operation cancelled'));
        }
        this.jobs.clear();
    }
    addEndpoint(value) {
        const url=gatewayURL(value);
        if(!this.endpoints.has(url)) this.endpoints.set(url,{url,active:0,window:2,credits:0,rescues:0,stalls:0,recovery:0,probationUntil:0,penalizedAt:0,latency:0,growAfter:0,dataSamples:0,attempts:0,validBytes:0,failures:0,consecutive:0,rate:0,cooldownUntil:0,excluded:false});
    }
    async acquireCarRequest(signal) {
        const remote=this.remote;
        const available=()=>this.carActive<Math.min(4,remote.concurrency-1) &&
            this.carActive+[...this.endpoints.values()].reduce((n,e)=>n+e.active,0)<remote.concurrency-1;
        while(!available()) {
            check(signal);if(remote.closed)throw fail('CANCELLED','Disk closed');
            await new Promise(resolve=>{
                const wake=()=>{this.admissionWaiters.delete(wake);signal?.removeEventListener('abort',wake);resolve();};
                this.admissionWaiters.add(wake);signal?.addEventListener('abort',wake,{once:true});if(signal?.aborted)wake();
            });
        }
        check(signal);if(remote.closed)throw fail('CANCELLED','Disk closed');this.carActive++;
        let released=false;
        return ()=>{if(released)return;released=true;this.carActive--;remote.schedule();remote.notifyAdmission();};
    }
    carCandidates() {
        const now=Date.now();
        return [...this.endpoints.values()].filter(e=>!e.excluded&&!e.carDisabled&&e.cooldownUntil<=now)
            .sort((a,b)=>(a.probationUntil>now)-(b.probationUntil>now)||(b.carVerified?1:0)-(a.carVerified?1:0)||b.rate-a.rate)
            .map(e=>e.url);
    }
    slowAfter(endpoint) {
        return Math.max(endpoint.dataSamples?250:750,Math.min(2000,3*endpoint.latency));
    }
    reduceWindow(endpoint) {
        const remote=this.remote;
        // Keep the proven two-slot baseline while reducing speculative growth.
        // A single slot serializes round trips after an isolated latency spike.
        endpoint.window=Math.max(Math.min(2,remote.concurrency),Math.floor(endpoint.window/2));endpoint.credits=0;
        endpoint.rate*=.5;endpoint.recovery=0;endpoint.penalizedAt=Date.now();
        endpoint.growAfter=endpoint.penalizedAt+1500;
    }
    notifyAdmission() {
        for(const wake of this.admissionWaiters) wake();
    }
    async admitBackground(signal, epoch) {
        const remote=this.remote;
        while([...this.jobs.values()].filter(j=>j.hasBackground).length>=8) {
            check(signal);
            if(epoch!==remote.epoch || remote.closed) throw fail('CANCELLED','Operation cancelled');
            await new Promise(resolve=>{
                const wake=()=>{this.admissionWaiters.delete(wake);signal?.removeEventListener('abort',wake);resolve();};
                this.admissionWaiters.add(wake);signal?.addEventListener('abort',wake,{once:true});
                if(signal?.aborted) wake();
            });
        }
        check(signal);
        if(epoch!==remote.epoch || remote.closed) throw fail('CANCELLED','Operation cancelled');
    }
    finishJob(job, error, bytes) {
        const remote=this.remote;
        if(this.jobs.get(job.key)!==job) return;
        this.jobs.delete(job.key);
        if(error) job.reject(error); else job.resolve(bytes);
        remote.notifyAdmission();
    }
    schedule() {
        const remote=this.remote;
        clearTimeout(this.scheduleTimer);
        if(remote.closed) return;
        const now=Date.now(), jobs=[...this.jobs.values()];
        let active=this.carActive+[...this.endpoints.values()].reduce((n,e)=>n+e.active,0), wakeAt=Infinity;
        const foreground=remote.demandReads || jobs.some(j=>j.priority!=='background');
        const order={demand:0,state:1,background:2};
        jobs.sort((a,b)=>order[a.priority]-order[b.priority]);
        for(const job of jobs) {
            const attempt=job.attempt;
            if(job.state==='active' && attempt && !job.rescued && job.priority!=='background') {
                const others=[...this.endpoints.values()].filter(e=>!e.excluded && !job.tried.has(e.url));
                if(others.length) {
                    const due=attempt.lastProgress+remote.slowAfter(attempt.endpoint);
                    const available=others.filter(e=>e.active<e.window && e.cooldownUntil<=now && e.probationUntil<=now);
                    // Progress alone is not sufficient: a trickling response
                    // can retain the ordered reader until the hard timeout.
                    // Only restart it when a provider with verified data samples
                    // is conservatively likely to finish the whole block sooner.
                    const bodyMs=now-attempt.firstByte;
                    const canEstimate=attempt.total>=65536 && attempt.received>0 && bodyMs>=250 && now-attempt.startedAt>=remote.slowAfter(attempt.endpoint);
                    const remainingMs=canEstimate ? (attempt.total-attempt.received)*bodyMs/attempt.received : 0;
                    const faster=canEstimate && available.some(e=>e.dataSamples && remainingMs>2*Math.max(150,1.5*e.latency,1.5*attempt.total/e.rate));
                    if(available.length && (now>=due || faster)) {
                        job.rescued=true;job.revisit=attempt.endpoint.url;attempt.rescue=true;
                        attempt.endpoint.rescues++;remote.reduceWindow(attempt.endpoint);
                        // A fast successful sample must not send every next
                        // window back to a provider repeatedly stalling. Prefer
                        // healthy alternatives until it has had time to recover.
                        attempt.endpoint.probationUntil=now+Math.min(8000,remote.slowAfter(attempt.endpoint)*2**Math.min(++attempt.endpoint.stalls,3));
                        remote.traceEvent('fetch-rescue',{cid:job.key,gateway:attempt.endpoint.url});
                        attempt.controller.abort();
                    } else wakeAt=Math.min(wakeAt,Math.max(now+100,Math.min(due,attempt.startedAt+remote.slowAfter(attempt.endpoint))));
                }
            }
            if(job.state!=='queued') continue;
            if(job.deadline && now>=job.deadline) {remote.finishJob(job,job.error || fail('IO_ERROR','IPFS block request timed out. You can retry.'));continue;}
            let remaining=[...this.endpoints.values()].filter(e=>!e.excluded && !job.tried.has(e.url));
            // An early rescue is speculative, not evidence that the original
            // provider cannot serve the block. Retain one ordinary fallback.
            if(!remaining.length && job.revisit) {
                job.tried.delete(job.revisit);job.revisit=undefined;
                remaining=[...this.endpoints.values()].filter(e=>!e.excluded && !job.tried.has(e.url));
            }
            if(!remaining.length && job.retryForever && [...this.endpoints.values()].some(e=>!e.excluded)) {
                job.tried.clear();
                job.retryAt=now+retryDelay(job.failures);
                remaining=[...this.endpoints.values()].filter(e=>!e.excluded);
            }
            if(!remaining.length && remote.discovery.state!=='running') {
                remote.finishJob(job,job.error || fail('IO_ERROR','No provider could serve this IPFS block. You can retry.'));continue;
            }
            if(job.retryAt>now) {wakeAt=Math.min(wakeAt,job.retryAt);continue;}
            if(job.deadline) wakeAt=Math.min(wakeAt,job.deadline);
            if(active>=remote.concurrency || (foreground && job.priority==='background')) continue;
            // Early state data may use spare capacity, but leave one slot for
            // the disk descriptor needed to authenticate/open the machine.
            if(job.priority==='state' && active>=Math.max(1,remote.concurrency-1))continue;
            for(const e of remaining) {
                if(e.cooldownUntil>now)wakeAt=Math.min(wakeAt,e.cooldownUntil);
                if(e.probationUntil>now)wakeAt=Math.min(wakeAt,e.probationUntil);
            }
            const healthyAlternative=remaining.some(e=>e.probationUntil<=now && e.cooldownUntil<=now);
            const eligible=remaining.filter(e=>e.active<e.window && e.cooldownUntil<=now && (!healthyAlternative || e.probationUntil<=now));
            eligible.sort((a,b)=>(a.attempts===0?0:1)-(b.attempts===0?0:1) || b.rate/(b.active+1)-a.rate/(a.active+1) || a.active-b.active);
            const endpoint=eligible[0];
            if(!endpoint) continue;
            if(!job.retryForever) job.deadline ??= now+remote.timeoutMs;
            job.tried.add(endpoint.url);job.state='active';endpoint.active++;endpoint.attempts++;active++;
            remote.runAttempt(job,endpoint);
            wakeAt=Math.min(wakeAt,now+remote.slowAfter(endpoint));
        }
        if(Number.isFinite(wakeAt)) this.scheduleTimer=setTimeout(()=>remote.schedule(),Math.max(1,wakeAt-Date.now()));
    }
    async runAttempt(job, endpoint) {
        const remote=this.remote;
        const started=performance.now(), live=()=>job.epoch===remote.epoch && !remote.closed && !job.controller.signal.aborted && this.jobs.get(job.key)===job;
        const controller=new AbortController(),abort=()=>controller.abort();
        job.controller.signal.addEventListener('abort',abort,{once:true});
        const attempt=job.attempt={controller,endpoint,startedAt:Date.now(),lastProgress:Date.now(),received:0,total:0};
        remote.traceEvent('fetch-start',{cid:job.key,priority:job.priority,gateway:endpoint.url,window:endpoint.window});
        try {
            const bytes=await remote.request(`/ipfs/${job.key}?format=raw`, 'application/vnd.ipld.raw', BLOCK_LIMIT, controller.signal, endpoint.url, job.deadline ? Math.min(5000,Math.max(1,job.deadline-Date.now())) : 5000,(received,total)=>{
                attempt.lastProgress=Date.now();attempt.firstByte??=attempt.lastProgress;attempt.received=received;attempt.total=total||0;
            });
            const digest=await sha256.digest(bytes);
            if(!live()) return;
            if(attempt.rescue)throw fail('CANCELLED','Block reassigned');
            if(!digest.digest.every((b,i)=>b===job.cid.multihash.digest[i]) || digest.digest.length!==job.cid.multihash.digest.length) throw fail('CORRUPTION','IPFS block does not match its CID.');
            const ms=Math.max(1,performance.now()-started), sample=bytes.length/ms;
            // Metadata has different transfer costs. Learn capacity from data
            // blocks; small DAG nodes must not distort the throughput estimate.
            if(bytes.length>=65536 && attempt.startedAt>=endpoint.penalizedAt) {
                // The first data transfer establishes a baseline: connection
                // setup must not collapse the initial window to a single slot.
                const healthy=!endpoint.dataSamples || ms<=Math.max(750,1.8*endpoint.latency);
                if(!healthy)remote.reduceWindow(endpoint);
                else if(Date.now()>=endpoint.growAfter && ++endpoint.credits>=endpoint.window) {
                    endpoint.window=Math.min(remote.concurrency,endpoint.window*2);endpoint.credits=0;
                }
                if(healthy && ++endpoint.recovery>=2) {endpoint.stalls=0;endpoint.probationUntil=0;}
                endpoint.latency=endpoint.latency ? .8*endpoint.latency+.2*ms : ms;
                endpoint.rate=endpoint.dataSamples++ ? .75*endpoint.rate+.25*sample : sample;
            } else if(!endpoint.dataSamples)endpoint.rate=endpoint.validBytes ? .75*endpoint.rate+.25*sample : sample;
            endpoint.validBytes+=bytes.length;endpoint.consecutive=0;endpoint.cooldownUntil=0;
            if(!remote.blocks.has(job.key)) {remote.blocks.set(job.key,bytes);remote.cacheBytes+=bytes.length;}
            remote.traceEvent('fetch-end',{cid:job.key,priority:job.priority,gateway:endpoint.url,bytes:bytes.length,ms});
            remote.finishJob(job,undefined,bytes);
        } catch(error) {
            if(!live()) return;
            if(attempt.rescue) {
                job.state='queued';return;
            }
            endpoint.failures++;job.failures++;remote.reduceWindow(endpoint);
            if(error.code==='CORRUPTION') endpoint.excluded=true;
            else if(!error.status || error.status===408 || error.status===429 || error.status>=500) {
                endpoint.cooldownUntil=Date.now()+retryDelay(++endpoint.consecutive);
            }
            job.error=error;job.state='queued';
            remote.traceEvent('fetch-error',{cid:job.key,gateway:endpoint.url,code:error.code,ms:performance.now()-started});
        } finally {
            job.controller.signal.removeEventListener('abort',abort);
            if(job.attempt===attempt)job.attempt=undefined;
            endpoint.active--;
            if(!remote.closed) remote.schedule();
            remote.notifyAdmission();
        }
    }
    async waitForJob(job, signal, priority) {
        const remote=this.remote;
        check(signal);
        const waiter={priority};job.waiters.add(waiter);
        let abort;
        try {
            return await Promise.race([job.promise, new Promise((_,reject)=>{
                abort=()=>reject(fail('CANCELLED','Operation cancelled'));
                signal?.addEventListener('abort',abort,{once:true});
                if(signal?.aborted) abort();
            })]);
        } finally {
            signal?.removeEventListener('abort',abort);
            job.waiters.delete(waiter);
            if(job.waiters.size) {
                const priorities=[...job.waiters].map(w=>w.priority);
                const priority=priorities.includes('demand')?'demand':priorities.includes('state')?'state':'background';
                if(job.priority!==priority) {job.priority=priority;remote.schedule();}
            }
            if(!job.waiters.size && signal?.aborted) {
                job.controller.abort();job.reject(fail('CANCELLED','Operation cancelled'));
                if(this.jobs.get(job.key)===job) this.jobs.delete(job.key);
                remote.notifyAdmission();remote.schedule();
            }
        }
    }
}
