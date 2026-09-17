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

/** Resolve only the signed reference. No disk blocks, credentials or persistent state. */
export async function resolveIpns(identity, {servers, onlyLocalhost = false, gateway, signal, onNetwork} = {}) {
    check(signal);
    const local = dataGateway(gateway, onlyLocalhost);
    const endpoints = resolutionServers(onlyLocalhost ? [{url:local,resolution:'gateway',discovery:false}] : servers);
    let key, name;
    try {
        key = publicKeyFromRaw(new Uint8Array(identity.publicKey));
        const parsed = CID.parse(identity.ipnsName);
        if(!key.toCID().equals(parsed)) throw Error();
        name = identity.ipnsName;
    } catch {throw fail('CORRUPTION', 'IPNS name does not match the public key.');}
    const candidates = [], failures = new Array(endpoints.length);let next = 0;
    async function worker() {
        while(next < endpoints.length) {
            check(signal);
            const index = next++, server = endpoints[index];
            try {
                const bytes = await request(server, name, signal, onNetwork);
                try {await validate(key, bytes);}
                catch {throw fail('CORRUPTION', 'Invalid, expired or incorrectly signed record');}
                check(signal);
                const record = unmarshalIPNSRecord(bytes), expires = expiration(record.validity);
                candidates.push({record, expires, index, server:server.url});
            } catch(error) {
                check(signal);failures[index] = {code:error.code || 'CORRUPTION', message:String(error.message).slice(0,100)};
            }
        }
    }
    await Promise.all(Array.from({length:Math.min(CONCURRENCY, endpoints.length)}, worker));
    check(signal);
    const now = BigInt(Date.now()) * 1000000n;
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
    valid.sort((a,b) => a.record.sequence !== b.record.sequence ? (a.record.sequence > b.record.sequence ? -1 : 1) :
        a.expires !== b.expires ? (a.expires > b.expires ? -1 : 1) : a.index-b.index);
    const best = valid[0], record = best.record;
    if(valid.some(c => c.record.sequence === record.sequence && c.expires === best.expires && c.record.value !== record.value)) {
        throw fail('CORRUPTION', 'Conflicting IPNS records have the same sequence and expiration.');
    }
    let rootCid;
    try {
        if(!record.value.startsWith('/ipfs/')) throw Error();
        rootCid = CID.parse(record.value.slice(6).split('/')[0]).toString();
    } catch {throw fail('UNSUPPORTED_FORMAT', 'The newest IPNS record must reference an IPFS file.');}
    check(signal);
    return {ipnsName:name, path:record.value, rootCid, sequence:record.sequence.toString(), resolutionServer:best.server};
}
