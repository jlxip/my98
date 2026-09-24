import {RemoteDisk} from '../web/remote.js';
import {CID} from 'multiformats/cid';
import {sha256} from 'multiformats/hashes/sha2';
import * as dagPb from '@ipld/dag-pb';
import {UnixFS} from 'ipfs-unixfs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const check=(value,message)=>{if(!value)throw Error(message);};
const cancelled=()=>Object.assign(Error('Cancelled'),{code:'CANCELLED'});
async function wait(ms,signal) {
 if(signal?.aborted)throw cancelled();
 await new Promise((resolve,reject)=>{
  const done=()=>{signal?.removeEventListener('abort',abort);resolve();};
  const timer=setTimeout(done,ms),abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(cancelled());};
  signal?.addEventListener('abort',abort,{once:true});
 });
}
async function until(fn) {const deadline=performance.now()+5000;while(!fn()){if(performance.now()>deadline)throw Error('Condition timed out');await delay(5);}}
const take=async iterable=>{for await(const bytes of iterable)return bytes;};
async function fixture(count=48) {
 const blocks=new Map(),leaves=[];
 async function put(bytes,code=0x55){const cid=CID.createV1(code,await sha256.digest(bytes));blocks.set(cid.toString(),bytes);return cid;}
 for(let i=0;i<count;i++){const bytes=new Uint8Array(262144);bytes.fill(i);leaves.push(await put(bytes));}
 const file=async cids=>put(dagPb.encode({Data:new UnixFS({type:'file',blockSizes:cids.map(cid=>BigInt(blocks.get(cid.toString()).length))}).marshal(),Links:cids.map(cid=>({Hash:cid,Name:'',Tsize:blocks.get(cid.toString()).length}))}),0x70);
 const state=await file(leaves),disk=await file([leaves[0]]);
 const publication=await put(dagPb.encode({Data:new UnixFS({type:'directory'}).marshal(),Links:[{Name:'disk.my98',Hash:disk},{Name:'state.my98state',Hash:state}]}),0x70);
 return {blocks,leaves,state,disk,publication};
}
function remoteFor(f,{providers=1,behavior=()=>({ms:8}),preloadState=false}={}) {
 const remote=new RemoteDisk({gateway:'https://p0.example',prefetch:{enabled:false,trace:true},preloadState,stateTransport:'blocks'});
 for(let i=1;i<providers;i++)remote.addEndpoint('https://p'+i+'.example');
 const calls=[];let active=0,peak=0;
 remote.request=async(path,type,limit,signal,gateway,timeout,onProgress)=>{
  const cid=path.split('/')[2].split('?')[0],entry={cid,gateway,start:performance.now()};calls.push(entry);
  active++;peak=Math.max(peak,active);
  try {const mode=behavior(entry,calls);await wait(mode.ms,signal);if(mode.error)throw Object.assign(Error('fixture failure'),{code:'IO_ERROR',status:404});
   const bytes=f.blocks.get(cid).slice();if(mode.corrupt)bytes[0]^=1;onProgress?.(bytes.length);return bytes;
  }finally{entry.end=performance.now();entry.aborted=signal.aborted;active--;}
 };
 return {remote,calls,get active(){return active;},get peak(){return peak;}};
}
export async function runNetworkCases() {
 const checks=[],ok=label=>checks.push(label),f=await fixture();
 {
  const t=remoteFor(f),r=t.remote;
  try {await Promise.all(f.leaves.map(cid=>take(r.get(cid,{}))));check(t.peak>2&&t.peak<=8,'adaptive concurrency must grow and respect global limit');check([...r.endpoints.values()][0].window===8,'healthy endpoint reaches global budget');ok('healthy provider grows beyond two within global budget');}
  finally{r.close();}
 }
 {
  let cold=true;const t=remoteFor(f,{behavior:()=>({ms:cold?800:8})}),r=t.remote;
  try {
   await take(r.get(f.leaves[0],{}));const endpoint=[...r.endpoints.values()][0];
   check(endpoint.window===2,'first data response establishes baseline without cutting initial capacity');
   cold=false;await Promise.all(f.leaves.slice(1,8).map(cid=>take(r.get(cid,{}))));
   check(endpoint.window===8,'successful initial windows ramp up promptly');
   ok('cold first data sample retains initial capacity and successful windows ramp up');
  }finally{r.close();}
 }
 {
  let slow=false;const t=remoteFor(f,{behavior:()=>({ms:slow?800:8})}),r=t.remote;
  try {
   await Promise.all(f.leaves.slice(0,32).map(cid=>take(r.get(cid,{}))));const endpoint=[...r.endpoints.values()][0],before=endpoint.window;
   slow=true;await take(r.get(f.leaves[32],{}));check(endpoint.window<before,'degradation reduces learned allowance');
   const reduced=endpoint.window;slow=false;await take(r.get(f.leaves[33],{}));check(endpoint.window===reduced,'slow provider does not immediately regrow');
   slow=true;for(const cid of f.leaves.slice(34,38))await take(r.get(cid,{}));
   check(endpoint.window>=2,'latency spikes must not serialize the established two-slot baseline');
   ok('slow completed transfers reduce capacity; single-provider reads are not abandoned');
  }finally{r.close();}
 }
 {
  const t=remoteFor(f,{providers:2,behavior:e=>({ms:e.gateway.includes('p0')?500:8})}),r=t.remote;r.slowAfter=()=>40;
  try {const start=performance.now();const data=await take(r.get(f.leaves[1],{}));check(data[0]===1,'rescue bytes');check(performance.now()-start<300,'early reassignment');check(t.calls.length===2&&t.calls[0].aborted,'old fetch cancelled before replacement');check(t.peak===1,'no duplicate concurrency outside budget');check(r.stats().endpoints[0].rescues===1,'rescue accounted');
   // Even a formerly excellent throughput estimate cannot repeatedly put the
   // next blocking leaf back on the stalled provider during its probation.
   [...r.endpoints.values()][0].rate=1e6;await take(r.get(f.leaves[2],{}));
   check(t.calls.at(-1).gateway.includes('p1'),'prefer healthy endpoint after rescue');
   ok('stalled demand rescued early; old request cancelled, CID verified and probation respected');}
  finally{r.close();}
 }
 {
  let original=0;
  const t=remoteFor(f,{providers:2,behavior:e=>e.gateway.includes('p0')?{ms:++original===1?500:8}:{ms:8,error:true}}),r=t.remote;r.slowAfter=()=>40;
  try {const data=await take(r.get(f.leaves[2],{}));check(data[0]===2&&t.calls.length===3,'fallback to original provider after failed speculative rescue');ok('failed alternate retains one ordinary attempt at original provider');}
  finally{r.close();}
 }
 {
  const t=remoteFor(f,{providers:2,behavior:e=>({ms:8,corrupt:e.gateway.includes('p0')})}),r=t.remote;
  try {const data=await take(r.get(f.leaves[3],{}));check(data[0]===3,'valid retry bytes');check(r.stats().endpoints[0].excluded,'corrupt provider excluded');ok('CID mismatch excludes provider before exposing bytes');}
  finally{r.close();}
 }
 {
  const t=remoteFor(f,{providers:2,behavior:()=>({ms:500})}),r=t.remote;r.slowAfter=()=>30;
  try {const c=new AbortController(),p=take(r.get(f.leaves[4],{signal:c.signal}));await until(()=>t.calls.length===2);c.abort();let error;try{await p;}catch(e){error=e;}await until(()=>!t.active);check(error?.code==='CANCELLED'&&r.jobs.size===0,'cancel rescued attempt');check(r.stats().endpoints.every(e=>e.active===0),'active slots released');ok('cancellation during rescue releases jobs and all endpoint slots');}
  finally{r.close();}
 }
 {
  let hang=true;const t=remoteFor(f,{behavior:()=>({ms:hang?500:8})}),r=t.remote;
  try {const c=new AbortController(),p=take(r.get(f.leaves[5],{signal:c.signal}));await delay(10);c.abort();try{await p;}catch{}await until(()=>!t.active);hang=false;check((await take(r.get(f.leaves[5],{})))[0]===5,'retry after cancellation');ok('subsequent load succeeds after cancellation');}
  finally{r.close();}
 }
 {
  const t=remoteFor(f,{preloadState:true,behavior:e=>({ms:e.cid===f.disk.toString()?120:8})}),r=t.remote;
  try {
   await r.openCid(f.publication.toString());await delay(100);
   const root=t.calls.find(c=>c.cid===f.disk.toString()),state=t.calls.filter(c=>f.leaves.some(cid=>cid.toString()===c.cid));
   check(state.some(c=>c.start<root.end),'state transfer overlaps disk open');check(state.length>0&&state.length*262144<=6*1024*1024,'bounded prefill before consumer');
   const {stream,size}=await r.openStateStream(),reader=stream.getReader();let read=0;
   for(;;){const {done,value}=await reader.read();if(done)break;for(let i=0;i<value.length;i++)check(value[i]===Math.floor((read+i)/262144),'state bytes/order');read+=value.length;}
   check(read===size&&read===48*262144,'full state exact length');check(!r.stateDownloads&&!r.readControllers.size,'stream completion releases lifecycle');
   check(t.calls.filter(c=>f.leaves.some(cid=>cid.toString()===c.cid)).length===48,'preloaded bytes reused without duplicate block requests');
   ok('state overlaps disk open, bounded prefill reused with exact ordered bytes');
  }finally{r.close();}
 }
 {
  const t=remoteFor(f,{preloadState:true,behavior:e=>({ms:e.cid===f.disk.toString()?10:15})}),r=t.remote;
  try {await r.openCid(f.publication.toString());await delay(20);r.cancel();await until(()=>!t.active);check(!r.pendingState&&r.jobs.size===0&&r.readControllers.size===0,'unused prefill cancelled');ok('cancel unused early stream releases downloads and requests');}
  finally{r.close();}
 }
 return {checks};
}
