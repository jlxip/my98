import {Slop86Disk,DiskBuffer} from '/build/disk/web/client.js';
import {createMachine,compatibility} from '/src/browser/machine-factory.js';
import {validateConfig,DEFAULT_CONFIG} from '/src/browser/machine-state.js';
import {chordCodes,textCodes} from './input.js';
let vm,adapter,config,source,pendingState;
const headers=()=>({'X-My98-Agent':globalThis.agentToken});
async function request(route,{method='GET',body,offset}={}){
    const response=await fetch('/_agent/'+route,{method,headers:{...headers(),...(offset!==undefined?{'X-Offset':String(offset)}:{})},body});
    if(!response.ok)throw new Error(await response.text());return response;
}
async function transfer(route,bytes){for(let offset=0;offset<bytes.byteLength;offset+=1048576)await request(route,{method:'POST',body:new Uint8Array(bytes,offset,Math.min(1048576,bytes.byteLength-offset)),offset});}
const client={
    async read(offset,length){return localDiskRequest(async()=>new Uint8Array(await(await request('disk?offset='+offset+'&length='+length)).arrayBuffer()));},
    async write(offset,bytes){await localDiskRequest(async()=>{await(await request('disk',{method:'POST',body:bytes,offset})).text();});}
};
// Local disk reads and writes at a fixed offset are idempotent. Consume write
// responses and retry transient fetch failures without fabricating disk data.
async function localDiskRequest(operation){
    for(let attempt=0;;attempt++){
        try{return await operation();}
        catch(error){
            if(!(error instanceof TypeError)||attempt>=2)throw error;
            console.error('Local disk transport retry',attempt+1,error.message);
            await new Promise(resolve=>setTimeout(resolve,100*(attempt+1)));
        }
    }
}
function requireVM(){if(!vm)throw new Error('The agent machine is not initialized');}
function requireRunning(){requireVM();if(!vm.is_running())throw new Error('Machine paused; use resume');}
async function releaseInput(){if(!vm)return;await vm.keyboard_send_scancodes([...Array.from({length:88},(_,i)=>0x81+i),...[0x1d,0x38,0x47,0x48,0x49,0x4b,0x4d,0x4f,0x50,0x51,0x52,0x53,0x5b,0x5c].flatMap(c=>[0xe0,c|0x80])]);vm.bus.send('mouse-click',[false,false,false]);}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
globalThis.my98Agent={
    async prepareImport(credentials,gateway,coldBoot=false){
        if(source)throw new Error('Import already active');
        const disk=await Slop86Disk.create();
        try{
            await disk.unlock(credentials.username,credentials.password,credentials.machine);credentials.password='';
            const description=await disk.openRemote({...(gateway?{gateway,servers:[{url:gateway,resolution:'gateway',discovery:false}]}:{}),prefetch:{enabled:false},persistentCache:{publication:false}});
            if(coldBoot){
                config={...DEFAULT_CONFIG};source={disk,prepared:{size:description.size},view:disk};
                return {size:description.size,config,compatibility:await compatibility(),running:true,source:description.remote,initialization:'local-cold-boot'};
            }
            if(!description.remote?.stateCid)throw new Error('The publication has no machine snapshot: '+JSON.stringify(description.remote));
            const prepared=await disk.prepareState({published:true});
            if(prepared.metadata.version!==1||typeof prepared.metadata.running!=='boolean')throw new Error('Invalid published state metadata');
            if(prepared.metadata.compatibility!==await compatibility())throw new Error('Published state requires a different emulator/BIOS build');
            config=validateConfig(prepared.metadata.config);
            const container=document.createElement('div');container.innerHTML='<div></div><canvas></canvas>';document.body.append(container);
            const probeAdapter=new DiskBuffer(disk.stateDisk(prepared.token),prepared.size);let probe;
            try{
                probe=await createMachine(probeAdapter,config,container,{disableSpeaker:true});
                probeAdapter.snapshotReady=true;await probe.restore_state(prepared.state);await probeAdapter.drain();
                if(probe.v86.cpu.devices.cdrom.has_disk()||probe.get_disk_fda()||probe.get_disk_fdb())throw new Error('Published snapshot contains removable media');
            }finally{await probe?.destroy();probeAdapter.dispose();container.remove();}
            source={disk,prepared,view:disk.stateDisk(prepared.token)};
            return {size:prepared.size,config,compatibility:prepared.metadata.compatibility,running:prepared.metadata.running,source:description.remote};
        }catch(e){await disk.close().catch(()=>{});throw e;}
    },
    async exportImport(){
        try{
            for(let offset=0;offset<source.prepared.size;offset+=1048576){
                const bytes=await source.view.read(offset,Math.min(1048576,source.prepared.size-offset));
                await request('import/disk',{method:'POST',body:bytes,offset});
            }
            if(source.prepared.state)await transfer('import/state',source.prepared.state);
        }finally{if(source){await source.disk.discardState(source.prepared.token).catch(()=>{});await source.disk.close().catch(()=>{});source=undefined;}}
    },
    async boot(metadata){
        if(vm)throw new Error('Machine already loaded');
        config=validateConfig(metadata.config);adapter=new DiskBuffer(client,metadata.size,async()=>{await vm?.stop();});
        try{vm=await createMachine(adapter,config,document.querySelector('#screen'),{disableSpeaker:true});vm.run();return this.status();}
        catch(e){adapter.dispose();throw e;}
    },
    async restore(metadata){
        if(vm)throw new Error('Machine already loaded');
        if(metadata.compatibility!==await compatibility())throw new Error('Checkpoint requires a different emulator/BIOS build');
        config=validateConfig(metadata.config);
        adapter=new DiskBuffer(client,metadata.size,async()=>{await vm?.stop();});adapter.snapshotReady=true;
        vm=await createMachine(adapter,config,document.querySelector('#screen'),{disableSpeaker:true});
        try{
            const response=await request('state');
            const raw=await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
            await vm.restore_state(raw);await adapter.drain();adapter.snapshotReady=false;
            return this.status();
        }catch(e){await vm.destroy().catch(()=>{});vm=undefined;adapter.dispose();throw e;}
    },
    status(){return {loaded:!!vm,running:!!vm?.is_running(),muted:!!vm&&!vm.speaker_adapter,headless:true,width:document.querySelector('#screen canvas')?.width||0,height:document.querySelector('#screen canvas')?.height||0,absolutePointer:!!vm?.mouse_adapter?.absolute_mouse,diskFailed:!!adapter?.failed,cdrom:!!vm?.v86.cpu.devices.cdrom.has_disk()};},
    async insertCD(){
        requireVM();if(vm.v86.cpu.devices.cdrom.has_disk())throw new Error('CD already inserted; use eject');
        const bytes=await(await request('media')).arrayBuffer(),running=vm.is_running();
        await releaseInput();await vm.stop();
        try{await adapter.drain();await vm.set_cdrom({buffer:bytes});return {inserted:true};}
        finally{if(running&&!adapter.failed)vm.run();}
    },
    async ejectCD(){
        requireVM();const running=vm.is_running();await releaseInput();await vm.stop();
        try{await adapter.drain();vm.eject_cdrom();return {ejected:true};}
        finally{if(running&&!adapter.failed)vm.run();}
    },
    async resume(){requireVM();if(adapter.failed)throw adapter.error;vm.run();return this.status();},
    async pause(){requireVM();await releaseInput();await vm.stop();await adapter.drain();return this.status();},
    async screenshot(){requireVM();await delay(50);const image=vm.screen_make_screenshot();if(!image)throw new Error('Screen unavailable');await image.decode();return {data:image.src,width:image.naturalWidth,height:image.naturalHeight};},
    async type(text){requireRunning();const codes=textCodes(text);try{await vm.keyboard_send_scancodes(codes,12);}finally{await releaseInput();}return {characters:text.length};},
    async key(chord){requireRunning();const codes=chordCodes(chord);try{await vm.keyboard_send_scancodes(codes,45);}finally{await releaseInput();}return {key:chord};},
    async mouse(input){
        requireRunning();
        const canvas=document.querySelector('#screen canvas'),width=canvas.width,height=canvas.height;
        const move=(x,y)=>{
            if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0||x>=width||y>=height)throw new Error('Mouse position outside framebuffer');
            if(!vm.mouse_adapter?.absolute_mouse)throw new Error('Absolute pointer unavailable; use relative movement or keyboard');
            vm.bus.send('mouse-pointer-lock',false);vm.bus.send('mouse-absolute',[x,y,width,height]);
        };
        const buttons=input.button==='right'?[false,false,true]:input.button==='middle'?[false,true,false]:[true,false,false];
        const relative=(dx,dy)=>{
            if(!Number.isFinite(dx)||!Number.isFinite(dy)||Math.abs(dx)>4096||Math.abs(dy)>4096)throw new Error('Invalid relative movement');
            vm.bus.send('mouse-pointer-lock',true);vm.bus.send('mouse-delta',[dx,-dy]);
        };
        try{
            if(input.button!==undefined&&!['left','middle','right'].includes(input.button))throw new Error('Invalid mouse button');
            if(input.action==='relative'){
                relative(input.dx,input.dy);
            }else if(input.action==='drag'&&input.x===undefined&&input.y===undefined){
                if(!Number.isFinite(input.dx)||!Number.isFinite(input.dy)||Math.abs(input.dx)>4096||Math.abs(input.dy)>4096)throw new Error('Invalid relative drag');
                vm.bus.send('mouse-pointer-lock',true);vm.bus.send('mouse-click',buttons);
                for(let i=0;i<12;i++){relative(input.dx/12,input.dy/12);await delay(25);}
            }else{
                if(input.x!==undefined||input.y!==undefined)move(input.x,input.y);
                if(input.action==='click'||input.action==='double'){
                    for(let i=0;i<(input.action==='double'?2:1);i++){vm.bus.send('mouse-click',buttons);await delay(65);vm.bus.send('mouse-click',[false,false,false]);await delay(65);}
                }else if(input.action==='drag'){
                    move(input.x,input.y);move(input.toX,input.toY);move(input.x,input.y);vm.bus.send('mouse-click',buttons);
                    for(let i=1;i<=12;i++){move(input.x+(input.toX-input.x)*i/12,input.y+(input.toY-input.y)*i/12);await delay(25);}
                }else if(input.action==='wheel'){
                    if(!Number.isInteger(input.delta)||Math.abs(input.delta)>100)throw new Error('Invalid wheel delta');
                    for(let i=0;i<Math.abs(input.delta);i++){vm.bus.send('mouse-wheel',[Math.sign(input.delta),0]);await delay(35);}
                }else if(input.action!=='move')throw new Error('Unknown mouse action');
            }
        }finally{await releaseInput();}
        return {action:input.action};
    },
    async beginCapture(){requireVM();if(vm.v86.cpu.devices.cdrom.has_disk())throw new Error('Eject the transfer CD before checkpoint/stop');await releaseInput();const running=vm.is_running();await vm.stop();await adapter.drain();adapter.snapshotReady=true;
        try{pendingState=await vm.save_state();return {size:adapter.byteLength,config,compatibility:await compatibility(),running};}
        finally{adapter.snapshotReady=false;}
    },
    async exportCapture(){try{await transfer('checkpoint/state',pendingState);}finally{pendingState=undefined;}},
    async release(){await releaseInput();},
    async close(){await releaseInput();if(vm)await vm.destroy();vm=undefined;adapter?.dispose();}
};
