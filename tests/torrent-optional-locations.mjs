import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
import {createHash,createPrivateKey,createPublicKey,sign} from "node:crypto";
import {chromium,webkit} from "playwright";

const key=createPrivateKey({key:Buffer.concat([Buffer.from("302e020100300506032b657004220420","hex"),
    Buffer.from(Array.from({length:32},(_,i)=>i))]),format:"der",type:"pkcs8"});
const publicKey=createPublicKey(key).export({format:"der",type:"spki"}).subarray(-32).toString("hex");
function encode(value) {
    if(Number.isInteger(value))return Buffer.from("i"+value+"e");
    if(typeof value==="string")value=Buffer.from(value);
    if(value instanceof Uint8Array)return Buffer.concat([Buffer.from(value.length+":"),value]);
    if(Array.isArray(value))return Buffer.concat([Buffer.from("l"),...value.map(encode),Buffer.from("e")]);
    return Buffer.concat([Buffer.from("d"),...Object.keys(value).sort().flatMap(k=>[encode(k),encode(value[k])]),Buffer.from("e")]);
}
const objects={};
function object(name,data) {
    const info={name,length:data.length,"piece length":262144,pieces:createHash("sha1").update(data).digest()};
    const hash=createHash("sha1").update(encode(info)).digest("hex");
    objects[hash]={metadata:[...encode({info})],data:[...data]};return hash;
}
const disk=object("disk.my98",Buffer.from([1,2,3,4]));
const descriptor=object("publication.json",Buffer.from(JSON.stringify({version:1,disk,state:null,profile:null})));
function signed(salt,value,fields) {
    const payload=Buffer.concat([Buffer.from("4:salt"+salt.length+":"+salt+"3:seqi1e1:v"),encode(value)]);
    return {publicKey,sequence:1,salt:Buffer.from(salt).toString("hex"),signature:sign(null,payload,key).toString("hex"),...fields};
}
const publication=signed("my98/publication/v1",{ih:Buffer.from(descriptor,"hex")},{infoHash:descriptor});
const origins=["https://seedbox.example:8445"];
const locations=signed("my98/locations/v1",{origins,version:1},{origins});
const forkOrigins=["https://other.example:8445"];
const fork=signed("my98/locations/v1",{origins:forkOrigins,version:1},{origins:forkOrigins});
const files=new Map();
for(const name of ["torrent-remote.js","torrent-records.js","torrent-protocol.js","torrent-store.js","torrent-sources.js","load-profiles.js","range-prefetch.js","startup-prefetch.js"])
    files.set("/"+name,await readFile("src/disk/web/"+name));
for(const name of ["slop86_disk.js","slop86_disk_bg.wasm"])
    files.set("/pkg/"+name,await readFile("build/disk/pkg/"+name));
const server=createServer((req,res)=>{
    const data=files.get(req.url);
    res.writeHead(200,{"Content-Type":data?(req.url.endsWith(".wasm")?"application/wasm":"text/javascript"):"text/html"});
    res.end(data||"<!doctype html>");
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
try {
    for(const [browserName,type] of Object.entries({chromium,webkit})) {
        const browser=await type.launch();
        try {
            for(const mode of ["absent","unavailable","network","invalid","malformed","conflict","valid","delayed-valid","delayed-absent","pending-close","cancel","bad-publication","no-publication"]) {
                const page=await browser.newPage();
                try {
                    await page.goto("http://127.0.0.1:"+server.address().port);
                    await page.evaluate(async({mode,publication,locations,fork,objects,disk})=>{
                        const {default:init,verify}=await import("/pkg/slop86_disk.js");await init();
                        const {RemotePublication}=await import("/torrent-remote.js");
                        const {cachedRecord}=await import("/torrent-records.js");
                        const assert=(ok,message)=>{if(!ok)throw Error(message);};
                        const controller=new AbortController(),calls=[];
                        let release,aborted=0;
                        const gate=new Promise(resolve=>{release=resolve;});
                        globalThis.fetch=async(url,{signal}={})=>{
                            if(url.endsWith(publication.salt)) {
                                if(mode==="no-publication")return new Response(null,{status:404});
                                return Response.json(mode==="bad-publication"?{...publication,signature:"00".repeat(64)}:publication);
                            }
                            if(mode==="cancel") {
                                controller.abort(Object.assign(Error("Cancelled"),{code:"CANCELLED"}));
                                throw signal.reason;
                            }
                            if(mode==="network")throw new TypeError("Network unavailable");
                            if(mode.startsWith("delayed-") || mode==="pending-close")await new Promise((resolve,reject)=>{
                                const abort=()=>{aborted++;reject(signal.reason);};
                                signal.addEventListener("abort",abort,{once:true});
                                gate.then(()=>{signal.removeEventListener("abort",abort);resolve();});
                                if(signal.aborted)abort();
                            });
                            if(mode==="delayed-absent")return new Response(null,{status:404});
                            if(mode==="absent" || mode==="unavailable")return new Response(null,{status:mode==="absent"?404:503});
                            if(mode==="malformed")return new Response("invalid JSON");
                            if(mode==="invalid")return Response.json({...locations,origins:["https://attacker.example"]});
                            return Response.json(mode==="conflict" && url.includes("/second/")?fork:locations);
                        };
                        const io={notify(){},async call(op,args) {
                            calls.push({op,args});
                            if(op==="metadata")return new Uint8Array(objects[args.infoHash].metadata);
                            if(op==="read")return new Uint8Array(objects[args.infoHash].data).slice(args.offset,args.offset+args.length);
                        }};
                        let remote,error;
                        try {
                            remote=await RemotePublication.open(io,{owner:publication.publicKey,verifySignature:verify,signal:controller.signal,
                                sources:{apis:[location.origin+"/first",location.origin+"/second"],
                                    trackers:["wss://tracker.example"],webseeds:["https://unsigned.example/content"]}});
                        } catch(cause){error=cause;}
                        if(["cancel","bad-publication","no-publication"].includes(mode)) {
                            assert(error,"Required publication or cancellation was ignored");
                            assert(!calls.length,"Transport started after cancellation or without an authentic publication");
                            if(mode==="cancel")assert(error.code==="CANCELLED","Cancellation was swallowed");
                            if(mode==="no-publication")assert(error.code==="NO_PUBLICATION","Absent publication was swallowed");
                            return;
                        }
                        assert(!error,"Optional locations blocked opening: "+error?.message);
                        try {
                            assert(remote.remote.infoHash===disk,"Wrong disk was opened");
                            assert((await remote.read(0,4)).join(",")==="1,2,3,4","Payload read failed");
                            const initial=calls.find(call=>call.op==="create").args.sources;
                            assert(!initial.apis.length && !initial.webseeds.length,"Opening waited for optional HTTPS sources");
                            if(mode==="pending-close") {
                                await remote.close();assert(aborted===2,"Closing did not abort pending location requests");
                                release();await Promise.resolve();
                                assert(!calls.some(call=>call.op==="sources"),"Closed session received late sources");return;
                            }
                            release();await remote.locationsTask;
                            const sources=calls.findLast(call=>call.op==="sources").args.sources,valid=mode==="valid" || mode==="delayed-valid";
                            assert(sources.trackers.join() === "wss://tracker.example","WebRTC tracker was lost");
                            assert(JSON.stringify(sources.apis)===JSON.stringify(valid?locations.origins:[]),"Unexpected metadata origins");
                            assert(JSON.stringify(sources.webseeds)===JSON.stringify(valid?locations.origins.map(origin=>origin+"/content"):[]),"Unverified webseed was used");
                            assert(!!await cachedRecord(publication.publicKey,verify,true)===valid,"Invalid or conflicting locations were persisted");
                        } finally {await remote.close();}
                    },{mode,publication,locations,fork,objects,disk});
                    console.log(JSON.stringify({browser:browserName,mode,passed:true}));
                } finally {await page.close();}
            }
        } finally {await browser.close();}
    }
} finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
