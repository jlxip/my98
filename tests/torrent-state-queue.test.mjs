import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as idle} from 'node:timers/promises';
import {RemotePublication} from '../src/disk/web/torrent-remote.js';

const piece=262144;
function fixture({size=64*piece+123,failIndex,shortIndex}={}) {
    const requests=[];
    let active=0,peak=0;
    const source={publication:{state:'fixture'},torrent:async()=>({size}),
        bytes:(_hash,offset,length,signal)=>new Promise((resolve,reject)=>{
            active++;peak=Math.max(peak,active);
            let settled=false;
            const finish=(error,bytes)=>{
                if(settled)return;settled=true;active--;
                signal.removeEventListener('abort',abort);
                if(error)reject(error);else resolve(bytes);
            };
            const abort=()=>finish(signal.reason);
            const request={offset,length,complete:()=>finish(null,new Uint8Array(length).fill(offset/piece%251))};
            requests.push(request);signal.addEventListener('abort',abort,{once:true});
            if(signal.aborted){abort();return;}
            if(offset/piece===failIndex)queueMicrotask(()=>finish(Object.assign(Error('Range failed'),{code:'FIXTURE_ERROR'})));
            else if(offset/piece===shortIndex)queueMicrotask(()=>finish(null,new Uint8Array(length-1)));
            else if(offset!==0)queueMicrotask(request.complete);
        })};
    return {source,requests,get active(){return active;},get peak(){return peak;}};
}

test('a stalled head refills four lanes up to 4 MiB, pauses, then emits exact ordered bytes',async()=>{
    const f=fixture(),input=await RemotePublication.prototype.stateInput.call(f.source);
    const reader=input.stream.getReader(),first=reader.read();
    await idle();
    assert.equal(f.requests.length,16,'Completed ranges must replenish lanes while the head is pending');
    assert.equal(f.active,1);assert.equal(f.peak,4);
    await idle();assert.equal(f.requests.length,16,'A stalled head must not buffer the whole state');
    f.requests[0].complete();
    let item=await first,index=0,total=0;
    assert.equal(item.value[0],0);
    await idle();assert.equal(f.requests.length,17,'Only the consumed slot may be replenished under backpressure');
    for(;;){
        if(item.done)break;
        assert(item.value.every(byte=>byte===index%251),'Out-of-order state bytes');
        assert.equal(item.value.length,Math.min(piece,input.size-total));
        total+=item.value.length;index++;
        item=await reader.read();
    }
    assert.equal(total,input.size);assert.equal(index,65);assert.equal(f.active,0);
    assert.equal(new Set(f.requests.map(q=>q.offset)).size,65,'Duplicate range requests');
    assert(f.peak<=4);
});

for(const action of ['signal','reader'])test(action+' cancellation stops a full reorder window without refilling',async()=>{
    const f=fixture(),controller=new AbortController();
    const input=await RemotePublication.prototype.stateInput.call(f.source,controller.signal);
    const reader=input.stream.getReader(),pending=reader.read();
    const observed=action==='signal'?assert.rejects(pending,{code:'CANCELLED'}):pending;
    await idle();assert.equal(f.requests.length,16);
    if(action==='signal')controller.abort(Object.assign(Error('Cancelled'),{code:'CANCELLED'}));
    else await reader.cancel();
    await observed;await idle();
    assert.equal(f.active,0);assert.equal(f.requests.length,16);
    if(action==='reader')assert.deepEqual(await reader.read(),{value:undefined,done:true});
});

for(const [option,code] of [['failIndex','FIXTURE_ERROR'],['shortIndex','TRANSPORT_ERROR']])
test(option+' on a later range aborts the pending head and all other lanes',async()=>{
    const f=fixture({[option]:2});
    const input=await RemotePublication.prototype.stateInput.call(f.source);
    const reader=input.stream.getReader();
    await assert.rejects(reader.read(),{code});await idle();
    assert.equal(f.active,0);assert(f.requests.length<=7,'Failure must stop read-ahead immediately');
    await assert.rejects(reader.read(),{code});
});

test('an already cancelled input never starts a range',async()=>{
    const f=fixture(),controller=new AbortController();
    controller.abort(Object.assign(Error('Cancelled'),{code:'CANCELLED'}));
    await assert.rejects(RemotePublication.prototype.stateInput.call(f.source,controller.signal),{code:'CANCELLED'});
    assert.equal(f.requests.length,0);
});
