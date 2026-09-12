// Optional real-Windows acceptance, using only an existing public test fixture.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { webkit } from "playwright";
import { serveSite, quietAudio, clockResolution } from "./server.mjs";

if(process.argv.length !== 3) throw Error("Usage: node tests/pages/benchmark.mjs <public Win98 fixture.json>");
const fixture = JSON.parse(await readFile(resolve(process.argv[2]), "utf8"));
const source = resolve(fixture.source), encrypted = resolve(fixture.file);
async function hash(path) { const digest = createHash("sha256"); for await(const bytes of createReadStream(path)) digest.update(bytes); return digest.digest("hex"); }
assert.equal(await hash(source), fixture.sha256);
const encryptedHash = await hash(encrypted), results = [];
await mkdir("build/pages-tests", { recursive: true });
for(const mode of ["none", "worker", "headers"]) {
    const server = await serveSite({ headers: mode === "headers" }), browser = await webkit.launch();
    try {
        const context = await browser.newContext({ viewport: { width: 1024, height: 800 } });
        await context.routeWebSocket("**/*", socket => socket.close());
            await context.addInitScript(quietAudio);
        if(mode === "none") await context.addInitScript(() => Object.defineProperty(navigator, "serviceWorker", { value: undefined }));
        const page = await context.newPage(), errors = [];
        page.on("pageerror", e => errors.push(String(e)));
        await page.goto(server.url);
        await page.waitForFunction(() => document.body && !document.body.inert);
        const clock = await clockResolution(page);
        assert.equal(clock.isolated, mode !== "none");
        await page.locator("#disk-panel > summary").click();
        await page.locator("#disk-user").fill("disk fixtures"); await page.locator("#disk-password").fill("public compatibility password");
        await page.locator("#disk-login button").click(); await page.locator("#disk-workspace").waitFor({ state: "visible" });
        const chooser = page.waitForEvent("filechooser"); await page.locator("#disk-open").click(); await (await chooser).setFiles(encrypted);
        await page.waitForFunction(() => !document.querySelector("#disk-boot").disabled);
        const started = Date.now(); await page.locator("#disk-boot").click();
        console.log(mode + ": boot started; clock " + JSON.stringify(clock));
        await page.waitForFunction(() => {
            const c = document.querySelector("#vga"); if(!c || c.width < 640 || c.height < 480) return false;
            const p = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
            let teal = 0, bar = 0;
            for(let i = 0; i < p.length; i += 16) if(p[i] < 10 && p[i+1] >= 115 && p[i+1] <= 140 && p[i+2] >= 115 && p[i+2] <= 140) teal++;
            for(let y = c.height - 20; y < c.height - 3; y++) for(let x = 0; x < c.width; x++) {
                const i = (y*c.width+x)*4, r = p[i], g = p[i+1], b = p[i+2];
                if(r > 150 && r < 220 && Math.abs(r-g) < 12 && Math.abs(r-b) < 12) bar++;
            }
            return teal > 1000 && bar > c.width*8;
        }, null, { timeout: 180000, polling: 500 });
        const desktopMs = Date.now() - started;
        await page.evaluate(async () => { if(document.fullscreenElement) await document.exitFullscreen(); else if(document.webkitFullscreenElement) document.webkitExitFullscreen(); });
        await page.locator("#pause").click();
        await page.screenshot({ path: `build/pages-tests/win98-${mode}.png`, fullPage: true });
        assert.deepEqual(errors, []);
        results.push({ mode, browser: browser.version(), clock, desktopMs, errors, sourceSha256: fixture.sha256 });
        await writeFile("build/pages-tests/benchmark.json", JSON.stringify(results, null, 2));
        console.log(mode + ": desktop reached in " + desktopMs + " ms");
    } finally { await browser.close(); await server.close(); }
}
assert.equal(await hash(source), fixture.sha256); assert.equal(await hash(encrypted), encryptedHash);
console.log("Real Win98 benchmark PASS; source and encrypted fixture unchanged");
