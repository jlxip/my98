import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { serveSite, quietAudio } from "./server.mjs";
import { diskFixture } from "./fixture.mjs";
import { bootEncrypted } from "./encrypted.mjs";

const output = "build/pages-tests/controls";
await mkdir(output, { recursive: true });
const fixture = await diskFixture({isolated: true});
try {
    for(const [name, engine] of Object.entries({chromium, webkit})) {
        const server = await serveSite({headers: true}), browser = await engine.launch();
        try {
            const context = await browser.newContext({viewport: {width: 1280, height: 900}});
            await context.routeWebSocket("**/*", socket => socket.close());
            await context.addInitScript(quietAudio);
            await context.addInitScript(() => {
                Element.prototype.requestFullscreen = undefined;
                Element.prototype.webkitRequestFullscreen = undefined;
                window.lockAttempts = 0;
                Element.prototype.requestPointerLock = function() {
                    window.lockAttempts++;
                    return new Promise(resolve => { window.completeLock = () => {
                        Object.defineProperty(document, "pointerLockElement", {configurable: true, value: this});
                        document.dispatchEvent(new Event("pointerlockchange"));
                        resolve();
                    }; });
                };
                document.exitPointerLock = () => {
                    Object.defineProperty(document, "pointerLockElement", {configurable: true, value: null});
                    document.dispatchEvent(new Event("pointerlockchange"));
                };
            });
            const page = await context.newPage(), errors = [];
            page.on("pageerror", error => errors.push(String(error)));
            page.on("dialog", dialog => { errors.push("Unexpected dialog: " + dialog.message()); dialog.dismiss(); });
            await page.goto(server.url);
            await page.waitForFunction(() => !document.body.inert);
            await page.evaluate(async () => {
                const {V86} = await import("./build/libv86.mjs"), run = V86.prototype.run;
                V86.prototype.run = function(...args) { window.vm = this; return run.apply(this, args); };
            });
            await bootEncrypted(page, fixture.file);
            assert.equal(await page.locator("#fullscreen").isVisible(), false);
            assert.equal(await page.locator("#view-controls").isVisible(), false);
            await page.keyboard.press("Escape");
            assert.equal(await page.locator("#mouse").count(), 0);
            const ready = () => page.waitForFunction(() => !document.querySelector("#pause").disabled);
            const icon = id => page.locator("#" + id).getAttribute("data-icon");
            for(const width of [1280, 390, 320]) {
                await page.setViewportSize({width, height: 900});
                await page.locator("#pause").scrollIntoViewIfNeeded();
                const metrics = await page.locator("#session").evaluate(session => ({
                    overflow: document.documentElement.scrollWidth > innerWidth,
                    buttons: [...session.querySelectorAll("button:not([hidden])")].filter(b => b.getBoundingClientRect().width).map(b => {
                        const r = b.getBoundingClientRect(), svg = b.querySelector("svg").getBoundingClientRect();
                        return {id: b.id, width: r.width, height: r.height, svgWidth: svg.width, label: b.getAttribute("aria-label"), text: b.textContent};
                    }),
                }));
                assert.equal(metrics.overflow, false);
                for(const button of metrics.buttons) {
                    assert.equal(button.width, 56, button.id); assert.equal(button.height, 56, button.id);
                    assert.equal(button.svgWidth, 40, button.id); assert(button.label, button.id); assert.equal(button.text, "", button.id);
                }
                await page.screenshot({path: `${output}/${name}-${width}.png`, fullPage: true});
            }
            await page.setViewportSize({width: 1280, height: 900});
            await page.locator("#pause").click(); await ready();
            assert.equal(await icon("pause"), "play"); assert.equal(await page.evaluate(() => vm.is_running()), false);
            await page.locator("#pause").click(); await ready(); assert.equal(await icon("pause"), "pause");
            await page.locator("#mute").click(); await ready();
            assert.equal(await icon("mute"), "volume-x"); assert.equal(await page.locator("#mute").getAttribute("aria-pressed"), "true");
            await page.locator("#mute").click(); await ready(); assert.equal(await page.locator("#mute").getAttribute("aria-pressed"), "false");
            await page.evaluate(() => { window.resets = 0; const restart = vm.restart; vm.restart = function() { window.resets++; return restart.call(this); }; });
            await page.locator("#reset").click();
            assert.equal(await page.evaluate(() => window.resets), 0);
            await page.waitForFunction(() => getComputedStyle(document.querySelector("#reset")).backgroundColor === "rgb(185, 28, 28)");
            await page.keyboard.press("Escape"); assert.equal(await page.locator("#reset").getAttribute("data-confirm"), null);
            await page.locator("#reset").click(); await page.locator("#mute").focus();
            assert.equal(await page.locator("#reset").getAttribute("data-confirm"), null);
            await page.locator("#reset").focus(); await page.keyboard.press("Enter"); await page.keyboard.press("Enter"); await ready();
            assert.equal(await page.evaluate(() => window.resets), 1);

            // Each drive toggles in place, with independent state and exact floppy downloads.
            for(const drive of ["cdrom", "fda", "fdb"]) {
                const buffer = Buffer.alloc(drive === "cdrom" ? 2048 : 1440 * 1024, 42);
                const chooser = page.waitForEvent("filechooser");
                await page.locator("#insert-" + drive).click();
                await (await chooser).setFiles({name: drive + (drive === "cdrom" ? ".iso" : ".img"), mimeType: "application/octet-stream", buffer});
                await ready(); assert.equal(await icon("insert-" + drive), "eject");
                if(drive !== "cdrom") {
                    const download = page.waitForEvent("download"); await page.locator("#download-" + drive).click();
                    const file = await download; assert.deepEqual(await readFile(await file.path()), buffer); await ready();
                }
            }
            await page.locator("#controls").screenshot({path: `${output}/${name}-loaded.png`});
            for(const drive of ["cdrom", "fda", "fdb"]) {
                await page.locator("#insert-" + drive).click(); await ready();
                assert.equal(await icon("insert-" + drive), drive === "cdrom" ? "disc" : "save");
                if(drive !== "cdrom") assert.equal(await page.locator("#download-" + drive).isDisabled(), true);
            }

            await page.locator("#display").click(); assert.equal(await page.evaluate(() => window.lockAttempts), 0);
            assert.equal(await page.locator("#vga").evaluate(e => getComputedStyle(e).cursor), "none");
            await page.locator("#direct-pointer").click();
            await page.locator("#fullscreen").click();
            assert.equal(await icon("fullscreen"), "minimize");
            assert.equal(await page.locator("#view-controls #fullscreen").count(), 1);
            assert.equal(await page.locator("#fullscreen").isVisible(), false);
            assert.equal(await page.locator("#view-controls").isVisible(), false);
            assert.equal(await page.locator("#direct-pointer").getAttribute("aria-checked"), "false");
            assert.equal(await page.evaluate(() => window.lockAttempts), 1);
            await page.evaluate(() => window.completeLock());
            assert.equal(await page.evaluate(() => document.pointerLockElement?.id), "display");
            await page.keyboard.press("Escape");
            assert.equal(await page.evaluate(() => document.pointerLockElement), null);
            assert.equal(await page.locator("#direct-pointer").getAttribute("aria-checked"), "true");
            assert.equal(await icon("fullscreen"), "monitor");
            // Escape exits fallback fullscreen; a late pointer-lock result is released.
            await page.locator("#fullscreen").click(); await page.keyboard.press("Escape");
            await page.evaluate(() => window.completeLock());
            assert.equal(await page.evaluate(() => document.pointerLockElement), null);
            assert.equal(await page.locator("#direct-pointer").getAttribute("aria-checked"), "true");
            assert.deepEqual(errors, []);
            console.log(`${name}: icons, sizing, labels, reset, pause/mute, media/downloads, fullscreen and pointer lifecycle PASS`);
        } finally { await browser.close(); await server.close(); }
    }
} finally { await fixture.close(); }
