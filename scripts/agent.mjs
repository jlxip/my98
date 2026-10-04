#!/usr/bin/env node
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
import {latest,staging,commit,workingCopy,copyLocalFile} from './agent/store.mjs';
import {createCD} from './agent/media.mjs';

process.umask(0o077);
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),option=args.indexOf('--state-dir');
const root=path.resolve(option<0?path.join(os.homedir(),'.local/state/my98-agent'):args.splice(option,2)[1]);
const socket=path.join(root,'control.sock'),command=args.shift();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const errorText=e=>e.message||String(e);
async function rpc(request){return new Promise((resolve,reject)=>{
    const connection=net.createConnection(socket);let buffer='';
    connection.on('connect',()=>connection.end(JSON.stringify(request)+'\n'));
    connection.on('error',reject);
    connection.on('data',bytes=>{buffer+=bytes;if(buffer.length>1048576){connection.destroy();reject(new Error('Oversized response'));}});
    connection.on('end',()=>{try{resolve(JSON.parse(buffer));}catch{reject(new Error('Controller disconnected; input outcome is unknown. Do not retry input automatically.'));}});
});}
async function available(){try{return await rpc({command:'status'});}catch(e){if(['ENOENT','ECONNREFUSED'].includes(e.code))return null;throw e;}}
async function launch(){
    if(await available())return;
    await fs.mkdir(root,{recursive:true,mode:0o700});await fs.chmod(root,0o700);
    const log=await fs.open(path.join(root,'controller.log'),'a',0o600);
    const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'daemon','--state-dir',root],{detached:true,stdio:['ignore',log.fd,log.fd]});child.unref();await log.close();
    for(let i=0;i<300;i++){await sleep(100);if(await available())return;}
    throw new Error('Controller did not start; inspect '+path.join(root,'controller.log'));
}

async function daemon(){
    await fs.mkdir(root,{recursive:true,mode:0o700});await fs.chmod(root,0o700);
    const lock=path.join(root,'controller.lock');
    try{await fs.mkdir(lock,{mode:0o700});}catch(e){
        if(e.code!=='EEXIST')throw e;
        let pid;try{pid=Number(await fs.readFile(path.join(lock,'pid'),'utf8'));}catch{}
        if(!pid)throw new Error('Controller startup already in progress');
        try{process.kill(pid,0);throw new Error('Controller already running');}catch(err){if(err.code!=='ESRCH')throw err;}
        await fs.rm(lock,{recursive:true});await fs.mkdir(lock,{mode:0o700});
    }
    await fs.writeFile(path.join(lock,'pid'),String(process.pid));await fs.rm(socket,{force:true});
    let browser,page,disk,diskSize,statePath,current,transfer,media,queue=Promise.resolve(),closing=false;
    const token=randomBytes(32).toString('hex');
    const assets=JSON.parse(await fs.readFile(path.join(repo,'scripts/site-assets.json'),'utf8'));
    assets['_agent/runtime.js']='scripts/agent/runtime.js';assets['_agent/input.js']='scripts/agent/input.js';
    const mime=file=>file.endsWith('.js')||file.endsWith('.mjs')?'text/javascript':file.endsWith('.wasm')?'application/wasm':'application/octet-stream';
    async function body(req){const chunks=[];let length=0;for await(const b of req){length+=b.length;if(length>1048576)throw new Error('Request too large');chunks.push(b);}return Buffer.concat(chunks);}
    const server=http.createServer(async(req,res)=>{
        res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
        res.setHeader('Cache-Control','no-store');
        try{
            if(!/^127\.0\.0\.1:\d+$/.test(req.headers.host||''))throw new Error('Invalid local host');
            const url=new URL(req.url,'http://127.0.0.1');
            if(url.pathname==='/_agent/'&&req.method==='GET'){
                res.setHeader('Content-Type','text/html');res.end('<!doctype html><base href="/"><div id="screen"><div></div><canvas></canvas></div><script type="module" src="/_agent/runtime.js"></script>');return;
            }
            const asset=assets[url.pathname.slice(1)];
            if(asset&&req.method==='GET'){res.setHeader('Content-Type',mime(asset));createReadStream(path.join(repo,asset)).pipe(res);return;}
            if(req.headers['x-my98-agent']!==token)throw new Error('Unauthorized runtime request');
            if(url.pathname==='/_agent/state'&&req.method==='GET'){
                if(!statePath)throw new Error('No checkpoint state');res.setHeader('Content-Type','application/gzip');createReadStream(statePath).pipe(res);return;
            }
            if(url.pathname==='/_agent/media'&&req.method==='GET'){
                if(!media)throw new Error('No transfer CD');res.setHeader('Content-Type','application/octet-stream');res.setHeader('Content-Length',media.bytes);createReadStream(media.path).pipe(res);return;
            }
            if(url.pathname==='/_agent/disk'){
                if(!disk)throw new Error('No active disk');
                const offset=Number(req.method==='GET'?url.searchParams.get('offset'):req.headers['x-offset']);
                const length=Number(url.searchParams.get('length'));
                if(req.method==='GET'&&(!Number.isSafeInteger(length)||length<=0||length>8388608))throw new Error('Invalid disk read length');
                const bytes=req.method==='GET'?Buffer.alloc(length):await body(req);
                if(!Number.isSafeInteger(offset)||offset<0||!bytes.length||bytes.length>8388608||offset+bytes.length>diskSize)throw new Error('Invalid disk range');
                if(req.method==='GET'){const {bytesRead}=await disk.read(bytes,0,bytes.length,offset);if(bytesRead!==bytes.length)throw new Error('Short disk read');res.end(bytes);}
                else if(req.method==='POST'){const {bytesWritten}=await disk.write(bytes,0,bytes.length,offset);if(bytesWritten!==bytes.length)throw new Error('Short disk write');res.end('ok');}
                else throw new Error('Invalid disk method');return;
            }
            const match=/^\/_agent\/(import|checkpoint)\/(disk|state)$/.exec(url.pathname);
            if(match&&req.method==='POST'){
                const entry=transfer?.[match[2]],bytes=await body(req),offset=Number(req.headers['x-offset']);
                if(!entry||transfer.kind!==match[1]||offset!==entry.offset||!bytes.length||offset+bytes.length>entry.limit)throw new Error('Invalid checkpoint transfer');
                await entry.handle.write(bytes,0,bytes.length,offset);entry.offset+=bytes.length;res.end('ok');return;
            }
            throw new Error('Unknown runtime route');
        }catch(e){if(!res.headersSent)res.statusCode=400;res.end(errorText(e));}
    });
    const listen=(s,...where)=>new Promise((resolve,reject)=>{s.once('error',reject);s.listen(...where,resolve);});
    const call=async(method,...params)=>{if(!page)throw new Error('Use start first');return page.evaluate(({method,params})=>globalThis.my98Agent[method](...params),{method,params});};
    async function openPage(){
        if(page)return;
        browser=await chromium.launch({headless:true,args:['--mute-audio']});
        page=await browser.newPage({viewport:{width:1280,height:1024}});
        page.on('requestfailed',request=>{if(request.url().includes('/_agent/disk'))console.error('Local disk request failed:',request.method(),request.failure()?.errorText);});
        page.on('console',message=>{if(message.type()==='error'&&message.text().startsWith('Local disk transport retry'))console.error(message.text());});
        await page.addInitScript(value=>{globalThis.agentToken=value;},token);
        await page.goto('http://127.0.0.1:'+server.address().port+'/_agent/');
        await page.waitForFunction(()=>!!globalThis.my98Agent);
    }
    async function restore(){
        await openPage();current=await latest(root);const file=await workingCopy(root,current);
        disk=await fs.open(file,'r+');diskSize=current.meta.size;statePath=path.join(current.dir,'state.bin.gz');
        try{await call('restore',current.meta);}catch(e){await disk.close();disk=undefined;throw e;}
    }
    async function openTransfer(kind,dir,size){
        transfer={kind,state:{handle:await fs.open(path.join(dir,'state.bin'),'wx',0o600),offset:0,limit:1073741824}};
        if(kind==='import')transfer.disk={handle:await fs.open(path.join(dir,'disk.img'),'wx',0o600),offset:0,limit:size};
    }
    async function closeTransfer(){if(!transfer)return;for(const key of ['disk','state'])if(transfer[key]){await transfer[key].handle.sync();await transfer[key].handle.close();}transfer=undefined;}
    async function checkpoint(){
        const before=await call('status');if(!before.loaded)throw new Error('No loaded machine');
        let dir;
        try{
            const metadata=await call('beginCapture');await disk.sync();dir=await staging(root);
            await copyLocalFile(path.join(root,'working.img'),path.join(dir,'disk.img'));
            await fs.chmod(path.join(dir,'disk.img'),0o600);await openTransfer('checkpoint',dir,metadata.size);
            await call('exportCapture');await closeTransfer();const saved=await commit(root,dir,{...metadata,source:current.meta.source});
            current={id:saved.id,meta:saved,dir:path.join(root,'checkpoints',saved.id)};statePath=path.join(current.dir,'state.bin.gz');return {checkpoint:saved.id};
        }finally{await closeTransfer();if(dir)await fs.rm(dir,{recursive:true,force:true});if(before.running)await call('resume');}
    }
    async function execute(request){
        if(closing)throw new Error('Controller is stopping');
        switch(request.command){
        case 'status':return {...(page?await call('status'):{loaded:false,running:false,headless:true}),pid:process.pid,checkpoint:current?.id||null,...(media?{media:{files:media.files,bytes:media.bytes}}:{})};
        case 'init':{
            try{await fs.access(path.join(root,'latest.json'));throw new Error('Machine already imported; use start');}catch(e){if(e.code!=='ENOENT')throw e;}
            await openPage();if((await call('status')).loaded)throw new Error('Machine already loaded; save it with checkpoint');let dir;
            try{
                const metadata=await call('prepareImport',request.credentials,request.gateway,request.coldBoot===true);dir=await staging(root);
                await openTransfer('import',dir,metadata.size);await call('exportImport');await closeTransfer();
                if(request.coldBoot){
                    await copyLocalFile(path.join(dir,'disk.img'),path.join(root,'working.img'));await fs.chmod(path.join(root,'working.img'),0o600);
                    disk=await fs.open(path.join(root,'working.img'),'r+');diskSize=metadata.size;current={meta:metadata};
                    await call('boot',metadata);await checkpoint();return {...await call('status'),checkpoint:current.id};
                }
                await commit(root,dir,metadata);await restore();await call('resume');return {...await call('status'),checkpoint:current.id};
            }finally{request.credentials=undefined;await closeTransfer();if(dir)await fs.rm(dir,{recursive:true,force:true});}
        }
        case 'start':if(!page||!(await call('status')).loaded)await restore();return call('resume');
        case 'cold-local':{
            if(page&&(await call('status')).loaded)throw new Error('Stop the local machine before cold-local');
            if(!Number.isInteger(request.memoryMiB)||request.memoryMiB<16||request.memoryMiB>512)throw new Error('Local RAM must be 16–512 MiB');
            current=await latest(root);
            const size=request.diskMiB===undefined?current.meta.size:request.diskMiB*1048576;
            if(!Number.isSafeInteger(size)||size<current.meta.size||size>32768*1048576)throw new Error('Local disk growth must preserve existing bytes and remain at most 32 GiB');
            const metadata={...current.meta,size,config:{...current.meta.config,memory_size:request.memoryMiB*1048576}};
            await openPage();const file=await workingCopy(root,current);
            if(size>current.meta.size)await fs.truncate(file,size);
            disk=await fs.open(file,'r+');diskSize=metadata.size;
            try{return {...await call('boot',metadata),coldLocal:true,checkpoint:current.id};}
            catch(e){await disk.close();disk=undefined;throw e;}
        }
        case 'resume':return call('resume');
        case 'pause':return call('pause');
        case 'type':return call('type',request.text);
        case 'key':return call('key',request.key);
        case 'mouse':return call('mouse',request.mouse);
        case 'send':{
            const status=await call('status');if(!status.loaded)throw new Error('Use start first');if(status.cdrom)throw new Error('CD already inserted; use eject before sending another batch');
            const cd=await createCD(request.paths);const directory=path.join(root,'transfers');await fs.mkdir(directory,{recursive:true,mode:0o700});
            const file=path.join(directory,randomBytes(12).toString('hex')+'.iso');await fs.writeFile(file,cd.image,{mode:0o600,flag:'wx'});
            media={path:file,files:cd.files,bytes:cd.bytes};
            try{await call('insertCD');return {inserted:true,files:cd.files,bytes:cd.bytes};}
            catch(e){if(!(await call('status')).cdrom){await fs.rm(file,{force:true});media=undefined;}throw e;}
        }
        case 'eject':{
            const result=await call('ejectCD');if(media){await fs.rm(media.path,{force:true});media=undefined;}return result;
        }
        case 'wait':if(!Number.isInteger(request.ms)||request.ms<0||request.ms>60000)throw new Error('Wait must be 0–60000 ms');await sleep(request.ms);return call('status');
        case 'screenshot':{
            const shot=await call('screenshot');if(!shot.data.startsWith('data:image/png;base64,'))throw new Error('Invalid screenshot');
            const dir=path.join(root,'screenshots');await fs.mkdir(dir,{mode:0o700,recursive:true});const file=path.join(dir,Date.now()+'.png');
            await fs.writeFile(file,Buffer.from(shot.data.split(',')[1],'base64'),{mode:0o600});return {path:file,width:shot.width,height:shot.height};
        }
        case 'checkpoint':return checkpoint();
        case 'stop':{
            const saved=page&&(await call('status')).loaded?await checkpoint():{};
            closing=true;await cleanup();return {...saved,stopped:true};
        }
        default:throw new Error('Unknown command');
        }
    }
    const control=net.createServer({allowHalfOpen:true},connection=>{
        let data='',submitted=false;
        connection.on('error',()=>{});
        connection.on('data',bytes=>{data+=bytes;if(data.length>131072){connection.destroy();return;}
            if(!submitted&&data.includes('\n')){
                submitted=true;let request;try{request=JSON.parse(data.slice(0,data.indexOf('\n')));}catch{connection.end(JSON.stringify({ok:false,error:'Invalid JSON'})+'\n');return;}
                queue=queue.then(async()=>{
                    try{connection.end(JSON.stringify({ok:true,...await execute(request)})+'\n');}
                    catch(e){await call('release').catch(()=>{});connection.end(JSON.stringify({ok:false,error:errorText(e)})+'\n');}
                });
            }
        });
    });
    async function cleanup(){await browser?.close();await disk?.close();server.close();control.close();await fs.rm(socket,{force:true});await fs.rm(lock,{recursive:true,force:true});}
    try{await listen(server,0,'127.0.0.1');await listen(control,socket);await fs.chmod(socket,0o600);}
    catch(e){await cleanup();throw e;}
    // Graceful termination has the same save-before-close contract as the CLI.
    for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{queue=queue.then(()=>execute({command:'stop'})).catch(e=>console.error('Stop failed:',errorText(e)));});
}

try{
    if(command==='daemon')await daemon();
    else if(!command||command==='--help')console.log('Usage: node scripts/agent.mjs COMMAND [ARG] [--state-dir PATH]\ninit reads {username,password,machine,gateway?} from stdin. init --cold explicitly clones only the disk and creates its own local state. cold-local RAM_MIB [DISK_MIB] cold boots the latest local disk with 16–512 MiB RAM and optional disk growth up to 32 GiB; partition/format new space inside the guest. No import or publication. Commands: start status screenshot type TEXT key Ctrl+A mouse JSON wait MS send FILE... eject checkpoint pause resume stop. send inserts a local read-only CD (files/ZIPs, up to 256 MiB); copy to C: inside Windows and eject before checkpoint/stop.');
    else{
        let request={command};
        if(command==='init'){let data='';for await(const b of process.stdin){data+=b;if(data.length>8192)throw new Error('Credentials input too large');}const {gateway,...credentials}=JSON.parse(data);request={command,credentials,gateway,coldBoot:args.includes('--cold')};}
        if(command==='type')request.text=args.join(' ');
        if(command==='key')request.key=args.join(' ');
        if(command==='mouse')request.mouse=JSON.parse(args.join(' '));
        if(command==='send')request.paths=args.map(file=>path.resolve(file));
        if(command==='wait')request.ms=Number(args[0]);
        if(command==='cold-local'){request.memoryMiB=Number(args[0]);if(args[1]!==undefined)request.diskMiB=Number(args[1]);}
        if(command==='status'&&!(await available())){let saved;try{saved=await latest(root);}catch(e){if(e.code!=='ENOENT')throw e;}console.log(JSON.stringify({ok:true,loaded:false,running:false,controller:false,checkpoint:saved?.id||null}));}
        else{if(['start','init','cold-local'].includes(command))await launch();const result=await rpc(request);console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1;}
    }
}catch(e){console.log(JSON.stringify({ok:false,error:errorText(e)}));process.exitCode=1;}
