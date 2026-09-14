import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, readdir, lstat } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { serveSite, clockResolution, quietAudio } from "./server.mjs";

const output = "build/pages-tests";
await mkdir(output, { recursive: true });
const results = [];
const ready = page => page.waitForFunction(() => document.body && !document.body.inert && !document.querySelector("#disk-user").disabled, null, { timeout: 20000 });
async function inventory(dir, base = "") {
    const names = [];
    for(const entry of await readdir(dir)) {
        const path = dir + "/" + entry, relative = base + entry, info = await lstat(path);
        assert(!info.isSymbolicLink(), "Site contains a symlink: " + relative);
        if(info.isDirectory()) names.push(...await inventory(path, relative + "/"));
        else { assert.equal(info.nlink, 1, "Site contains a hard link"); names.push(relative); }
    }
    return names.sort();
}
const manifest = JSON.parse(await readFile("build/site-manifest.json", "utf8"));
assert.deepEqual(await inventory("build/site"), manifest.map(x => x.path).sort());
assert(!manifest.some(x => /advanced|fixture|results|remote-test|\.img$|\.my98$|\.map$/.test(x.path)));

for(const [name, type] of Object.entries({ chromium, webkit })) {
    const browser = await type.launch();
    try {
        for(const prefix of ["/", "/my98/"]) {
            const options = { prefix }, server = await serveSite(options);
            const context = await browser.newContext();
            await context.addInitScript(quietAudio);
            try {
                const page = await context.newPage(), errors = [];
                page.on("pageerror", e => errors.push(String(e)));
                let navigations = 0; page.on("framenavigated", f => { if(f === page.mainFrame()) navigations++; });
                await page.goto(server.url + "?check=1#preserved"); await ready(page);
                assert.equal(navigations, 2, "Exactly one initial reload");
                assert.equal(page.url(), server.url + "?check=1#preserved");
                const clock = await clockResolution(page); assert(clock.isolated);
                assert(clock.samples > 0 && clock.minimumMs < 1, "Fine clock enabled");
                const assets = await page.evaluate(async paths => {
                    for(const path of paths) {
                        const response = await fetch(path);
                        if(!response.ok) throw Error("Missing asset " + path);
                        if(path.endsWith(".wasm") && response.headers.get("content-type") !== "application/wasm") throw Error("WASM MIME");
                        await response.arrayBuffer();
                    }
                    const partial = await fetch("bios/seabios.bin", { headers: { Range: "bytes=0-31" } });
                    if(partial.status !== 206 || (await partial.arrayBuffer()).byteLength !== 32 || !partial.headers.get("content-range").startsWith("bytes 0-31/")) throw Error("Range response changed");
                    const iso = await import("./slop86/src/iso9660.js");
                    const bytes = iso.generate([{ name: "hello.txt", contents: new TextEncoder().encode("hello") }]);
                    if(bytes.byteLength < 32768) throw Error("ISO generation failed");
                    return paths.length;
                }, manifest.map(x => x.path));
                // Use the packaged Worker/WASM across the service worker, including SAB cancellation setup.
                const disk = await page.evaluate(async () => {
                    const { Slop86Disk } = await import("./build/disk/web/client.js");
                    const c = await Slop86Disk.create();
                    try {
                        await c.unlock("pages fixtures", "public test password", "main");
                        const bytes = new Uint8Array(512 * 1024); bytes[510] = 85; bytes[511] = 170;
                        await c.createFromImage(new File([bytes], "fixture.img"));
                        await c.write(17, new Uint8Array([42]));
                        const saved = (await c.save()).download.blob;
                        await c.close();
                        const d = await Slop86Disk.create();
                        try { await d.unlock("pages fixtures", "public test password", "main"); await d.open(saved); return { value: (await d.read(17, 1))[0], bytes: saved.size }; }
                        finally { await d.close(); }
                    } finally { await c.close(); }
                });
                assert.equal(disk.value, 42);
                // A return visit is already controlled and must not navigate again.
                await page.reload(); await ready(page); assert.equal(navigations, 3);
                await page.locator("#disk-user").fill("unsaved identity");
                await page.locator("#disk-password").fill("unsaved password");
                const second = await context.newPage(); await second.goto(server.url); await ready(second);
                options.revision = "2";
                await second.evaluate(async () => {
                    const registration = await navigator.serviceWorker.getRegistration();
                    const changed = new Promise(resolve => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }));
                    await registration.update(); await changed;
                });
                await page.waitForTimeout(300);
                assert.equal(navigations, 3, "Update reloaded an active page");
                assert.equal(await page.locator("#disk-password").inputValue(), "unsaved password");
                await second.close();
                await page.screenshot({ path: `${output}/${name}-${prefix === "/" ? "root" : "subpath"}-desktop.png` });
                await page.setViewportSize({ width: 390, height: 844 });
                assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
                await page.screenshot({ path: `${output}/${name}-${prefix === "/" ? "root" : "subpath"}-mobile.png`, fullPage: true });
                assert.deepEqual(errors, []);
                results.push({ browser: name, prefix, clock, assets, disk, navigations, updatePreservedInput: true, errors });
            } finally { await context.close(); await server.close(); }
        }
        for(const scenario of ["headers", "no-worker", "storage-denied", "worker-error", "late-worker", "isolation-failed"]) {
            const options = { headers: scenario === "headers", workerStatus: scenario === "worker-error" ? 404 : 0, workerDelay: scenario === "late-worker" ? 12000 : 0 };
            const server = await serveSite(options), context = await browser.newContext();
            try {
                if(scenario === "no-worker") await context.addInitScript(() => Object.defineProperty(navigator, "serviceWorker", { value: undefined }));
                if(scenario === "storage-denied") await context.addInitScript(() => { Storage.prototype.setItem = () => { throw new DOMException("Blocked", "SecurityError"); }; });
                if(scenario === "isolation-failed") await context.addInitScript(() => Object.defineProperty(window, "crossOriginIsolated", { value: false }));
                const page = await context.newPage(); let navigations = 0;
                page.on("framenavigated", f => { if(f === page.mainFrame()) navigations++; });
                const before = Date.now(); await page.goto(server.url);
                if(scenario === "late-worker") {
                    assert(await page.evaluate(() => document.body.inert && document.querySelector("#disk-password").disabled && document.querySelector("#disk-user").disabled), "Inputs enabled before isolation completes");
                }
                await ready(page);
                const elapsedMs = Date.now() - before;
                const warning = await page.locator("#acceleration-status").textContent();
                if(scenario === "headers") assert.equal(warning, ""); else assert(warning.includes("more slowly"));
                assert.equal(navigations, scenario === "isolation-failed" ? 2 : 1);
                if(scenario === "late-worker") {
                    assert(elapsedMs >= 9900 && elapsedMs < 15000);
                    await page.locator("#disk-password").fill("kept after timeout");
                    await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 10000 });
                    assert.equal(navigations, 1); assert.equal(await page.locator("#disk-password").inputValue(), "kept after timeout");
                }
                if(scenario === "headers") assert.equal(server.requests.filter(x => x.path.endsWith("coi-serviceworker.js")).length, 0);
                results.push({ browser: name, scenario, elapsedMs, navigations, clock: await clockResolution(page) });
            } finally { await context.close(); await server.close(); }
        }
        console.log(name + ": Pages bootstrap, assets, disk and fallback scenarios PASS");
    } finally { await browser.close(); }
    await writeFile(output + "/results.json", JSON.stringify(results, null, 2));
}
console.log("Pages tests PASS (" + results.length + " browser scenarios)");
