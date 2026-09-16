export const RANGE_SLOTS = 32;

// Profiles are hints for one immutable file, never authority for its contents.
export function matchingRanges(profile, cid, units) {
    if(typeof cid!=='string' || !cid || !profile || profile.version!==1 || profile.cid!==cid || profile.unitBytes!==65536 ||
       !Array.isArray(profile.ranges) || profile.ranges.length!==RANGE_SLOTS) return undefined;
    const ranges=[];
    for(const range of profile.ranges) {
        if(range===null)continue;
        if(!Array.isArray(range) || range.length!==2 || !range.every(Number.isSafeInteger) ||
           range[0]<0 || range[1]<range[0] || range[1]>=units) return undefined;
        ranges.push(range.slice());
    }
    const sorted=ranges.slice().sort((a,b)=>a[0]-b[0]);
    if(sorted.some((r,i)=>i && sorted[i-1][1]>=r[0]))return undefined;
    return ranges;
}

export class RangePrefetchOrder {
    constructor(ranges, coverage) {
        this.ranges=ranges;this.coverage=coverage;this.seen=new Uint8Array(coverage.length);
        this.active=0;this.cursor=ranges[0]?.[0] || 0;
    }
    observe(offset, length) {
        const first=Math.floor(offset/65536),last=Math.min(this.seen.length-1,Math.floor((offset+length-1)/65536));
        for(let unit=first;unit<=last;unit++) {
            if(this.seen[unit])continue;
            this.seen[unit]=1;
            const index=this.ranges.findIndex(([start,end])=>unit>=start && unit<=end);
            if(index<0)continue;
            this.active=index;
            const [start,end]=this.ranges[index];this.cursor=unit===end?start:unit+1;
        }
    }
    next() {
        const scan=(index,cursor)=>{
            const [start,end]=this.ranges[index],length=end-start+1;
            for(let n=0;n<length;n++) {
                const unit=start+(cursor-start+n)%length;
                if(!this.coverage[unit]) {
                    this.active=index;this.cursor=unit===end?start:unit+1;return unit;
                }
            }
            return -1;
        };
        if(this.ranges.length) {
            const next=scan(this.active,this.cursor);
            if(next>=0)return next;
        }
        // Ranges are stored by first observed use, not by their position on disk.
        for(let i=0;i<this.ranges.length;i++) {
            const next=scan(i,this.ranges[i][0]);
            if(next>=0)return next;
        }
        return -1; // RemoteDisk then continues its normal full-file download.
    }
    stats() {
        let units=0,completed=0;
        for(const [start,end] of this.ranges)for(let i=start;i<=end;i++){units++;completed+=this.coverage[i];}
        return {ranges:this.ranges.length,units,completedUnits:completed};
    }
}
