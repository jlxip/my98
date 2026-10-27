import assert from "node:assert/strict";
import {createServer} from "node:http";
import {readFile,writeFile,mkdir} from "node:fs/promises";
import {resolve,extname,sep} from "node:path";
import {createHash,createPrivateKey,createPublicKey,sign} from "node:crypto";
import {chromium,webkit} from "playwright";
import {offlineRelayDiscovery} from "./pages/server.mjs";
import {diskFixture} from "./pages/fixture.mjs";
import {diskAction} from "./pages/encrypted.mjs";

// Disposable public fixture identity; no user credentials or private VM files.
// Frozen Python Argon2/HKDF result for the credentials above, public by design.
const seed=Buffer.from("c80e4484997cdd302848d0348e56e84e089089fe14e03dcf681fe9ce0ba76944","hex");
const key=createPrivateKey({key:Buffer.concat([Buffer.from("302e020100300506032b657004220420","hex"),seed]),format:"der",type:"pkcs8"});
seed.fill(0);
const publicKey=createPublicKey(key).export({format:"der",type:"spki"}).subarray(-32).toString("hex");
const salt=Buffer.from("my98/publication/v1"),root=resolve("."),objects=new Map(),results=[],requests=[];
const assets=JSON.parse(await readFile("scripts/site-assets.json","utf8"));
const fixture=await diskFixture({sizeBytes:2*1024*1024});
const encrypted=await readFile(fixture.file);
function encode(value) {
    if(Number.isInteger(value))return Buffer.from("i"+value+"e");
    if(typeof value==="string")value=Buffer.from(value);
    if(value instanceof Uint8Array)return Buffer.concat([Buffer.from(value.length+":"),value]);
    if(Array.isArray(value))return Buffer.concat([Buffer.from("l"),...value.map(encode),Buffer.from("e")]);
    return Buffer.concat([Buffer.from("d"),...Object.keys(value).sort().flatMap(k=>[encode(k),encode(value[k])]),Buffer.from("e")]);
}
function add(data,name) {
    const pieces=[];
    for(let offset=0;offset<data.length;offset+=262144)pieces.push(createHash("sha1").update(data.subarray(offset,offset+262144)).digest());
    const info={name,length:data.length,"piece length":262144,pieces:Buffer.concat(pieces)},hash=createHash("sha1").update(encode(info)).digest("hex");
    objects.set(hash,{data,name,metadata:encode({info}),info:encode(info)});return hash;
}
const disk=add(encrypted,"disk.my98");
let record,descriptor,mode="online",sequence=1000;
function publish(state) {
    const stateHash=add(state,"state.my98state"),stateSha=createHash("sha256").update(state).digest("hex");
    const profiles=["boot","state"].map(kind=>({version:2,infoHash:disk,unitBytes:65536,
        origin:kind==="boot"?{kind}:{kind,sha256:stateSha},ranges:[[12,12],...Array(31).fill(null)]}));
    const profile=add(Buffer.from(JSON.stringify(profiles)),"profile.json");
    descriptor=add(Buffer.from(JSON.stringify({version:1,disk,state:stateHash,profile})),"publication.json");
    const payload=Buffer.concat([Buffer.from("4:salt"+salt.length+":"),salt,Buffer.from("3:seqi"+(++sequence)+"e1:vd2:ih20:"),Buffer.from(descriptor,"hex"),Buffer.from("e")]);
    record={publicKey,sequence,infoHash:descriptor,signature:sign(null,payload,key).toString("hex"),salt:salt.toString("hex")};
}
const server=createServer(async(req,res)=>{
    const path=new URL(req.url,"http://localhost").pathname;
    const headers={"Cross-Origin-Opener-Policy":"same-origin","Cross-Origin-Embedder-Policy":"require-corp","Cache-Control":"no-store"};
    try {
        if(path==="/torrent-sources.json") {
            res.writeHead(200,{...headers,"Content-Type":"application/json"}).end(JSON.stringify({apis:[url],trackers:[],webseeds:[url+"/content"]}));return;
        }
        if(path==="/.well-known/my98-relay.json") {
            res.writeHead(200,{...headers,"Content-Type":"application/json"}).end(JSON.stringify({version:1,relay:null}));return;
        }
        if(path==="/setup" && req.method==="POST") {
            const parts=[];for await(const part of req)parts.push(part);
            publish(Buffer.concat(parts));res.writeHead(200,{...headers,"Content-Type":"application/json"}).end(JSON.stringify({descriptor,publicKey}));return;
        }
        if(path.startsWith("/mode/")){mode=path.split("/").at(-1);res.writeHead(200,headers).end();return;}
        if(path.startsWith("/v2/")||path.startsWith("/content/")) {
            if(mode==="offline"){res.writeHead(503,headers).end();return;}
            if(path==="/v2/dht/"+publicKey+"/"+salt.toString("hex")) {res.writeHead(200,{...headers,"Content-Type":"application/json"}).end(JSON.stringify(record));return;}
            if(path==="/v2/dht/"+publicKey+"/"+Buffer.from("my98/locations/v1").toString("hex")) {
                const locationsSalt=Buffer.from("my98/locations/v1"),value=encode({version:1,origins:[url]});
                const payload=Buffer.concat([Buffer.from("4:salt"+locationsSalt.length+":"),locationsSalt,Buffer.from("3:seqi1e1:v"),value]);
                res.writeHead(200,{...headers,"Content-Type":"application/json"}).end(JSON.stringify({publicKey,sequence:1,origins:[url],salt:locationsSalt.toString("hex"),signature:sign(null,payload,key).toString("hex")}));return;
            }
            const match=path.match(/^\/v2\/info\/([a-f0-9]{40})$/);
            if(match && objects.has(match[1])){res.writeHead(200,headers).end(objects.get(match[1]).info);return;}
            const content=path.match(/^\/content\/([a-f0-9]{40})\/([^/]+)$/),object=objects.get(content?.[1]);
            if(object && content[2]===object.name) {
                const range=req.headers.range?.match(/^bytes=(\d+)-(\d+)$/);requests.push({hash:content[1],range:req.headers.range});
                if(!range){res.writeHead(400,headers).end();return;}
                const first=+range[1],last=Math.min(+range[2],object.data.length-1),bytes=object.data.subarray(first,last+1);
                res.writeHead(206,{...headers,"Content-Length":bytes.length,"Content-Range":"bytes "+first+"-"+last+"/"+object.data.length,"Accept-Ranges":"bytes"}).end(bytes);return;
            }
            res.writeHead(404,headers).end();return;
        }
        if(path==="/fixture"){res.writeHead(200,{...headers,"Content-Type":"text/html"}).end("<!doctype html>");return;}
        const file=resolve(root,assets[path==="/"?"index.html":path.slice(1)]||("."+path));
        if(!file.startsWith(root+sep))throw Error("path");
        const type={".js":"text/javascript",".mjs":"text/javascript",".css":"text/css",".html":"text/html",".wasm":"application/wasm"}[extname(file)]||"application/octet-stream";
        res.writeHead(200,{...headers,"Content-Type":type}).end(await readFile(file));
    } catch {if(!res.headersSent)res.writeHead(404,headers);res.end();}
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const url="http://127.0.0.1:"+server.address().port;
try {
    for(const [name,type] of Object.entries({chromium,webkit})) {
        mode="online";
        const browser=await type.launch();
        try {
            const page=await browser.newPage(),errors=[],external=[];
            page.on("pageerror",error=>{errors.push(String(error));console.error(name,"page error",error.stack);});
            // WebKit reads cloned Files/Blobs through same-origin blob URLs.
            // Their hostname is empty; origin, rather than hostname, is decisive.
            await page.route("**/*",route=>{
                const target=new URL(route.request().url());
                if(target.origin!==url){external.push(target.href);return route.abort();}
                return route.continue();
            });
            await page.addInitScript(()=>{for(const name of ["RTCPeerConnection","webkitRTCPeerConnection","mozRTCPeerConnection"])
                Object.defineProperty(globalThis,name,{value:undefined,configurable:true});});
            await page.addInitScript(()=>{
                if(navigator.storage?.getDirectory)navigator.storage.getDirectory=()=>{throw Error("Unused OPFS adapter was included");};
            });
            await page.addInitScript(offlineRelayDiscovery);
            await page.goto(url+"/fixture");
            await page.evaluate(()=>document.body.innerHTML='<input id="fixture-file" type="file">');
            await page.locator("#fixture-file").setInputFiles(fixture.file);
            const result=await page.evaluate(async({url,diskHash})=>{
                const {Slop86Disk,DiskBuffer}=await import("/build/disk/web/client.js");
                const assert=(value,message)=>{if(!value)throw Error(message);};
                const owner=await Slop86Disk.create();
                let remote,reader,machine,adapter,stage="local fixture";
                try {
                    stage="local unlock";await owner.unlock("disk fixtures","public compatibility password","main");
                    stage="local open";await owner.open(document.querySelector("#fixture-file").files[0]);
                    stage="export capability";const readKey=await owner.exportReadOnlyKey();
                    stage="local write";await owner.write(10000,new Uint8Array([42]));
                    stage="local state";const state=await owner.saveState(new Uint8Array([10,20,30,40]).buffer,{version:1,compatibility:"remote-fixture",config:{},running:false});
                    const response=await fetch("/setup",{method:"POST",body:state.blob}),publication=await response.json();
                    const sources={apis:[url],trackers:[],webseeds:[url+"/content"]};
                    remote=await Slop86Disk.create();
                    await remote.unlock("disk fixtures","public compatibility password","main");
                    stage="open by key";const opened=await remote.openRemote({publicKey:publication.publicKey,sources,prefetchScope:"none"});
                    assert(opened.size===2*1024*1024 && opened.remote.infoHash===diskHash,"Remote disk identity/size changed");
                    assert(opened.remote.stateInfoHash && opened.remote.profileInfoHash,"Missing component references");
                    stage="encrypted read";const first=await remote.read(0,4);
                    assert(first.join(",")==="250,244,235,253","Worker did not decrypt requested disk range");
                    stage="boot profile";await remote.setLoadPrefetch({origin:"boot",scope:"profile"});
                    for(let i=0;i<1000;i++) {
                        if([...remote.torrentHost.sessions.values()].every(transport=>[...transport.entries.values()].every(entry=>!entry.prefetch)))break;
                        await new Promise(resolve=>setTimeout(resolve,10));
                    }
                    const profileStats=(await remote.readStats()).remote;
                    assert(profileStats.coveredBytes>=524288,"Requested profile ranges did not finish downloading");
                    assert(!profileStats.complete,"Profile prefetch downloaded the entire disk");
                    await remote.setLoadPrefetch({origin:"boot",scope:"disk"});
                    stage="cancel resume";remote.cancel();await remote.resumePrefetch();
                    for(let i=0;i<1000;i++) {
                        if((await remote.readStats()).remote.complete)break;
                        await new Promise(resolve=>setTimeout(resolve,10));
                    }
                    assert((await remote.readStats()).remote.complete,"Encrypted background download did not complete");
                    stage="published state";const candidate=await remote.prepareState({publication:true});
                    assert(new Uint8Array(candidate.state).join(",")==="10,20,30,40","Published state changed");
                    assert((await remote.stateDisk(candidate.token).read(10000,1))[0]===42,"Published overlay did not decrypt");
                    assert((await remote.read(10000,1))[0]===0,"Preparing state changed current disk");
                    await remote.commitState(candidate.token);
                    stage="state profile";await remote.setLoadPrefetch({origin:"restored",scope:"profile"});
                    assert((await remote.read(10000,1))[0]===42,"Restored overlay missing");
                    await remote.close();remote=null;
                    reader=await Slop86Disk.create();
                    stage="capability open";const description=await reader.openRemoteReadOnly({infoHash:publication.descriptor,readKey,sources,prefetchScope:"none"});
                    assert(description.readOnly,"Remote capability opened writable");
                    stage="capability state";const restored=await reader.preparePublishedState();await reader.commitState(restored.token);
                    assert((await reader.read(10000,1))[0]===42,"Capability state restoration failed");
                    await reader.close();reader=null;
                    stage="offline reopen";await fetch("/mode/offline");
                    remote=await Slop86Disk.create();
                    await remote.unlock("disk fixtures","public compatibility password","main");
                    await remote.openRemote({publicKey:publication.publicKey,sources,prefetchScope:"none"});
                    assert((await remote.read(0,4)).join(",")==="250,244,235,253","Worker could not reopen verified cache offline");
                    await fetch("/mode/online");
                    stage="cache clear";await remote.clearCaches();
                    assert((await remote.read(0,4)).join(",")==="250,244,235,253","Read after cache cleanup failed");
                    stage="emulator boot";
                    const {createMachine,compatibility}=await import("/src/browser/machine-factory.js");
                    const {captureMachineState,restoreMachineState,DEFAULT_CONFIG}=await import("/src/browser/machine-state.js");
                    const config={...DEFAULT_CONFIG,memory_size:16*1024*1024};
                    const container=document.createElement("div");container.innerHTML="<div></div><canvas></canvas>";
                    document.body.append(container);
                    adapter=new DiskBuffer(remote,opened.size,error=>{throw error;});
                    machine=await createMachine(adapter,config,container,{disableSpeaker:true});
                    machine.run();
                    for(let i=0;i<2500;i++) {
                        if(machine.v86.cpu.in_hlt[0] && machine.v86.cpu.instruction_pointer[0]===0x7c02)break;
                        await new Promise(resolve=>setTimeout(resolve,20));
                    }
                    assert(machine.v86.cpu.instruction_pointer[0]===0x7c02,"Remote disk did not boot its halt sector");
                    machine.v86.cpu.mem8[0x70000]=41;await remote.write(10000,new Uint8Array([42]));
                    stage="emulator capture";
                    const saved=await captureMachineState({machine,adapter,disk:remote,config,compatibility:await compatibility()});
                    await machine.destroy();machine=null;adapter.dispose();adapter=null;
                    await fetch("/setup",{method:"POST",body:saved.blob});
                    await remote.close();remote=await Slop86Disk.create();
                    await remote.unlock("disk fixtures","public compatibility password","main");
                    await remote.openRemote({publicKey:publication.publicKey,sources,prefetchScope:"none"});
                    stage="emulator restore";
                    const restoredMachine=await restoreMachineState({disk:remote,input:{publication:true},
                        compatibility:await compatibility(),createMachine:(buffer,options)=>createMachine(buffer,options,container,{disableSpeaker:true})});
                    machine=restoredMachine.machine;adapter=restoredMachine.adapter;
                    assert(machine.v86.cpu.mem8[0x70000]===41,"Published emulator RAM did not restore");
                    assert((await remote.read(10000,1))[0]===42,"Published emulator disk overlay did not restore");
                    assert(machine.v86.cpu.instruction_pointer[0]===0x7c02,"Published emulator CPU did not restore");
                    await machine.destroy();machine=null;adapter.dispose();adapter=null;
                    return {readKey,emulatorBoot:true,emulatorRestore:true,encryptedRanges:true,background:true,profile:true,cancelResume:true,state:true,capability:true,offline:true,cleanup:true};
                } catch(error){throw Error(stage+": "+error.message+" ["+error.code+"]");} finally {await machine?.destroy();adapter?.dispose();await owner.close();await remote?.close();await reader?.close();}
            },{url,diskHash:disk});
            const readKey=result.readKey;delete result.readKey;
            // URL targets cannot override the public key from login or the read key.
            await page.goto(url+"/?infoHash="+"ab".repeat(20)+"&publicKey="+"cd".repeat(32));
            await page.waitForFunction(()=>!document.body.inert);
            await page.evaluate(async()=>{
                const {Slop86Disk}=await import("/build/disk/web/client.js"),create=Slop86Disk.create;
                Slop86Disk.create=async function(...args){const client=await create.apply(this,args);window.uiDisk=client;return client;};
                const {V86}=await import("/build/libv86.mjs"),restore=V86.prototype.restore_state;
                V86.prototype.restore_state=function(...args){window.uiMachine=this;return restore.apply(this,args);};
            });
            await page.locator("#disk-user").fill("disk fixtures");
            await page.locator("#disk-password").fill("public compatibility password");
            await page.locator("#disk-login button").click();
            // Login alone resolves and opens the publication; boot stays manual.
            await page.waitForFunction(()=>!document.querySelector("#disk-resume-state").disabled);
            assert.equal(await page.locator("#disk-remote").count(),0);
            assert.equal(await page.locator("#session").isVisible(),false);
            assert.equal((await page.evaluate(()=>uiDisk.describe())).remote.publicationInfoHash,descriptor);
            assert.equal((await page.evaluate(()=>uiDisk.describe())).remote.publicKey,publicKey);
            for(const width of [1280,320]) {
                await page.setViewportSize({width,height:900});
                await page.locator("#disk-menu-tools > summary").click();
                assert.equal(await page.locator("#disk-clear-cache").isVisible(),true);
                assert.equal(await page.locator("#disk-analyze").isVisible(),true);
                assert.equal(await page.locator("#disk-open").isVisible(),false);
                assert.equal(await page.locator("#disk-save-state").isVisible(),false);
                assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
                await page.screenshot({path:`build/transport-retirement/${name}-workspace-ready-${width}.png`,fullPage:true});
                await page.keyboard.press("Escape");
            }
            await page.setViewportSize({width:1280,height:900});
            await page.locator("#disk-resume-state").click();
            await page.waitForFunction(()=>!document.querySelector("#session").hidden && !document.querySelector("#pause").disabled);
            assert.equal(await page.evaluate(()=>uiMachine.v86.cpu.mem8[0x70000]),41);
            assert.equal(await page.evaluate(async()=>(await uiDisk.read(10000,1))[0]),42);
            assert.equal(await page.evaluate(async()=>(await uiDisk.readStats()).remote.scope),"profile");
            await page.screenshot({path:"build/transport-retirement/"+name+"-torrent-desktop.png",fullPage:true});
            await page.setViewportSize({width:390,height:844});
            await page.screenshot({path:"build/transport-retirement/"+name+"-torrent-mobile.png",fullPage:true});
            assert.equal(await page.locator("#disk-boot").isVisible(),false);
            const savedState=page.waitForEvent("download");
            await diskAction(page,"disk-save-state");
            assert.match((await savedState).suggestedFilename(),/\.my98state$/);
            await page.waitForFunction(()=>!document.querySelector("#disk-save-state").disabled);
            await diskAction(page,"disk-clear-cache");
            await page.waitForFunction(()=>document.querySelector("#disk-status").textContent.startsWith("Cached pieces cleared."));
            assert.equal(await page.evaluate(()=>uiMachine.v86.cpu.mem8[0x70000]),41);
            assert.equal(await page.evaluate(async()=>(await uiDisk.read(10000,1))[0]),42);
            page.on("dialog",dialog=>dialog.accept());
            await page.locator("#disk-close").click();
            await page.waitForFunction(()=>!document.querySelector("#disk-login").hidden);
            await page.getByRole("button",{name:"Or use a read key",exact:true}).click();
            await page.locator("#disk-read-key").fill(readKey);
            await page.locator("#disk-reader button").click();
            await page.waitForFunction(()=>!document.querySelector("#disk-boot").disabled);
            assert.equal(await page.locator("#disk-read-key").inputValue(),"");
            assert.equal((await page.evaluate(()=>uiDisk.describe())).readOnly,true);
            assert.equal((await page.evaluate(()=>uiDisk.describe())).remote.publicationInfoHash,descriptor);
            assert.equal((await page.evaluate(()=>uiDisk.describe())).remote.publicKey,publicKey);
            assert.equal(await page.locator("#disk-relay-key").isDisabled(),true);
            await page.locator("#disk-menu-tools > summary").click();
            assert.equal(await page.locator("#disk-relay-key").isVisible(),false);
            assert.equal(await page.locator("#disk-clear-cache").isVisible(),true);
            await page.keyboard.press("Escape");
            await page.locator("#disk-menu-state > summary").click();
            assert.equal(await page.locator("#disk-save-state").isVisible(),false);
            assert.equal(await page.locator("#disk-load-state").isVisible(),true);
            await page.keyboard.press("Escape");
            await page.locator("#disk-close").click();
            await page.waitForFunction(()=>!document.querySelector("#disk-reader").hidden);
            await page.getByRole("button",{name:"Or log in",exact:true}).click();
            result.publicationUI=true;result.readOnlyUI=true;
            assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
            results.push({browser:name,...result});console.log(JSON.stringify(results.at(-1)));
        } finally {await browser.close();}
    }
} finally {
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fixture.close();
    await mkdir("build/transport-retirement",{recursive:true});
    await writeFile("build/transport-retirement/torrent-client.json",JSON.stringify({results,requests},null,2)+"\n");
}
