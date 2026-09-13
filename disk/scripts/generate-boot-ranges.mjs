// Usage: node disk/scripts/generate-boot-ranges.mjs profile.json [minimum-utilization=0.75]
// Input: a prefetch-boot trace, {cid,trace}, or {diskRootCID,firstTouchUnits}.
// Output is a registry suitable for disk/web/boot-range-profiles.json; no downloads.
import {readFile} from 'node:fs/promises';
import {CID} from 'multiformats/cid';
import {selectBootRanges} from './range-profile.mjs';
const input=JSON.parse(await readFile(process.argv[2],'utf8'));
const cid=CID.parse(input.cid || input.diskRootCID || input.disk?.remote?.cid).toString();
let units=input.firstTouchUnits;
if(!units) {
    if(!Array.isArray(input.trace) || input.stats?.remote?.traceDropped || input.errors?.length)throw Error('A complete guest trace is required');
    units=[];
    for(const e of input.trace)if(e.type==='guest-read') {
        if(!Number.isSafeInteger(e.offset) || !Number.isSafeInteger(e.length) || e.offset<0 || e.length<=0 || !Number.isSafeInteger(e.offset+e.length) || e.offset+e.length>2**40)throw Error('Invalid guest read');
        for(let unit=Math.floor(e.offset/65536);unit<=Math.floor((e.offset+e.length-1)/65536);unit++)units.push(unit);
    }
}
const result=selectBootRanges(units,{minUtilization:Number(process.argv[3] || 0.75)});
const {details,rankSum,...profile}=result;
console.log(JSON.stringify([{version:1,cid,unitBytes:65536,...profile}],null,2));
console.error(JSON.stringify({rangeCount:details.length,...result}));
