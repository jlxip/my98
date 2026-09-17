// Dedicated disposable VM/browser. The source image is only read, never modified.
import {makeServer} from './server.mjs';
import {readFile,writeFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const repo=fileURLToPath(new URL('../../../',import.meta.url)),require=createRequire(import.meta.url);
if(process.argv.length!==3) {
 console.error('Usage: node src/disk/browser-tests/boot.mjs <fixture.json> (relative paths use the repository root)');
 process.exit(2);
}
const fixture=JSON.parse(await readFile(resolve(repo,process.argv[2]),'utf8'));
const sourcePath=resolve(repo,fixture.source),diskPath=resolve(repo,fixture.file);
const outputPrefix=fixture.gateway?'remote-':'';
const {chromium,webkit}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
async function hashFile(path){const h=createHash('sha256');for await(const b of createReadStream(path))h.update(b);return h.digest('hex');}
const sourceBefore=await hashFile(sourcePath);if(sourceBefore!==fixture.sha256)throw Error('Source mismatch');
const server=makeServer(repo);await new Promise(r=>server.listen(0,'127.0.0.1',r));const results=[];
try {for(const [name,type] of Object.entries({chromium,webkit})) {
 const browser=await type.launch({headless:true,args:name==='chromium'?['--mute-audio']:[]});
 try {const page=await browser.newPage({viewport:{width:1024,height:800}}),errors=[];page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>console.log(name+': '+m.text()));
 await page.goto(`http://127.0.0.1:${server.address().port}/disk/browser-tests/index.html`);
 await page.evaluate(()=>{document.body.innerHTML='<input type="file" id="fixture">';});await page.locator('#fixture').setInputFiles(diskPath);
 const before=await page.evaluate(async fixture=>{
  const file=document.querySelector('#fixture').files[0];const {Slop86Disk,DiskBuffer}=await import('/build/disk/web/client.js');const {V86}=await import('/build/libv86.mjs');
  let last=0;let c=await Slop86Disk.create({onProgress:p=>{if(performance.now()-last>5000){last=performance.now();console.log('verify '+(p.completed/1048576).toFixed(1)+' MiB');}}});await c.unlock('disk fixtures','public compatibility password','main');await (fixture.gateway ? c.openRemote({onlyLocalhost:true,gateway:fixture.gateway}) : c.open(file));
  const t=performance.now(),hash=Array.from(await c.verifyImage(),b=>b.toString(16).padStart(2,'0')).join('');const verifyMs=performance.now()-t;if(hash!==fixture.sha256)throw Error('Preboot hash mismatch');await c.close();
  c=await Slop86Disk.create();await c.unlock('disk fixtures','public compatibility password','main');const cold=performance.now();await (fixture.gateway ? c.openRemote({onlyLocalhost:true,gateway:fixture.gateway}) : c.open(file));await c.read(0,512);const coldMs=performance.now()-cold,reads=await c.readStats();
  if(reads.readBytes!==65796||reads.readCalls!==2)throw Error('Cold boot reads extra data');
  const actualRead=c.read.bind(c);let inject=true;c.read=async(offset,length)=>{if(inject&&offset>=65536){inject=false;throw Object.assign(Error('Injected transient disk read failure'),{code:'IO_ERROR'});}return actualRead(offset,length);};
  let blockedResolve;const blocked=new Promise(r=>blockedResolve=r);
  const adapter=new DiskBuffer(c,fixture.size,async e=>{window.diskFailure=e;await window.vm.stop();blockedResolve();});
  document.body.innerHTML='<div id="screen"><div style="white-space:pre;font:14px monospace;line-height:14px"></div><canvas></canvas></div>';
  const asset=async path=>({buffer:await(await fetch(path)).arrayBuffer()});
  const vm=new V86({wasm_path:'/build/v86.wasm',memory_size:128*1048576,vga_memory_size:8*1048576,bios:await asset('/bios/seabios.bin'),vga_bios:await asset('/bios/bochs-vgabios.bin'),hda:{disk_adapter:adapter},acpi:false,boot_order:0x312,disable_speaker:true,disable_keyboard:true,disable_mouse:true,screen_container:document.getElementById('screen'),autostart:false});
  await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('VM load timeout')),30000);vm.add_listener('emulator-loaded',()=>{clearTimeout(timeout);resolve();});});window.vm=vm;window.client=c;window.adapter=adapter;vm.run();
  await Promise.race([blocked,new Promise((_,reject)=>setTimeout(()=>reject(Error('I/O interruption not exercised')),30000))]);
  const instructions=vm.get_instruction_counter(),ram=vm.v86.cpu.mem8.slice(0,65536),state=await c.describe();await new Promise(r=>setTimeout(r,100));
  if(instructions!==vm.get_instruction_counter()||!ram.every((b,i)=>b===vm.v86.cpu.mem8[i]))throw Error('Paused VM changed RAM');
  await adapter.retry();if(adapter.failed)throw Error('Retry failed');vm.run();
  console.log('hash exact; cold '+coldMs.toFixed(2)+'ms, '+reads.readBytes+' bytes; recovered I/O, waiting desktop');
  return {hash,verifyMs,coldMs,reads,recovery:{instructions,ramSampleBytes:ram.length,ramPreserved:true,dirtyBytes:state.dirty_bytes}};
 },fixture);
 await page.waitForFunction(()=>{const c=document.querySelector('canvas');if(!c||c.width<640||c.height<480)return false;const p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let teal=0,bar=0;for(let i=0;i<p.length;i+=16)if(p[i]<10&&p[i+1]>=115&&p[i+1]<=140&&p[i+2]>=115&&p[i+2]<=140)teal++;
  for(let y=c.height-20;y<c.height-3;y++)for(let x=0;x<c.width;x++){const i=(y*c.width+x)*4,r=p[i],g=p[i+1],b=p[i+2];if(r>150&&r<220&&Math.abs(r-g)<12&&Math.abs(r-b)<12)bar++;}return teal>1000&&bar>c.width*8;},null,{timeout:180000,polling:1000});
 await page.waitForTimeout(5000);const after=await page.evaluate(async()=>{await vm.stop();return {instructions:vm.get_instruction_counter(),speakerAbsent:!vm.speaker_adapter,blocked:adapter.failed,stats:await client.describe()};});
 await page.screenshot({path:repo+`build/disk/${outputPrefix}win98-${name}.png`,fullPage:true});if(errors.length||after.blocked||!after.speakerAbsent)throw Error(JSON.stringify({errors,after}));
 await page.evaluate(async()=>{await vm.destroy();await client.close();});results.push({browser:name,version:browser.version(),before,after,errors});await writeFile(repo+`build/disk/${outputPrefix}win98-${name}.json`,JSON.stringify(results.at(-1),null,2));console.log(name+': desktop reached, silent, '+after.instructions+' instructions');
 }finally{await browser.close();}
}
if(await hashFile(sourcePath)!==sourceBefore)throw Error('Source changed');await writeFile(repo+`build/disk/${outputPrefix}win98-results.json`,JSON.stringify(results,null,2));
}finally{await new Promise(r=>server.close(r));}
