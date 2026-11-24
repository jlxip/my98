/** BEP44/46 signatures and the my98 profile of standard BEP49 catalogs. */
const encoder=new TextEncoder(),decoder=new TextDecoder("utf-8",{fatal:true});
export const PUBLICATION_SALT="my98/publication/v1";
export const COMPONENT_NAMES=Object.freeze({disk:"disk.my98",state:"state.my98state",profile:"profile.json"});
const limits={catalog:32*1024*1024,disk:2**40+2**30+198,state:2**30+65536,profile:65536};
const error=(code,message)=>Object.assign(new Error(message),{code});
const invalid=message=>error("INVALID_PUBLICATION",message);
export const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
export function unhex(value,length) {
    if(!Number.isSafeInteger(length) || length<0 || typeof value!=="string" || value.length!==length*2 || !/^[0-9a-f]*$/.test(value))throw invalid("Invalid canonical hexadecimal value");
    return Uint8Array.from(value.match(/../g)||[],part=>parseInt(part,16));
}
export function infoHash(value){unhex(value,20);return value;}
function concat(...parts) {
    const result=new Uint8Array(parts.reduce((n,part)=>n+part.length,0));
    let offset=0;for(const part of parts){result.set(part,offset);offset+=part.length;}return result;
}
export function bdecode(bytes) {
    if(!(bytes instanceof Uint8Array) || bytes.length>8*1024*1024)throw invalid("Torrent metadata exceeds limits");
    let offset=0,nodes=0;
    function number(end,negative=false) {
        const start=offset;
        while(offset<bytes.length && bytes[offset]!==end)offset++;
        if(offset===bytes.length || offset-start>(negative?20:17))throw invalid("Invalid torrent integer");
        const text=decoder.decode(bytes.subarray(start,offset++));
        if(!(negative?/^(0|-?[1-9][0-9]*)$/:/^(0|[1-9][0-9]*)$/).test(text))throw invalid("Noncanonical bencode integer");
        if(negative) {
            const value=BigInt(text);
            if(value < -9223372036854775808n || value > 9223372036854775807n)throw invalid("Bencode integer exceeds i64");
            return Number.isSafeInteger(Number(value))?Number(value):value;
        }
        if(!Number.isSafeInteger(Number(text)))throw invalid("Unsafe torrent length");
        return Number(text);
    }
    function parse(depth=0) {
        if(++nodes>4096 || depth>16 || offset>=bytes.length)throw invalid("Torrent metadata structure exceeds limits");
        const start=offset,type=bytes[offset];let value;
        if(type===105){offset++;value=number(101,true);}
        else if(type===100) {
            offset++;value=Object.create(null);let previous;
            while(bytes[offset]!==101) {
                const key=parse(depth+1);
                if(!(key.value instanceof Uint8Array))throw invalid("Invalid dictionary key");
                const name=decoder.decode(key.value);
                if(previous!==undefined && name<=previous)throw invalid("Noncanonical dictionary");
                previous=name;value[name]=parse(depth+1);
            }
            offset++;
        } else if(type===108) {
            offset++;value=[];while(bytes[offset]!==101)value.push(parse(depth+1));offset++;
        } else if(type>=48 && type<=57) {
            const length=number(58);
            if(offset+length>bytes.length)throw invalid("Truncated torrent string");
            value=bytes.subarray(offset,offset+length);offset+=length;
        } else throw invalid("Invalid bencoding");
        return {value,start,end:offset};
    }
    const result=parse();if(offset!==bytes.length)throw invalid("Trailing torrent metadata");return result;
}
const text=node=>{
    if(!(node?.value instanceof Uint8Array))throw invalid("Expected torrent text");
    return decoder.decode(node.value);
};
function component(node) {
    const name=text(node);
    if(!name || name==="." || name===".." || /[\x00-\x1f\x7f/\\:]/.test(name))throw invalid("Unsafe torrent path");
    return name;
}
export function sequence(value) {
    if(typeof value!=="string" || !/^(0|[1-9][0-9]*)$/.test(value) || value.length>19 || BigInt(value)>9223372036854775807n)throw invalid("Invalid exact publication sequence");
    return BigInt(value);
}
export function verifyRecord(value,expectedKey,verifySignature) {
    if(!value || value.key!==expectedKey || value.salt!==hex(encoder.encode(PUBLICATION_SALT)))throw invalid("Invalid publication identity or salt");
    sequence(value.sequence);
    const key=unhex(value.key,32),signature=unhex(value.signature,64);
    if(typeof value.value!=="string" || value.value.length>2000)throw invalid("Invalid BEP44 value");
    const wire=unhex(value.value,value.value.length/2),decoded=bdecode(wire).value;
    const ih=decoded?.ih?.value;
    if(!(ih instanceof Uint8Array) || ih.length!==20)throw invalid("Invalid BEP46 pointer");
    const payload=concat(encoder.encode("4:salt19:"+PUBLICATION_SALT+"3:seqi"+value.sequence+"e1:v"),wire);
    if(typeof verifySignature!=="function" || verifySignature(key,payload,signature)!==true)throw invalid("Invalid publication signature");
    return Object.freeze({key:value.key,salt:value.salt,sequence:value.sequence,signature:value.signature,value:value.value,infoHash:hex(ih)});
}
export function parseRecord(input,expectedKey,verifySignature) {
    let value;try{value=JSON.parse(input);}catch{throw invalid("Invalid gateway JSON");}
    return verifyRecord(value,expectedKey,verifySignature);
}
export function compareRecords(previous,candidate) {
    if(!previous)return true;
    if(previous.key!==candidate.key || previous.salt!==candidate.salt)throw invalid("Cannot compare different identities");
    if(sequence(candidate.sequence)<sequence(previous.sequence))throw error("PUBLICATION_CONFLICT","Publication is older than the highest observed version");
    if(candidate.sequence===previous.sequence) {
        if(candidate.value!==previous.value)throw error("PUBLICATION_CONFLICT","Conflicting publications have the same sequence");
        return false;
    }
    return true;
}
export async function verifyMetadata(input,expected,kind) {
    infoHash(expected);
    const bytes=input instanceof Uint8Array?input:new Uint8Array(input),outer=bdecode(bytes).value,info=outer?.info;
    if(!info?.value || Array.isArray(info.value))throw invalid("Missing torrent info");
    const value=info.value,name=component(value.name),raw=bytes.subarray(info.start,info.end);
    const actualHash=hex(new Uint8Array(await crypto.subtle.digest("SHA-1",raw)));
    if(actualHash!==expected)throw invalid("Torrent metadata does not match its infohash");
    const pieceLength=value["piece length"]?.value,hashes=value.pieces?.value;
    if(!Number.isSafeInteger(pieceLength) || pieceLength<16384 || pieceLength>128*1024*1024 || (pieceLength&(pieceLength-1)) || !(hashes instanceof Uint8Array))throw invalid("Invalid torrent pieces");
    let offset=0,files=[];
    if(value.files) {
        if(value.length || !Array.isArray(value.files.value) || value.files.value.length>64)throw invalid("Invalid multifile torrent");
        const paths=new Set();
        for(const entry of value.files.value) {
            const f=entry.value,length=f?.length?.value,path=f?.path?.value;
            if(!Number.isSafeInteger(length) || length<0 || !Array.isArray(path) || !path.length)throw invalid("Invalid torrent file");
            const parts=path.map(component),filename=parts.join("/");
            if(paths.has(filename))throw invalid("Duplicate torrent path");paths.add(filename);
            const attributes=f.attr?text(f.attr):"";
            if(attributes.includes("l"))throw invalid("Symlinks are not supported");
            files.push({path:parts,filename,length,offset,padding:attributes.includes("p"),sha1:f.sha1?.value});offset+=length;
        }
    } else {
        const length=value.length?.value;
        if(!Number.isSafeInteger(length)||length<1)throw invalid("Invalid torrent length");
        files=[{path:[name],filename:name,length,offset:0,padding:false}];offset=length;
    }
    if(!Number.isSafeInteger(offset) || offset<1 || hashes.length!==20*Math.ceil(offset/pieceLength))throw invalid("Invalid torrent length or piece count");
    let filename=name,size=offset,payloadOffset=0,items;
    if(kind==="catalog") {
        if(!value.files || !value.bep49 || typeof value.bep49.value!=="object" || Array.isArray(value.bep49.value) || value.bep49.value instanceof Uint8Array || offset>limits.catalog)throw invalid("Expected a BEP49 catalog");
        const fields=value.bep49.value;
        if(fields.archive || fields["archive next"])throw invalid("my98 expects a complete HEAD snapshot");
        const source=fields["bep46 source"]?text(fields["bep46 source"]):null;
        const wanted=new Set(["disk.torrent","state.torrent","profile.torrent"]);items=[];
        for(const f of files) {
            if(f.padding)continue;
            if(f.path.length!==1 || !wanted.delete(f.filename) || !(f.sha1 instanceof Uint8Array) || f.sha1.length!==20 || f.length<1 || f.length>8*1024*1024)throw invalid("Unexpected or invalid my98 catalog item");
            items.push({...f,sha1:hex(f.sha1)});
        }
        if(wanted.has("disk.torrent"))throw invalid("Catalog has no disk");
        items.source=source;
    } else {
        const useful=files.filter(f=>!f.padding);
        if(useful.length!==1)throw invalid("Expected one component file");
        const f=useful[0],role=Object.keys(COMPONENT_NAMES).find(k=>COMPONENT_NAMES[k]===f.path.at(-1));
        if(!role || kind!==undefined && kind!==role || f.length<1 || f.length>limits[role] || value.bep49)throw invalid("Invalid torrent component");
        kind=role;filename=f.path.at(-1);size=f.length;payloadOffset=f.offset;
    }
    return {infoHash:expected,kind,filename,size,totalLength:offset,payloadOffset,pieceLength,pieces:Math.ceil(offset/pieceLength),
        ...(items?{items,source:items.source}:{}),metadata:concat(encoder.encode("d4:info"),raw,encoder.encode("e"))};
}
export async function verifyCatalogItem(bytes,item) {
    if(bytes.length!==item.length || hex(new Uint8Array(await crypto.subtle.digest("SHA-1",bytes)))!==item.sha1)throw invalid("Catalog item checksum mismatch");
    const parsed=bdecode(bytes).value,info=parsed?.info;
    if(!info)throw invalid("Catalog item is not a torrent");
    const ih=hex(new Uint8Array(await crypto.subtle.digest("SHA-1",bytes.subarray(info.start,info.end))));
    return verifyMetadata(bytes,ih,item.filename.slice(0,-8));
}
export function verifyCatalogSource(source,key) {
    let url;try{url=new URL(source);}catch{throw invalid("Catalog has no BEP46 identity");}
    if(url.protocol!=="magnet:" || url.searchParams.getAll("xs").length!==1 || url.searchParams.get("xs")!=="urn:btpk:"+key || url.searchParams.getAll("s").length!==1 || url.searchParams.get("s")!==hex(encoder.encode(PUBLICATION_SALT)))throw invalid("Catalog identity does not match login");
}
