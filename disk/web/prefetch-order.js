// Experimental, disk-independent orders. State is bounded by file units plus four streams.
export const adaptivePolicies = ['fresh-demand', 'nearby', 'streams'];
export class AdaptivePrefetchOrder {
    constructor(policy, coverage) {
        this.policy=policy;this.coverage=coverage;
        this.seen=new Uint8Array(coverage.length);
        this.cursor=0;this.anchor=-1;this.streams=[];this.turn=0;
    }
    // Observe guest requests only: internal source reads and repeated metadata must not steer it.
    observe(offset, length) {
        const first=Math.floor(offset/65536),last=Math.min(this.seen.length-1,Math.floor((offset+length-1)/65536));
        for(let unit=first;unit<=last;unit++) {
            if(this.seen[unit])continue;
            this.seen[unit]=1;this.anchor=unit;this.cursor=(unit+1)%this.seen.length;
            if(this.policy==='streams') {
                let match=-1,distance=17;
                for(let i=0;i<this.streams.length;i++) {
                    const delta=unit-this.streams[i];
                    if(delta>0 && delta<distance){match=i;distance=delta;}
                }
                if(match>=0)this.streams.splice(match,1);
                this.streams.unshift(unit);this.streams.length=Math.min(4,this.streams.length);
                this.turn=0;
            }
        }
    }
    next() {
        const available=i=>i>=0 && i<this.coverage.length && !this.coverage[i];
        if(this.policy==='nearby' && this.anchor>=0) {
            for(let distance=1;distance<=16;distance++) {
                if(available(this.anchor+distance))return this.anchor+distance;
                if(available(this.anchor-distance))return this.anchor-distance;
            }
        }
        if(this.policy==='streams') {
            for(let i=0;i<this.streams.length;i++) {
                const stream=(this.turn+i)%this.streams.length;
                for(let distance=1;distance<=16;distance++) {
                    const unit=this.streams[stream]+distance;
                    if(available(unit)){this.turn=(stream+1)%this.streams.length;return unit;}
                }
            }
        }
        // Exhaust the entire file even if no guest reads arrive or all windows are resident.
        for(let i=0;i<this.coverage.length;i++) {
            const unit=(this.cursor+i)%this.coverage.length;
            if(available(unit)){this.cursor=(unit+1)%this.coverage.length;return unit;}
        }
        return -1;
    }
}
