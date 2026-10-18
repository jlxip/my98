import {createServer} from "node:http";
import {readFile,mkdir,writeFile} from "node:fs/promises";
import {chromium,webkit} from "playwright";

const publicKey="07d2860c1066244fa0d7973545b4dd822466d8b2c9fd83fb84331716949b3a54";
const first={publicKey,sequence:123,infoHash:"12".repeat(20),salt:Buffer.from("my98/publication/v1").toString("hex"),
    signature:"512b1784e462afb245621af1ea416b1bbf35556f15d1f31372fa6a23c787f489b980fbb56f60dc0ca133904e41bac76796ee3a9c698ef09e251f2c8e6076f50b"};
const maximum={...first,sequence:Number.MAX_SAFE_INTEGER,infoHash:"34".repeat(20),
    signature:"d69cbee3bba77d17a2023e2ad59a2cffd313df77e4273f22bc17d713970e726a05f8067004df1ca1b8172c143849d4456a77e0cc82c86192c914d00d0d808504"};
const fork={...first,infoHash:"56".repeat(20),
    signature:"77c3ad3e43a38ad75aba19e8d7c864e5756f218b055309cf189ed621d8ce6526a495b6fa0e0a8e35c5c0c3b211196f9e04419760a1e9cf511225cac4d89e7b01"};
const files=new Map();
for(const name of ["torrent-records.js","torrent-protocol.js","torrent-store.js","torrent-sources.js"])
    files.set("/"+name,await readFile("src/disk/web/"+name));
for(const name of ["slop86_disk.js","slop86_disk_bg.wasm"])
    files.set("/pkg/"+name,await readFile("build/disk/pkg/"+name));
const server=createServer((req,res)=>{
    const bytes=files.get(req.url);
    if(bytes){res.writeHead(200,{"Content-Type":req.url.endsWith(".wasm")?"application/wasm":"text/javascript"}).end(bytes);return;}
    if(req.url.startsWith("/api/")) {
        let record;
        if(req.url.startsWith("/api/current/"))record=first;
        if(req.url.startsWith("/api/fork/"))record=fork;
        if(req.url.startsWith("/api/invalid/"))record={...maximum,signature:"00".repeat(64)};
        res.writeHead(record?200:404,{"Content-Type":"application/json"}).end(JSON.stringify(record||{}));return;
    }
    res.writeHead(200,{"Content-Type":"text/html"}).end("<!doctype html>");
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const url="http://127.0.0.1:"+server.address().port,results=[];
try {
    for(const [name,type] of Object.entries({chromium,webkit})) {
        const browser=await type.launch();
        try {
            const page=await browser.newPage();await page.goto(url);
            const result=await page.evaluate(async({first,maximum,url})=>{
                const {default:init,verify}=await import("/pkg/slop86_disk.js");await init();
                const {observeRecord,cachedRecord,resolveRecord}=await import("/torrent-records.js");
                const {clearTorrentCache}=await import("/torrent-store.js");
                const assert=(value,message)=>{if(!value)throw Error(message);};
                const key=first.publicKey;
                await observeRecord(first,key,verify);
                const outcomes=await Promise.allSettled([
                    observeRecord(first,key,verify),observeRecord(maximum,key,verify)]);
                assert(outcomes.some(r=>r.status==="fulfilled"),"No record persisted");
                assert((await cachedRecord(key,verify)).sequence===Number.MAX_SAFE_INTEGER,"Concurrent observation lost maximum");
                for(const value of [first,{...maximum,signature:"00".repeat(64)},{...maximum,sequence:2**53}]) {
                    let rejected=false;try{await observeRecord(value,key,verify);}catch{rejected=true;}
                    assert(rejected,"Invalid, unsafe or stale record was accepted");
                }
                const resolved=await resolveRecord(key,{apis:[url+"/api/invalid",url+"/api/current"]},verify);
                assert(resolved.sequence===maximum.sequence,"Stale source rolled back cached maximum");
                let conflict=false;
                try{await resolveRecord(key,{apis:[url+"/api/current",url+"/api/fork"]},verify);}
                catch(error){conflict=error.code==="PUBLICATION_CONFLICT";}
                assert(conflict,"Equivocating signed sources were not reported");
                await clearTorrentCache();
                assert((await cachedRecord(key,verify)).sequence===maximum.sequence,"Cache cleanup erased maximum");
                assert((await resolveRecord(key,{apis:[]},verify)).sequence===maximum.sequence,"Offline verified record unavailable");
                assert(await resolveRecord("11".repeat(32),{apis:[url+"/api/empty"]},verify)===null,"Absent identity was fabricated");
                return {rustWasmVectors:true,maximumPersists:true,concurrentSafe:true,invalidRejected:true,
                    conflict:true,offlineVerifiedCache:true,cleanupPreservesMaximum:true};
            },{first,maximum,url});
            results.push({browser:name,...result});console.log(JSON.stringify(results.at(-1)));
        } finally {await browser.close();}
    }
} finally {
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    await mkdir("build/transport-retirement",{recursive:true});
    await writeFile("build/transport-retirement/torrent-records.json",JSON.stringify(results,null,2)+"\n");
}
