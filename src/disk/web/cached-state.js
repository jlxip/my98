import {CID} from 'multiformats/cid';
import {decode} from '@ipld/dag-pb';
import {UnixFS} from 'ipfs-unixfs';
const invalid=()=>Object.assign(new Error('Invalid cached state DAG'),{code:'CORRUPTION'});
// A cached stream needs no network lookahead. Read one verified block at a time,
// with exact offsets even for inline data in nested UnixFS nodes. The general
// exporter miscounts skipped inline bytes on ranged traversals of such DAGs.
export async function* cachedStateContent(root,size,store,signal) {
 let visited=0;
 async function* walk(cid,total,depth) {
  if(signal?.aborted)throw Object.assign(new Error('Operation cancelled'),{code:'CANCELLED'});
  if(depth>64||++visited>16384)throw invalid();
  let bytes;
  for await(const part of store.get(cid,{signal})) {if(bytes)throw invalid();bytes=part;}
  if(!bytes)throw invalid();
  if(cid.code===0x55){if(bytes.length!==total)throw invalid();yield bytes;return;}
  if(cid.code!==0x70)throw invalid();
  const node=decode(bytes),file=UnixFS.unmarshal(node.Data),data=file.data||new Uint8Array(),sizes=file.blockSizes.map(Number);
  if(!['file','raw'].includes(file.type)||sizes.length!==node.Links.length||sizes.some(n=>!Number.isSafeInteger(n)||n<=0)||data.length+sizes.reduce((a,b)=>a+b,0)!==total||Number(file.fileSize())!==total)throw invalid();
  if(data.length)yield data;
  for(let i=0;i<sizes.length;i++)yield* walk(node.Links[i].Hash,sizes[i],depth+1);
 }
 yield* walk(CID.parse(root),size,0);
}
