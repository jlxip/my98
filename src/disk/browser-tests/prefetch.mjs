import {AdaptivePrefetchOrder, adaptivePolicies} from '../web/prefetch-order.js';
import {matchingRanges,RangePrefetchOrder} from '../web/range-prefetch.js';
import {RemoteDisk} from '../web/remote.js';
import {CID} from 'multiformats/cid';
import {sha256} from 'multiformats/hashes/sha2';

const HEADER=198,RECORD=65598;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=5000) {
    const start=performance.now();
    while(!await fn()) {if(performance.now()-start>timeout)throw Error('Condition timed out');await delay(5);}
}
async function synthetic({units=12,blockSize=4*RECORD,latency=10,prefetch={concurrency:2,trace:true}}={}) {
    const size=HEADER+units*RECORD-13,source=new Uint8Array(size),blocks=[],byKey=new Map();
    for(let i=0;i<size;i++)source[i]=(i*17+Math.floor(i/65536))%251;
    for(let offset=0;offset<size;offset+=blockSize) {
        const bytes=source.slice(offset,offset+blockSize),cid=CID.createV1(0x55,await sha256.digest(bytes));
        blocks.push({cid,offset,bytes});byKey.set(cid.toString(),bytes);
    }
    const remote=new RemoteDisk({prefetch});
    let mode='ok',calls=0,active=0,peak=0;
    remote.request=async(path,type,limit,signal)=>{
        calls++;active++;peak=Math.max(peak,active);
        try {
            const current=mode;
            await new Promise((resolve,reject)=>{
                const finish=()=>{signal?.removeEventListener('abort',abort);resolve();};
                const timer=setTimeout(finish,latency);
                const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(Object.assign(Error('Cancelled'),{code:'CANCELLED'}));};
                if(current!=='late'){signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();}
            });
            if(current==='error')throw Object.assign(Error('Network unavailable'),{code:'IO_ERROR'});
            const data=byKey.get(path.split('/')[2].split('?')[0]).slice();
            if(current==='corrupt')data[0]^=1;
            return data;
        }finally{active--;}
    };
    remote.size=size;
    remote.entry={async *content({offset,length,...options}) {
        const start=Number(offset),end=start+Number(length);
        for(const block of blocks) {
            if(block.offset>=end)break;
            if(block.offset+block.bytes.length<=start)continue;
            for await(const bytes of remote.get(block.cid,options))yield bytes.subarray(Math.max(0,start-block.offset),Math.min(bytes.length,end-block.offset));
        }
    }};
    // Production authenticates this header before it starts prefetching.
    await remote.read(0,HEADER);
    return {remote,source,blocks,setMode:value=>{mode=value;},metrics:()=>({calls,active,peak})};
}
export async function runPrefetch() {
    const checks=[],check=(name,value)=>{if(!value)throw Error(name);checks.push(name);};
    const rejects=async(fn,code)=>{try{await fn();}catch(e){if(e.code===code)return;throw e;}throw Error('Expected '+code);};
    for(const policy of ['auto','sequential','demand','head-demand','ranges',...adaptivePolicies])for(const concurrency of [1,2]) {
        const f=await synthetic({prefetch:{policy,concurrency}}),r=f.remote;
        try {
            r.startPrefetch();await until(()=>r.prefetchState==='complete');
            check(policy+concurrency+' complete without guest reads',r.stats().coveredBytes===r.size && r.stats().completedUnits===12);
            const calls=f.metrics().calls;f.setMode('error');
            check(policy+concurrency+' offline full content',(await r.read(0,r.size)).every((b,i)=>b===f.source[i])&&f.metrics().calls===calls);
        }finally{r.close();}
    }
    {
        const f=await synthetic({units:544,latency:0,prefetch:{enabled:false}}),r=f.remote;
        try {
            await r.read(0,r.size);const calls=f.metrics().calls;
            await r.read(0,512);
            check('retains more than 32 MiB with no re-fetch',r.cacheBytes>32*1048576&&f.metrics().calls===calls);
        }finally{r.close();}
    }
    {
        const f=await synthetic({blockSize:RECORD,latency:80,prefetch:{enabled:false,concurrency:2,trace:true}}),r=f.remote;
        try {
            const offset=3*RECORD,calls=f.metrics().calls;
            const background=r.read(offset,100,undefined,'background');
            await until(()=>f.metrics().active===1);
            const controller=new AbortController(),demand=r.read(offset,100,controller.signal);
            controller.abort();await rejects(()=>demand,'CANCELLED');await background;
            check('promotes and shares in-flight CID without aborting other reader',f.metrics().calls===calls+1&&r.trace.some(e=>e.type==='promote'));
        }finally{r.close();}
    }
    for(const concurrency of [1,2]) {
        const f=await synthetic({blockSize:RECORD,latency:60,prefetch:{enabled:false,concurrency,trace:true}}),r=f.remote;
        try {
            r.trace=[];
            const bg=r.read(2*RECORD,10,undefined,'background');
            await until(()=>f.metrics().active===1);
            const a=r.read(3*RECORD,10),b=r.read(4*RECORD,10),queued=r.read(5*RECORD,10,undefined,'background');
            await Promise.all([bg,a,b,queued]);
            const starts=r.trace.filter(e=>e.type==='fetch-start');
            check('demand precedes queued speculation, concurrency '+concurrency,starts.map(e=>e.priority).join()==='background,demand,demand,background'&&f.metrics().peak<=concurrency);
        }finally{r.close();}
    }
    {
        const f=await synthetic(),r=f.remote;
        try {
            f.setMode('error');r.startPrefetch();await until(()=>r.prefetchState==='paused');
            check('background failure is observable and pauses',r.stats().prefetchError.code==='IO_ERROR');
            f.setMode('ok');await r.read(8*RECORD,100);await until(()=>r.prefetchState==='complete');
            check('successful demand resumes failed background work',!r.prefetchError);
            r.clearCache();await delay(50);const calls=f.metrics().calls;
            check('clear stops and empties download',r.cacheBytes===0&&r.prefetchState==='stopped');
            await delay(50);check('clear remains stopped',f.metrics().calls===calls);
            r.startPrefetch();await until(()=>r.prefetchState==='complete');check('explicit resume fills again',r.cacheBytes>0);
        }finally{r.close();}
    }
    {
        const f=await synthetic(),r=f.remote;
        try {
            f.setMode('corrupt');r.startPrefetch();await until(()=>r.prefetchState==='paused');
            const bytes=r.cacheBytes;
            await rejects(()=>r.read(8*RECORD,10),'CORRUPTION');
            check('corrupt speculative and demand bytes are never retained',r.cacheBytes===bytes&&r.prefetchError.code==='CORRUPTION');
        }finally{r.close();}
    }
    for(const action of ['clearCache','close']) {
        const f=await synthetic({latency:60}),r=f.remote;
        f.setMode('late');r.startPrefetch();await until(()=>f.metrics().active>0);
        r[action]();await delay(150);
        check(action+' discards late responses and completes pending tasks',r.cacheBytes===0&&r.jobs.size===0&&!r.prefetchLoop);
        r.close();
    }
    {
        const f=await synthetic({units:1,blockSize:HEADER,latency:0}),r=f.remote;
        try {
            r.clearCache();r.startPrefetch();await until(()=>r.prefetchState==='complete');
            const calls=f.metrics().calls;f.setMode('error');
            check('resume restores separately stored header',(await r.read(0,HEADER)).every((b,i)=>b===f.source[i])&&f.metrics().calls===calls);
        }finally{r.close();}
    }
    {
        const f=await synthetic({units:40,latency:0,prefetch:{policy:'head-demand',concurrency:2,trace:true}}),r=f.remote;
        try {
            r.startPrefetch();r.noteDemand(30*65536,1);
            await until(()=>r.prefetchState==='complete');
            const reads=r.trace.filter(e=>e.type==='read'&&e.priority==='background'&&e.offset>=HEADER);
            check('bootstrap preserves latest guest demand for subsequent read-ahead',reads[16].offset===HEADER+31*RECORD);
        }finally{r.close();}
    }
    for(const policy of adaptivePolicies) {
        const coverage=new Uint8Array(100),order=new AdaptivePrefetchOrder(policy,coverage);
        order.observe(30*65536,1);order.observe(70*65536,1);order.observe(30*65536,1);
        check(policy+' ignores repeated guest units',order.anchor===70);
        coverage[71]=1;
        check(policy+' skips resident predictions',order.next()!==71);
        let count=0;
        for(let unit;(unit=order.next())>=0;) {coverage[unit]=1;if(++count>100)throw Error('No progress');}
        check(policy+' exhausts file after guest stops',coverage.every(Boolean));
    }
    {
        const nearby=new AdaptivePrefetchOrder('nearby',new Uint8Array(100));nearby.observe(50*65536,1);
        const first=nearby.next();nearby.coverage[first]=1;
        check('nearby explores both directions',first===51 && nearby.next()===49);
        const streams=new AdaptivePrefetchOrder('streams',new Uint8Array(100));
        streams.observe(20*65536,1);streams.observe(70*65536,1);
        check('streams alternates active sequences',streams.next()===71 && streams.next()===21);
        streams.observe(71*65536,1);
        check('streams extends existing sequence',streams.streams.length===2 && streams.streams[0]===71);
    }
    for(const concurrency of [1,2]) {
        const profile={version:1,cid:'synthetic',unitBytes:65536,ranges:[[8,9],[2,3],...Array(30).fill(null)]};
        const f=await synthetic({latency:2,prefetch:{policy:'ranges',concurrency,bootProfile:profile,trace:true}}),r=f.remote;
        r.remote={cid:'synthetic'};
        try {
            r.startPrefetch();await until(()=>r.prefetchState==='complete');
            const reads=r.trace.filter(e=>e.type==='prefetch-unit').map(e=>e.unit);
            check('range order then complete file, concurrency '+concurrency,reads.slice(0,4).join()==='8,9,2,3' && r.stats().completedUnits===12 && r.stats().rangeProfile.completedUnits===4);
            r.clearCache();check('clear removes range traversal state',!r.rangeOrder);
            r.startPrefetch();await until(()=>r.prefetchState==='complete');
            check('range resume rebuilds state and completes',r.stats().rangeProfile.completedUnits===4);
        }finally{r.close();}
    }
    {
        const profile={version:1,cid:'other',unitBytes:65536,ranges:[[8,9],...Array(31).fill(null)]};
        const f=await synthetic({prefetch:{policy:'ranges',bootProfile:profile,trace:true}}),r=f.remote;
        r.remote={cid:'synthetic'};
        try {
            r.startPrefetch();await until(()=>r.prefetchState==='complete');
            check('unmatched profile falls back to full demand order',!r.stats().rangeProfile && r.trace.find(e=>e.type==='prefetch-unit').unit===0);
        }finally{r.close();}
    }
    {
        const profile={version:1,cid:'synthetic',unitBytes:65536,ranges:[[8,9],...Array(31).fill(null)]};
        const f=await synthetic({prefetch:{bootProfile:profile,trace:true}}),r=f.remote;
        r.remote={cid:'synthetic'};
        try {
            r.startPrefetch();await until(()=>r.prefetchState==='complete');
            check('default automatically uses a matching profile',r.stats().policy==='ranges' && r.trace.find(e=>e.type==='prefetch-unit').unit===8);
            r.clearCache();r.remote={cid:'other'};r.startPrefetch();await until(()=>r.prefetchState==='complete');
            check('default falls back when profile does not match',r.stats().policy==='demand' && !r.rangeOrder);
        }finally{r.close();}
    }
    return checks;
}
