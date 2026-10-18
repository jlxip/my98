const fail=(code,message)=>Object.assign(new Error(message),{code});
const errorValue=error=>({code:typeof error?.code==="string"?error.code:
    error?.name==="AbortError"?"CANCELLED":"TRANSPORT_ERROR",message:String(error?.message||error)});

/** Worker-side ciphertext/control RPC. Replies bypass the serialized Vault queue. */
export class TorrentPort {
    constructor(port,onProgress=()=>{}) {
        this.port=port;this.pending=new Map();this.next=0;this.closed=false;
        port.onmessage=({data})=>{
            if(data.type==="progress"){onProgress(data.session,data.value);return;}
            const pending=this.pending.get(data.id);if(!pending)return;
            this.pending.delete(data.id);pending.cleanup();
            data.ok?pending.resolve(data.result):pending.reject(Object.assign(new Error(data.error.message),data.error));
        };
        port.onmessageerror=()=>this.close(fail("TRANSPORT_ERROR","Invalid ciphertext bridge response"));
        port.start();
    }
    call(op,args={},signal) {
        if(this.closed)return Promise.reject(fail("TRANSPORT_ERROR","Ciphertext bridge is closed"));
        if(signal?.aborted)return Promise.reject(signal.reason||fail("CANCELLED","Torrent operation cancelled"));
        const id=++this.next;
        return new Promise((resolve,reject)=>{
            const abort=()=>{
                this.pending.delete(id);cleanup();
                this.port.postMessage({op:"abort",id});
                reject(signal.reason||fail("CANCELLED","Torrent operation cancelled"));
            };
            const cleanup=()=>signal?.removeEventListener("abort",abort);
            this.pending.set(id,{resolve,reject,cleanup});
            signal?.addEventListener("abort",abort,{once:true});
            try{this.port.postMessage({id,op,args});}
            catch(error){this.pending.delete(id);cleanup();reject(error);}
        });
    }
    notify(op,args) {
        if(!this.closed)this.port.postMessage({op,args});
    }
    close(error=fail("CANCELLED","Ciphertext bridge closed")) {
        this.closed=true;
        for(const pending of this.pending.values()){pending.cleanup();pending.reject(error);}
        this.pending.clear();this.port.close();
    }
}

/** Window dispatch has no identity/crypto operations and never receives keys. */
export class WindowTorrentPort {
    constructor(port,createTransport,clearStorage=async()=>{}) {
        this.port=port;this.createTransport=createTransport;this.clearStorage=clearStorage;
        this.sessions=new Map();this.requests=new Map();this.closed=false;
        port.onmessage=({data})=>{
            if(data.op==="abort"){this.requests.get(data.id)?.abort(fail("CANCELLED","Ciphertext operation cancelled"));return;}
            if(!data.id && data.op==="cancel"){this.sessions.get(data.args?.session)?.cancel();return;}
            if(this.closed)return;
            const controller=new AbortController();this.requests.set(data.id,controller);
            this.execute(data.op,data.args,controller.signal).then(result=>{
                if(!this.closed)this.port.postMessage({id:data.id,ok:true,result},
                    result instanceof Uint8Array?[result.buffer]:[]);
            },error=>{
                if(!this.closed)this.port.postMessage({id:data.id,ok:false,error:errorValue(error)});
            }).finally(()=>this.requests.delete(data.id));
        };
        port.start();
    }
    async execute(op,args,signal) {
        if(!args || typeof args.session!=="string" || !/^torrent:[0-9]+$/.test(args.session))
            throw fail("TRANSPORT_ERROR","Invalid ciphertext session");
        const session=args.session;
        if(op==="clearStorage") {
            await Promise.allSettled([...this.sessions.values()].map(transport=>transport.close()));
            this.sessions.clear();await this.clearStorage();return null;
        }
        if(op==="create") {
            if(this.sessions.has(session))throw fail("TRANSPORT_ERROR","Ciphertext session already exists");
            const transport=this.createTransport(args.sources,value=>{
                if(!this.closed)this.port.postMessage({type:"progress",session,value});
            });
            this.sessions.set(session,transport);return null;
        }
        const transport=this.sessions.get(session);
        if(!transport)throw fail("TRANSPORT_ERROR","Ciphertext session is closed");
        switch(op) {
        case "open":return transport.open(args);
        case "read":return transport.read(args,signal);
        case "background":transport.setBackground(args.infoHash,args.enabled);return null;
        case "stopPrefetch":await transport.stopPrefetch(args.infoHash);return null;
        case "prefetch":
            void transport.prefetch(args.infoHash,args.ranges).catch(error=>{
                if(!this.closed && error.code!=="CANCELLED")
                    this.port.postMessage({type:"progress",session,value:{infoHash:args.infoHash,prefetchError:errorValue(error)}});
            });
            return null;
        case "stats":return transport.describe(transport.entry(args.infoHash));
        case "clear":await transport.clearCaches();return null;
        case "close":
            this.sessions.delete(session);await transport.close();return null;
        default:throw fail("TRANSPORT_ERROR","Unknown ciphertext bridge operation");
        }
    }
    async close() {
        this.closed=true;
        for(const request of this.requests.values())request.abort(fail("CANCELLED","Ciphertext bridge closed"));
        this.requests.clear();this.port.close();
        await Promise.allSettled([...this.sessions.values()].map(transport=>transport.close()));
        this.sessions.clear();
    }
}
