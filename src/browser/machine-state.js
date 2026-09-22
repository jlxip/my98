import {DiskBuffer} from "../../build/disk/web/client.js";
export const DEFAULT_CONFIG=Object.freeze({memory_size:256*1024*1024,vga_memory_size:8*1024*1024,boot_order:0x312,acpi:false,network:"ne2k"});
export function validateConfig(c) {
    if(!c || !Number.isInteger(c.memory_size) || c.memory_size<16*1024*1024 || c.memory_size>512*1024*1024 || c.memory_size%1048576 ||
        !Number.isInteger(c.vga_memory_size) || c.vga_memory_size<1024*1024 || c.vga_memory_size>16*1024*1024 || c.vga_memory_size%1048576 || c.boot_order!==0x312 || c.acpi!==false || c.network!=="ne2k")throw new Error("Unsupported saved machine configuration");
    return {...c};
}
const check=signal=>{if(signal?.aborted)throw Object.assign(new Error("State operation cancelled"),{code:"CANCELLED"});};
const emptyMedia=machine=>!machine.v86.cpu.devices.cdrom.has_disk() && !machine.get_disk_fda() && !machine.get_disk_fdb();
export async function captureMachineState({machine,adapter,disk,config,compatibility,signal}) {
    if(!machine || !adapter || !emptyMedia(machine))throw new Error("Eject the CD and both floppies before saving a state");
    validateConfig(config);check(signal);
    const running=machine.is_running();
    await machine.stop();
    const abort=()=>disk.cancel();
    try {
        await adapter.drain();check(signal);adapter.snapshotReady=true;
        const state=await machine.save_state();check(signal);
        signal?.addEventListener("abort",abort,{once:true});
        return await disk.saveState(state,{version:1,config,compatibility,running});
    } finally {
        signal?.removeEventListener("abort",abort);adapter.snapshotReady=false;
        if(running && !adapter.failed)machine.run();
    }
}
// createMachine returns a stopped, isolated VM configured from authenticated metadata.
// The returned VM is stopped: the caller attaches its surface before optionally running it.
export async function restoreMachineState({disk,input,current,compatibility,createMachine,signal,onDiskError}) {
    check(signal);
    const running=!!current?.machine.is_running();
    let prepared,candidate,adapter,view,committed=false;
    const abort=()=>disk.cancel();
    try {
        if(current) {await current.machine.stop();await current.adapter.drain();}
        check(signal);signal?.addEventListener("abort",abort,{once:true});
        prepared=await disk.prepareState(input);check(signal);
        const m=prepared.metadata;
        if(m.version!==1 || typeof m.running!=="boolean" || m.compatibility!==compatibility)throw new Error("State requires the same emulator and BIOS build");
        const config=validateConfig(m.config);
        view=disk.stateDisk(prepared.token);
        adapter=new DiskBuffer(view,prepared.size,onDiskError);adapter.snapshotReady=true;
        candidate=await createMachine(adapter,config);check(signal);
        await candidate.restore_state(prepared.state);check(signal);
        if(!emptyMedia(candidate))throw new Error("Saved state contains removable media");
        await adapter.drain();
        const description=await disk.commitState(prepared.token);
        committed=true;view.committed=true;adapter.snapshotReady=false;
        return {machine:candidate,adapter,config,running:m.running,description};
    } finally {
        signal?.removeEventListener("abort",abort);
        if(!committed) {
            if(candidate)await candidate.destroy().catch(()=>{});
            adapter?.dispose();
            if(prepared)await disk.discardState(prepared.token).catch(()=>{});
            if(running && !current.adapter.failed)current.machine.run();
        }
    }
}
