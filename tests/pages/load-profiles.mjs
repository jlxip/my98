import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium,webkit} from 'playwright';
import {serveSite} from './server.mjs';
import {diskFixture} from './fixture.mjs';

await mkdir('build/load-profiles',{recursive:true});
const results=[];
for(const [name,type] of Object.entries({chromium,webkit})) {
    const fixture=await diskFixture({isolated:true}),server=await serveSite({headers:true}),browser=await type.launch();
    try {
        const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));
        await page.goto(server.url);
        const saved=await page.evaluate(async gateway=>{
            const {Slop86Disk}=await import('./build/disk/web/client.js');
            const d=await Slop86Disk.create();
            try {
                await d.unlock('disk fixtures','public compatibility password','main');
                await d.openRemote({gateway,servers:[{url:gateway,resolution:'gateway',discovery:false}],prefetch:{enabled:false}});
                const readKey=await d.exportReadOnlyKey();
                await d.write(10000,new Uint8Array([42]));
                const {blob}=await d.saveState(new Uint8Array([9,8,7,6]).buffer,{version:1});
                return {readKey,bytes:Array.from(new Uint8Array(await blob.arrayBuffer()))};
            }finally{await d.close();}
        },fixture.gateway);
        const bytes=Buffer.from(saved.bytes),hash=createHash('sha256').update(bytes).digest('hex');
        const profile={version:2,cid:fixture.diskCid,origin:{kind:'state',sha256:hash},unitBytes:65536,ranges:[[1,2],...Array(31).fill(null)]};
        const pub=await fixture.publishState(bytes,undefined,[profile]);
        fixture.delays.set(pub.profilesCid,700);
        const checks=await page.evaluate(async({pub,gateway,readKey,hash,bytes})=>{
            const {Slop86Disk}=await import('./build/disk/web/client.js');
            const checks=[],check=(label,ok)=>{if(!ok)throw Error(label);checks.push(label);};
            const d=await Slop86Disk.create();window.testDisk=d;
            async function settled() {
                for(let n=0;n<200;n++) {const s=(await d.readStats()).remote;if(s.prefetchState==='complete')return s;await new Promise(r=>setTimeout(r,10));}
                throw Error('prefetch did not settle');
            }
            try {
                await d.openReadOnly({cid:pub.publicationCid,readKey,gateway,prefetch:{enabled:false}});
                let prepared=await d.prepareState({published:true});
                check('RAM restored exactly',new Uint8Array(prepared.state).join(',')==='9,8,7,6');
                await d.commitState(prepared.token);
                await d.startLoadAnalysis({origin:'restored'});
                check('overlay restored', (await d.read(10000,1))[0]===42);
                await d.read(65536,32);await d.write(65536,new Uint8Array([11]));await d.read(65536,1);
                const [recorded]=await d.finishLoadAnalysis();
                check('profile binds exact file and base',recorded.version===2 && recorded.origin.sha256===hash && recorded.cid===pub.diskCid);
                check('logical reads include overlay and cached repeats only once',recorded.observedUnits===2);
                check('session writes remain permitted',(await d.read(65536,1))[0]===11);
                for(const operation of [()=>d.save(),()=>d.saveState(new ArrayBuffer(4),{}),()=>d.exportReadOnlyKey()]) {
                    try {await operation();throw Error('owner operation allowed');}catch(e){check('owner operation rejected',e.code==='READ_ONLY');}
                }
                try {await d.startLoadAnalysis({origin:'restored'});throw Error('stale origin allowed');}catch(e){check('recording requires freshly restored origin',e.code==='OPERATION_FAILED');}
                const started=performance.now();
                await d.setLoadPrefetch({origin:'restored',scope:'profile'});
                await d.read(10000,1);
                check('metadata fetch does not block RPC or demand',performance.now()-started<500);
                const complete=await settled();check('only selected ranges prefetched',complete.completedUnits<=3 && complete.completedUnits<complete.totalUnits && complete.rangeProfile.completedUnits===2 && complete.loadProfile.status==='complete');
                // Failed restore must keep the current overlay, origin and profile.
                const corrupt=new Uint8Array(bytes);corrupt[corrupt.length-1]^=1;
                try {await d.prepareState(new Blob([corrupt]));throw Error('corrupt state accepted');}catch(e){check('corrupt state rejected',e.code==='CORRUPTION'||e.code==='INVALID_STATE');}
                check('failed restore retains session write',(await d.read(65536,1))[0]===11);
                check('failed restore retains profile',(await d.readStats()).remote.loadProfile.origin.sha256===hash);
                await d.setLoadPrefetch({origin:'restored',scope:'disk'});let full=await settled();
                check('Exit scope completes entire disk',full.completedUnits===full.totalUnits);
                const calls=(await d.readStats()).networkRequests;
                await d.setLoadPrefetch({origin:'restored',scope:'disk'});await settled();
                check('repeated exit does not duplicate download',(await d.readStats()).networkRequests===calls);
                // Local and published copies have precisely the same binding.
                prepared=await d.prepareState(new Blob([new Uint8Array(bytes)]));await d.commitState(prepared.token);
                await d.startLoadAnalysis({origin:'restored'});await d.read(1,1);
                check('local file has same state identity',(await d.finishLoadAnalysis())[0].origin.sha256===hash);
                await d.clearCaches();await d.setLoadPrefetch({origin:'restored',scope:'profile'});d.cancel();
                await d.setLoadPrefetch({origin:'restored',scope:'profile'});await settled();
                check('cancel and retry settle without duplicate resources',(await d.readStats()).remote.inFlight===0);
            }finally{await d.close();}
            const fresh=await Slop86Disk.create();try {
                await fresh.openReadOnly({cid:pub.publicationCid,readKey,gateway,prefetch:{enabled:false}});
                const p=await fresh.prepareState({published:true});await fresh.commitState(p.token);
                check('new visit discards session writes',(await fresh.read(65536,1))[0]!==11);
                await fresh.discardWrites();
                const discarded=(await fresh.readStats()).remote.loadProfile;
                check('discard cancels the restored origin',discarded.origin.kind==='boot' && discarded.scope==='none');
                await fresh.startLoadAnalysis({origin:'boot'});await fresh.read(0,512);
                check('cold boot profile independent',(await fresh.finishLoadAnalysis())[0].origin.kind==='boot');
                await fresh.startBootAnalysis();await fresh.read(0,512);
                check('legacy API remains v1',(await fresh.finishBootAnalysis())[0].version===1);
            }finally{await fresh.close();}
            return checks;
        },{pub,gateway:fixture.gateway,readKey:saved.readKey,hash,bytes:saved.bytes});
        const variants=[['missing',undefined],['invalid',[{...profile,version:1}]],['mismatch',[{...profile,origin:{kind:'state',sha256:'0'.repeat(64)}}]],
            ['invalid',[profile,profile]],['invalid',new Uint8Array(65537)],['invalid',new TextEncoder().encode('bad JSON')]];
        for(const [expected,profiles] of variants) {
            const publication=await fixture.publishState(bytes,undefined,profiles);
            const result=await page.evaluate(async({publication,readKey,gateway})=>{
                const {Slop86Disk}=await import('./build/disk/web/client.js'),d=await Slop86Disk.create();
                try {
                    await d.openReadOnly({cid:publication.publicationCid,readKey,gateway,prefetch:{enabled:false}});
                    const p=await d.prepareState({published:true});await d.commitState(p.token);
                    await d.setLoadPrefetch({origin:'restored',scope:'profile'});
                    for(let n=0;n<300;n++) {const s=(await d.readStats()).remote;if(s.prefetchState==='complete')return {status:s.loadProfile.status,overlay:(await d.read(10000,1))[0]};await new Promise(r=>setTimeout(r,10));}
                    throw Error('optional hint stalled');
                }finally{await d.close();}
            },{publication,readKey:saved.readKey,gateway:fixture.gateway});
            assert.equal(result.status,expected);assert.equal(result.overlay,42);checks.push('optional '+expected+' profile preserves restoration');
        }
        assert.deepEqual(errors,[]);results.push({browser:name,checks,errors});console.log(`${name}: ${checks.length} load profile API checks PASS`);
    }finally{await browser.close();await server.close();await fixture.close();}
}
await writeFile('build/load-profiles/browser.json',JSON.stringify(results,null,2));
