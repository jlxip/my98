/** Explicit acceptance with a caller-supplied, read-only Windows 98 disk fixture. */
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,access} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {serveSite,quietAudio} from './pages/server.mjs';
if(!process.env.MY98_WIN98_IMAGE)throw Error('Set MY98_WIN98_IMAGE to an accepted Windows 98 raw disk; the original is never modified.');
const root=resolve('.'),image=resolve(process.env.MY98_WIN98_IMAGE),ft=resolve(process.env.MY98_FEEDTORRENT_TEST_ROOT||'build/feedtorrent');
const resume=process.env.MY98_WIN98_RESUME,output=resume?resolve(resume):join(root,'build/publishing-tests/win98-'+Date.now());await mkdir(output,{recursive:true});console.log('OUTPUT',output);
process.chdir(ft);
const {dhtNetwork,startApp,wait}=await import(pathToFileURL(join(ft,'dev/tests/helpers.mjs')));
const {signaling}=await import(pathToFileURL(join(ft,'dev/tests/webtorrent-fixture.mjs')));
const {freePort,proxy,checkSignature}=await import(pathToFileURL(join(ft,'dev/tests/dht-gateway-fixture.mjs')));
const {default:parseTorrent}=await import(pathToFileURL(join(ft,'dev/node_modules/parse-torrent/index.js')));
let net,tr,app,gateway,site,context,cli,page;const report=resume?JSON.parse(await readFile(join(output,'report.json'),'utf8')):{image};report.status='running';delete report.error;
try{
 net=await dhtNetwork({verify:checkSignature});await wait(()=>net.nodes.every(n=>n.nodes.toArray().length===2),'DHT routing');tr=await signaling(join(output,'tls'));
 app=await startApp(join(output,'replica'),['--dht-bootstrap',net.bootstrap.map(n=>n.host+':'+n.port).join(',')],{env:tr.env});
 const port=await freePort();await app.command({type:'configure',settings:{...(await app.api()).settings,webtorrent_trackers:[tr.url],webtorrent_stun_server:'',dht_gateway:{enabled:true,allow_publish:true,listen:'127.0.0.1:'+port}}});
 gateway=await proxy(join(output,'proxy'),'http://127.0.0.1:'+port);const sources={gateways:[gateway.url],trackers:[tr.url]};site=await serveSite({root:join(root,'build/site'),headers:true,sources});
 const launch=async dir=>{
  const c=await chromium.launchPersistentContext(join(output,dir),{ignoreHTTPSErrors:true,acceptDownloads:true,viewport:{width:1280,height:960}});await c.addInitScript(quietAudio);
  await c.addInitScript(()=>{const RTC=globalThis.RTCPeerConnection;globalThis.RTCPeerConnection=new Proxy(RTC,{construct(T,args,N){args[0]={...args[0],iceServers:[]};return Reflect.construct(T,args,N);}});});return c;
 };
 if(!resume){
 context=await launch('publisher-profile');page=context.pages()[0];page.setDefaultTimeout(120000);await page.goto(tr.page);await page.goto(gateway.page);await page.goto(site.url);await page.waitForFunction(()=>!document.body.inert);
 await page.evaluate(()=>{const input=document.createElement('input');input.type='file';input.id='fixture-file';document.body.append(input);});await page.locator('#fixture-file').setInputFiles(image);
 console.log('Preparing and publishing Windows 98 fixture');
 const publication=await page.evaluate(async sources=>{
  const {Slop86Disk}=await import('/build/disk/web/client.js');window.publisher=await Slop86Disk.create({onProgress:v=>window.fixtureProgress=v,onPublishing:v=>window.fixturePublishing=v});await publisher.unlock('disk fixtures','public compatibility password','main');
  return publisher.publishDisk({kind:'raw',file:document.querySelector('#fixture-file').files[0],sources});
 },sources);assert.equal(publication.state,'seeding',JSON.stringify(publication));report.publication=publication;console.log('Browser announcement acknowledged');
 await app.command({type:'follow_post',uri:publication.magnet,config:{name:'Windows 98 browser fixture',mode:'mirror_all',automatic_limit:null}});
 const catalog=new URL(publication.catalogMagnet).searchParams.get('xt').slice(9);
 const parent=await wait(async()=>{const t=(await app.api()).transfers.find(t=>t.id===catalog);return t&&t.total>0&&t.verified===t.total&&t;},'Windows catalog replica',120000);
 const item=parent.files.find(f=>f.name.endsWith('disk.torrent')),disk=(await parseTorrent(await readFile(join(parent.save_path,item.name)))).infoHash;
 const payload=await wait(async()=>{const t=(await app.api()).transfers.find(t=>t.id===disk);if(t?.error)throw Error(t.error);return t&&t.total>0&&t.verified===t.total&&t;},'complete Windows encrypted disk',180000);
 const diskPath=join(payload.save_path,payload.files[0].name);report.disk={id:disk,bytes:payload.total,sha256:createHash('sha256').update(await readFile(diskPath)).digest('hex')};console.log('Full native replica verified',payload.total);
 await page.evaluate(async()=>{await publisher.stopSeeding();await publisher.close();});await context.close();context=null;
 const cliRoot=join(output,'cli');await mkdir(cliRoot);const config=join(cliRoot,'sources.json');await writeFile(config,JSON.stringify(sources));
 cli=spawn(process.env.MY98_TORRENT_BIN||join(root,'build/torrent-target/release/my98-torrent'),['--root',cliRoot,'--config',config,'--isolated','--dht-bootstrap',net.bootstrap.map(n=>n.host+':'+n.port).join(','),'publish',diskPath],{env:tr.env,stdio:['pipe','pipe','pipe']});
 let cliLogs='';cli.stdout.on('data',b=>cliLogs+=b);cli.stderr.on('data',b=>cliLogs+=b);cli.stdin.end('disk fixtures\npublic compatibility password\n');
 await wait(()=>{if(cli.exitCode!==null)throw Error(cliLogs);return cliLogs.includes('Seeding until interrupted.');},'CLI publishes browser-generated disk',120000);
 const journal=JSON.parse(await readFile(join(cliRoot,'publication.json'),'utf8'));assert(journal.torrents.some(t=>t.id===disk));assert(journal.torrents.some(t=>t.id===catalog));report.cli={catalog,disk,sequence:journal.record.sequence};
 const done=once(cli,'exit');cli.kill('SIGTERM');assert.equal((await done)[0],0,cliLogs);cli=null;console.log('CLI metainfo hashes match browser exactly; all publishers closed');
 }else{
  const journal=JSON.parse(await readFile(join(output,'cli/publication.json'),'utf8')),r=journal.record;
  const response=await fetch('http://127.0.0.1:'+port+'/dht/mutable/'+r.key+'?salt='+r.salt,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({sequence:r.sequence,signature:r.signature,value:r.value})});
  assert.equal(response.status,200,await response.clone().text());console.log('Existing exact replica and signed record restored for boot-only continuation');
 }
 context=await launch('reader-profile');page=context.pages()[0];page.setDefaultTimeout(120000);await page.goto(tr.page);await page.goto(gateway.page);await page.goto(site.url);await page.waitForFunction(()=>!document.body.inert);
 await page.evaluate(async()=>{const {V86}=await import('/build/libv86.mjs'),run=V86.prototype.run;V86.prototype.run=function(...a){window.fixtureVm=this;return run.apply(this,a);};});
 await page.locator('#disk-user').fill('disk fixtures');await page.locator('#disk-password').fill('public compatibility password');await page.locator('#disk-login button').click();await page.waitForFunction(()=>!document.querySelector('#disk-boot').disabled);await page.locator('#disk-boot').click();
 await page.waitForFunction(()=>window.fixtureVm?.v86?.cpu&& !document.querySelector("#session").hidden && !document.querySelector("#pause").disabled);
 report.memoryBytes=await page.evaluate(()=>fixtureVm.v86.cpu.mem8.length);assert.equal(report.memoryBytes,512*1024*1024);
 // Human acceptance records the observed GUI checkpoint; it does not imply a complete shell desktop.
 console.log('BOOT_GATE',join(output,'boot-accepted'));const deadline=Date.now()+360000;
 while(Date.now()<deadline){
  await page.screenshot({path:join(output,'windows-live.png')});
  const status=await page.locator('#disk-status').textContent();assert(!/disk stopped/i.test(status),status);
  if(await access(join(output,'boot-accepted')).then(()=>true,()=>false)){report.status='PASS';break;}
  await new Promise(r=>setTimeout(r,3000));
 }
 assert.equal(report.status,'PASS','GUI boot not visually accepted before deadline');await page.screenshot({path:join(output,'windows-accepted.png')});
 await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));console.log('Windows 98 boot from native replica PASS');
}catch(error){report.status='FAIL';report.error=String(error);await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));throw error;}
finally{if(cli&&cli.exitCode===null){const done=once(cli,'exit');cli.kill('SIGTERM');await done;}await context?.close();await site?.close();await gateway?.stop();await app?.stop();await tr?.stop();await net?.stop();}
