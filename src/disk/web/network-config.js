// Shared query-service configuration for IPNS resolution and provider discovery.
export const DEFAULT_SERVERS = Object.freeze([
    Object.freeze({url:'https://piensa.jlxip.net', resolution:'gateway', discovery:true}),
    Object.freeze({url:'https://ipfs.filebase.io', resolution:'gateway', discovery:false}),
    Object.freeze({url:'https://ipfs.orbitor.dev', resolution:'gateway', discovery:false}),
    Object.freeze({url:'https://delegated-ipfs.dev', resolution:'routing', discovery:true}),
]);
export const DEFAULT_GATEWAY = 'https://trustless-gateway.net';
export const LOCAL_GATEWAY = 'http://127.0.0.1:8080';
const fail = message => Object.assign(new Error(message), {code:'IO_ERROR'});
export function isLoopback(url) {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
}
export function gatewayURL(value = DEFAULT_GATEWAY) {
    let url;
    try {if(typeof value !== 'string') throw Error(); url = new URL(value);}
    catch {throw fail('Invalid IPFS server URL.');}
    if(url.username || url.password || url.search || url.hash ||
       (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.href)))) {
        throw fail('Use an HTTPS gateway (HTTP is allowed only on localhost).');
    }
    if(url.origin === 'https://trustless-gateway.link' && url.pathname === '/') url.hostname = 'trustless-gateway.net';
    return url.href.replace(/\/+$/, '');
}
export function dataGateway(gateway, onlyLocalhost = false) {
    if(typeof onlyLocalhost !== 'boolean') throw fail('Invalid Only localhost option.');
    const url = gatewayURL(gateway ?? (onlyLocalhost ? LOCAL_GATEWAY : DEFAULT_GATEWAY));
    if(onlyLocalhost && !isLoopback(url)) throw fail('Only localhost requires a loopback gateway.');
    return url;
}
function queryServers(servers, capability) {
    if(!Array.isArray(servers) || servers.length > 16) throw fail('Configure at most 16 query servers.');
    const seen = new Set(), result = [];
    for(const server of servers) {
        if(!server || typeof server !== 'object' || typeof server.url !== 'string' || ![false, 'gateway', 'routing'].includes(server.resolution) || typeof server.discovery !== 'boolean') {
            throw fail('Invalid query server capabilities.');
        }
        const url = gatewayURL(server.url);
        if(!server[capability]) continue;
        const key = (capability === 'resolution' ? server.resolution + ':' : '') + url;
        if(!seen.has(key)) {seen.add(key);result.push({url, resolution:server.resolution, discovery:server.discovery});}
    }
    if(!result.length) throw fail(capability === 'resolution' ? 'No IPNS resolution servers configured.' : 'No discovery servers configured.');
    return result;
}
export const resolutionServers = (servers = DEFAULT_SERVERS) => queryServers(servers, 'resolution');
export const discoveryServers = (servers = DEFAULT_SERVERS) => queryServers(servers, 'discovery');
