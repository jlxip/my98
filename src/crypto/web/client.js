/** Worker-backed crypto primitives. Handles are local to this client, never keys. */
export class Slop86Crypto {
    #worker;
    #pending = new Map();
    #sequence = 0;
    #closed = false;
    #ready;
    #resolveReady;
    #rejectReady;

    static async create({ workerUrl = new URL("./worker.js", import.meta.url) } = {}) {
        const client = new Slop86Crypto(workerUrl);
        await client.#ready;
        return client;
    }
    constructor(workerUrl) {
        this.#ready = new Promise((resolve, reject) => {
            this.#resolveReady = resolve;
            this.#rejectReady = reject;
        });
        this.#worker = new Worker(workerUrl, { type: "module", name: "slop86-crypto" });
        const timer = setTimeout(() => this.#fail(new Error("Crypto Worker initialization timed out")), 30000);
        this.#ready.then(() => clearTimeout(timer), () => clearTimeout(timer));
        this.#worker.onmessage = ({ data }) => {
            if(data.type === "ready") { this.#resolveReady(); return; }
            if(data.type === "fatal") { this.#fail(new Error(data.error)); return; }
            const pending = this.#pending.get(data.id);
            if(!pending) return;
            this.#pending.delete(data.id);
            if(data.ok) pending.resolve(data.result);
            else pending.reject(new Error(data.error));
        };
        this.#worker.onerror = event => {
            event.preventDefault();
            this.#fail(new Error("Crypto Worker failed"));
        };
        this.#worker.onmessageerror = () => this.#fail(new Error("Crypto Worker message failed"));
    }
    #fail(error) {
        this.#closed = true;
        this.#rejectReady(error);
        for(const request of this.#pending.values()) request.reject(error);
        this.#pending.clear();
        this.#worker.terminate();
    }
    async #request(op, args = {}) {
        try {
            await this.#ready;
            if(this.#closed) throw new Error("Crypto client is closed");
        } catch(error) {
            for(const value of Object.values(args)) if(value instanceof Uint8Array && value.byteLength) value.fill(0);
            throw error;
        }
        const id = ++this.#sequence;
        return new Promise((resolve, reject) => {
            this.#pending.set(id, { resolve, reject });
            try {
                const transfer = Object.values(args).filter(x => x instanceof Uint8Array).map(x => x.buffer);
                this.#worker.postMessage({ id, op, args }, transfer);
            } catch(error) {
                this.#pending.delete(id);
                for(const value of Object.values(args)) if(value instanceof Uint8Array && value.byteLength) value.fill(0);
                reject(error);
            }
        });
    }
    /** Derives credentials only. Does not look up, create or overwrite stored data. */
    deriveIdentity(username, password, machine) {
        if(typeof username !== "string" || typeof password !== "string" || typeof machine !== "string") return Promise.reject(new TypeError("Credentials must be strings"));
        return this.#request("derive", { username, machine, password: new TextEncoder().encode(password) });
    }
    createDisk(identity) { return this.#request("createDisk", { identity }); }
    openDisk(identity, descriptor) { return this.#request("openDisk", { identity, descriptor: copy(descriptor) }); }
    sealUnit(disk, unit, bytes) { return this.#request("sealUnit", { disk, unit: unitId(unit), bytes: copy(bytes) }); }
    openUnit(disk, unit, envelope) { return this.#request("openUnit", { disk, unit: unitId(unit), envelope: copy(envelope) }); }
    sealMetadata(disk, bytes) { return this.#request("sealMetadata", { disk, bytes: copy(bytes) }); }
    openMetadata(disk, envelope) { return this.#request("openMetadata", { disk, envelope: copy(envelope) }); }
    sign(identity, message) { return this.#request("sign", { identity, message: copy(message) }); }
    verify(publicKey, message, signature) { return this.#request("verify", { publicKey: copy(publicKey), message: copy(message), signature: copy(signature) }); }
    cid(bytes) { return this.#request("cid", { bytes: copy(bytes) }); }
    closeDisk(disk) { return this.#request("closeDisk", { disk }); }
    closeIdentity(identity) { return this.#request("closeIdentity", { identity }); }
    async close() {
        if(this.#closed) return;
        try { await this.#request("shutdown"); }
        finally { this.#fail(new Error("Crypto client is closed")); }
    }
    /** Emergency cancellation, including a pending expensive derivation. */
    terminate() { this.#fail(new Error("Crypto client was terminated")); }
}
function copy(bytes) {
    if(!(bytes instanceof Uint8Array)) throw new TypeError("Expected Uint8Array");
    if(bytes.byteLength > 16 * 1024 * 1024 + 62) throw new RangeError("Transfer exceeds maximum envelope size");
    return new Uint8Array(bytes);
}
/** Avoid JS number rounding: unit IDs are BigInt in [0, 2^96). */
export function unitId(value) {
    if(typeof value !== "bigint" || value < 0n || value >= 1n << 96n) throw new RangeError("Unit ID must be an unsigned 96-bit BigInt");
    const bytes = new Uint8Array(12);
    for(let i = 0; i < bytes.length; i++) { bytes[i] = Number(value & 255n); value >>= 8n; }
    return bytes;
}
