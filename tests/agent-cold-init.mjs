import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {diskFixture} from './pages/fixture.mjs';
import {latest} from '../scripts/agent/store.mjs';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'my98-cold-'));
const fixture=await diskFixture({isolated:true});
async function cli(command,...args){
    const processCLI=spawn(process.execPath,['scripts/agent.mjs',command,...args,'--state-dir',root],{stdio:['pipe','pipe','pipe']});
    processCLI.stdin.end(command==='init'?JSON.stringify({username:'disk fixtures',password:'public compatibility password',machine:'main',gateway:fixture.gateway}):'');
    let output='';processCLI.stdout.on('data',b=>output+=b);processCLI.stderr.on('data',b=>output+=b);
    await new Promise((resolve,reject)=>{processCLI.on('close',resolve);processCLI.on('error',reject);});return JSON.parse(output);
}
try{
    const imported=await cli('init','--cold');assert.equal(imported.ok,true,imported.error);assert.equal(imported.muted,true);
    const first=await latest(root);assert.equal(first.meta.source.cid,fixture.diskCid);assert.equal(first.meta.size,524288);
    assert.equal((await fs.readFile(path.join(first.dir,'disk.img')))[10000],0);
    assert.match((await cli('init','--cold')).error,/already imported/);
    assert.equal((await cli('stop')).ok,true);assert.equal((await cli('start')).ok,true);
    const shot=await cli('screenshot');assert.equal(shot.ok,true,shot.error);assert.ok(shot.width>0&&shot.height>0);
    assert.equal((await cli('screenshot')).ok,true);
    const payload=path.join(root,'SOURCE.ZIP');await fs.writeFile(payload,Buffer.from([0,255,1,128,2,0]));
    const previous=(await latest(root)).id;
    const inserted=await cli('send',payload);assert.equal(inserted.ok,true,inserted.error);assert.equal(inserted.files[0].size,6);
    const transfers=path.join(root,'transfers'),iso=(await fs.readdir(transfers))[0];
    assert.equal((await fs.stat(transfers)).mode&0o777,0o700);assert.equal((await fs.stat(path.join(transfers,iso))).mode&0o777,0o600);
    assert.equal((await cli('status')).cdrom,true);assert.equal((await cli('status')).running,true);
    assert.match((await cli('send',payload)).error,/already inserted/);
    assert.match((await cli('checkpoint')).error,/Eject/);assert.match((await cli('stop')).error,/Eject/);
    assert.equal((await latest(root)).id,previous);assert.equal((await cli('status')).running,true);
    assert.equal((await cli('eject')).ok,true);assert.equal((await cli('status')).cdrom,false);
    assert.deepEqual(await fs.readdir(path.join(root,'transfers')),[]);
    assert.equal((await cli('pause')).running,false);
    assert.match((await cli('send',path.join(root,'missing.zip'))).error,/ENOENT/);
    assert.equal((await cli('status')).cdrom,false);
    assert.equal((await cli('send',payload)).ok,true);assert.equal((await cli('status')).running,false);
    assert.equal((await cli('eject')).ok,true);assert.equal((await cli('status')).running,false);
    assert.equal((await cli('checkpoint')).ok,true);assert.equal((await cli('pause')).running,false);
    assert.equal((await cli('stop')).ok,true);assert.equal((await cli('start')).ok,true);assert.equal((await cli('status')).cdrom,false);
    fixture.verify(fixture.file);
    console.log('PASS: cold import/restart, local CD hot insertion/ejection, running/paused preservation, failed saves retain session/checkpoint, private media cleanup; source unchanged');
}finally{await cli('stop');await fixture.close();await fs.rm(root,{recursive:true,force:true});}
