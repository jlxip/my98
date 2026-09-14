import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
import { serveSite, quietAudio } from "./server.mjs";

const server = await serveSite({root: "build/slop86"});
try {
    for(const [name, type] of Object.entries({chromium, webkit})) {
        console.log(name + ": audio lifecycle start");
        const browser = await type.launch();
        try {
            const page = await browser.newPage();
            const errors = []; page.on("pageerror", error => errors.push(String(error)));
            page.on("console", message => console.log(name + ": " + message.text()));
            await page.addInitScript(quietAudio);
            await page.goto(server.url + "tests/browser/speaker.html");
            await page.locator("#run").click();
            const result = await page.evaluate(() => window.audioTest);
            assert.ok(result.checks > 0);
            assert.deepEqual(errors, []);
            console.log(name + ": audio startup regression PASS " + JSON.stringify(result));
        } finally { await browser.close(); }
    }
} finally { await server.close(); }
