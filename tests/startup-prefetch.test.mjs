import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as idle} from 'node:timers/promises';
import {StartupPrefetch,startupPrefetchOptions,startupRanges} from '../src/disk/web/startup-prefetch.js';
import {RemotePublication} from '../src/disk/web/torrent-remote.js';

const PIECE=262144,origin={kind:'state',sha256:'a'.repeat(64)};
const error=(code='TRANSPORT_ERROR')=>Object.assign(new Error(code),{code});
const profile=(ranges=[[0,0]])=>({origin,ranges:[...ranges,...Array(32-ranges.length).fill(null)]});
function deferred() {
    let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});
    return {promise,resolve,reject};
}
function clock() {
    let now=0,next=0;const timers=new Map();
    return {setTimeout(fn,delay){const id=++next;timers.set(id,{at:now+delay,fn});return id;},
        clearTimeout(id){timers.delete(id);},
        advance(ms){now+=ms;for(const [id,timer] of [...timers])if(timer.at<=now){timers.delete(id);timer.fn();}},
        get pending(){return timers.size;}};
}
function fixture(overrides={}) {
    const transfer=deferred(),events=[],calls=[],recoveries=[],c=clock();
    const args={id:'test:startup:1',options:startupPrefetchOptions({}),logicalSize:64*65536,diskSize:64*(65536+62)+198,
        stateHash:'state',profileHash:'profile',clock:c,
        loadProfiles:async()=>[profile()],
        prefetch:async(args,signal)=>{calls.push({args,signal});return transfer.promise;},
        recover:async(kind,signal)=>{recoveries.push({kind,signal});},
        onProgress:value=>events.push(value),...overrides};
    const job=new StartupPrefetch(args);
    return {job,transfer,events,calls,recoveries,clock:c};
}
function state(job,covered=1000) {job.progress({infoHash:'state',size:1000,coveredBytes:covered});}
function pieces(job,completed,total=PIECE,id=job.attemptId) {
    job.progress({infoHash:'disk',startupPrefetch:{id,completed,total}});
}

test('starts payload before state authentication but does not complete before matching SHA',async()=>{
    const f=fixture();await idle();
    assert.equal(f.calls.length,1);assert.equal(f.calls[0].args.windowPieces,8);
    assert.equal(f.calls[0].signal.aborted,false);
    state(f.job,400);pieces(f.job,PIECE);
    f.transfer.resolve({completed:PIECE,total:PIECE});await idle();
    assert.equal(f.job.settled,false);assert.equal(f.events.at(-1).completed,400+PIECE);
    state(f.job);f.job.validate(origin);
    assert.deepEqual(await f.job.result,{outcome:'complete',attempts:1});
    assert.equal(f.events.at(-1).completed,f.events.at(-1).total);
    f.job.commit();assert.equal(f.clock.pending,0);
});

test('target combines unique encrypted pieces and a short final piece, not logical ranges',()=>{
    const size=198+8*(65536+62),target=startupRanges(profile([[0,0],[1,1],[7,7]]),size);
    assert.equal(target.ranges.length,3);assert.equal(target.total,size);
    assert.notEqual(target.total,3*65536);
});

test('aggregate waits for both totals, ignores other data and stale generations, never regresses',async()=>{
    let attempt=0;const second=deferred();
    const f=fixture({prefetch:async()=>{if(++attempt===1)throw error();return second.promise;}});
    state(f.job,200);assert.equal(f.events.length,0);await idle();
    assert.equal(attempt,2);assert.equal(f.job.attemptId,'test:startup:1:2');
    const total=1000+PIECE;
    assert(f.events.length);assert(f.events.every(e=>e.total===total));
    pieces(f.job,PIECE,PIECE,'test:startup:1:1');
    f.job.progress({infoHash:'unrelated',size:100000,coveredBytes:100000});
    assert.equal(f.events.at(-1).completed,200);
    pieces(f.job,100);state(f.job,300);pieces(f.job,50);state(f.job,100);
    assert.equal(f.events.at(-1).completed,400);
    state(f.job);f.job.validate(origin);second.resolve({completed:PIECE,total:PIECE});
    assert.equal((await f.job.result).outcome,'complete');
    assert.equal(f.events.at(-1).completed,total);
    for(let i=1;i<f.events.length;i++)assert(f.events[i].completed>=f.events[i-1].completed);
});

test('retries a transient metadata error, then a payload error, preserving the target',async()=>{
    let profiles=0,payloads=0;
    const f=fixture({loadProfiles:async()=>{if(++profiles===1)throw error('TRANSPORT_TIMEOUT');return [profile()];},
        prefetch:async()=>{if(++payloads===1)throw error();return {completed:PIECE,total:PIECE};}});
    state(f.job);f.job.validate(origin);
    assert.deepEqual(await f.job.result,{outcome:'complete',attempts:3});
    assert.equal(profiles,3);assert.equal(payloads,2);
    assert.deepEqual(f.recoveries.map(v=>v.kind),['profile','disk']);
    assert(f.events.every(e=>e.total===1000+PIECE));
});

test('three failed attempts resolve fallback, never reject the state operation',async()=>{
    let calls=0;const f=fixture({prefetch:async()=>{calls++;throw error();}});
    assert.deepEqual(await f.job.result,{outcome:'fallback',reason:'TRANSPORT_ERROR',attempts:3});
    assert.equal(calls,3);assert.equal(f.job.controller.signal.aborted,true);assert.equal(f.clock.pending,0);
});

for(const [name,options,reason,attempts] of [
    ['absent',{profileHash:null},'NO_PROFILE',0],
    ['no state profile',{loadProfiles:async()=>[]},'NO_PROFILE',1],
    ['invalid',{loadProfiles:async()=>{throw error('INVALID_PROFILE');}},'INVALID_PROFILE',1],
])test(name+' profile falls back without futile retries',async()=>{
    const f=fixture(options);
    assert.deepEqual(await f.job.result,{outcome:'fallback',reason,attempts});
    assert.equal(f.calls.length,0);assert.equal(f.recoveries.length,0);
});

test('SHA mismatch arriving after payload stops it without waiting for the transport',async()=>{
    const f=fixture();await idle();f.job.validate({...origin,sha256:'b'.repeat(64)});
    assert.equal((await f.job.result).reason,'PROFILE_MISMATCH');
    assert.equal(f.calls[0].signal.aborted,true);
    const count=f.events.length;f.transfer.resolve({completed:PIECE,total:PIECE});await idle();
    assert.equal(f.events.length,count);assert.equal(f.job.outcome.outcome,'fallback');
});

test('late JSON is checked against the authenticated state before selecting any payload',async()=>{
    const hints=deferred();const f=fixture({loadProfiles:()=>hints.promise});
    f.job.validate({...origin,sha256:'b'.repeat(64)});await idle();
    hints.resolve([profile()]);
    assert.equal((await f.job.result).reason,'PROFILE_MISMATCH');assert.equal(f.calls.length,0);
});

test('post-restore budget starts once, spans retries and resolves while IO ignores abort',async()=>{
    const hints=deferred(),f=fixture({loadProfiles:()=>hints.promise});await idle();
    f.clock.advance(20000);assert.equal(f.job.settled,false);
    f.job.commit();f.clock.advance(9000);f.job.commit();f.clock.advance(999);
    assert.equal(f.job.settled,false);f.clock.advance(1);
    assert.deepEqual(await f.job.result,{outcome:'fallback',reason:'PREFETCH_TIMEOUT',attempts:1});
    assert.equal(f.job.controller.signal.aborted,true);
    hints.resolve([profile()]);await idle();assert.equal(f.calls.length,0);assert.equal(f.events.length,0);
});

test('retry does not extend deadline and old transport progress cannot complete a new attempt',async()=>{
    const first=deferred(),second=deferred();let calls=0;
    const f=fixture({prefetch:async()=>++calls===1?first.promise:second.promise});await idle();
    f.job.commit();f.clock.advance(8000);first.reject(error());await idle();
    assert.equal(calls,2);pieces(f.job,PIECE,PIECE,'test:startup:1:1');
    f.clock.advance(2000);assert.equal((await f.job.result).reason,'PREFETCH_TIMEOUT');
    second.resolve({completed:PIECE,total:PIECE});await idle();assert.equal(f.job.outcome.outcome,'fallback');
});

test('attempt cancellation removes timers and suppresses late events',async()=>{
    const controller=new AbortController(),f=fixture({signal:controller.signal});await idle();
    f.job.commit();state(f.job,200);const before=f.events.length;
    controller.abort(error('CANCELLED'));
    assert.equal((await f.job.result).reason,'CANCELLED');assert.equal(f.clock.pending,0);
    state(f.job);pieces(f.job,PIECE);f.transfer.resolve({completed:PIECE,total:PIECE});await idle();
    assert.equal(f.events.length,before);
});

test('RemotePublication opt-in leaves defaults unchanged and promotes matching completed work',async()=>{
    const requests=[];let remote;
    const io={call:async(op,args)=>{
        requests.push({op,args});
        if(op==='prefetchStartup') {
            remote.progress({infoHash:'disk',startupPrefetch:{id:args.id,completed:PIECE,total:PIECE}});
            return {completed:PIECE,total:PIECE};
        }
        return null;
    },notify:()=>{}};
    remote=new RemotePublication(io,{});remote.publication={disk:'disk',state:'state',profile:'profile'};
    remote.size=64*(65536+62)+198;remote.profiles=async()=>[profile()];
    await remote.read(0,1);assert.equal(requests.at(-1).args.recover,undefined);
    const events=[],id=remote.startStartupPrefetch({}, {size:64*65536,onProgress:p=>events.push(p)});
    remote.progress({infoHash:'state',size:1000,coveredBytes:1000});
    remote.validateStartupPrefetch(id,origin);remote.commitStartupPrefetch(id);
    assert.equal((await remote.waitStartupPrefetch(id)).outcome,'complete');
    assert.equal(remote.scope,'profile');assert.equal(events.at(-1).completed,1000+PIECE);
    const background=requests.findIndex(v=>v.op==='background'),stop=requests.findIndex(v=>v.op==='stopPrefetch');
    const prefetch=requests.findIndex(v=>v.op==='prefetchStartup');
    assert.equal(requests[background].args.enabled,false);
    assert(background>=0 && stop>background && prefetch>stop,'Opt-in must stop full disk and prior profile selections first');
    await remote.read(0,1);assert.equal(requests.at(-1).args.recover,true);
    await remote.setLoadPrefetch(origin,'none',{size:64*65536});assert.equal(remote.scope,'none');
    assert.equal(requests.some(v=>v.op==='cancel'),false);
});

test('new startup work supersedes old JSON without letting old cleanup change the new scope',async()=>{
    const old=deferred(),io={call:async(op)=>op==='prefetchStartup'?{completed:PIECE,total:PIECE}:null,notify:()=>{}};
    const remote=new RemotePublication(io,{});remote.publication={disk:'disk',state:'state',profile:'profile'};
    remote.size=64*(65536+62)+198;let calls=0;remote.profiles=()=>++calls===1?old.promise:Promise.resolve([profile()]);
    const first=remote.startStartupPrefetch({}, {size:64*65536});const firstResult=remote.waitStartupPrefetch(first);await idle();
    const second=remote.startStartupPrefetch({}, {size:64*65536});remote.validateStartupPrefetch(second,origin);
    assert.equal((await firstResult).reason,'CANCELLED');
    assert.equal((await remote.waitStartupPrefetch(second)).outcome,'complete');
    old.resolve([profile()]);await idle();assert.equal(remote.scope,'profile');
    remote.discardStartupPrefetch();
});

test('invalid options do not silently request full-disk or unbounded work',()=>{
    for(const options of [{scope:'disk'},{maxAttempts:4},{maxAttempts:0},{postRestoreBudgetMs:-1},{windowPieces:0},{extra:true}])
        assert.throws(()=>startupPrefetchOptions(options),{code:'INVALID_PROFILE'});
});

test('a missing profile still turns off pre-existing full-disk background work',async()=>{
    const requests=[],io={call:async(op,args)=>{requests.push({op,args});return null;},notify:()=>{}};
    const remote=new RemotePublication(io,{});remote.publication={disk:'disk',state:'state',profile:null};
    remote.size=1024;assert.equal(remote.scope,'disk');
    const id=remote.startStartupPrefetch({}, {size:512});
    assert.equal((await remote.waitStartupPrefetch(id)).reason,'NO_PROFILE');
    assert.equal(remote.scope,'none');assert.deepEqual(requests.map(v=>v.op),['background','stopPrefetch']);
    assert.equal(requests[0].args.enabled,false);
});

test('default timers retain the global receiver required by browser Workers',async()=>{
    const originalSet=globalThis.setTimeout,originalClear=globalThis.clearTimeout;
    const calls=[];let callback,f;
    try {
        globalThis.setTimeout=function(fn,delay){
            assert.equal(this,globalThis);calls.push(['set',delay]);callback=fn;return 42;
        };
        globalThis.clearTimeout=function(id){assert.equal(this,globalThis);calls.push(['clear',id]);};
        f=fixture({clock:undefined});f.job.commit();callback();
        assert.deepEqual(calls,[['set',10000],['clear',42]]);
    } finally {globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;}
    assert.equal((await f.job.result).reason,'PREFETCH_TIMEOUT');
});
