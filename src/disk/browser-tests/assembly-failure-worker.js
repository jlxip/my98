const NativeBlob=Blob;let count=0;
globalThis.Blob=class extends NativeBlob {constructor(parts,options){if(parts.length>1&&++count===2)throw new Error("Injected Blob assembly failure");super(parts,options);}};
await import('/build/disk/web/worker.js');
