import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
export async function diskFixture({sizeBytes=512*1024}={}) {
    const base=resolve('build/pages-tests');await mkdir(base,{recursive:true});
    const directory=await mkdtemp(base+'/fixture-'),source=directory+'/fixture.img',file=directory+'/fixture.my98';
    const bytes=new Uint8Array(sizeBytes);bytes.set([0xfa,0xf4,0xeb,0xfd]);bytes[510]=85;bytes[511]=170;
    await writeFile(source,bytes);
    const run=(...args)=>execFileSync(resolve('build/disk-target/release/examples/compat'),args,{encoding:'utf8'});
    const packed=JSON.parse(run('pack',source,file));
    return {...packed,source,file,verify(path,expected=source){run('verify',path,expected);},async close(){await rm(directory,{recursive:true,force:true});}};
}
