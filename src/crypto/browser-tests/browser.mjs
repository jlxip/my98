import { Slop86Crypto, unitId } from "/build/crypto/web/client.js";
const bytes = hex => Uint8Array.from(hex.match(/../g) || [], pair => parseInt(pair, 16));
const hex = bytes => Array.from(bytes, x => x.toString(16).padStart(2, "0")).join("");
const text = value => new TextEncoder().encode(value);
export async function runCryptoTests(fixture) {
    const results = [];
    const check = (name, condition) => { if(!condition) throw new Error(name); results.push(name); };
    const rejects = async (name, call) => {
        let failed = false;
        try { await call(); } catch { failed = true; }
        check(name, failed);
    };
    const client = await Slop86Crypto.create();
    try {
        let ticks = 0;
        const timer = setInterval(() => ticks++, 5);
        const start = performance.now();
        const identity = await client.deriveIdentity(fixture.username, fixture.password, "main");
        const deriveMs = performance.now() - start;
        clearInterval(timer);
        check("derivation runs outside UI thread", ticks > 2);
        check("native/browser stable IPNS identity", identity.ipnsName === fixture.ipns);
        check("native/browser public key", hex(identity.publicKey) === fixture.publicKey);
        check("native signature verifies", await client.verify(identity.publicKey, text("native signed"), bytes(fixture.signature)));
        check("altered signature message rejected", !await client.verify(identity.publicKey, text("changed"), bytes(fixture.signature)));
        const normalized = await client.deriveIdentity("café", fixture.password, "main");
        check("Unicode NFC identity", normalized.ipnsName === identity.ipnsName);
        await client.closeIdentity(normalized.handle);
        const wrong = await client.deriveIdentity(fixture.username, fixture.password.trim(), "main");
        check("password whitespace preserved", wrong.ipnsName !== identity.ipnsName);
        await rejects("wrong credentials cannot open descriptor", () => client.openDisk(wrong.handle, bytes(fixture.descriptor)));
        await client.closeIdentity(wrong.handle);
        const otherMachine = await client.deriveIdentity(fixture.username, fixture.password, "Main");
        check("Machine is case-sensitive", otherMachine.ipnsName !== identity.ipnsName);
        await rejects("other Machine cannot decrypt descriptor", () => client.openDisk(otherMachine.handle, bytes(fixture.descriptor)));
        await client.closeIdentity(otherMachine.handle);
        await rejects("empty Machine rejected", () => client.deriveIdentity(fixture.username, fixture.password, ""));
        const m1 = await client.deriveIdentity("u", "p", "máquina");
        const m2 = await client.deriveIdentity("u", "p", "ma\u0301quina");
        check("Machine Unicode NFC", m1.ipnsName === m2.ipnsName);
        await client.closeIdentity(m1.handle);await client.closeIdentity(m2.handle);
        const disk = await client.openDisk(identity.handle, bytes(fixture.descriptor));
        check("native bytes incl zero/slack/partial tail restored", hex(await client.openUnit(disk.handle, 0n, bytes(fixture.unit))) === fixture.plain);
        check("native object CID interoperable", await client.cid(bytes(fixture.unit)) === fixture.cid);
        check("native encrypted metadata opens", new TextDecoder().decode(await client.openMetadata(disk.handle, bytes(fixture.metadata))) === "native metadata");
        await rejects("unit substitution rejected", () => client.openUnit(disk.handle, 1n, bytes(fixture.unit)));
        await rejects("kind substitution rejected", () => client.openMetadata(disk.handle, bytes(fixture.unit)));
        for(const offset of [0, 4, 5, 6, 38, 46, bytes(fixture.unit).length - 1]) {
            const damaged = bytes(fixture.unit); damaged[offset] ^= 1;
            await rejects("altered envelope byte " + offset, () => client.openUnit(disk.handle, 0n, damaged));
        }
        await rejects("truncated envelope rejected", () => client.openUnit(disk.handle, 0n, bytes(fixture.unit).slice(0, -1)));
        await rejects("unknown version rejected", () => client.openDisk(identity.handle, Uint8Array.of(1, 2, 3)));
        const newDisk = await client.createDisk(identity.handle);
        check("disk creation is explicit and isolated", hex(newDisk.diskId) !== hex(disk.diskId));
        await rejects("disk substitution rejected", () => client.openUnit(newDisk.handle, 0n, bytes(fixture.unit)));
        const plain = bytes(fixture.plain);
        const first = await client.sealUnit(newDisk.handle, 0n, plain);
        const second = await client.sealUnit(newDisk.handle, 0n, plain);
        check("rewrites use new use salt", hex(first.bytes.slice(6, 38)) !== hex(second.bytes.slice(6, 38)));
        check("same plaintext rewrite changes ciphertext CID", first.cid !== second.cid);
        check("input is not detached or modified", hex(plain) === fixture.plain);
        check("transfer retry keeps immutable ciphertext CID", await client.cid(first.bytes) === first.cid);
        check("browser exact roundtrip", hex(await client.openUnit(newDisk.handle, 0n, first.bytes)) === fixture.plain);
        const part0 = await client.sealUnit(newDisk.handle, 10n, plain.slice(0, 512));
        const part1 = await client.sealUnit(newDisk.handle, 11n, plain.slice(512, 1024));
        const rewritten1 = await client.sealUnit(newDisk.handle, 11n, plain.slice(512, 1024));
        check("independent units retain their ciphertext CID", await client.cid(part0.bytes) === part0.cid && rewritten1.cid !== part1.cid);
        const empty = await client.sealUnit(newDisk.handle, (1n << 96n) - 1n, new Uint8Array());
        check("full 96-bit unit and empty content", (await client.openUnit(newDisk.handle, (1n << 96n) - 1n, empty.bytes)).length === 0);
        for(const invalid of [-1n, 1n << 96n, 1, "1"]) await rejects("invalid unit ID " + String(invalid), () => unitId(invalid));
        const metadata = await client.sealMetadata(newDisk.handle, text("browser metadata"));
        const signature = await client.sign(identity.handle, text("browser signed"));
        const output = { ipns: identity.ipnsName, descriptor: hex(newDisk.descriptor), unit: hex(first.bytes),
            plain: fixture.plain, metadata: hex(metadata.bytes), signature: hex(signature) };
        await client.closeDisk(disk.handle);
        await rejects("closed disk inaccessible", () => client.openUnit(disk.handle, 0n, bytes(fixture.unit)));
        await client.closeIdentity(identity.handle);
        await rejects("closed identity cannot sign", () => client.sign(identity.handle, text("x")));
        await rejects("identity close also closes its disks", () => client.openUnit(newDisk.handle, 0n, first.bytes));
        const reopened = await client.deriveIdentity(fixture.username, fixture.password, "main");
        const recovered = await client.openDisk(reopened.handle, newDisk.descriptor);
        check("reopen using credentials and descriptor only", hex(await client.openUnit(recovered.handle, 0n, first.bytes)) === fixture.plain);
        check("no automatic browser persistence", localStorage.length === 0 && sessionStorage.length === 0 && (await indexedDB.databases()).length === 0);
        await client.close();
        await rejects("closed client rejects operations", () => client.cid(first.bytes));
        const noRng = await Slop86Crypto.create({ workerUrl: new URL("/rng-disabled-worker.js", location.href) });
        try {
            const id = await noRng.deriveIdentity(fixture.username, fixture.password, "main");
            await rejects("CSPRNG failure does not fall back", () => noRng.createDisk(id.handle));
        } finally { await noRng.close(); }
        await rejects("Worker initialization failure rejects", () => Slop86Crypto.create({ workerUrl: new URL("/missing-worker.js", location.href) }));
        const canceled = await Slop86Crypto.create();
        const pending = canceled.deriveIdentity(fixture.username, fixture.password, "main");
        canceled.terminate();
        await rejects("termination rejects pending request", () => pending);
        return { results, deriveMs, output };
    } finally { await client.close(); }
}
window.runCryptoTests = runCryptoTests;
