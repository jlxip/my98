import {makeServer} from './server.mjs';
import {readFile,writeFile,copyFile,open} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const repo=fileURLToPath(new URL('../../',import.meta.url)),require=createRequire(import.meta.url);
const {chromium,webkit}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fixtures=JSON.parse(await readFile(repo+'build/disk/native.json','utf8'));
const server=makeServer(repo),results=[];await new Promise(r=>server.listen(0,'127.0.0.1',r));
try {for(const [name,type] of Object.entries({chromium,webkit})) {
 const browser=await type.launch({headless:true,args:name==='chromium'?['--mute-audio']:[]});
 try {const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));await page.goto(`http://127.0.0.1:${server.address().port}/disk/browser-tests/index.html`);await page.waitForFunction(()=>typeof window.run==='function');
 const result=await page.evaluate(f=>window.run(f),fixtures);if(errors.length)throw Error(errors.join('\n'));
 await writeFile(repo+`build/disk/browser-${name}.my98`,Buffer.from(result.output));await writeFile(repo+`build/disk/browser-${name}.img`,Buffer.from(result.expected));delete result.output;delete result.expected;
 const downloadEvent=page.waitForEvent('download');await page.evaluate(()=>{const a=document.createElement('a');a.href=URL.createObjectURL(window.fatOutput);a.download='fat.my98';a.click();});const download=await downloadEvent;await download.saveAs(repo+`build/disk/browser-${name}-fat.my98`);
 await copyFile(repo+fixtures[1].source,repo+`build/disk/browser-${name}-fat.img`);const fatExpected=await open(repo+`build/disk/browser-${name}-fat.img`,'r+');await fatExpected.write(Buffer.from([122]),0,1,fixtures[1].size-1);await fatExpected.close();
 execFileSync(repo+'build/disk-target/release/examples/compat',['verify',`build/disk/browser-${name}-fat.my98`,`build/disk/browser-${name}-fat.img`],{cwd:repo,stdio:'inherit'});

 const ui=await page.evaluate(async()=>{const {runUi}=await import('/disk/browser-tests/ui.mjs');return runUi();});
 results.push({browser:name,version:browser.version(),...result,ui});console.log(name+': '+result.checks.length+' core + '+ui.length+' UI checks passed '+JSON.stringify(result.metrics));
 execFileSync(repo+'build/disk-target/release/examples/compat',['verify',`build/disk/browser-${name}.my98`,`build/disk/browser-${name}.img`],{cwd:repo,stdio:'inherit'});
 // Cancellation without SharedArrayBuffer must still be observed before accepting a save.
 await page.goto(`http://127.0.0.1:${server.address().port}/disk/browser-tests/index.html?no-isolation`);
 const cancellation=await page.evaluate(async()=>{const {Slop86Disk}=await import('/build/disk/web/client.js');let c,armed=false;c=await Slop86Disk.create({onProgress:()=>{if(armed){armed=false;c.cancel();}}});await c.unlock('u','p','main');const source=new Blob([new Uint8Array(4*1048576)]);armed=true;let code;try{await c.createFromImage(source);}catch(e){code=e.code;}const absent=await c.describe().then(()=>false,()=>true);await c.close();return {isolated:crossOriginIsolated,code,absent};});
 if(cancellation.isolated||cancellation.code!=='CANCELLED'||!cancellation.absent)throw Error(JSON.stringify(cancellation));results.at(-1).cancellationWithoutIsolation=cancellation;if(errors.length)throw Error(errors.join('\n'));
 }finally{await browser.close();}
}
await writeFile(repo+'build/disk/browser-results.json',JSON.stringify(results,null,2));
}finally{await new Promise(r=>server.close(r));}
