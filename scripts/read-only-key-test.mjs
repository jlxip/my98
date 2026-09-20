// Isolated CLI integration checks. All credentials here belong to public fixtures.
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {readFile, writeFile, mkdir, mkdtemp, copyFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve, join} from 'node:path';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {CID} from 'multiformats/cid';
import {sha256} from 'multiformats/hashes/sha2';
import {createIPNSRecord, marshalIPNSRecord} from 'ipns';
import {fixture} from '../src/disk/browser-tests/ipfs-fixture.mjs';
import init, {Vault} from '../build/disk/pkg/slop86_disk.js';
import {RemoteDisk} from '../build/disk/remote.mjs';

const root = resolve(import.meta.dirname, '..');
process.chdir(root);
const helper = resolve('scripts/read-only-key.mjs');
const credentials = {username:'disk fixtures', password:'public compatibility password', machine:'main'};
const out = resolve('build/read-only-cli'); await mkdir(out, {recursive:true});
const passed = [];
function ok(name) { passed.push(name); console.log('PASS ' + name); }
function launch(args, input, command = process.execPath) {
    const child = spawn(command, args, {stdio:['pipe','pipe','pipe']});
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk=>stdout += chunk);
    child.stderr.on('data', chunk=>stderr += chunk);
    const done = new Promise((resolve, reject)=>{
        child.on('error', reject);
        child.on('close', (code, signal)=>resolve({code, signal, stdout, stderr}));
    });
    if(input !== undefined) child.stdin.end(input);
    return {child, done};
}
function run(fields) { return launch([helper], JSON.stringify(fields)).done; }
function failed(result, name) {
    assert.notEqual(result.code, 0, name);
    assert.equal(result.stdout, '', name + ': no partial output');
    assert(!result.stderr.includes(credentials.password), name + ': password redacted');
    assert(!result.stderr.includes('my98-ro-v1.'), name + ': key redacted');
    ok(name);
}
await init({module_or_path:await readFile('build/disk/pkg/slop86_disk_bg.wasm')});
const f = await fixture();
const login = {...credentials, gateway:f.endpoint};
let corruptionServer;
try {
    f.setMode('v1');
    const result = await run(login);
    assert.equal(result.code, 0, result.stderr);
    const exported = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(exported).sort(), ['cid','readKey']);
    assert.equal(exported.cid, f.cid1);
    assert.match(exported.readKey, /^my98-ro-v1\.[A-Za-z0-9_-]{64}$/);
    assert.equal(result.stdout.split('\n').length, 2);
    assert(!result.stderr.includes(exported.readKey));
    assert(f.requests.filter(r=>r.path.startsWith('/ipfs/')).length <= 3, 'only header/first block path fetched');
    ok('verified IPNS, pinned CID, JSON-only stdout and bounded fetches');
    // Exercise the CLI's default path in a fresh process. Only its test transport
    // maps the configured public services and discovered provider to the fixture.
    const transport=join(out,'discovery-transport.mjs'),calls=join(out,'discovery-calls.jsonl');
    await writeFile(calls,'');
    const peerId=CID.createV1(0x72,CID.parse(f.cid1).multihash).toString();
    await writeFile(transport,`
import {appendFileSync} from 'node:fs';
const original=globalThis.fetch.bind(globalThis);
globalThis.fetch=(value,options)=>{
    const u=new URL(value);appendFileSync(${JSON.stringify(calls)},JSON.stringify(u.href)+'\\n');
    if(['piensa.jlxip.net','delegated-ipfs.dev'].includes(u.hostname) && u.pathname.startsWith('/routing/v1/providers/'))return Promise.resolve(new Response(JSON.stringify({Providers:[{Schema:'peer',ID:${JSON.stringify(peerId)},Addrs:['/dns4/cli-provider.example.com/tcp/443/tls/http']}]}),{headers:{'Content-Type':'application/json'}}));
    if(u.hostname==='cli-provider.example.com')return original(${JSON.stringify(f.endpoint)}+u.pathname+u.search,options);
    if(['piensa.jlxip.net','ipfs.filebase.io','ipfs.orbitor.dev','delegated-ipfs.dev'].includes(u.hostname))return original(${JSON.stringify(f.endpoint)}+u.pathname.replace('/routing/v1/ipns/','/ipns/')+u.search,options);
    throw Error('Unexpected external endpoint in CLI test');
};
`);
    const automatic=await launch(['--import',transport,helper],JSON.stringify(credentials)).done;
    assert.equal(automatic.code,0,automatic.stderr);assert.deepEqual(JSON.parse(automatic.stdout),exported);
    const automaticCalls=(await readFile(calls,'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(automaticCalls.filter(url=>url.includes('/ipns/')).length,4);
    assert.equal(automaticCalls.filter(url=>url.includes('/providers/')).length,2);
    assert(automaticCalls.filter(url=>url.includes('/ipfs/')).every(url=>url.startsWith('https://cli-provider.example.com/')));
    ok('CLI without gateway resolves all services, discovers HTTPS provider and exports the same capability');
    const remote = new RemoteDisk({gateway:f.endpoint, prefetch:{enabled:false}});
    const key = Buffer.from(exported.readKey.slice(11), 'base64url');
    let vault;
    const before = f.requests.length;
    globalThis.slopDiskCancelled = ()=>false;
    globalThis.slopDiskRead = (_source, offset, length)=>remote.read(offset, length);
    try {
        await remote.openCid(exported.cid);
        vault = await Vault.open_read_only('remote', remote.size, key);
        const bytes = await vault.read(0, f.small.size);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), f.small.sha256);
        bytes.fill(0);
        assert(f.requests.slice(before).every(r=>!r.path.startsWith('/ipns/')));
        ok('fresh read-only open by CID and exact full content without IPNS');
    } finally {key.fill(0); vault?.free(); remote.close();}
    for(const mode of ['missing','wrong','expired','corrupt','truncated']) {
        f.setMode(mode); failed(await run(login), mode);
    }
    f.setMode('v1');
    failed(await run({...login, password:'incorrect-password'}), 'incorrect credentials');
    failed(await run({...login, gateway:'http://127.0.0.1:1'}), 'network failure');
    failed(await run({...login, gateway:'http://example.com'}), 'invalid gateway');
    for(const fields of [{}, {...login, password:''}, {...login, password:'x'.repeat(65537)}]) {
        const before = f.requests.length;
        failed(await run(fields), 'invalid input');
        assert.equal(f.requests.length, before);
    }
    // Valid CID and IPNS around damaged ciphertext must still fail AEAD authentication.
    const original = await readFile(f.small.file);
    const damaged = Buffer.from(original); damaged[260] ^= 1;
    const badHeader = Buffer.from(original); badHeader[0] ^= 1;
    const compat = resolve('build/disk-target/release/examples/compat');
    const signer = {type:'Ed25519', sign:async bytes=>new Uint8Array(Buffer.from(execFileSync(compat, ['sign', Buffer.from(bytes).toString('hex')], {encoding:'utf8'}).trim(), 'hex'))};
    let block, record, blockCid;
    corruptionServer = createServer((req,res)=>{
        if(req.url.startsWith('/ipns/')) res.writeHead(200, {'Content-Type':'application/vnd.ipfs.ipns-record'}).end(record);
        else if(req.url.startsWith('/ipfs/' + blockCid)) res.writeHead(200, {'Content-Type':'application/vnd.ipld.raw'}).end(block);
        else res.writeHead(404).end();
    });
    await new Promise(r=>corruptionServer.listen(0,'127.0.0.1',r));
    for(const [name, data] of [['raw CID control', original], ['authenticated first block', damaged], ['authenticated header', badHeader]]) {
        block = data; blockCid = CID.createV1(0x55, await sha256.digest(block)).toString();
        record = marshalIPNSRecord(await createIPNSRecord(signer, '/ipfs/' + blockCid, 1n, 3600000, {v1Compatible:false}));
        const result = await run({...login, gateway:'http://127.0.0.1:' + corruptionServer.address().port});
        if(name === 'raw CID control') { assert.equal(result.code, 0, result.stderr); ok(name); }
        else failed(result, name);
    }
    const temp = await mkdtemp(join(tmpdir(), 'my98-cli-'));
    try {
        await mkdir(join(temp, 'scripts'));
        for(const name of ['read-only-key.mjs','read-only-key.py']) await copyFile(resolve('scripts',name), join(temp,'scripts',name));
        const absent = await launch([join(temp,'scripts/read-only-key.mjs'),'--check'], '').done;
        failed(absent, 'missing artifacts (helper)'); assert(absent.stderr.includes('make disk'));
        const absentPython = await launch([join(temp,'scripts/read-only-key.py')], '', 'python3').done;
        failed(absentPython, 'missing artifacts before prompts'); assert(absentPython.stderr.includes('make disk'));
    } finally {await rm(temp,{recursive:true,force:true});}
    for(const mode of ['success','wrong','cancel']) {
        f.setMode(mode === 'cancel' ? 'hang' : 'v1');
        const result = await launch(['scripts/read-only-key-test.py', f.endpoint, mode], '', 'python3').done;
        assert.equal(result.code,0,result.stderr); ok('PTY ' + mode + ' (hidden password, output separation, exit status)');
    }
    f.setMode('hang');
    const beforeCancel = f.requests.length;
    const opening = launch([helper], JSON.stringify(login));
    const until = Date.now() + 10000;
    while(f.requests.length === beforeCancel && Date.now() < until) await new Promise(r=>setTimeout(r,20));
    opening.child.kill('SIGINT');
    const interrupted = await opening.done;
    assert(f.requests.length > beforeCancel, 'cancellation happened during a gateway request');
    assert.equal(interrupted.code, 130); failed(interrupted, 'cancel during network opening');
    const idle = launch([helper]);
    setTimeout(()=>idle.child.kill('SIGTERM'), 500);
    const cancelled = await idle.done;
    assert.equal(cancelled.code,130); failed(cancelled,'cancel while awaiting stdin');
    f.setMode('v1'); assert.equal((await run(login)).code,0); ok('successful retry after cancellation and errors');
    await writeFile(join(out,'results.json'),JSON.stringify({passed, count:passed.length},null,2)+'\n');
    console.log(passed.length + ' CLI checks passed');
} finally {
    if(corruptionServer) {corruptionServer.closeAllConnections();await new Promise(r=>corruptionServer.close(r));}
    await f.close();
    delete globalThis.slopDiskRead; delete globalThis.slopDiskCancelled;
}
