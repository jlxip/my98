import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CID} from 'multiformats/cid';
import {sha256} from 'multiformats/hashes/sha2';
import {validateLoadProfiles} from '../web/load-profiles.js';
import {BootAnalysis} from '../web/boot-analysis.js';
import {RemoteDisk} from '../web/remote.js';

const cid=CID.createV1(0x55,await sha256.digest(new Uint8Array([1]))).toString();
const profile=(origin={kind:'boot'})=>({version:2,cid,origin,unitBytes:65536,ranges:[[2,3],...Array(31).fill(null)]});
test('exact disk and origin, bounded non-overlapping ranges',()=>{
    const p=profile(),state=profile({kind:'state',sha256:'f'.repeat(64)});
    assert.deepEqual(validateLoadProfiles([p,state],cid,10),[p,state]);
    for(const bad of [null,{},[p,p],[{...p,version:1}],[{...p,cid:'wrong'}],[{...p,origin:{kind:'other'}}],
        [{...state,origin:{kind:'state',sha256:'bad'}}],[{...p,ranges:[[2,11],...Array(31).fill(null)]}],
        [{...p,ranges:[[2,3],[3,4],...Array(30).fill(null)]}],[{...p,observedUnits:-1}]]) {
        assert.throws(()=>validateLoadProfiles(bad,cid,10));
    }
});
test('same collector, independent origins and legacy export',()=>{
    for(const origin of [undefined,{kind:'boot'},{kind:'state',sha256:'a'.repeat(64)}]) {
        const analysis=new BootAnalysis(cid,65536*10,origin);
        analysis.observe(65536*2,1);analysis.observe(65536*3,1);analysis.observe(65536*2,1);
        const [p]=analysis.finish();assert.equal(p.version,origin?2:1);assert.equal(p.observedUnits,2);
        assert.deepEqual(p.origin,origin);assert.deepEqual(p.ranges[0],[2,3]);
    }
});
async function remote(value=[profile()]) {
    const data=new TextEncoder().encode(JSON.stringify(value));
    const profileCid=CID.createV1(0x55,await sha256.digest(data));
    const r=new RemoteDisk({gateway:'http://127.0.0.1:9999',prefetch:{enabled:false}});
    r.entry={};r.size=198+10*(65536+62);r.remote={cid};r.profilesCid=profileCid.toString();r.headerCovered=true;
    r.get=async function*(requested){assert.equal(requested.toString(),profileCid.toString());yield data;};
    r.reads=[];
    r.read=async function(offset,length,signal,priority){assert.equal(priority,'background');r.reads.push({offset,length});r.recordCoverage(offset,length);};
    return r;
}
async function done(r) {
    for(let n=0;n<200;n++) {await new Promise(resolve=>setTimeout(resolve,2));if(!r.prefetchLoop && r.load?.status!=='loading')return;}
    throw Error('prefetch did not settle');
}
test('profile only, then disk, reuses coverage and is idempotent',async()=>{
    const r=await remote();
    try {
        r.setLoadPrefetch({kind:'boot'},'profile');await done(r);
        assert.equal(r.completedUnits,2);assert.equal(r.stats().loadProfile.status,'complete');assert.equal(r.reads.length,2);
        r.setLoadPrefetch({kind:'boot'},'disk');await done(r);
        assert.equal(r.completedUnits,10);const count=r.reads.length;
        r.setLoadPrefetch({kind:'boot'},'disk');await done(r);assert.equal(r.reads.length,count);
    }finally{r.close();}
});
test('missing, mismatching and invalid hints remain optional',async()=>{
    for(const variant of ['missing','mismatch','invalid']) {
        const r=await remote(variant==='invalid'?[{...profile(),version:17}]:[profile()]);
        if(variant==='missing')r.profilesCid=undefined;
        try {
            r.setLoadPrefetch({kind:'state',sha256:'a'.repeat(64)},'profile');await done(r);
            assert.equal(r.stats().loadProfile.status,variant);assert.equal(r.completedUnits,0);
            r.setLoadPrefetch({kind:'state',sha256:'a'.repeat(64)},'disk');await done(r);assert.equal(r.completedUnits,10);
        }finally{r.close();}
    }
});
test('cancel, clear cache and origin change cannot revive stale profiles',async()=>{
    const r=await remote();
    try {
        r.setLoadPrefetch({kind:'boot'},'profile');r.cancel();
        r.startPrefetch();await done(r);assert.equal(r.completedUnits,2);
        r.clearCache();r.startPrefetch();await done(r);assert.equal(r.completedUnits,2);
        r.setLoadPrefetch({kind:'boot'},'none');r.setLoadPrefetch({kind:'state',sha256:'b'.repeat(64)},'profile');
        await done(r);assert.equal(r.load.status,'mismatch');assert.equal(r.rangeOrder,undefined);
    }finally{r.close();}
});
