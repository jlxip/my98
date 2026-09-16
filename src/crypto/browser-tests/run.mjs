import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
const repo = process.env.CRYPTO_REPO_ROOT || fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(import.meta.url);
const { chromium, webkit } = process.env.PLAYWRIGHT_MODULE ? require(process.env.PLAYWRIGHT_MODULE) : require("playwright");
const fixture = JSON.parse(await readFile(path.join(repo, "build/crypto/native.json"), "utf8"));
const results = [], cross = [], requests = [];
const server = createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url });
    try {
        if(req.method !== "GET") { res.writeHead(405).end(); return; }
        const url = new URL(req.url, "http://localhost");
        let data, type = "text/javascript";
        if(url.pathname === "/") {
            data = '<!doctype html><meta charset="utf-8"><title>slop86 crypto tests</title><link rel="icon" href="data:,"><script type="module" src="/suite.mjs"></script>';
            type = "text/html";
        } else if(url.pathname === "/suite.mjs") data = await readFile(new URL("./browser.mjs", import.meta.url));
        else if(url.pathname === "/rng-disabled-worker.js") data = 'Object.defineProperty(globalThis.crypto,"getRandomValues",{value(){throw new Error("test RNG failure")}}); await import("/build/crypto/web/worker.js");';
        else {
            const candidate = path.resolve(repo, "." + decodeURIComponent(url.pathname));
            const allowed = path.join(repo, "build/crypto") + path.sep;
            if(!candidate.startsWith(allowed)) throw new Error("not allowed");
            data = await readFile(candidate);
            if(candidate.endsWith(".wasm")) type = "application/wasm";
        }
        res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" });
        res.end(data);
    } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
try {
    for(const [name, type] of Object.entries({ chromium, webkit })) {
        const browser = await type.launch({ headless: true });
        try {
            const context = await browser.newContext();
            const page = await context.newPage();
            const errors = [], expectedErrors = [];
            page.on("pageerror", error => {
                const message = String(error);
                if(message.includes("/missing-worker.js")) expectedErrors.push(message);
                else errors.push(message);
            });
            await page.goto(`http://127.0.0.1:${server.address().port}/`);
            await page.waitForFunction(() => typeof window.runCryptoTests === "function");
            const result = await page.evaluate(fixture => window.runCryptoTests(fixture), fixture);
            if(errors.length) throw new Error(errors.join("\n"));
            results.push({ browser: name, version: browser.version(), checks: result.results, deriveMs: result.deriveMs, expectedErrors });
            cross.push(result.output);
            console.log(`${name}: ${result.results.length} checks passed; derivation ${result.deriveMs.toFixed(0)} ms`);
        } finally { await browser.close(); }
    }
    if(requests.some(r => r.method !== "GET" || r.url.includes(fixture.password) || r.url.includes(fixture.username))) throw new Error("Unexpected network request");
    await mkdir(path.join(repo, "build/crypto"), { recursive: true });
    await writeFile(path.join(repo, "build/crypto/browser-results.json"), JSON.stringify({ results, requests }, null, 2));
    await writeFile(path.join(repo, "build/crypto/browser-output.json"), JSON.stringify(cross));
} finally { await new Promise(resolve => server.close(resolve)); }
