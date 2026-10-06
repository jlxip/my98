import {RemoteDisk} from '../web/remote.js';
import {carBytes,carFixture} from './car-fixture.mjs';
const check=(value,label)=>{if(!value)throw Error(label);};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){const end=Date.now()+3000;while(!fn()){if(Date.now()>end)throw Error('condition timed out');await delay(5);}}
const collect=async stream=>{const parts=[];let size=0;for await(const b of stream){parts.push(b);size+=b.length;}const bytes=new Uint8Array(size);let n=0;for(const b of parts){bytes.set(b,n);n+=b.length;}return bytes;};
export async function runCarCases() {
    const native=globalThis.fetch,checks=[];
    async function run(label,options={}) {
        const f=await carFixture(options),r=new RemoteDisk({gateway:'https://one.example',prefetch:{enabled:false,trace:true,concurrency:options.concurrency||8},timeoutMs:options.stall?100:3000,stateTransport:options.blocks?'blocks':'auto'});
        if(options.second)r.addEndpoint('https://two.example');
        if(options.late){r.discovery.state='running';setTimeout(()=>{r.addEndpoint('https://two.example');r.discovery.state='complete';},25);}
        r.stateCid=f.cid.toString();
        let requests=0,carActive=0,rawActive=0,peak=0,cancelled=0,wire=0;
        const calls=[];const observe=()=>{peak=Math.max(peak,carActive+rawActive);check(carActive+rawActive<=r.concurrency,'shared data concurrency exceeded');};
        r.request=async(path,type,limit,signal,gateway)=>{rawActive++;observe();try{check(!signal?.aborted,'raw cancelled');await delay(1);const cid=path.split('/')[2].split('?')[0];return f.blocks.get(cid).slice();}finally{rawActive--;}};
        globalThis.fetch=async(url,opts)=>{
            requests++;carActive++;observe();let active=true;
            const finish=()=>{if(active){active=false;carActive--;}};
            const parsed=new URL(url),[offset,end]=parsed.searchParams.get('entity-bytes').split(':').map(Number);calls.push({url:String(url),offset});
            const bad=(options.second||options.late)&&parsed.hostname==='one.example';
            if(options.unsupported||bad){finish();return new Response('unsupported',{status:406});}
            if(options.stall){
                return new Promise((resolve,reject)=>{const abort=()=>{finish();reject(Error('aborted'));};opts.signal.addEventListener('abort',abort,{once:true});if(opts.signal.aborted)abort();});
            }
            let bytes=carBytes(f.blocks,f.cid,options.ignoreRange?0:offset,options.ignoreRange?f.size:end-offset+1);
            if(options.oversize)bytes=new Uint8Array([0x81,0x80,0x04]);
            if(options.corruptRoot){bytes=bytes.slice();bytes[120]^=1;}
            if(options.corrupt&&offset===0){bytes=bytes.slice();bytes[bytes.length-20]^=1;}
            if(options.truncate&&offset===0)bytes=bytes.subarray(0,bytes.length-17);
            if(options.trailing)bytes=new Uint8Array([...bytes,1,0]);
            let pos=0;const step=32768;
            const stream=new ReadableStream({async pull(output){
                if(options.slow)await delay(2);
                if(opts.signal.aborted){finish();output.error(Error('aborted'));return;}
                if(pos===bytes.length){finish();output.close();return;}
                const next=Math.min(bytes.length,pos+step);wire+=next-pos;output.enqueue(bytes.slice(pos,next));pos=next;
            },cancel(){cancelled++;finish();}},new ByteLengthQueuingStrategy({highWaterMark:step}));
            return new Response(stream,{headers:{'Content-Type':'application/vnd.ipld.car'}});
        };
        try {
            const streamInfo=await r.openStateStream();
            if(options.demand){const pending=collect(streamInfo.stream);await until(()=>r.carActive>0);await Promise.all(f.leaves.slice(0,12).map(async leaf=>{for await(const ignored of r.get(leaf.cid)){};}));const bytes=await pending;check(bytes.length===f.size&&bytes.every((x,i)=>x===f.bytes[i]),'concurrent demand changed state');check(peak>4&&peak<=8,'shared budget not exercised');}
            else if(options.cancel){const reader=streamInfo.stream.getReader();await reader.read();await reader.cancel();r.cancel();await until(()=>carActive===0&&rawActive===0&&r.carActive===0&&r.stateDownloads===0);check(r.carActive===0&&r.readControllers.size===0&&r.stateDownloads===0,'cancel leaked state requests');}
            else if(options.backpressure){await delay(100);check(wire<5*1048576,'unconsumed CAR download unbounded');await streamInfo.stream.cancel();r.cancel();await until(()=>!carActive&&!rawActive);}
            else {
                const bytes=await collect(streamInfo.stream);check(bytes.length===f.bytes.length&&bytes.every((x,i)=>x===f.bytes[i]),label+' bytes mismatch');
                await until(()=>!carActive&&!rawActive);check(!r.carActive&&!r.readControllers.size&&!r.stateDownloads,'completion leaked lifecycle');
                const stats=r.stats().stateTransport;
                if(options.unsupported||options.corrupt||options.truncate||options.trailing||options.ignoreRange||options.stall||options.corruptRoot||options.oversize)check(stats.fallback,label+' did not fall back');
                else if(!options.blocks&&options.concurrency!==1)check(stats.mode==='car'&&!stats.fallback,'CAR not used');
                if(options.corrupt||options.truncate)check(stats.fallbackAt>0,'verified prefix not retained');
                if(options.second||options.late)check(stats.gateway==='https://two.example','did not choose supporting provider');
                if(options.blocks||options.concurrency===1)check(requests===0,'disabled CAR was requested');
            }
            checks.push({label,carRequests:requests,peak,state:r.stats().stateTransport,cancelled});
        } finally {r.close();globalThis.fetch=native;}
    }
    await run('four streams, shared budget and exact state');
    await run('CAR and demand share the eight-slot limit',{demand:true,slow:true});
    await run('nested DAG with inline data',{nested:true,inline:true});
    await run('protobuf leaves and repeated CIDs',{protobuf:true,duplicate:true});
    await run('unsupported CAR falls back',{unsupported:true});
    await run('later corrupt leaf resumes verified prefix',{corrupt:true,slow:true});
    await run('truncated CAR resumes verified prefix',{truncate:true,slow:true});
    await run('ignored ranges cannot reorder state',{ignoreRange:true});
    await run('trailing CAR data rejected',{trailing:true});
    await run('wrong root proof rejected before output',{corruptRoot:true});
    await run('oversized CAR header rejected before allocation',{oversize:true});
    await run('stalled capability bounded and raw fallback',{stall:true});
    await run('second authorized provider selected',{second:true});
    await run('provider discovered during capability selection',{late:true});
    await run('cancel releases streams and slots',{cancel:true,slow:true});
    await run('backpressure bounds speculative data',{backpressure:true,slow:true});
    await run('explicit block transport remains available',{blocks:true});
    await run('single-slot budget uses raw',{concurrency:1});
    checks.push(...await runPrefixCases());
    return {checks};
}

async function runPrefixCases(){
 const checks=[];const native=globalThis.fetch;
 for(const opts of [{label:'early slow versus sustained fast',two:true},{label:'late fast provider',late:true},{label:'one provider skips prefix'},{label:'small range completes immediately',two:true,count:4},{label:'cancel during prefix',two:true,cancel:true},{label:'deduplicated endpoint',two:true,duplicate:true},{label:'sustained low throughput retains CAR',two:true,slow:true,count:8},{label:'prefix delivered while next leaf is pending',two:true,drip:true,count:8},{label:'incompatible alternative leaves sole provider',two:true,unsupported:true},{label:'Discovery ends with sole provider',ending:true},{label:'late healthy prefix with completed Discovery',boundary:true,count:8},{label:'late healthy prefix survives global deadline',boundary:true,keepDiscovery:true,count:8},{label:'cancel selected prefix with pending leaf',two:true,drip:true,count:8,cancelPending:true},{label:'two-probe backpressure plateaus',two:true,backpressure:true,count:96},{label:'single CAR slot skips additional sampling',two:true,concurrency:2},{label:'two CAR slots compare prefix',two:true,concurrency:3}]){
  const f=await carFixture({count:opts.count||24}),r=new RemoteDisk({gateway:'https://one.example',prefetch:{enabled:false,concurrency:opts.concurrency||8,trace:true},timeoutMs:30000});
  if(opts.boundary){r.discovery.state='running';setTimeout(()=>{r.addEndpoint('https://two.example');if(!opts.keepDiscovery)r.discovery.state='complete';},2100);}
  if(opts.ending){r.discovery.state='running';setTimeout(()=>{r.discovery.state='complete';},30);}
  if(opts.two)r.addEndpoint('https://two.example');if(opts.duplicate)r.addEndpoint('https://two.example');
  if(opts.late){r.discovery.state='running';setTimeout(()=>{r.addEndpoint('https://two.example');r.discovery.state='complete';},25);}
  r.stateCid=f.cid.toString();r.request=async p=>f.blocks.get(p.split('/')[2].split('?')[0]).slice();
  const calls=[],firstPayload={},wire={};let active=0;
  globalThis.fetch=async(url,options)=>{
   const u=new URL(url),[offset,end]=u.searchParams.get('entity-bytes').split(':').map(Number),host=u.hostname;
   calls.push({host,offset});wire[host]??=0;active++;let closed=false;const close=()=>{if(!closed){closed=true;active--;}};
   options.signal.addEventListener('abort',close,{once:true});
   if(opts.boundary&&host==='one.example')return new Promise((resolve,reject)=>{options.signal.addEventListener('abort',()=>{close();reject(Error('aborted'));},{once:true});});
   if(host==='two.example')await delay(opts.slow||opts.drip||opts.boundary?0:opts.unsupported?20:200);
   if(opts.unsupported&&host==='two.example'){close();return new Response('unsupported',{status:406});}
   if(options.signal.aborted){close();throw Error('aborted');}
   const bytes=carBytes(f.blocks,f.cid,offset,end-offset+1);let n=0;
   return new Response(new ReadableStream({async pull(c){await delay(opts.slow?125:opts.drip||opts.boundary?(n<294912?30:375):host==='one.example'?20:1);if(options.signal.aborted){close();c.error(Error('aborted'));return;}if(n===bytes.length){close();c.close();return;}const next=Math.min(bytes.length,n+32768);wire[host]+=next-n;c.enqueue(bytes.slice(n,next));n=next;if(n>=262144&&!firstPayload[host])firstPayload[host]=performance.now();},cancel(){close();}},{highWaterMark:0}),{headers:{'content-type':'application/vnd.ipld.car'}});
  };
  try{
   const t=performance.now(),info=await r.openStateStream(),reader=info.stream.getReader();
   if(opts.cancel||opts.cancelPending){if(opts.cancelPending){const first=await reader.read();check(!first.done&&first.value.length>0,'no selected prefix');check(r.stats().stateTransport.mode==='car','pending cancellation was not CAR');}else await delay(20);await reader.cancel();r.cancel();const deadline=performance.now()+500;while(active||r.carActive||r.stateDownloads||r.readControllers.size){check(performance.now()<deadline,'cancel leaked leases');await delay(5);}}
   else if(opts.backpressure){
    await delay(1000);const plateau=Object.values(wire).reduce((a,b)=>a+b,0);await delay(100);
    check(Object.values(wire).reduce((a,b)=>a+b,0)===plateau,'two-probe network did not plateau');check(plateau<10*1048576,'prefix buffering exceeded budget');
    await reader.cancel();r.cancel();const deadline=performance.now()+500;while(active||r.carActive||r.stateDownloads||r.readControllers.size){check(performance.now()<deadline,'backpressure cancel leaked');await delay(5);}
   }
   else{
    const parts=[];let len=0,first;
    for(;;){const v=await reader.read();if(v.done)break;first??=performance.now()-t;parts.push(v.value);len+=v.value.length;}
    check(len===f.size,'length duplicated or truncated');let p=0;for(const b of parts){check(b.every((v,i)=>v===f.bytes[p+i]),'bytes changed or repeated');p+=b.length;}
    const stats=r.stats().stateTransport;
    check(stats.mode==='car'&&!stats.fallback,'valid slow source discarded: '+opts.label);
    if((opts.two||opts.late)&&!opts.slow&&!opts.drip&&!opts.unsupported&&opts.concurrency!==2){check(stats.gateway==='https://two.example',opts.label+': first-payload slow source won '+JSON.stringify({gateway:stats.gateway,firstPayload,wire}));check(firstPayload['one.example']<firstPayload['two.example'],'heterogeneous fixture failed to deliver one first');}
    else if(opts.boundary){check(first<2650,'late verified prefix discarded or delayed');check(stats.gateway==='https://two.example','late provider not used');if(opts.keepDiscovery){const probe=r.trace.find(e=>e.type==='car-probe-prefix'&&e.gateway==='https://two.example');check(probe?.target===1048576&&probe.bytes>0&&probe.bytes<probe.target,'late case did not exercise partial-prefix closure');}}
    else if(opts.slow)check(first<1600,'slow provider waited for full prefix');
    else if(opts.drip)check(first<1100,'pending next leaf delayed verified prefix');
    else check(first<250,'sole provider waited for prefix');
    check(first<(opts.boundary?2650:2500),'fixed selection wait');
    const same=calls.filter(c=>c.offset===0);check(new Set(same.map(c=>c.host)).size===same.length,'provider tried twice');
    checks.push({label:opts.label,firstMs:first,gateway:stats.gateway,wire,requests:calls});
   }
  }finally{r.close();globalThis.fetch=native;}
  if(opts.cancel||opts.cancelPending||opts.backpressure)checks.push({label:opts.label,active,leases:r.carActive,wire});
 }
 return checks;
}
