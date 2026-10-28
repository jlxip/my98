import {sameOrigin} from './load-profiles.js';

const fail=(code,message)=>Object.assign(new Error(message),{code});
const PIECE=262144;
const permanent=new Set(['INVALID_PROFILE','INVALID_PUBLICATION','INVALID_RANGE','INVALID_STATE']);

export function startupPrefetchOptions(value) {
    const options={scope:'profile',maxAttempts:3,postRestoreBudgetMs:10000,windowPieces:8,...value};
    if(!value || typeof value!=='object' || Array.isArray(value) ||
        Object.keys(value).some(key=>!['scope','maxAttempts','postRestoreBudgetMs','windowPieces'].includes(key)) ||
        options.scope!=='profile' || !Number.isSafeInteger(options.maxAttempts) || options.maxAttempts<1 || options.maxAttempts>3 ||
        !Number.isSafeInteger(options.postRestoreBudgetMs) || options.postRestoreBudgetMs<0 || options.postRestoreBudgetMs>60000 ||
        !Number.isSafeInteger(options.windowPieces) || options.windowPieces<1 || options.windowPieces>16)
        throw fail('INVALID_PROFILE','Invalid startup prefetch options');
    return options;
}

// Count the union of ciphertext pieces, rather than logical units or transferred retries.
// At most 32 intervals are merged; this does not allocate one entry per disk piece.
export function startupRanges(profile,diskSize) {
    const ranges=profile.ranges.filter(Boolean).map(([first,last])=>{
        const begin=198+first*(65536+62),end=Math.min(diskSize,198+(last+1)*(65536+62));
        if(!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin<0 || end<=begin)
            throw fail('INVALID_PROFILE','Invalid startup profile range');
        return [begin,end-begin];
    });
    const intervals=ranges.map(([start,length])=>[Math.floor(start/PIECE),Math.floor((start+length-1)/PIECE)])
        .sort((a,b)=>a[0]-b[0]),merged=[];
    for(const interval of intervals) {
        const last=merged.at(-1);
        if(last && interval[0]<=last[1]+1)last[1]=Math.max(last[1],interval[1]);
        else merged.push(interval.slice());
    }
    const total=merged.reduce((bytes,[first,last])=>bytes+Math.min(diskSize,(last+1)*PIECE)-first*PIECE,0);
    return {ranges,total};
}

/** Optional ciphertext work. It never owns or calls the Vault or cancels the state. */
export class StartupPrefetch {
    constructor({id,options,logicalSize,diskSize,stateHash,profileHash,loadProfiles,prefetch,recover,prepare=async()=>{},
        onProgress=()=>{},onOutcome=()=>{},signal,clock={
            setTimeout:(callback,delay)=>globalThis.setTimeout(callback,delay),
            clearTimeout:id=>globalThis.clearTimeout(id),
        }}) {
        Object.assign(this,{id,options,logicalSize,diskSize,stateHash,profileHash,loadProfiles,prefetch,recover,
            onProgress,onOutcome,clock,prepare});
        this.controller=new AbortController();this.attempts=0;this.profileCompleted=0;this.stateCompleted=0;
        this.lastCompleted=0;this.committed=false;this.settled=false;
        this.result=new Promise(resolve=>this.resolve=resolve);
        this.abort=()=>this.cancel(signal?.reason?.code||'CANCELLED');
        this.cleanup=()=>signal?.removeEventListener('abort',this.abort);
        signal?.addEventListener('abort',this.abort,{once:true});
        if(signal?.aborted)this.abort();
        // The owner installs the job before either callback can run.
        this.task=Promise.resolve().then(()=>this.run()).catch(error=>this.finish('fallback',error?.code||'TRANSPORT_ERROR'));
    }
    current() {return !this.settled && !this.controller.signal.aborted;}
    finish(outcome,reason) {
        if(this.settled)return;
        this.settled=true;this.cleanup();this.clock.clearTimeout(this.timer);
        this.outcome={outcome,attempts:this.attempts,...(reason?{reason}:{})};
        if(outcome!=='complete')this.controller.abort(fail(reason||'CANCELLED','Startup prefetch stopped'));
        // A host progress/UI callback must not turn an optional hint into an unhandled rejection.
        try{this.onOutcome(this.outcome);}catch{}
        this.resolve(this.outcome);
    }
    cancel(reason='CANCELLED') {this.finish('fallback',reason);}
    validate(origin) {
        if(!this.current())return;
        this.origin=origin;
        if(this.profile && !sameOrigin(this.profile.origin,origin)) {
            this.finish('fallback','PROFILE_MISMATCH');return;
        }
        this.complete();
    }
    commit() {
        if(this.committed || this.settled)return;
        this.committed=true;
        this.timer=this.clock.setTimeout(()=>this.finish('fallback','PREFETCH_TIMEOUT'),this.options.postRestoreBudgetMs);
        this.complete();
    }
    complete() {
        if(this.current() && this.downloadComplete && this.origin && sameOrigin(this.profile?.origin,this.origin))
            this.finish('complete');
    }
    emit() {
        if(!this.current() || this.stateTotal===undefined || this.profileTotal===undefined)return;
        const total=this.stateTotal+this.profileTotal;
        const completed=Math.min(total,Math.max(this.lastCompleted,this.stateCompleted+this.profileCompleted));
        this.lastCompleted=completed;
        try{this.onProgress({id:this.id,completed,total});}catch{}
    }
    progress(value) {
        if(!this.current())return;
        if(value.infoHash===this.stateHash && Number.isSafeInteger(value.size) && value.size>0 &&
            Number.isSafeInteger(value.coveredBytes) && value.coveredBytes>=0 && value.coveredBytes<=value.size) {
            if(this.stateTotal!==undefined && this.stateTotal!==value.size)return;
            this.stateTotal=value.size;this.stateCompleted=Math.max(this.stateCompleted,value.coveredBytes);
        }
        const p=value.startupPrefetch;
        if(p && p.id===this.attemptId && p.total===this.profileTotal && Number.isSafeInteger(p.completed) &&
            p.completed>=0 && p.completed<=p.total)this.profileCompleted=Math.max(this.profileCompleted,p.completed);
        this.emit();
    }
    async run() {
        if(!this.current())return;
        await this.prepare(this.controller.signal);
        if(!this.current())return;
        if(!this.profileHash){this.finish('fallback','NO_PROFILE');return;}
        let failedKind;
        while(this.current() && this.attempts<this.options.maxAttempts) {
            this.attempts++;
            this.attemptId=this.id+':'+this.attempts;
            let stage=failedKind||'profile';
            try {
                if(failedKind)await this.recover(failedKind,this.controller.signal);
                if(!this.current())return;
                stage='profile';
                const profiles=await this.loadProfiles(Math.ceil(this.logicalSize/65536),this.controller.signal);
                if(!this.current())return;
                const profile=profiles.find(value=>value.origin.kind==='state');
                if(!profile){this.finish('fallback','NO_PROFILE');return;}
                if(this.origin && !sameOrigin(profile.origin,this.origin)) {
                    this.finish('fallback','PROFILE_MISMATCH');return;
                }
                this.profile=profile;
                const target=startupRanges(profile,this.diskSize);
                if(this.profileTotal!==undefined && this.profileTotal!==target.total)
                    throw fail('INVALID_PROFILE','Startup target changed within one publication');
                this.profileTotal=target.total;this.emit();
                stage='disk';
                const result=await this.prefetch({id:this.attemptId,ranges:target.ranges,windowPieces:this.options.windowPieces},this.controller.signal);
                if(!this.current())return;
                if(result?.completed!==target.total || result?.total!==target.total)
                    throw fail('TRANSPORT_ERROR','Startup prefetch did not verify its target');
                this.profileCompleted=target.total;this.downloadComplete=true;this.emit();this.complete();
                return;
            } catch(error) {
                if(!this.current())return;
                const code=error?.code||'TRANSPORT_ERROR';
                if(permanent.has(code) || code==='CANCELLED' || this.attempts===this.options.maxAttempts) {
                    this.finish('fallback',code);return;
                }
                failedKind=stage;
            }
        }
    }
}
