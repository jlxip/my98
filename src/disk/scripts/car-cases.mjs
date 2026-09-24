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
            else if(options.cancel){const reader=streamInfo.stream.getReader();await reader.read();await reader.cancel();r.cancel();await until(()=>carActive===0&&rawActive===0);check(r.carActive===0&&r.readControllers.size===0&&r.stateDownloads===0,'cancel leaked state requests');}
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
    return {checks};
}
