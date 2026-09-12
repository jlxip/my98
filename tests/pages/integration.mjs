import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { serveSite, quietAudio } from "./server.mjs";
import { diskFixture } from "./fixture.mjs";
const results = [], f = await diskFixture();
const ready = page => page.waitForFunction(() => document.body && !document.body.inert && !document.querySelector("#choose-disk").disabled);
async function pick(page, selector, file) {
    const chooser = page.waitForEvent("filechooser");
    await page.locator(selector).click(); await (await chooser).setFiles(file);
}
async function download(page, selector, path) {
    const [file] = await Promise.all([page.waitForEvent("download"), page.locator(selector).click()]);
    await file.saveAs(path); return path;
}
async function exitFullscreen(page) {
    await page.evaluate(async () => { if(document.fullscreenElement) await document.exitFullscreen(); else if(document.webkitFullscreenElement) document.webkitExitFullscreen(); });
}
async function login(page) {
    await page.locator("#disk-panel > summary").click();
    await page.locator("#disk-user").fill("disk fixtures");
    await page.locator("#disk-password").fill("public compatibility password");
    await page.locator("#disk-login button").click();
    await page.locator("#disk-workspace").waitFor({ state: "visible" });
}
try {
    for(const [name, type] of Object.entries({ chromium, webkit })) {
        const server = await serveSite({ prefix: "/my98/" }), browser = await type.launch();
        try {
            const context = await browser.newContext(); await context.routeWebSocket("**/*", socket => socket.close());
            await context.addInitScript(quietAudio);
            const page = await context.newPage(), errors = [];
            page.on("pageerror", e => errors.push(String(e)));
            page.on("dialog", dialog => dialog.accept());
            await page.goto(server.url); await ready(page);
            // Actual local file chooser, VM boot, media insertion and VM state round-trip.
            await pick(page, "#choose-disk", f.source);
            await page.waitForFunction(() => !document.querySelector("#save-state").disabled && !document.querySelector("#session").hidden);
            await exitFullscreen(page);
            const statePath = `build/pages-tests/${name}-state.bin`;
            await download(page, "#save-state", statePath);
            await pick(page, "#load-state", statePath);
            await page.waitForFunction(() => document.querySelector("#session-status").textContent.startsWith("State restored"));
            await pick(page, "#insert-cdrom", { name: "hello.txt", mimeType: "text/plain", buffer: Buffer.from("Pages ISO fixture") });
            await page.waitForFunction(() => document.querySelector("#cdrom-name").textContent === "hello.txt");
            const local = await download(page, "#download-disk", `build/pages-tests/${name}-local.img`);
            assert.deepEqual(await readFile(local), await readFile(f.source));
            // Navigate only this disposable test context; this also checks a controlled return visit.
            await page.goto(server.url); await ready(page); await login(page);
            await pick(page, "#disk-open", f.file);
            await page.waitForFunction(() => !document.querySelector("#disk-boot").disabled);
            await page.locator("#disk-boot").click();
            await page.waitForFunction(() => !document.querySelector("#disk-save").disabled);
            await exitFullscreen(page);
            await page.locator("#disk-save").click();
            await page.waitForFunction(() => document.querySelector("#disk-status").textContent.includes("No changes"));
            await page.locator("#disk-close").click();
            await page.waitForFunction(() => !document.querySelector("#disk-login").hidden);
            await page.locator("#disk-user").fill("disk fixtures"); await page.locator("#disk-password").fill("public compatibility password");
            await page.locator("#disk-login button").click(); await page.locator("#disk-workspace").waitFor({ state: "visible" });
            await page.locator("#disk-workspace details summary").click(); await page.locator("#disk-gateway").fill(f.gateway);
            await page.locator("#disk-remote").click();
            await page.waitForFunction(() => !document.querySelector("#disk-boot").disabled);
            const remote = await download(page, "#disk-download", `build/pages-tests/${name}-remote.my98`); f.verify(remote);
            await page.locator("#disk-boot").click(); await page.waitForFunction(() => !document.querySelector("#disk-save").disabled);
            // Exercise dirty remote save through the shipped Worker and native reconstruction.
            const saved = await page.evaluate(async gateway => {
                const { Slop86Disk } = await import("./build/disk/web/client.js");
                const c = await Slop86Disk.create();
                try {
                    await c.unlock("disk fixtures", "public compatibility password", "main"); await c.openRemote({ gateway });
                    await c.write(100, new Uint8Array([99]));
                    return Array.from(new Uint8Array(await (await c.save()).download.blob.arrayBuffer()));
                } finally { await c.close(); }
            }, f.gateway);
            const savedPath = `build/pages-tests/${name}-remote-saved.my98`, expectedPath = `build/pages-tests/${name}-expected.img`;
            const expected = await readFile(f.source); expected[100] = 99;
            await writeFile(savedPath, Buffer.from(saved)); await writeFile(expectedPath, expected); f.verify(savedPath, expectedPath);
            await page.screenshot({ path: `build/pages-tests/${name}-vm.png` });
            assert.deepEqual(errors, []);
            results.push({ browser: name, version: browser.version(), rawDisk: true, localEncrypted: true, remoteEncrypted: true, nativeSavedExact: true, stateRestored: true, isoInserted: true, requests: f.requests.length, errors });
            console.log(name + ": packaged UI local/remote VM, saves, state restore and ISO PASS");
        } finally { await browser.close(); await server.close(); }
    }
    const hash = createHash("sha256").update(await readFile(f.source)).digest("hex"); assert.equal(hash, f.sha256);
    await writeFile("build/pages-tests/integration.json", JSON.stringify(results, null, 2));
} finally { await f.close(); }
