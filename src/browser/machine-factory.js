import {V86} from "../../build/libv86.mjs";

let compatibilityPromise;
export function compatibility() {
    return compatibilityPromise ||= Promise.all(["build/libv86.mjs","build/v86.wasm","bios/seabios.bin","bios/bochs-vgabios.bin"].map(async path=>{
        const hash=await crypto.subtle.digest("SHA-256",await readAsset(path));
        return Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,"0")).join("");
    })).then(hashes=>"my98-state-adapter-1:"+hashes.join(":"));
}

async function readAsset(path) {
    const response = await fetch(path);
    if(!response.ok) throw new Error("Could not load " + path + " (" + response.status + ").");
    return response.arrayBuffer();
}

export async function createMachine(diskAdapter, config, container) {
    await compatibility();
    const hda = {disk_adapter:diskAdapter};
    const [bios, vgaBios, wasm] = await Promise.all([
        readAsset("bios/seabios.bin"), readAsset("bios/bochs-vgabios.bin"), readAsset("build/v86.wasm"),
    ]);
    const module = await WebAssembly.compile(wasm);
    let initializationError;
    const vm = new V86({
        wasm_fn: async imports => {
            try { return (await WebAssembly.instantiate(module, imports)).exports; }
            catch(error) { initializationError = error; return new Promise(() => {}); }
        },
        memory_size: config.memory_size,
        vga_memory_size: config.vga_memory_size,
        bios: {buffer:bios}, vga_bios: {buffer:vgaBios},
        hda, boot_order: 0x312, acpi: false,
        net_device: {type:"ne2k", relay_url:"wss://relay.widgetry.org/", mtu:1500},
        screen: {container, use_graphical_text:false},
        disable_speaker: false, autostart: false,
    });
    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => finish(initializationError || new Error("The machine could not initialize. Choose the files again.")), 30000);
            const loaded = () => finish();
            const failed = event => finish(new Error(event.file_name || "Error loading the machine."));
            function finish(error) {
                clearTimeout(timer);
                vm.remove_listener("emulator-loaded", loaded);
                vm.remove_listener("download-error", failed);
                error ? reject(error) : resolve();
            }
            vm.add_listener("emulator-loaded", loaded);
            vm.add_listener("download-error", failed);
        });
    } catch(error) { await vm.destroy(); throw error; }
    return vm;
}
