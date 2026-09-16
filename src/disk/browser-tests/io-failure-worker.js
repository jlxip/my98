await import('/build/disk/web/worker.js');
const read=globalThis.slopDiskRead;let fail=true;
globalThis.slopDiskRead=async(id,offset,len)=>{if(fail&&offset>=198){fail=false;throw new Error("Injected transient source failure");}return read(id,offset,len);};
