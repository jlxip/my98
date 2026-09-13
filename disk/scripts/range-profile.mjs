import {RANGE_SLOTS} from '../web/range-prefetch.js';

const bound=(values,x,inclusive=false)=>{
    let lo=0,hi=values.length;
    while(lo<hi){const mid=(lo+hi)>>>1;if(values[mid]<x || inclusive && values[mid]===x)lo=mid+1;else hi=mid;}
    return lo;
};
const better=(hits,size,rank,otherHits,otherSize,otherRank)=>
    hits>otherHits || hits===otherHits && (size<otherSize || size===otherSize && rank<otherRank);

// At most 32 disjoint ranges, each above the utilization floor. Maximize distinct
// observed units covered, then minimize downloaded units, then prefer earlier reads.
// Exact dynamic programming with prefix maxima: O(32*n*log(n)), O(32*n) memory.
export function selectBootRanges(firstTouchUnits, {minUtilization=0.75}={}) {
    const percent=Math.round(minUtilization*100);
    if(!Number.isFinite(minUtilization) || percent<1 || percent>100 || Math.abs(percent/100-minUtilization)>1e-9)throw Error('Utilization must be a whole percentage from 1 to 100');
    const ranks=new Map();
    for(const unit of firstTouchUnits) {
        if(!Number.isSafeInteger(unit) || unit<0 || unit>=2**24)throw Error('Invalid 64 KiB unit');
        if(!ranks.has(unit))ranks.set(unit,ranks.size);
    }
    const units=[...ranks.keys()].sort((a,b)=>a-b),n=units.length;
    const rankPrefix=new Float64Array(n+1);
    for(let i=0;i<n;i++)rankPrefix[i+1]=rankPrefix[i]+ranks.get(units[i]);
    // Range [i,j) is valid iff 100*i-percent*units[i] <= 100*j-percent*(units[j-1]+1).
    const keys=units.map((unit,i)=>100*i-percent*unit),sorted=[...new Set(keys)].sort((a,b)=>a-b);
    const positions=keys.map(key=>bound(sorted,key)+1),choices=[];
    let hits=new Float64Array(n+1),size=new Float64Array(n+1),rank=new Float64Array(n+1);
    for(let slot=0;slot<RANGE_SLOTS;slot++) {
        const nextHits=new Float64Array(n+1),nextSize=new Float64Array(n+1),nextRank=new Float64Array(n+1);
        const pick=new Int32Array(n+1).fill(-1),tree=new Int32Array(sorted.length+1).fill(-1);
        const wins=(a,b)=>b<0 || better(hits[a]-a,size[a]-units[a],rank[a]-rankPrefix[a],hits[b]-b,size[b]-units[b],rank[b]-rankPrefix[b]);
        for(let j=1;j<=n;j++) {
            const i=j-1;
            for(let at=positions[i];at<tree.length;at+=at&-at)if(wins(i,tree[at]))tree[at]=i;
            let start=-1;
            for(let at=bound(sorted,100*j-percent*(units[j-1]+1),true);at>0;at-=at&-at) {
                if(tree[at]>=0 && wins(tree[at],start))start=tree[at];
            }
            nextHits[j]=nextHits[j-1];nextSize[j]=nextSize[j-1];nextRank[j]=nextRank[j-1];
            if(start>=0) {
                const h=hits[start]+j-start,s=size[start]+units[j-1]-units[start]+1,r=rank[start]+rankPrefix[j]-rankPrefix[start];
                if(better(h,s,r,nextHits[j],nextSize[j],nextRank[j])) {
                    nextHits[j]=h;nextSize[j]=s;nextRank[j]=r;pick[j]=start;
                }
            }
        }
        choices.push(pick);hits=nextHits;size=nextSize;rank=nextRank;
    }
    const selected=[];
    for(let slot=RANGE_SLOTS-1,j=n;slot>=0 && j>0;) {
        const start=choices[slot][j];
        if(start<0){j--;continue;}
        selected.push([units[start],units[j-1]]);slot--;j=start;
    }
    // Adjacent intervals are equivalent to their union; leave redundant slots empty.
    const merged=[];
    for(const range of selected.sort((a,b)=>a[0]-b[0])) {
        const last=merged.at(-1);
        if(last && last[1]+1===range[0])last[1]=range[1];else merged.push(range);
    }
    const details=merged.map(([start,end])=>{
        const observed=units.filter(unit=>unit>=start && unit<=end);
        return {start,end,used:observed.length,utilization:observed.length/(end-start+1),firstUse:observed.reduce((first,unit)=>Math.min(first,ranks.get(unit)),Infinity)};
    }).sort((a,b)=>a.firstUse-b.firstUse || a.start-b.start);
    return {ranges:[...details.map(r=>[r.start,r.end]),...Array(RANGE_SLOTS-details.length).fill(null)],
        minUtilization,observedUnits:n,coveredUnits:hits[n],downloadUnits:size[n],rankSum:rank[n],details};
}
