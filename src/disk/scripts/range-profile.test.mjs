import assert from 'node:assert/strict';
import {test} from 'node:test';
import {selectBootRanges} from './range-profile.mjs';
import {matchingRanges,RangePrefetchOrder} from '../web/range-prefetch.js';
const tupleBetter=(a,b)=>a[0]>b[0] || a[0]===b[0] && (a[1]<b[1] || a[1]===b[1] && a[2]<b[2]);
// Independent quadratic reference, used only on small random inputs.
function reference(input,percent) {
    const rank=new Map(input.map((v,i)=>[v,i])),u=[...rank.keys()].sort((a,b)=>a-b),n=u.length;
    let prev=Array.from({length:n+1},()=>[0,0,0]);
    for(let k=0;k<32;k++) {
        const cur=[[0,0,0]];
        for(let j=1;j<=n;j++) {
            cur[j]=cur[j-1];let ranks=0;
            for(let i=j-1;i>=0;i--) {
                ranks+=rank.get(u[i]);const span=u[j-1]-u[i]+1;
                if((j-i)*100<percent*span)continue;
                const candidate=[prev[i][0]+j-i,prev[i][1]+span,prev[i][2]+ranks];
                if(tupleBetter(candidate,cur[j]))cur[j]=candidate;
            }
        }
        prev=cur;
    }
    return prev[n];
}
test('exact optimizer agrees with independent reference, preserves density and ordering',()=>{
    let seed=123;
    const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
    for(let trial=0;trial<40;trial++) {
        let position=0;const input=Array.from({length:40+trial%15},()=>position+=1+random()%4);
        for(let i=input.length-1;i>0;i--){const j=random()%(i+1);[input[i],input[j]]=[input[j],input[i]];}
        const percent=[50,75,90,100][trial%4],r=selectBootRanges(input,{minUtilization:percent/100});
        assert.deepEqual([r.coveredUnits,r.downloadUnits,r.rankSum],reference(input,percent));
        assert.equal(r.ranges.length,32);assert.ok(r.details.every(d=>d.utilization>=percent/100));
        assert.ok(r.details.every((d,i)=>!i || d.firstUse>=r.details[i-1].firstUse));
        const occupied=r.ranges.filter(Boolean).slice().sort((a,b)=>a[0]-b[0]);
        assert.ok(occupied.every((r,i)=>!i || occupied[i-1][1]<r[0]));
    }
});
test('empty slots, repeats and sparse disks do not force wasteful ranges',()=>{
    assert.deepEqual(selectBootRanges([]).ranges,Array(32).fill(null));
    const sparse=selectBootRanges(Array.from({length:40},(_,i)=>i*1000));
    assert.equal(sparse.coveredUnits,32);assert.equal(sparse.downloadUnits,32);
    const few=selectBootRanges([8,9,8,10]);assert.equal(few.details.length,1);
    assert.deepEqual(few.ranges[0],[8,10]);assert.equal(few.ranges.filter(r=>r===null).length,31);
    assert.throws(()=>selectBootRanges([-1]));assert.throws(()=>selectBootRanges([0],{minUtilization:0}));
});
test('CID binding, bounds, overlaps and slot count are validated',()=>{
    const p={version:1,cid:'snapshot',unitBytes:65536,ranges:[[7,9],[1,3],...Array(30).fill(null)]};
    assert.deepEqual(matchingRanges(p,'snapshot',10),[[7,9],[1,3]]);
    for(const bad of [{...p,cid:'other'},{...p,unitBytes:512},{...p,ranges:[[0,1]]},{...p,ranges:[[1,4],[3,5],...Array(30).fill(null)]},{...p,ranges:[[1,10],...Array(31).fill(null)]}])assert.equal(matchingRanges(bad,'snapshot',10),undefined);
});
test('range order follows new demand, skips resident units and ends without covering unrelated data',()=>{
    const c=new Uint8Array(100),r=new RangePrefetchOrder([[70,72],[20,22]],c);
    assert.equal(r.next(),70);c[70]=1;
    r.observe(20*65536,1);assert.equal(r.next(),21);c[21]=1;
    r.observe(71*65536,1);r.observe(20*65536,1);assert.equal(r.next(),72);c[72]=1;
    for(let unit;(unit=r.next())>=0;)c[unit]=1;
    assert.equal(c.reduce((a,b)=>a+b,0),6);assert.deepEqual(r.stats(),{ranges:2,units:6,completedUnits:6});
});
