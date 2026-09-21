import {AdaptivePrefetchOrder, adaptivePolicies} from './prefetch-order.js';
import {matchingRanges, RangePrefetchOrder} from './range-prefetch.js';
import {CID} from 'multiformats/cid';
import {sha256} from 'multiformats/hashes/sha2';
import {resolveIpns} from './resolution.js';
import {discoverProviders} from './discovery.js';
import {dataGateway, gatewayURL} from './network-config.js';
export {DEFAULT_GATEWAY, gatewayURL} from './network-config.js';
import {exporter} from 'ipfs-unixfs-exporter';

const BLOCK_LIMIT = 4 * 1024 * 1024;
const HEADER = 198, RECORD = 65536 + 62;
const MAX_FILE = 198 + 2 ** 40 + Math.ceil(2 ** 40 / 65536) * 62;
const fail = (code, message) => Object.assign(new Error(message), {code});
const check = signal => { if(signal?.aborted) throw fail('CANCELLED', 'Operation cancelled'); };

export class RemoteDisk {
    constructor({gateway, servers, onlyLocalhost = false, onNetwork, timeoutMs = 30000, prefetch = {}} = {}) {
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
            endpoints:[...this.endpoints.values()].map(({url,active,validBytes,failures,rate,cooldownUntil,excluded})=>({url,active,validBytes,failures,bytesPerMs:rate,cooldownUntil,excluded})),
            discovery:{...this.discovery}, policy:this.policy, concurrency:this.concurrency, traceDropped:this.traceDropped};
    }
    // Called only after the encrypted header has been authenticated by the Vault.
    startPrefetch() {
        if(this.closed || !this.entry) return;
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
        if(!this.prefetchEnabled || this.prefetchState === 'complete') return;
        this.prefetchState = 'running';
        this.prefetchError = undefined;
        this.kickPrefetch();
    }
    kickPrefetch() {
        if(this.prefetchLoop || this.prefetchState !== 'running' || this.closed) return;
        const epoch = this.epoch;
        this.prefetchLoop = (async()=>{
            // Let openRemote return, and allow an immediately queued guest read first.
            await new Promise(r=>setTimeout(r, 0));
            if(epoch !== this.epoch) return;
            if(!this.headerCovered) await this.read(0,HEADER,undefined,'background');
            let yielded = performance.now();
            while(epoch === this.epoch && this.prefetchState === 'running') {
                let index = this.rangeOrder?.next() ?? -1;
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
                await this.read(HEADER + index * RECORD, Math.min((last-index+1)*RECORD, this.size - HEADER - index * RECORD), undefined, 'background', false);
                if(epoch !== this.epoch) break;
                if(!bootstrap && (this.policy === 'sequential' || demand === this.lastDemand)) this.cursor = (last + 1) % this.coverage.length;
                if(performance.now() - yielded > 8) {await new Promise(r=>setTimeout(r,0));yielded=performance.now();}
            }
        })().catch(error=>{
            if(epoch !== this.epoch || this.closed) return;
            this.prefetchState='paused';
            this.prefetchError={code:error.code || 'IO_ERROR',message:error.message};
        }).finally(()=>{
            this.prefetchLoop = undefined;
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
        if(!this.endpoints.has(url)) this.endpoints.set(url,{url,active:0,attempts:0,validBytes:0,failures:0,consecutive:0,rate:0,cooldownUntil:0,excluded:false});
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
        const foreground=this.demandReads || jobs.some(j=>j.priority==='demand');
        jobs.sort((a,b)=>(a.priority==='demand'?0:1)-(b.priority==='demand'?0:1));
        for(const job of jobs) {
            if(job.state!=='queued') continue;
            if(job.deadline && now>=job.deadline) {this.finishJob(job,job.error || fail('IO_ERROR','IPFS block request timed out. You can retry.'));continue;}
            const remaining=[...this.endpoints.values()].filter(e=>!e.excluded && !job.tried.has(e.url));
            if(!remaining.length && this.discovery.state!=='running') {
                this.finishJob(job,job.error || fail('IO_ERROR','No provider could serve this IPFS block. You can retry.'));continue;
            }
            if(job.deadline) wakeAt=Math.min(wakeAt,job.deadline);
            if(active>=this.concurrency || (foreground && job.priority!=='demand')) continue;
            for(const e of remaining) if(e.cooldownUntil>now) wakeAt=Math.min(wakeAt,e.cooldownUntil);
            const eligible=remaining.filter(e=>e.active<2 && e.cooldownUntil<=now);
            eligible.sort((a,b)=>(a.attempts===0?0:1)-(b.attempts===0?0:1) || b.rate-a.rate || a.active-b.active);
            const endpoint=eligible[0];
            if(!endpoint) continue;
            job.deadline ??= now+this.timeoutMs;
            job.tried.add(endpoint.url);job.state='active';endpoint.active++;endpoint.attempts++;active++;
            this.runAttempt(job,endpoint);
        }
        if(Number.isFinite(wakeAt)) this.scheduleTimer=setTimeout(()=>this.schedule(),Math.max(1,wakeAt-Date.now()));
    }
    async runAttempt(job, endpoint) {
        const started=performance.now(), live=()=>job.epoch===this.epoch && !this.closed && !job.controller.signal.aborted && this.jobs.get(job.key)===job;
        this.traceEvent('fetch-start',{cid:job.key,priority:job.priority,gateway:endpoint.url});
        try {
            const bytes=await this.request(`/ipfs/${job.key}?format=raw`, 'application/vnd.ipld.raw', BLOCK_LIMIT, job.controller.signal, endpoint.url, Math.min(5000,Math.max(1,job.deadline-Date.now())));
            const digest=await sha256.digest(bytes);
            if(!live()) return;
            if(!digest.digest.every((b,i)=>b===job.cid.multihash.digest[i]) || digest.digest.length!==job.cid.multihash.digest.length) throw fail('CORRUPTION','IPFS block does not match its CID.');
            const ms=Math.max(1,performance.now()-started), sample=bytes.length/ms;
            endpoint.rate=endpoint.validBytes ? .75*endpoint.rate+.25*sample : sample;
            endpoint.validBytes+=bytes.length;endpoint.consecutive=0;endpoint.cooldownUntil=0;
            if(!this.blocks.has(job.key)) {this.blocks.set(job.key,bytes);this.cacheBytes+=bytes.length;}
            this.traceEvent('fetch-end',{cid:job.key,priority:job.priority,gateway:endpoint.url,bytes:bytes.length,ms});
            this.finishJob(job,undefined,bytes);
        } catch(error) {
            if(!live()) return;
            endpoint.failures++;
            if(error.code==='CORRUPTION') endpoint.excluded=true;
            else if(!error.status || error.status===408 || error.status===429 || error.status>=500) {
                endpoint.cooldownUntil=Date.now()+Math.min(60000,5000*2**Math.min(endpoint.consecutive++,4));
            }
            job.error=error;job.state='queued';
            this.traceEvent('fetch-error',{cid:job.key,gateway:endpoint.url,code:error.code,ms:performance.now()-started});
        } finally {
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
            if(job.waiters.size && job.priority==='demand' && ![...job.waiters].some(w=>w.priority==='demand')) {
                job.priority='background';this.schedule();
            }
            if(!job.waiters.size && signal?.aborted) {
                job.controller.abort();job.reject(fail('CANCELLED','Operation cancelled'));
                if(this.jobs.get(job.key)===job) this.jobs.delete(job.key);
                this.notifyAdmission();this.schedule();
            }
        }
    }
    async request(path, type, limit, signal, gateway=this.gateway, timeoutMs=Math.min(5000,this.timeoutMs)) {
        return this.requestOnce(path,type,limit,signal,timeoutMs,gateway);
    }
    async requestOnce(path, type, limit, signal, timeoutMs, gateway=this.gateway) {
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
            this.remote = {...resolved, cid:this.entry.cid.toString(), gateway:this.gateway};
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
        } catch { throw fail('INVALID_CID', 'Expected a file CID without a URL or path.'); }
        check(signal);
        if(this.closed) throw fail('CANCELLED','Disk closed');
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener('abort',abort,{once:true});this.resolutionController=controller;
        try {
            await this.prepareGateway(cid, controller.signal);
            await this.openPath(cid, controller.signal);check(controller.signal);
            this.remote = {path:'/ipfs/' + this.entry.cid.toString(), rootCid:cid, cid:this.entry.cid.toString(), gateway:this.gateway};
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
        check(signal);
        if(!['file','raw','identity'].includes(this.entry.type)) throw fail('UNSUPPORTED_FORMAT', 'The reference does not identify a file.');
        const size = this.entry.type === 'file' ? this.entry.unixfs.fileSize() : this.entry.size;
        if(size < 198n || size > BigInt(MAX_FILE)) throw fail('CORRUPTION', 'Invalid encrypted file size.');
        this.size = Number(size);
        return this;
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
    clearCache() {this.cancel();this.blocks.clear();this.cacheBytes=0;this.headerCovered=false;this.coverage=undefined;this.adaptiveOrder=undefined;this.rangeOrder=undefined;this.completedUnits=this.coveredBytes=0;}
    close() {this.closed=true;this.clearCache();this.providers.clear();this.endpoints.clear();this.prefetchState='closed';this.entry=undefined;}
}
