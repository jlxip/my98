import {AdaptivePrefetchOrder, adaptivePolicies} from './prefetch-order.js';
import {matchingRanges, RangePrefetchOrder} from './range-prefetch.js';
import {MAX_PROFILE_BYTES, sameOrigin, validateLoadProfiles} from './load-profiles.js';
import {CID} from 'multiformats/cid';
import {sha256} from 'multiformats/hashes/sha2';
import {resolveIpns} from './resolution.js';
import {discoverProviders} from './discovery.js';
import {dataGateway, gatewayURL} from './network-config.js';
export {DEFAULT_GATEWAY, gatewayURL} from './network-config.js';
import {exporter} from 'ipfs-unixfs-exporter';

const BLOCK_LIMIT = 4 * 1024 * 1024;
const STATE_WINDOW = 2 * 1024 * 1024;
const STATE_RANGE = 4 * 1024 * 1024;
const HEADER = 198, RECORD = 65536 + 62;
const MAX_FILE = 198 + 2 ** 40 + Math.ceil(2 ** 40 / 65536) * 62;
const fail = (code, message) => Object.assign(new Error(message), {code});
const check = signal => { if(signal?.aborted) throw fail('CANCELLED', 'Operation cancelled'); };

export class RemoteDisk {
    constructor({gateway, servers, onlyLocalhost = false, onNetwork, timeoutMs = 30000, prefetch = {}, preloadState = false, onStateProgress} = {}) {
        if(typeof onlyLocalhost !== 'boolean') throw fail('IO_ERROR', 'Invalid Only localhost option.');
        this.directGateway = gateway != null || onlyLocalhost;
        this.gateway = this.directGateway ? dataGateway(gateway, onlyLocalhost) : undefined;
        this.servers = servers;this.onlyLocalhost = onlyLocalhost;
        this.providers = new Map();
        this.endpoints = new Map();
        this.admissionWaiters = new Set();
        if(this.gateway) this.addEndpoint(this.gateway);
        this.discovery = {state:'idle',providers:0,verifiedProviders:0,verifiedEndpoints:0};
        this.resolutionController = undefined;
        this.onNetwork = onNetwork;
        this.preloadState = preloadState;
        this.onStateProgress = onStateProgress;
        this.timeoutMs = timeoutMs;
        this.blocks = new Map();
        this.cacheBytes = 0;
        this.jobs = new Map();
        this.readControllers = new Set();
        this.epoch = 0;
        this.demandReads = 0;
        this.trace = [];
        this.traceDropped = 0;
        this.prefetchState = 'idle';
        this.loadGeneration = 0;
        this.configurePrefetch(prefetch);
    }
    configurePrefetch({enabled = true, policy = 'auto', concurrency = 8, trace = false, bootProfile} = {}) {
        if(!['auto', 'sequential', 'demand', 'head-demand', 'ranges', ...adaptivePolicies].includes(policy) || (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)) throw fail('OPERATION_FAILED', 'Invalid prefetch settings');
        this.bootProfile = bootProfile;
        this.prefetchEnabled = enabled;
        this.requestedPolicy = policy;
        this.policy = policy;
        this.concurrency = concurrency;
        this.tracing = trace;
    }
    traceEvent(type, detail) {
        if(!this.tracing) return;
        if(this.trace.length < 200000) this.trace.push({type, time:performance.now(), ...detail});
        else this.traceDropped++;
    }
    stats() {
        const jobs = [...this.jobs.values()];
        return {retainedBytes:this.cacheBytes, coveredBytes:this.coveredBytes || 0, totalBytes:this.size || 0,
            completedUnits:this.completedUnits || 0, totalUnits:this.coverage?.length || 0,
            inFlight:jobs.filter(j=>j.state === 'active').length, queued:jobs.filter(j=>j.state === 'queued').length,
            prefetchState:this.prefetchState, prefetchError:this.prefetchError,
            rangeProfile:this.rangeOrder?.stats(),
            loadProfile:this.load ? {...this.load, selected:this.load.selected ? {cid:this.load.selected.cid,origin:this.load.selected.origin} : undefined,
                status:this.load.selected && this.rangeOrder?.stats().completedUnits===this.rangeOrder?.stats().units ? 'complete' : this.load.status} : undefined,
            endpoints:[...this.endpoints.values()].map(({url,active,window,rescues,probationUntil,validBytes,failures,rate,cooldownUntil,excluded})=>({url,active,window,rescues,probationUntil,validBytes,failures,bytesPerMs:rate,cooldownUntil,excluded})),
            discovery:{...this.discovery}, policy:this.policy, concurrency:this.concurrency, traceDropped:this.traceDropped};
    }
    // Called only after the encrypted header has been authenticated by the Vault.
    startPrefetch() {
        if(this.closed || !this.entry || this.stateDownloads) return;
        if(this.load?.needsReload && this.load.scope!=='none') {this.setLoadPrefetch(this.load.origin,this.load.scope);return;}
        if(!this.coverage) {
            this.coverage = new Uint8Array(Math.ceil((this.size - HEADER) / RECORD));
            this.completedUnits = 0;
            this.coveredBytes = this.headerCovered ? HEADER : 0;
            this.cursor = 0;
            this.lastDemand = 0;
            const profile=this.bootProfile;
            const ranges=['auto','ranges'].includes(this.requestedPolicy) ? matchingRanges(profile,this.remote?.cid,this.coverage.length) : undefined;
            this.policy=this.requestedPolicy==='auto' ? (ranges?.length?'ranges':'demand') : this.requestedPolicy;
            this.rangeOrder=this.policy==='ranges' && ranges ? new RangePrefetchOrder(ranges,this.coverage) : undefined;
            this.adaptiveOrder = adaptivePolicies.includes(this.policy) ? new AdaptivePrefetchOrder(this.policy,this.coverage) : undefined;
        }
        if(!this.prefetchEnabled || this.prefetchState === 'complete' || this.load?.status==='loading') return;
        this.prefetchState = 'running';
        this.prefetchError = undefined;
        this.kickPrefetch();
    }
    // Short control operation: optional metadata and ranges never occupy the Worker RPC queue.
    setLoadPrefetch(origin, scope) {
        if(!['none','profile','disk'].includes(scope))throw fail('OPERATION_FAILED','Invalid load prefetch scope.');
        if(this.load && sameOrigin(this.load.origin,origin) && !this.load.needsReload && scope!=='none') {
            this.load.scope=scope;this.prefetchEnabled=true;
            if(this.prefetchState==='complete' && this.completedUnits!==this.coverage?.length)this.prefetchState='stopped';
            this.startPrefetch();return;
        }
        this.loadGeneration++;
        this.profileController?.abort();this.prefetchController?.abort();
        this.prefetchState='stopped';this.prefetchEnabled=false;
        this.load=undefined;
        this.startPrefetch(); // Establish coverage even when no speculation is requested.
        this.rangeOrder=this.adaptiveOrder=undefined;this.policy='demand';
        this.load={origin:{...origin},scope,status:scope==='none'?'disabled':'loading',needsReload:scope==='none'};
        if(scope==='none')return;
        this.prefetchEnabled=true;
        const generation=this.loadGeneration, controller=new AbortController();
        this.profileController=controller;
        const timer=setTimeout(()=>controller.abort(),this.timeoutMs);
        this.profileTask=(async()=>{
            if(!this.profilesCid) {this.load.status='missing';return;}
            const store={get:(cid,options)=>this.get(cid,{...options,signal:controller.signal,priority:'background'})};
            const entry=await exporter(this.profilesCid,store,{signal:controller.signal,blockReadConcurrency:1});
            if(!['file','raw','identity'].includes(entry.type))throw fail('INVALID_PROFILE','Load profiles must be a file.');
            const size=Number(entry.type==='file'?entry.unixfs.fileSize():entry.size);
            if(!Number.isSafeInteger(size) || size>MAX_PROFILE_BYTES)throw fail('INVALID_PROFILE','Load profiles exceed 64 KiB.');
            const data=new Uint8Array(size);let offset=0;
            for await(const bytes of entry.content({signal:controller.signal,blockReadConcurrency:1})) {
                if(offset+bytes.length>size)throw fail('INVALID_PROFILE','Invalid load profile size.');
                data.set(bytes,offset);offset+=bytes.length;
            }
            check(controller.signal);
            if(generation!==this.loadGeneration)return;
            if(offset!==size)throw fail('INVALID_PROFILE','Incomplete load profiles.');
            const profiles=validateLoadProfiles(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data)),this.remote.cid,this.coverage.length);
            const selected=profiles.find(p=>sameOrigin(p.origin,origin));
            this.load.selected=selected;this.load.status=selected?'ready':'mismatch';
            if(selected) {
                this.rangeOrder=new RangePrefetchOrder(matchingRanges({...selected,version:1},this.remote.cid,this.coverage.length),this.coverage);
                this.policy='ranges';
            }
        })().catch(error=>{
            if(generation!==this.loadGeneration)return;
            this.load.status=error.code==='INVALID_PROFILE' || error instanceof SyntaxError || error instanceof TypeError ? 'invalid' : 'failed';
            this.load.error={code:error.code || 'IO_ERROR',message:error.message};
        }).finally(()=>{
            clearTimeout(timer);
            if(generation!==this.loadGeneration || this.closed)return;
            this.profileController=undefined;
            this.startPrefetch();
        });
    }
    kickPrefetch() {
        if(this.prefetchLoop || this.prefetchState !== 'running' || this.closed || this.load?.status==='loading') return;
        const epoch = this.epoch, generation=this.loadGeneration, controller=new AbortController();
        this.prefetchController=controller;
        this.prefetchLoop = (async()=>{
            // Let openRemote return, and allow an immediately queued guest read first.
            await new Promise(r=>setTimeout(r, 0));
            if(epoch !== this.epoch || generation!==this.loadGeneration) return;
            if(!this.headerCovered) await this.read(0,HEADER,controller.signal,'background');
            let yielded = performance.now();
            while(epoch === this.epoch && generation===this.loadGeneration && this.prefetchState === 'running') {
                let index = this.rangeOrder?.next() ?? -1;
                if(index<0 && this.load?.scope==='profile') {this.prefetchState='complete';break;}
                if(this.policy === 'head-demand') {
                    for(let i=0;i<Math.min(16,this.coverage.length);i++) if(!this.coverage[i]) {index=i;break;}
                }
                const bootstrap=index>=0;
                if(this.adaptiveOrder) index=this.adaptiveOrder.next();
                if(index < 0 && !this.adaptiveOrder) {
                    for(let i=0;i<this.coverage.length;i++) {
                        const candidate = (this.cursor + i) % this.coverage.length;
                        if(!this.coverage[candidate]) {index=candidate;break;}
                    }
                }
                if(index < 0) {this.prefetchState='complete';break;}
                this.traceEvent('prefetch-unit',{unit:index,policy:this.policy});
                const demand = this.lastDemand;
                let last=index;
                // The exporter can now see distinct IPFS blocks instead of one 64 KiB record.
                // Keep range/profile and nearby/stream ordering; do not batch experimental policies.
                if(this.entry.node && !this.adaptiveOrder) {
                    let bound=this.coverage.length-1;
                    if(this.rangeOrder) {
                        const range=this.rangeOrder.ranges.find(([a,b])=>index>=a && index<=b);
                        if(range) bound=range[1];
                    }
                    if(this.policy==='head-demand' && index<16) bound=Math.min(bound,15);
                    const maxUnits=Math.max(1,Math.floor(8*BLOCK_LIMIT/RECORD));
                    while(last<bound && last-index+1<maxUnits && !this.coverage[last+1]) last++;
                }
                await this.read(HEADER + index * RECORD, Math.min((last-index+1)*RECORD, this.size - HEADER - index * RECORD), controller.signal, 'background', false);
                if(epoch !== this.epoch) break;
                if(!bootstrap && (this.policy === 'sequential' || demand === this.lastDemand)) this.cursor = (last + 1) % this.coverage.length;
                if(performance.now() - yielded > 8) {await new Promise(r=>setTimeout(r,0));yielded=performance.now();}
            }
        })().catch(error=>{
            if(epoch !== this.epoch || generation!==this.loadGeneration || this.closed) return;
            this.prefetchState='paused';
            this.prefetchError={code:error.code || 'IO_ERROR',message:error.message};
        }).finally(()=>{
            this.prefetchLoop = undefined;
            if(this.prefetchController===controller)this.prefetchController=undefined;
            this.kickPrefetch();
        });
    }
    recordCoverage(offset, length) {
        if(offset===0 && length>=HEADER && !this.headerCovered) {
            this.headerCovered=true;
            if(this.coverage) this.coveredBytes+=HEADER;
        }
        if(!this.coverage) return;
        for(let i=Math.max(0,Math.ceil((offset - HEADER)/RECORD));i<this.coverage.length;i++) {
            const start=HEADER+i*RECORD, end=Math.min(start+RECORD,this.size);
            if(end > offset+length) break;
            if(!this.coverage[i]) {this.coverage[i]=1;this.completedUnits++;this.coveredBytes+=end-start;}
        }
        if(this.headerCovered && this.completedUnits === this.coverage.length) {this.prefetchState='complete';this.prefetchError=undefined;}
    }
    noteDemand(offset, length) {
        if(!this.coverage || !Number.isSafeInteger(offset) || offset<0 || !Number.isSafeInteger(length) || length<=0) return;
        this.adaptiveOrder?.observe(offset,length);
        this.rangeOrder?.observe(offset,length);
        this.lastDemand++;
        if(this.policy!=='sequential') this.cursor=(Math.floor((offset+length-1)/65536)+1)%this.coverage.length;
    }
    cancel() {
        this.pendingState?.controller.abort();this.pendingState=undefined;
        this.loadGeneration++;
        this.profileController?.abort();this.prefetchController?.abort();
        if(this.load?.status==='loading') {this.load.status='cancelled';this.load.needsReload=true;}
        this.resolutionController?.abort();
        this.discoveryController?.abort();
        if(this.discovery.state === 'running') this.discovery.state = 'cancelled';
        this.epoch++;
        clearTimeout(this.scheduleTimer);
        for(const wake of this.admissionWaiters) wake();
        this.prefetchState='stopped';
        for(const controller of this.readControllers) controller.abort();
        for(const job of this.jobs.values()) {
            job.controller.abort();
            job.reject(fail('CANCELLED', 'Operation cancelled'));
        }
        this.jobs.clear();
    }
    addEndpoint(value) {
        const url=gatewayURL(value);
        if(!this.endpoints.has(url)) this.endpoints.set(url,{url,active:0,window:2,credits:0,rescues:0,stalls:0,recovery:0,probationUntil:0,penalizedAt:0,latency:0,growAfter:0,dataSamples:0,attempts:0,validBytes:0,failures:0,consecutive:0,rate:0,cooldownUntil:0,excluded:false});
    }
    slowAfter(endpoint) { return Math.max(endpoint.dataSamples?250:750,Math.min(2000,3*endpoint.latency)); }
    reduceWindow(endpoint) {
        // Keep the proven two-slot baseline while reducing speculative growth.
        // A single slot serializes round trips after an isolated latency spike.
        endpoint.window=Math.max(Math.min(2,this.concurrency),Math.floor(endpoint.window/2));endpoint.credits=0;
        endpoint.rate*=.5;endpoint.recovery=0;endpoint.penalizedAt=Date.now();
        endpoint.growAfter=endpoint.penalizedAt+1500;
    }
    notifyAdmission() { for(const wake of this.admissionWaiters) wake(); }
    async admitBackground(signal, epoch) {
        while([...this.jobs.values()].filter(j=>j.hasBackground).length>=8) {
            check(signal);
            if(epoch!==this.epoch || this.closed) throw fail('CANCELLED','Operation cancelled');
            await new Promise(resolve=>{
                const wake=()=>{this.admissionWaiters.delete(wake);signal?.removeEventListener('abort',wake);resolve();};
                this.admissionWaiters.add(wake);signal?.addEventListener('abort',wake,{once:true});
                if(signal?.aborted) wake();
            });
        }
        check(signal);
        if(epoch!==this.epoch || this.closed) throw fail('CANCELLED','Operation cancelled');
    }
    finishJob(job, error, bytes) {
        if(this.jobs.get(job.key)!==job) return;
        this.jobs.delete(job.key);
        if(error) job.reject(error); else job.resolve(bytes);
        this.notifyAdmission();
    }
    schedule() {
        clearTimeout(this.scheduleTimer);
        if(this.closed) return;
        const now=Date.now(), jobs=[...this.jobs.values()];
        let active=[...this.endpoints.values()].reduce((n,e)=>n+e.active,0), wakeAt=Infinity;
        const foreground=this.demandReads || jobs.some(j=>j.priority!=='background');
        const order={demand:0,state:1,background:2};
        jobs.sort((a,b)=>order[a.priority]-order[b.priority]);
        for(const job of jobs) {
            const attempt=job.attempt;
            if(job.state==='active' && attempt && !job.rescued && job.priority!=='background') {
                const others=[...this.endpoints.values()].filter(e=>!e.excluded && !job.tried.has(e.url));
                if(others.length) {
                    const due=attempt.lastProgress+this.slowAfter(attempt.endpoint);
                    const available=others.filter(e=>e.active<e.window && e.cooldownUntil<=now && e.probationUntil<=now);
                    // Progress alone is not sufficient: a trickling response
                    // can retain the ordered reader until the hard timeout.
                    // Only restart it when a provider with verified data samples
                    // is conservatively likely to finish the whole block sooner.
                    const bodyMs=now-attempt.firstByte;
                    const canEstimate=attempt.total>=65536 && attempt.received>0 && bodyMs>=250 && now-attempt.startedAt>=this.slowAfter(attempt.endpoint);
                    const remainingMs=canEstimate ? (attempt.total-attempt.received)*bodyMs/attempt.received : 0;
                    const faster=canEstimate && available.some(e=>e.dataSamples && remainingMs>2*Math.max(150,1.5*e.latency,1.5*attempt.total/e.rate));
                    if(available.length && (now>=due || faster)) {
                        job.rescued=true;job.revisit=attempt.endpoint.url;attempt.rescue=true;
                        attempt.endpoint.rescues++;this.reduceWindow(attempt.endpoint);
                        // A fast successful sample must not send every next
                        // window back to a provider repeatedly stalling. Prefer
                        // healthy alternatives until it has had time to recover.
                        attempt.endpoint.probationUntil=now+Math.min(8000,this.slowAfter(attempt.endpoint)*2**Math.min(++attempt.endpoint.stalls,3));
                        this.traceEvent('fetch-rescue',{cid:job.key,gateway:attempt.endpoint.url});
                        attempt.controller.abort();
                    } else wakeAt=Math.min(wakeAt,Math.max(now+100,Math.min(due,attempt.startedAt+this.slowAfter(attempt.endpoint))));
                }
            }
            if(job.state!=='queued') continue;
            if(job.deadline && now>=job.deadline) {this.finishJob(job,job.error || fail('IO_ERROR','IPFS block request timed out. You can retry.'));continue;}
            let remaining=[...this.endpoints.values()].filter(e=>!e.excluded && !job.tried.has(e.url));
            // An early rescue is speculative, not evidence that the original
            // provider cannot serve the block. Retain one ordinary fallback.
            if(!remaining.length && job.revisit) {
                job.tried.delete(job.revisit);job.revisit=undefined;
                remaining=[...this.endpoints.values()].filter(e=>!e.excluded && !job.tried.has(e.url));
            }
            if(!remaining.length && this.discovery.state!=='running') {
                this.finishJob(job,job.error || fail('IO_ERROR','No provider could serve this IPFS block. You can retry.'));continue;
            }
            if(job.deadline) wakeAt=Math.min(wakeAt,job.deadline);
            if(active>=this.concurrency || (foreground && job.priority==='background')) continue;
            // Early state data may use spare capacity, but leave one slot for
            // the disk descriptor needed to authenticate/open the machine.
            if(job.priority==='state' && active>=Math.max(1,this.concurrency-1))continue;
            for(const e of remaining) {
                if(e.cooldownUntil>now)wakeAt=Math.min(wakeAt,e.cooldownUntil);
                if(e.probationUntil>now)wakeAt=Math.min(wakeAt,e.probationUntil);
            }
            const healthyAlternative=remaining.some(e=>e.probationUntil<=now && e.cooldownUntil<=now);
            const eligible=remaining.filter(e=>e.active<e.window && e.cooldownUntil<=now && (!healthyAlternative || e.probationUntil<=now));
            eligible.sort((a,b)=>(a.attempts===0?0:1)-(b.attempts===0?0:1) || b.rate/(b.active+1)-a.rate/(a.active+1) || a.active-b.active);
            const endpoint=eligible[0];
            if(!endpoint) continue;
            job.deadline ??= now+this.timeoutMs;
            job.tried.add(endpoint.url);job.state='active';endpoint.active++;endpoint.attempts++;active++;
            this.runAttempt(job,endpoint);
            wakeAt=Math.min(wakeAt,now+this.slowAfter(endpoint));
        }
        if(Number.isFinite(wakeAt)) this.scheduleTimer=setTimeout(()=>this.schedule(),Math.max(1,wakeAt-Date.now()));
    }
    async runAttempt(job, endpoint) {
        const started=performance.now(), live=()=>job.epoch===this.epoch && !this.closed && !job.controller.signal.aborted && this.jobs.get(job.key)===job;
        const controller=new AbortController(),abort=()=>controller.abort();
        job.controller.signal.addEventListener('abort',abort,{once:true});
        const attempt=job.attempt={controller,endpoint,startedAt:Date.now(),lastProgress:Date.now(),received:0,total:0};
        this.traceEvent('fetch-start',{cid:job.key,priority:job.priority,gateway:endpoint.url,window:endpoint.window});
        try {
            const bytes=await this.request(`/ipfs/${job.key}?format=raw`, 'application/vnd.ipld.raw', BLOCK_LIMIT, controller.signal, endpoint.url, Math.min(5000,Math.max(1,job.deadline-Date.now())),(received,total)=>{
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
                if(!healthy)this.reduceWindow(endpoint);
                else if(Date.now()>=endpoint.growAfter && ++endpoint.credits>=endpoint.window) {
                    endpoint.window=Math.min(this.concurrency,endpoint.window*2);endpoint.credits=0;
                }
                if(healthy && ++endpoint.recovery>=2) {endpoint.stalls=0;endpoint.probationUntil=0;}
                endpoint.latency=endpoint.latency ? .8*endpoint.latency+.2*ms : ms;
                endpoint.rate=endpoint.dataSamples++ ? .75*endpoint.rate+.25*sample : sample;
            } else if(!endpoint.dataSamples)endpoint.rate=endpoint.validBytes ? .75*endpoint.rate+.25*sample : sample;
            endpoint.validBytes+=bytes.length;endpoint.consecutive=0;endpoint.cooldownUntil=0;
            if(!this.blocks.has(job.key)) {this.blocks.set(job.key,bytes);this.cacheBytes+=bytes.length;}
            this.traceEvent('fetch-end',{cid:job.key,priority:job.priority,gateway:endpoint.url,bytes:bytes.length,ms});
            this.finishJob(job,undefined,bytes);
        } catch(error) {
            if(!live()) return;
            if(attempt.rescue) {
                job.state='queued';return;
            }
            endpoint.failures++;this.reduceWindow(endpoint);
            if(error.code==='CORRUPTION') endpoint.excluded=true;
            else if(!error.status || error.status===408 || error.status===429 || error.status>=500) {
                endpoint.cooldownUntil=Date.now()+Math.min(60000,5000*2**Math.min(endpoint.consecutive++,4));
            }
            job.error=error;job.state='queued';
            this.traceEvent('fetch-error',{cid:job.key,gateway:endpoint.url,code:error.code,ms:performance.now()-started});
        } finally {
            job.controller.signal.removeEventListener('abort',abort);
            if(job.attempt===attempt)job.attempt=undefined;
            endpoint.active--;
            if(!this.closed) this.schedule();
        }
    }
    async waitForJob(job, signal, priority) {
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
                if(job.priority!==priority) {job.priority=priority;this.schedule();}
            }
            if(!job.waiters.size && signal?.aborted) {
                job.controller.abort();job.reject(fail('CANCELLED','Operation cancelled'));
                if(this.jobs.get(job.key)===job) this.jobs.delete(job.key);
                this.notifyAdmission();this.schedule();
            }
        }
    }
    async request(path, type, limit, signal, gateway=this.gateway, timeoutMs=Math.min(5000,this.timeoutMs), onProgress) {
        return this.requestOnce(path,type,limit,signal,timeoutMs,gateway,onProgress);
    }
    async requestOnce(path, type, limit, signal, timeoutMs, gateway=this.gateway, onProgress) {
        check(signal);
        if(!gateway) throw fail('IO_ERROR', 'No verified HTTPS provider is available for this disk.');
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener('abort', abort, {once:true});
        let timedOut = false;
        const timer = setTimeout(() => {timedOut = true;controller.abort();}, timeoutMs);
        let response;
        const epoch=this.epoch;
        try {
            this.onNetwork?.(0, 1);
            response = await fetch(gateway + path, {
                headers:{Accept:type}, signal:controller.signal, credentials:'omit',
                cache:'no-store', redirect:'error', referrerPolicy:'no-referrer',
            });
            if(!response.ok) {
                const detail = path.startsWith('/ipns/') && response.status === 404
                    ? 'No published disk reference is available from this gateway for this identity.'
                    : 'The gateway could not retrieve the remote data.';
                throw Object.assign(fail('IO_ERROR', `IPFS gateway returned HTTP ${response.status}. ${detail}`), {
                    status:response.status,
                });
            }
            if(response.headers.get('content-type')?.split(';')[0].trim() !== type) throw fail('CORRUPTION', 'Gateway did not return verifiable IPFS data.');
            if(Number(response.headers.get('content-length')) > limit) throw fail('CORRUPTION', 'IPFS response exceeds the supported size.');
            const reader = response.body.getReader(), parts = []; let size = 0;
            try {
                for(;;) {
                    const {done, value} = await reader.read();
                    if(done) break;
                    if(epoch===this.epoch && !this.closed && !signal?.aborted) this.onNetwork?.(value.length, 0);
                    size += value.length;
                    onProgress?.(size,Number(response.headers.get('content-length'))||0);
                    if(size > limit) throw fail('CORRUPTION', 'IPFS response exceeds the supported size.');
                    parts.push(value);
                }
            } finally { await reader.cancel().catch(()=>{}); }
            check(signal);
            if(timedOut) throw fail('IO_ERROR','IPFS request timed out. You can retry.');
            const bytes = new Uint8Array(size); let offset = 0;
            for(const part of parts) {bytes.set(part, offset);offset += part.length;}
            return bytes;
        } catch(error) {
            check(signal);
            if(timedOut) throw fail('IO_ERROR', 'IPFS request timed out. You can retry.');
            if(error.code) throw error;
            throw fail('IO_ERROR', 'Could not reach the IPFS gateway. Check Remote disk settings; the connection may be blocked by the network, CORS, or a redirect.');
        } finally {
            controller.abort(); clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
        }
    }
    async *get(cid, {signal, priority = 'demand'} = {}) {
        check(signal);
        if(this.closed) throw fail('CANCELLED','Disk closed');
        if(cid.code !== 0x55 && cid.code !== 0x70) throw fail('UNSUPPORTED_FORMAT', 'Only raw and UnixFS IPFS blocks are supported.');
        const epoch=this.epoch;
        const key = cid.toV1().toString();
        let bytes = this.blocks.get(key);
        this.traceEvent('block',{cid:key,priority,hit:!!bytes});
        if(bytes) {yield bytes;return;}
        if(cid.multihash.code === 0) {
            bytes = cid.multihash.digest;
            if(bytes.length > BLOCK_LIMIT) throw fail('UNSUPPORTED_FORMAT', 'IPFS block is too large.');
            this.blocks.set(key,bytes);this.cacheBytes+=bytes.length;
        } else {
            if(cid.multihash.code !== sha256.code) throw fail('UNSUPPORTED_FORMAT', 'Unsupported IPFS hash algorithm.');
            while(priority==='background' && !this.jobs.get(key)?.hasBackground && !this.blocks.has(key) && [...this.jobs.values()].filter(j=>j.hasBackground).length>=8) await this.admitBackground(signal,epoch);
            check(signal);
            if(epoch!==this.epoch || this.closed) throw fail('CANCELLED','Operation cancelled');
            if(this.blocks.has(key)) {yield this.blocks.get(key);return;}
            let job=this.jobs.get(key);
            if(!job) {
                job={key,cid,priority,epoch:this.epoch,state:'queued',hasBackground:priority==='background',tried:new Set(),controller:new AbortController(),waiters:new Set()};
                job.promise=new Promise((resolve,reject)=>{job.resolve=resolve;job.reject=reject;});
                this.jobs.set(key,job);
            }
            if(priority==='background') job.hasBackground=true;
            if(priority==='demand' && job.priority!=='demand') {job.priority='demand';this.traceEvent('promote',{cid:key});}
            if(priority==='state' && job.priority==='background')job.priority='state';
            const pending=this.waitForJob(job,signal,priority);
            this.schedule();
            bytes=await pending;
        }
        check(signal);
        yield bytes;
    }
    async open(identity, signal) {
        check(signal);
        if(this.closed) throw fail('CANCELLED', 'Disk closed');
        const controller = new AbortController(), epoch = this.epoch;
        const abort = () => controller.abort();
        signal?.addEventListener('abort', abort, {once:true});
        this.resolutionController = controller;
        try {
            check(signal);
            const resolved = await resolveIpns(identity, {servers:this.servers, onlyLocalhost:this.onlyLocalhost,
                gateway:this.gateway, signal:controller.signal, onNetwork:this.onNetwork});
            check(signal);check(controller.signal);
            if(epoch !== this.epoch || this.closed) throw fail('CANCELLED', 'Disk closed');
            await this.prepareGateway(resolved.rootCid, controller.signal);
            await this.openPath(resolved.path.slice(6), controller.signal);
            check(controller.signal);
            this.remote = {...resolved, cid:this.entry.cid.toString(), ...(this.stateCid ? {stateCid:this.stateCid} : {}), gateway:this.gateway};
            return this;
        } catch(error) {
            this.discoveryController?.abort();
            throw error;
        } finally {
            signal?.removeEventListener('abort', abort);
            if(this.resolutionController === controller) this.resolutionController = undefined;
        }
    }
    async openCid(cid, signal) {
        try {
            if(typeof cid !== 'string') throw new Error();
            const parsed = CID.parse(cid);
            if(![0x70, 0x55, 0x00].includes(parsed.code)) throw new Error();
        } catch { throw fail('INVALID_CID', 'Expected a publication or disk CID without a URL or path.'); }
        check(signal);
        if(this.closed) throw fail('CANCELLED','Disk closed');
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener('abort',abort,{once:true});this.resolutionController=controller;
        try {
            await this.prepareGateway(cid, controller.signal);
            await this.openPath(cid, controller.signal);check(controller.signal);
            this.remote = {path:'/ipfs/' + cid, rootCid:cid, cid:this.entry.cid.toString(), ...(this.stateCid ? {stateCid:this.stateCid} : {}), gateway:this.gateway};
            return this;
        } catch(error) {this.discoveryController?.abort();throw error;}
        finally {
            signal?.removeEventListener('abort',abort);
            if(this.resolutionController===controller)this.resolutionController=undefined;
        }
    }
    async prepareGateway(rootCid, signal) {
        check(signal);
        if(this.directGateway) {this.discovery.state='skipped';return;}
        const controller=new AbortController(),epoch=this.epoch;
        const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
        this.discoveryController=controller;this.providers.clear();
        this.gateway=undefined;this.discovery={state:'running',providers:0,verifiedProviders:0,verifiedEndpoints:0};
        let resolveFirst,rejectFirst,selected=false;
        const first=new Promise((resolve,reject)=>{resolveFirst=resolve;rejectFirst=reject;});
        const usable=()=>!controller.signal.aborted && epoch===this.epoch && !this.closed;
        this.discoveryTask=discoverProviders(rootCid,{servers:this.servers,signal:controller.signal,onNetwork:this.onNetwork,
            onProvider:(provider,block)=>{
                if(!usable())return;
                this.providers.set(provider.peerId,provider);
                for(const gateway of provider.gateways) this.addEndpoint(gateway);
                this.schedule();
                this.discovery.providers=this.discovery.verifiedProviders=this.providers.size;
                this.discovery.verifiedEndpoints=new Set([...this.providers.values()].flatMap(p=>p.gateways)).size;
                if(!selected && block) {
                    selected=true;this.gateway=block.gateway;
                    const key=CID.parse(rootCid).toV1().toString();
                    this.blocks.set(key,block.rootBlock);this.cacheBytes+=block.rootBlock.length;
                    resolveFirst();
                }
            },
        }).then(result=>{
            if(!usable())throw fail('CANCELLED','Operation cancelled');
            this.discovery={state:result.state,providers:result.providers.length,
                verifiedProviders:result.providers.filter(p=>p.gateways.length).length,
                verifiedEndpoints:result.verifiedEndpoints,limits:result.limits,failures:result.failures,
                endpointsTested:result.endpointsTested,receivedBytes:result.receivedBytes};
            this.providers=new Map(result.providers.map(p=>[p.peerId,p]));
            if(!selected)throw fail('IO_ERROR','No verified HTTPS provider is available for this disk.');
        }).catch(error=>{
            if(epoch===this.epoch && !this.closed) {
                this.discovery.state=controller.signal.aborted?'cancelled':'failed';
                this.discovery.error={code:error.code || 'IO_ERROR',message:error.message};
            }
            rejectFirst(error);
        }).finally(()=>{
            signal?.removeEventListener('abort',abort);
            if(this.discoveryController===controller)this.discoveryController=undefined;
            if(epoch===this.epoch && !this.closed) this.schedule();
        });
        await first;check(signal);check(controller.signal);
    }
    async openPath(path, signal) {
        check(signal);
        this.entry = await exporter(path, this, {signal, blockReadConcurrency:1});
        this.stateCid = undefined;
        this.profilesCid = undefined;
        if(this.entry.type === 'directory') {
            const entries = new Map();
            for await(const entry of this.entry.entries({signal, blockReadConcurrency:1})) {
                if(entries.size >= 3 || !['disk.my98','state.my98state','load-profiles.json'].includes(entry.name) || entries.has(entry.name)) throw fail('UNSUPPORTED_FORMAT', 'Unsupported publication directory.');
                entries.set(entry.name,entry);
            }
            if(!entries.has('disk.my98')) throw fail('UNSUPPORTED_FORMAT', 'Incomplete publication directory.');
            const state = entries.get('state.my98state');
            this.stateCid = state?.cid.toString();
            this.profilesCid = entries.get('load-profiles.json')?.cid.toString();
            if(this.preloadState && this.stateCid)this.beginStatePrefetch(signal);
            this.entry = await exporter(entries.get('disk.my98').cid,this,{signal,blockReadConcurrency:1});
        }
        check(signal);
        if(!['file','raw','identity'].includes(this.entry.type)) throw fail('UNSUPPORTED_FORMAT', 'The reference does not identify a file.');
        const size = this.entry.type === 'file' ? this.entry.unixfs.fileSize() : this.entry.size;
        if(size < 198n || size > BigInt(MAX_FILE)) throw fail('CORRUPTION', 'Invalid encrypted file size.');
        this.size = Number(size);
        return this;
    }
    async openStateStream(signal, progress) {
        check(signal);
        const pending=this.pendingState;
        if(!pending)return this.createStateStream(signal,progress);
        this.pendingState=undefined;pending.progress=progress;pending.priority='demand';
        for(const job of this.jobs.values())if(job.priority==='state') {
            job.priority='demand';for(const waiter of job.waiters)if(waiter.priority==='state')waiter.priority='demand';
        }
        this.schedule();
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
        const controller=new AbortController(),abort=()=>controller.abort();
        signal?.addEventListener('abort',abort,{once:true});
        const pending=this.pendingState={controller,priority:'state',progress:this.onStateProgress};
        pending.promise=this.createStateStream(controller.signal,(received,total)=>{
            pending.received=received;pending.progress?.(received,total);
        },()=>{signal?.removeEventListener('abort',abort);controller.abort();},()=>pending.priority);
        // The disk can still open when optional state data is invalid. Its
        // error belongs to prepareState, which takes ownership of this promise.
        pending.promise.catch(()=>{});
    }
    async createStateStream(signal, progress, onFinish, priority=()=> 'demand') {
        check(signal);
        if(!this.stateCid) throw fail('INVALID_STATE','No state is published for this disk.');
        const resume = this.prefetchState === 'running';
        const controller=new AbortController(), external=signal;
        const abort=()=>finish();external?.addEventListener('abort',abort,{once:true});
        signal=controller.signal;
        this.readControllers.add(controller);
        this.stateDownloads = (this.stateDownloads || 0) + 1;
        if(resume) this.prefetchState = 'suspended';
        let iterator,finished=false,blockBytes=0;
        const stateBlocks=new Map();
        const finish=(resumeAllowed=false)=>{
            if(finished)return;finished=true;controller.abort();
            external?.removeEventListener('abort',abort);this.stateDownloads--;
            stateBlocks.clear();blockBytes=0;
            this.readControllers.delete(controller);onFinish?.();
            if(resume && resumeAllowed)this.startPrefetch();
        };
        signal.addEventListener('abort',()=>finish(),{once:true});
        try {
            await this.prefetchLoop;
            check(signal);
            const remote = this;
            // Do not retain another full encrypted state in the disk block cache.
            const store = {async *get(cid, options) {
                const key=cid.toV1().toString(), retained=remote.blocks.has(key);
                if(stateBlocks.has(key)) {yield stateBlocks.get(key);return;}
                try {for await(const bytes of remote.get(cid,{...options,signal,priority:priority()})) {
                    // A range traversal can touch the boundary leaf twice.
                    // Keep a small local cache instead of redownloading it or
                    // retaining the complete encrypted file in the disk cache.
                    if(!stateBlocks.has(key)) {stateBlocks.set(key,bytes);blockBytes+=bytes.length;}
                    while(blockBytes>BLOCK_LIMIT) {const first=stateBlocks.keys().next().value;blockBytes-=stateBlocks.get(first).length;stateBlocks.delete(first);}
                    yield bytes;
                }}
                finally {if(!retained && remote.blocks.has(key)) {remote.cacheBytes-=remote.blocks.get(key).length;remote.blocks.delete(key);}}
            }};
            const entry=await exporter(this.stateCid,store,{signal,blockReadConcurrency:1});
            if(!['file','raw','identity'].includes(entry.type)) throw fail('INVALID_STATE','Published state is not a file.');
            const total=Number(entry.type==='file'?entry.unixfs.fileSize():entry.size);
            if(!Number.isSafeInteger(total) || total<12 || total>1024*1024*1024+65536) throw fail('INVALID_STATE','Invalid published state size.');
            // UnixFS's exporter has an internal push queue. Bound each traversal
            // too, so a slow/absent consumer cannot accumulate the whole file.
            // Exporter concurrency also counts completed out-of-order blocks.
            // Give it bounded lookahead beyond the actual network budget so a
            // slow head block does not leave the other download slots idle.
            const concurrency=2*this.concurrency;
            iterator=(async function*() {
                for(let offset=0;offset<total;offset+=STATE_RANGE) {
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
            return {size:total,stream};
        } catch(error) {finish();throw error;}
    }
    // Preserve the collecting API for callers explicitly asking for a file.
    async downloadState(signal, progress) {
        const {stream}=await this.openStateStream(signal,progress),reader=stream.getReader(),parts=[];
        try {for(;;) {const {done,value}=await reader.read();if(done)break;parts.push(new Blob([value]));}
            return new Blob(parts,{type:'application/octet-stream'});
        } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
    }
    async read(offset, length, signal, priority = 'demand', retainOutput = true) {
        check(signal);
        if(this.closed) throw fail('CANCELLED','Disk closed');
        if(!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > this.size) throw fail('IO_ERROR', 'Remote range unavailable.');
        const epoch=this.epoch,start=performance.now(), controller=new AbortController(), externalSignal=signal;
        const abort=()=>controller.abort();
        externalSignal?.addEventListener('abort',abort,{once:true});
        if(externalSignal?.aborted) abort();
        this.readControllers.add(controller);
        signal=controller.signal;
        if(priority==='demand') {
            this.demandReads++;
            if(this.coverage && offset>=HEADER) {
                this.lastDemand++;
                if(this.policy!=='sequential') this.cursor=(Math.floor((offset-HEADER)/RECORD)+1)%this.coverage.length;
            }
        }
        try {
            const output = retainOutput ? new Uint8Array(length) : undefined; let copied = 0;
            if(length === 0) return output;
            for await(const bytes of this.entry.content({offset:BigInt(offset), length:BigInt(length), signal, priority, blockReadConcurrency:this.concurrency})) {
                check(signal);
                if(epoch!==this.epoch || this.closed) throw fail('CANCELLED','Operation cancelled');
                if(copied + bytes.length > length) throw fail('CORRUPTION', 'IPFS range is longer than requested.');
                output?.set(bytes, copied);copied += bytes.length;
            }
            check(signal);
            if(copied !== length) throw fail('IO_ERROR', 'Incomplete IPFS range.');
            this.recordCoverage(offset,length);
            this.traceEvent('read',{offset,length,priority,ms:performance.now()-start});
            if(priority==='demand' && this.prefetchState==='paused') this.startPrefetch();
            return output;
        } finally {
            controller.abort();
            this.readControllers.delete(controller);
            externalSignal?.removeEventListener('abort',abort);
            if(priority==='demand') this.demandReads--;
            this.schedule();
        }
    }
    clearCache() {this.cancel();if(this.load)this.load.needsReload=true;this.blocks.clear();this.cacheBytes=0;this.headerCovered=false;this.coverage=undefined;this.adaptiveOrder=undefined;this.rangeOrder=undefined;this.completedUnits=this.coveredBytes=0;}
    close() {this.closed=true;this.clearCache();this.providers.clear();this.endpoints.clear();this.prefetchState='closed';this.entry=undefined;}
}
