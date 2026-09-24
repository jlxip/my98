import {CID} from 'multiformats/cid';
import {sha256} from 'multiformats/hashes/sha2';
import * as pb from '@ipld/dag-pb';
import {encode as cbor} from '@ipld/dag-cbor';
import {UnixFS} from 'ipfs-unixfs';
const join=parts=>{const result=new Uint8Array(parts.reduce((n,b)=>n+b.length,0));let offset=0;for(const part of parts){result.set(part,offset);offset+=part.length;}return result;};
const vi=n=>{const bytes=[];do{let b=n%128;n=Math.floor(n/128);bytes.push(b|(n?128:0));}while(n);return new Uint8Array(bytes);};
const section=bytes=>join([vi(bytes.length),bytes]);
export function carBytes(blocks,root,offset,length) {
    const parts=[section(cbor({version:1,roots:[root]}))];
    function visit(cid,start,end) {
        const bytes=blocks.get(cid.toString());if(!bytes)throw Error('missing fixture block');
        parts.push(section(join([cid.bytes,bytes])));
        if(cid.code===0x55)return;
        const node=pb.decode(bytes),file=UnixFS.unmarshal(node.Data);let position=file.data?.length||0;
        for(let i=0;i<node.Links.length;i++) {const next=position+Number(file.blockSizes[i]);if(next>start&&position<end)visit(node.Links[i].Hash,Math.max(0,start-position),Math.min(Number(file.blockSizes[i]),end-position));position=next;}
    }
    visit(root,offset,offset+length);return join(parts);
}
export async function carFixture({nested=false,protobuf=false,inline=false,duplicate=false}={}) {
    const blocks=new Map();
    const put=async(bytes,code=0x55)=>{const cid=CID.createV1(code,await sha256.digest(bytes));blocks.set(cid.toString(),bytes);return {cid,size:bytes.length};};
    const node=async(children,data)=>{
        const file=new UnixFS({type:'file',data,blockSizes:children.map(c=>BigInt(c.size))});
        const value=await put(pb.encode({Data:file.marshal(),Links:children.map(c=>({Hash:c.cid,Name:'',Tsize:blocks.get(c.cid.toString()).length}))}),0x70);
        return {...value,size:Number(file.fileSize())};
    };
    const leaves=[],bytes=[];
    for(let i=0;i<24;i++) {
        const b=new Uint8Array(262144);b.fill(duplicate?7:i);bytes.push(b);
        leaves.push(protobuf?await node([],b):await put(b));
    }
    let children=leaves;
    if(nested) {children=[];for(let i=0;i<leaves.length;i+=4)children.push(await node(leaves.slice(i,i+4)));}
    const prefix=inline?new Uint8Array([19,20,21,22,23]):undefined;
    const file=await node(children,prefix);
    return {blocks,leaves,cid:file.cid,size:file.size,bytes:join([...(prefix?[prefix]:[]),...bytes])};
}
