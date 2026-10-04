import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {chromium} from 'playwright';
import {serveSite} from './pages/server.mjs';
import {diskFixture} from './pages/fixture.mjs';
import {latest} from '../scripts/agent/store.mjs';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'my98-controller-'));
const fixture=await diskFixture({isolated:true}),server=await serveSite({headers:true}),browser=await chromium.launch();
const page=await browser.newPage();let running=false;
async function cli(command,argument='',credentials){
    const child=spawn(process.execPath,['scripts/agent.mjs',command,...(argument?[argument]:[]),'--state-dir',root],{stdio:['pipe','pipe','pipe']});
    child.stdin.end(credentials?JSON.stringify({...credentials,gateway:fixture.gateway}):'');
    let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
    await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
    const result=JSON.parse(output);if(result.ok&&command==='init')running=true;if(result.ok&&command==='stop')running=false;return result;
}
const credentials={username:'disk fixtures',password:'public compatibility password',machine:'main'};
try{
    await page.goto(server.url);
    const source=await page.evaluate(async bytes=>{
        const {Slop86Disk,DiskBuffer}=await import('./build/disk/web/client.js');
        const {createMachine,compatibility}=await import('./src/browser/machine-factory.js');
        const disk=await Slop86Disk.create();await disk.unlock('disk fixtures','public compatibility password','main');
        await disk.open(new Blob([new Uint8Array(bytes)]));
        const config={memory_size:16*1048576,vga_memory_size:1048576,boot_order:0x312,acpi:false,network:'ne2k'};
        const buffer=new DiskBuffer(disk,524288),container=document.createElement('div');container.innerHTML='<div></div><canvas></canvas>';document.body.append(container);
        const vm=await createMachine(buffer,config,container,{disableSpeaker:true});
        vm.run();await new Promise(resolve=>setTimeout(resolve,500));await vm.stop();await buffer.drain();
        vm.v86.cpu.mem8[0x70000]=41;await disk.write(10000,new Uint8Array([42]));buffer.snapshotReady=true;
        const state=await vm.save_state(),compat=await compatibility();
        const packed=await disk.saveState(state.slice(0),{version:1,config,compatibility:compat,running:true});
        const incompatible=await disk.saveState(state.slice(0),{version:1,config,compatibility:'wrong-build',running:true});
        const invalid=await disk.saveState(new ArrayBuffer(100),{version:1,config,compatibility:compat,running:true});
        await vm.destroy();await disk.close();
        return {packed:Array.from(new Uint8Array(await packed.blob.arrayBuffer())),incompatible:Array.from(new Uint8Array(await incompatible.blob.arrayBuffer())),invalid:Array.from(new Uint8Array(await invalid.blob.arrayBuffer()))};
    },Array.from(await fs.readFile(fixture.file)));
    assert.match((await cli('init','',credentials)).error,/no machine snapshot/);
    assert.equal((await cli('status')).loaded,false);
    await fixture.publishState(Buffer.from(source.incompatible));
    assert.match((await cli('init','',credentials)).error,/different emulator/);
    const corrupt=Buffer.from(source.packed);corrupt[corrupt.length-1]^=1;await fixture.publishState(corrupt);
    assert.match((await cli('init','',credentials)).error,/authentication/i);
    await fixture.publishState(Buffer.from(source.invalid));assert.equal((await cli('init','',credentials)).ok,false);
    await assert.rejects(fs.access(path.join(root,'latest.json')));
    const other=await diskFixture({isolated:true,sizeBytes:1048576});
    try{await fixture.publishState(Buffer.from(source.packed),await fs.readFile(other.file));assert.match((await cli('init','',credentials)).error,/different base disk/);}finally{await other.close();}
    const publication=await fixture.publishState(Buffer.from(source.packed));
    const imported=await cli('init','',credentials);assert.equal(imported.ok,true,imported.error);assert.equal(imported.muted,true);assert.equal(imported.headless,true);
    const saved=await latest(root);assert.equal(saved.meta.source.stateCid,publication.stateCid);assert.equal(saved.meta.source.cid,publication.diskCid);
    assert.equal((await fs.readFile(path.join(saved.dir,'disk.img')))[10000],42);
    // Exercise error cleanup and all mouse primitives on the actual browser runtime.
    // These test-only hooks observe bus events; the public CLI has no JS evaluator.
    const localDisk=await fs.readFile(path.join(saved.dir,'disk.img'));
    await page.route('**/_agent/runtime.js',route=>route.fulfill({path:'scripts/agent/runtime.js',contentType:'text/javascript'}));
    await page.route('**/_agent/input.js',route=>route.fulfill({path:'scripts/agent/input.js',contentType:'text/javascript'}));
    await page.route('**/_agent/state',route=>route.fulfill({path:path.join(saved.dir,'state.bin.gz')}));
    await page.route('**/_agent/disk?*',route=>{const u=new URL(route.request().url());return route.fulfill({body:localDisk.subarray(Number(u.searchParams.get('offset')),Number(u.searchParams.get('offset'))+Number(u.searchParams.get('length')))});});
    const inputChecks=await page.evaluate(async metadata=>{
        const {V86}=await import('./build/libv86.mjs'),restore=V86.prototype.restore_state;
        V86.prototype.restore_state=async function(...args){window.inputVM=this;return restore.apply(this,args);};
        await import('./_agent/runtime.js');await my98Agent.restore(metadata);await my98Agent.resume();
        const vm=inputVM,events=[],send=vm.bus.send;let failMouse=false;
        vm.bus.send=function(name,data){events.push([name,data]);const result=send.call(this,name,data);if(failMouse&&name==='mouse-click'&&data[0]){failMouse=false;throw Error('injected mouse failure');}return result;};
        const keyboard=vm.keyboard_send_scancodes;let failKeys=true;
        vm.keyboard_send_scancodes=async function(codes,delay){if(failKeys){failKeys=false;await keyboard.call(this,[codes[0]]);throw Error('injected key failure');}return keyboard.call(this,codes,delay);};
        let keyFailed=false,mouseFailed=false;
        try{await my98Agent.key('Ctrl+A');}catch(e){keyFailed=e.message.includes('injected');}
        const releasedCtrl=events.some(([name,data])=>name==='keyboard-code'&&data===0x9d);
        vm.mouse_adapter.absolute_mouse=true;failMouse=true;
        try{await my98Agent.mouse({action:'drag',x:1,y:1,toX:20,toY:20});}catch(e){mouseFailed=e.message.includes('injected');}
        const releasedButtons=events.filter(([name])=>name==='mouse-click').at(-1)[1].every(v=>v===false);
        const before=events.filter(([name,data])=>name==='mouse-click'&&data[0]).length;
        await my98Agent.mouse({action:'double',x:20,y:20});
        const doubleClicks=events.filter(([name,data])=>name==='mouse-click'&&data[0]).length-before;
        await my98Agent.mouse({action:'drag',x:20,y:20,toX:40,toY:30});await my98Agent.mouse({action:'wheel',delta:-2});await my98Agent.mouse({action:'relative',dx:5,dy:-3});
        const wheelEvents=events.filter(([name])=>name==='mouse-wheel').length;
        const relative=events.some(([name,data])=>name==='mouse-delta'&&data[0]===5&&data[1]===3);
        vm.mouse_adapter.absolute_mouse=false;await my98Agent.mouse({action:'drag',dx:24,dy:12});
        const relativeDrag=events.filter(([name,data])=>name==='mouse-delta'&&data[0]===2&&data[1]===-1).length===12;
        await my98Agent.close();return {keyFailed,releasedCtrl,mouseFailed,releasedButtons,doubleClicks,wheelEvents,relative,relativeDrag};
    },saved.meta);
    assert.deepEqual(inputChecks,{keyFailed:true,releasedCtrl:true,mouseFailed:true,releasedButtons:true,doubleClicks:2,wheelEvents:2,relative:true,relativeDrag:true});
    assert.equal((await fs.stat(root)).mode&0o777,0o700);assert.equal((await fs.stat(path.join(root,'control.sock'))).mode&0o777,0o600);
    const shot=await cli('screenshot');assert.equal(shot.ok,true,shot.error);assert.ok(shot.width>0&&shot.height>0);assert.ok((await fs.readFile(shot.path)).subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
    assert.match((await cli('type','prefix 😀')).error,/Windows-1252/);assert.equal((await cli('key','Ctrl+A')).ok,true);
    assert.equal((await cli('type','España ¿sí? €')).ok,true);assert.equal((await cli('mouse',JSON.stringify({action:'click',button:'right'}))).ok,true);
    assert.match((await cli('mouse',JSON.stringify({action:'drag',x:0,y:0,toX:100000,toY:0}))).error,/pointer|framebuffer/);
    const waiting=cli('wait','250');await new Promise(r=>setTimeout(r,50));const paused=cli('pause');assert.equal((await waiting).running,true);assert.equal((await paused).running,false);
    await cli('resume');
    // Disconnect after submission: server keeps its queue, and CLI never retries input.
    const dropped=net.createConnection(path.join(root,'control.sock'));await new Promise(r=>dropped.on('connect',r));
    dropped.write(JSON.stringify({command:'wait',ms:250})+'\n');await new Promise(r=>setTimeout(r,50));dropped.destroy();
    assert.equal((await cli('status')).running,true);
    // Block creation with a file, rather than permissions which root can bypass.
    const before=(await latest(root)).id,checkpoints=path.join(root,'checkpoints'),held=path.join(root,'checkpoints-held');
    await fs.rename(checkpoints,held);await fs.writeFile(checkpoints,'blocked fixture');
    try{const failed=await cli('stop');assert.equal(failed.ok,false);assert.match(failed.error,/EEXIST|ENOTDIR/);assert.equal((await cli('status')).running,true);}
    finally{await fs.rm(checkpoints,{force:true});await fs.rename(held,checkpoints);}
    assert.equal((await latest(root)).id,before);
    assert.equal((await cli('stop')).ok,true);assert.equal((await cli('status')).controller,false);
    assert.equal((await cli('start')).ok,true);running=true;await cli('pause');
    const restored=await latest(root),raw=gunzipSync(await fs.readFile(path.join(restored.dir,'state.bin.gz')));
    const marker=await page.evaluate(async({state,metadata,disk})=>{
        const {DiskBuffer}=await import('./build/disk/web/client.js');const {createMachine}=await import('./src/browser/machine-factory.js');
        const bytes=new Uint8Array(disk),buffer=new DiskBuffer({read:async(o,n)=>bytes.slice(o,o+n),write:async()=>{}},bytes.length);buffer.snapshotReady=true;
        const container=document.createElement('div');container.innerHTML='<div></div><canvas></canvas>';document.body.append(container);
        const vm=await createMachine(buffer,metadata.config,container,{disableSpeaker:true});await vm.restore_state(new Uint8Array(state).buffer);const marker=vm.v86.cpu.mem8[0x70000];await vm.destroy();return marker;
    },{state:Array.from(raw),metadata:restored.meta,disk:Array.from(await fs.readFile(path.join(restored.dir,'disk.img')))});
    assert.equal(marker,41);assert.equal((await fs.readFile(path.join(restored.dir,'disk.img')))[10000],42);
    console.log('PASS: import/overlay/CID binding, missing/corrupt/incompatible snapshots, headless/muted PNG, input errors, FIFO/disconnection, failed stop preserves session/checkpoint, full restart preserves RAM/disk');
}finally{
    await cli('stop').catch(()=>{});await browser.close();await server.close();await fixture.close();
    // Successful stop exits the detached daemon; avoid deleting an active socket on failure.
    if(!running)await fs.rm(root,{recursive:true,force:true});else console.error('Fixture controller retained for diagnosis:',root);
}
