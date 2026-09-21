import {Slop86Disk, DiskBuffer} from '/build/disk/web/client.js';

export async function runReadOnly(f) {
    const checks = [];
    const check = (name, value) => { if(!value) throw Error(name); checks.push(name); };
    const rejects = async(name, fn, code) => {
        try { await fn(); } catch(error) { check(name, !code || error.code === code); return; }
        throw Error(name + ' did not reject');
    };
    const hex = bytes => Array.from(bytes, b=>b.toString(16).padStart(2,'0')).join('');
    const file = document.querySelector('#encrypted').files[0];
    const plain = new Uint8Array(await document.querySelector('#plain').files[0].arrayBuffer());
    let owner, c, adapter;
    try {
        owner = await Slop86Disk.create();
        await owner.unlock('disk fixtures', 'public compatibility password', 'main');
        await rejects('export needs an open disk', ()=>owner.exportReadOnlyKey(), 'OPERATION_FAILED');
        const owned = await owner.open(file);
        check('owner state remains writable', owned.readOnly === false);
        const readKey = await owner.exportReadOnlyKey();
        check('versioned 48-byte capability', /^my98-ro-v1\.[A-Za-z0-9_-]{64}$/.test(readKey) && readKey.length === 75);
        await owner.write(7, new Uint8Array([99]));
        await rejects('dirty owner cannot export', ()=>owner.exportReadOnlyKey(), 'OPERATION_FAILED');
        await owner.discardWrites();
        check('discard preserves original capability', await owner.exportReadOnlyKey() === readKey);
        await rejects('owner cannot switch mode in place', ()=>owner.openReadOnly({cid:f.cid0, readKey}), 'OPERATION_FAILED');
        await owner.close(); owner = undefined;
        const options = {cid:f.cid0, readKey, gateway:f.endpoint, prefetch:{enabled:false}};
        c = await Slop86Disk.create();
        const networkBefore = await window.gatewayRequestCount();
        for(const bad of ['', 'my98-ro-v2.'+'A'.repeat(64), readKey+'=', readKey+'\n', readKey.slice(1), readKey.slice(0,-1)+'!', null]) {
            await rejects('malformed key rejected', ()=>c.openReadOnly({...options, readKey:bad}), 'INVALID_READ_KEY');
        }
        for(const readKey of [null, 'not bytes', new Uint8Array(47)]) {
            await rejects('worker validates capability bytes', ()=>c.call('openReadOnly',{...options,readKey}), 'INVALID_READ_KEY');
        }
        for(const cid of ['', '/ipfs/'+f.cid0, f.cid0+'/file', 'https://example.com/'+f.cid0, ' '+f.cid0, 'k51-invalid', f.ipnsName, null]) {
            await rejects('non-CID rejected', ()=>c.openReadOnly({...options, cid}), 'INVALID_CID');
        }
        check('invalid inputs cause no requests', await window.gatewayRequestCount() === networkBefore);
        await rejects('directory CID rejected', ()=>c.openReadOnly({...options,cid:f.directoryCid}), 'UNSUPPORTED_FORMAT');
        for(const pos of [11, 40]) {
            const wrong = readKey.slice(0,pos) + (readKey[pos] === 'A' ? 'B' : 'A') + readKey.slice(pos+1);
            await rejects('wrong capability rejected before open', ()=>c.openReadOnly({...options, readKey:wrong}), 'CORRUPTION');
            await rejects('failed open leaves no disk', ()=>c.describe(), 'OPERATION_FAILED');
        }
        for(const cid of [f.cid0, f.cid1]) {
            const state = await c.openReadOnly({...options,cid});
            check('direct CID opens without identity', state.readOnly && state.size === plain.length && !('ipnsName' in state.remote) && !('sequence' in state.remote));
            const reads = await c.readStats();
            check('header and first chunk authenticated', reads.readBytes >= 198 + 65536 + 62);
            check('cross-record read exact', hex(await c.read(65533,12)) === hex(plain.slice(65533,65545)));
            check('full plaintext verified', hex(await c.verifyImage()) === f.sha256);
            await c.close(); c = await Slop86Disk.create();
        }
        const state = await c.openReadOnly(options);
        const restricted = [
            ['save', ()=>c.save()], ['create', ()=>c.createFromImage(new Blob([plain]))],
            ['create empty', ()=>c.createEmpty(512)], ['export', ()=>c.exportReadOnlyKey()],
            ['download', ()=>c.downloadCurrent()], ['retry download', ()=>c.retryDownload()],
            ['unlock', ()=>c.unlock('u','p','main')], ['open local', ()=>c.open(file)],
            ['open identity remote', ()=>c.openRemote({gateway:f.endpoint})],
        ];
        for(const [name,fn] of restricted) await rejects(name+' restricted in worker',fn,'READ_ONLY');
        await c.startBootAnalysis(); await c.read(65536,512);
        check('analysis remains available', (await c.finishBootAnalysis())[0].cid === state.remote.cid);
        await c.clearCaches(); await window.setGatewayMode('missing');
        await c.write(512, new Uint8Array(512).fill(7));
        await rejects('partial write fails atomically', ()=>c.write(65535, new Uint8Array([1,2,3])), 'IO_ERROR');
        check('previous writes retained on network failure', (await c.describe()).dirty_sectors === 1);
        let stopped = 0; const order = [];
        adapter = new DiskBuffer(c, state.size, ()=>{stopped++;});
        adapter.get(0, 1, b=>{check('adapter retry returns correct byte', b[0] === plain[0]); order.push('read');});
        adapter.set(17, new Uint8Array([211]), ()=>order.push('write'));
        const deadline = performance.now() + 5000;
        while(!adapter.failed && performance.now() < deadline) await new Promise(r=>setTimeout(r,5));
        check('adapter stops with queued operations intact', adapter.failed && stopped === 1 && order.length === 0);
        await window.setGatewayMode('small'); await adapter.retry();
        check('adapter retries operations exactly once', order.join() === 'read,write');
        adapter.dispose(); adapter = undefined;
        check('overlay visible', (await c.read(17,1))[0] === 211 && (await c.read(512,1))[0] === 7);
        for(const mode of ['corrupt','truncated']) {
            await window.setGatewayMode('small');const broken=await Slop86Disk.create();
            try {
                await broken.openReadOnly({...options,prefetch:{enabled:false}});await broken.clearCaches();await window.setGatewayMode(mode);
                await rejects('tampered CID block rejected: '+mode, ()=>broken.read(2*65536,1),'CORRUPTION');
                await window.setGatewayMode('small');await rejects('corrupt endpoint stays excluded: '+mode,()=>broken.read(2*65536,1),'IO_ERROR');
            }finally{await broken.close();}
        }
        await window.setGatewayMode('hang'); await c.clearCaches();
        const pending = c.read(2*65536,1); setTimeout(()=>c.cancel(),100);
        await rejects('read cancellation', ()=>pending, 'CANCELLED');
        check('cancellation preserves writes', (await c.describe()).dirty_sectors === 2);
        await window.setGatewayMode('small'); await c.resumePrefetch();
        check('retry keeps overlay', (await c.read(17,1))[0] === 211);
        await c.discardWrites();
        check('discard restores original hash', hex(await c.verifyImage()) === f.sha256);
        await c.write(17,new Uint8Array([211])); await c.close();
        c = await Slop86Disk.create(); await c.openReadOnly(options);
        check('reopen loses writes', (await c.read(17,1))[0] === plain[17] && !(await c.describe()).dirty_bytes);
        await c.close(); c = await Slop86Disk.create();
        await window.setGatewayMode('hang');
        const opening = c.openReadOnly(options); setTimeout(()=>c.cancel(),100);
        await rejects('opening cancellation', ()=>opening,'CANCELLED');
        await rejects('cancelled opening leaves no disk', ()=>c.describe(),'OPERATION_FAILED');
        await window.setGatewayMode('small'); await c.openReadOnly(options);
        check('open retries after cancellation', (await c.describe()).readOnly);
        await c.close(); c = undefined;
        // A page reload must destroy the only copy of the overlay, even without an explicit close.
        c = await Slop86Disk.create(); await c.openReadOnly(options); await c.write(17,new Uint8Array([211]));
        window.reloadClient = c; c = undefined;
        return {checks};
    } finally {adapter?.dispose(); await owner?.close(); await c?.close(); await window.setGatewayMode('small');}
}

export async function bootReadOnly(f) {
    const file = document.querySelector('#encrypted').files[0];
    const owner = await Slop86Disk.create(); let c, vm, adapter;
    try {
        await owner.unlock('disk fixtures','public compatibility password','main'); await owner.open(file);
        const readKey = await owner.exportReadOnlyKey(); await owner.close();
        c = await Slop86Disk.create();
        const options = {cid:f.cid0,readKey,gateway:f.endpoint,prefetch:{enabled:false}};
        const state = await c.openReadOnly(options);
        if((await c.read(17,1))[0] !== f.original17 || state.dirty_bytes) throw Error('Reload retained writes');
        const {V86} = await import('/build/libv86.mjs');
        let ioError;
        adapter = new DiskBuffer(c,state.size,error=>{ioError=error;});
        const asset = async path=>({buffer:await (await fetch(path)).arrayBuffer()});
        vm = new V86({wasm_path:'/build/v86.wasm',memory_size:32*1048576,vga_memory_size:2*1048576,
            bios:await asset('/bios/seabios.bin'),vga_bios:await asset('/bios/bochs-vgabios.bin'),
            hda:{disk_adapter:adapter},acpi:false,boot_order:0x312,disable_speaker:true,
            disable_keyboard:true,disable_mouse:true,autostart:false});
        let serial = '';
        vm.add_listener('serial0-output-byte', byte=>{serial+=String.fromCharCode(byte);});
        await new Promise((resolve,reject)=>{
            const timer = setTimeout(()=>reject(Error('VM load timeout')),30000);
            vm.add_listener('emulator-loaded',()=>{clearTimeout(timer);resolve();});
        });
        vm.run();
        const deadline = performance.now()+30000;
        while(!serial.includes('\n') && !ioError && performance.now()<deadline) await new Promise(r=>setTimeout(r,20));
        await vm.stop();
        if(ioError) throw ioError;
        if(!serial.includes('READ_ONLY_BOOT_OK')) throw Error('Guest disk roundtrip failed: '+JSON.stringify({serial,instructions:vm.get_instruction_counter(),ip:vm.v86.cpu.instruction_pointer,boot:Array.from(vm.v86.cpu.mem8.slice(0x7c00,0x7c20)),state:await c.describe(),reads:await c.readStats()}));
        const after = await c.describe();
        if(!after.readOnly || after.dirty_bytes !== 512 || hexPair(await c.read(512,2)) !== 'efbe') throw Error('Guest write missing');
        await vm.destroy(); vm=undefined; adapter.dispose(); adapter=undefined; await c.close();
        c=await Slop86Disk.create(); await c.openReadOnly(options);
        if(hexPair(await c.read(512,2)) !== '0000' || (await c.describe()).dirty_bytes) throw Error('Guest write persisted');
        return {serial:serial.trim(),dirtyBytes:after.dirty_bytes,reloadDiscarded:true,guestWritesDiscarded:true};
    } finally {await vm?.destroy();adapter?.dispose();await c?.close();await owner.close();}
}
const hexPair = bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
