import { V86 } from "../../build/libv86.mjs";
import { setupDisk } from "./disk-ui.js";
import { setupTouch, setupFullscreen } from "./vm-input.js";

const $ = id => document.getElementById(id);
const media = { cdrom: null, fda: null, fdb: null };
let emulator, diskName = "windows98.img", busy = false, muted = false;
let diskBlocked = false;
let diskController;

function status(message, error = false)
{
    const target = $("session").hidden ? $("welcome-status") : $("session-status");
    target.textContent = message;
    target.classList.toggle("error", error);
}

function syncMediaNames()
{
    for(const drive of Object.keys(media))
    {
        const present = drive === "cdrom" ? emulator.v86.cpu.devices.cdrom.has_disk() : emulator["get_disk_" + drive]();
        if(!present) media[drive] = null;
        else if(!media[drive]) media[drive] = drive === "cdrom" ? "CD" : "Floppy";
    }
}

function updateControls()
{
    document.querySelectorAll("button, input, select").forEach(element => element.disabled = busy);
    diskController?.syncControls(busy);
    $("exit-fullscreen").disabled = false;
    for(const id of ["touch-drag", "touch-right"]) $(id).disabled = busy || diskBlocked || !emulator?.is_running();
    if(busy || diskBlocked || !emulator?.is_running()) touch.release();
    if(!emulator) return;
    $("pause").textContent = emulator.is_running() ? "Pause" : "Resume";
    $("mute").textContent = muted ? "Unmute" : "Mute";
    $("mouse").textContent = document.pointerLockElement ? "Release mouse" : "Capture mouse";
    for(const drive of Object.keys(media))
    {
        $(drive + "-name").textContent = media[drive] || "Empty";
        $(drive + "-name").title = media[drive] || "Empty";
        $("eject-" + drive).disabled = busy || !media[drive];
        if(drive !== "cdrom") $("download-" + drive).disabled = busy || !media[drive];
    }
    if(diskBlocked) document.querySelectorAll("#controls button").forEach(button => button.disabled = true);
}

async function action(message, work)
{
    if(busy || diskBlocked) return;
    busy = true;
    updateControls();
    status(message);
    try { await work(); }
    catch(error) { status(message.replace(/…$/, "") + ": " + (error.message || error), true); }
    finally { busy = false; updateControls(); if(emulator) focusScreen(); }
}

// Keep a strong DOM reference while the native panel is open, including in WebKit.
function pickFiles(multiple = false)
{
    return new Promise((resolve, reject) => {
        const input = document.createElement("input");
        input.type = "file";
        input.multiple = multiple;
        input.hidden = true;
        document.body.append(input);
        const finish = files => { input.remove(); resolve(files); };
        input.onchange = () => finish(Array.from(input.files));
        input.oncancel = () => finish([]);
        try { input.click(); }
        catch(error) { input.remove(); reject(error); }
    });
}

async function readDisk(file, drive)
{
    if(!file?.size) throw new Error("The file is empty. Choose a disk image.");
    const alignment = drive === "cdrom" ? 2048 : 512;
    if(drive === "cdrom" && file.size % alignment)
    {
        // Some ISO exports include an unaligned trailer (e.g. Nero metadata).
        // Discard only the partial final sector, and only outside a complete
        // ISO9660 volume. Never pad a truncated image or guess a raw CD layout.
        const end = file.size - file.size % alignment;
        const header = new Uint8Array(await file.slice(16 * alignment, 17 * alignment).arrayBuffer());
        if(header.length === alignment && header[0] === 1 && header[6] === 1 &&
            String.fromCharCode(...header.subarray(1, 6)) === "CD001")
        {
            const view = new DataView(header.buffer);
            const sectors = view.getUint32(80, true);
            if(sectors >= 17 && sectors === view.getUint32(84, false) &&
                view.getUint16(128, true) === alignment && view.getUint16(130, false) === alignment &&
                sectors * alignment <= end)
            {
                file = new File([file.slice(0, end)], file.name, { type: file.type, lastModified: file.lastModified });
            }
        }
    }
    if(file.size % alignment) throw new Error("The image size is invalid for this drive.");
    if(drive === "fda" || drive === "fdb")
    {
        if(![160, 180, 200, 320, 360, 400, 410, 420, 640, 720, 800, 820, 830, 880, 1040, 1120, 1200, 1440, 1476, 1494, 1600, 1680, 1722, 1743, 1760, 1840, 1920, 2880, 3120, 3200, 3520, 3840].includes(file.size / 1024))
            throw new Error("Choose a standard-size floppy image.");
    }
    // Match the existing frontend's snapshot representation and lazy-read threshold.
    // Reading small files ourselves also reports I/O errors and avoids set_*'s FileReader race.
    if(file.size < 256 * 1024 * 1024 || drive === "fda" || drive === "fdb")
        return { buffer: await file.arrayBuffer() };
    await file.slice(0, alignment).arrayBuffer();
    return { buffer: file, async: true };
}

async function readAsset(path)
{
    const response = await fetch(path);
    if(!response.ok) throw new Error("Could not load " + path + " (" + response.status + ").");
    return response.arrayBuffer();
}

function focusScreen()
{
    if(!emulator || busy) return;
    $("display").focus({ preventScroll: true });
    emulator.keyboard_set_enabled(true);
    emulator.speaker_adapter?.resume().catch(() => {});
}

function fitScreen()
{
    const display = $("display"), screen = $("screen_container");
    const canvas = $("vga"), text = $("screen");
    const graphical = getComputedStyle(canvas).display !== "none";
    const width = graphical ? canvas.width : text.offsetWidth;
    const height = graphical ? canvas.height : text.offsetHeight;
    if(!width || !height) return;
    const area = display.getBoundingClientRect();
    // The emulator owns pixel aspect correction; this page only fits its output.
    const aspect = emulator?.screen_get_aspect_ratio() || width / height;
    const visibleWidth = Math.min(area.width, area.height * aspect);
    const visibleHeight = visibleWidth / aspect;
    const scaleX = visibleWidth / width, scaleY = visibleHeight / height;
    if(graphical)
    {
        canvas.style.width = visibleWidth + "px";
        canvas.style.height = visibleHeight + "px";
        canvas.style.imageRendering = Number.isInteger(scaleX) && Number.isInteger(scaleY) ? "pixelated" : "";
    }
    // Replace the adapter's default text scale instead of applying it twice.
    if(!graphical)
    {
        text.style.transform = "";
        text.style.marginRight = "";
        text.style.marginBottom = "";
    }
    screen.style.transform = `translate(-50%, -50%) scale(${graphical ? 1 : scaleX}, ${graphical ? 1 : scaleY})`;
    // Center relative to the displayed screen dimensions.
    screen.style.transformOrigin = "center center";
}

function captureMouse()
{
    if(document.pointerLockElement || busy || !emulator ||
        !$("display").requestPointerLock || matchMedia("(pointer: coarse)").matches) return;
    emulator.mouse_set_enabled(true);
    try
    {
        // Some browsers report completion only through pointerlockchange/error.
        const pending = $("display").requestPointerLock();
        pending?.catch(() => status("Could not capture the mouse. Click inside Windows to try again."));
    }
    catch { status("Could not capture the mouse. Click inside Windows to try again."); }
}

function fullscreen()
{
    // Fullscreen consumes activation; request desktop pointer lock first.
    captureMouse();
    return screenView.enter();
}

async function paused(work)
{
    const running = emulator.is_running();
    await emulator.stop();
    try { return await work(); }
    finally { if(running) emulator.run(); }
}

function datedName(name, extension)
{
    const stem = name.replace(/\.[^.]+$/, "");
    const date = new Date();
    const pad = n => String(n).padStart(2, "0");
    const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
    return `${stem}_${stamp}.${extension}`;
}

function download(blob, name)
{
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    // Downloads may begin after the click handler returns, especially in WebKit.
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function diskBuffer(drive)
{
    return emulator.v86.cpu.devices.fdc.drives[drive === "fda" ? 0 : 1].buffer;
}

async function exportDisk(drive)
{
    await paused(async () => {
        const buffer = diskBuffer(drive);
        if(!buffer) throw new Error("The drive is empty.");
        const name = datedName(media[drive], "img");
        const blob = buffer.get_as_file ? buffer.get_as_file(name) :
            new Blob([await new Promise(resolve => buffer.get_buffer(resolve))]);
        download(blob, name);
    });
    status("Disk download prepared.");
}

async function start(diskAdapter, name, autoFullscreen = true)
{
    // Invoke fullscreen before the first asynchronous read loses user activation.
    $("session").hidden = false;
    const fullscreenAttempt = autoFullscreen ? fullscreen() : screenView.exit();
    try
    {
        status("Preparing Windows…");
        const hda = { disk_adapter: diskAdapter };
        const wasmPath = "build/v86.wasm";
        const [bios, vgaBios, wasm] = await Promise.all([
            readAsset("bios/seabios.bin"), readAsset("bios/bochs-vgabios.bin"), readAsset(wasmPath),
        ]);
        const module = await WebAssembly.compile(wasm);
        let initializationError;
        emulator = new V86({
            wasm_fn: async imports => {
                try { return (await WebAssembly.instantiate(module, imports)).exports; }
                catch(error) { initializationError = error; return new Promise(() => {}); }
            },
            memory_size: 256 * 1024 * 1024,
            vga_memory_size: 8 * 1024 * 1024,
            bios: { buffer: bios }, vga_bios: { buffer: vgaBios },
            hda, boot_order: 0x312, acpi: false,
            net_device: { type: "ne2k", relay_url: "wss://relay.widgetry.org/", mtu: 1500 },
            screen: { container: $("screen_container"), use_graphical_text: false },
            disable_speaker: false, autostart: false,
        });
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => finish(initializationError || new Error("The machine could not initialize. Choose the files again.")), 30000);
            const loaded = () => finish();
            const failed = event => finish(new Error(event.file_name || "Error loading the machine."));
            function finish(error)
            {
                clearTimeout(timer);
                emulator.remove_listener("emulator-loaded", loaded);
                emulator.remove_listener("download-error", failed);
                error ? reject(error) : resolve();
            }
            emulator.add_listener("emulator-loaded", loaded);
            emulator.add_listener("download-error", failed);
        });
        diskName = name;
        $("disk-name").textContent = diskName;
        $("disk-name").title = diskName;
        for(const drive of Object.keys(media)) media[drive] = null;
        syncMediaNames();
        emulator.add_listener("screen-set-size", fitScreen);
        emulator.add_listener("emulator-started", updateControls);
        emulator.add_listener("emulator-stopped", updateControls);
        emulator.run();
        await fullscreenAttempt;
        status("Encrypted disk: shut down Windows and save the full disk when you finish." +
            (!screenView.expanded ? " Fullscreen is available in the toolbar." : ""));
        fitScreen();
        // action() still owns the pending state until it returns.
        setTimeout(focusScreen, 0);
    }
    catch(error)
    {
        touch.release();
        if(emulator) { await emulator.destroy(); emulator = undefined; }
        await screenView.exit();
        $("session").hidden = true;
        throw error;
    }
}

function bind(id, message, work)
{
    $(id).addEventListener("click", () => action(message, work));
}

bind("pause", "", async () => {
    if(emulator.is_running()) await emulator.stop(); else emulator.run();
    status(emulator.is_running() ? "Windows is running." : "Machine paused.");
});
bind("reset", "", async () => {
    if(!window.confirm("Reset Windows? Any work not saved within Windows will be lost."))
    {
        status("Reset cancelled.");
        return;
    }
    emulator.restart();
    status("Machine reset.");
});
// Fullscreen and pointer lock must run directly in a user gesture.
$("fullscreen").onclick = () => fullscreen().then(focusScreen);
$("mouse").onclick = () => {
    if(document.pointerLockElement) document.exitPointerLock();
    else captureMouse();
    focusScreen();
};
bind("ctrlaltdel", "", async () => { emulator.keyboard_send_scancodes([0x1D, 0x38, 0x53, 0xD3, 0xB8, 0x9D]); });
bind("mute", "", async () => {
    muted = !muted;
    emulator.speaker_adapter?.mixer.set_volume(muted ? 0 : 1, undefined);
    if(!muted) await emulator.speaker_adapter?.resume();
    status(muted ? "Sound muted." : "Sound enabled.");
});
bind("screenshot", "Taking screenshot…", async () => {
    const image = emulator.screen_make_screenshot();
    if(!image) throw new Error("The display is not available yet.");
    const response = await fetch(image.src);
    download(await response.blob(), datedName(diskName, "png"));
    status("Screenshot prepared.");
});
for(const drive of Object.keys(media))
{
    bind("insert-" + drive, "Inserting media…", async () => {
        const files = await pickFiles(drive === "cdrom");
        if(!files.length) { status(""); return; }
        const file = files[0];
        let disk;
        if(drive === "cdrom" && !(files.length === 1 && /\.(iso(9660|img)?|cdr|img)$/i.test(file.name)))
        {
            const { generate } = await import("../../slop86/src/iso9660.js");
            const contents = await Promise.all(files.map(async file => ({ name: file.name, contents: new Uint8Array(await file.arrayBuffer()) })));
            disk = { buffer: generate(contents).buffer };
        }
        else disk = await readDisk(file, drive);
        await paused(() => emulator["set_" + drive](disk));
        media[drive] = files.map(file => file.name).join(", ");
        status("Media inserted: " + media[drive]);
    });
    bind("eject-" + drive, "Ejecting media…", async () => {
        await paused(() => emulator["eject_" + drive]());
        media[drive] = null;
        status("Media ejected.");
    });
    if(drive !== "cdrom") bind("download-" + drive, "Preparing download…", () => exportDisk(drive));
}
const touch = setupTouch({
    display: $("display"), view: $("vm-view"), drag: $("touch-drag"), right: $("touch-right"),
    getMachine: () => busy || diskBlocked ? null : emulator, focus: focusScreen,
});
const screenView = setupFullscreen({
    view: $("vm-view"), exitButton: $("exit-fullscreen"), fit: fitScreen, focus: focusScreen,
    status, release: () => touch.release(),
});
$("display").addEventListener("pointerdown", event => {
    if(event.pointerType === "mouse") { focusScreen(); captureMouse(); }
});
document.addEventListener("focusin", event => {
    if(emulator) emulator.keyboard_set_enabled($("display").contains(event.target));
});
document.addEventListener("pointerlockchange", () => {
    updateControls();
    focusScreen();
    status(document.pointerLockElement ? "Mouse captured. Press Esc to release it." : "Mouse released.");
});
document.addEventListener("pointerlockerror", () => status("Could not capture the mouse."));
new ResizeObserver(fitScreen).observe($("display"));
window.addEventListener("resize", fitScreen);
let lastCount = 0, lastTime = performance.now();
setInterval(() => {
    const now = performance.now();
    const count = emulator?.get_instruction_counter() || 0;
    const mips = Math.max(0, (count - lastCount) / ((now - lastTime) * 1000));
    $("ips").textContent = mips.toFixed(1) + " MIPS";
    lastCount = count;
    lastTime = now;
}, 1000);


diskController = setupDisk({
    pickFiles, download,
    busy: () => busy,
    hasSession: () => !!emulator,
    setBusy(value) { busy = value; updateControls(); },
    async stop() { if(emulator) await emulator.stop(); },
    async boot(adapter, name, {autoFullscreen = true} = {}) {
        touch.release();
        if(emulator) { await emulator.destroy(); emulator = undefined; }
        diskBlocked = false;
        await start(adapter, name, autoFullscreen);
    },
    async close() {
        touch.release();
        await screenView.exit();
        if(emulator) { await emulator.destroy(); emulator = undefined; }
        diskBlocked = false;
        $("session").hidden = true;
        updateControls();
    },
    async resume() { diskBlocked = false; if(emulator) emulator.run(); updateControls(); },
    async fail(error) {
        diskBlocked = true;
        if(emulator) await emulator.stop();
        status("Encrypted disk stopped: " + error.message, true);
        updateControls();
    },
});
updateControls();
