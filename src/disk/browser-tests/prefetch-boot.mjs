// Disposable Win98 boots against a local, verified IPFS fixture. No guest network or audio.
// Usage: node src/disk/browser-tests/prefetch-boot.mjs fixture.json [all|baseline|matrix|local|policy:concurrency,...] [runs=3] [output-directory]
// Baseline uses a separately preserved, instrumented build/disk/web/baseline-worker.js.
import {fixture,repo} from './ipfs-fixture.mjs';
import {makeServer} from './server.mjs';
import {webkit} from 'playwright';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';

if(!process.argv[2]) throw Error('A public-credentials Windows 98 fixture is required');
const original=JSON.parse(await readFile(resolve(repo,process.argv[2]),'utf8'));
const selection=process.argv[3] || 'matrix',runs=Number(process.argv[4] || 3);
const hash=createHash('sha256');for await(const chunk of createReadStream(resolve(repo,original.source)))hash.update(chunk);
if(hash.digest('hex')!==original.sha256)throw Error('Source image mismatch');
const cases=selection==='matrix' ? ['sequential:1','sequential:2','demand:1','demand:2','head-demand:1','head-demand:2'] : selection==='all' ? ['baseline','local','sequential:1','sequential:2','demand:1','demand:2','head-demand:1','head-demand:2'] : selection.split(',');
const f=selection==='local'?null:await fixture({small:original});
const server=makeServer(repo),output=resolve(repo,process.argv[5] || 'build/disk/prefetch');await mkdir(output,{recursive:true});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let sendReady=0;
const proxy=createServer(async(req,res)=>{
    res.setHeader('Access-Control-Allow-Origin','*');
    try {
        const response=await fetch(f.endpoint+req.url,{headers:{accept:req.headers.accept || '*/*'}});
        const bytes=new Uint8Array(await response.arrayBuffer());
        await new Promise(r=>setTimeout(r,150));
        sendReady=Math.max(performance.now(),sendReady)+bytes.length/8388608*1000;
        await new Promise(r=>setTimeout(r,Math.max(0,sendReady-performance.now())));
        if(!res.destroyed) res.writeHead(response.status,{'Content-Type':response.headers.get('content-type') || 'application/octet-stream'}).end(bytes);
    }catch{if(!res.destroyed)res.writeHead(502).end();}
});
if(f)await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
const results=[];
try {
    for(let run=0;run<runs;run++) for(const name of [...cases.slice(run%cases.length),...cases.slice(0,run%cases.length)]) {
        sendReady=0;
        const browser=await webkit.launch({headless:true});
        try {
            const page=await browser.newPage({viewport:{width:1024,height:800}}),errors=[];
            page.on('pageerror',e=>errors.push(String(e)));
            await page.goto(`http://127.0.0.1:${server.address().port}/disk/browser-tests/index.html`);
            await page.evaluate(()=>{document.body.innerHTML='<input type="file" id="fixture">';});
            if(name==='local')await page.locator('#fixture').setInputFiles(resolve(repo,original.file));
            const [policy,concurrency]=name.split(':');
            await page.evaluate(async options=>{
                const {Slop86Disk,DiskBuffer}=await import('/build/disk/web/client.js');
                const {V86}=await import('/build/libv86.mjs');
                const asset=async path=>({buffer:await(await fetch(path)).arrayBuffer()});
                const bios=await asset('/bios/seabios.bin'),vga=await asset('/bios/bochs-vgabios.bin');
                const c=await Slop86Disk.create(options.name==='baseline'?{workerUrl:'/build/disk/web/baseline-worker.js'}:{});
                await c.unlock('disk fixtures','public compatibility password','main');
                window.started=performance.now();
                if(options.name==='local')await c.open(document.querySelector('#fixture').files[0]);
                else await c.openRemote({gateway:options.gateway,prefetch:{policy:options.policy,concurrency:options.concurrency,trace:true}});
                const adapter=new DiskBuffer(c,options.size,e=>{window.bootError=String(e);void window.vm?.stop();});
                document.body.innerHTML='<div id="screen"><div style="white-space:pre;font:14px monospace;line-height:14px"></div><canvas></canvas></div>';
                const vm=new V86({wasm_path:'/build/v86.wasm',memory_size:128*1048576,vga_memory_size:8*1048576,bios,vga_bios:vga,hda:{disk_adapter:adapter},acpi:false,boot_order:0x312,disable_speaker:true,disable_keyboard:true,disable_mouse:true,screen_container:document.getElementById('screen'),autostart:false});
                await new Promise(r=>vm.add_listener('emulator-loaded',r));
                window.vm=vm;window.client=c;vm.run();
            },{name,policy:name==='baseline'?'sequential':policy,concurrency:Number(concurrency)||1,size:original.size,gateway:f?`http://127.0.0.1:${proxy.address().port}`:undefined});
            await page.waitForFunction(()=>{
                if(window.bootError)throw Error(window.bootError);
                const c=document.querySelector('canvas');if(!c||c.width<640||c.height<480)return false;
                const p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let teal=0,bar=0,icons=0,title=0;
                for(let i=0;i<p.length;i+=16)if(p[i]<10&&p[i+1]>=115&&p[i+1]<=140&&p[i+2]>=115&&p[i+2]<=140)teal++;
                for(let y=c.height-20;y<c.height-3;y++)for(let x=0;x<c.width;x++){const i=(y*c.width+x)*4,r=p[i],g=p[i+1],b=p[i+2];if(r>150&&r<220&&Math.abs(r-g)<12&&Math.abs(r-b)<12)bar++;}
                for(let y=0;y<c.height-45;y++)for(let x=0;x<70;x++){const i=(y*c.width+x)*4;if(p[i]>220&&p[i+1]>220&&p[i+2]>220)icons++;}
                // This fixture opens Welcome to Windows 98 after Explorer has populated its desktop.
                for(let y=55;y<130;y++)for(let x=80;x<Math.min(600,c.width);x++){const i=(y*c.width+x)*4;if(p[i]<30&&p[i+1]<130&&p[i+2]>p[i+1]+50)title++;}
                if(teal>1000&&bar>c.width*8&&icons>500&&title>1000){
                    if(!window.desktopFirstSeen)window.desktopFirstSeen=performance.now();
                    if(performance.now()-window.desktopFirstSeen>=500){window.desktopMs=performance.now()-window.started;return true;}
                }else window.desktopFirstSeen=undefined;
                return false;
            },null,{timeout:240000,polling:250}).catch(async error=>{
                await page.screenshot({path:resolve(output,`${name.replace(':','-')}-${run+1}-failed.png`)}).catch(()=>{});
                throw error;
            });
            const data=await page.evaluate(async()=>{await vm.stop();const stats=await client.readStats();client.cancel();return {desktopMs,stats,disk:await client.describe(),trace:await client.readTrace()};});
            await page.screenshot({path:resolve(output,`${name.replace(':','-')}-${run+1}.png`)});
            if(errors.length)throw Error(errors.join('\n'));
            if(policy==='ranges' && !data.stats.remote?.rangeProfile)throw Error('No matching range profile for this disk');
            const entry={name,run:run+1,browser:'webkit',version:browser.version(),criterion:'desktop icons, taskbar and Welcome title visible for 500 ms',latencyMs:name==='local'?0:150,bandwidthBytesPerSecond:name==='local'?undefined:8388608,...data,errors};
            await writeFile(resolve(output,`${name.replace(':','-')}-${run+1}.json`),JSON.stringify(entry));
            const summary={...entry,trace:undefined,guestReadMs:name==='local'?undefined:data.trace.filter(e=>e.type==='guest-read').reduce((n,e)=>n+e.ms,0)};
            results.push(summary);console.log(JSON.stringify(summary));
            await writeFile(resolve(output,`${selection.includes(',')?'experiment':selection.replace(':','-')}-results.json`),JSON.stringify(results,null,2));
            await page.evaluate(async()=>{await vm.destroy();await client.close();});
        } finally {await browser.close();}
    }
} finally {
    if(f){proxy.closeAllConnections();await new Promise(r=>proxy.close(r));await f.close();}
    server.closeAllConnections();await new Promise(r=>server.close(r));
}
