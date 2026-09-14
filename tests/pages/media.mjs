import assert from "node:assert/strict";
import { mkdir, open, stat, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { serveSite, quietAudio } from "./server.mjs";

const output = "build/pages-tests";
await mkdir(output, { recursive: true });
const results = [];
async function pick(page, selector, file) {
    const chooser = page.waitForEvent("filechooser");
    await page.locator(selector).click();
    await (await chooser).setFiles(file);
    await page.waitForFunction(() => !document.querySelector("#insert-cdrom").disabled);
}
const upload = (name, buffer) => ({ name, mimeType: "application/octet-stream", buffer });
for(const [name, type] of Object.entries({ chromium, webkit })) {
    const server = await serveSite({ prefix: "/my98/", headers: true });
    const browser = await type.launch();
    try {
        const context = await browser.newContext();
        await context.routeWebSocket("**/*", socket => socket.close());
        await context.addInitScript(quietAudio);
        const page = await context.newPage(), errors = [];
        page.on("pageerror", e => errors.push(String(e)));
        await page.goto(server.url);
        await page.waitForFunction(() => !document.body.inert && !document.querySelector("#choose-disk").disabled);
        await page.evaluate(async () => {
            const { V86 } = await import("./build/libv86.mjs");
            const insert = V86.prototype.set_cdrom;
            V86.prototype.set_cdrom = async function(disk) {
                await insert.call(this, disk);
                window.testCD = this.v86.cpu.devices.cdrom;
                window.testCDAsync = disk.async === true;
            };
        });
        const boot = Buffer.alloc(512 * 1024);
        boot.set([0xfa, 0xf4, 0xeb, 0xfd]); boot[510] = 85; boot[511] = 170;
        await pick(page, "#choose-disk", upload("boot.img", boot));
        await page.evaluate(() => document.querySelector("#exit-fullscreen").click());
        await page.waitForFunction(() => !document.querySelector("#vm-view").classList.contains("expanded"));
        const iso = Buffer.from(await page.evaluate(async () => {
            const { generate } = await import("./slop86/src/iso9660.js");
            return Array.from(generate([{ name: "hello.txt", contents: new TextEncoder().encode("CD regression") }]));
        }));
        const readCD = (offset, length) => page.evaluate(({ offset, length }) => new Promise(resolve => {
            window.testCD.buffer.get(offset, length, bytes => resolve(Array.from(bytes)));
        }), { offset, length });
        async function inserted(file, expected) {
            await pick(page, "#insert-cdrom", file);
            assert.equal(await page.locator("#cdrom-name").textContent(), expected,
                await page.locator("#session-status").textContent());
        }
        await inserted(upload("aligned.iso", iso), "aligned.iso");
        assert.deepEqual(Buffer.from(await readCD(0, iso.length)), iso);
        // A complete ISO followed by an unaligned trailer, as in Nero exports.
        await inserted(upload("trailer.iso", Buffer.concat([iso, Buffer.alloc(72, 0xa5)])), "trailer.iso");
        assert.equal(await page.evaluate(() => window.testCD.buffer.byteLength), iso.length);
        assert.deepEqual(Buffer.from(await readCD(0, iso.length)), iso);
        const mismatched = Buffer.concat([iso, Buffer.alloc(72)]);
        mismatched[16 * 2048 + 84] ^= 1;
        const badBlockSize = Buffer.concat([iso, Buffer.alloc(72)]);
        badBlockSize[16 * 2048 + 128] = 1;
        const missingHeader = Buffer.concat([iso, Buffer.alloc(72)]);
        missingHeader[16 * 2048 + 1] = 0;
        for(const [filename, bytes] of [
            ["truncated.iso", iso.subarray(0, iso.length - 1)],
            ["endian.iso", mismatched], ["block-size.iso", badBlockSize],
            ["no-header.iso", missingHeader], ["raw.iso", Buffer.alloc(2352)],
        ]) {
            await pick(page, "#insert-cdrom", upload(filename, bytes));
            assert.match(await page.locator("#session-status").textContent(), /image size is invalid/);
            assert.equal(await page.locator("#cdrom-name").textContent(), "trailer.iso");
        }
        await pick(page, "#insert-fda", upload("trailer.img", Buffer.concat([iso, Buffer.alloc(72)])));
        assert.match(await page.locator("#session-status").textContent(), /image size is invalid/);
        assert.equal(await page.locator("#fda-name").textContent(), "Empty");
        let realImage;
        if(process.env.MY98_TEST_CD) {
            const path = process.env.MY98_TEST_CD, size = (await stat(path)).size;
            const alignedSize = size - size % 2048;
            await inserted(path, path.split("/").pop());
            assert.equal(await page.evaluate(() => window.testCD.buffer.byteLength), alignedSize);
            assert.equal(await page.evaluate(() => window.testCDAsync), size >= 256 * 1024 * 1024);
            const source = await open(path);
            try {
                for(const offset of [0, 16 * 2048, alignedSize - 2048]) {
                    const expected = Buffer.alloc(2048);
                    await source.read(expected, 0, 2048, offset);
                    assert.deepEqual(Buffer.from(await readCD(offset, 2048)), expected);
                }
            } finally { await source.close(); }
            realImage = { size, mountedBytes: alignedSize, sectorsVerified: 3 };
        }
        assert.deepEqual(errors, []);
        results.push({ browser: name, alignedISO: true, trailerISO: true, rejectedInvalid: 6, realImage, errors });
        console.log(name + ": CD trailer, exact reads, invalid media preservation PASS");
    } finally { await browser.close(); await server.close(); }
}
await writeFile(output + "/media.json", JSON.stringify(results, null, 2));
