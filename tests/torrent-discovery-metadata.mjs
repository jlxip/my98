import assert from "node:assert/strict";
import {createServer} from "node:http";
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {chromium,webkit} from "playwright";
const data=Buffer.alloc(262145,42),pieces=[data.subarray(0,262144),data.subarray(262144)].map(bytes=>createHash("sha1").update(bytes).digest());
const raw=Buffer.concat([Buffer.from("d6:lengthi262145e4:name9:disk.my9812:piece lengthi262144e6:pieces40:"),...pieces,Buffer.from("e")]);
const hash=createHash("sha1").update(raw).digest("hex");
const files=new Map();
for(const name of ["torrent-window","torrent-store","torrent-protocol","torrent-sources","torrent-port"])
    files.set("/"+name+".js",await readFile("src/disk/web/"+name+".js"));
files.set("/torrent/webtorrent.min.js",await readFile("build/torrent/webtorrent.min.js"));
let mode="wrong",aborted=0,requests=0;
const server=createServer((req,res)=>{
    if(files.has(req.url)){res.writeHead(200,{"Content-Type":"text/javascript"}).end(files.get(req.url));return;}
    if(req.url==="/v2/info/"+hash) {
        requests++;
        if(mode==="slow"){res.on("close",()=>aborted++);return;}
        res.end(mode==="wrong"?Buffer.from("de"):raw);return;
    }
    if(req.url==="/"){res.writeHead(200,{"Content-Type":"text/html"}).end("<!doctype html>");return;}
    throw Error("Unexpected payload or torrent-file request: "+req.url);
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const url="http://127.0.0.1:"+server.address().port;
try {
    for(const [engine,type] of Object.entries({chromium,webkit})) {
        const browser=await type.launch();
        try {
            const page=await browser.newPage();await page.goto(url);
            await page.evaluate(async url=>{
                const {WindowTorrents}=await import("/torrent-window.js");
                window.newClient=()=>new WindowTorrents({sources:{apis:[url],trackers:[],webseeds:[]}});
                window.client=newClient();
            },url);
            mode="wrong";
            assert.equal(await page.evaluate(async hash=>{try{await client.open({infoHash:hash,kind:"disk"});return "accepted";}catch(error){return error.code;}},hash),"INVALID_PUBLICATION");
            mode="online";
            const opened=await page.evaluate(async hash=>client.open({infoHash:hash,kind:"disk"}),hash);
            assert.equal(opened.infoHash,hash);assert.equal(opened.size,data.length);
            await page.evaluate(async()=>{await client.close();window.client=newClient();});
            const copies=await page.evaluate(async hash=>{
                const {WindowTorrentPort,TorrentPort}=await import("/torrent-port.js"),channel=new MessageChannel();
                const host=new WindowTorrentPort(channel.port1,()=>newClient()),io=new TorrentPort(channel.port2);
                try {
                    const session="torrent:1";await io.call("create",{session});
                    const one=await io.call("metadata",{session,infoHash:hash,kind:"disk"});
                    const two=await io.call("metadata",{session,infoHash:hash,kind:"disk"});
                    return one.length>0&&two.length===one.length&&two.every((byte,index)=>byte===one[index]);
                } finally {await host.close();io.close();}
            },hash);
            assert(copies,"Transferring metadata detached the transport's retained copy");
            const lateSources=await page.evaluate(async({hash,url})=>{
                const {WindowTorrentPort,TorrentPort}=await import("/torrent-port.js");
                const {WindowTorrents}=await import("/torrent-window.js"),channel=new MessageChannel();
                const host=new WindowTorrentPort(channel.port1,sources=>new WindowTorrents({sources})),io=new TorrentPort(channel.port2);
                try {
                    const session="torrent:2";await io.call("create",{session,sources:{apis:[],trackers:[],webseeds:[]},sourcesPending:true});
                    let finished=false;const opening=io.call("metadata",{session,infoHash:hash,kind:"disk"}).finally(()=>{finished=true;});
                    await new Promise(resolve=>setTimeout(resolve,50));if(finished)throw Error("Metadata lookup did not wait for late HTTPS sources");
                    await io.call("sources",{session,sources:{apis:[url],trackers:[],webseeds:[]}});
                    const bytes=await opening;return bytes.length>0;
                } finally {await host.close();io.close();}
            },{hash,url});
            assert(lateSources,"Late sources failed across the Worker bridge");
            mode="slow";const before=aborted;
            const cancelled=await page.evaluate(async hash=>{
                const start=performance.now(),opening=client.open({infoHash:hash,kind:"disk"}).then(()=>"accepted",error=>error.code);
                await new Promise(resolve=>setTimeout(resolve,150));client.cancel();
                const code=await opening;await client.close();return {code,milliseconds:performance.now()-start};
            },hash);
            assert.equal(cancelled.code,"CANCELLED");assert(cancelled.milliseconds<2000);
            for(let i=0;i<20&&aborted===before;i++)await new Promise(resolve=>setTimeout(resolve,10));
            assert(aborted>before,"Metadata cancellation left an HTTP request running");
            console.log(JSON.stringify({engine,infohashOnly:true,incorrectInfoRejected:true,retry:true,metadataCancellation:true,noPayloadRequests:true}));
        } finally {await browser.close();}
    }
    assert.equal(requests,10);
} finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
