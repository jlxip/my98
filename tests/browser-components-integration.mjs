/** Real private DHT/WebRTC chain, immutable base, state/profile updates and offline-publisher restore. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {chromium,firefox,webkit} from 'playwright';
import {serveSite,quietAudio} from './pages/server.mjs';
import {browserOptions} from './browser-options.mjs';
const root=resolve('.'),ft=resolve(process.env.MY98_FEEDTORRENT_TEST_ROOT||'build/feedtorrent');
const output=join(root,'build/ans414-integration-'+Date.now());await mkdir(output,{recursive:true});
process.chdir(ft);
const {dhtNetwork,startApp,wait}=await import(pathToFileURL(join(ft,'dev/tests/helpers.mjs')));
const {signaling}=await import(pathToFileURL(join(ft,'dev/tests/webtorrent-fixture.mjs')));
const {default:parseTorrent}=await import(pathToFileURL(join(ft,'dev/node_modules/parse-torrent/index.js')));
const {freePort,proxy,checkSignature}=await import(pathToFileURL(join(ft,'dev/tests/dht-gateway-fixture.mjs')));
const report=[];let net,tr,app,gateway,site,browser,diagnosticTimer,diagnostic;
const inspect=()=>({publishing:window.publishing,sessions:window.publisher?[...publisher.torrentHost.sessions].map(([id,t])=>({id,parts:t.replicas?[...t.replicas.components]:[],nodes:t.replicas?[...t.replicas.nodes].map(([id,n])=>({id,parts:[...n.parts]})):[],wires:t.replicas?[...t.replicas.wires.values()].map(w=>({kind:w.kind,node:w.node,bytes:w.bytes,live:w.live,receipt:w.receipt})):[]})):[]});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
try {
 net=await dhtNetwork({verify:checkSignature});await wait(()=>net.nodes.every(n=>n.nodes.toArray().length===2),'private DHT routing');
 tr=await signaling(join(output,'tls'));
 app=await startApp(join(output,'replica'),['--dht-bootstrap',net.bootstrap.map(n=>n.host+':'+n.port).join(',')],{env:tr.env});
 const port=await freePort();await app.command({type:'configure',settings:{...(await app.api()).settings,webtorrent_trackers:[tr.url],webtorrent_stun_server:'',dht_gateway:{enabled:true,allow_publish:true,listen:'127.0.0.1:'+port}}});
 gateway=await proxy(join(output,'proxy'),'http://127.0.0.1:'+port);
 const sources={gateways:[gateway.url],trackers:[tr.url]};site=await serveSite({root:join(root,'build/site'),headers:true,sources});
 for(const name of (process.env.MY98_PUBLISH_BROWSERS||'chromium,firefox,webkit').split(',')) {
  browser=await ({chromium,firefox,webkit}[name]).launch(browserOptions(name));
  const context=await browser.newContext({ignoreHTTPSErrors:true});await context.addInitScript(quietAudio);
  await context.addInitScript(()=>{const Original=RTCPeerConnection;globalThis.RTCPeerConnection=new Proxy(Original,{construct(T,args,N){args[0]={...args[0],iceServers:[]};return Reflect.construct(T,args,N);}});});
  const page=await context.newPage();page.setDefaultTimeout(120000);let phase='publishing';const errors=[];page.on('pageerror',e=>{errors.push({message:String(e),stack:e.stack,phase});console.error(name+' page error '+JSON.stringify(errors.at(-1)));});
  await page.goto(tr.page);await page.goto(gateway.page);await page.goto(site.url);await page.waitForFunction(()=>!document.body.inert);
  diagnosticTimer=setInterval(async()=>{try{diagnostic=await page.evaluate(inspect);await writeFile(join(output,'live.json'),JSON.stringify(diagnostic,null,2));}catch{}},3000);
  const first=await page.evaluate(async({sources,name})=>{
    const {Slop86Disk}=await import('/build/disk/web/client.js');
    window.publisher=await Slop86Disk.create({onPublishing:v=>window.publishing=v});
    await publisher.unlock('ans414 '+name,'public test password','main');
    const raw=new Uint8Array(1048576);raw.set([0xfa,0xf4,0xeb,0xfd]);raw[510]=85;raw[511]=170;
    window.original=(await publisher.createFromImage(new Blob([raw]))).download.blob;
    return publisher.publishDisk({sources});
  },{sources,name});assert.equal(first.state,'seeding',JSON.stringify(first));
  await app.command({type:'follow_post',uri:first.magnet,config:{name:'ans414 '+name,mode:'mirror_all',automatic_limit:null}});
  const post=()=>app.api().then(s=>s.posts.find(p=>p.magnet===first.magnet));
  async function copied(publication) {
    const p=await post();if(p)await app.command({type:'refresh_post',id:p.id});
    const catalog=new URL(publication.catalogMagnet).searchParams.get('xt').slice(9);
    const t=await wait(async()=>{const t=(await app.api()).transfers.find(t=>t.id===catalog);if(t?.error)throw Error(t.error);return t?.total>0&&t.verified===t.total&&t;},'complete catalog '+catalog,90000);
    const result={catalog};
    for(const f of t.files.filter(f=>/\/(disk|state|profile)\.torrent$/.test('/'+f.name))) {
      const kind=f.name.split('/').at(-1).slice(0,-8),meta=await readFile(join(t.save_path,f.name)),hash=(await parseTorrent(meta)).infoHash;
      const payload=await wait(async()=>{const v=(await app.api()).transfers.find(t=>t.id===hash);if(v?.error)throw Error(v.error);return v?.total>0&&v.verified===v.total&&v;},'complete '+kind+' '+hash,90000);
      result[kind]={hash,file:join(payload.save_path,payload.files.find(f=>!f.name.includes('.pad/')).name)};
    }
    await wait(async()=>{if(app.child.exitCode!==null||app.child.signalCode)throw Error('Native receiver exited '+app.child.exitCode+'/'+app.child.signalCode);return await page.evaluate(()=>window.publishing?.replicas?.complete>=1);},'replica receipt',90000);
    console.log(name+': copied '+Object.keys(result).join(','));return result;
  }
  const base=await copied(first),baseBytes=await readFile(base.disk.file);
  await page.evaluate(async({sources,name})=>{
    await publisher.close();
    const {Slop86Disk}=await import('/build/disk/web/client.js');
    window.publisher=await Slop86Disk.create({onPublishing:v=>window.publishing=v});
    await publisher.unlock('ans414 '+name,'public test password','main');
    await publisher.openRemote({sources,prefetchScope:'none',waitForFinal:true});
    await publisher.startLoadAnalysis({origin:'boot'});await publisher.read(0,512);window.bootProfiles=await publisher.finishLoadAnalysis();
    const {DiskBuffer}=await import('/build/disk/web/client.js');
    const {createMachine,compatibility}=await import('/src/browser/machine-factory.js');
    const {captureMachineState}=await import('/src/browser/machine-state.js');
    window.captureMachineState=captureMachineState;window.machineCompat=await compatibility();
    window.machineConfig={memory_size:32*1048576,vga_memory_size:1048576,boot_order:0x312,acpi:false,network:'ne2k'};
    window.testScreen=document.createElement('div');document.body.append(testScreen);
    window.adapter=new DiskBuffer(publisher,(await publisher.describe()).size,e=>{throw e;});
    window.machine=await createMachine(adapter,machineConfig,testScreen,{disableSpeaker:true});machine.run();
    window.capture=async()=>captureMachineState({machine,adapter,disk:publisher,config:machineConfig,compatibility:machineCompat});
  },{sources,name});
  await page.waitForFunction(()=>machine.v86.cpu.in_hlt[0]);
  const statePublication=await page.evaluate(async sources=>{
    machine.v86.cpu.mem8[0x70000]=73;await publisher.write(10000,new Uint8Array([42]));
    window.stateFile=(await capture()).blob;window.beforeState=await publisher.describe();
    return publisher.publishUpdate({action:'state',file:stateFile,compatibility:machineCompat,sources});
  },sources);assert.equal(statePublication.state,'seeding',JSON.stringify(statePublication));
  const state=await copied(statePublication);assert.equal(state.disk.hash,base.disk.hash);assert.deepEqual(await readFile(state.disk.file),baseBytes);
  assert.equal(sha(await readFile(state.state.file)),await page.evaluate(async()=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await stateFile.arrayBuffer())),n=>n.toString(16).padStart(2,'0')).join('')));
  const profilePublication=await page.evaluate(async sources=>{
    const {restoreMachineState}=await import('/src/browser/machine-state.js');const {createMachine}=await import('/src/browser/machine-factory.js');
    const previous=machine;
    const restored=await restoreMachineState({disk:publisher,input:stateFile,current:{machine,adapter},compatibility:machineCompat,createMachine:(buffer,config)=>createMachine(buffer,config,testScreen,{disableSpeaker:true})});
    await previous.destroy();window.machine=restored.machine;window.adapter=restored.adapter;
    await publisher.startLoadAnalysis({origin:'restored'});await publisher.read(10000,512);window.stateProfiles=await publisher.finishLoadAnalysis();
    return publisher.publishUpdate({action:'profiles',profiles:[...bootProfiles,...stateProfiles],remove:[],compatibility:machineCompat,sources});
  },sources);assert.equal(profilePublication.state,'seeding',JSON.stringify(profilePublication));
  const full=await copied(profilePublication);assert.equal(full.disk.hash,base.disk.hash);assert.equal(full.state.hash,state.state.hash);
  assert.equal(JSON.parse(await readFile(full.profile.file,'utf8')).length,2);
  const rejects=await page.evaluate(async sources=>{
    const out=[],reject=async(fn,code)=>{try{await fn();throw Error('Unexpected success');}catch(e){if(e.code!==code)throw e;out.push(code);}};
    const options={sources,compatibility:machineCompat};
    const {Slop86Disk}=await import('/build/disk/web/client.js');const other=await Slop86Disk.create();
    // Independent authenticated disk header must be rejected before admitting its state.
    await other.unlock('foreign state fixture','public test password','main');await other.createFromImage(new Blob([new Uint8Array(65536)]));
    const foreignState=(await other.saveState(new Uint8Array([1,2,3]).buffer,{version:1,config:machineConfig,compatibility:machineCompat,running:false,baseInfoHash:null})).blob;
    await reject(()=>publisher.publishUpdate({...options,action:'state',file:foreignState}),'INVALID_STATE');await other.close();
    const bad=new Uint8Array(await stateFile.arrayBuffer());bad[bad.length-1]^=1;
    await reject(()=>publisher.publishUpdate({...options,action:'state',file:new Blob([bad])}),'CORRUPTION');
    await reject(()=>publisher.publishUpdate({...options,action:'state',file:stateFile,compatibility:'another build'}),'INVALID_STATE');
    const wrong=structuredClone(stateProfiles);wrong[0].origin.sha256='0'.repeat(64);
    await reject(()=>publisher.publishUpdate({...options,action:'profiles',profiles:wrong,remove:[]}),'INVALID_PROFILE');
    const foreign=structuredClone(bootProfiles);foreign[0].infoHash='0'.repeat(40);
    await reject(()=>publisher.publishUpdate({...options,action:'profiles',profiles:foreign,remove:[]}),'INVALID_PROFILE');
    if((await publisher.read(10000,1))[0]!==42||machine.v86.cpu.mem8[0x70000]!==73)throw Error('Failed candidate changed session');
    return out;
  },sources);
  const replaced=await page.evaluate(async sources=>{
    machine.v86.cpu.mem8[0x70000]=81;await publisher.write(10000,new Uint8Array([55]));stateFile=(await capture()).blob;
    return publisher.publishUpdate({action:'state',file:stateFile,compatibility:machineCompat,sources});
  },sources);const replacement=await copied(replaced);assert.equal(replacement.disk.hash,base.disk.hash);
  assert.deepEqual(JSON.parse(await readFile(replacement.profile.file,'utf8')).map(p=>p.origin.kind),['boot']);
  const removed=await page.evaluate(async sources=>publisher.publishUpdate({action:'remove-state',compatibility:machineCompat,sources}),sources);
  const withoutState=await copied(removed);assert(!withoutState.state);assert(withoutState.profile);
  const cleared=await page.evaluate(async sources=>publisher.publishUpdate({action:'profiles',profiles:[],remove:['boot'],compatibility:machineCompat,sources}),sources);
  const bare=await copied(cleared);assert(!bare.state&&!bare.profile);assert.equal(bare.disk.hash,base.disk.hash);
  const final=await page.evaluate(async sources=>publisher.publishUpdate({action:'state',file:stateFile,compatibility:machineCompat,sources}),sources);
  const finalReplica=await copied(final);assert.equal(finalReplica.disk.hash,base.disk.hash);
  phase='refresh';const refresh=await page.evaluate(async()=>{
    const {restoreMachineState}=await import('/src/browser/machine-state.js'),{createMachine}=await import('/src/browser/machine-factory.js');
    const seed=await publisher.publicationStatus(),before=await publisher.describe();
    const candidate=await publisher.prepareRemoteUpdate(),view=publisher.remoteUpdateDisk(candidate.token);
    const container=document.createElement('div');container.innerHTML='<div></div><canvas></canvas>';
    const next=await restoreMachineState({disk:view,input:{publication:true},compatibility:machineCompat,createMachine:(buffer,config)=>createMachine(buffer,config,container,{disableSpeaker:true})});
    if((await publisher.describe()).remote.publicationInfoHash!==before.remote.publicationInfoHash)throw Error('Preparation replaced current source');
    await machine.stop();await adapter.drain();await publisher.commitRemoteUpdate(candidate.token,{discardChanges:true});view.committed=true;
    const current=await publisher.publicationStatus();
    if(!current.active||current.sequence!==seed.sequence)throw Error('Reader replacement interrupted independent seed');
    const result={activeSeed:current.active,memory:next.machine.v86.cpu.mem8[0x70000],overlay:(await publisher.read(10000,1))[0],ram:next.config.memory_size};
    await next.machine.destroy();next.adapter.dispose();await machine.destroy();adapter.dispose();await publisher.close();return result;
  });assert.deepEqual(refresh,{activeSeed:true,memory:81,overlay:55,ram:32*1048576});phase='closed';await context.close();
  const readerContext=await browser.newContext({ignoreHTTPSErrors:true});await readerContext.addInitScript(quietAudio);
  const reader=await readerContext.newPage();reader.setDefaultTimeout(120000);await reader.goto(tr.page);await reader.goto(gateway.page);await reader.goto(site.url);await reader.waitForFunction(()=>!document.body.inert);
  const restored=await reader.evaluate(async({sources,name})=>{
    const {Slop86Disk}=await import('/build/disk/web/client.js');const {restoreMachineState}=await import('/src/browser/machine-state.js');const {createMachine,compatibility}=await import('/src/browser/machine-factory.js');
    const client=await Slop86Disk.create();await client.unlock('ans414 '+name,'public test password','main');await client.openRemote({sources,prefetchScope:'none',waitForFinal:true});
    const screen=document.createElement('div');document.body.append(screen);
    const restored=await restoreMachineState({disk:client,input:{publication:true},compatibility:await compatibility(),createMachine:(adapter,config)=>createMachine(adapter,config,screen,{disableSpeaker:true})});
    const result={ram:restored.config.memory_size,memory:restored.machine.v86.cpu.mem8[0x70000],overlay:(await client.read(10000,1))[0]};
    await restored.machine.destroy();restored.adapter.dispose();await client.close();return result;
  },{sources,name});assert.deepEqual(restored,{ram:32*1048576,memory:81,overlay:55});
  assert.deepEqual(errors,[]);report.push({browser:name,status:'PASS',base,full,replacement,withoutState,bare,finalReplica,rejects,restored,refresh});await writeFile(join(output,'progress.json'),JSON.stringify(report,null,2));
  clearInterval(diagnosticTimer);await readerContext.close();await browser.close();browser=null;console.log(name+': state/profile updates and independent restore PASS');
 }
 await writeFile(join(output,'report.json'),JSON.stringify({status:'PASS',report},null,2));
} catch(error){await writeFile(join(output,'failure.json'),JSON.stringify({error:String(error),stack:error.stack,report,diagnostic,nativeExit:app?{code:app.child.exitCode,signal:app.child.signalCode}:null,app:app?await app.api().catch(()=>null):null,logs:app?.logs,announces:tr?.announces},null,2));throw error;}
finally{clearInterval(diagnosticTimer);await browser?.close();await site?.close();await gateway?.stop();await app?.stop();await tr?.stop();await net?.stop();}
