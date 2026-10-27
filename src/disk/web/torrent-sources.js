const nodes=["piensa","nuc","oregon"].map(name=>"https://"+name+".jlxip.net:8445");
export const DEFAULT_TORRENT_SOURCES=Object.freeze({
    apis:Object.freeze(nodes),webseeds:Object.freeze(nodes.map(url=>url+"/content")),
    trackers:Object.freeze(["wss://nuc.jlxip.net:8445/tracker","wss://oregon.jlxip.net:8445/tracker"])
});
const fail=message=>Object.assign(new Error(message),{code:"INVALID_SOURCE"});
function sourceURL(value,protocols) {
    let url;
    try {if(typeof value!=="string")throw Error();url=new URL(value);}
    catch{throw fail("Invalid torrent source URL");}
    if(!protocols.includes(url.protocol) || url.username || url.password || url.search || url.hash ||
        (["http:","ws:"].includes(url.protocol) && !["127.0.0.1","[::1]","localhost"].includes(url.hostname)))
        throw fail("Use HTTPS/WSS torrent sources");
    return url.href.replace(/\/+$/,"");
}
export function torrentSources(value=DEFAULT_TORRENT_SOURCES) {
    if(!value || typeof value!=="object" || Array.isArray(value) ||
        Object.keys(value).some(key=>!["apis","trackers","webseeds"].includes(key)))throw fail("Invalid torrent sources");
    const result={};
    for(const [key,protocols] of [["apis",["https:","http:"]],["trackers",["wss:","ws:"]],["webseeds",["https:","http:"]]]) {
        if(!Array.isArray(value[key]??[]))throw fail("Invalid torrent sources");
        result[key]=[...new Set((value[key]??[]).map(url=>sourceURL(url,protocols)))];
    }
    return result;
}
