export class Slop86Disk {
    static async create({ workerUrl = new URL("./worker.js", import.meta.url), onProgress, onAnalysis } = {}) {
        const client = new Slop86Disk(workerUrl, onProgress, onAnalysis);
        try { await client.ready; return client; }
        catch(error) { client.terminate(); throw error; }
    }
    constructor(url, onProgress, onAnalysis) {
        this.worker = new Worker(url, { type: "module" });
        this.pending = new Map(); this.next = 0; this.closed = false; this.cancelEpoch = 0;
        if(globalThis.crossOriginIsolated && typeof SharedArrayBuffer !== "undefined") {
            this.cancelView = new Int32Array(new SharedArrayBuffer(4));
            this.worker.postMessage({ op: "configure", buffer: this.cancelView.buffer });
        }
        this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
        this.timer = setTimeout(() => this.fail(new Error("Disk Worker timed out")), 30000);
        this.worker.onmessage = ({data}) => {
            if(data.type === "ready") { clearTimeout(this.timer); this.readyResolve(); return; }
            if(data.type === "progress") { onProgress?.(data); return; }
            if(data.type === "analysis") { onAnalysis?.(data); return; }
            if(data.type === "fatal") { this.fail(new Error(data.error)); return; }
            const item = this.pending.get(data.id);
            if(item) { this.pending.delete(data.id); data.ok ? item.resolve(data.result) : item.reject(Object.assign(new Error(data.error.message || data.error), data.error)); }
        };
        this.worker.onerror = event => { event.preventDefault(); this.fail(new Error("Disk Worker could not run")); };
        this.worker.onmessageerror = () => this.fail(new Error("Invalid Worker response"));
    }
    fail(error) {
        clearTimeout(this.timer); this.readyReject(error);
        for(const pending of this.pending.values()) pending.reject(error);
        this.pending.clear(); this.closed = true; this.worker.terminate();
    }
    async call(op, args = {}, transfer = []) {
        const epoch = this.cancelEpoch;
        await this.ready;
        if(this.closed) throw new Error("Disk is closed");
        const id = ++this.next;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            try { this.worker.postMessage({ id, op, args, epoch }, transfer); }
            catch(error) { this.pending.delete(id); reject(error); }
        });
    }
    unlock(username, password, machine) {
        if([username,password,machine].some(v=>typeof v !== "string")) return Promise.reject(new TypeError("Credentials must be strings"));
        const bytes = new TextEncoder().encode(password);
        return this.call("unlock", {username,password:bytes,machine}, [bytes.buffer]);
    }
    createFromImage(file) {return this.call("create", {file});}
    open(file) {return this.call("open", {file});}
    openRemote({gateway, prefetch} = {}) {return this.call("openRemote", {gateway,prefetch});}
    describe() {return this.call("describe");}
    read(offset,length) {return this.call("read", {offset,length});}
    write(offset,data) {const bytes=new Uint8Array(data).slice();return this.call("write", {offset,bytes}, [bytes.buffer]);}
    save() {return this.call("save");}
    downloadCurrent() {return this.call("download");}
    retryDownload() {return this.call("retry");}
    verifyImage() {return this.call("verify");}
    discardWrites() {return this.call("discard");}
    readStats() {return this.call("readStats");}
    readTrace() {return this.call("readTrace");}
    startBootAnalysis() {return this.call("startBootAnalysis");}
    finishBootAnalysis() {return this.call("finishBootAnalysis");}
    cancelBootAnalysis() {return this.call("cancelBootAnalysis");}
    resumePrefetch() {return this.call("resumePrefetch");}
    clearCaches() {return this.call("clearCaches");}
    cancel() {
        this.cancelEpoch = (this.cancelEpoch + 1) | 0;
        if(this.cancelView) Atomics.store(this.cancelView, 0, this.cancelEpoch);
        this.worker.postMessage({ op: "cancel", epoch: this.cancelEpoch });
    }
    async close() {
        if(!this.closed) { try { await this.call("close"); } finally { this.terminate(); } }
    }
    terminate() { this.fail(new Error("Disk Worker closed")); }
}

/** v86's async buffer contract; failed reads never complete with fabricated data. */
export class DiskBuffer {
    constructor(client, size, onError) {
        this.client = client; this.byteLength = size;
        this.onError = onError; this.failed = false;
    }
    load() { this.onload?.({ buffer: this }); }
    get_from_cache(offset, length) {
        if(this.bootSector && offset >= 0 && offset + length <= this.bootSector.length) return this.bootSector.slice(offset, offset + length);
        return undefined;
    }
    get_and_cache(offset, length, callback) {
        this.get(offset, length, bytes => {
            // v86 derives its BIOS/CHS geometry from this preloaded MBR.
            if(offset === 0 && length === 512) this.bootSector = bytes.slice();
            callback(bytes);
        });
    }
    get(offset, length, callback) { this.enqueue({ offset, length, callback }); }
    set(offset, bytes, callback) {
        if(offset < 512) { this.bootSector?.fill(0); this.bootSector = undefined; }
        this.enqueue({ offset, bytes: new Uint8Array(bytes).slice(), callback });
    }
    enqueue(request) {
        if(this.disposed) return;
        this.queue ||= []; this.queue.push(request);
        void this.pump();
    }
    async pump() {
        if(this.pumping || this.failed || this.disposed) return;
        this.pumping = true;
        try {
            while(this.queue?.length && !this.failed && !this.disposed) {
                const request = this.queue[0];
                let result;
                try {
                    result = request.bytes ? await this.client.write(request.offset, request.bytes) : await this.client.read(request.offset, request.length);
                } catch(error) {
                    this.failed = true; this.error = error;
                    await this.onError?.(error);
                    break;
                }
                if(this.disposed) break;
                this.queue.shift(); request.bytes?.fill(0);
                request.callback(result);
            }
        } finally { this.pumping = false; }
    }
    async retry() {
        if(this.pumping) throw new Error("Disk is still stopping");
        if(this.disposed) throw new Error("Disk adapter is closed");
        this.failed = false; this.error = undefined;
        await this.client.resumePrefetch?.();
        await this.pump();
        if(this.failed) throw this.error;
    }
    fail(error) { if(!this.failed) { this.failed = true; this.error = error; void this.onError?.(error); } }
    dispose() { this.disposed = true; for(const r of this.queue || []) r.bytes?.fill(0); this.queue = []; this.bootSector?.fill(0); this.bootSector = undefined; }
    get_state() { throw new Error("Encrypted disks boot from disk; RAM snapshots are unavailable"); }
    set_state() { throw new Error("RAM snapshots cannot replace encrypted disks"); }
}
