import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, createWriteStream } from "node:fs";
import { basename } from "node:path";

const file = process.argv[2];
const timeout = Number(process.env.BROWSER_TEST_TIMEOUT_MS || 180000);
if(!file || !Number.isFinite(timeout) || timeout <= 0) throw Error("Expected a test file and a positive timeout");
mkdirSync("build/pages-tests", { recursive: true });
const log = createWriteStream(`build/pages-tests/${basename(file)}.log`);
const started = Date.now();
function report(message) { const line = `[${file}] ${message}\n`; process.stdout.write(line); log.write(line); }
report(`START (deadline ${timeout}ms)`);
const child = spawn(process.execPath, [file], {
    detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DEBUG: process.env.DEBUG || "pw:browser" },
});
for(const [stream, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]])
    stream.on("data", data => { output.write(data); log.write(data); });
const descendants = new Set();
function kill(signal) {
    // Playwright starts browsers in separate process groups. Capture the complete
    // tree before terminating Node, so reparented browsers can still be killed.
    const rows = execFileSync("ps", ["-axo", "pid=,ppid="], {encoding:"utf8"})
        .trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
    const owned = new Set([child.pid]);
    let added;
    do {
        added = false;
        for(const [pid, parent] of rows) if(owned.has(parent) && !owned.has(pid)) {
            owned.add(pid); descendants.add(pid); added = true;
        }
    } while(added);
    for(const pid of [...descendants, child.pid]) for(const target of [-pid, pid]) {
        try { process.kill(target, signal); }
        catch(error) { if(error.code !== "ESRCH") throw error; }
    }
}
let expired = false, forced;
const deadline = setTimeout(() => {
    expired = true;
    report("DEADLINE exceeded; terminating test and browser process group");
    kill("SIGTERM");
    forced = setTimeout(() => kill("SIGKILL"), 2000);
}, timeout);
const cancel = () => { expired = true; kill("SIGKILL"); };
process.on("SIGTERM", cancel);
process.on("SIGINT", cancel);
child.on("error", error => report(String(error)));
child.on("close", (code, signal) => {
    clearTimeout(deadline); clearTimeout(forced);
    // A test must not leave a browser behind even when it exits early.
    kill("SIGKILL");
    process.off("SIGTERM", cancel); process.off("SIGINT", cancel);
    process.exitCode = expired ? 124 : code ?? 1;
    report(`END exit=${process.exitCode} signal=${signal || "none"} elapsed=${Date.now() - started}ms`);
    log.end();
});
