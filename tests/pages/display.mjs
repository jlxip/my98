import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { serveSite, quietAudio } from "./server.mjs";
import { diskFixture } from "./fixture.mjs";
import { bootEncrypted } from "./encrypted.mjs";

const output = "build/pages-tests/display";
await mkdir(output, { recursive: true });
const fixture = await diskFixture();
const results = [];
for(const [name, type] of Object.entries({ chromium, webkit })) {
    const server = await serveSite({ headers: true }), browser = await type.launch();
    try {
        // Keep each viewport in a fresh context. Resizing after native fullscreen
        // can leave headless Chromium's pointer coordinates stale on Linux.
        for(const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
            const context = await browser.newContext({ viewport });
            await context.routeWebSocket("**/*", socket => socket.close());
            await context.addInitScript(quietAudio);
            const page = await context.newPage(), errors = [];
            page.on("pageerror", error => errors.push(String(error)));
            await page.goto(server.url);
            await page.waitForFunction(() => !document.body.inert);
            await page.evaluate(async () => {
                const { V86 } = await import("./build/libv86.mjs"), run = V86.prototype.run;
                V86.prototype.run = function(...args) { window.vm = this; return run.apply(this, args); };
            });
            await bootEncrypted(page, fixture.file);
            await page.waitForFunction(() => window.vm?.is_running() && !document.querySelector("#pause").disabled);
            await page.evaluate(() => window.vm.stop());
            await page.waitForFunction(() => !window.vm.is_running());
            // Wait for the native exit as well as the application's layout change.
            await page.evaluate(() => document.querySelector("#exit-fullscreen").click());
            await page.waitForFunction(() =>
                !document.querySelector("#vm-view").classList.contains("expanded") &&
                !document.fullscreenElement && !document.webkitFullscreenElement);
            for(const expanded of [false, true]) {
                if(expanded) await page.locator("#fullscreen").click();
                for(const [width, height, bpp, aspect] of [
                    [80, 25, 0, 4 / 3], [320, 400, 32, 4 / 5],
                    [320, 400, 8, 4 / 3], [320, 200, 8, 4 / 3],
                    [640, 480, 16, 4 / 3], [800, 600, 16, 4 / 3],
                    [1280, 1024, 32, 5 / 4], [1280, 720, 32, 16 / 9], [80, 25, 0, 4 / 3],
                ]) {
                    // Exercise the real adapter (including its built-in scale reset),
                    // followed by the same notification order as VGAScreen.
                    await page.evaluate(({ width, height, bpp }) => {
                        const adapter = window.vm.screen_adapter;
                        adapter.set_mode(!!bpp);
                        if(bpp) {
                            const vga = window.vm.v86.cpu.devices.vga;
                            vga.graphical_mode = true;
                            vga.svga_enabled = bpp > 8;
                            vga.set_size_graphical(width, height, width, height, bpp);
                        }
                        else adapter.set_size_text(width, height);
                        window.vm.emulator_bus.send("screen-set-size", [width, height, bpp]);
                    }, { width, height, bpp });
                    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                    const layout = await page.evaluate(bpp => {
                        const target = document.querySelector(bpp ? "#vga" : "#screen");
                        const r = target.getBoundingClientRect(), a = document.querySelector("#display").getBoundingClientRect();
                        return { x: r.x, y: r.y, width: r.width, height: r.height,
                            area: { x: a.x, y: a.y, width: a.width, height: a.height },
                            buffer: bpp ? [target.width, target.height] : null };
                    }, bpp);
                    const expectedWidth = Math.min(layout.area.width, layout.area.height * aspect);
                    assert(Math.abs(layout.width - expectedWidth) < 1, JSON.stringify(layout));
                    assert(Math.abs(layout.height - expectedWidth / aspect) < 1, JSON.stringify(layout));
                    assert(Math.abs(layout.x + layout.width / 2 - layout.area.x - layout.area.width / 2) < 1);
                    assert(Math.abs(layout.y + layout.height / 2 - layout.area.y - layout.area.height / 2) < 1);
                    if(bpp) assert.deepEqual(layout.buffer, [width, height], "Presentation must not change guest resolution");
                    results.push({ browser: name, viewport, expanded, mode: [width, height, bpp], layout });
                }
            }
            assert.deepEqual(errors, []);
            await context.close();
        }
        console.log(`${name}: VGA/text transitions, desktop/mobile layouts and fullscreen PASS`);
    } finally { await browser.close(); await server.close(); }
}
await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));

await fixture.close();
