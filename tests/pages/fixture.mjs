import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as dagPB from "@ipld/dag-pb";
import {UnixFS} from "ipfs-unixfs";
import { createIPNSRecord, marshalIPNSRecord } from "ipns";

// An actual signed IPNS record and content-addressed raw block on a second origin.
// Small enough to test the packaged client without a Kubo installation or public network.
export async function diskFixture({isolated=false} = {}) {
    let directory = resolve("build/pages-tests"); await mkdir(directory, { recursive: true });
    if(isolated) directory=await mkdtemp(directory+"/fixture-");
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
    let record = marshalIPNSRecord(await createIPNSRecord(signer, "/ipfs/" + cid, 1n, 3600000, { v1Compatible: false }));
    const blocks=new Map([[cid,block]]), delays=new Map(), timers=new Set();let sequence=1n;
    async function addBlock(bytes,code=0x55) {const id=CID.createV1(code,await sha256.digest(bytes));blocks.set(id.toString(),bytes);return id;}
    async function publishState(bytes) {
        const links=[],unixfs=new UnixFS({type:"file"});
        for(let i=0;i<bytes.length;i+=262144) {
            const chunk=bytes.subarray(i,i+262144),id=await addBlock(chunk);
            links.push({Name:"",Hash:id,Tsize:chunk.length});unixfs.addBlockSize(BigInt(chunk.length));
        }
        const file=dagPB.encode(dagPB.prepare({Data:unixfs.marshal(),Links:links}));
        const stateCid=await addBlock(file,0x70);
        const directory=dagPB.encode(dagPB.prepare({Data:new UnixFS({type:"directory"}).marshal(),Links:[
            {Name:"disk.my98",Hash:CID.parse(cid),Tsize:block.length},
            {Name:"state.my98state",Hash:stateCid,Tsize:file.length+bytes.length},
        ]}));
        const root=await addBlock(directory,0x70);
        record=marshalIPNSRecord(await createIPNSRecord(signer,"/ipfs/"+root,++sequence,3600000,{v1Compatible:false}));
        return {publicationCid:root.toString(),stateCid:stateCid.toString(),diskCid:cid};
    }
    const requests = [];
    const server = createServer((req, res) => {
        const url = new URL(req.url, "http://localhost"); requests.push(url.pathname);
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Headers", "Accept");
        if(req.method === "OPTIONS") { res.writeHead(204).end(); return; }
        if(url.pathname === "/ipns/" + identity.ipnsName) res.writeHead(200, { "Content-Type": "application/vnd.ipfs.ipns-record" }).end(record);
        else if(blocks.has(url.pathname.slice(6)) && url.pathname.startsWith("/ipfs/")) {
            const id=url.pathname.slice(6),send=()=>res.writeHead(200,{"Content-Type":"application/vnd.ipld.raw"}).end(blocks.get(id));
            if(delays.has(id)) {const timer=setTimeout(()=>{timers.delete(timer);send();},delays.get(id));timers.add(timer);}
            else send();
        }
        else res.writeHead(404).end();
    });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    return { ...packed, requests, publishState, blocks, delays, diskCid:cid, gateway: `http://127.0.0.1:${server.address().port}`,
        verify(path, expected = source) { run("verify", path, expected); },
        async close() { for(const timer of timers)clearTimeout(timer);server.closeAllConnections(); await new Promise(r => server.close(r)); if(isolated)await rm(directory,{recursive:true,force:true}); },
    };
}
