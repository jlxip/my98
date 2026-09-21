import {Slop86Disk,DiskBuffer} from '/build/disk/web/client.js';
export async function runRemote(fixture) {
    const checks=[],check=(name,value)=>{if(!value)throw Error(name);checks.push(name);};
    const hex=b=>Array.from(b,v=>v.toString(16).padStart(2,'0')).join('');
    const rejects=async(name,fn,code)=>{try{await fn();}catch(e){check(name,!code||e.code===code);return;}throw Error(name+' did not reject');};
    const mode=window.setGatewayMode;
    const make=async()=>{const c=await Slop86Disk.create();await c.unlock('disk fixtures','public compatibility password','main');return c;};
    let c;
    try {
        for(const flavor of ['kubo','v1','path']) {
            await mode(flavor);c=await make();const state=await c.openRemote({onlyLocalhost:true,gateway:fixture.endpoint,prefetch:{enabled:false}});
            check(flavor+' exact image size',state.size===fixture.small.size);
            check(flavor+' header-only open',(await c.readStats()).readBytes===198);
            check(flavor+' full native hash',hex(await c.verifyImage())===fixture.small.sha256);
            await c.close();c=undefined;
        }
        await mode('small');c=await make();await c.openRemote({onlyLocalhost:true,gateway:fixture.endpoint,prefetch:{enabled:false}});
        const plain=new Uint8Array(await(await fetch('/'+fixture.small.source)).arrayBuffer());
        check('cross-record range exact',hex(await c.read(65533,12))===hex(plain.slice(65533,65545)));
        const first=await c.readStats();await c.read(65533,12);check('repeat read uses cache',(await c.readStats()).networkRequests===first.networkRequests);
        await mode('v1');check('IPNS change does not change open CID',(await c.describe()).remote.cid===fixture.cid0);
        await c.clearCaches();await mode('missing');
        await c.write(512,new Uint8Array(512).fill(7));
        await rejects('failed partial write',()=>c.write(65535,new Uint8Array([1,2,3])),'IO_ERROR');
        check('failed write preserves previous overlay',(await c.describe()).dirty_sectors===1);
        let stopped=0;const order=[],ram=new Uint8Array([4,5,6]);
        const adapter=new DiskBuffer(c,plain.length,async()=>{stopped++;});
        adapter.get(0,1,b=>{check('retried remote byte exact',b[0]===plain[0]);order.push('read');});
        adapter.set(5,new Uint8Array([99]),()=>order.push('write'));
        while(!adapter.failed)await new Promise(r=>setTimeout(r,5));
        check('network failure stops callbacks',stopped===1&&order.length===0);
        await mode('small');await adapter.retry();
        check('retry callbacks ordered once',order.join()==='read,write'&&ram.join()==='4,5,6');adapter.dispose();
        // Corruption excludes the endpoint for its entire session. Isolate each fault
        // from the live overlay used by the cancellation and save checks below.
        for(const flavor of ['corrupt','truncated']) {
            await mode('small');const broken=await make();
            try {
                await broken.openRemote({onlyLocalhost:true,gateway:fixture.endpoint,prefetch:{enabled:false}});
                await broken.clearCaches();await mode(flavor);
                await rejects(flavor+' block rejected',()=>broken.read(2*65536,1),'CORRUPTION');
                await mode('small');await rejects(flavor+' gateway remains excluded',()=>broken.read(2*65536,1),'IO_ERROR');
            }finally{await broken.close();}
        }
        await c.clearCaches();
        await mode('hang');const start=performance.now();const pending=c.read(2*65536,1);setTimeout(()=>c.cancel(),100);
        await rejects('cancel in-flight network',()=>pending,'CANCELLED');check('cancel returns promptly',performance.now()-start<3000);
        check('cancel preserves dirty sectors',(await c.describe()).dirty_sectors===2);
        await mode('small');await c.discardWrites();await c.clearCaches();
        await mode('hang');const timeout=performance.now();await rejects('network timeout',()=>c.read(0,1),'IO_ERROR');
        check('timeout bounded',performance.now()-timeout>=4900&&performance.now()-timeout<8000);
        await mode('small');check('read after timeout succeeds',(await c.read(0,1))[0]===plain[0]);
        const download=await c.downloadCurrent();
        window.remoteOriginal=download.blob;check('complete download has original length',download.size===fixture.small.encryptedSize);
        const expected=plain.slice();expected[17]=211;await c.write(17,new Uint8Array([211]));
        await c.clearCaches();await mode('missing');await rejects('failed save preserves source',()=>c.save(),'IO_ERROR');
        check('failed save preserves writes',(await c.describe()).dirty_bytes===512);
        await mode('small');const saved=await c.save();window.remoteSaved=saved.download.blob;
        check('save becomes local',!saved.remote&&saved.outcome==='created');
        check('saved output hash',hex(await c.verifyImage())===hex(new Uint8Array(await crypto.subtle.digest('SHA-256',expected))));
        check('retry reuses prepared download',(await c.retryDownload()).id===saved.download.id);
        await c.close();c=undefined;
        for(const flavor of ['expired','wrong','missing']) {
            await mode(flavor);c=await make();await rejects(flavor+' IPNS rejected',()=>c.openRemote({onlyLocalhost:true,gateway:fixture.endpoint,prefetch:{enabled:false}}),flavor==='missing'?'IO_ERROR':'CORRUPTION');
            check(flavor+' leaves identity without disk',await c.describe().then(()=>false,()=>true));await c.close();c=undefined;
        }
        await mode('large');c=await make();const started=performance.now();await c.openRemote({onlyLocalhost:true,gateway:fixture.endpoint,prefetch:{enabled:false}});await c.read(0,512);
        let stats=await c.readStats();const cold={...stats,milliseconds:performance.now()-started};
        check('1GiB opens lazily',stats.readBytes===65796&&stats.networkBytes<2*1048576);
        check('1GiB far tail direct access',(await c.read(1073741823,1))[0]===0);
        const before=(await c.readStats()).networkBytes;
        // Retain >32MiB, then revisit the first block without another request.
        for(let offset=0;offset<36*1048576;offset+=262144)await c.read(offset,1);
        stats=await c.readStats();check('blocks retained beyond former LRU limit',stats.blockCacheBytes>32*1048576&&stats.networkBytes-before>32*1048576);
        const requests=stats.networkRequests;await c.read(0,1);check('retained first block needs no network',(await c.readStats()).networkRequests===requests);
        await c.close();c=undefined;
        return {checks,cold};
    } finally {await c?.close().catch(()=>{});}
}
