/** Public protocol validation. The Worker supplies the existing Rust verifier. */
const encoder=new TextEncoder(),decoder=new TextDecoder("utf-8",{fatal:true});
export const PUBLICATION_SALT="my98/publication/v1";
export const COMPONENT_NAMES=Object.freeze({descriptor:"publication.json",disk:"disk.my98",state:"state.my98state",profile:"profile.json"});
const limits={descriptor:4096,disk:2**40+2**30+198,state:2**30+65536,profile:65536};
const error=(code,message)=>Object.assign(new Error(message),{code});
const invalid=message=>error("INVALID_PUBLICATION",message);
const keysAre=(value,keys)=>value && typeof value==="object" && !Array.isArray(value) &&
    Object.keys(value).length===keys.length && keys.every(key=>Object.hasOwn(value,key));
export const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
export function unhex(value,length) {
    if(typeof value!=="string" || value.length!==length*2 || !/^[0-9a-f]+$/.test(value))
        throw invalid("Invalid canonical hexadecimal value");
    return Uint8Array.from(value.match(/../g),part=>parseInt(part,16));
}
export function infoHash(value){unhex(value,20);return value;}
function concat(...parts) {
    const result=new Uint8Array(parts.reduce((n,part)=>n+part.length,0));
    let offset=0;for(const part of parts){result.set(part,offset);offset+=part.length;}
    return result;
}

export function verifyRecord(value,expectedKey,verifySignature) {
    if(!keysAre(value,["publicKey","sequence","infoHash","signature","salt"]) ||
        value.publicKey!==expectedKey || value.salt!==hex(encoder.encode(PUBLICATION_SALT)) ||
        !Number.isSafeInteger(value.sequence) || value.sequence<1)throw invalid("Invalid signed publication destination or sequence");
    const key=unhex(value.publicKey,32),signature=unhex(value.signature,64),ih=unhex(value.infoHash,20);
    const payload=concat(encoder.encode("4:salt19:"+PUBLICATION_SALT+"3:seqi"+value.sequence+"e1:vd2:ih20:"),ih,encoder.encode("e"));
    if(typeof verifySignature!=="function" || verifySignature(key,payload,signature)!==true)
        throw invalid("Invalid publication signature");
    return Object.freeze({...value});
}

export function parseRecord(text,expectedKey,verifySignature) {
    let value;
    try{value=JSON.parse(text);}catch{throw invalid("Invalid signed publication JSON");}
    // JSON.parse can round a fractional literal near MAX_SAFE_INTEGER into a
    // valid signed integer. Reject non-integer wire syntax before accepting it.
    const fields=typeof text==="string"?[...text.matchAll(/"sequence"\s*:\s*(0|[1-9][0-9]*)\s*(?=[,}])/g)]:[];
    if(fields.length!==1 || Number(fields[0][1])!==value?.sequence)
        throw invalid("Publication sequence must be an exact JSON integer");
    return verifyRecord(value,expectedKey,verifySignature);
}

export function compareRecords(previous,candidate) {
    if(!previous)return true;
    if(previous.publicKey!==candidate.publicKey)throw invalid("Cannot compare different publication identities");
    if(candidate.sequence<previous.sequence)throw error("PUBLICATION_CONFLICT","Publication is older than the highest observed version");
    if(candidate.sequence===previous.sequence) {
        if(candidate.infoHash!==previous.infoHash)throw error("PUBLICATION_CONFLICT","Conflicting publications have the same sequence");
        return false;
    }
    return true;
}

export function parseDescriptor(input) {
    const bytes=typeof input==="string"?encoder.encode(input):input;
    if(!(bytes instanceof Uint8Array) || bytes.length>4096)throw invalid("Invalid descriptor size");
    let value,text;
    try{text=decoder.decode(bytes);value=JSON.parse(text);}
    catch{throw invalid("Invalid publication descriptor JSON");}
    if(!keysAre(value,["version","disk","state","profile"]) || value.version!==1)
        throw invalid("Invalid publication descriptor fields");
    // JSON.parse does not report duplicate keys. Scan valid JSON string tokens
    // at depth one, including escaped spellings of the same field name.
    let depth=0;const seen=new Set();
    for(let i=0;i<text.length;i++) {
        const c=text[i];
        if(c==='"') {
            const start=i++;
            for(;i<text.length;i++) {
                if(text[i]==="\\"){i++;continue;}
                if(text[i]==='"')break;
            }
            let next=i+1;while(/\s/.test(text[next]||"x"))next++;
            if(depth===1 && text[next]===":") {
                const key=JSON.parse(text.slice(start,i+1));
                if(seen.has(key))throw invalid("Duplicate publication descriptor field");
                seen.add(key);
                if(key==="version" && !/^\s*1\s*[,}]/.test(text.slice(next+1)))
                    throw invalid("Descriptor version must be an exact JSON integer");
            }
        } else if(c==="{" || c==="[")depth++;
        else if(c==="}" || c==="]")depth--;
    }
    infoHash(value.disk);
    for(const key of ["state","profile"])if(value[key]!==null)infoHash(value[key]);
    return Object.freeze({version:1,disk:value.disk,state:value.state,profile:value.profile});
}

function bdecode(bytes) {
    let offset=0,nodes=0;
    function number(end,negative=false) {
        const start=offset;
        while(offset<bytes.length && bytes[offset]!==end)offset++;
        if(offset===bytes.length || offset-start>17)throw invalid("Invalid torrent integer");
        const text=decoder.decode(bytes.subarray(start,offset++));
        if(!(negative?/^(0|-?[1-9][0-9]*)$/:/^(0|[1-9][0-9]*)$/).test(text) ||
            !Number.isSafeInteger(Number(text)))throw invalid("Unsafe or noncanonical torrent integer");
        return Number(text);
    }
    function parse(depth=0) {
        if(++nodes>256 || depth>8 || offset>=bytes.length)throw invalid("Torrent metadata structure exceeds limits");
        const start=offset,type=bytes[offset];
        let value;
        if(type===105){offset++;value=number(101,true);}
        else if(type===100) {
            offset++;value=Object.create(null);let previous;
            while(bytes[offset]!==101) {
                const key=parse(depth+1);
                if(!(key.value instanceof Uint8Array))throw invalid("Invalid torrent dictionary key");
                const name=decoder.decode(key.value);
                if(previous!==undefined && name<=previous)throw invalid("Noncanonical torrent dictionary");
                previous=name;value[name]=parse(depth+1);
            }
            offset++;
        } else if(type===108) {
            offset++;value=[];
            while(bytes[offset]!==101)value.push(parse(depth+1));
            offset++;
        } else if(type>=48 && type<=57) {
            const length=number(58);
            if(length<0 || offset+length>bytes.length)throw invalid("Truncated torrent string");
            value=bytes.subarray(offset,offset+length);offset+=length;
        } else throw invalid("Invalid torrent bencoding");
        return {value,start,end:offset};
    }
    const result=parse();
    if(offset!==bytes.length)throw invalid("Trailing torrent metadata");
    return result.value;
}

export async function verifyMetadata(bytes,expected,kind) {
    infoHash(expected);
    const limit=kind==="descriptor"?16384:96*1024*1024;
    if(!(bytes instanceof Uint8Array) || !bytes.length || bytes.length>limit)throw invalid("Invalid torrent metadata size");
    let info;
    try{info=bdecode(bytes).info;}
    catch(cause){throw invalid("Invalid canonical torrent metadata: "+cause.message);}
    if(!info || !keysAre(info.value,["name","length","piece length","pieces"]))throw invalid("Only single-file v1 torrents are accepted");
    const value=info.value,name=value.name.value;
    const filename=name instanceof Uint8Array?decoder.decode(name):"";
    const actual=Object.keys(COMPONENT_NAMES).find(key=>COMPONENT_NAMES[key]===filename);
    if(!actual || (kind!==undefined && kind!==actual))throw invalid("Incorrect torrent component filename");
    const size=value.length.value,pieceLength=value["piece length"].value,hashes=value.pieces.value;
    if(!Number.isSafeInteger(size) || size<1 || size>limits[actual] || pieceLength!==256*1024 ||
        !(hashes instanceof Uint8Array) || hashes.length!==20*Math.ceil(size/pieceLength))
        throw invalid("Invalid torrent size, piece length or piece hashes");
    const raw=bytes.subarray(info.start,info.end);
    const actualHash=hex(new Uint8Array(await crypto.subtle.digest("SHA-1",raw)));
    if(actualHash!==expected)throw invalid("Torrent metadata does not match the publication infohash");
    // Preserve only the exact verified info dictionary. Unsigned trackers,
    // webseeds, URLs and paths cannot introduce network destinations.
    return {infoHash:actualHash,kind:actual,filename,size,pieces:Math.ceil(size/pieceLength),
        metadata:concat(encoder.encode("d4:info"),raw,encoder.encode("e"))};
}
