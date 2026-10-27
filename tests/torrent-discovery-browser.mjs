import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdir,readFile,writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {chromium,webkit} from "playwright";
import {diskFixture} from "./pages/fixture.mjs";
import {serveSite,offlineRelayDiscovery} from "./pages/server.mjs";

const directory=resolve("build/ans250/native-browser-"+Date.now());await mkdir(directory,{recursive:true});
const fixture=await diskFixture({sizeBytes:2*1024*1024});
const python=process.env.TORRENT_PYTHON||"build/torrent-native/mac/venv/bin/python";
const external=process.env.MY98_DISCOVERY_INFO;
const native=external?null:spawn(python,["tests/torrent-discovery-fixture.py","--root",directory,"--disk",fixture.file],{env:{...process.env,PYTHONDONTWRITEBYTECODE:"1"},stdio:["ignore","pipe","pipe"]});
let output="",errors="";native?.stdout.on("data",data=>{output+=data;});native?.stderr.on("data",data=>{errors+=data;});
const completed=native?new Promise(resolve=>native.once("exit",(code,signal)=>resolve({code,signal}))):null;
const options={headers:true};let server;const results=[];
try {
    let info=external?JSON.parse(await readFile(external,"utf8")):null;const deadline=Date.now()+90000;
    while(!info) {
        const line=output.split("\n").find(line=>line.startsWith("{"));if(line){info=JSON.parse(line);break;}
        if(native.exitCode!==null)throw Error("Native fixture exited: "+errors);
        if(Date.now()>deadline)throw Error("Native fixture did not become ready: "+errors);
        await new Promise(resolve=>setTimeout(resolve,50));
    }
    options.sources={apis:[info.resolver],trackers:[],webseeds:[]};server=await serveSite(options);
    for(const [name,type] of Object.entries({chromium,webkit})) {
        const browser=await type.launch();
        try {
            const page=await browser.newPage({ignoreHTTPSErrors:!!info.fixtureCertificate}),requests=[],failures=[];
            page.on("pageerror",error=>failures.push(String(error)));page.on("request",request=>requests.push(request.url()));
            await page.addInitScript(offlineRelayDiscovery);
            await page.addInitScript(()=>{for(const name of ["RTCPeerConnection","webkitRTCPeerConnection","mozRTCPeerConnection"])Object.defineProperty(globalThis,name,{value:undefined,configurable:true});});
            await page.goto(server.url);await page.waitForFunction(()=>!document.body.inert);
            await page.locator("#disk-user").fill("disk fixtures");await page.locator("#disk-password").fill("public compatibility password");
            await page.locator("#disk-machine").fill("main");await page.locator("#disk-login button[type=submit]").click();
            try {await page.locator("#disk-boot").waitFor({state:"visible",timeout:45000});}
            catch(error) {
                await writeFile(directory+"/"+name+"-failure.json",JSON.stringify({status:await page.locator("#disk-status").textContent(),requests,failures},null,2));
                throw error;
            }
            assert.equal((await page.locator("#disk-identity").textContent()).trim(),info.publicKey);
            await page.locator("#disk-boot").click();await page.waitForFunction(()=>!document.querySelector("#session").hidden);
            assert(requests.some(url=>url.startsWith(info.resolver+"/v2/dht/")));
            assert(requests.some(url=>url.startsWith(info.seedbox+"/v2/info/")));
            assert(requests.some(url=>url.startsWith(info.seedbox+"/content/")));
            assert(!requests.some(url=>url.includes(".torrent")));
            assert(!requests.some(url=>url.startsWith(info.resolver+"/v2/info/")));
            assert.deepEqual(failures,[]);
            results.push({browser:name,credentialsOnly:true,nativePublisherClosed:true,unrelatedPublicResolver:true,
                signedLocations:true,seedboxDiscovered:true,noWebRTC:true,noTorrentFiles:true,encryptedGuestBoot:true});
            console.log(JSON.stringify(results.at(-1)));
        } finally {await browser.close();}
    }
} finally {
    if(native?.exitCode===null)native.kill("SIGTERM");
    const timer=native?setTimeout(()=>native.kill("SIGKILL"),10000):null;const done=completed?await completed:{code:0};clearTimeout(timer);
    await writeFile(directory+"/native.stderr",errors);
    if(server)await server.close();await fixture.close();
    await writeFile(directory+"/browser-results.json",JSON.stringify(results,null,2));
    assert.equal(done.code,0,"Native fixture cleanup failed: "+errors);
}
if(external){await writeFile("build/ans250/openbsd-browser.json",JSON.stringify({results,externalFixture:true},null,2));process.exit(0);}
const nativeResult=JSON.parse(await readFile(directory+"/result.json","utf8"));
assert(nativeResult.resolverStoresNoTorrents&&nativeResult.noTorrentFilesRequested);
await writeFile("build/ans250/native-browser.json",JSON.stringify({results,native:nativeResult},null,2));
