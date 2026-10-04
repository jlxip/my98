import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {generate} from '../../vendor/slop86/src/iso9660.js';

export const MAX_MEDIA_BYTES=256*1048576;
const shortName=name=>{const dot=name.lastIndexOf('.');return dot<0?name.slice(0,8):name.slice(0,Math.min(8,dot))+'.'+name.slice(dot+1,dot+4);};
export const dosName=name=>shortName(shortName(name).toUpperCase().replace(/[^A-Z0-9_.]/g,''));
export async function createCD(paths){
    if(!Array.isArray(paths)||!paths.length||paths.length>42||paths.some(p=>typeof p!=='string'))throw new Error('send requires 1–42 file paths; zip directories first');
    const entries=[],names=new Set(),aliases=new Set();let total=0,directoryBytes=68;
    for(const file of paths){
        const name=path.basename(file),alias=dosName(name);
        if(!name||name.length>64||/[\x00-\x1f*\/:;?\\"<>|\ud800-\udfff]/.test(name)||/[ .]$/.test(name)||!/^[A-Z0-9_]{1,8}(?:\.[A-Z0-9_]{1,3})?$/.test(alias)||/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name))throw new Error('Unsupported Windows 98 CD filename: '+name);
        if(names.has(name.toUpperCase())||aliases.has(alias))throw new Error('Conflicting CD filename or DOS alias: '+name+' ('+alias+')');
        directoryBytes+=34+name.length*2;if(directoryBytes>=2048)throw new Error('Too many/long CD filenames; put them in one ZIP');
        const stat=await fs.stat(file);if(!stat.isFile())throw new Error('Not a regular file; zip directories first: '+file);
        total+=stat.size;if(total>MAX_MEDIA_BYTES)throw new Error('Files exceed the 256 MiB transfer limit');
        names.add(name.toUpperCase());aliases.add(alias);entries.push({file,name,alias,size:stat.size});
    }
    const contents=[];
    for(const entry of entries){
        const bytes=await fs.readFile(entry.file);if(bytes.length!==entry.size)throw new Error('File changed while preparing transfer: '+entry.file);
        contents.push({name:entry.name,contents:new Uint8Array(bytes.buffer,bytes.byteOffset,bytes.byteLength)});
        entry.sha256=createHash('sha256').update(bytes).digest('hex');
    }
    const image=generate(contents);
    return {image,files:entries.map(({name,alias,size,sha256})=>({name,dosName:alias,size,sha256})),bytes:image.byteLength};
}
