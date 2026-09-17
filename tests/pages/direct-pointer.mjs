import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { serveSite, quietAudio } from "./server.mjs";
import { diskFixture } from "./fixture.mjs";
import { bootEncrypted } from "./encrypted.mjs";

const out = "build/pages-tests/direct-pointer";
await mkdir(out, { recursive: true });
const fixture = await diskFixture(), results = [];
try {
for(const [name, type] of Object.entries({ chromium, webkit })) {
    const server = await serveSite({ headers: true }), browser = await type.launch();
    try {
        for(const mobile of [false, true]) {
            const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: mobile, hasTouch: mobile });
            await context.routeWebSocket("**/*", socket => socket.close());
            await context.addInitScript(quietAudio);
            await context.addInitScript(() => {
                window.lockAttempts = 0;
                Element.prototype.requestPointerLock = () => { window.lockAttempts++; return Promise.reject(Error("Test lock denial")); };
                Element.prototype.requestFullscreen = undefined;
                Element.prototype.webkitRequestFullscreen = undefined;
            });
            const page = await context.newPage(), errors = [];
            page.on("pageerror", error => errors.push(String(error)));
            page.on("dialog", dialog => dialog.accept());
            await page.goto(server.url);
            await page.waitForFunction(() => !document.body.inert);
            await page.evaluate(async () => {
                const { V86 } = await import("./build/libv86.mjs"), run = V86.prototype.run;
                V86.prototype.run = function(...args) {
                    if(window.vm !== this) {
                        window.vm = this; window.events = [];
                        const send = this.bus.send;
                        this.bus.send = function(type, value) {
                            if(type.startsWith("mouse-")) window.events.push([type, value]);
                            return send.call(this, type, value);
                        };
                    }
                    return run.apply(this, args);
                };
            });
            await bootEncrypted(page, fixture.file);
            await page.evaluate(() => document.querySelector("#exit-fullscreen").click());
            assert.equal(await page.locator("#direct-pointer").getAttribute("aria-checked"), "false");
            await page.locator("#direct-pointer").click();
            assert.equal(await page.locator("#direct-pointer").getAttribute("aria-checked"), "true");
            const initialLocks = await page.evaluate(() => window.lockAttempts);
            await page.waitForTimeout(250);
            await page.screenshot({ path: `${out}/${name}-${mobile ? "mobile" : "desktop"}-controls.png` });
            await page.locator("#fullscreen").click();
            // Use the real display adapter; guest fixture itself is just a halted boot sector.
            await page.evaluate(() => {
                const a = vm.screen_adapter, v = vm.v86.cpu.devices.vga;
                a.set_mode(true); v.graphical_mode = true; v.svga_enabled = true;
                v.set_size_graphical(800, 600, 800, 600, 32);
                vm.emulator_bus.send("screen-set-size", [800, 600, 32]);
            });
            const clear = () => page.evaluate(() => { window.events = []; });
            const events = () => page.evaluate(() => window.events);
            const clicks = async () => (await events()).filter(e => e[0] === "mouse-click");
            const rect = () => page.locator("#vga").boundingBox();
            const checkPoint = async (x, y, r) => {
                const moves = (await events()).filter(e => e[0] === "mouse-absolute");
                assert(moves.length > 0);
                const value = moves.at(-1)[1];
                assert(Math.abs(value[0] / value[2] - (x - r.x) / r.width) < .006);
                assert(Math.abs(value[1] / value[3] - (y - r.y) / r.height) < .006);
                assert(!(await events()).some(e => e[0] === "mouse-delta"));
            };
            for(const viewport of [mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, { width: 844, height: 390 }]) {
                await page.setViewportSize(viewport);
                await page.waitForFunction(() => Math.abs(document.querySelector("#vm-view").getBoundingClientRect().height - visualViewport.height) < 2);
                const r = await rect();
                for(const [u, v] of [[.5,.5], [.02,.02], [.98,.98], [.1,.85]]) {
                    const x = r.x + r.width * u, y = r.y + r.height * v;
                    await clear();
                    if(mobile) await page.touchscreen.tap(x, y); else await page.mouse.click(x, y);
                    await checkPoint(x, y, r);
                    assert.deepEqual(await clicks(), [["mouse-click", [true,false,false]], ["mouse-click", [false,false,false]]]);
                    const es = await events();
                    assert(es.findIndex(e => e[0] === "mouse-absolute") < es.findIndex(e => e[0] === "mouse-click"));
                }
                await clear();
                const area = await page.locator("#display").boundingBox();
                const margin = r.x - area.x > 3 ? [area.x + 1, area.y + area.height / 2] : [area.x + area.width / 2, area.y + 1];
                if(mobile) await page.touchscreen.tap(...margin); else await page.mouse.click(...margin);
                assert.deepEqual(await clicks(), [], "Letterbox must not click the guest");
                await page.screenshot({ path: `${out}/${name}-${mobile ? "mobile" : "desktop"}-${viewport.width}.png` });
            }
            assert.equal(await page.locator("#vga").evaluate(e => getComputedStyle(e).cursor), "default");
            for(const id of ["touch-drag", "touch-right", "touch-hint"]) assert.equal(await page.locator("#" + id).isVisible(), false);
            if(!mobile) {
                const r = await rect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
                await page.mouse.move(x,y); await clear();
                await page.mouse.down(); await page.mouse.move(r.x - 10,y); await page.mouse.up();
                assert.deepEqual(await clicks(), [["mouse-click",[true,false,false]],["mouse-click",[false,false,false]]]);
                await page.mouse.click(x,y,{button:"right"});
                assert.deepEqual((await clicks()).slice(-2), [["mouse-click",[false,false,true]],["mouse-click",[false,false,false]]]);
                await clear();
                await page.mouse.down(); await page.mouse.down({button:"right"});
                await page.mouse.up({button:"right"}); await page.mouse.up();
                assert.deepEqual(await clicks(), [
                    ["mouse-click",[true,false,false]], ["mouse-click",[true,false,true]],
                    ["mouse-click",[true,false,false]], ["mouse-click",[false,false,false]],
                ], "Button chords must not leave latches pressed");
                await page.mouse.wheel(0,100);
                assert((await events()).some(e => e[0] === "mouse-wheel" && e[1][0] === -1));
                await page.mouse.down(); await page.evaluate(() => window.dispatchEvent(new Event("blur")));
                assert.deepEqual((await clicks()).at(-1), ["mouse-click",[false,false,false]]);
                await page.mouse.up();
            }
            // Deterministic gesture cancellation in both browsers (native taps above).
            await page.evaluate(() => {
                const d = document.querySelector("#display"), captures = new Set();
                d.setPointerCapture = id => captures.add(id);
                d.hasPointerCapture = id => captures.has(id);
                d.releasePointerCapture = id => captures.delete(id);
                window.pointer = (type, dx = 0, extra = {}) => {
                    const r = document.querySelector("#vga").getBoundingClientRect();
                    d.dispatchEvent(new PointerEvent(type, {pointerType:"touch",pointerId:41,isPrimary:true,bubbles:true,cancelable:true,clientX:r.x+r.width/2+dx,clientY:r.y+r.height/2,...extra}));
                };
            });
            for(const reason of ["move", "cancel", "lost", "multi", "blur", "pause", "toggle"]) {
                await clear();
                await page.evaluate(reason => {
                    pointer("pointerdown");
                    if(reason === "move") { pointer("pointermove",9); pointer("pointermove",0); }
                    if(reason === "cancel") pointer("pointercancel");
                    if(reason === "lost") pointer("lostpointercapture");
                    if(reason === "multi") pointer("pointerdown",0,{pointerId:42,isPrimary:false});
                    if(reason === "blur") window.dispatchEvent(new Event("blur"));
                    if(reason === "toggle") document.querySelector("#direct-pointer").click();
                }, reason);
                if(reason === "pause") await page.evaluate(() => vm.stop());
                await page.evaluate(() => pointer("pointerup"));
                assert(!(await clicks()).some(e => e[1].some(Boolean)), reason);
                if(reason === "pause") { await page.evaluate(() => vm.run()); await page.waitForFunction(() => !document.querySelector("#pause").disabled); }
                if(reason === "toggle") await page.evaluate(() => document.querySelector("#direct-pointer").click());
            }
            await clear(); await page.evaluate(() => pointer("pointerdown"));
            await page.waitForTimeout(450); await page.evaluate(() => pointer("pointerup"));
            assert.deepEqual(await clicks(), [["mouse-click",[true,false,false]],["mouse-click",[false,false,false]]], "No short tap deadline");
            assert.equal(await page.evaluate(() => window.lockAttempts), initialLocks);
            assert.equal(await page.evaluate(() => !!document.pointerLockElement), false);
            await page.evaluate(() => vm.restart());
            assert.equal(await page.locator("#direct-pointer").getAttribute("aria-checked"), "true");
            await page.evaluate(() => document.querySelector("#exit-fullscreen").click());
            await page.locator("#direct-pointer").click();
            assert.equal(await page.locator("#mouse").isDisabled(), false);
            assert.equal(await page.evaluate(() => vm.mouse_adapter.emu_enabled), true);
            // Closing and reopening the VM resets the option; no reload is required.
            await page.locator("#direct-pointer").click();
            await page.locator("#disk-close").click();
            await page.waitForFunction(() => !document.querySelector("#disk-login").hidden);
            await bootEncrypted(page, fixture.file);
            assert.equal(await page.locator("#direct-pointer").getAttribute("aria-checked"), "false");
            assert.deepEqual(errors, []);
            results.push({ browser: name, mobile, passed: true });
            console.log(`${name}/${mobile ? "mobile" : "desktop"}: direct pointer PASS`);
            await context.close();
        }
    } finally { await browser.close(); await server.close(); }
}
await writeFile(`${out}/results.json`, JSON.stringify(results,null,2));
} finally { await fixture.close(); }
