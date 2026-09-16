import {Slop86Disk,DiskBuffer} from '/build/disk/web/client.js';
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const hash=async b=>hex(new Uint8Array(await crypto.subtle.digest('SHA-256',b)));
export async function run(fixtures) {
 const checks=[],metrics={};const check=(name,value)=>{if(!value)throw Error(name);checks.push(name);};
 const rejects=async(name,fn,code)=>{try{await fn();}catch(e){check(name,!code||e.code===code);return;}throw Error(name+' did not reject');};
 const make=async options=>{const c=await Slop86Disk.create(options);await c.unlock('disk fixtures','public compatibility password','main');return c;};
 const fixture=fixtures[0],file=await(await fetch('/'+fixture.file)).blob(),plain=new Uint8Array(await(await fetch('/'+fixture.source)).arrayBuffer());
 let c=await make();let start=performance.now();await c.open(file);check('open reads only 198 header bytes',(await c.readStats()).readBytes===198);
 check('first sector exact',hex(await c.read(0,512))===hex(plain.slice(0,512)));metrics.coldMs=performance.now()-start;metrics.coldReads=await c.readStats();check('cold first sector only one record',metrics.coldReads.readBytes===65796&&metrics.coldReads.readCalls===2);
 check('cross-record unaligned exact',hex(await c.read(65533,12))===hex(plain.slice(65533,65545)));
 check('native to WASM full reconstruction',hex(await c.verifyImage())===fixture.sha256);
 await rejects('range bounds',()=>c.read(plain.length,1),'IO_ERROR');await rejects('one active disk',()=>c.open(file),'OPERATION_FAILED');
 const originalDownload=await c.downloadCurrent();check('download reuses original file',await hash(await originalDownload.blob.arrayBuffer())===await hash(await file.arrayBuffer()));
 await c.write(511,new Uint8Array([7,8,9]));await c.write(511,plain.slice(511,514));check('restored bytes are unchanged',(await c.save()).outcome==='unchanged');check('no-op clears pending',(await c.describe()).dirty_bytes===0);
 const expected=plain.slice();expected.set([13,14,15,16],65535);await c.write(65535,new Uint8Array([13,14,15,16]));expected[expected.length-1]=88;await c.write(expected.length-1,new Uint8Array([88]));
 await rejects('download rejects unsaved writes',()=>c.downloadCurrent(),'OPERATION_FAILED');
 const previous=(await c.describe()).disk_id.join();start=performance.now();const saved=await c.save();metrics.saveMs=performance.now()-start;metrics.fullBytes=saved.download.size;
 check('save creates full file',saved.outcome==='created'&&saved.download.size===file.size);check('save rotates disk context',saved.disk_id.join()!==previous);
 check('saved bytes exact',hex(await c.verifyImage())===await hash(expected));check('retry exact ciphertext',await hash(await (await c.retryDownload()).blob.arrayBuffer())===await hash(await saved.download.blob.arrayBuffer()));
 const output=new Uint8Array(await saved.download.blob.arrayBuffer());await c.close();
 for(const machine of ['Main',' main']) {const wrong=await Slop86Disk.create();await wrong.unlock('disk fixtures','public compatibility password',machine);await rejects('wrong Machine header-only '+machine,()=>wrong.open(file),'AUTHENTICATION_FAILED');check('wrong Machine reads header only',(await wrong.readStats()).readBytes===198);await wrong.close();}
 c=await make();const bytes=new Uint8Array(await file.arrayBuffer());bytes[134]^=1;await rejects('header signature corruption',()=>c.open(new Blob([bytes])),'CORRUPTION');check('failed open leaves context empty',await c.describe().then(()=>false,()=>true));
 await rejects('CAR rejected explicitly',()=>c.open(new Blob([new Uint8Array(300)])),'UNSUPPORTED_FORMAT');await rejects('truncated file',()=>c.open(file.slice(0,file.size-1)),'CORRUPTION');await rejects('trailing bytes',()=>c.open(new Blob([file,new Uint8Array(1)])),'CORRUPTION');await c.close();
 c=await make();const altered=new Uint8Array(await file.arrayBuffer());altered[198+46]^=1;await c.open(new Blob([altered]));await rejects('ciphertext corruption on demand',()=>c.read(0,1),'CORRUPTION');await c.close();
 c=await make();const mixed=output.slice();mixed.set(new Uint8Array(await file.slice(198,198+65598).arrayBuffer()),198);await c.open(new Blob([mixed]));await rejects('cross-save record substitution',()=>c.read(0,1),'CORRUPTION');await c.close();
 const failing=await make({workerUrl:new URL('./assembly-failure-worker.js',import.meta.url)});await failing.createFromImage(new Blob([plain]));const before=(await failing.describe()).disk_id.join();await failing.write(9,new Uint8Array([8]));await rejects('assembly failure',()=>failing.save());check('assembly failure preserves key and writes',(await failing.describe()).disk_id.join()===before&&(await failing.describe()).dirty_bytes===512);check('assembly retry succeeds',(await failing.save()).outcome==='created');await failing.close();
 let cancelOn=false,client;client=await make({onProgress:()=>{if(cancelOn){cancelOn=false;client.cancel();}}});await client.open(file);await client.write(1,new Uint8Array([77]));const old=(await client.describe()).disk_id.join();cancelOn=true;await rejects('cancel streamed save',()=>client.save(),'CANCELLED');check('cancel preserves disk and writes',(await client.describe()).disk_id.join()===old&&(await client.describe()).dirty_bytes===512);check('cancel retry succeeds',(await client.save()).outcome==='created');cancelOn=true;await rejects('cancel verification',()=>client.verifyImage(),'CANCELLED');await client.close();
 const io=await make({workerUrl:new URL('./io-failure-worker.js',import.meta.url)});await io.open(file);let stopped=0;const order=[],ram=new Uint8Array([4,5,6]);const adapter=new DiskBuffer(io,plain.length,async()=>{stopped++;});
 adapter.get(0,1,b=>{check('retried read exact',b[0]===plain[0]);order.push('read');});adapter.set(5,new Uint8Array([99]),()=>order.push('write'));adapter.get(5,1,b=>{check('queued read follows write',b[0]===99);order.push('last');});
 while(!adapter.failed)await new Promise(r=>setTimeout(r,5));check('E/O failure blocks all callbacks',order.length===0&&stopped===1);await adapter.retry();check('callbacks once in original order',order.join()==='read,write,last');check('adapter preserves host RAM',ram.join()==='4,5,6');check('pending writes kept',(await io.describe()).dirty_bytes===512);adapter.dispose();await io.close();
 // Larger opaque FAT32 image, free space, slack and partial tail; no filesystem interpretation.
 const fat=fixtures[1],fatFile=await(await fetch('/'+fat.file)).blob();c=await make();await c.open(fatFile);check('FAT32 exact full reconstruction',hex(await c.verifyImage())===fat.sha256);check('data cache bounded',(await c.describe()).cache_bytes<=32*1048576-512);await c.clearCaches();let stats=await c.readStats();await c.read(fat.size-1,1);check('far tail is direct access',(await c.readStats()).readBytes-stats.readBytes<=65598);await c.write(fat.size-1,new Uint8Array([122]));
 start=performance.now();const fatSaved=await c.save();metrics.fatSaveMs=performance.now()-start;metrics.fatFullBytes=fatSaved.download.size;
 check('FAT32 full save has no dependencies',fatSaved.outcome==='created'&&fatSaved.download.size===fatFile.size);
 check('FAT32 partial tail saved exactly',(await c.read(fat.size-1,1))[0]===122);window.fatOutput=fatSaved.download.blob;await c.close();
 return {checks,metrics,output:Array.from(output),expected:Array.from(expected)};
}
