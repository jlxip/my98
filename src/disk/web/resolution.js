import {CID} from 'multiformats/cid';
import {publicKeyFromRaw} from '@libp2p/crypto/keys';
import {validate} from 'ipns/validator';
import {unmarshalIPNSRecord} from 'ipns';
import {resolutionServers, dataGateway} from './network-config.js';

const TYPE = 'application/vnd.ipfs.ipns-record';
const LIMIT = 10240, TIMEOUT = 5000, CONCURRENCY = 4;
const fail = (code, message) => Object.assign(new Error(message), {code});
const check = signal => {if(signal?.aborted) throw fail('CANCELLED', 'Operation cancelled');};
// Retain nanosecond precision when comparing renewals of the same sequence.
function expiration(value) {
    const match = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/i.exec(value);
    const seconds = match && Date.parse(match[1] + match[3]);
    if(!match || !Number.isFinite(seconds)) throw fail('CORRUPTION', 'Invalid IPNS expiration.');
    return BigInt(seconds) * 1000000n + BigInt((match[2] || '').padEnd(9, '0'));
}
async function request(server, name, signal, onNetwork) {
    check(signal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, {once:true});
    let timedOut = false, reader;
    const timer = setTimeout(() => {timedOut = true;controller.abort();}, TIMEOUT);
    const path = server.resolution === 'gateway' ? `/ipns/${name}?format=ipns-record` : `/routing/v1/ipns/${name}`;
    try {
        check(signal);onNetwork?.(0, 1);
        const response = await fetch(server.url + path, {
            headers:{Accept:TYPE}, signal:controller.signal, credentials:'omit',
            cache:'no-store', redirect:'error', referrerPolicy:'no-referrer',
        });
        if(!response.ok) throw fail('IO_ERROR', `HTTP ${response.status}`);
        if(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== TYPE) throw fail('CORRUPTION', 'Invalid record content type');
        if(Number(response.headers.get('content-length')) > LIMIT) throw fail('CORRUPTION', 'Record exceeds 10 KiB');
        if(!response.body) throw fail('CORRUPTION', 'Empty record');
        reader = response.body.getReader();
        const parts = [];let size = 0;
        for(;;) {
            const {done, value} = await reader.read();
            if(done) break;
            check(signal);onNetwork?.(value.length, 0);size += value.length;
            if(size > LIMIT) throw fail('CORRUPTION', 'Record exceeds 10 KiB');
            parts.push(value);
        }
        check(signal);
        if(timedOut) throw fail('IO_ERROR', 'Timed out');
        const bytes = new Uint8Array(size);let offset = 0;
        for(const part of parts) {bytes.set(part, offset);offset += part.length;}
        return bytes;
    } catch(error) {
        check(signal);
        if(timedOut) throw fail('IO_ERROR', 'Timed out');
        throw error.code ? error : fail('IO_ERROR', 'Network, CORS or redirect failure');
    } finally {
        controller.abort();clearTimeout(timer);signal?.removeEventListener('abort', abort);
        await reader?.cancel().catch(()=>{});
    }
}

const compare = (a,b) => a.record.sequence !== b.record.sequence ? (a.record.sequence > b.record.sequence ? -1 : 1) :
    a.expires !== b.expires ? (a.expires > b.expires ? -1 : 1) : a.index-b.index;
function result(identity, candidate) {
    const {record}=candidate;let rootCid;
    try {
        if(!record.value.startsWith('/ipfs/'))throw Error();
        rootCid=CID.parse(record.value.slice(6).split('/')[0]).toString();
    } catch {throw fail('UNSUPPORTED_FORMAT','The newest IPNS record must reference an IPFS file.');}
    return {ipnsName:identity.ipnsName,path:record.value,rootCid,sequence:record.sequence.toString(),resolutionServer:candidate.server};
}
function bestCandidate(candidates) {
    const best=[...candidates].sort(compare)[0];
    if(best && candidates.some(c=>c.record.sequence===best.record.sequence && c.expires===best.expires && c.record.value!==best.record.value))
        throw fail('CORRUPTION','Conflicting IPNS records have the same sequence and expiration.');
    return best;
}
/** Optional progressive mode queries all endpoints within one global deadline.
 * onCandidate is synchronous; it schedules work without delaying resolution.
 * The promise still supplies the final choice (or rejects on conflict/expiry).
 */
export async function resolveIpns(identity, {servers, onlyLocalhost = false, gateway, signal, onNetwork, onCandidate, deadlineMs} = {}) {
    check(signal);
    const progressive=onCandidate!==undefined || deadlineMs!==undefined;
    if(onCandidate!==undefined && typeof onCandidate!=='function')throw new TypeError('Expected a candidate callback');
    if(progressive && (!Number.isFinite(deadlineMs??TIMEOUT) || (deadlineMs??TIMEOUT)<=0))throw new TypeError('Expected a positive resolution deadline');
    const local = dataGateway(gateway, onlyLocalhost);
    const endpoints = resolutionServers(onlyLocalhost ? [{url:local,resolution:'gateway',discovery:false}] : servers);
    let key, name;
    try {
        key = publicKeyFromRaw(new Uint8Array(identity.publicKey));
        const parsed = CID.parse(identity.ipnsName);
        if(!key.toCID().equals(parsed)) throw Error();
        name = identity.ipnsName;
    } catch {throw fail('CORRUPTION', 'IPNS name does not match the public key.');}
    const candidates = [], failures = new Array(endpoints.length);let next = 0,notified,fatal,closed=false;
    const round=new AbortController(),abort=()=>round.abort();
    signal?.addEventListener('abort',abort,{once:true});
    const deadline=progressive?performance.now()+(deadlineMs??TIMEOUT):Infinity;
    const timer=progressive?setTimeout(()=>{closed=true;round.abort();},deadlineMs??TIMEOUT):undefined;
    async function worker() {
        while(next < endpoints.length && !closed) {
            check(signal);
            const index = next++, server = endpoints[index];
            try {
                const bytes = await request(server, name, round.signal, onNetwork);
                try {await validate(key, bytes);}
                catch {throw fail('CORRUPTION', 'Invalid, expired or incorrectly signed record');}
                check(signal);
                if(closed || performance.now()>=deadline)return;
                const record = unmarshalIPNSRecord(bytes), expires = expiration(record.validity);
                if(expires<=BigInt(Date.now())*1000000n)throw fail('CORRUPTION','Record expired during resolution');
                candidates.push({record, expires, index, server:server.url});
                if(progressive) {
                    try {
                        const best=bestCandidate(candidates);
                        if(!notified || compare(best,notified)<0) {
                            const value=result(identity,best);notified=best;
                            onCandidate?.(value);
                        }
                    } catch(error) {fatal=error;closed=true;round.abort();}
                }
            } catch(error) {
                check(signal);failures[index] = {code:error.code || 'CORRUPTION', message:String(error.message).slice(0,100)};
            }
        }
    }
    try {
    await Promise.all(Array.from({length:progressive?endpoints.length:Math.min(CONCURRENCY, endpoints.length)}, worker));
    check(signal);
    if(fatal)throw fatal;
    const now = BigInt(Date.now()) * 1000000n;
    // Never roll back a candidate already offered to a progressive consumer.
    if(notified && notified.expires<=now)throw fail('CORRUPTION','Selected IPNS record expired during resolution');
    const valid = candidates.filter(candidate => {
        if(candidate.expires > now) return true;
        failures[candidate.index] = {code:'CORRUPTION', message:'Record expired during resolution'};
        return false;
    });
    if(!valid.length) {
        const errors = failures.filter(Boolean);
        const code = errors.some(e=>e.code === 'CORRUPTION') ? 'CORRUPTION' : 'IO_ERROR';
        throw fail(code, 'No valid IPNS record found. ' + errors.map((e,i)=>`Server ${i+1}: ${e.message}`).join('; '));
    }
    check(signal);
    return result(identity,bestCandidate(valid));
    } finally {closed=true;clearTimeout(timer);round.abort();signal?.removeEventListener('abort',abort);}
}
