function errorInfo(error) {
    const message = String(error?.message || error);
    try {const value = JSON.parse(message);if(value.code && value.message) return value;}catch{}
    return {code:error?.code || 'OPERATION_FAILED',message};
}

/** Serializes Worker requests and owns their cancellation and reply protocol. */
export class WorkerProtocol {
    constructor({ready, getInitError, execute, onCancel, onCancelled, onRequest}) {
        this.ready=ready;
        this.getInitError=getInitError;
        this.execute=execute;
        this.onCancel=onCancel;
        this.onCancelled=onCancelled;
        this.onRequest=onRequest;
        this.sequence=Promise.resolve();
        this.cancelEpoch=0;
        this.activeEpoch=0;
    }
    get signal() {return this.activeRequest?.signal;}
    cancelled() {
        return this.activeEpoch!==this.cancelEpoch ||
            !!(this.cancelView && Atomics.load(this.cancelView,0)!==this.activeEpoch);
    }
    handle(data) {
        if(data.op==='cancel') {
            this.cancelEpoch=data.epoch;
            this.activeRequest?.abort();
            this.onCancel();
            return;
        }
        if(data.op==='configure') {
            this.cancelView=data.buffer ? new Int32Array(data.buffer) : undefined;
            return;
        }
        this.sequence=this.sequence.then(async()=>{
            const {id,op,args,epoch}=data;
            try {
                await this.ready;
                if(this.getInitError())throw this.getInitError();
                this.activeEpoch=epoch;
                this.activeRequest=new AbortController();
                this.onRequest();
                if(this.cancelled())throw Object.assign(new Error('Operation cancelled'),{code:'CANCELLED'});
                const result=await this.execute(op,args);
                self.postMessage({id,ok:true,result},result instanceof Uint8Array?[result.buffer]:result?.state instanceof ArrayBuffer?[result.state]:[]);
            } catch(error) {
                if(this.cancelled()) {
                    this.onCancelled();
                    error=Object.assign(new Error('Operation cancelled'),{code:'CANCELLED'});
                }
                self.postMessage({id,ok:false,error:errorInfo(error)});
            } finally {
                this.activeRequest=undefined;
                args?.password?.fill(0);
                args?.bytes?.fill(0);
                if(args?.readKey instanceof Uint8Array)args.readKey.fill(0);
            }
        }).catch(()=>self.postMessage({type:'fatal',error:'Disk Worker failed'}));
    }
}
