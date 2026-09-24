import {decode} from '@ipld/dag-pb';
import {UnixFS} from 'ipfs-unixfs';
import {CID} from 'multiformats/cid';
const HEADER=198,RECORD=65536+62;
// Derive eligibility from authenticated DAG edges and file offsets, never from
// request priority. A CID may occur at several offsets in a UnixFS file.
export class ProfileCacheSelection {
    constructor(root,size,ranges,blocks,persist) {
        this.blocks=blocks;this.persist=persist;this.positions=new Map();this.visited=new Set();this.eligible=new Set();
        this.ranges=[[0,HEADER],...ranges.map(([a,b])=>[HEADER+a*RECORD,Math.min(size,HEADER+(b+1)*RECORD)])];
        this.add(CID.parse(root),0,size,0);
    }
    add(cid,offset,size,depth) {
        if(depth>64||this.visited.size>=16384||!this.ranges.some(([a,b])=>offset<b&&offset+size>a))return;
        const key=cid.toV1().toString(),position=key+':'+offset;
        if(this.visited.has(position))return;
        this.visited.add(position);this.eligible.add(key);
        const entries=this.positions.get(key)||[];entries.push({offset,size,depth});this.positions.set(key,entries);
        const bytes=this.blocks.get(key);if(bytes)this.observe(cid,bytes);
    }
    observe(cid,bytes) {
        const key=cid.toV1().toString(),positions=this.positions.get(key);
        if(!positions)return;
        this.persist(cid,bytes);
        if(cid.code!==0x70)return;
        let node,file,sizes;
        try {
            node=decode(bytes);file=UnixFS.unmarshal(node.Data);sizes=file.blockSizes.map(Number);
            if(!['file','raw'].includes(file.type)||sizes.length!==node.Links.length||sizes.some(n=>!Number.isSafeInteger(n)||n<=0))return;
        }catch{return;}
        for(const {offset,size,depth} of positions.splice(0)) {
            if((file.data?.length||0)+sizes.reduce((a,b)=>a+b,0)!==size)return;
            let at=offset+(file.data?.length||0);
            for(let i=0;i<sizes.length;i++){this.add(node.Links[i].Hash,at,sizes[i],depth+1);at+=sizes[i];}
        }
    }
}
