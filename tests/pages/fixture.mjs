import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { createIPNSRecord, marshalIPNSRecord } from "ipns";

// An actual signed IPNS record and content-addressed raw block on a second origin.
// Small enough to test the packaged client without a Kubo installation or public network.
export async function diskFixture() {
    const directory = resolve("build/pages-tests"); await mkdir(directory, { recursive: true });
    const source = directory + "/fixture.img", file = directory + "/fixture.my98";
    const bytes = new Uint8Array(512 * 1024);
    bytes.set([0xfa, 0xf4, 0xeb, 0xfd]); // cli; hlt; loop: a harmless bootable test disk
    bytes[510] = 85; bytes[511] = 170;
    await writeFile(source, bytes);
    const compat = resolve("build/disk-target/release/examples/compat");
    const run = (...args) => execFileSync(compat, args, { encoding: "utf8" });
    const packed = JSON.parse(run("pack", source, file));
    const block = await readFile(file), cid = CID.createV1(0x55, await sha256.digest(block)).toString();
    const identity = JSON.parse(run("identity"));
    const signer = { type: "Ed25519", sign: async data => new Uint8Array(Buffer.from(run("sign", Buffer.from(data).toString("hex")).trim(), "hex")) };
    const record = marshalIPNSRecord(await createIPNSRecord(signer, "/ipfs/" + cid, 1n, 3600000, { v1Compatible: false }));
    const requests = [];
    const server = createServer((req, res) => {
        const url = new URL(req.url, "http://localhost"); requests.push(url.pathname);
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Headers", "Accept");
        if(req.method === "OPTIONS") { res.writeHead(204).end(); return; }
        if(url.pathname === "/ipns/" + identity.ipnsName) res.writeHead(200, { "Content-Type": "application/vnd.ipfs.ipns-record" }).end(record);
        else if(url.pathname === "/ipfs/" + cid) res.writeHead(200, { "Content-Type": "application/vnd.ipld.raw" }).end(block);
        else res.writeHead(404).end();
    });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    return { ...packed, requests, gateway: `http://127.0.0.1:${server.address().port}`,
        verify(path, expected = source) { run("verify", path, expected); },
        async close() { server.closeAllConnections(); await new Promise(r => server.close(r)); },
    };
}
