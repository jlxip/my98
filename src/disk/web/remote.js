import {AdaptivePrefetchOrder, adaptivePolicies} from './prefetch-order.js';
import {matchingRanges, RangePrefetchOrder} from './range-prefetch.js';
import {CID} from 'multiformats/cid';
import {sha256} from 'multiformats/hashes/sha2';
import {publicKeyFromRaw} from '@libp2p/crypto/keys';
import {validate} from 'ipns/validator';
import {unmarshalIPNSRecord} from 'ipns';
import {exporter} from 'ipfs-unixfs-exporter';

export const DEFAULT_GATEWAY = 'https://trustless-gateway.net';
const BLOCK_LIMIT = 4 * 1024 * 1024;
const HEADER = 198, RECORD = 65536 + 62;
const MAX_FILE = 198 + 2 ** 40 + Math.ceil(2 ** 40 / 65536) * 62;
const fail = (code, message) => Object.assign(new Error(message), {code});
const check = signal => { if(signal?.aborted) throw fail('CANCELLED', 'Operation cancelled'); };
export function gatewayURL(value = DEFAULT_GATEWAY) {
    const url = new URL(value);
    if(url.username || url.password || url.search || url.hash ||
       (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
        throw fail('IO_ERROR', 'Use an HTTPS gateway (HTTP is allowed only on localhost).');
    }
    // The former public endpoint redirects without CORS headers. Bypass that hop.
    if(url.origin === 'https://trustless-gateway.link' && url.pathname === '/') url.hostname = 'trustless-gateway.net';
    return url.href.replace(/\/$/, '');
}

export class RemoteDisk {
    constructor({gateway, onNetwork, timeoutMs = 30000, prefetch = {}}) {
        this.gateway = gatewayURL(gateway);
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
    configurePrefetch({enabled = true, policy = 'auto', concurrency = 2, trace = false, bootProfile} = {}) {
        if(!['auto', 'sequential', 'demand', 'head-demand', 'ranges', ...adaptivePolicies].includes(policy) || ![1, 2].includes(concurrency)) throw fail('OPERATION_FAILED', 'Invalid prefetch settings');
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
            policy:this.policy, concurrency:this.concurrency, traceDropped:this.traceDropped};
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
                await this.read(HEADER + index * RECORD, Math.min(RECORD, this.size - HEADER - index * RECORD), undefined, 'background');
                if(epoch !== this.epoch) break;
                if(!bootstrap && (this.policy === 'sequential' || demand === this.lastDemand)) this.cursor = (index + 1) % this.coverage.length;
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
        this.epoch++;
        this.prefetchState='stopped';
        for(const controller of this.readControllers) controller.abort();
        for(const job of this.jobs.values()) {
            job.controller.abort();
            job.reject(fail('CANCELLED', 'Operation cancelled'));
        }
        this.jobs.clear();
    }
    schedule() {
        const jobs=[...this.jobs.values()], active=jobs.filter(j=>j.state==='active');
        if(active.length >= this.concurrency) return;
        const demand=jobs.find(j=>j.state==='queued' && j.priority==='demand');
        const next=demand || (!this.demandReads && !active.some(j=>j.priority==='demand') && jobs.find(j=>j.state==='queued'));
        if(!next || active.some(j=>j.priority===next.priority)) return;
        next.state='active';
        const start=performance.now();
        this.traceEvent('fetch-start',{cid:next.key,priority:next.priority});
        void (async()=>{
            const bytes=await this.request(`/ipfs/${next.key}?format=raw`, 'application/vnd.ipld.raw', BLOCK_LIMIT, next.controller.signal);
            const digest=await sha256.digest(bytes);
            check(next.controller.signal);
            if(next.epoch !== this.epoch || this.closed) throw fail('CANCELLED','Operation cancelled');
            if(digest.digest.length !== next.cid.multihash.digest.length || !digest.digest.every((b,i)=>b===next.cid.multihash.digest[i])) throw fail('CORRUPTION','IPFS block does not match its CID.');
            this.blocks.set(next.key, bytes);this.cacheBytes+=bytes.length;
            return bytes;
        })().then(bytes=>{this.traceEvent('fetch-end',{cid:next.key,priority:next.priority,bytes:bytes.length,ms:performance.now()-start});next.resolve(bytes);},error=>{this.traceEvent('fetch-error',{cid:next.key,code:error.code,ms:performance.now()-start});next.reject(error);}).finally(()=>{
            if(this.jobs.get(next.key)===next) this.jobs.delete(next.key);
            this.schedule();
        });
    }
    async waitForJob(job, signal) {
        check(signal);
        const waiter={};job.waiters.add(waiter);
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
            if(!job.waiters.size && signal?.aborted) {
                job.controller.abort();job.reject(fail('CANCELLED','Operation cancelled'));
                if(this.jobs.get(job.key)===job) this.jobs.delete(job.key);
                this.schedule();
            }
        }
    }
    async request(path, type, limit, signal) {
        const deadline = Date.now() + this.timeoutMs;
        for(let attempt = 0;; attempt++) {
            try {
                return await this.requestOnce(path, type, limit, signal, Math.max(1, deadline - Date.now()));
            } catch(error) {
                check(signal);
                const delay = 250 * 4 ** attempt;
                if(!error.retryable || attempt >= 2 || deadline - Date.now() <= delay) throw error;
                await new Promise((resolve, reject) => {
                    const finish = () => {signal?.removeEventListener('abort', abort);resolve();};
                    const timer = setTimeout(finish, delay);
                    const abort = () => {clearTimeout(timer);signal.removeEventListener('abort', abort);reject(fail('CANCELLED', 'Operation cancelled'));};
                    signal?.addEventListener('abort', abort, {once:true});
                    if(signal?.aborted) abort();
                });
            }
        }
    }
    async requestOnce(path, type, limit, signal, timeoutMs) {
        check(signal);
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener('abort', abort, {once:true});
        let timedOut = false;
        const timer = setTimeout(() => {timedOut = true;controller.abort();}, timeoutMs);
        let response;
        try {
            this.onNetwork?.(0, 1);
            response = await fetch(this.gateway + path, {
                headers:{Accept:type}, signal:controller.signal, credentials:'omit',
                cache:'no-store', redirect:'error', referrerPolicy:'no-referrer',
            });
            if(!response.ok) {
                const detail = path.startsWith('/ipns/') && response.status === 404
                    ? 'No published disk reference is available from this gateway for this identity.'
                    : 'The gateway could not retrieve the remote data.';
                throw Object.assign(fail('IO_ERROR', `IPFS gateway returned HTTP ${response.status}. ${detail}`), {
                    retryable: [500, 502, 503, 504].includes(response.status),
                });
            }
            if(response.headers.get('content-type')?.split(';')[0].trim() !== type) throw fail('CORRUPTION', 'Gateway did not return verifiable IPFS data.');
            if(Number(response.headers.get('content-length')) > limit) throw fail('CORRUPTION', 'IPFS response exceeds the supported size.');
            const reader = response.body.getReader(), parts = []; let size = 0;
            try {
                for(;;) {
                    const {done, value} = await reader.read();
                    if(done) break;
                    this.onNetwork?.(value.length, 0);
                    size += value.length;
                    if(size > limit) throw fail('CORRUPTION', 'IPFS response exceeds the supported size.');
                    parts.push(value);
                }
            } finally { await reader.cancel().catch(()=>{}); }
            check(signal);
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
        const key = cid.toString();
        let bytes = this.blocks.get(key);
        this.traceEvent('block',{cid:key,priority,hit:!!bytes});
        if(bytes) {yield bytes;return;}
        if(cid.multihash.code === 0) {
            bytes = cid.multihash.digest;
            if(bytes.length > BLOCK_LIMIT) throw fail('UNSUPPORTED_FORMAT', 'IPFS block is too large.');
            this.blocks.set(key,bytes);this.cacheBytes+=bytes.length;
        } else {
            if(cid.multihash.code !== sha256.code) throw fail('UNSUPPORTED_FORMAT', 'Unsupported IPFS hash algorithm.');
            let job=this.jobs.get(key);
            if(!job) {
                job={key,cid,priority,epoch:this.epoch,state:'queued',controller:new AbortController(),waiters:new Set()};
                job.promise=new Promise((resolve,reject)=>{job.resolve=resolve;job.reject=reject;});
                this.jobs.set(key,job);
            }
            if(priority==='demand' && job.priority!=='demand') {job.priority='demand';this.traceEvent('promote',{cid:key});}
            const pending=this.waitForJob(job,signal);
            this.schedule();
            bytes=await pending;
        }
        check(signal);
        yield bytes;
    }
    async open(identity, signal) {
        const bytes = await this.request(`/ipns/${identity.ipnsName}?format=ipns-record`, 'application/vnd.ipfs.ipns-record', 10240, signal);
        try {await validate(publicKeyFromRaw(new Uint8Array(identity.publicKey)), bytes);}
        catch {throw fail('CORRUPTION', 'The IPNS record is invalid, expired, or signed by another identity.');}
        check(signal);
        const record = unmarshalIPNSRecord(bytes);
        if(!record.value.startsWith('/ipfs/')) throw fail('UNSUPPORTED_FORMAT', 'The IPNS record must reference an IPFS file.');
        const path = record.value.slice(6), [root] = path.split('/');
        CID.parse(root);
        await this.openPath(path, signal);
        this.remote = {ipnsName:identity.ipnsName, path:record.value, cid:this.entry.cid.toString(), sequence:record.sequence.toString(), gateway:this.gateway};
        return this;
    }
    async openCid(cid, signal) {
        try {
            if(typeof cid !== 'string') throw new Error();
            const parsed = CID.parse(cid);
            if(![0x70, 0x55, 0x00].includes(parsed.code)) throw new Error();
        } catch { throw fail('INVALID_CID', 'Expected a file CID without a URL or path.'); }
        await this.openPath(cid, signal);
        this.remote = {path:'/ipfs/' + this.entry.cid.toString(), cid:this.entry.cid.toString(), gateway:this.gateway};
        return this;
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
    async read(offset, length, signal, priority = 'demand') {
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
            const output = new Uint8Array(length); let copied = 0;
            if(length === 0) return output;
            for await(const bytes of this.entry.content({offset:BigInt(offset), length:BigInt(length), signal, priority, blockReadConcurrency:1})) {
                check(signal);
                if(epoch!==this.epoch || this.closed) throw fail('CANCELLED','Operation cancelled');
                if(copied + bytes.length > length) throw fail('CORRUPTION', 'IPFS range is longer than requested.');
                output.set(bytes, copied);copied += bytes.length;
            }
            check(signal);
            if(copied !== length) throw fail('IO_ERROR', 'Incomplete IPFS range.');
            this.recordCoverage(offset,length);
            this.traceEvent('read',{offset,length,priority,ms:performance.now()-start});
            if(priority==='demand' && this.prefetchState==='paused') this.startPrefetch();
            return output;
        } finally {
            this.readControllers.delete(controller);
            externalSignal?.removeEventListener('abort',abort);
            if(priority==='demand') this.demandReads--;
            this.schedule();
        }
    }
    clearCache() {this.cancel();this.blocks.clear();this.cacheBytes=0;this.headerCovered=false;this.coverage=undefined;this.adaptiveOrder=undefined;this.rangeOrder=undefined;this.completedUnits=this.coveredBytes=0;}
    close() {this.closed=true;this.clearCache();this.prefetchState='closed';this.entry=undefined;}
}
