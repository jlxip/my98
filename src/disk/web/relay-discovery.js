import {DEFAULT_SERVERS, gatewayURL} from './network-config.js';

export const RELAY_CAPABILITIES_PATH='/.well-known/my98-relay.json';
const LIMIT=4096;
// Service discovery shares the resolution inventory and verified provider origins.
// Disk/IPNS records never grant egress permission; the service still checks its allowlist.
export async function discoverRelay({servers=DEFAULT_SERVERS, gateways=[], signal, timeout=4000, fetcher=globalThis.fetch}={}) {
    const origins=new Set();
    if(!Array.isArray(servers) || servers.length>16)throw Error('Invalid relay discovery sources');
    for(const source of servers) {
        if(!source || ![false,'gateway','routing'].includes(source.resolution) || typeof source.discovery!=='boolean')throw Error('Invalid relay discovery source');
        if(source.seeder===true && (source.resolution || source.discovery))origins.add(new URL(gatewayURL(source.url)).origin);
    }
    for(const gateway of gateways.slice(0,16)) origins.add(new URL(gatewayURL(gateway)).origin);
    const controller=new AbortController(), abort=()=>controller.abort();
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)abort();
    const timer=setTimeout(abort,timeout);
    try {
        return await Promise.any([...origins].slice(0,16).map(async origin=>{
            const response=await fetcher(origin+RELAY_CAPABILITIES_PATH,{signal:controller.signal,redirect:'error',credentials:'omit',cache:'no-store'});
            if(!response.ok || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '') || Number(response.headers.get('content-length'))>LIMIT)throw Error('No relay announcement');
            const reader=response.body.getReader(), chunks=[];let length=0;
            try {
                for(;;) {
                    const {value,done}=await reader.read();if(done)break;
                    length+=value.byteLength;if(length>LIMIT)throw Error('Relay announcement too large');
                    chunks.push(value);
                }
            } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
            const bytes=new Uint8Array(length);let offset=0;
            for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
            const announcement=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
            const relay=announcement.relay;
            if(announcement.version!==1 || relay?.protocol!=='my98-relay.v1' || relay?.authorization!=='ed25519-allowlist' || typeof relay.url!=='string')throw Error('Relay unavailable');
            const url=new URL(relay.url),expected=new URL(origin);expected.protocol='wss:';
            if(url.origin!==expected.origin || url.pathname!=='/my98-relay/v1' || url.username || url.password || url.search || url.hash || url.protocol!=='wss:')throw Error('Invalid relay announcement');
            return url.href;
        }));
    } finally {clearTimeout(timer);controller.abort();signal?.removeEventListener('abort',abort);}
}
