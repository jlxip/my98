import assert from "node:assert/strict";
import {createServer} from "node:http";
import {readFile,mkdir,writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {chromium,webkit} from "playwright";

// Real WebTorrent and HTTP only: no request routing or simulated piece events.
// Three independent webseed URLs retain the transport's own connection limits.
const PIECE=262144,DELAY_MS=350,PAIR_COUNT=2;
const targets=[...Array.from({length:16},(_,i)=>i*2),33];
const data=Buffer.alloc(33*PIECE+123);
for(let i=0;i<data.length;i++)data[i]=i%251;
const ranges=targets.map(index=>[index*PIECE,Math.min(PIECE,data.length-index*PIECE)]);
const total=16*PIECE+123;
function encode(value) {
    if(Number.isInteger(value))return Buffer.from("i"+value+"e");
    if(typeof value==="string")value=Buffer.from(value);
    if(value instanceof Uint8Array)return Buffer.concat([Buffer.from(value.length+":"),value]);
    if(Array.isArray(value))return Buffer.concat([Buffer.from("l"),...value.map(encode),Buffer.from("e")]);
    return Buffer.concat([Buffer.from("d"),...Object.keys(value).sort().flatMap(key=>[encode(key),encode(value[key])]),Buffer.from("e")]);
}
const pieces=[];
for(let offset=0;offset<data.length;offset+=PIECE)
    pieces.push(createHash("sha1").update(data.subarray(offset,offset+PIECE)).digest());
const info={name:"disk.my98",length:data.length,"piece length":PIECE,pieces:Buffer.concat(pieces)};
const hash=createHash("sha1").update(encode(info)).digest("hex"),metadata=encode({info});
const files=new Map();
for(const name of ["torrent-window.js","torrent-store.js","torrent-protocol.js","torrent-sources.js"])
    files.set("/"+name,await readFile("src/disk/web/"+name));
files.set("/webtorrent.js",await readFile("build/torrent/webtorrent.min.js"));
const cases=new Map(),results=[],timers=new Set(),serverStarted=performance.now();
let failure;
function policy(id,mode) {
    const value={id,mode,allowed:new Set(),held:new Set(),requests:[]};
    cases.set(id,value);return value;
}
function respond(value,item) {
    value.held.delete(item);
    if(item.res.destroyed)return;
    item.record.respondedMs=performance.now()-serverStarted;
    item.res.writeHead(206,{"Content-Length":item.end-item.start+1,
        "Content-Range":"bytes "+item.start+"-"+item.end+"/"+data.length,
        "Accept-Ranges":"bytes","Cache-Control":"no-store"}).end(data.subarray(item.start,item.end+1));
}
function releasePiece(value,index) {
    value.allowed.add(index);
    for(const item of [...value.held])if(item.record.piece===index)respond(value,item);
}
function releaseAll(value) {
    value.mode="online";
    for(const item of [...value.held])respond(value,item);
}
const server=createServer((req,res)=>{
    const path=new URL(req.url,"http://localhost").pathname,file=files.get(path);
    if(file){res.writeHead(200,{"Content-Type":"text/javascript","Cache-Control":"no-store"}).end(file);return;}
    const match=path.match(/^\/content\/([^/]+)\/source[0-2]\/([^/]+)\/disk\.my98$/);
    if(match) {
        const value=cases.get(match[1]);
        if(!value||match[2]!==hash){res.writeHead(404).end();return;}
        const record={method:req.method,range:req.headers.range??null,receivedMs:performance.now()-serverStarted};
        value.requests.push(record);
        if(req.method==="HEAD"){res.writeHead(200,{"Content-Length":data.length,"Cache-Control":"no-store"}).end();return;}
        const range=req.headers.range?.match(/^bytes=([0-9]+)-([0-9]+)$/);
        if(req.method!=="GET"||!range){res.writeHead(400).end();return;}
        const start=Number(range[1]),end=Number(range[2]);
        if(start>end||end>=data.length){res.writeHead(416).end();return;}
        record.piece=Math.floor(start/PIECE);record.lastPiece=Math.floor(end/PIECE);
        const item={res,start,end,record};
        if(value.mode==="held"&&!value.allowed.has(record.piece)) {
            value.held.add(item);res.once("close",()=>value.held.delete(item));return;
        }
        if(value.mode==="delayed") {
            const timer=setTimeout(()=>{timers.delete(timer);respond(value,item);},DELAY_MS);
            timers.add(timer);
            res.once("close",()=>{clearTimeout(timer);timers.delete(timer);});return;
        }
        respond(value,item);return;
    }
    if(path==="/"){res.writeHead(200,{"Content-Type":"text/html","Cache-Control":"no-store"}).end("<!doctype html>");return;}
    res.writeHead(404).end();
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const url="http://127.0.0.1:"+server.address().port;
async function eventually(predicate,message) {
    const deadline=performance.now()+10000;
    while(!predicate()) {
        if(performance.now()>deadline)throw Error(message);
        await new Promise(resolve=>setTimeout(resolve,10));
    }
}
async function openCase(browser,value,variant) {
    const context=await browser.newContext(),external=[];
    context.on("request",request=>{
        const requestURL=new URL(request.url());
        if(requestURL.origin!==url)external.push(requestURL.href);
    });
    try {
        await context.addInitScript(()=>{
            for(const key of ["RTCPeerConnection","webkitRTCPeerConnection","mozRTCPeerConnection"])
                Object.defineProperty(globalThis,key,{value:undefined,configurable:true});
        });
        const page=await context.newPage();
        await page.goto(url);
        await page.evaluate(async({url,id,hash,metadata,ranges,targets,total,variant})=>{
            const {default:WebTorrent}=await import("/webtorrent.js");
            if(WebTorrent.WEBRTC_SUPPORT!==false)throw Error("Fixture did not disable WebRTC");
            const {WindowTorrents}=await import("/torrent-window.js");
            let probe;
            const client=new WindowTorrents({
                sources:{apis:[],trackers:[],webseeds:[0,1,2].map(i=>url+"/content/"+id+"/source"+i)},
                clientFactory:async()=>WebTorrent,timeout:30000,
                onProgress:state=>{
                    if(state.startupPrefetch?.id!==id)return;
                    probe.progress.push({...state.startupPrefetch,atMs:performance.now()-probe.started});
                    probe.snapshot("progress");
                }
            });
            await client.open({infoHash:hash,metadata:new Uint8Array(metadata),kind:"disk"});
            const torrent=client.entry(hash).torrent;
            if(targets.some(index=>torrent.bitfield.get(index)))throw Error("Fresh context contained verified pieces");
            probe=globalThis.probe={client,torrent,owners:new Set(),snapshots:[],progress:[],peak:0,done:false,
                started:performance.now(),result:null,error:null};
            probe.snapshot=reason=>{
                // Count only this job's exact notify callbacks. Connections,
                // HTTP requests and unrelated selections are not this window.
                const selections=[...torrent._selections].filter(s=>probe.owners.has(s.notify));
                const pending=selections.filter(s=>!torrent.bitfield.get(s.from)).map(s=>({
                    from:s.from,to:s.to,stream:s.isStreamSelection
                }));
                probe.peak=Math.max(probe.peak,pending.length);
                probe.snapshots.push({reason,atMs:performance.now()-probe.started,pending});
                return pending.map(s=>s.from);
            };
            const select=torrent._select;
            torrent._select=function(first,last,priority,notify,stream) {
                if(variant==="window"&&stream)probe.owners.add(notify);
                const result=select.apply(this,arguments);
                probe.snapshot("select");return result;
            };
            probe.task=(variant==="window"
                ?client.prefetchStartup({infoHash:hash,id,ranges,windowPieces:8})
                :client.prefetch(hash,ranges)).then(result=>{
                    probe.result=result??null;probe.elapsedMs=performance.now()-probe.started;probe.done=true;
                    probe.snapshot("complete");
                },error=>{
                    probe.error={message:error.message,code:error.code};probe.done=true;
                });
            probe.report=()=>({
                elapsedMs:probe.elapsedMs,error:probe.error,result:probe.result,peak:probe.peak,
                snapshots:probe.snapshots,progress:probe.progress,
                verified:targets.filter(index=>torrent.bitfield.get(index)),
                remainingOwned:[...torrent._selections].filter(s=>probe.owners.has(s.notify)).length,
                downloaded:client.describe(client.entry(hash)).downloaded,total
            });
        },{url,id:value.id,hash,metadata:Array.from(metadata),ranges,targets,total,variant});
        return {context,page,external};
    } catch(error) {await context.close();throw error;}
}
function validate(value,result,variant,external) {
    assert.equal(result.error,null,"Transport failed: "+JSON.stringify(result.error));
    assert.deepEqual(result.verified,targets,"Every profile piece must be verified");
    assert.ok(result.downloaded<data.length,"Profile unexpectedly downloaded the complete disk");
    assert.deepEqual(external,[],"Fixture contacted an external source");
    const requests=value.requests.filter(r=>r.method==="GET");
    assert.ok(requests.length>=targets.length,"Cold case did not transfer all target pieces");
    assert.ok(requests.every(r=>r.piece===r.lastPiece&&targets.includes(r.piece)),
        "Transport requested a piece outside the profile");
    if(variant!=="window")return;
    assert.equal(result.peak,8,"Startup must fill its eight-piece selection window");
    assert.equal(result.remainingOwned,0,"Completed startup retained its selections");
    assert.deepEqual(result.result,{completed:total,total},"Verified byte total changed");
    for(const snapshot of result.snapshots) {
        assert.ok(snapshot.pending.length<=8,"Startup selected more than eight pending pieces");
        assert.equal(new Set(snapshot.pending.map(s=>s.from)).size,snapshot.pending.length,"Duplicate owned piece");
        assert.ok(snapshot.pending.every(s=>s.stream&&s.from===s.to&&targets.includes(s.from)),
            "Startup selection must own a single target piece");
    }
    let previous=0;
    for(const progress of result.progress) {
        assert.equal(progress.total,total,"Profile denominator changed");
        assert.ok(progress.completed>=previous&&progress.completed<=total,"Verified progress regressed or duplicated");
        previous=progress.completed;
    }
    assert.equal(previous,total,"Final verified progress was incomplete");
}
async function gatedCase(browser,engine) {
    const value=policy(engine+"-held","held");
    const {context,page,external}=await openCase(browser,value,"window");
    try {
        await page.waitForFunction(()=>probe.peak===8||probe.error,{},{timeout:10000});
        const initial=await page.evaluate(()=>({pending:probe.snapshot("initial"),error:probe.error}));
        assert.equal(initial.error,null);
        assert.deepEqual(initial.pending,targets.slice(0,8),"Initial window did not contain the first eight target pieces");
        await eventually(()=>[...value.held].some(item=>item.record.piece!==0&&targets.slice(0,8).includes(item.record.piece)),
            "No actual non-head request arrived within the initial window");
        const released=[...value.held].find(item=>item.record.piece!==0&&targets.slice(0,8).includes(item.record.piece)).record.piece;
        releasePiece(value,released);
        await page.waitForFunction(({released,next})=>probe.error||
            (probe.torrent.bitfield.get(released)&&probe.snapshot("refill-check").includes(next)),
            {released,next:targets[8]},{timeout:10000});
        // Wait for a real held request for the first piece, as a fresh webseed
        // may initially validate itself with another selected piece.
        await eventually(()=>[...value.held].some(item=>item.record.piece===0),
            "First target never reached the controlled HTTP gate");
        const replenished=await page.evaluate(()=>({
            firstVerified:probe.torrent.bitfield.get(0),pending:probe.snapshot("replenished"),error:probe.error
        }));
        assert.equal(replenished.error,null);
        assert.equal(replenished.firstVerified,false,"First piece was not held during replenishment");
        assert.ok(replenished.pending.includes(targets[8]),"Next range did not enter while the first range was blocked");
        assert.equal(replenished.pending.length,8,"Verified piece did not replenish one slot");
        releaseAll(value);
        await page.waitForFunction(()=>probe.done,{},{timeout:30000});
        const result=await page.evaluate(()=>probe.report());
        validate(value,result,"window",external);
        return {releasedPiece:released,firstPieceHeld:true,nextRangeBeforeFirst:true,...result};
    } finally {
        releaseAll(value);
        await page.evaluate(()=>globalThis.probe?.client.close()).catch(()=>{});
        await context.close();
    }
}
async function timedCase(browser,engine,variant,pair) {
    const value=policy(engine+"-"+pair+"-"+variant,"delayed");
    const {context,page,external}=await openCase(browser,value,variant);
    try {
        await page.waitForFunction(()=>probe.done,{},{timeout:30000});
        const result=await page.evaluate(()=>probe.report());
        validate(value,result,variant,external);
        const requests=value.requests.filter(r=>r.method==="GET");
        assert.ok(requests.every(r=>r.respondedMs-r.receivedMs>=DELAY_MS-5),
            "Controlled response latency was not applied");
        return {pair,variant,...result};
    } finally {
        await page.evaluate(()=>globalThis.probe?.client.close()).catch(()=>{});
        await context.close();
    }
}
async function recoveryCase(browser,engine) {
    const value=policy(engine+"-recovery","online");
    const {context,page,external}=await openCase(browser,value,"window");
    const cachedReads=[{offset:17,length:512},{offset:targets[targets.length-1]*PIECE,length:123}];
    const demand={offset:PIECE+29,length:1024};
    try {
        await page.waitForFunction(()=>probe.done,{},{timeout:30000});
        const prefetch=await page.evaluate(()=>probe.report());
        validate(value,prefetch,"window",external);
        const destroyed=await page.evaluate(async hash=>{
            const entry=probe.client.entry(hash);
            probe.failedEntry=entry;
            // This is the real WebTorrent teardown and persistent store close.
            // No synthetic error, piece event or replacement store is involved.
            await new Promise((resolve,reject)=>entry.torrent.destroy({destroyStore:false},
                error=>error?reject(error):resolve()));
            return {destroyed:entry.torrent.destroyed,failed:!!entry.error};
        },hash);
        assert.deepEqual(destroyed,{destroyed:true,failed:true},"Torrent teardown did not fail its transport entry");
        const beforeRecovery=value.requests.length;
        const recovered=await page.evaluate(async({hash,reads})=>{
            const {client}=probe,webtorrent=client.client,original=webtorrent.add,added=[];
            // Observe actual component creations while preserving WebTorrent's
            // implementation, scheduling and IndexedDB-backed piece store.
            webtorrent.add=function(...args) {
                const torrent=original.apply(this,args);added.push(torrent);return torrent;
            };
            try {
                const first=client.read({infoHash:hash,...reads[0],recover:true});
                const recovery=client.recovering.get(hash);
                const second=client.read({infoHash:hash,...reads[1],recover:true});
                const sharedRecovery=!!recovery&&recovery===client.recovering.get(hash);
                const results=await Promise.all([first,second].map(async read=>({
                    bytes:Array.from(await read),entry:client.entry(hash)
                })));
                probe.recoveredEntry=client.entry(hash);
                return {
                    bytes:results.map(result=>result.bytes),sharedRecovery,
                    sharedEntry:results.every(result=>result.entry===probe.recoveredEntry),
                    replacedEntry:probe.recoveredEntry!==probe.failedEntry,
                    replacedTorrent:probe.recoveredEntry.torrent!==probe.failedEntry.torrent,
                    additions:added.length,onlyAddedTorrent:added[0]===probe.recoveredEntry.torrent,
                    liveComponents:webtorrent.torrents.filter(torrent=>torrent.infoHash===hash).length,
                    cachedVerified:reads.every(read=>probe.recoveredEntry.torrent.bitfield.get(Math.floor(read.offset/262144)))
                };
            } finally {webtorrent.add=original;}
        },{hash,reads:cachedReads});
        assert.equal(recovered.sharedRecovery,true,"Concurrent readers did not share the recovery promise");
        assert.equal(recovered.sharedEntry,true,"Concurrent readers used different recovered entries");
        assert.equal(recovered.replacedEntry,true,"Recovery reused the failed entry");
        assert.equal(recovered.replacedTorrent,true,"Recovery reused the destroyed torrent");
        assert.equal(recovered.additions,1,"Concurrent readers reopened the component more than once");
        assert.equal(recovered.onlyAddedTorrent,true,"Readers did not use the reopened WebTorrent component");
        assert.equal(recovered.liveComponents,1,"WebTorrent retained duplicate live components");
        assert.equal(recovered.cachedVerified,true,"Recovered reads did not verify the preserved cache");
        for(let index=0;index<cachedReads.length;index++) {
            const {offset,length}=cachedReads[index];
            assert.deepEqual(recovered.bytes[index],Array.from(data.subarray(offset,offset+length)),
                "Recovered cached read returned incorrect ciphertext");
        }
        const recoveryGets=value.requests.slice(beforeRecovery).filter(request=>request.method==="GET");
        assert.deepEqual(recoveryGets,[],"Recovery fetched payload despite both target pieces being cached");
        const beforeDemand=value.requests.length;
        const demanded=await page.evaluate(async({hash,range})=>{
            const before=probe.client.entry(hash),index=Math.floor(range.offset/262144);
            const wasVerified=before.torrent.bitfield.get(index);
            const bytes=await probe.client.read({infoHash:hash,...range,recover:true});
            return {bytes:Array.from(bytes),wasVerified,sameEntry:probe.client.entry(hash)===probe.recoveredEntry,
                verified:probe.client.entry(hash).torrent.bitfield.get(index)};
        },{hash,range:demand});
        assert.equal(demanded.wasVerified,false,"Outside-profile demand was unexpectedly cached");
        assert.equal(demanded.sameEntry,true,"Outside-profile demand replaced the healthy recovered component");
        assert.equal(demanded.verified,true,"Outside-profile demand did not verify its real download");
        assert.deepEqual(demanded.bytes,Array.from(data.subarray(demand.offset,demand.offset+demand.length)),
            "Outside-profile demand returned incorrect ciphertext");
        const demandGets=value.requests.slice(beforeDemand).filter(request=>request.method==="GET");
        assert.ok(demandGets.length>0,"Outside-profile demand performed no real HTTP GET");
        assert.ok(demandGets.every(request=>request.piece===1&&request.lastPiece===1),
            "Outside-profile demand fetched unrelated pieces");
        assert.deepEqual(external,[],"Recovery contacted an external source");
        return {sharedRecovery:recovered.sharedRecovery,sharedEntry:recovered.sharedEntry,
            additions:recovered.additions,preservedCacheGets:recoveryGets.length,
            outsideProfileGets:demandGets.length,cachedBytes:cachedReads.map(read=>read.length),demandBytes:demand.length};
    } finally {
        await page.evaluate(()=>globalThis.probe?.client.close()).catch(()=>{});
        await context.close();
    }
}
const median=values=>{
    const ordered=[...values].sort((a,b)=>a-b),middle=Math.floor(ordered.length/2);
    return ordered.length%2?ordered[middle]:(ordered[middle-1]+ordered[middle])/2;
};
try {
    for(const [engine,type] of Object.entries({chromium,webkit})) {
        const browser=await type.launch();
        try {
            const gated=await gatedCase(browser,engine),recovery=await recoveryCase(browser,engine),timings=[];
            // Fresh contexts, paired and alternating order. The 350 ms delay
            // dominates local scheduling noise; serial ranges require at least
            // 17 response rounds whereas the window overlaps independent ranges.
            for(let pair=0;pair<PAIR_COUNT;pair++)
                for(const variant of pair%2?["window","ranges"]:["ranges","window"])
                    timings.push(await timedCase(browser,engine,variant,pair));
            const sequentialMs=median(timings.filter(r=>r.variant==="ranges").map(r=>r.elapsedMs));
            const windowMs=median(timings.filter(r=>r.variant==="window").map(r=>r.elapsedMs));
            const ratio=windowMs/sequentialMs;
            results.push({engine,gated,recovery,timings,comparison:{sequentialMs,windowMs,ratio,improvement:1-ratio}});
            assert.ok(ratio<0.8,"Eight-piece window did not improve controlled multi-range latency by 20%: "+ratio);
            console.log(JSON.stringify({engine,initialWindow:8,replenishedAcrossRanges:true,sequentialMs,windowMs,ratio}));
        } finally {await browser.close();}
    }
} catch(error) {failure={message:error.message,stack:error.stack};throw error;}
finally {
    for(const timer of timers)clearTimeout(timer);
    for(const value of cases.values())for(const item of value.held)item.res.destroy();
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    await mkdir("build/startup-prefetch",{recursive:true});
    await writeFile("build/startup-prefetch/torrent-startup-window.json",JSON.stringify({
        status:failure?"failed":"passed",pieceBytes:PIECE,targets,ranges,total,
        delayMs:DELAY_MS,pairsPerEngine:PAIR_COUNT,results,failure,
        cases:[...cases.values()].map(({id,requests})=>({id,requests}))
    },null,2)+"\n");
}

