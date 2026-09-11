import init, { derive_identity, verify, object_cid } from "../pkg/slop86_crypto.js";

const identities = new Map();
const disks = new Map();
let nextHandle = 0;
let queue = Promise.resolve();
let stopped = false;
const loaded = init().then(() => self.postMessage({ type: "ready" })).catch(() => {
    self.postMessage({ type: "fatal", error: "Could not initialize crypto WASM" });
    stopped = true;
});
function identity(handle) {
    const value = identities.get(handle);
    if(!value) throw new Error("Unknown or closed identity");
    return value;
}
function disk(handle) {
    const value = disks.get(handle);
    if(!value) throw new Error("Unknown or closed disk");
    return value.disk;
}
function dropDisk(handle) {
    const value = disks.get(handle);
    if(value) { value.disk.close(); value.disk.free(); disks.delete(handle); }
}
function dropIdentity(handle) {
    for(const [id, value] of disks) if(value.owner === handle) dropDisk(id);
    const value = identities.get(handle);
    if(value) { value.close(); value.free(); identities.delete(handle); }
}
function addDisk(value, owner, descriptor) {
    const handle = ++nextHandle;
    disks.set(handle, { disk: value, owner });
    return { handle, diskId: value.id(), descriptor, cid: object_cid(descriptor) };
}
function encrypted(bytes) { return { bytes, cid: object_cid(bytes) }; }
function execute(op, a) {
    switch(op) {
    case "derive": {
        const value = derive_identity(a.username, a.password, a.machine);
        const handle = ++nextHandle;
        identities.set(handle, value);
        return { handle, ipnsName: value.ipns_name(), publicKey: value.public_key() };
    }
    case "createDisk": {
        const owner = identity(a.identity);
        const value = owner.create_disk();
        try { return addDisk(value, a.identity, owner.seal_descriptor(value)); }
        catch(error) { value.close(); value.free(); throw error; }
    }
    case "openDisk": return addDisk(identity(a.identity).open_disk(a.descriptor), a.identity, a.descriptor.slice());
    case "sealUnit": return encrypted(disk(a.disk).seal_unit(a.unit, a.bytes));
    case "openUnit": return disk(a.disk).open_unit(a.unit, a.envelope);
    case "sealMetadata": return encrypted(disk(a.disk).seal_metadata(a.bytes));
    case "openMetadata": return disk(a.disk).open_metadata(a.envelope);
    case "sign": return identity(a.identity).sign(a.message);
    case "verify": return verify(a.publicKey, a.message, a.signature);
    case "cid": return object_cid(a.bytes);
    case "closeDisk": disk(a.disk); dropDisk(a.disk); return null;
    case "closeIdentity": identity(a.identity); dropIdentity(a.identity); return null;
    case "shutdown": for(const handle of identities.keys()) dropIdentity(handle); stopped = true; return null;
    default: throw new Error("Unknown crypto operation");
    }
}
function buffers(result) {
    if(result instanceof Uint8Array) return [result.buffer];
    if(result && typeof result === "object") return Object.values(result).filter(x => x instanceof Uint8Array).map(x => x.buffer);
    return [];
}
self.onmessage = ({ data }) => {
    queue = queue.then(async () => {
        await loaded;
        const { id, op, args } = data;
        try {
            if(stopped) throw new Error("Crypto Worker is closed");
            const result = execute(op, args);
            self.postMessage({ id, ok: true, result }, buffers(result));
        } catch(error) {
            self.postMessage({ id, ok: false, error: typeof error === "string" ? error : error.message || "Crypto operation failed" });
        } finally {
            for(const value of Object.values(args || {})) if(value instanceof Uint8Array && value.byteLength) value.fill(0);
        }
    }).catch(() => {
        for(const handle of identities.keys()) dropIdentity(handle);
        stopped = true;
        self.postMessage({ type: "fatal", error: "Crypto Worker failed" });
    });
};
