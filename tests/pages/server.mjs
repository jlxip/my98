import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";

export async function serveSite(options = {}) {
    const root = resolve(options.root || "build/site");
    const prefix = options.prefix || "/";
    const requests = [];
    const timers = new Set();
    const server = createServer(async (req, res) => {
        const pathname = new URL(req.url, "http://localhost").pathname;
        requests.push({ path: pathname, range: req.headers.range });
        try {
            if(!pathname.startsWith(prefix)) { res.writeHead(404).end(); return; }
            let relative = decodeURIComponent(pathname.slice(prefix.length));
            if(!relative || relative.endsWith("/")) relative += "index.html";
            const file = resolve(root, relative);
            if(!file.startsWith(root + sep)) { res.writeHead(404).end(); return; }
            if(relative === "coi-serviceworker.js") {
                if(options.workerStatus) { res.writeHead(options.workerStatus).end(); return; }
                if(options.workerDelay) await new Promise(r => {
                    const timer = setTimeout(() => { timers.delete(timer); r(); }, options.workerDelay);
                    timers.add(timer);
                });
            }
            let bytes = await readFile(file);
            if(relative === "coi-serviceworker.js" && options.revision)
                bytes = Buffer.concat([bytes, Buffer.from("\n// Test update " + options.revision)]);
            const type = ({ ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".html": "text/html", ".css": "text/css" })[extname(file)] || "application/octet-stream";
            const headers = { "Content-Type": type, "Cache-Control": "no-store" };
            if(options.headers) Object.assign(headers, { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" });
            const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
            if(range) {
                const start = +range[1], end = range[2] ? Math.min(+range[2], bytes.length - 1) : bytes.length - 1;
                if(start > end) { res.writeHead(416).end(); return; }
                headers["Content-Range"] = `bytes ${start}-${end}/${bytes.length}`;
                bytes = bytes.subarray(start, end + 1);
            }
            headers["Content-Length"] = bytes.length;
            res.writeHead(range ? 206 : 200, headers).end(bytes);
        } catch { res.writeHead(404).end(); }
    });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    return {
        url: `http://127.0.0.1:${server.address().port}${prefix}`, requests,
        async close() {
            for(const timer of timers) clearTimeout(timer);
            server.closeAllConnections();
            await new Promise(r => server.close(r));
        },
    };
}

export function quietAudio() {
    const connect = AudioNode.prototype.connect;
    const sinks = new WeakMap();
    AudioNode.prototype.connect = function(destination, ...args) {
        if(destination === this.context.destination) {
            let sink = sinks.get(this.context);
            if(!sink) {
                sink = this.context.createGain(); sink.gain.value = 0;
                connect.call(sink, destination); sinks.set(this.context, sink);
            }
            destination = sink;
        }
        return connect.call(this, destination, ...args);
    };
}

export async function clockResolution(page) {
    return page.evaluate(() => {
        const deltas = []; let before = performance.now();
        for(let i = 0; i < 100000 && deltas.length < 100; i++) {
            const now = performance.now();
            if(now > before) { deltas.push(now - before); before = now; }
        }
        return { isolated: crossOriginIsolated, minimumMs: Math.min(...deltas), samples: deltas.length };
    });
}
