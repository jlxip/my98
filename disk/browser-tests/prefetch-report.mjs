// Select only after three independent boots of every case have completed.
import {readFile} from 'node:fs/promises';
const rows=JSON.parse(await readFile(process.argv[2] || 'build/disk/prefetch/all-results.json','utf8'));
const policies=['sequential','demand','head-demand','fresh-demand','nearby','streams','ranges'];
const names=[...new Set(rows.map(r=>r.name))];
const median=xs=>xs.slice().sort((a,b)=>a-b)[1];
const table=names.map(name=>{
    const runs=rows.filter(r=>r.name===name);
    if(runs.length!==3 || new Set(runs.map(r=>r.run)).size!==3 || runs.some(r=>r.errors.length || r.stats.remote?.traceDropped))throw Error('Three successful, untruncated runs required for '+name);
    if(runs.some(r=>r.criterion!==rows[0].criterion))throw Error('Mixed desktop criteria');
    return {name,samplesMs:runs.map(r=>r.desktopMs),medianMs:median(runs.map(r=>r.desktopMs)),
        guestReadMedianMs:name==='local'?undefined:median(runs.map(r=>r.guestReadMs)),
        networkRequests:median(runs.map(r=>r.stats.networkRequests)),
        retainedBytesAtDesktop:median(runs.map(r=>r.stats.blockCacheBytes))};
});
const candidates=table.filter(r=>!['baseline','local'].includes(r.name)),best=Math.min(...candidates.map(r=>r.medianMs));
const eligible=candidates.filter(r=>r.medianMs<best*1.05);
eligible.sort((a,b)=>Number(a.name.split(':')[1])-Number(b.name.split(':')[1]) || policies.indexOf(a.name.split(':')[0])-policies.indexOf(b.name.split(':')[0]));
const selected=eligible[0],fastest=candidates.find(r=>r.medianMs===best);
const reference=table.find(r=>r.name==='baseline') || table.find(r=>r.name==='demand:2') || candidates[0];
console.log(JSON.stringify({criterion:rows[0].criterion,environment:'WebKit, isolated VM without audio or guest network; fresh client for each run; local IPFS with 150 ms response delay and shared 8 MiB/s bandwidth',
    selectionRule:'Lowest median of three runs; within 5% of fastest prefer fewer connections, then sequential, demand, head-demand, fresh-demand, nearby, streams, ranges',
    selected:selected.name,reference:reference.name,improvementPercent:100*(1-selected.medianMs/reference.medianMs),
    fastest:fastest.name,fastestImprovementPercent:100*(1-fastest.medianMs/reference.medianMs),table},null,2));
