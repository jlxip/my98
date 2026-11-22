import {createHash,createPrivateKey,createPublicKey,sign,verify} from 'node:crypto';
export function encode(value) {
    if(typeof value==='number'||typeof value==='bigint')return Buffer.from('i'+value+'e');
    if(typeof value==='string')value=Buffer.from(value);
    if(value instanceof Uint8Array)return Buffer.concat([Buffer.from(value.length+':'),value]);
    if(Array.isArray(value))return Buffer.concat([Buffer.from('l'),...value.map(encode),Buffer.from('e')]);
    return Buffer.concat([Buffer.from('d'),...Object.keys(value).sort().flatMap(k=>[encode(k),encode(value[k])]),Buffer.from('e')]);
}
export const sha1=bytes=>createHash('sha1').update(bytes).digest();
export const salt=Buffer.from('my98/publication/v1');
// Frozen derivation for the public disk-fixture credentials; not a user identity.
export const secret=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from('c80e4484997cdd302848d0348e56e84e089089fe14e03dcf681fe9ce0ba76944','hex')]),format:'der',type:'pkcs8'});
export const key=createPublicKey(secret).export({format:'der',type:'spki'}).subarray(-32).toString('hex');
export function checkSignature(pk,message,sig) {return verify(null,message,createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),pk]),format:'der',type:'spki'}),sig);}
export function record(hash,sequence='9007199254740994',extra={}) {
    const value=encode({ih:Buffer.from(hash,'hex'),...extra});
    const message=Buffer.concat([Buffer.from('4:salt19:'),salt,Buffer.from('3:seqi'+sequence+'e1:v'),value]);
    return {key,salt:salt.toString('hex'),sequence,signature:sign(null,message,secret).toString('hex'),value:value.toString('hex')};
}
export function torrent(bytes,name='disk.my98',piece=16384) {
    const pieces=[];for(let offset=0;offset<bytes.length;offset+=piece)pieces.push(sha1(bytes.subarray(offset,offset+piece)));
    const info={name,length:bytes.length,'piece length':piece,pieces:Buffer.concat(pieces)};
    return {bytes,info,metadata:encode({info}),hash:sha1(encode(info)).toString('hex')};
}
export function catalog(entries,{piece=16384,source=true}={}) {
    const files=entries.map(([name,t])=>({path:[name],length:t.metadata.length,sha1:sha1(t.metadata)}));
    const bytes=Buffer.concat(entries.map(([,t])=>t.metadata)),pieces=[];
    for(let offset=0;offset<bytes.length;offset+=piece)pieces.push(sha1(bytes.subarray(offset,offset+piece)));
    const info={name:'my98',bep49:source?{'bep46 source':'magnet:?xs=urn:btpk:'+key+'&s='+salt.toString('hex')}:{},files,'piece length':piece,pieces:Buffer.concat(pieces)};
    return {bytes,info,metadata:encode({info}),hash:sha1(encode(info)).toString('hex')};
}
