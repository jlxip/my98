import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {setImmediate as idle} from 'node:timers/promises';
import {Selections} from '../node_modules/webtorrent/lib/selections.js';
import {WindowTorrents} from '../src/disk/web/torrent-window.js';
import {WindowTorrentPort} from '../src/disk/web/torrent-port.js';

const P=262144,H='a'.repeat(40);
const error=code=>Object.assign(new Error(code),{code});
function fixture({pieces=20,last=P,cached=[],corrupt=[],delay}={}) {
    const events=[],requested=[],verifiedCache=[],destroyed=[];
    const size=(pieces-1)*P+last;
    class Torrent extends EventEmitter {
        constructor(){
            super();this.destroyed=false;this.downloaded=0;this.peak=0;this.paused=false;
            this._selections=new Selections();
            const buffer=new Uint8Array(Math.ceil(pieces/8));
            this.bitfield={buffer,get:i=>!!(buffer[i>>3]&(128>>(i%8))),set:(i,value)=>{if(value)buffer[i>>3]|=128>>(i%8);else buffer[i>>3]&=~(128>>(i%8));}};
            this.files=[{stream:({start,end})=>new ReadableStream({start(c){c.enqueue(new Uint8Array(end-start+1).fill(9));c.close();}})}];
        }
        _verifyPiece(index,callback){
            verifiedCache.push(index);
            queueMicrotask(()=>callback(null,cached.includes(index)&&!corrupt.includes(index)));
        }
        _markVerified(index){this.bitfield.set(index,true);this.emit('verified',index);}
        _select(from,to,priority,notify,isStreamSelection){
            this._selections.insert({from,to,priority,notify,isStreamSelection,offset:0});
            requested.push(from);this._updateSelections();
            if(delay!==undefined)setTimeout(()=>{if(!this.destroyed)this._markVerified(from);},delay);
        }
        _updateSelections(){this.peak=Math.max(this.peak,[...this._selections].filter(s=>!this.bitfield.get(s.from)).length);}
        deselect(from,to){this._selections.remove({from,to,isStreamSelection:false});this._updateSelections();}
        resume(){this.paused=false;}
        pause(){this.paused=true;}
        destroy(options,callback){destroyed.push(options);this.destroyed=true;this._selections.clear();queueMicrotask(callback);}
    }
    const transport=new WindowTorrents({onProgress:value=>events.push(value),timeout:2000});
    const torrent=new Torrent(),entry={infoHash:H,kind:'disk',filename:'disk.my98',metadata:new Uint8Array([1,2]),pieces,size,torrent,readers:new Set(),background:false,paused:false,rescanned:false};
    transport.entries.set(H,entry);
    const begin=(options={},signal)=>transport.prefetchStartup({infoHash:H,id:'job',ranges:[[0,size]],windowPieces:8,...options},signal);
    return {transport,torrent,entry,events,requested,verifiedCache,destroyed,begin,Torrent};
}
async function until(fn){for(let i=0;i<100;i++){if(fn())return;await idle();}assert(fn(),'condition did not become true');}

// The fixture bitfield changes only when a test simulates a verified piece.
// This deliberately separates selection, receipt and authenticated completion.
test('eight-piece window refills on any completion and never waits for the head',async()=>{
    const f=fixture(),pending=f.begin();await until(()=>f.requested.length===8);
    assert.deepEqual(f.requested,[0,1,2,3,4,5,6,7]);
    f.torrent._markVerified(7);assert.equal(f.requested.length,9);assert.equal(f.requested[8],8);
    assert.equal(f.torrent.bitfield.get(0),false);
    for(let i=1;i<20;i++)f.torrent._markVerified(i);
    assert.equal(f.requested.length,20);assert.equal(f.torrent.peak,8);
    let done=false;pending.then(()=>done=true);await idle();assert.equal(done,false);
    f.torrent._markVerified(0);assert.deepEqual(await pending,{completed:20*P,total:20*P});
    assert.equal(f.torrent._selections.length,0);
    assert.equal(new Set(f.requested).size,20);
});

test('union excludes duplicates, counts the short last piece, and reuses only verified cached targets',async()=>{
    const f=fixture({pieces:4,last:19,cached:[1,3],corrupt:[3]});
    const pending=f.begin({ranges:[[P+1,3],[P+40,20],[3*P,19]]});
    await until(()=>f.requested.length===1);
    assert.deepEqual(f.verifiedCache.sort((a,b)=>a-b),[1,3]);
    assert.deepEqual(f.requested,[3]);
    assert.equal(f.events.at(-1).startupPrefetch.completed,P);
    assert.equal(f.events.at(-1).startupPrefetch.total,P+19);
    f.torrent._markVerified(3);assert.deepEqual(await pending,{completed:P+19,total:P+19});
    assert.equal(f.events.at(-1).startupPrefetch.completed,P+19);
});

test('fully cached targets complete without a network selection',async()=>{
    const f=fixture({pieces:4,cached:[0,2]});
    const result=await f.begin({ranges:[[0,3],[2*P,5]]});
    assert.deepEqual(result,{completed:2*P,total:2*P});assert.deepEqual(f.requested,[]);
});

test('cache verification is bounded by the same window and cancellation is prompt',async()=>{
    const f=fixture(),controller=new AbortController();let active=0,peak=0;
    f.torrent._verifyPiece=()=>{active++;peak=Math.max(peak,active);};
    const pending=f.begin({},controller.signal);const rejected=assert.rejects(pending,{code:'CANCELLED'});
    await until(()=>active===8);controller.abort(error('CANCELLED'));await rejected;
    assert.equal(peak,8);assert.equal(f.entry.startupPrefetches.size,0);assert.deepEqual(f.requested,[]);
});

test('cancellation releases only this job, preserves demand and does not poison the disk',async()=>{
    const f=fixture(),controller=new AbortController(),demand=()=>{};
    f.torrent._select(0,0,1,demand,true);
    const pending=f.begin({},controller.signal),rejected=assert.rejects(pending,{code:'CANCELLED'});
    await until(()=>f.requested.length===9);controller.abort(error('CANCELLED'));await rejected;
    assert.equal(f.entry.error,undefined);assert.equal(f.torrent.paused,false);
    assert.equal(f.torrent._selections.length,1);assert.equal(f.torrent._selections.get(0).notify,demand);
    const bytes=await f.transport.read({infoHash:H,offset:0,length:512,recover:true});assert.equal(bytes.length,512);
});

test('old job cleanup cannot remove a newer job selecting the same piece',async()=>{
    const f=fixture(),old=new AbortController(),fresh=new AbortController();
    const one=f.begin({id:'old',ranges:[[0,1]],windowPieces:1},old.signal);
    const rejected=assert.rejects(one,{code:'CANCELLED'});await until(()=>f.requested.length===1);
    old.abort(error('CANCELLED'));
    const two=f.begin({id:'new',ranges:[[0,1]],windowPieces:1},fresh.signal);
    await rejected;await until(()=>f.requested.length===2);
    assert.equal(f.torrent._selections.length,1);
    f.torrent._markVerified(0);await two;assert.equal(f.events.at(-1).startupPrefetch.id,'new');
});

test('timeout stays local and a later request can still read the same disk',async()=>{
    const f=fixture();f.transport.timeout=10;
    await assert.rejects(f.begin(),{code:'TRANSPORT_TIMEOUT'});
    assert.equal(f.entry.error,undefined);assert.equal(f.torrent.paused,false);assert.equal(f.torrent._selections.length,0);
    assert.equal((await f.transport.read({infoHash:H,offset:5,length:512,recover:true})).length,512);
});

test('real torrent failure aborts startup and recovery replaces only that component with cache retained',async()=>{
    const f=fixture();const pending=f.begin(),rejected=assert.rejects(pending,{code:'TRANSPORT_ERROR'});
    await until(()=>f.requested.length===8);f.transport.failed(f.entry,error('TRANSPORT_ERROR'));await rejected;
    const other={...f.entry,infoHash:'b'.repeat(40),torrent:new f.Torrent(),error:undefined};f.transport.entries.set(other.infoHash,other);
    let calls=0,args;
    f.transport.open=async value=>{calls++;args=value;await idle();const entry={...f.entry,error:undefined,torrent:new f.Torrent(),startupPrefetches:new Set()};f.transport.entries.set(H,entry);return f.transport.describe(entry);};
    await Promise.all([f.transport.recover({infoHash:H}),f.transport.recover({infoHash:H}),f.transport.read({infoHash:H,offset:0,length:512,recover:true})]);
    assert.equal(calls,1);assert.deepEqual(args,{infoHash:H,metadata:f.entry.metadata,kind:'disk'});
    assert.deepEqual(f.destroyed,[{destroyStore:false}]);assert.equal(f.transport.entries.get(other.infoHash),other);
});

test('one cancelled recovery waiter cannot cancel a shared recovery needed by demand',async()=>{
    const f=fixture(),controller=new AbortController();f.entry.error=error('TRANSPORT_ERROR');let ready;
    f.transport.open=()=>new Promise(resolve=>{ready=()=>{const entry={...f.entry,error:undefined,torrent:new f.Torrent()};f.transport.entries.set(H,entry);resolve(f.transport.describe(entry));};});
    const first=f.transport.recover({infoHash:H},controller.signal),rejected=assert.rejects(first,{code:'CANCELLED'});
    const second=f.transport.recover({infoHash:H});await until(()=>ready);controller.abort(error('CANCELLED'));await rejected;
    ready();assert.equal((await second).infoHash,H);assert.equal((await f.transport.read({infoHash:H,offset:0,length:1,recover:true})).length,1);
});

test('already cancelled and invalid inputs cannot start network selection',async()=>{
    const f=fixture(),controller=new AbortController();controller.abort(error('CANCELLED'));
    await assert.rejects(f.begin({},controller.signal),{code:'CANCELLED'});
    for(const args of [{windowPieces:0},{windowPieces:33},{ranges:[[0,0]]},{ranges:[[-1,5]]},{ranges:[[20*P,1]]}])
        await assert.rejects(f.begin(args),{code:'INVALID_RANGE'});
    assert.deepEqual(f.requested,[]);
});

test('ciphertext bridge waits for startup completion and forwards isolated cancellation',async()=>{
    let complete,seenSignal;
    const bridge=Object.create(WindowTorrentPort.prototype);bridge.sessions=new Map([['torrent:1',{prefetchStartup:(_args,signal)=>{seenSignal=signal;return new Promise(resolve=>complete=resolve);}}]]);
    const controller=new AbortController();let done=false;
    const waiting=bridge.execute('prefetchStartup',{session:'torrent:1',infoHash:H},controller.signal).then(value=>{done=true;return value;});
    await idle();assert.equal(done,false);assert.equal(seenSignal,controller.signal);
    complete({completed:P,total:P});assert.deepEqual(await waiting,{completed:P,total:P});
});

test('controlled separated ranges complete faster with a window than one selected piece',async()=>{
    const ranges=Array.from({length:16},(_,i)=>[i*P,1]);
    const run=async windowPieces=>{const f=fixture({delay:15});const start=performance.now();await f.begin({ranges,windowPieces});return performance.now()-start;};
    const serial=await run(1),parallel=await run(8);
    assert(parallel<serial*0.65,`window ${parallel.toFixed(1)} ms, serial ${serial.toFixed(1)} ms`);
});

test('cancelling the sole startup opening aborts its discovery before adding a torrent',async()=>{
    const transport=new WindowTorrents();let entered=false,aborted=false,added=false;
    transport.discoverMetadata=(_hash,_kind,signal)=>new Promise((resolve,reject)=>{
        entered=true;signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true});
    });
    transport.add=async()=>{added=true;};
    const controller=new AbortController(),opening=transport.open({infoHash:H,kind:'profile'},controller.signal);
    const rejected=assert.rejects(opening,{code:'CANCELLED'});await until(()=>entered);
    controller.abort(error('CANCELLED'));await rejected;await until(()=>transport.opening.size===0);
    assert.equal(aborted,true);assert.equal(added,false);assert.equal(transport.entries.size,0);
});

test('a default opening sharing the hash survives cancellation of its startup waiter',async()=>{
    const transport=new WindowTorrents();let finish,seenSignal,added=0;
    transport.discoverMetadata=(_hash,_kind,signal)=>new Promise(resolve=>{seenSignal=signal;finish=()=>resolve(new Uint8Array([1]));});
    transport.add=async()=>{added++;return {infoHash:H};};
    const controller=new AbortController(),one=transport.open({infoHash:H,kind:'profile'},controller.signal);
    const rejected=assert.rejects(one,{code:'CANCELLED'});await until(()=>finish);
    const two=transport.open({infoHash:H,kind:'profile'});controller.abort(error('CANCELLED'));await rejected;
    assert.equal(seenSignal.aborted,false);finish();assert.deepEqual(await two,{infoHash:H});assert.equal(added,1);
});

test('startup metadata RPC opts into cancellation without altering default open calls',async()=>{
    const seen=[];
    const bridge=Object.create(WindowTorrentPort.prototype);
    bridge.sessions=new Map([['torrent:1',{open:async(args,signal)=>{seen.push(signal);},entry:()=>({metadata:new Uint8Array([1])})}]]);
    const controller=new AbortController();
    await bridge.execute('metadata',{session:'torrent:1',infoHash:H,startup:true},controller.signal);
    await bridge.execute('metadata',{session:'torrent:1',infoHash:H},controller.signal);
    assert.deepEqual(seen,[controller.signal,undefined]);
});

test('startup discovery and HEAD probes propagate their own abort to actual fetch signals',async()=>{
    const original=globalThis.fetch;let active=0,aborted=0;
    globalThis.fetch=(_url,{signal})=>new Promise((resolve,reject)=>{
        active++;
        const abort=()=>{active--;aborted++;reject(signal.reason);};
        signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    });
    try {
        const transport=new WindowTorrents({sources:{apis:['http://127.0.0.1:12345'],trackers:[],webseeds:['http://127.0.0.1:12345/content']}});
        transport.initialize=async()=>{transport.webRTC=false;return {};};
        const discovery=new AbortController();
        const pending=transport.open({infoHash:H,kind:'profile'},discovery.signal),rejected=assert.rejects(pending,{code:'CANCELLED'});
        await until(()=>active===1);discovery.abort(error('CANCELLED'));await rejected;
        await until(()=>transport.opening.size===0);assert.equal(active,0);assert.equal(transport.discoveries.size,0);
        const heads=new AbortController();
        const probing=transport.webseeds({infoHash:H,filename:'profile.json',size:1},transport.sources,heads.signal);
        const rejectedHead=assert.rejects(probing,{code:'CANCELLED'});await until(()=>active===1);
        heads.abort(error('CANCELLED'));await rejectedHead;assert.equal(active,0);assert.equal(aborted,2);
    } finally {globalThis.fetch=original;}
});

test('demand can retry from retained immutable metadata after a reopen fails before creating an entry',async()=>{
    const f=fixture({cached:[0]});f.entry.error=error('TRANSPORT_ERROR');let attempts=0;
    f.transport.open=async args=>{
        attempts++;assert.deepEqual(args,{infoHash:H,metadata:f.entry.metadata,kind:'disk'});
        if(attempts===1)throw error('PUBLICATION_UNAVAILABLE');
        const entry={...f.entry,error:undefined,torrent:new f.Torrent(),startupPrefetches:new Set()};
        f.transport.entries.set(H,entry);return f.transport.describe(entry);
    };
    await assert.rejects(f.transport.recover({infoHash:H}),{code:'PUBLICATION_UNAVAILABLE'});
    assert.equal(f.transport.entries.has(H),false);
    assert.equal((await f.transport.read({infoHash:H,offset:0,length:512,recover:true})).length,512);
    assert.equal(attempts,2);assert.deepEqual(f.destroyed,[{destroyStore:false}]);
    assert.equal(f.transport.entries.get(H).torrent.bitfield.get(0),true);
    await f.transport.close();assert.equal(f.transport.componentMetadata.size,0);
});

test('opt-in demand verifies cached target pieces before creating a stream, default reads do not change',async()=>{
    const f=fixture({cached:[0,1],corrupt:[1]});let streams=0;
    f.torrent.files=[{stream:({start,end})=>{
        streams++;
        if(streams===1){assert.equal(f.torrent.bitfield.get(0),true);assert.equal(f.torrent.bitfield.get(1),false);}
        return new ReadableStream({start(c){c.enqueue(new Uint8Array(end-start+1));c.close();}});
    }}];
    await f.transport.read({infoHash:H,offset:P-10,length:20,recover:true});
    assert.deepEqual(f.verifiedCache,[0,1]);
    await f.transport.read({infoHash:H,offset:2*P,length:1});
    assert.deepEqual(f.verifiedCache,[0,1]);assert.equal(streams,2);
});

test('cache verification for opt-in demand shares the read timeout and leaves the torrent usable',async()=>{
    const f=fixture();f.transport.timeout=10;f.torrent._verifyPiece=()=>{};
    await assert.rejects(f.transport.read({infoHash:H,offset:0,length:512,recover:true}),{code:'TRANSPORT_TIMEOUT'});
    assert.equal(f.entry.readers.size,0);assert.equal(f.entry.error,undefined);
});

function delayedScan(f) {
    const reads=[];
    f.torrent._verifyPiece=(index,callback)=>reads.push({index,callback});
    const original=f.torrent._verifyPiece;
    f.torrent.rescanFiles=done=>f.torrent._verifyPiece(0,(error,valid)=>{
        if(!error){if(valid)f.torrent._markVerified(0);else f.torrent.bitfield.set(0,false);}
        done(error);
    });
    f.transport.rescanCachedPieces(f.entry);
    return {reads,original};
}

test('a stale background negative cannot revoke newer verification of a startup target',async()=>{
    const f=fixture(),{reads,original}=delayedScan(f);
    const waiting=f.begin({ranges:[[0,2*P]],windowPieces:2});
    await until(()=>reads.length===3);
    assert.deepEqual(reads.map(value=>value.index),[0,0,1]);
    reads[1].callback(null,true);reads[2].callback(null,false);
    await until(()=>f.requested.length===1);assert.deepEqual(f.requested,[1]);
    reads[0].callback(null,false);
    assert.equal(f.torrent.bitfield.get(0),true,'Stale scan invalidated a newer target verification');
    assert.equal(f.torrent._verifyPiece,original);assert.equal(f.entry.cacheScan,undefined);
    f.torrent._markVerified(1);assert.deepEqual(await waiting,{completed:2*P,total:2*P});
});

test('real cache corruption without newer verification is still invalidated for opt-in targets',async()=>{
    const f=fixture();f.torrent._markVerified(0);
    const {reads,original}=delayedScan(f);
    await f.transport.verifyCachedPieces(f.entry,[0]);
    reads[0].callback(null,false);
    assert.equal(f.torrent.bitfield.get(0),false);
    assert.equal(f.torrent._verifyPiece,original);assert.equal(f.entry.cacheScan,undefined);
});

test('background rescan keeps its existing invalidation behavior without startup opt-in',()=>{
    const f=fixture(),{reads,original}=delayedScan(f);
    f.torrent._markVerified(0);reads[0].callback(null,false);
    assert.equal(f.torrent.bitfield.get(0),false);
    assert.equal(f.torrent._verifyPiece,original);
});
