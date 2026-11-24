/** Private DHT/WSS acceptance: browser publisher -> FeedTorrent -> independent reader. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium,firefox,webkit} from 'playwright';
import {serveSite,quietAudio} from './pages/server.mjs';
import {browserOptions} from './browser-options.mjs';
const root=resolve('.'),ft=resolve(process.env.MY98_FEEDTORRENT_TEST_ROOT||'build/feedtorrent');
const output=join(root,'build/publishing-tests/integration-'+Date.now());await mkdir(output,{recursive:true});
process.chdir(ft);
const {dhtNetwork,startApp,wait}=await import(pathToFileURL(join(ft,'dev/tests/helpers.mjs')));
const {signaling}=await import(pathToFileURL(join(ft,'dev/tests/webtorrent-fixture.mjs')));
const {default:parseTorrent}=await import(pathToFileURL(join(ft,'dev/node_modules/parse-torrent/index.js')));
const {freePort,proxy,checkSignature}=await import(pathToFileURL(join(ft,'dev/tests/dht-gateway-fixture.mjs')));
let net,tr,app,secondApp,gateway,site,browser,diagnosticTimer;const report=[],diagnostics=[];
try{
 net=await dhtNetwork({verify:checkSignature});await wait(()=>net.nodes.every(n=>n.nodes.toArray().length===2),'DHT routing');
 tr=await signaling(join(output,'tls'));
 app=await startApp(join(output,'replica'),['--dht-bootstrap',net.bootstrap.map(n=>n.host+':'+n.port).join(',')],{env:tr.env});
 const port=await freePort();await app.command({type:'configure',settings:{...(await app.api()).settings,webtorrent_trackers:[tr.url],webtorrent_stun_server:'',dht_gateway:{enabled:true,allow_publish:true,listen:'127.0.0.1:'+port}}});
 gateway=await proxy(join(output,'proxy'),'http://127.0.0.1:'+port);
 const sources={gateways:[gateway.url],trackers:[tr.url]};site=await serveSite({root:join(root,'build/site'),headers:true,sources});
 const engines={chromium,firefox,webkit};
 for(const name of (process.env.MY98_PUBLISH_BROWSERS||'chromium,firefox,webkit').split(',')){
  browser=await engines[name].launch(browserOptions(name));
  try{
   const context=await browser.newContext({ignoreHTTPSErrors:true,acceptDownloads:true});await context.addInitScript(quietAudio);
   await context.addInitScript(()=>{const RTC=globalThis.RTCPeerConnection;window.testPeers=[];globalThis.RTCPeerConnection=new Proxy(RTC,{construct(T,args,N){args[0]={...args[0],iceServers:[]};const pc=Reflect.construct(T,args,N);testPeers.push(pc);return pc;}});});
   const page=await context.newPage();page.setDefaultTimeout(120000);
   diagnosticTimer=setInterval(async()=>{
    try{
     const state=await page.evaluate(()=>({publishing:window.publishing,replicaPackets:window.replicaPackets?.slice(-6),lastSeed:window.publisher?.torrentHost.lastSeedDebug,sessions:window.publisher?[...publisher.torrentHost.sessions].map(([id,t])=>({id,debug:t.seedDebug,replicas:t.replicas?{nodes:[...t.replicas.nodes].map(([id,node])=>({id,parts:[...node.parts]})),wires:[...t.replicas.wires.values()].map(w=>({kind:w.kind,node:w.node,bytes:w.bytes,feedtorrent:w.feedtorrent,peer:w.wire.peerId}))}:null,torrents:t.client?.torrents.map(x=>({hash:x.infoHash,ready:x.ready,done:x.done,length:x.length,verified:x.pieces?.filter(p=>p===null).length}))})):[]}));
     await writeFile(join(output,'live.json'),JSON.stringify({browser:name,...state},null,2));
     if(await import('node:fs/promises').then(fs=>fs.access(join(output,'cancel')).then(()=>true,()=>false)))await page.evaluate(()=>window.publisher?.cancel());
    }catch{}
   },5000);const errors=[];page.on('pageerror',e=>{errors.push(String(e));diagnostics.push({browser:name,pageError:String(e)});});
   await page.goto(tr.page);await page.goto(gateway.page);await page.goto(site.url);await page.waitForFunction(()=>!document.body.inert);
   const first=await page.evaluate(async sources=>{
    const {Slop86Disk}=await import('/build/disk/web/client.js');
    const c=await Slop86Disk.create({onPublishing:value=>window.publishing=value});window.publisher=c;
    await c.unlock('disk fixtures','public compatibility password','main');
    const bytes=new Uint8Array(1048576);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
    bytes.set([0xfa,0xf4,0xeb,0xfd]);bytes[510]=85;bytes[511]=170;
    window.original=(await c.createFromImage(new Blob([bytes]))).download.blob;
    await c.write(10,new Uint8Array([99]));
    const before=await c.describe();const publication=await c.publishDisk({sources});
    if(JSON.stringify(before)!==JSON.stringify(await c.describe()))throw Error('Publishing changed the open disk');
    return publication;
   },sources);
   assert.equal(first.state,'seeding',JSON.stringify(first));assert(first.active);console.log(name+': browser DHT publication acknowledged');
   await page.evaluate(()=>{
    window.replicaPackets=[];
    for(const transport of publisher.torrentHost.sessions.values())for(const torrent of transport.client?.torrents||[])
     torrent.on('wire',wire=>wire.on('extended',(name,bytes)=>{if(name==='ft_replica'){replicaPackets.push({hash:torrent.infoHash,peer:wire.peerId,bytes:Array.from(bytes)});if(replicaPackets.length>32)replicaPackets.shift();}}));
   });
   const existing=(await app.api()).posts.find(p=>p.magnet===first.magnet);
   await app.command({type:'follow_post',uri:first.magnet,config:{name:'browser publication '+name,mode:'mirror_all',automatic_limit:null}});
   if(existing)await app.command({type:'refresh_post',id:existing.id});
   async function copied(publication) {
    const catalog=new URL(publication.catalogMagnet).searchParams.get('xt').slice(9);
    const transfer=await wait(async()=>{const state=await app.api(),t=state.transfers.find(t=>t.id===catalog);if(t?.error)throw Error(t.error);return t&&t.total>0&&t.verified===t.total&&t;},'complete catalog '+catalog,90000);
    const file=transfer.files.find(f=>f.name.endsWith('/disk.torrent')||f.name==='disk.torrent');assert(file);
    const meta=await readFile(join(transfer.save_path,file.name));const disk=(await parseTorrent(meta)).infoHash;
    const payload=await wait(async()=>{const s=await app.api(),t=s.transfers.find(t=>t.id===disk);if(t?.error)throw Error(t.error);return t&&t.total>0&&t.verified===t.total&&t;},'complete disk '+disk,90000);
    return {catalog,disk,file:join(payload.save_path,payload.files[0].name)};
   }
   const firstReplica=await copied(first);
   await page.waitForFunction(()=>window.publishing?.replicas?.complete===1);
   assert.equal((await page.evaluate(()=>window.publishing)).replicas.label,'1');
   if(name==='chromium') {
    const secondDirectory=join(output,'second-replica');
    const startSecond=()=>startApp(secondDirectory,['--dht-bootstrap',net.bootstrap.map(n=>n.host+':'+n.port).join(',')],{env:tr.env});
    secondApp=await startSecond();
    await secondApp.command({type:'configure',settings:{...(await secondApp.api()).settings,webtorrent_trackers:[tr.url],webtorrent_stun_server:''}});
    await secondApp.command({type:'follow_post',uri:first.magnet,config:{name:'second seedbox',mode:'mirror_all',automatic_limit:null}});
    await page.waitForFunction(()=>window.publishing?.replicas?.complete===2);
    const received=await wait(async()=>{const transfer=(await secondApp.api()).transfers.find(t=>t.id===firstReplica.disk);return transfer?.total>0&&transfer.verified===transfer.total&&transfer;},'second seedbox exact disk');
    assert.deepEqual(await readFile(join(received.save_path,received.files[0].name)),await readFile(firstReplica.file));
    await page.evaluate(()=>{
     const tracker=[...publisher.torrentHost.sessions.values()].find(t=>t.replicas).replicas,attach=tracker.attach.bind(tracker);
     window.replicaReconnects=[];tracker.attach=(kind,wire)=>{const sample={kind,peer:wire.peerId,identified:false};replicaReconnects.push(sample);wire.on('extended',name=>{if(name==='ft_replica')sample.identified=true;});return attach(kind,wire);};
    });
    await secondApp.stop();secondApp=await startSecond();
    await page.waitForFunction(()=>window.replicaReconnects?.some(sample=>sample.identified));
    await wait(async()=>(await secondApp.api()).transfers.some(t=>t.id===firstReplica.disk&&t.progress===1),'restarted seedbox retains disk');
    assert.equal((await page.evaluate(()=>window.publishing)).replicas.complete,2);
    assert.equal(await page.evaluate(()=>[...publisher.torrentHost.sessions.values()].find(t=>t.replicas).replicas.nodes.size),2);
    await secondApp.stop();secondApp=null;
    console.log('chromium: two exact replicas and stable counter after native restart PASS');
   }
   const originalBytes=Buffer.from(await page.evaluate(async()=>Array.from(new Uint8Array(await original.arrayBuffer()))));
   const external=join(output,name+'-external.my98');await writeFile(external,originalBytes);
   await page.evaluate(()=>{const input=document.createElement('input');input.type='file';input.id='external-fixture';document.body.append(input);});
   await page.locator('#external-fixture').setInputFiles(external);
   const beforeSecond=await page.evaluate(()=>publisher.describe());
   const second=await page.evaluate(async sources=>{await publisher.stopSeeding();const result=await publisher.publishDisk({kind:'encrypted',file:document.querySelector("#external-fixture").files[0],sources});return result;},sources);
   assert.equal(second.state,'seeding',JSON.stringify(second));assert(BigInt(second.sequence)>BigInt(first.sequence));assert.deepEqual(await page.evaluate(()=>publisher.describe()),beforeSecond);
   await writeFile(external,Buffer.alloc(originalBytes.length,0)); // Seeding must no longer depend on the selected file.
   const post=(await app.api()).posts.find(p=>p.magnet===first.magnet);await app.command({type:'refresh_post',id:post.id});
   const secondReplica=await copied(second);
   const {createHash}=await import('node:crypto');
   const originalHash=createHash('sha256').update(originalBytes).digest('hex');
   assert.equal(createHash('sha256').update(await readFile(secondReplica.file)).digest('hex'),originalHash);
   const third=await page.evaluate(async sources=>{
    await publisher.stopSeeding();const bytes=new Uint8Array(1048576);bytes.set([0xfa,0xf4,0xeb,0xfd]);bytes[10]=55;bytes[510]=85;bytes[511]=170;
    return publisher.publishDisk({kind:'raw',file:new Blob([bytes]),sources});
   },sources);
   assert.equal(third.state,'seeding',JSON.stringify(third));assert(BigInt(third.sequence)>BigInt(second.sequence));assert.deepEqual(await page.evaluate(()=>publisher.describe()),beforeSecond);
   await app.command({type:'refresh_post',id:post.id});const thirdReplica=await copied(third);
   await page.evaluate(async()=>{await publisher.stopSeeding();await publisher.close();});
   await page.reload();await page.waitForFunction(()=>!document.body.inert);
   await page.locator('#disk-user').fill('disk fixtures');await page.locator('#disk-password').fill('public compatibility password');await page.locator('#disk-login button').click();
   await page.waitForFunction(()=>!document.querySelector('#disk-boot').disabled);
   await page.evaluate(async()=>{const {V86}=await import('/build/libv86.mjs'),run=V86.prototype.run;V86.prototype.run=function(...a){window.fixtureVm=this;return run.apply(this,a);};});
   await page.locator('#disk-boot').click();
   await page.waitForFunction(()=>window.fixtureVm?.v86.cpu.in_hlt[0]&&fixtureVm.v86.cpu.instruction_pointer[0]===0x7c02);
   assert.equal(await page.evaluate(()=>fixtureVm.v86.cpu.mem8.length),512*1024*1024);
   assert.deepEqual(errors,[]);report.push({browser:name,first,second,third,firstReplica,secondReplica,thirdReplica,boot:'private replica exact boot sector PASS'});
   await writeFile(join(output,'progress.json'),JSON.stringify(report,null,2));console.log(name+': replica, replacement and independent boot PASS');
  }finally{
   clearInterval(diagnosticTimer);
   for(const page of browser.contexts().flatMap(c=>c.pages()))diagnostics.push({browser:name,...await page.evaluate(()=>({lastSeed:window.publisher?.torrentHost.lastSeedDebug,publishing:window.publishing,seedSessions:window.publisher?[...publisher.torrentHost.sessions].map(([id,t])=>({id,debug:t.seedDebug,torrents:t.client?.torrents.map(x=>({hash:x.infoHash,ready:x.ready,done:x.done,length:x.length,verified:x.pieces?.filter(p=>p===null).length}))})):[],peerCount:window.testPeers?.length,peers:window.testPeers?.filter(pc=>pc.connectionState!=="closed"&&pc.remoteDescription).slice(-8).map(pc=>({connection:pc.connectionState,ice:pc.iceConnectionState,gathering:pc.iceGatheringState,local:pc.localDescription?.sdp,remote:pc.remoteDescription?.sdp})),publishing:window.publishing})).catch(()=>({}))});
   await browser.close();browser=null;
  }
 }
 await writeFile(join(output,'report.json'),JSON.stringify({status:'PASS',report},null,2));
}catch(error){await writeFile(join(output,'failure.json'),JSON.stringify({error:String(error),report,diagnostics,app:app?await app.api().catch(()=>null):null,logs:app?.logs,announces:tr?.announces},null,2));throw error;}
finally{await browser?.close();await site?.close();await gateway?.stop();await secondApp?.stop();await app?.stop();await tr?.stop();await net?.stop();}
