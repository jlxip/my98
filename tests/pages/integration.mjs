import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { serveSite, quietAudio } from "./server.mjs";
import { diskFixture } from "./fixture.mjs";
import { selectBootRanges } from "../../disk/scripts/range-profile.mjs";
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
    await page.evaluate(() => document.querySelector("#exit-fullscreen").click());
    await page.waitForFunction(() => !document.querySelector("#vm-view").classList.contains("expanded"));
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
        console.log(name + ": launching browser");
        const server = await serveSite({ prefix: "/my98/" }), browser = await type.launch();
        try {
            const context = await browser.newContext(); await context.routeWebSocket("**/*", socket => socket.close());
            await context.addInitScript(quietAudio);
            const page = await context.newPage(), errors = [];
            page.on("pageerror", e => errors.push(String(e)));
            page.on("dialog", dialog => dialog.accept());
            await page.goto(server.url); await ready(page);
            // Actual local file chooser, VM boot, media insertion and VM state round-trip.
            console.log(name + ": local VM boot");
            await pick(page, "#choose-disk", f.source);
            await page.waitForFunction(() => !document.querySelector("#save-state").disabled && !document.querySelector("#session").hidden);
            await exitFullscreen(page);
            console.log(name + ": state save and restore");
            const statePath = `build/pages-tests/${name}-state.bin`;
            await download(page, "#save-state", statePath);
            await pick(page, "#load-state", statePath);
            await page.waitForFunction(() => document.querySelector("#session-status").textContent.startsWith("State restored"));
            await pick(page, "#insert-cdrom", { name: "hello.txt", mimeType: "text/plain", buffer: Buffer.from("Pages ISO fixture") });
            await page.waitForFunction(() => document.querySelector("#cdrom-name").textContent === "hello.txt");
            const local = await download(page, "#download-disk", `build/pages-tests/${name}-local.img`);
            assert.deepEqual(await readFile(local), await readFile(f.source));
            // Navigate only this disposable test context; this also checks a controlled return visit.
            console.log(name + ": encrypted disk and remote login");
            await page.goto(server.url); await ready(page); await login(page);
            await pick(page, "#disk-open", f.file);
            await page.waitForFunction(() => !document.querySelector("#disk-boot").disabled);
            assert.equal(await page.locator("#disk-analyze").isDisabled(), true);
            await page.locator("#disk-boot").click();
            await page.waitForFunction(() => !document.querySelector("#disk-save").disabled);
            assert.equal(await page.locator('#vm-view').evaluate(e=>e.classList.contains('expanded')), true);
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
            // Worker API records cached demand, not background reads or writes.
            console.log(name + ": boot analysis");
            const analysis = await page.evaluate(async gateway => {
                const {Slop86Disk} = await import("./build/disk/web/client.js");
                const c = await Slop86Disk.create();
                const reject = async fn => { try { await fn(); } catch { return; } throw Error('Expected rejection'); };
                try {
                    await c.unlock('disk fixtures', 'public compatibility password', 'main');
                    const state = await c.openRemote({gateway});
                    await c.read(5 * 65536, 512); // Warm the plaintext cache before recording.
                    await c.startBootAnalysis();
                    await reject(() => c.startBootAnalysis());
                    await c.read(5 * 65536, 512);
                    await c.read(65536, 65537);
                    await c.read(5 * 65536, 512);
                    await c.write(7 * 65536, new Uint8Array([42]));
                    for(const op of ['verifyImage', 'downloadCurrent', 'save', 'discardWrites']) await reject(() => c[op]());
                    const profile = await c.finishBootAnalysis();
                    const dirty = (await c.describe()).dirty_bytes;
                    await c.read(6 * 65536, 512);
                    await reject(() => c.startBootAnalysis()); // Writes still present.
                    await c.discardWrites();
                    await c.startBootAnalysis(); await c.read(4 * 65536, 512); await c.cancelBootAnalysis();
                    await c.startBootAnalysis(); await c.read(3 * 65536, 512);
                    const fresh = await c.finishBootAnalysis();
                    return {profile, fresh, cid:state.remote.cid, dirty};
                } finally { await c.close(); }
            }, f.gateway);
            const {details, rankSum, ...expectedProfile} = selectBootRanges([5, 1, 2]);
            assert.deepEqual(analysis.profile, [{version:1, cid:analysis.cid, unitBytes:65536, ...expectedProfile}]);
            assert.ok(analysis.dirty > 0);
            assert.deepEqual(analysis.fresh[0].ranges.filter(Boolean), [[3, 3]]);
            assert.equal(await page.locator('#disk-analyze').isEnabled(), true);
            await page.locator('#disk-analyze').click();
            await page.waitForFunction(() => document.querySelector('#disk-analyze').textContent === 'Stop analyzing' && !document.querySelector('#disk-analyze').disabled);
            assert.equal(await page.locator('#vm-view').evaluate(e=>e.classList.contains('expanded')), false);
            assert.equal(await page.evaluate(()=>!!(document.fullscreenElement || document.webkitFullscreenElement)), false);
            for(const id of ['save', 'download', 'verify', 'discard', 'retry']) assert.equal(await page.locator('#disk-' + id).isDisabled(), true);
            const jsonPath = `build/pages-tests/${name}-boot-ranges.json`;
            const [jsonDownload] = await Promise.all([page.waitForEvent('download'), page.locator('#disk-analyze').click()]);
            assert.match(jsonDownload.suggestedFilename(), /^[0-9a-f]{8}-boot-ranges\.json$/);
            await jsonDownload.saveAs(jsonPath);
            const [profile] = JSON.parse(await readFile(jsonPath, 'utf8'));
            assert.equal(profile.cid, analysis.cid); assert.equal(profile.ranges.length, 32);
            assert.ok(profile.observedUnits > 0); assert.equal(profile.minUtilization, 0.5);
            assert.equal(await page.locator('#pause').textContent(), 'Pause');
            assert.equal(await page.locator('#disk-analyze').textContent(), 'Analyze boot');
            assert.equal(await page.locator('#disk-analyze').isDisabled(), true);
            // Pause/resume still operates on the same live VM after analysis.
            await page.locator('#pause').click(); await page.waitForFunction(() => document.querySelector('#pause').textContent === 'Resume');
            await page.locator('#pause').click(); await page.waitForFunction(() => document.querySelector('#pause').textContent === 'Pause');
            await page.screenshot({path:`build/pages-tests/${name}-boot-analysis.png`});
            // Exercise dirty remote save through the shipped Worker and native reconstruction.
            console.log(name + ": remote save and native verification");
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
            results.push({ browser: name, version: browser.version(), rawDisk: true, localEncrypted: true, remoteEncrypted: true, bootAnalysis: true, nativeSavedExact: true, stateRestored: true, isoInserted: true, requests: f.requests.length, errors });
            console.log(name + ": packaged UI local/remote VM, saves, state restore and ISO PASS");
        } finally { await browser.close(); await server.close(); }
    }
    const hash = createHash("sha256").update(await readFile(f.source)).digest("hex"); assert.equal(hash, f.sha256);
    await writeFile("build/pages-tests/integration.json", JSON.stringify(results, null, 2));
} finally { await f.close(); }
