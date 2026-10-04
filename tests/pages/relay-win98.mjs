// Real Windows boot/restore using the public-credentials fixture and the real WSS relay.
import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {chordCodes,textCodes} from '../../scripts/agent/input.js';
import {unlockIdentity,bootEncrypted} from './encrypted.mjs';
const fixture=JSON.parse(await readFile(process.env.MY98_RELAY_WIN98_FIXTURE || 'build/relay-pilot/win98-fixture.json','utf8'));
const prefix=JSON.parse(process.env.MY98_RELAY_ADMIN_JSON || '["python3","scripts/seedbox.py"]');
const admin=(command,publicKey)=>JSON.parse(execFileSync(prefix[0],[...prefix.slice(1),'relay-'+command,...(publicKey?[publicKey]:[])],{encoding:'utf8'}));
const results=[];
for(const [name,type] of Object.entries({chromium,webkit})) {
 const browser=await type.launch(),context=await browser.newContext({viewport:{width:1280,height:1000}});
 let publicKey;
 try {
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));page.on('dialog',d=>d.accept());
  await page.goto('http://127.0.0.1:8686/');await page.waitForFunction(()=>!document.body.inert);
  await page.evaluate(async()=>{
   const {V86}=await import('./build/libv86.mjs'),run=V86.prototype.run,init=V86.prototype.continue_init;
   V86.prototype.continue_init=function(cpu,options){return init.call(this,cpu,{...options,disable_speaker:true});};
   V86.prototype.run=function(){window.vm=this;return run.call(this);};
   const restore=V86.prototype.restore_state;
   V86.prototype.restore_state=async function(...args){await restore.apply(this,args);window.vm=this;};
   const {Slop86Disk}=await import('./build/disk/web/client.js'),create=Slop86Disk.create;
   Slop86Disk.create=async(...args)=>{const client=await create.apply(Slop86Disk,args);window.disk=client;return client;};
  });
  await unlockIdentity(page);
  publicKey=await page.evaluate(async()=>Array.from(await disk.relayPublicKey(),b=>b.toString(16).padStart(2,'0')).join(''));
  admin('allow',publicKey);
  const chooser=page.waitForEvent('filechooser');await page.locator('#disk-open').click();await(await chooser).setFiles(fixture.file);
  await page.waitForFunction(()=>!document.querySelector('#disk-boot').disabled);
  await page.locator('#disk-boot').click();
  await page.waitForFunction(()=>window.vm&&document.querySelector('#relay-status').textContent==='Internet connected.',null,{timeout:60000});
  assert.equal(await page.evaluate(()=>!vm.speaker_adapter),true,'Test VMs must have no audio adapter');
  await page.evaluate(()=>document.querySelector('#fullscreen').click());
  await page.waitForFunction(()=>!document.querySelector('#vm-view').classList.contains('expanded'));
  await page.waitForFunction(()=>{
   const c=document.querySelector('#vga');if(!c||c.width<640||c.height<480)return false;
   const p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let teal=0,bar=0;
   for(let i=0;i<p.length;i+=16)if(p[i]<10&&p[i+1]>=115&&p[i+1]<=140&&p[i+2]>=115&&p[i+2]<=140)teal++;
   for(let y=c.height-20;y<c.height-3;y++)for(let x=0;x<c.width;x++){const i=(y*c.width+x)*4,r=p[i],g=p[i+1],b=p[i+2];if(r>150&&r<220&&Math.abs(r-g)<12&&Math.abs(r-b)<12)bar++;}
   return teal>1000&&bar>c.width*8;
  },null,{timeout:240000,polling:1000});
  await page.screenshot({path:'build/relay-pilot/'+name+'-win98-boot.png',fullPage:true});
  await page.waitForTimeout(5000); // Explorer and its first-run window must finish starting.
  // Pause before measuring RAM; the guest is allowed to change it while running.
  const saved=await page.evaluate(async()=>{await vm.stop();window.originalVM=vm;return {instructions:vm.get_instruction_counter(),ram:Array.from(vm.v86.cpu.mem8.slice(0x70000,0x70040)),dirty:(await disk.describe()).dirty_bytes};});
  if(process.env.MY98_RELAY_RESTART_JSON) {
   const generation=await page.evaluate(()=>vm.network_adapter.generation);
   const restart=JSON.parse(process.env.MY98_RELAY_RESTART_JSON);
   execFileSync(restart[0],restart.slice(1),{stdio:'pipe'});
   await page.waitForFunction(previous=>vm.network_adapter.ready&&vm.network_adapter.generation>previous,generation,{timeout:60000});
  }
  admin('revoke',publicKey);
  await page.waitForFunction(()=>document.querySelector('#relay-status').textContent.includes('rejected'));
  admin('allow',publicKey);await page.locator('#relay-retry').click();
  await page.waitForFunction(()=>document.querySelector('#relay-status').textContent==='Internet connected.');
  const after=await page.evaluate(async()=>({sameVM:vm===originalVM,instructions:vm.get_instruction_counter(),ram:Array.from(vm.v86.cpu.mem8.slice(0x70000,0x70040)),dirty:(await disk.describe()).dirty_bytes}));
  assert.equal(after.sameVM,true);delete after.sameVM;assert.deepEqual(after,saved);
  const download=page.waitForEvent('download');await page.locator('#save-state').click();
  const state='build/relay-pilot/'+name+'-win98.my98state';await(await download).saveAs(state);
  const pick=page.waitForEvent('filechooser');await page.locator('#load-state').click();await(await pick).setFiles(state);
  await page.waitForFunction(()=>document.querySelector('#disk-status').textContent.includes('State restored'),null,{timeout:90000});
  await page.waitForFunction(()=>document.querySelector('#relay-status').textContent==='Internet connected.');
  assert.equal(await page.evaluate(()=>vm!==originalVM),true);
  assert.deepEqual(await page.evaluate(()=>Array.from(vm.v86.cpu.mem8.slice(0x70000,0x70040))),saved.ram);
  await page.screenshot({path:'build/relay-pilot/'+name+'-win98-restored.png',fullPage:true});
  await page.evaluate(()=>vm.run());
  // The public Windows fixture uses a Spanish keyboard and first-run LAN wizard.
  // Verify HTTP payload on the actual NE2K receive bus, as well as its screenshot.
  if(process.env.MY98_RELAY_HTTP_PROBE) {
   await page.waitForTimeout(5000);
   await page.evaluate(()=>{
    window.actualGuestHTTP=false;vm.keyboard_set_enabled(true);
    vm.emulator_bus.register('net0-receive',bytes=>{
     if(new TextDecoder().decode(bytes).includes('my98 Internet works'))window.actualGuestHTTP=true;
    });
   });
   const key=async chord=>page.evaluate(codes=>vm.keyboard_send_scancodes(codes,30),chordCodes(chord));
   await key('Alt+F4');await page.waitForTimeout(500);
   await key('Win+R');await page.waitForTimeout(700);await key('NumLock');
   await page.evaluate(codes=>vm.keyboard_send_scancodes(codes,20),textCodes(process.env.MY98_RELAY_HTTP_PROBE));
   await key('Enter');await page.waitForTimeout(5000);
   // Manual connection, LAN, no proxy, no mail account, finish.
   for(const chords of [['Down','Down','Enter'],['Down','Enter'],['Space','Enter'],['Down','Enter'],['Enter']]) {
    for(const chord of chords)await key(chord);
    await page.waitForTimeout(1500);
   }
   await page.screenshot({path:'build/relay-pilot/'+name+'-win98-http.png',fullPage:true});
   await page.waitForFunction(()=>window.actualGuestHTTP,null,{timeout:30000});
   await page.waitForTimeout(2000);
   await page.screenshot({path:'build/relay-pilot/'+name+'-win98-http.png',fullPage:true});
  }
  await page.evaluate(()=>disk.close());assert.equal(await page.evaluate(()=>vm.network_adapter.closed),true);
  assert.deepEqual(errors,[]);results.push({browser:name,boot:true,restore:true,actualWSS:true,ramAndWritesPreserved:true,identityClose:true,muted:true,...(process.env.MY98_RELAY_RESTART_JSON?{actualRelayRestart:true}:{}),...(process.env.MY98_RELAY_HTTP_PROBE?{guestHTTP:await page.evaluate(()=>actualGuestHTTP)}:{})});
 } finally {if(publicKey)admin('revoke',publicKey);await browser.close();}
}
await writeFile('build/relay-pilot/win98-results.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results));
