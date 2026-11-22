import {serveSite,quietAudio} from './pages/server.mjs';
/** Real private DHT + WSS + native CLI/FeedTorrent + shipped browser consumer. */
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir,rm,stat,access} from 'node:fs/promises';
import {resolve,join,extname,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,createPublicKey,verify} from 'node:crypto';
import {key as fixtureKey} from './feedtorrent-fixture.mjs';
const {chromium,firefox,webkit}=process.env.MY98_NATIVE_ONLY?{}:await import('playwright');
const {browserOptions}=process.env.MY98_NATIVE_ONLY?{browserOptions:()=>({})}:await import('./browser-options.mjs');
const root=resolve('.'),ft=resolve(process.env.MY98_FEEDTORRENT_TEST_ROOT||join(root,'build/feedtorrent')),output=join(root,'build/feedtorrent-test');
await mkdir(output,{recursive:true});
process.chdir(ft);
const {dhtNetwork,startApp,wait}=await import(pathToFileURL(join(ft,'dev/tests/helpers.mjs')));
const {signaling}=await import(pathToFileURL(join(ft,'dev/tests/webtorrent-fixture.mjs')));
const {proxy,freePort}=await import(pathToFileURL(join(ft,'dev/tests/dht-gateway-fixture.mjs')));
const runtime=join(output,'run-'+Date.now());await mkdir(runtime);
let network,tr,app,gateway,server,appSite,cli,browser;const results=[];
const digest=b=>createHash('sha256').update(b).digest('hex');
function check(sig,message,pk){try{return verify(null,message,createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),pk]),format:'der',type:'spki'}),sig)}catch{return false}}
async function stopCli(){if(!cli || cli.exitCode!==null)return;const done=once(cli,'exit');cli.kill('SIGTERM');const timeout=setTimeout(()=>cli.kill('SIGKILL'),10000);const [code,signal]=await done;clearTimeout(timeout);assert.equal(code,0,`CLI exit ${code}/${signal}: ${cli.logs}`);}
async function startCli(args,input){
 const child=spawn(process.env.MY98_TORRENT_BIN||join(root,'build/torrent-target/release/my98-torrent'),['--root',join(runtime,'publisher'),'--config',join(runtime,'sources.json'),'--isolated','--dht-bootstrap',network.bootstrap.map(n=>`${n.host}:${n.port}`).join(','),...args],{env:tr.env,stdio:['pipe','pipe','pipe']});
 child.logs='';child.stdout.on('data',b=>child.logs+=b);child.stderr.on('data',b=>child.logs+=b);child.stdin.end(input);cli=child;
 await wait(()=>{if(child.exitCode!==null)throw Error(child.logs);return child.logs.includes('Seeding until interrupted.')},'CLI DHT acknowledgement',90000);
 return JSON.parse(await readFile(join(runtime,'publisher/publication.json'),'utf8'));
}
async function loginPublication(page) {
 await page.locator('#disk-user').fill('disk fixtures');await page.locator('#disk-password').fill('public compatibility password');await page.locator('#disk-login button').click();
}
async function hookMachine(page) {
 await page.evaluate(async()=>{
  const {V86}=await import('./build/libv86.mjs');
  for(const method of ['run','restore_state']){const original=V86.prototype[method];V86.prototype[method]=function(...args){window.fixtureVm=this;return original.apply(this,args);};}
 });
}
async function copied(journal,timeout=90000){await wait(async()=>{const snapshot=await app.api();return journal.torrents.every(t=>snapshot.transfers.some(x=>x.id===t.id && x.total>0 && x.verified===x.total && !x.error))},'complete remote snapshot',timeout)}
try {
 network=await dhtNetwork({verify:check});await wait(()=>network.nodes.every(n=>n.nodes.toArray().length===2),'DHT routing');
 tr=await signaling(join(runtime,'tls'));
 const bootstrap=network.bootstrap.map(n=>`${n.host}:${n.port}`).join(',');
 app=await startApp(join(runtime,'replica'),['--dht-bootstrap',bootstrap],{env:tr.env});
 const port=await freePort();
 await app.command({type:'configure',settings:{...(await app.api()).settings,webtorrent_trackers:[tr.url],webtorrent_stun_server:'',dht_gateway:{enabled:true,listen:'127.0.0.1:'+port}}});
 gateway=await proxy(join(runtime,'proxy'),'http://127.0.0.1:'+port);
 await writeFile(join(runtime,'sources.json'),JSON.stringify({gateways:[gateway.url],trackers:[tr.url]}));
 if(!process.env.MY98_NATIVE_ONLY)appSite=await serveSite({root:join(root,'build/site'),headers:true,sources:{gateways:[gateway.url],trackers:[tr.url]}});
 const raw=process.env.MY98_WIN98_IMAGE||join(runtime,'disk.img'),disk=join(runtime,'disk.my98');
 const bytes=Buffer.alloc(1024*1024,17);bytes.set([0xfa,0xf4,0xeb,0xfd]);bytes[510]=85;bytes[511]=170;if(!process.env.MY98_WIN98_IMAGE)await writeFile(raw,bytes);
 execFileSync(join(root,'build/disk-target/release/examples/compat'),['pack',raw,disk],{cwd:root});
 const first=await startCli(['publish',disk],'disk fixtures\npublic compatibility password\n');
 const follow=`magnet:?xs=urn:btpk:${first.record.key}&s=${first.record.salt}`;
 assert.equal(first.record.key,fixtureKey);
 await app.command({type:'follow_post',uri:follow,config:{name:'my98 fixture',mode:'mirror_all',automatic_limit:null}});
 await copied(first);await stopCli();
 const saved=JSON.parse(await readFile(join(runtime,'publisher/publication.json'),'utf8'));
 const resumed=await startCli(['resume']);assert.deepEqual(resumed,saved);await stopCli();
 let state;
 if(!process.env.MY98_NATIVE_ONLY) {
  // Chromium off-the-record IndexedDB is memory backed; a real 1GiB disk
  // needs a test-owned persistent profile, as in normal desktop browsing.
  let context;
  if(process.env.MY98_WIN98_IMAGE){context=await chromium.launchPersistentContext(join(runtime,'windows-capture-profile'),{ignoreHTTPSErrors:true,acceptDownloads:true});browser=context;}
  else {browser=await chromium.launch();context=await browser.newContext({ignoreHTTPSErrors:true,acceptDownloads:true});}
  try {await context.addInitScript(quietAudio);
   await context.addInitScript(()=>{const RTC=globalThis.RTCPeerConnection;globalThis.RTCPeerConnection=new Proxy(RTC,{construct(Target,args,newTarget){args[0]={...args[0],iceServers:[]};return Reflect.construct(Target,args,newTarget);}});});
   const page=await context.newPage();page.setDefaultTimeout(150000);page.on("pageerror",e=>console.error("capture page",e));page.on("requestfailed",r=>console.error("capture request",r.url(),r.failure()));await page.goto(tr.page);await page.goto(appSite.url);await page.waitForFunction(()=>!document.body.inert);await hookMachine(page);await loginPublication(page);
   await page.waitForFunction(()=>!document.querySelector('#disk-boot').disabled,{},{timeout:120000});await page.locator('#disk-boot').click();
   if(process.env.MY98_WIN98_IMAGE) {
    const gate=join(runtime,'windows-desktop-accepted');console.log('WINDOWS_DESKTOP_GATE',gate);
    const deadline=Date.now()+600000;
    for(;;){
     const keyFile=join(runtime,'windows-key.txt'),key=await readFile(keyFile,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
     if(key){assert(['Enter','Escape','Alt+F4'].includes(key.trim()),'Unsupported Windows test key');await rm(keyFile);await page.keyboard.press(key.trim());}
     await page.screenshot({path:join(runtime,'windows-live.png')});assert(!/disk stopped:/i.test(await page.locator('#disk-status').textContent()),await page.locator('#disk-status').textContent());if(await access(gate).then(()=>true,()=>false))break;assert(Date.now()<deadline,'Windows desktop acceptance timed out');await new Promise(r=>setTimeout(r,2000));}
    }else await page.waitForFunction(()=>window.fixtureVm?.v86.cpu.in_hlt[0] && fixtureVm.v86.cpu.instruction_pointer[0]===0x7c02,{},{timeout:60000}).catch(async error=>{await page.screenshot({path:join(runtime,'capture-error.png')});error.message+=' '+await page.evaluate(()=>({status:document.querySelector('#disk-status').textContent,session:document.querySelector('#session-status').textContent,vm:window.fixtureVm?{ip:fixtureVm.v86.cpu.instruction_pointer[0],halt:fixtureVm.v86.cpu.in_hlt[0],memory:fixtureVm.v86.cpu.mem8.length}:null})).then(JSON.stringify);throw error;});
   assert.equal(await page.evaluate(()=>fixtureVm.v86.cpu.mem8.length),512*1024*1024);
   await page.evaluate(()=>{if(document.querySelector('#vm-view').classList.contains('expanded'))document.querySelector('#fullscreen').click();});
   await page.locator('#pause').click();if(!process.env.MY98_WIN98_IMAGE)await page.evaluate(()=>fixtureVm.v86.cpu.mem8[0x70000]=93);
   await page.screenshot({path:join(runtime,'session-before-save.png')});
   const pending=page.waitForEvent('download',{timeout:120000});await page.locator('#save-state').click();
   state=join(runtime,'session.my98state');await(await pending).saveAs(state);console.log('512MiB session captured');
  }finally{await browser.close();browser=undefined;}
 }
 const diskId=first.torrents[0].id,profile=join(runtime,'profile.json');
 const profiles=[{version:2,infoHash:diskId,unitBytes:65536,origin:{kind:'boot'},ranges:[[0,0],...Array(31).fill(null)]}];
 if(state)profiles.push({...profiles[0],origin:{kind:'state',sha256:digest(await readFile(state))}});
 await writeFile(profile,JSON.stringify(profiles));
 const second=await startCli(['publish',disk,'--profile',profile,...(state?['--state',state]:[])],'disk fixtures\npublic compatibility password\n');
 assert(BigInt(second.record.sequence)>BigInt(first.record.sequence));
 const post=(await app.api()).posts.find(p=>p.magnet===follow);assert(post,'Followed post missing');
 if(process.env.MY98_REFRESH_TEST)await app.command({type:'refresh_post',id:post.id});
 console.log(process.env.MY98_REFRESH_TEST?'Explicit test refresh':'Waiting for automatic FeedTorrent polling');await copied(second,process.env.MY98_REFRESH_TEST?90000:17*60*1000);await stopCli();
 assert.equal(second.torrents.length,state?4:3);assert(!JSON.stringify(second).includes('compatibility password'));
 // All browser bytes must come from the replica after the CLI has exited.
 const requests=[];
 server=createServer(async(req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  try {
   if(path==='/'){res.writeHead(200,{'Content-Type':'text/html'}).end('<!doctype html><title>my98 transport fixture</title>');return;}
   const file=resolve(root,'.'+path);assert(file.startsWith(root+sep));const data=await readFile(file);
   res.writeHead(200,{'Content-Type':extname(file)==='.js'?'text/javascript':extname(file)==='.wasm'?'application/wasm':'application/octet-stream','Cache-Control':'no-store'}).end(data);
  }catch{res.writeHead(404).end();}
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url='http://127.0.0.1:'+server.address().port;
 for(const [name,type]of Object.entries(process.env.MY98_NATIVE_ONLY?{}:{chromium,firefox,webkit}).filter(([name])=>!process.env.MY98_BROWSERS||process.env.MY98_BROWSERS.split(',').includes(name))) {
  console.log(name,'starting transport');
  browser=process.env.MY98_WIN98_IMAGE?await type.launchPersistentContext(join(runtime,name+'-restore-profile'),{...browserOptions(name),ignoreHTTPSErrors:true}):await type.launch(browserOptions(name));
  try {
   const page=process.env.MY98_WIN98_IMAGE?await browser.newPage():await browser.newPage({ignoreHTTPSErrors:true});page.setDefaultTimeout(150000);await page.addInitScript(()=>{const RTC=globalThis.RTCPeerConnection;globalThis.RTCPeerConnection=new Proxy(RTC,{construct(Target,args,newTarget){args[0]={...args[0],iceServers:[]};return Reflect.construct(Target,args,newTarget);}});});page.on('request',request=>requests.push(request.url()));
   page.on('pageerror',error=>console.error(name,error));
   let publicationRequests=0;
   await page.route(gateway.url+'/dht/mutable/**',route=>{
    if(++publicationRequests===1)return route.fulfill({status:200,contentType:'text/event-stream',headers:{'Access-Control-Allow-Origin':'*'},body:'event: done\ndata: '+JSON.stringify({record:null,error:{status:503,message:'DHT gateway unavailable'}})+'\n\n'});
    return route.continue();
   });
   await page.goto(tr.page);await page.goto(url);
   let value={sequence:second.record.sequence};
   if(!process.env.MY98_WIN98_IMAGE){value=await page.evaluate(async({key,gateway,tracker})=>{
    const {RemotePublication}=await import('/src/disk/web/torrent-remote.js');
    const {WindowTorrents}=await import('/src/disk/web/torrent-window.js');
    const {TorrentPort,WindowTorrentPort}=await import('/src/disk/web/torrent-port.js');
    const {default:WebTorrent}=await import('/build/torrent/webtorrent.min.js');
    const {default:init,verify}=await import('/build/disk/pkg/slop86_disk.js');await init();
    const wires=[];class Client extends WebTorrent {constructor(options){super({...options,tracker:{rtcConfig:{iceServers:[]}}});}add(...args){const torrent=super.add(...args);torrent.on('wire',wire=>wires.push(wire.type));return torrent;}}
    const channel=new MessageChannel();const dispatch=new WindowTorrentPort(channel.port1,(sources,onProgress)=>new WindowTorrents({sources,onProgress,clientFactory:async()=>Client,timeout:60000}));
    const io=new TorrentPort(channel.port2);let remote;
    const call=io.call.bind(io);io.call=async(op,args,...rest)=>{try{return await call(op,args,...rest)}catch(error){error.message+=' '+JSON.stringify({op,hash:args?.infoHash,offset:args?.offset,length:args?.length,transfers:[...dispatch.sessions.values()].flatMap(t=>[...t.entries.values()].map(e=>({kind:e.kind,size:e.size,wires:e.torrent.wires.map(w=>({type:w.type,choking:w.peerChoking,downloaded:w.downloaded})),verified:t.describe(e)})))});throw error;}};
    try {
     remote=await RemotePublication.open(io,{publicKey:key,owner:key,sources:{gateways:[gateway],trackers:[tracker]},verifySignature:verify});
     const chunks=[];for(let offset=0;offset<remote.size;offset+=1024*1024)chunks.push(await remote.read(offset,Math.min(1024*1024,remote.size-offset)));
     const all=new Uint8Array(remote.size);let offset=0;for(const part of chunks){all.set(part,offset);offset+=part.length;}
     const metadata=await remote.torrent(remote.publication.profile,'profile');const profile=await remote.bytes(remote.publication.profile,0,metadata.size);
     const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',all)),b=>b.toString(16).padStart(2,'0')).join('');
     const stateInput=await remote.stateInput();let stateHash=null;
     if(stateInput){const state=await new Response(stateInput.stream).arrayBuffer();stateHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',state)),b=>b.toString(16).padStart(2,'0')).join('');}
     if(wires.length===0 || wires.some(type=>type!=='webrtc'))throw Error('Non-WebRTC transport: '+wires);
     return {hash,stateHash,profile:JSON.parse(new TextDecoder().decode(profile)),wires,sequence:remote.remote.sequence};
    }finally{await remote?.close();io.close();await dispatch.close();}
   },{key:second.record.key,gateway:gateway.url,tracker:tr.url});
   assert.equal(value.hash,digest(await readFile(disk)));assert.equal(value.profile[0].infoHash,diskId);assert.equal(value.sequence,second.record.sequence);
   if(state)assert.equal(value.stateHash,digest(await readFile(state)));
   }
   if(!process.env.MY98_WIN98_IMAGE)assert(publicationRequests>=2,'Cold reader did not recover from SSE503');
   publicationRequests=0;
   await page.goto(appSite.url);await page.waitForFunction(()=>!document.body.inert);await hookMachine(page);await loginPublication(page);
   await page.waitForFunction(()=>!document.querySelector('#disk-resume-state').disabled && !document.querySelector('#disk-resume-state').hidden,{},{timeout:120000});
   assert(publicationRequests>=2,'Shipped Worker did not recover from SSE503');
   await page.locator('#disk-resume-state').click();
   await page.waitForFunction(win=>window.fixtureVm?.v86.cpu.mem8 && (win||fixtureVm.v86.cpu.mem8[0x70000]===93) && !document.querySelector('#session').hidden,!!process.env.MY98_WIN98_IMAGE,{timeout:120000});
   await page.waitForFunction(()=>document.querySelector('#session-status').textContent.includes('State restored') && document.querySelector('#disk-status').textContent.includes('State restored'),{},{timeout:120000});
   await page.screenshot({path:join(runtime,name+'-restored.png')});
   assert.equal(await page.evaluate(()=>fixtureVm.v86.cpu.mem8.length),512*1024*1024);
   results.push({browser:name,transientSSE503Recovered:true,exact:true,webRTCOnly:true,profile:true,stateRestored:true,memoryMiB:512,sequence:value.sequence});console.log(name,'transport and restored session PASS');
  }finally{await browser.close();browser=undefined;}
 }
 assert(!requests.some(url=>/\/v2\/|\/content\//.test(url)), 'Legacy transport request');
 // A new full snapshot must remove roles omitted by the publisher. Refresh only
 // this third snapshot; the second update above exercises ordinary polling.
 const diskOnly=await startCli(['publish',disk],'disk fixtures\npublic compatibility password\n');
 assert.equal(diskOnly.torrents.length,2);assert(BigInt(diskOnly.record.sequence)>BigInt(second.record.sequence));
 assert.equal(diskOnly.torrents[0].id,diskId);
 await app.command({type:'refresh_post',id:post.id});await copied(diskOnly);await stopCli();
 await app.stop();app=undefined;
 // A fresh reader with no replica and no cache must fail without fabricating data.
 if(!process.env.MY98_NATIVE_ONLY){
 browser=await chromium.launch();const page=await browser.newPage({ignoreHTTPSErrors:true});await page.goto(url);
 const unavailable=await page.evaluate(async({hash,tracker})=>{
  const {WindowTorrents}=await import('/src/disk/web/torrent-window.js');const {default:WebTorrent}=await import('/build/torrent/webtorrent.min.js');
  const transport=new WindowTorrents({sources:{gateways:[],trackers:[tracker]},clientFactory:async()=>WebTorrent,timeout:500});
  try{await transport.open({infoHash:hash,kind:'catalog'});return false}catch(error){return error.code==='TRANSPORT_TIMEOUT'}finally{await transport.close()}
 },{hash:second.torrents.at(-1).id,tracker:tr.url});assert(unavailable);await browser.close();browser=undefined;
 }
 const result={status:'pass',platform:process.platform,firstSequence:first.record.sequence,secondSequence:second.record.sequence,replication:process.env.MY98_REFRESH_TEST?'explicit test refresh':'manual follow once, automatic polling of new snapshot',resumeExact:true,omittedComponents:true,publisherOffline:true,unavailable:!process.env.MY98_NATIVE_ONLY,noLegacyRequests:true,browsers:results};
 await writeFile(join(output,'result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}catch(error){console.error('App requests',JSON.stringify(appSite?.requests.slice(-12)));console.error('Signaling',JSON.stringify(tr?.announces.slice(-50)));console.error('CLI',cli?.logs);console.error('FeedTorrent',app?.logs);console.error('Snapshot',app?await app.api().catch(()=>null):null);throw error;}
finally{await browser?.close();await stopCli();await app?.stop();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await appSite?.close();await gateway?.stop();await tr?.stop();await network?.stop();}
