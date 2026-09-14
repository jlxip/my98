import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { serveSite, quietAudio } from "./server.mjs";
import { diskFixture } from "./fixture.mjs";
import { bootEncrypted } from "./encrypted.mjs";

const output = "build/pages-tests/mobile";
await mkdir(output, { recursive: true });
const fixture = await diskFixture();
const results = [];
for(const [name, type] of Object.entries({ chromium, webkit })) {
    const server = await serveSite({ headers: true }), browser = await type.launch();
    try {
        for(const fullscreen of ["missing", "rejected", "native"]) {
            const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
            await context.routeWebSocket("**/*", socket => socket.close());
            await context.addInitScript(quietAudio);
            await context.addInitScript(mode => {
                window.lockAttempts = 0;
                Element.prototype.requestPointerLock = () => { window.lockAttempts++; throw Error("No touch pointer lock"); };
                if(mode !== "native") {
                    Element.prototype.requestFullscreen = mode === "missing" ? undefined : () => Promise.reject(Error("Denied"));
                    Element.prototype.webkitRequestFullscreen = undefined;
                }
            }, fullscreen);
            try {
                const page = await context.newPage(), errors = [];
                page.on("pageerror", error => errors.push(String(error)));
                await page.goto(server.url);
                await page.waitForFunction(() => !document.body.inert);
                // Observe the real V86 bus at the module boundary, without a production debug API.
                await page.evaluate(async () => {
                    const { V86 } = await import("./build/libv86.mjs");
                    const run = V86.prototype.run;
                    V86.prototype.run = function(...args) {
                        if(!window.vm) {
                            window.vm = this; window.mouseEvents = [];
                            const send = this.bus.send;
                            this.bus.send = function(type, value) {
                                if(type.startsWith("mouse-")) window.mouseEvents.push([type, value]);
                                return send.call(this, type, value);
                            };
                        }
                        return run.apply(this, args);
                    };
                });
                await bootEncrypted(page, fixture.file);
                await page.waitForFunction(() => window.vm?.is_running() && !document.querySelector("#touch-drag").disabled);
                assert.equal(await page.locator("#vm-view").evaluate(e => e.classList.contains("expanded")), true);
                await page.evaluate(() => window.scrollTo(0, 100));
                const layout = async () => page.evaluate(() => {
                    const view = document.querySelector("#vm-view").getBoundingClientRect();
                    const display = document.querySelector("#display").getBoundingClientRect();
                    const exit = document.querySelector("#exit-fullscreen").getBoundingClientRect();
                    return { width: view.width, height: view.height, available: visualViewport.height,
                        displayHeight: display.height, exitBottom: exit.bottom, bottom: view.bottom, scroll: scrollY,
                        action: getComputedStyle(document.querySelector("#display")).touchAction };
                });
                const portrait = await layout();
                assert(Math.abs(portrait.height - portrait.available) < 2);
                assert(portrait.displayHeight > 650 && portrait.exitBottom <= portrait.bottom);
                assert.equal(portrait.action, "none");
                const point = async () => {
                    const r = await page.locator("#display").boundingBox();
                    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
                };
                const clear = () => page.evaluate(() => { window.mouseEvents = []; });
                const events = () => page.evaluate(() => window.mouseEvents);
                await clear();
                const p = await point();
                await page.touchscreen.tap(p.x, p.y);
                assert.deepEqual((await events()).filter(e => e[0] === "mouse-click"), [
                    ["mouse-click", [true, false, false]], ["mouse-click", [false, false, false]],
                ], "One tap must produce exactly one left click");
                await page.locator("#touch-right").tap();
                assert.deepEqual((await events()).slice(-2), [["mouse-click", [false, false, true]], ["mouse-click", [false, false, false]]]);
                // Chromium exposes native moving touches via CDP. WebKit's public Playwright
                // touchscreen API only taps: use synthetic Pointer Events for its move/cancel logic.
                const cdp = name === "chromium" ? await context.newCDPSession(page) : null;
                if(!cdp) await page.evaluate(() => {
                    const display = document.querySelector("#display"), captures = new Set();
                    display.setPointerCapture = id => captures.add(id);
                    display.hasPointerCapture = id => captures.has(id);
                    display.releasePointerCapture = id => captures.delete(id);
                });
                const pointer = async (phase, dx = 0, dy = 0) => {
                    if(cdp) await cdp.send("Input.dispatchTouchEvent", { type: "touch" + phase,
                        touchPoints: ["End", "Cancel"].includes(phase) ? [] : [{ x: p.x + dx, y: p.y + dy, id: 1 }] });
                    else await page.evaluate(({ phase, x, y }) => {
                        const type = { Start: "pointerdown", Move: "pointermove", End: "pointerup", Cancel: "pointercancel" }[phase];
                        document.querySelector("#display").dispatchEvent(new PointerEvent(type, {
                            pointerId: 9, pointerType: "touch", isPrimary: true, clientX: x, clientY: y,
                            bubbles: true, cancelable: true,
                        }));
                    }, { phase, x: p.x + dx, y: p.y + dy });
                };
                await clear();
                await pointer("Start"); await pointer("Move", 30, 45); await pointer("End", 30, 45);
                const moved = await events();
                assert(moved.some(e => e[0] === "mouse-delta" && e[1][0] > 0 && e[1][1] < 0));
                assert(!moved.some(e => e[0] === "mouse-click"));
                assert.equal((await layout()).scroll, portrait.scroll, "Touch drag scrolled the page");
                await clear(); await page.locator("#touch-drag").tap();
                await pointer("Start"); await pointer("Move", 40, 10); await pointer("End", 40, 10);
                assert.deepEqual((await events()).filter(e => e[0] === "mouse-click"), [
                    ["mouse-click", [true, false, false]], ["mouse-click", [false, false, false]],
                ]);
                assert.equal(await page.locator("#touch-drag").getAttribute("aria-pressed"), "false");
                for(const reason of ["cancel", "blur", "stop"]) {
                    await clear(); await page.locator("#touch-drag").tap(); await pointer("Start");
                    if(reason === "cancel") await pointer("Cancel");
                    else {
                        if(reason === "blur") await page.evaluate(() => window.dispatchEvent(new Event("blur")));
                        else await page.evaluate(() => window.vm.stop());
                        await pointer("End");
                    }
                    assert.deepEqual((await events()).filter(e => e[0] === "mouse-click").at(-1), ["mouse-click", [false, false, false]], reason);
                    await page.evaluate(() => window.vm.run());
                    await page.waitForFunction(() => !document.querySelector("#touch-drag").disabled);
                }
                assert.equal(await page.evaluate(() => window.lockAttempts), 0);
                await page.screenshot({ path: `${output}/${name}-${fullscreen}-portrait.png` });
                const native = await page.evaluate(() => !!(document.fullscreenElement || document.webkitFullscreenElement));
                if(native && cdp) await cdp.send("Emulation.setDeviceMetricsOverride", {
                    width: 844, height: 390, deviceScaleFactor: 1, mobile: true,
                    screenOrientation: { type: "landscapePrimary", angle: 90 },
                });
                else await page.setViewportSize({ width: 844, height: 390 });
                await page.waitForFunction(() => Math.abs(document.querySelector("#vm-view").getBoundingClientRect().height - visualViewport.height) < 2);
                const landscape = await layout();
                assert(landscape.displayHeight > 290 && landscape.exitBottom <= landscape.bottom);
                await page.screenshot({ path: `${output}/${name}-${fullscreen}-landscape.png` });
                await page.locator("#exit-fullscreen").tap();
                await page.waitForFunction(() => !document.querySelector("#vm-view").classList.contains("expanded"));
                assert.equal(await page.evaluate(() => document.documentElement.classList.contains("vm-expanded")), false);
                await page.locator("#fullscreen").tap();
                await page.locator("#exit-fullscreen").waitFor({ state: "visible" });
                await page.locator("#exit-fullscreen").tap();
                await page.locator("#pause").tap();
                await page.waitForFunction(() => document.querySelector("#pause").textContent === "Resume");
                assert.deepEqual(errors, []);
                results.push({ browser: name, fullscreen, native, portrait, landscape, nativeTouchMove: !!cdp, errors });
                console.log(`${name}/${fullscreen}: fullscreen, touch, drag, cancellation, rotation and controls PASS`);
            } finally { await context.close(); }
        }
    } finally { await browser.close(); await server.close(); }
}
await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));

await fixture.close();
