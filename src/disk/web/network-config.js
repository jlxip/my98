export const DEFAULT_SERVERS = Object.freeze([
    Object.freeze({url:'https://piensa.jlxip.net', relay:true}),
    Object.freeze({url:'https://nuc.jlxip.net', relay:true}),
    Object.freeze({url:'https://oregon.jlxip.net', relay:true}),
]);
export function serviceURL(value) {
    let url;
    try {if(typeof value!=='string')throw Error();url=new URL(value);}catch {throw Error('Invalid service URL');}
    if(url.username || url.password || url.search || url.hash || (url.protocol!=='https:' && !(url.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))))throw Error('Use an HTTPS service URL');
    return url.href.replace(/\/+$/, '');
}
