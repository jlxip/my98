/** Deployment supplies public read gateways and WebRTC signaling, never admin APIs. */
export const DEFAULT_TORRENT_SOURCES=Object.freeze({gateways:Object.freeze([]),trackers:Object.freeze([])});
const fail=message=>Object.assign(new Error(message),{code:"INVALID_SOURCE"});
function sourceURL(value,protocol) {
    let url;try{if(typeof value!=="string")throw Error();url=new URL(value);}catch{throw fail("Invalid torrent source URL");}
    const local=["127.0.0.1","[::1]","localhost"].includes(url.hostname);
    if(![protocol,local?(protocol==="https:"?"http:":"ws:"):protocol].includes(url.protocol) || url.username || url.password || url.search || url.hash)throw fail("Use HTTPS gateways and WSS signaling");
    return url.href.replace(/\/+$/,"");
}
export function torrentSources(value=DEFAULT_TORRENT_SOURCES) {
    if(!value || typeof value!=="object" || Array.isArray(value) || Object.keys(value).some(key=>!["gateways","trackers"].includes(key)))throw fail("Invalid torrent sources");
    const result={};
    for(const [key,protocol] of [["gateways","https:"],["trackers","wss:"]]) {
        if(!Array.isArray(value[key]??[]) || (value[key]?.length??0)>16)throw fail("Invalid torrent sources");
        result[key]=[...new Set((value[key]??[]).map(url=>sourceURL(url,protocol)))];
    }
    return result;
}
