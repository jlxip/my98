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
        this.loadProfiles=[];
        this.usedForVm=false;
        this.remoteMode='boot';
        this.publicationGeneration=0;
        this.publication=undefined;
        this.failedUpdate=undefined;
    }
    publicationEvents(events={}) {
        const generation=++this.publicationGeneration;
        return {...events,onPublication:value=>{if(generation===this.publicationGeneration&&this.observePublication(value))events.onPublication?.(value);}};
    }
    observePublication(value) {
        const remote=this.description?.remote;
        if(remote&&(!remote.following || value.sourceId&&value.sourceId!==remote.sourceId))return false;
        if(!this.publication || value.fatal || !value.sequence || !this.publication.sequence || BigInt(value.sequence)>=BigInt(this.publication.sequence))this.publication=value;
        return true;
    }
    get pendingPublication() {
        const remote=this.description?.remote,value=this.publication;
        if(!remote?.following||!value?.sequence||value.fatal||value.sourceId&&value.sourceId!==remote.sourceId)return undefined;
        return BigInt(value.sequence)>BigInt(remote.sequence)?value:undefined;
    }
    get automaticUpdate() {
        const pending=this.pendingPublication;
        return !!pending && !this.analyzing && this.failedUpdate!==pending.sequence &&
            (pending.infoHash===this.description.remote.publicationInfoHash || !this.usedForVm&&!this.description.dirty_bytes);
    }
    async updatePublication({restart=false,mode=this.remoteMode,discardChanges=false,onStart}={}) {
        const client=this.client;
        return this.withStateOperation(async signal=>{
            const abort=()=>client.cancelRemoteUpdate();signal.addEventListener('abort',abort,{once:true});
            const check=()=>{if(signal.aborted)throw Object.assign(new Error('Publication update cancelled'),{code:'CANCELLED'});};
            try {
                for(;;) {
                    let prepared,candidate,paused;
                    try {
                        check();
                        prepared=await client.prepareRemoteUpdate({minimumSequence:this.pendingPublication?.sequence,automatic:!restart});check();
                        if(prepared.changed)continue;
                        if(prepared.unchanged){this.description=prepared.description;this.failedUpdate=undefined;return;}
                        if(!restart&&this.usedForVm)throw Object.assign(new Error('Restart the current session to use the new publication'),{code:'SESSION_USED'});
                        const view=client.remoteUpdateDisk(prepared.token);
                        if(restart)candidate=await this.host.preparePublicationUpdate(view,mode,signal);
                        check();
                        if(restart)paused=await this.host.pausePublicationUpdate();
                        check();
                        const description=await client.commitRemoteUpdate(prepared.token,{discardChanges});
                        view.committed=true;
                        this.description=description;this.prepared=false;this.analyzing=false;this.analysisError=undefined;this.loadProfiles=[];
                        if(candidate){this.adapter=candidate.adapter;this.active=true;this.usedForVm=true;this.remoteMode=mode;await this.host.installPublicationUpdate(candidate);candidate=undefined;}
                        // Keep an already observed higher version, with the new source identity.
                        if(this.publication)this.publication={...this.publication,sourceId:description.remote.sourceId,selectedSequence:description.remote.sequence,selectedInfoHash:description.remote.publicationInfoHash};
                        this.failedUpdate=undefined;return;
                    } catch(error) {
                        if(candidate)await this.host.discardPublicationUpdate(candidate);
                        if(paused)await this.host.resumePublicationUpdate(paused);
                        if(error.code==='PUBLICATION_CHANGED'&&!signal.aborted)continue;
                        this.failedUpdate=this.pendingPublication?.sequence;throw error;
                    } finally {if(prepared?.token)await client.discardRemoteUpdate(prepared.token).catch(()=>{});}
                }
            } finally {signal.removeEventListener('abort',abort);}
        },onStart);
    }
    async unlock(username, password, machine, events) {
        const module=await import('../../build/disk/web/client.js');
        this.BufferClass=module.DiskBuffer;
        const candidate=await module.Slop86Disk.create(this.publicationEvents(events));
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
        this.publication=undefined;
        this.description=await this.client.createFromImage(file);
        return this.description;
    }
    async createEmpty(sizeBytes) {
        this.publication=undefined;
        this.description=await this.client.createEmpty(sizeBytes);
        return this.description;
    }
    async open(file) {
        this.publication=undefined;
        this.loadProfiles=[];
        this.description=await this.client.open(file);
        this.prepared=false;
        return this.description;
    }
    async openRemote(options) {
        this.loadProfiles=[];
        this.description=await this.client.openRemote(options);
        this.prepared=false;
        return this.description;
    }
    async openRemoteReadOnly(options,events) {
        const module=await import('../../build/disk/web/client.js');
        this.BufferClass=module.DiskBuffer;
        const candidate=await module.Slop86Disk.create(this.publicationEvents(events));
        try {
            this.description=await candidate.openRemoteReadOnly(options);
            this.client=candidate;this.prepared=false;
            return this.description;
        } catch(error) {await candidate.close().catch(()=>{});throw error;}
    }
    async boot({analyze=false,onDiskError}={}) {
        this.usedForVm=true;this.remoteMode='boot';
        if(this.description.size%512)throw new Error('The image is preserved exactly, but its length does not allow booting it as an HDD.');
        try {
            if(analyze) {
                await this.client.startLoadAnalysis({origin:'boot'});
                this.analyzing=true;
                this.analysisError=undefined;
            }
            await this.client.setLoadPrefetch({origin:'boot',scope:analyze?'disk':'auto'});
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
        this.usedForVm=true;if(input?.publication)this.remoteMode='resume';
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
    async stopForExport() {
        if(!this.host.diskQuiescent())throw new Error("Shut Windows down and wait for 0.0 MIPS. Pausing it manually does not count.");
        await this.host.stopForExport();
        await this.adapter?.drain();
    }
    async publishDisk(options) {await this.stopForExport();return this.client.publishDisk(options);}
    async exportDisk(format) {await this.stopForExport();return this.client.exportDisk(format);}
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
    async clearCaches() {
        await this.host.stop();
        await this.client.clearCaches();
    }
    retryDownload() {return this.client.retryDownload();}
    async finishLoadAnalysis() {
        const profile=await this.client.finishLoadAnalysis();
        this.analyzing=false;
        for(const value of profile)this.loadProfiles=[...this.loadProfiles.filter(p=>p.origin?.kind!==value.origin?.kind),value];
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
        ++this.publicationGeneration;
        this.loadProfiles=[];
        if(this.active)await this.host.stop();
        this.adapter?.dispose();
        this.adapter=undefined;
        await this.host.close();
        this.active=false;
        await this.client.close();
        this.client=this.description=this.publication=undefined;
        this.usedForVm=false;this.remoteMode='boot';this.failedUpdate=undefined;
        this.prepared=this.analyzing=false;
        this.analysisError=undefined;
    }
    cancel() {
        if(this.stateAbort)this.stateAbort.abort();
        else this.client?.cancel();
    }
}
