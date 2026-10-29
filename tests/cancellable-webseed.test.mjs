import test from 'node:test';
import assert from 'node:assert/strict';
import {createWebSeed} from '../src/disk/web/cancellable-webseed.js';

async function request(fetcher,run) {
    const original=globalThis.fetch,seed=createWebSeed('https://seed.example/content',{pieceLength:262144,length:4});
    globalThis.fetch=fetcher;
    try{await run(seed);}finally{seed.destroy();globalThis.fetch=original;}
}
const read=seed=>new Promise((resolve,reject)=>seed.httpRequest(0,0,4,(error,bytes)=>error?reject(error):resolve(bytes)));

test('webseed accepts only the exact requested ciphertext range',async()=>{
    await request(async()=>new Response(new Uint8Array([1,2,3,4]),{status:206,headers:{'Content-Range':'bytes 0-3/4'}}),async seed=>{
        assert.deepEqual(await read(seed),new Uint8Array([1,2,3,4]));assert.equal(seed.requests.size,0);
    });
    for(const [status,range,bytes] of [[200,'bytes 0-3/4',4],[206,'bytes 1-3/4',4],[206,'bytes 0-3/4',3],[206,'bytes 0-3/4',5]]) {
        let signal;
        await request(async(url,options)=>{signal=options.signal;return new Response(new Uint8Array(bytes),{status,headers:{'Content-Range':range}});},async seed=>{
            await assert.rejects(read(seed));assert(signal.aborted);assert.equal(seed.requests.size,0);
        });
    }
});

test('removing a stalled webseed aborts its actual HTTP request and completes its callback once',async()=>{
    let started,signal,callbacks=0;const ready=new Promise(resolve=>{started=resolve;});
    await request((url,options)=>new Promise((resolve,reject)=>{
        signal=options.signal;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});started();
    }),async seed=>{
        const pending=new Promise(resolve=>seed.httpRequest(0,0,4,error=>{callbacks++;resolve(error);}));
        await ready;assert.equal(seed.requests.size,1);seed.destroy();
        assert(await pending);assert(signal.aborted);assert.equal(callbacks,1);assert.equal(seed.requests.size,0);
    });
});
