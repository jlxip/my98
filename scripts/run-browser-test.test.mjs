import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const runner = resolve("scripts/run-browser-test.mjs");
for(const [name, source, expected] of [
    ["success", "console.log('finished');", 0],
    ["failure", "process.exitCode = 7;", 7],
    ["stuck-renderer", `import {spawn} from 'node:child_process';
        spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'], {stdio:'inherit', detached:true});
        process.on('SIGTERM',()=>{}); console.log('last phase: audio startup'); setInterval(()=>{},1000);`, 124],
]) test(name, async () => {
    const dir = await mkdtemp(join(tmpdir(), "browser-deadline-"));
    try {
        const file = join(dir, "fixture.mjs"); await writeFile(file, source);
        const result = spawnSync(process.execPath, [runner, file], {
            cwd: dir, encoding: "utf8", timeout: 10000,
            env: {...process.env, BROWSER_TEST_TIMEOUT_MS: "500"},
        });
        assert.ifError(result.error); assert.equal(result.status, expected, result.stderr);
        const log = await readFile(join(dir, "build/pages-tests/fixture.mjs.log"), "utf8");
        assert.match(log, /END exit=/);
        if(expected === 124) { assert.match(log, /last phase: audio startup/); assert.match(log, /DEADLINE exceeded/); }
    } finally { await rm(dir, {recursive:true, force:true}); }
});
