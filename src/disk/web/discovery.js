import {CID} from 'multiformats/cid';
import {base58btc} from 'multiformats/bases/base58';
import {sha256} from 'multiformats/hashes/sha2';
import {multiaddr} from '@multiformats/multiaddr';
import {discoveryServers} from './network-config.js';

export const DISCOVERY_LIMITS = Object.freeze({roundMs:30000, requestMs:5000, queries:4, probes:4,
    records:100, responseBytes:1048576, recordBytes:16384, addresses:16, endpoints:64,
    totalBytes:32 * 1048576, blockBytes:4 * 1048576});
const L = DISCOVERY_LIMITS, encoder = new TextEncoder();
const fail = (code, message) => Object.assign(new Error(message), {code});
const cancelled = () => fail('CANCELLED', 'Operation cancelled');

function peerID(value) {
    if(typeof value !== 'string' || value.length > 256) throw Error('Invalid peer ID');
    // Legacy Peer IDs are multihashes, rather than CIDv0 (which only permits sha256).
    if(value.startsWith('Qm') || value.startsWith('1')) return legacyPeerID(value);
    const cid = CID.parse(value);
    if(cid.code !== 0x72 || ![0,sha256.code].includes(cid.multihash.code)) throw Error('Invalid peer ID');
    return cid.toV1().toString();
}

// Decode through a libp2p-key CID so both identity and sha256 Peer IDs normalize alike.
function legacyPeerID(value) {
    const hash = base58btc.decode('z' + value);
    const bytes = new Uint8Array(hash.length + 2); bytes.set([1,0x72]); bytes.set(hash,2);
    const cid = CID.decode(bytes);
    if(![0,sha256.code].includes(cid.multihash.code)) throw Error('Invalid peer ID');
    return cid.toString();
}

function publicIPv4(host) {
    const p = host.split('.').map(Number);
    if(p.length !== 4 || p.some(n=>!Number.isInteger(n) || n<0 || n>255)) return false;
    const [a,b,c] = p;
    return !(a===0 || a===10 || a===127 || a>=224 || a===169&&b===254 ||
        a===172&&b>=16&&b<=31 || a===192&&b===168 || a===100&&b>=64&&b<=127 ||
        a===192&&b===0&&(c===0||c===2) || a===192&&b===88&&c===99 || a===198&&(b===18||b===19) ||
        a===198&&b===51&&c===100 || a===203&&b===0&&c===113);
}
function publicIPv6(host) {
    // Only global unicast 2000::/3, excluding special-use, transition and documentation ranges.
    const words = host.replace(/^\[|\]$/g,'').split(':');
    const first = parseInt(words[0],16), second = parseInt(words[1] || '0',16);
    return first>=0x2000 && first<=0x3fff && first!==0x2002 &&
        !(first===0x2001 && (second<0x200 || second===0xdb8)) &&
        first<0x3ffe;
}

/** Decode advertised HTTP transports only. TLS/SNI/WebSocket is not an HTTP gateway. */
export function advertisedGateway(address, expectedPeer) {
    try {
        const components = multiaddr(address).getComponents();
        const last = components.at(-1);
        if(last?.name === 'p2p') {
            if(peerID(last.value) !== peerID(expectedPeer)) return;
            components.pop();
        }
        const [host, port, ...transport] = components;
        if(!host || !['dns','dns4','dns6','ip4','ip6'].includes(host.name) || port?.name!=='tcp' ||
           !Number.isInteger(+port.value) || +port.value<1 || +port.value>65535 ||
           !['https','tls/http'].includes(transport.map(c=>c.name).join('/'))) return;
        const raw = host.name==='ip6' ? '['+host.value+']' : host.value;
        const url = new URL('https://' + raw + ':' + port.value);
        if(url.username || url.password || url.pathname!=='/' || url.search || url.hash) return;
        const name = url.hostname.toLowerCase().replace(/\.$/,'');
        if(host.name==='ip4' || /^\d+\.\d+\.\d+\.\d+$/.test(name)) {
            if(!publicIPv4(name)) return;
        } else if(host.name==='ip6' || name.startsWith('[')) {
            if(!publicIPv6(name)) return;
        } else {
            if(!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(name) || !name.includes('.') ||
               name.split('.').some(label=>!label || label.length>63 || label.startsWith('-') || label.endsWith('-')) ||
               /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|onion|test|invalid|example)$/.test(name) || name.endsWith('.home.arpa')) return;
        }
        url.hostname = name;
        return url.origin;
    } catch { return; }
}

/** One bounded round. onProvider receives snapshots and, on a successful probe, its verified root block. */
export async function discoverProviders(value, {servers, signal, onProvider, onNetwork} = {}) {
    if(signal?.aborted) throw cancelled();
    let cid;
    try {cid = CID.parse(String(value)).toV1();} catch {throw fail('INVALID_CID','Invalid discovery CID.');}
    if(![0,sha256.code].includes(cid.multihash.code)) throw fail('UNSUPPORTED_FORMAT','Unsupported IPFS hash algorithm.');
    const endpoints = discoveryServers(servers), controller = new AbortController();
    const abort = () => controller.abort(); signal?.addEventListener('abort',abort,{once:true});
    const limits = new Set(), failures = [], peers = new Map(), gateways = new Map();
    const queues = endpoints.map(()=>[]), waiters = new Set();
    let receivedBytes=0, tested=0, verified=0, nextQuery=0, nextQueue=0, queriesDone=false;
    const stop = limit => {limits.add(limit);controller.abort();wake();};
    const timer = setTimeout(()=>stop('round-time'),L.roundMs);
    const check = () => {if(controller.signal.aborted) throw cancelled();};
    function wake() {for(const resolve of waiters) resolve();waiters.clear();}
    controller.signal.addEventListener('abort',wake);
    const snapshot = peer => ({peerId:peer.id, addresses:[...peer.addresses], sources:[...peer.sources],
        gateways:[...peer.gateways].filter(url=>gateways.get(url)?.state==='verified')});
    const emit = (peer, block) => {check();const record=snapshot(peer);if(record.gateways.length) onProvider?.(record, block);};
    function failure(stage, target, error) {
        if(!controller.signal.aborted) failures.push({stage,target,code:typeof error.code==='string'?error.code:'IO_ERROR',message:String(error.message).slice(0,160)});
    }
    function count(bytes) {
        onNetwork?.(bytes,0);receivedBytes+=bytes;
        if(receivedBytes>L.totalBytes) {stop('total-bytes');throw fail('IO_ERROR','Discovery byte budget exhausted.');}
    }
    async function request(url, accept, limit, consume, empty404=false) {
        check(); const local = new AbortController();
        const abortRequest = () => local.abort();controller.signal.addEventListener('abort',abortRequest,{once:true});
        const timeout = setTimeout(abortRequest,L.requestMs);let reader;
        try {
            onNetwork?.(0,1);
            const response = await fetch(url,{headers:{Accept:accept},signal:local.signal,
                credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer'});
            check();if(local.signal.aborted)throw fail('IO_ERROR','Discovery request timed out.');
            if(empty404 && response.status===404) return;
            if(!response.ok) throw fail('IO_ERROR','HTTP '+response.status);
            const type=response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
            if(!(empty404 ? ['application/json','application/x-ndjson'] : ['application/vnd.ipld.raw']).includes(type)) throw fail('CORRUPTION','Invalid discovery content type.');
            if(Number(response.headers.get('content-length'))>limit) {
                if(empty404) limits.add('response-bytes');
                throw fail('CORRUPTION','Discovery response too large.');
            }
            if(!response.body) throw fail('IO_ERROR','Missing response body.');
            reader=response.body.getReader();let size=0;
            const acceptChunk=consume(type);
            for(;;) {
                const {value,done}=await reader.read();check();
                if(local.signal.aborted) throw fail('IO_ERROR','Discovery request timed out.');
                if(done) {
                    await acceptChunk(undefined);check();
                    if(local.signal.aborted)throw fail('IO_ERROR','Discovery request timed out.');
                    break;
                }
                count(value.length);size+=value.length;
                if(size>limit) {if(empty404)limits.add('response-bytes');throw fail('CORRUPTION','Discovery response too large.');}
                if(await acceptChunk(value)===false) break;
            }
        } finally {
            local.abort();clearTimeout(timeout);controller.signal.removeEventListener('abort',abortRequest);
            await reader?.cancel().catch(()=>{});
        }
    }
    function record(raw, index) {
        if(!raw || raw.Schema!=='peer') return;
        let id;try {id=peerID(raw.ID);}catch{return;}
        let peer=peers.get(id);
        if(!peer) {peer={id,addresses:new Set(),sources:new Set(),gateways:new Set()};peers.set(id,peer);}
        const before=peer.addresses.size+peer.sources.size;
        peer.sources.add(endpoints[index].url);
        for(const addr of Array.isArray(raw.Addrs)?raw.Addrs:[]) {
            if(typeof addr!=='string' || peer.addresses.has(addr))continue;
            if(peer.addresses.size>=L.addresses) {limits.add('addresses');break;}
            try{multiaddr(addr);}catch{continue;}
            peer.addresses.add(addr);
            const url=advertisedGateway(addr,id);if(!url)continue;
            peer.gateways.add(url);
            let gateway=gateways.get(url);
            if(!gateway) {gateway={url,state:'queued',peers:new Set()};gateways.set(url,gateway);queues[index].push(gateway);}
            gateway.peers.add(peer);
        }
        if(peer.addresses.size+peer.sources.size!==before) emit(peer);
        wake();
    }
    async function query(index) {
        try {
            await request(endpoints[index].url+'/routing/v1/providers/'+cid,'application/x-ndjson',L.responseBytes,type=>{
                let text='',records=0;const decoder=new TextDecoder('utf-8',{fatal:true});
                function line(value) {
                    if(!value.trim())return true;
                    if(records>=L.records) {limits.add('records');return false;}
                    records++;
                    if(encoder.encode(value).length>L.recordBytes){limits.add('record-bytes');return true;}
                    let parsed;try{parsed=JSON.parse(value);}catch{return true;}
                    record(parsed,index);return true;
                }
                return chunk=>{
                    text+=chunk?decoder.decode(chunk,{stream:true}):decoder.decode();
                    if(type==='application/json') {
                        if(chunk)return;
                        const raw=JSON.parse(text);if(!Array.isArray(raw?.Providers))throw fail('CORRUPTION','Missing Providers array.');
                        for(const provider of raw.Providers) if(line(JSON.stringify(provider))===false)break;
                    } else {
                        let end;
                        while((end=text.indexOf('\n'))>=0) {
                            const value=text.slice(0,end);text=text.slice(end+1);
                            if(line(value)===false)return false;
                        }
                        if(encoder.encode(text).length>L.recordBytes) {limits.add('record-bytes');throw fail('CORRUPTION','Discovery record too large.');}
                        if(!chunk && text)line(text);
                    }
                };
            },true);
        } catch(error) {failure('routing',endpoints[index].url,error);}
    }
    function next() {
        if(tested>=L.endpoints) {
            if(queues.some(q=>q.length))limits.add('endpoints');
            for(const queue of queues)queue.length=0;
            return;
        }
        for(let i=0;i<queues.length;i++) {
            const index=(nextQueue+i)%queues.length, gateway=queues[index].shift();
            if(gateway) {nextQueue=(index+1)%queues.length;tested++;gateway.state='testing';return gateway;}
        }
    }
    async function probe(gateway) {
        try {
            let block;
            await request(gateway.url+'/ipfs/'+cid+'?format=raw','application/vnd.ipld.raw',L.blockBytes,()=>{
                const parts=[];let size=0;
                return async chunk=>{
                    if(chunk) {parts.push(chunk);size+=chunk.length;return;}
                    block=new Uint8Array(size);let offset=0;
                    for(const part of parts){block.set(part,offset);offset+=part.length;}
                    const digest=cid.multihash.code===0?block:(await sha256.digest(block)).digest;check();
                    if(!digest.every((b,i)=>b===cid.multihash.digest[i]) || digest.length!==cid.multihash.digest.length) throw fail('CORRUPTION','Provider block does not match the root CID.');
                };
            });
            check();gateway.state='verified';verified++;
            for(const peer of gateway.peers)emit(peer,{gateway:gateway.url,rootBlock:block});
        } catch(error) {gateway.state='failed';failure('probe',gateway.url,error);}
    }
    async function probeWorker() {
        while(!controller.signal.aborted) {
            const gateway=next();
            if(gateway) {await probe(gateway);continue;}
            if(queriesDone)return;
            await new Promise(resolve=>waiters.add(resolve));
        }
    }
    try {
        // Routing and probing use separate pools, so a slow provider cannot hold up another router.
        const queries=Promise.all(Array.from({length:Math.min(L.queries,endpoints.length)},async()=>{
            while(!controller.signal.aborted && nextQuery<endpoints.length)await query(nextQuery++);
        })).finally(()=>{queriesDone=true;wake();});
        await Promise.all([queries,...Array.from({length:L.probes},probeWorker)]);
        if(signal?.aborted)throw cancelled();
        return {state:limits.size?'limited':'complete',providers:[...peers.values()].map(snapshot),
            failures,limits:[...limits],receivedBytes,endpointsTested:tested,verifiedEndpoints:verified};
    } finally {
        controller.abort();clearTimeout(timer);signal?.removeEventListener('abort',abort);
    }
}
