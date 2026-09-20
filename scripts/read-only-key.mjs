// Private helper for read-only-key.py. Credentials arrive only through stdin.
import {readFile} from 'node:fs/promises';

const fail = (code, message) => Object.assign(new Error(message), {code});
const controller = new AbortController();
let timedOut = false;
const cancel = () => { controller.abort(); process.stdin.destroy(); };
process.on('SIGINT', cancel);
process.on('SIGTERM', cancel);
const deadline = setTimeout(() => { timedOut = true; cancel(); }, 120000);
const check = () => { if(controller.signal.aborted) throw fail('CANCELLED'); };

async function load() {
    if(Number(process.versions.node.split('.')[0]) < 24) throw fail('BUILD_REQUIRED');
    try {
        const [{default:init, Vault}, {RemoteDisk}] = await Promise.all([
            import('../build/disk/pkg/slop86_disk.js'),
            import('../build/disk/remote.mjs'),
        ]);
        await init({module_or_path:await readFile(new URL('../build/disk/pkg/slop86_disk_bg.wasm', import.meta.url))});
        if(typeof Vault.prototype.export_read_key !== 'function') throw fail('BUILD_REQUIRED');
        return {Vault, RemoteDisk};
    } catch { throw fail('BUILD_REQUIRED'); }
}

async function input() {
    const parts = []; let total = 0, raw;
    try {
        for await(const part of process.stdin) {
            parts.push(part); total += part.length;
            if(total > 65536) throw fail('INVALID_INPUT');
            check();
        }
        check(); raw = Buffer.concat(parts);
        const fields = JSON.parse(raw.toString('utf8'));
        if(!fields || ['username', 'password', 'machine'].some(k=>typeof fields[k] !== 'string' || !fields[k] || Buffer.byteLength(fields[k], 'utf8') > 4096)) throw fail('INVALID_INPUT');
        if(fields.gateway != null && typeof fields.gateway !== 'string') throw fail('INVALID_INPUT');
        return fields;
    } catch(error) {
        check();
        throw fail('INVALID_INPUT');
    } finally { raw?.fill(0); for(const part of parts) part.fill(0); }
}

async function extract({Vault, RemoteDisk}, credentials) {
    let vault, remote, key, first;
    const password = new TextEncoder().encode(credentials.password);
    credentials.password = undefined;
    globalThis.slopDiskCancelled = () => controller.signal.aborted;
    globalThis.slopDiskRead = async (source, offset, length) => {
        check();
        if(source !== 'remote' || !remote) throw fail('IO_ERROR');
        return remote.read(offset, length, controller.signal);
    };
    try {
        check();
        try { remote = new RemoteDisk({gateway:credentials.gateway ?? undefined, servers:credentials.gateway == null ? undefined : [{url:credentials.gateway,resolution:'gateway',discovery:false}], prefetch:{enabled:false}}); }
        catch { throw fail('INVALID_GATEWAY'); }
        process.stderr.write('Unlocking identity…\n');
        try { vault = new Vault(credentials.username, password, credentials.machine); }
        finally { password.fill(0); }
        credentials.username = credentials.machine = undefined;
        check();
        process.stderr.write('Finding and verifying the published disk…\n');
        await remote.open(JSON.parse(vault.identity()), controller.signal);
        check(); await vault.open('remote', remote.size);
        const state = JSON.parse(vault.describe());
        first = await vault.read(0, Math.min(state.size, 512));
        check(); key = vault.export_read_key();
        const readKey = 'my98-ro-v1.' + Buffer.from(key.buffer, key.byteOffset, key.byteLength).toString('base64url');
        return {cid:remote.remote.cid, readKey};
    } finally {
        password.fill(0); key?.fill(0); first?.fill(0);
        remote?.close(); vault?.free();
        delete globalThis.slopDiskRead; delete globalThis.slopDiskCancelled;
    }
}

const messages = {
    BUILD_REQUIRED:'Disk tools are unavailable or outdated. Use Node.js 24 or later and run make disk in the repository.',
    INVALID_INPUT:'Invalid login input.',
    INVALID_GATEWAY:'Use an HTTPS gateway, or HTTP on localhost.',
    AUTHENTICATION_FAILED:'Credentials are incorrect or the disk descriptor is damaged.',
    CORRUPTION:'The published reference or disk data failed verification.',
    UNSUPPORTED_FORMAT:'The published disk uses an unsupported format.',
    IO_ERROR:'Cannot find a usable provider or read the published disk. Check its HTTPS availability, or specify a gateway.',
    CANCELLED:'Cancelled.',
};
process.stdout.on('error', () => { process.exitCode = 1; });
try {
    if(process.argv.length > 3 || process.argv[2] && process.argv[2] !== '--check') throw fail('INVALID_INPUT');
    const modules = await load(); check();
    if(process.argv[2] !== '--check') {
        const credentials = await input();
        const result = await extract(modules, credentials); check();
        process.stdout.write(JSON.stringify(result) + '\n');
    }
} catch(error) {
    let code = error?.code;
    if(typeof error === 'string') { try { code = JSON.parse(error).code; } catch {} }
    if(controller.signal.aborted) code = 'CANCELLED';
    process.stderr.write((timedOut ? 'Export timed out; check the gateway and retry.' : messages[code] || 'Disk export failed.') + '\n');
    process.exitCode = code === 'CANCELLED' && !timedOut ? 130 : 1;
} finally {
    clearTimeout(deadline); process.stdin.destroy();
    process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
}
