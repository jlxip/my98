import {CID} from 'multiformats/cid';
import {sha256} from 'multiformats/hashes/sha2';
import {publicKeyFromRaw} from '@libp2p/crypto/keys';
import {validate} from 'ipns/validator';
import {unmarshalIPNSRecord} from 'ipns';
import {exporter} from 'ipfs-unixfs-exporter';

export const DEFAULT_GATEWAY = 'https://trustless-gateway.net';
const CACHE_LIMIT = 32 * 1024 * 1024;
const BLOCK_LIMIT = 4 * 1024 * 1024;
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
    constructor({gateway, onNetwork, timeoutMs = 30000}) {
        this.gateway = gatewayURL(gateway);
        this.onNetwork = onNetwork;
        this.timeoutMs = timeoutMs;
        this.blocks = new Map();
        this.cacheBytes = 0;
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
    async *get(cid, {signal} = {}) {
        check(signal);
        if(cid.code !== 0x55 && cid.code !== 0x70) throw fail('UNSUPPORTED_FORMAT', 'Only raw and UnixFS IPFS blocks are supported.');
        const key = cid.toString();
        let bytes = this.blocks.get(key);
        if(bytes) {this.blocks.delete(key);this.blocks.set(key, bytes);yield bytes;return;}
        if(cid.multihash.code === 0) {
            bytes = cid.multihash.digest;
        } else {
            if(cid.multihash.code !== sha256.code) throw fail('UNSUPPORTED_FORMAT', 'Unsupported IPFS hash algorithm.');
            bytes = await this.request(`/ipfs/${key}?format=raw`, 'application/vnd.ipld.raw', BLOCK_LIMIT, signal);
            const digest = await sha256.digest(bytes);
            check(signal);
            if(!digest.digest.every((b,i)=>b === cid.multihash.digest[i]) || digest.digest.length !== cid.multihash.digest.length) {
                throw fail('CORRUPTION', 'IPFS block does not match its CID.');
            }
        }
        if(bytes.length > BLOCK_LIMIT) throw fail('UNSUPPORTED_FORMAT', 'IPFS block is too large.');
        while(this.cacheBytes + bytes.length > CACHE_LIMIT) {
            const oldest = this.blocks.keys().next().value;
            this.cacheBytes -= this.blocks.get(oldest).length; this.blocks.delete(oldest);
        }
        this.blocks.set(key, bytes);this.cacheBytes += bytes.length;
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
        this.entry = await exporter(path, this, {signal, blockReadConcurrency:1});
        check(signal);
        if(!['file','raw','identity'].includes(this.entry.type)) throw fail('UNSUPPORTED_FORMAT', 'The IPNS record does not reference a file.');
        const size = this.entry.type === 'file' ? this.entry.unixfs.fileSize() : this.entry.size;
        if(size < 198n || size > BigInt(MAX_FILE)) throw fail('CORRUPTION', 'Invalid encrypted file size.');
        this.size = Number(size);
        this.remote = {ipnsName:identity.ipnsName, path:record.value, cid:this.entry.cid.toString(), sequence:record.sequence.toString(), gateway:this.gateway};
        return this;
    }
    async read(offset, length, signal) {
        check(signal);
        if(!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > this.size) throw fail('IO_ERROR', 'Remote range unavailable.');
        const output = new Uint8Array(length); let copied = 0;
        if(length === 0) return output;
        for await(const bytes of this.entry.content({offset:BigInt(offset), length:BigInt(length), signal, blockReadConcurrency:1})) {
            check(signal);
            if(copied + bytes.length > length) throw fail('CORRUPTION', 'IPFS range is longer than requested.');
            output.set(bytes, copied);copied += bytes.length;
        }
        check(signal);
        if(copied !== length) throw fail('IO_ERROR', 'Incomplete IPFS range.');
        return output;
    }
    clearCache() {this.blocks.clear();this.cacheBytes = 0;}
    close() {this.clearCache();this.entry = undefined;}
}
