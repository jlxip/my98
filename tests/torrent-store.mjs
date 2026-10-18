import assert from "node:assert/strict";
import {createServer} from "node:http";
import {readFile,mkdir,writeFile} from "node:fs/promises";
import {chromium,webkit} from "playwright";

const source=await readFile("src/disk/web/torrent-store.js");
const server=createServer((req,res)=>{
    if(req.url==="/store.js")res.writeHead(200,{"Content-Type":"text/javascript"}).end(source);
    else res.writeHead(200,{"Content-Type":"text/html"}).end("<!doctype html>");
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const results=[];
try {
    for(const [name,type] of Object.entries({chromium,webkit})) {
        const browser=await type.launch();
        try {
            const page=await browser.newPage();
            await page.goto("http://127.0.0.1:"+server.address().port+"/");
            const checks=await page.evaluate(async()=>{
                const {TorrentPieceStore,PIECE_LENGTH,openTorrentDatabase,clearTorrentCache}=await import("/store.js");
                const call=(store,op,...args)=>new Promise((resolve,reject)=>store[op](...args,(error,value)=>error?reject(error):resolve(value)));
                const assert=(value,message)=>{if(!value)throw Error(message);};
                const hash="12".repeat(20),options={infoHash:hash,length:PIECE_LENGTH*2+123,ramBytes:PIECE_LENGTH};
                let store=new TorrentPieceStore(PIECE_LENGTH,options);
                const first=new Uint8Array(PIECE_LENGTH).fill(11),second=new Uint8Array(PIECE_LENGTH).fill(22),last=new Uint8Array(123).fill(33);
                const pending=call(store,"put",0,first);
                await call(store,"close");await pending;
                store=new TorrentPieceStore(PIECE_LENGTH,options);
                assert((await call(store,"get",0))[0]===11,"Close discarded an accepted pending write");
                await call(store,"put",1,second);
                await call(store,"put",2,last);
                assert(store.memoryBytes<=PIECE_LENGTH,"RAM bound exceeded");
                assert((await call(store,"get",0,{offset:37,length:10})).every(b=>b===11),"Incorrect cached range");
                const copy=await call(store,"get",0);copy.fill(99);
                assert((await call(store,"get",0))[0]===11,"Caller mutated RAM cache");
                await call(store,"close");
                store=new TorrentPieceStore(PIECE_LENGTH,options);
                assert((await call(store,"get",2)).length===123,"Last piece did not persist");
                assert((await call(store,"get",1))[0]===22,"Piece did not persist");
                try{await call(store,"get",3);throw Error("Invalid piece accepted");}
                catch(error){assert(error.code==="INVALID_RANGE","Incorrect range error");}
                await call(store,"close");
                store=new TorrentPieceStore(PIECE_LENGTH,{...options,infoHash:"34".repeat(20)});
                const put=IDBObjectStore.prototype.put;
                try {
                    IDBObjectStore.prototype.put=function(){throw new DOMException("Fixture quota","QuotaExceededError");};
                    try{await call(store,"put",0,first);throw Error("Quota failure was ignored");}
                    catch(error){assert(error.code==="STORAGE_FULL","Quota error was not controlled");}
                    assert(store.memoryBytes===0,"Failed persistent write accumulated RAM data");
                } finally {IDBObjectStore.prototype.put=put;}
                try{await call(store,"get",0);throw Error("Failed write appeared in cache");}
                catch(error){assert(error.code==="ENOENT","Failed write was retained");}
                await call(store,"close");
                const db=await openTorrentDatabase();
                await new Promise((resolve,reject)=>{
                    const tx=db.transaction(["names"],"readwrite");
                    tx.objectStore("names").put({publicKey:"cache-policy-fixture",sequence:123});
                    tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
                });
                db.close();
                await clearTorrentCache();
                store=new TorrentPieceStore(PIECE_LENGTH,options);
                try{await call(store,"get",0);throw Error("Clear retained pieces");}
                catch(error){assert(error.code==="ENOENT","Clear did not remove pieces");}
                await call(store,"close");
                const reopened=await openTorrentDatabase();
                const maximum=await new Promise((resolve,reject)=>{
                    const request=reopened.transaction(["names"]).objectStore("names").get("cache-policy-fixture");
                    request.onsuccess=()=>resolve(request.result?.sequence);request.onerror=()=>reject(request.error);
                });
                reopened.close();assert(maximum===123,"Piece cleanup erased anti-replay high-water marks");
                return {persisted:true,range:true,ramBound:true,quotaError:true,noRamFallback:true,cleanupPreservesNames:true};
            });
            results.push({browser:name,...checks});console.log(JSON.stringify(results.at(-1)));
        } finally {await browser.close();}
    }
} finally {
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    await mkdir("build/transport-retirement",{recursive:true});
    await writeFile("build/transport-retirement/torrent-store.json",JSON.stringify(results,null,2)+"\n");
}
