import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {diskFixture} from './fixture.mjs';
import {torrent,catalog,record,key} from '../feedtorrent-fixture.mjs';
export async function publicationFixture() {
    const source=await diskFixture(),raw=await readFile(source.source);raw[1024]=42;
    const rawB=source.source+'.b',encryptedB=source.file+'.b';await writeFile(rawB,raw);
    execFileSync(resolve('build/disk-target/release/examples/compat'),['pack',rawB,encryptedB]);
    const a=torrent(await readFile(source.file)),b=torrent(await readFile(encryptedB)),ca=catalog([['disk.torrent',a]]),cb=catalog([['disk.torrent',b]]);
    const entries=[a,b,ca,cb],wire=()=>Object.fromEntries(entries.map(t=>[t.hash,{metadata:Array.from(t.metadata),bytes:Array.from(t.bytes)}]));
    return {key,a,b,ca,cb,wire,record,addState(bytes,withProfile=false){const state=torrent(Buffer.from(bytes),'state.my98state'),profile=torrent(Buffer.from('[]\n'),'profile.json'),c=catalog([['disk.torrent',b],['state.torrent',state],...(withProfile?[['profile.torrent',profile]]:[])]);entries.push(state,profile,c);return c;},close:()=>source.close()};
}
export async function installPublicationFixture(page,fixture,initial=fixture.ca) {
    await page.route('**/src/disk/web/**',async route=>route.fulfill({body:await readFile(resolve('.'+new URL(route.request().url()).pathname)),contentType:'text/javascript'}));
    await page.evaluate(async({entries,initial})=>{
        const {DiskSession}=await import('/src/browser/disk-session.js'),open=DiskSession.prototype.openRemote;
        DiskSession.prototype.openRemote=function(...args){window.fixtureSession=this;return open.apply(this,args);};
        const {Slop86Disk}=await import('/build/disk/web/client.js'),{observeRecord}=await import('/src/disk/web/torrent-records.js');
        const {default:init,verify}=await import('/build/disk/pkg/slop86_disk.js');await init();
        window.fixtureEntries=Object.fromEntries(Object.entries(entries).map(([hash,t])=>[hash,{metadata:Uint8Array.from(t.metadata),bytes:Uint8Array.from(t.bytes)}]));
        window.announcePublication=value=>observeRecord(value,value.key,verify);
        await announcePublication(initial);
        const create=Slop86Disk.create;
        Slop86Disk.create=async function(events){
            const client=await create.call(this,events);window.fixtureClient=client;window.fixtureEvents=events;
            client.torrentHost.createTransport=()=>({
                async open({infoHash},signal){
                    if(window.fixtureHold){await window.fixtureHold(signal);}
                    if(window.fixtureError)throw Object.assign(Error('Injected source failure'),{code:'TRANSPORT_ERROR'});
                    if(!fixtureEntries[infoHash])throw Error('Unknown fixture torrent '+infoHash);
                },
                entry(hash){return fixtureEntries[hash];},
                async read({infoHash,offset,length}){return fixtureEntries[infoHash].bytes.slice(offset,offset+length);},
                setBackground(){},stopPrefetch(){},prefetch(){},cancel(){},async close(){},
                describe(entry){return {coveredBytes:entry.bytes.length,totalBytes:entry.bytes.length,received:0};}
            });return client;
        };
    },{entries:fixture.wire(),initial:record(initial.hash,'100')});
}
export async function makePublishedState(page,fixture) {
    return page.evaluate(async({encrypted,base})=>{
        const {Slop86Disk,DiskBuffer}=await import('/build/disk/web/client.js');
        const {createMachine,compatibility}=await import('/src/browser/machine-factory.js');
        const {DEFAULT_CONFIG}=await import('/src/browser/machine-config.js');
        const client=await Slop86Disk.create();let machine;
        try {
            await client.unlock('disk fixtures','public compatibility password','main');
            const description=await client.open(new Blob([Uint8Array.from(encrypted)])),adapter=new DiskBuffer(client,description.size);
            const config={...DEFAULT_CONFIG,memory_size:32*1048576};
            const container=document.createElement('div');container.innerHTML='<div></div><canvas></canvas>';
            machine=await createMachine(adapter,config,container,{disableSpeaker:true});
            await adapter.drain();adapter.snapshotReady=true;
            const state=await client.saveState(await machine.save_state(),{version:1,config,compatibility:await compatibility(),running:true,baseInfoHash:base});
            return {bytes:Array.from(new Uint8Array(await state.blob.arrayBuffer())),readKey:await client.exportReadOnlyKey()};
        } finally {await machine?.destroy();await client.close();}
    },{encrypted:Array.from(fixture.b.bytes),base:fixture.b.hash});
}
