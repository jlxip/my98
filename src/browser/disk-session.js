/** Owns the identity, opened disk, VM adapter and in-flight state operation. */
export class DiskSession {
    constructor(host) {
        this.host=host;
        this.client=undefined;
        this.description=undefined;
        this.adapter=undefined;
        this.active=false;
        this.prepared=false;
        this.analyzing=false;
        this.analysisError=undefined;
        this.stateAbort=undefined;
    }
    async unlock(username, password, machine, events) {
        const module=await import('../../build/disk/web/client.js');
        this.BufferClass=module.DiskBuffer;
        const candidate=await module.Slop86Disk.create(events);
        try {
            const identity=await candidate.unlock(username,password,machine);
            this.client=candidate;
            return identity;
        } catch(error) {
            await candidate.close().catch(()=>{});
            throw error;
        }
    }
    async createFromImage(file) {
        this.description=await this.client.createFromImage(file);
        return this.description;
    }
    async createEmpty(sizeBytes) {
        this.description=await this.client.createEmpty(sizeBytes);
        return this.description;
    }
    async open(file) {
        this.description=await this.client.open(file);
        this.prepared=false;
        return this.description;
    }
    async openRemote(options) {
        this.description=await this.client.openRemote(options);
        this.prepared=false;
        return this.description;
    }
    async boot({analyze=false,onDiskError}={}) {
        if(this.description.size%512)throw new Error('The image is preserved exactly, but its length does not allow booting it as an HDD.');
        try {
            if(analyze) {
                await this.client.startLoadAnalysis({origin:'boot'});
                this.analyzing=true;
                this.analysisError=undefined;
            }
            await this.client.setLoadPrefetch({origin:'boot',scope:'disk'});
            await this.client.read(0,512);
            this.adapter?.dispose();
            this.adapter=new this.BufferClass(this.client,this.description.size,onDiskError);
            await this.host.boot(this.adapter,'Encrypted disk',{autoFullscreen:!analyze});
            this.active=true;
        } catch(error) {
            if(analyze) {
                await this.client.cancelLoadAnalysis().catch(()=>{});
                this.analyzing=false;
            }
            throw error;
        }
    }
    async withStateOperation(work, onStart) {
        this.stateAbort=new AbortController();
        onStart?.();
        try {return await work(this.stateAbort.signal);}
        finally {
            this.stateAbort=undefined;
            this.description=await this.client.describe();
        }
    }
    saveMachineState(onStart) {
        return this.withStateOperation(async signal=>{
            const result=await this.host.captureState(this.client,signal);
            const id=this.description.disk_id.slice(0,4).map(n=>n.toString(16).padStart(2,'0')).join('');
            return {...result,id};
        },onStart);
    }
    restoreState(input, {analyze=false,onStart}={}) {
        return this.withStateOperation(async signal=>{
            const result=await this.host.restoreState(this.client,input,signal,{analyze});
            this.adapter=result.adapter;
            this.description=result.description;
            this.active=true;
            this.prepared=false;
            if(analyze) {
                this.analyzing=true;
                this.analysisError=undefined;
            }
            return result;
        },onStart);
    }
    async saveDisk() {
        await this.host.stop();
        this.description=await this.client.save();
        return this.description;
    }
    async downloadCurrent() {
        await this.host.stop();
        return this.client.downloadCurrent();
    }
    async verifyImage() {
        await this.host.stop();
        return this.client.verifyImage();
    }
    retryDownload() {return this.client.retryDownload();}
    async finishLoadAnalysis() {
        const profile=await this.client.finishLoadAnalysis();
        this.analyzing=false;
        return profile;
    }
    async cancelLoadAnalysis() {
        await this.client.cancelLoadAnalysis();
        this.analyzing=false;
    }
    async retryAdapter() {
        await this.adapter.retry();
        await this.host.resume();
    }
    async discardWrites() {
        if(this.active) {
            await this.host.stop();
            this.adapter?.dispose();
            this.adapter=undefined;
            await this.host.close();
            this.active=false;
        }
        this.description=await this.client.discardWrites();
        return this.description;
    }
    async close() {
        if(this.active)await this.host.stop();
        this.adapter?.dispose();
        this.adapter=undefined;
        await this.host.close();
        this.active=false;
        await this.client.close();
        this.client=this.description=undefined;
        this.prepared=this.analyzing=false;
        this.analysisError=undefined;
    }
    cancel() {
        if(this.stateAbort)this.stateAbort.abort();
        else this.client?.cancel();
    }
}
