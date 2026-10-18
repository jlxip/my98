import {createServer} from "node:http";
import {readFile,mkdir,writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {chromium,webkit} from "playwright";

function encode(value) {
    if(Number.isInteger(value))return Buffer.from("i"+value+"e");
    if(typeof value==="string")value=Buffer.from(value);
    if(value instanceof Uint8Array)return Buffer.concat([Buffer.from(value.length+":"),value]);
    if(Array.isArray(value))return Buffer.concat([Buffer.from("l"),...value.map(encode),Buffer.from("e")]);
    return Buffer.concat([Buffer.from("d"),...Object.keys(value).sort().flatMap(key=>[encode(key),encode(value[key])]),Buffer.from("e")]);
}
const data=Buffer.alloc(10*262144+123);
for(let i=0;i<data.length;i++)data[i]=i%251;
const hashes=[];
for(let offset=0;offset<data.length;offset+=262144)
    hashes.push(createHash("sha1").update(data.subarray(offset,offset+262144)).digest());
const info={name:"disk.my98",length:data.length,"piece length":262144,pieces:Buffer.concat(hashes)};
const hash=createHash("sha1").update(encode(info)).digest("hex");
const metadata=encode({info,announce:"wss://untrusted.invalid","url-list":["https://untrusted.invalid/disk"]});
const files=new Map();
for(const name of ["torrent-window.js","torrent-store.js","torrent-protocol.js","torrent-sources.js"])
    files.set("/"+name,await readFile("src/disk/web/"+name));
files.set("/webtorrent.js",await readFile("build/torrent/webtorrent.min.js"));
let mode="online",corruptServed=0;const requests=[],results=[];
const server=createServer((req,res)=>{
    const path=new URL(req.url,"http://localhost").pathname;
    if(path.startsWith("/mode/")){mode=path.split("/").at(-1);res.writeHead(200).end();return;}
    const file=files.get(path);
    if(file){res.writeHead(200,{"Content-Type":"text/javascript"}).end(file);return;}
    if(path.endsWith("/"+hash+"/disk.my98")) {
        requests.push({path,method:req.method,range:req.headers.range,mode});
        if(path.startsWith("/unavailable/")){res.writeHead(503).end();return;}
        if(mode==="offline"){res.writeHead(503).end();return;}
        if(req.method==="HEAD" && path.startsWith("/content/")){res.writeHead(200,{"Content-Length":data.length}).end();return;}
        if(req.method==="HEAD"){res.writeHead(405).end();return;}
        const range=req.headers.range?.match(/^bytes=([0-9]+)-([0-9]+)$/);
        if(!range){res.writeHead(400).end();return;}
        const start=Number(range[1]),end=Math.min(Number(range[2]),data.length-1);
        const body=Buffer.from(data.subarray(start,end+1));
        if(mode==="corrupt" && start===0){body[0]^=255;corruptServed++;mode="online";}
        res.writeHead(206,{"Content-Length":body.length,"Content-Range":"bytes "+start+"-"+end+"/"+data.length,
            "Accept-Ranges":"bytes","Access-Control-Allow-Origin":"*"}).end(body);return;
    }
    res.writeHead(200,{"Content-Type":"text/html"}).end("<!doctype html>");
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const url="http://127.0.0.1:"+server.address().port;
try {
    for(const [name,type] of Object.entries({chromium,webkit})) {
        mode="online";const before=corruptServed,requestStart=requests.length;
        const browser=await type.launch();
        try {
            const page=await browser.newPage(),external=[];
            await page.route("**/*",route=>{
                if(new URL(route.request().url()).hostname!=="127.0.0.1"){external.push(route.request().url());return route.abort();}
                return route.continue();
            });
            await page.addInitScript(()=>{
                for(const key of ["RTCPeerConnection","webkitRTCPeerConnection","mozRTCPeerConnection"])
                    Object.defineProperty(globalThis,key,{value:undefined,configurable:true});
            });
            await page.goto(url);
            const result=await page.evaluate(async({url,hash,metadata,size})=>{
                const {default:WebTorrent}=await import("/webtorrent.js");
                if(WebTorrent.WEBRTC_SUPPORT!==false)throw Error("Fixture did not disable WebRTC");
                const {WindowTorrents}=await import("/torrent-window.js");
                const {openTorrentDatabase,clearTorrentCache}=await import("/torrent-store.js");
                const assert=(value,message)=>{if(!value)throw Error(message);};
                const options={sources:{apis:[],trackers:[],webseeds:[url+"/unavailable",url+"/content",url+"/alternate"]},
                    clientFactory:async()=>WebTorrent,timeout:15000};
                const open=async()=>{
                    const client=new WindowTorrents(options);
                    await client.open({infoHash:hash,metadata:new Uint8Array(metadata),kind:"disk"});
                    return client;
                };
                let client=await open();
                try {
                    const one=await client.read({infoHash:hash,offset:0,length:1});
                    assert(one.length===1 && one[0]===0,"Single-byte range changed");
                    const offset=262140,bytes=await client.read({infoHash:hash,offset,length:32});
                    assert(bytes.length===32 && bytes.every((b,i)=>b===(offset+i)%251),"Range crossing pieces changed");
                    assert(client.describe(client.entry(hash)).downloaded<size,"Lazy read downloaded the whole disk");
                    client.setBackground(hash,true);
                    for(let i=0;i<1000&&!client.describe(client.entry(hash)).complete;i++)await new Promise(resolve=>setTimeout(resolve,10));
                    assert(client.describe(client.entry(hash)).complete,"Background download did not complete");
                } finally {await client.close();}
                await fetch("/mode/offline");client=await open();
                try {
                    const bytes=await client.read({infoHash:hash,offset:0,length:64});
                    assert(bytes.every((b,i)=>b===i),"Verified persistent cache did not reopen offline");
                } finally {await client.close();}
                const db=await openTorrentDatabase();
                await new Promise((resolve,reject)=>{
                    const tx=db.transaction(["pieces"],"readwrite"),store=tx.objectStore("pieces");
                    const request=store.get([hash,0]);
                    request.onsuccess=()=>{const row=request.result;row.data[0]^=255;store.put(row);};
                    tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
                });db.close();
                await fetch("/mode/corrupt");client=await open();
                try {
                    const bytes=await client.read({infoHash:hash,offset:0,length:64});
                    assert(bytes.every((b,i)=>b===i),"Corrupt cached/network piece was accepted");
                } finally {await client.close();}
                await clearTorrentCache();
                await fetch("/mode/offline");client=await open();
                try {
                    const read=client.read({infoHash:hash,offset:size-100,length:100});
                    setTimeout(()=>client.cancel(),30);
                    let cancelled=false;try{await read;}catch(error){cancelled=error.code==="CANCELLED";}
                    assert(cancelled,"Cancellation did not reject pending ciphertext read");
                } finally {await client.close();}
                await fetch("/mode/online");client=await open();
                const put=IDBObjectStore.prototype.put;
                try {
                    IDBObjectStore.prototype.put=function(...args){
                        if(this.name==="pieces")throw new DOMException("Fixture quota","QuotaExceededError");
                        return put.apply(this,args);
                    };
                    let full=false;
                    try{await client.read({infoHash:hash,offset:0,length:64});}
                    catch(error){full=error.code==="STORAGE_FULL";}
                    assert(full,"Quota error did not propagate through WebTorrent");
                } finally {IDBObjectStore.prototype.put=put;await client.close();}
                await clearTorrentCache();
                return {webRTCUnavailable:WebTorrent.WEBRTC_SUPPORT===false,lazyRanges:true,
                    unavailableSourceSkipped:true,headUnsupportedSource:true,background:true,offlineCache:true,corruptionRejected:true,cancel:true,quota:true};
            },{url,hash,metadata:Array.from(metadata),size:data.length});
            const sourceRequests=requests.slice(requestStart);
            if(!sourceRequests.some(r=>r.method==="HEAD"&&r.path.startsWith("/unavailable/")))throw Error("Unavailable source was not probed");
            if(sourceRequests.some(r=>r.method!=="HEAD"&&r.path.startsWith("/unavailable/")))throw Error("Unavailable source received a piece request");
            for(const root of ["/content/","/alternate/"])if(!sourceRequests.some(r=>r.method==="GET"&&r.path.startsWith(root)))throw Error("Healthy or HEAD-unsupported source was lost");
            if(external.length)throw Error("Untrusted metadata introduced network sources: "+external.join(", "));
            if(corruptServed<=before)throw Error("Corrupt network piece fixture was not exercised");
            results.push({browser:name,...result});console.log(JSON.stringify(results.at(-1)));
        } finally {await browser.close();}
    }
} finally {
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    await mkdir("build/transport-retirement",{recursive:true});
    await writeFile("build/transport-retirement/torrent-window.json",JSON.stringify({results,requests,corruptServed},null,2)+"\n");
}
