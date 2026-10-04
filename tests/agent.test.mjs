import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chordCodes,textCodes} from '../scripts/agent/input.js';
import {staging,commit,latest,workingCopy} from '../scripts/agent/store.mjs';
import {createCD,MAX_MEDIA_BYTES} from '../scripts/agent/media.mjs';

test('transfer ISO preserves binary files and Joliet names, rejects ambiguous or oversized batches',async t=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'my98-media-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const binary=Buffer.from(Array.from({length:8193},(_,i)=>i%256));
    const files=[path.join(root,'Español.zip'),path.join(root,'EMPTY.TXT')];
    await fs.writeFile(files[0],binary);await fs.writeFile(files[1],'');
    const cd=await createCD(files),image=Buffer.from(cd.image);
    assert.equal(image.subarray(16*2048+1,16*2048+6).toString(),'CD001');
    const entries=[];let offset=24*2048;
    while(image[offset]){const len=image[offset],nameLen=image[offset+32];if(!(image[offset+25]&2)){
        const nameBytes=Buffer.from(image.subarray(offset+33,offset+33+nameLen));nameBytes.swap16();
        const start=image.readUInt32LE(offset+2)*2048,size=image.readUInt32LE(offset+10);
        entries.push({name:nameBytes.toString('utf16le'),bytes:image.subarray(start,start+size)});
    }offset+=len;}
    assert.deepEqual(entries.map(e=>e.name),['Español.zip','EMPTY.TXT']);
    assert.deepEqual(entries[0].bytes,binary);assert.equal(entries[1].bytes.length,0);
    await assert.rejects(createCD([root]),/regular file/);
    const alias1=path.join(root,'abcdefgh-one.zip'),alias2=path.join(root,'abcdefgh-two.zip');
    await fs.writeFile(alias1,'a');await fs.writeFile(alias2,'b');
    await assert.rejects(createCD([alias1,alias2]),/Conflicting/);
    const huge=path.join(root,'HUGE.ZIP'),handle=await fs.open(huge,'w');await handle.truncate(MAX_MEDIA_BYTES+1);await handle.close();
    await assert.rejects(createCD([huge]),/256 MiB/);
    const longFiles=Array.from({length:20},(_,i)=>path.join(root,String(i).padStart(2,'0')+'x'.repeat(60)));
    await Promise.all(longFiles.map(file=>fs.writeFile(file,'')));
    await assert.rejects(createCD(longFiles),/Too many/);
    await assert.rejects(createCD([path.join(root,'bad|file.txt')]),/Unsupported/);
});

test('Spanish and CP1252 input validates fully before returning scancodes',()=>{
    assert.ok(textCodes('España: áéíóú ü ñ ¿¡ € “hola”\n').includes(0x38));
    assert.throws(()=>textCodes('valid prefix then 😀'),/Windows-1252/);
    assert.throws(()=>textCodes('\u0081'),/Windows-1252/);
    assert.deepEqual(chordCodes('Ctrl+Alt+Delete'),[0x1d,0x38,0xe0,0x53,0xe0,0xd3,0xb8,0x9d]);
    assert.throws(()=>chordCodes('Delete+A'),/modifiers/);
});
test('checkpoint pairs bytes, preserves previous on failure, verifies integrity',async t=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'my98-agent-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const dir=await staging(root);await fs.writeFile(path.join(dir,'disk.img'),Buffer.alloc(512,7));await fs.writeFile(path.join(dir,'state.bin'),'fixture-memory');
    const first=await commit(root,dir,{size:512,config:{memory_size:16777216},compatibility:'fixture'});
    assert.equal((await latest(root)).id,first.id);
    const work=await workingCopy(root,await latest(root));await fs.writeFile(work,Buffer.alloc(512,9));
    assert.equal((await fs.readFile(path.join(root,'checkpoints',first.id,'disk.img')))[0],7);
    const broken=await staging(root);await fs.writeFile(path.join(broken,'disk.img'),Buffer.alloc(512));await fs.writeFile(path.join(broken,'state.bin'),Buffer.alloc(0));
    await assert.rejects(commit(root,broken,{size:512}),/Empty machine state/);
    assert.equal((await latest(root)).id,first.id);
    await fs.writeFile(path.join(root,'checkpoints',first.id,'state.bin.gz'),'corrupt');
    await assert.rejects(latest(root),/integrity/);
});
