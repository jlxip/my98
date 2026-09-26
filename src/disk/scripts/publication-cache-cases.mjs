import {PublicationCache,PUBLICATION_DATABASE,PUBLICATION_QUEUE_BYTES} from '../web/publication-cache.js';
import {CID} from 'multiformats/cid';
import {sha256} from 'multiformats/hashes/sha2';
const delay=()=>new Promise(r=>setTimeout(r,0));
export async function runPublicationCacheCases() {
    const checks=[],ok=(value,label)=>{if(!value)throw Error(label);checks.push(label);};
    const bytes=new Uint8Array([1,2,3]),cid=CID.createV1(0x55,await sha256.digest(bytes));
    const other=new Uint8Array([4,5,6]),otherCid=CID.createV1(0x55,await sha256.digest(other));
    const pub=(name='machine-a',sequence='1',root=cid,suffix='')=>({ipnsName:name,sequence,rootCid:root.toString(),path:'/ipfs/'+root+suffix});
    const caches=[];
    async function open(value=pub(),options={}) {const c=new PublicationCache(options);caches.push(c);await c.bind(value);return c;}
    async function flush(c) {for(let n=0;n<1000;n++){if(!c.stats().pendingWrites)return;await delay();}throw Error('writer did not settle');}
    try {
        const a=await open(),b=await open(pub('machine-b'));
        a.put(cid,bytes,'disk');b.put(cid,bytes,'disk');await Promise.all([flush(a),flush(b)]);
        const renew=await open(pub('machine-a','2'));ok((await renew.get(cid,'disk'))?.[0]===1,'renewal preserves blocks');
        const next=await open(pub('machine-a','3',otherCid));
        ok(await next.get(cid,'disk')===undefined,'new publication removes previous blocks immediately');
        ok((await b.get(cid,'disk'))?.[0]===1,'other machines survive invalidation');
        a.put(otherCid,other,'disk');await flush(a);ok(a.stats().stale,'old writer is fenced');
        const old=await open(pub());ok(old.stats().stale,'stale resolution cannot roll back a machine');
        const conflict=await open(pub('machine-a','3'));ok(conflict.stats().stale,'same-sequence conflict cannot replace current publication');
        next.put(otherCid,other,'disk');await flush(next);
        const path=await open(pub('machine-a','4',otherCid,'/new'));ok(await path.get(otherCid,'disk')===undefined,'path changes also invalidate');
        path.put(otherCid,other,'disk');await flush(path);
        await path.transaction(['blocks'],'readwrite',tx=>tx.objectStore('blocks').put({machine:'machine-a',cid:otherCid.toString(),bytes:new Uint8Array([0,0,0])}));
        ok(await path.get(otherCid,'disk')===undefined,'corrupt block is rejected by CID');
        path.put(otherCid,other,'disk');await flush(path);ok((await path.get(otherCid,'disk'))?.[0]===4,'corrupt block can be repaired');
        let warnings=0;const broken=await open(pub('broken'),{onError:()=>warnings++});
        broken.transaction=()=>Promise.reject(new DOMException('quota','QuotaExceededError'));
        broken.put(cid,bytes,'disk');await flush(broken);broken.put(otherCid,other,'disk');
        ok(!broken.stats().available&&warnings===1&&await broken.get(cid,'disk')===undefined,'quota failure is optional and warns once');
        const descriptor=Object.getOwnPropertyDescriptor(globalThis,'indexedDB');
        Object.defineProperty(globalThis,'indexedDB',{configurable:true,value:{open(){throw Error('unavailable');}}});
        try {const unavailable=new PublicationCache();caches.push(unavailable);await unavailable.ready;ok(!unavailable.stats().available,'unavailable storage is optional');}
        finally{if(descriptor)Object.defineProperty(globalThis,'indexedDB',descriptor);else delete globalThis.indexedDB;}
        const retained=new Map(),slow=await open(pub('slow'),{retained});
        let release;const gate=new Promise(r=>release=r),transaction=slow.transaction.bind(slow);
        slow.transaction=async(...args)=>{await gate;return transaction(...args);};
        for(let n=0;n<8;n++) {const payload=new Uint8Array(1048576);payload[0]=n;const id=CID.createV1(0x55,await sha256.digest(payload));retained.set(id.toString(),payload);slow.put(id,payload,'disk');}
        ok(slow.queueBytes<=PUBLICATION_QUEUE_BYTES&&slow.deferred.size>0,'slow writer has bounded payload queue');
        release();await flush(slow);ok(slow.stats().disk.writtenBytes===8*1048576,'deferred disk blocks eventually persist');
        // Block an old write before it starts its IDB transaction, then replace.
        const race=await open(pub('race'));let resume;const blocked=new Promise(r=>resume=r),normal=race.transaction.bind(race);
        race.transaction=async(...args)=>{await blocked;return normal(...args);};race.put(cid,bytes,'disk');
        const replacement=await open(pub('race','2',otherCid));resume();await flush(race);
        ok(race.stats().stale&&await replacement.get(cid,'disk')===undefined,'in-flight old queue cannot repopulate a replacement');
        return {checks,database:PUBLICATION_DATABASE};
    }finally{for(const c of caches)c.close();}
}
