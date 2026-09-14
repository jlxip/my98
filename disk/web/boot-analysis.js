import {selectBootRanges} from '../scripts/range-profile.mjs';

export const MAX_ANALYSIS_UNITS = 200000;
const UNIT = 65536;
const fail = (code, message) => Object.assign(new Error(message), {code});

// Demand coordinates only: independent of caches, network traffic and writes.
export class BootAnalysis {
    constructor(cid, size) {
        this.cid = cid;
        this.size = size;
        this.units = new Set();
        this.recording = true;
    }
    observe(offset, length) {
        if(!this.recording || !length) return false;
        if(!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > this.size) return false;
        for(let unit = Math.floor(offset / UNIT); unit <= Math.floor((offset + length - 1) / UNIT); unit++) {
            if(this.units.has(unit)) continue;
            if(this.units.size === MAX_ANALYSIS_UNITS) {
                this.recording = false;
                this.overflow = true;
                return true;
            }
            this.units.add(unit);
        }
        return false;
    }
    finish() {
        this.recording = false;
        if(this.overflow) throw fail('ANALYSIS_INCOMPLETE', 'Analysis exceeded 200,000 distinct blocks. No partial profile was exported.');
        // Preserve the frozen set if generation throws, so retries use the same reads.
        const {details, rankSum, ...profile} = selectBootRanges([...this.units]);
        return [{version:1, cid:this.cid, unitBytes:UNIT, ...profile}];
    }
}
