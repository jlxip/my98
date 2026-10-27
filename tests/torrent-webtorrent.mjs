import assert from "node:assert/strict";
import {createServer} from "node:http";
import {readFile,mkdir,writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {chromium,webkit} from "playwright";

// Exercise the same locked source build shipped by the application.
const bundlePath=process.env.MY98_WEBTORRENT_BUNDLE || "build/torrent/webtorrent.min.js";
const bundle=await readFile(bundlePath);
const bundleSha256=createHash("sha256").update(bundle).digest("hex");
const api=process.env.MY98_WEBTORRENT_FIXTURE;
const tracker=process.env.MY98_WEBTORRENT_TRACKER;
assert(api && tracker,"Set the loopback fixture HTTP and WS endpoints (SSH forwards are supported)");
for(const value of [api,tracker]) {
    const url=new URL(value);
    assert(["127.0.0.1","[::1]"].includes(url.hostname),"Fixture control must use loopback");
}
const info=await (await fetch(api+"/fixture.json")).json();
const fixtureTLS=new URL(tracker).protocol==="wss:";
const mixed=process.env.MY98_WEBTORRENT_MIXED==="1";
const webseedOnly=process.env.MY98_WEBTORRENT_WEBSEED_ONLY==="1";
assert(!(mixed&&webseedOnly));
assert(!fixtureTLS || info.trackerTLS && info.fixtureCertificate,"WSS exception requires the generated isolated fixture certificate");
assert.equal(info.conventionalPeerTransportsEnabled,false);
assert.equal(info.webseedConfigured,mixed||webseedOnly);
const modules=new Map();
for(const name of ["torrent-window.js","torrent-store.js","torrent-protocol.js","torrent-sources.js"])
    modules.set("/"+name,await readFile("src/disk/web/"+name));
const server=createServer((req,res)=>{
    if(modules.has(req.url))res.writeHead(200,{"Content-Type":"text/javascript"}).end(modules.get(req.url));
    else if(req.url==="/webtorrent.js")res.writeHead(200,{"Content-Type":"text/javascript"}).end(bundle);
    else if(req.url==="/")res.writeHead(200,{"Content-Type":"text/html"}).end("<!doctype html>");
    else res.writeHead(404).end();
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const results=[];
try {
    for(const [name,type] of Object.entries({chromium,webkit})) {
        const browser=await type.launch();
        try {
            const page=await browser.newPage({ignoreHTTPSErrors:fixtureTLS});
            if(process.env.MY98_TRANSPORT_DEBUG) {
                page.on("console",message=>console.log(name,message.text()));
                await page.addInitScript(()=>{localStorage.debug="webtorrent:*,ut_metadata";});
            }
            if(webseedOnly)await page.addInitScript(()=>{
                for(const name of ["RTCPeerConnection","mozRTCPeerConnection","webkitRTCPeerConnection"])
                    Object.defineProperty(globalThis,name,{value:undefined});
            });
            await page.goto("http://127.0.0.1:"+server.address().port+"/");
            const result=await page.evaluate(async({tracker,info,mixed,webseedOnly})=>{
                const {default:WebTorrent}=await import("/webtorrent.js");
                const denied=await new Promise((resolve,reject)=>{
                    const socket=new WebSocket(tracker);
                    const timer=setTimeout(()=>{socket.close();reject(Error("Tracker rejection timed out"));},10000);
                    socket.onopen=()=>socket.send(JSON.stringify({action:"announce",info_hash:"\xfe".repeat(20),
                        peer_id:"-MYTEST-"+"0".repeat(12),uploaded:0,downloaded:0,left:1,event:"started",numwant:0,offers:[]}));
                    socket.onmessage=event=>{clearTimeout(timer);socket.close();resolve(JSON.parse(event.data));};
                    socket.onerror=()=>{clearTimeout(timer);reject(Error("Tracker connection failed"));};
                });
                if(denied["failure reason"])throw Error("Public tracker rejected an unrelated swarm");
                const {WindowTorrents}=await import("/torrent-window.js");
                const seed=tracker.replace(/^wss:/,"https:").replace(/^ws:/,"http:").replace(/\/tracker$/,"/content/");
                const client=new WindowTorrents({sources:{apis:mixed||webseedOnly?[tracker.replace(/^wss:/,"https:").replace(/^ws:/,"http:").replace(/\/tracker$/,"")]:[],trackers:webseedOnly?[]:[tracker],webseeds:mixed||webseedOnly?[seed]:[]},
                    clientFactory:async()=>WebTorrent,timeout:90000});
                const warnings=[],wires=[];
                try {
                    console.log("Opening metadata from infohash",info.infoHash);
                    await client.open({infoHash:info.infoHash,kind:"disk"});
                    console.log("Opened verified metadata");
                    const torrent=client.entry(info.infoHash).torrent;
                    torrent.on("warning",error=>warnings.push(error.message));
                    torrent.on("wire",wire=>wires.push(wire.type));
                    if(mixed) {
                        const deadline=Date.now()+45000;
                        while(!torrent.wires.some(wire=>wire.type==="webrtc" && !wire.peerChoking)) {
                            if(Date.now()>deadline)throw Error("Mixed-source WebRTC peer did not connect");
                            await new Promise(resolve=>setTimeout(resolve,50));
                        }
                    }
                    const first=await client.read({infoHash:info.infoHash,offset:0,length:64});
                    if(!first.every((value,index)=>value===index))throw Error("Incorrect lazy WebRTC range");
                    client.setBackground(info.infoHash,true);
                    const data=await client.read({infoHash:info.infoHash,offset:0,length:info.size});
                    const sha256=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",data)),b=>b.toString(16).padStart(2,"0")).join("");
                    if(sha256!==info.sha256 || data.byteLength!==info.size)throw Error("Incorrect complete torrent content");
                    const received={};
                    for(const wire of torrent.wires)received[wire.type]=(received[wire.type]||0)+wire.downloaded;
                    if(webseedOnly) {
                        if(WebTorrent.WEBRTC_SUPPORT || !(received.webSeed>0) || received.webrtc)throw Error("Webseed-only fallback used an unavailable WebRTC transport");
                    } else if(mixed) {
                        if(!(received.webrtc>0 && received.webSeed>0))throw Error("Both offered sources must transfer bytes: "+JSON.stringify(received));
                    } else if(!wires.includes("webrtc") || wires.some(type=>type!=="webrtc"))throw Error("Transfer was not exclusively WebRTC");
                    return {size:data.byteLength,sha256,wires,received,warnings,unrelatedSwarmAccepted:true,indexedDBStore:true,lazyRange:true,mixedSources:mixed,webRTCUnavailable:webseedOnly};
                } finally {await client.close();}
            },{tracker,info,mixed,webseedOnly});
            results.push({browser:name,trackerTLS:fixtureTLS,fixtureCertificate:fixtureTLS,...result});
            console.log(JSON.stringify(results.at(-1)));
        } finally {await browser.close();}
    }
} finally {
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
    await mkdir("build/transport-retirement",{recursive:true});
    await writeFile("build/transport-retirement/"+(webseedOnly?"webtorrent-webseed-interop.json":mixed?"webtorrent-mixed-interop.json":fixtureTLS?"webtorrent-wss-interop.json":"webtorrent-interop.json"),JSON.stringify({fixture:info,bundleSha256,results},null,2)+"\n");
}
