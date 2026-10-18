import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateLoadProfiles} from '../web/load-profiles.js';
import {BootAnalysis} from '../web/boot-analysis.js';

const infoHash='1'.repeat(40);
const profile=(origin={kind:'boot'})=>({version:2,infoHash,origin,unitBytes:65536,ranges:[[2,3],...Array(31).fill(null)]});
test('exact disk and origin, bounded non-overlapping ranges',()=>{
    const p=profile(),state=profile({kind:'state',sha256:'f'.repeat(64)});
    assert.deepEqual(validateLoadProfiles([p,state],infoHash,10),[p,state]);
    for(const bad of [null,{},[p,p],[{...p,version:1}],[{...p,infoHash:'wrong'}],[{...p,origin:{kind:'other'}}],
        [{...state,origin:{kind:'state',sha256:'bad'}}],[{...p,ranges:[[2,11],...Array(31).fill(null)]}],
        [{...p,ranges:[[2,3],[3,4],...Array(30).fill(null)]}],[{...p,observedUnits:-1}]]) {
        assert.throws(()=>validateLoadProfiles(bad,infoHash,10));
    }
});
test('same collector, independent origins and legacy export',()=>{
    for(const origin of [undefined,{kind:'boot'},{kind:'state',sha256:'a'.repeat(64)}]) {
        const analysis=new BootAnalysis(infoHash,65536*10,origin);
        analysis.observe(65536*2,1);analysis.observe(65536*3,1);analysis.observe(65536*2,1);
        const [p]=analysis.finish();assert.equal(p.version,origin?2:1);assert.equal(p.observedUnits,2);
        assert.deepEqual(p.origin,origin);assert.deepEqual(p.ranges[0],[2,3]);
    }
});
