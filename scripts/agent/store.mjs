import fs from 'node:fs/promises';
import {createReadStream,createWriteStream,constants} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createGzip} from 'node:zlib';
import {pipeline} from 'node:stream/promises';
import {execFile} from 'node:child_process';
export async function copyLocalFile(source,destination){
    if(process.platform==='darwin'){
        await new Promise((resolve,reject)=>execFile('/bin/cp',['-c',source,destination],error=>error?reject(error):resolve()));
    }else await fs.copyFile(source,destination,constants.COPYFILE_FICLONE);
}
export async function hashFile(file){const h=createHash('sha256');for await(const b of createReadStream(file))h.update(b);return h.digest('hex');}
export async function syncFile(file){const h=await fs.open(file,'r');try{await h.sync();}finally{await h.close();}}
export async function staging(root){const dir=path.join(root,'checkpoints','.pending-'+randomUUID());await fs.mkdir(dir,{recursive:true,mode:0o700});return dir;}
export async function commit(root,dir,metadata){
    const disk=path.join(dir,'disk.img'),raw=path.join(dir,'state.bin'),state=path.join(dir,'state.bin.gz');
    if((await fs.stat(disk)).size!==metadata.size)throw new Error('Checkpoint disk size differs from its metadata');
    if(!(await fs.stat(raw)).size)throw new Error('Empty machine state');
    await pipeline(createReadStream(raw),createGzip({level:1}),createWriteStream(state,{mode:0o600,flags:'wx'}));
    await fs.unlink(raw);
    const data={...metadata,version:1,createdAt:new Date().toISOString(),diskSha256:await hashFile(disk),stateSha256:await hashFile(state)};
    await fs.writeFile(path.join(dir,'metadata.json'),JSON.stringify(data,null,2),{mode:0o600,flag:'wx'});
    for(const file of ['disk.img','state.bin.gz','metadata.json'])await syncFile(path.join(dir,file));
    const id='checkpoint-'+Date.now()+'-'+randomUUID().slice(0,8),destination=path.join(root,'checkpoints',id);
    await fs.rename(dir,destination);
    await syncFile(destination);await syncFile(path.join(root,'checkpoints'));
    const next=path.join(root,'.latest-'+randomUUID());
    await fs.writeFile(next,JSON.stringify({id}),{mode:0o600,flag:'wx'});await syncFile(next);
    await fs.rename(next,path.join(root,'latest.json'));
    const parent=await fs.open(root,'r');try{await parent.sync();}finally{await parent.close();}
    return {id,...data};
}
export async function latest(root){
    const {id}=JSON.parse(await fs.readFile(path.join(root,'latest.json'),'utf8'));
    if(!/^checkpoint-\d+-[a-f0-9]{8}$/.test(id))throw new Error('Invalid checkpoint pointer');
    const dir=path.join(root,'checkpoints',id),meta=JSON.parse(await fs.readFile(path.join(dir,'metadata.json'),'utf8'));
    if(meta.version!==1||!Number.isSafeInteger(meta.size)||meta.size<=0||(await fs.stat(path.join(dir,'disk.img'))).size!==meta.size)throw new Error('Invalid checkpoint metadata');
    if(await hashFile(path.join(dir,'disk.img'))!==meta.diskSha256||await hashFile(path.join(dir,'state.bin.gz'))!==meta.stateSha256)throw new Error('Checkpoint integrity check failed');
    return {dir,meta,id};
}
export async function workingCopy(root,checkpoint){
    const file=path.join(root,'working.img');
    await copyLocalFile(path.join(checkpoint.dir,'disk.img'),file);await fs.chmod(file,0o600);return file;
}
