import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {chromium,webkit} from 'playwright';
const piece=262144,data=Buffer.alloc(10*piece+123);for(let i=0;i<data.length;i++)data[i]=i%251;
function encode(v){if(Number.isInteger(v))return Buffer.from('i'+v+'e');if(typeof v==='string')v=Buffer.from(v);if(v instanceof Uint8Array)return Buffer.concat([Buffer.from(v.length+':'),v]);return Buffer.concat([Buffer.from('d'),...Object.keys(v).sort().flatMap(k=>[encode(k),encode(v[k])]),Buffer.from('e')]);}
const pieces=[];for(let i=0;i<data.length;i+=piece)pieces.push(createHash('sha1').update(data.subarray(i,i+piece)).digest());
const info={name:'state.my98state',length:data.length,'piece length':piece,pieces:Buffer.concat(pieces)},hash=createHash('sha1').update(encode(info)).digest('hex'),metadata=encode({info});
const modules=new Map();for(const name of ['torrent-window','torrent-store','torrent-protocol','torrent-sources','torrent-remote','torrent-records','load-profiles','range-prefetch'])modules.set('/'+name+'.js',await readFile('src/disk/web/'+name+'.js'));
modules.set('/webtorrent.js',await readFile('build/torrent/webtorrent.min.js'));
let mode='online',phase='',active=0,maxActive=0;const requests=[],results=[];
const server=createServer((req,res)=>{
 const pathname=new URL(req.url,'http://localhost').pathname,file=modules.get(pathname);
 if(file){res.writeHead(200,{'Content-Type':'text/javascript'}).end(file);return;}
 if(pathname==='/content/'+hash+'/state.my98state'){
  if(req.method==='HEAD'){res.writeHead(mode==='offline'?503:200,{'Content-Length':data.length}).end();return;}
  const range=req.headers.range?.match(/^bytes=(\d+)-(\d+)$/);if(!range){res.writeHead(400).end();return;}
  const start=+range[1],end=Math.min(+range[2],data.length-1);requests.push({phase,mode,start,end});
  if(mode==='offline'){res.writeHead(503).end();return;}
  active++;maxActive=Math.max(maxActive,active);res.once('close',()=>active--);
  setTimeout(()=>{if(!res.destroyed)res.writeHead(206,{'Content-Length':end-start+1,'Content-Range':`bytes ${start}-${end}/${data.length}`,'Accept-Ranges':'bytes'}).end(data.subarray(start,end+1));},mode==='delayed'?(start===0?150:20):10);return;
 }
 res.writeHead(200,{'Content-Type':'text/html'}).end('<!doctype html>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+server.address().port;
const args={url,hash,metadata:Array.from(metadata),size:data.length};
async function setup(context){const page=await context.newPage();await page.goto(url);return page;}
async function transport(page,{slow=false,expectMissing=0,abort=false}={}){
 return page.evaluate(async({url,hash,metadata,size,slow,expectMissing,abort})=>{
  const {default:WebTorrent}=await import('/webtorrent.js'),{WindowTorrents}=await import('/torrent-window.js'),{TorrentPieceStore}=await import('/torrent-store.js'),{RemotePublication}=await import('/torrent-remote.js');
  if(WebTorrent.WEBRTC_SUPPORT!==false)throw Error('Expected no WebRTC');
  class SlowStore extends TorrentPieceStore{get(index,options,callback){super.get(index,options,(...args)=>setTimeout(()=>callback(...args),20));}}
  const client=new WindowTorrents({sources:{apis:[],trackers:[],webseeds:[url+'/content']},clientFactory:async()=>WebTorrent,store:slow?SlowStore:TorrentPieceStore,timeout:15000});
  const controller=new AbortController();
  try{
   const opened=await client.open({infoHash:hash,metadata:new Uint8Array(metadata),kind:'state'});
   if(opened.coveredBytes!==size-expectMissing&&expectMissing!==size)throw Error('State cache was not verified before open: '+opened.coveredBytes);
   const remote={publication:{state:hash},torrent:async()=>({size}),bytes:(infoHash,offset,length,signal)=>client.read({infoHash,offset,length},signal)};
   const input=await RemotePublication.prototype.stateInput.call(remote,controller.signal),reader=input.stream.getReader();
   if(abort){const pending=reader.read();setTimeout(()=>controller.abort(Object.assign(Error('Fixture abort'),{code:'CANCELLED'})),30);let code;try{await pending;}catch(e){code=e.code;}if(code!=='CANCELLED')throw Error('Pending/corrupt state was served or did not cancel');await new Promise(r=>setTimeout(r,250));if(client.entry(hash).readers.size!==0)throw Error('Cancelled state retained readers');return {pendingReadCancelled:true};}
   const bytes=new Uint8Array(size);let offset=0;for(;;){const {done,value}=await reader.read();if(done)break;bytes.set(value,offset);offset+=value.length;}
   if(offset!==size||!bytes.every((b,i)=>b===i%251))throw Error('Parallel/verified state bytes changed');
   return {size:offset,complete:client.describe(client.entry(hash)).complete};
  }finally{await client.close();}
 },{...args,slow,expectMissing,abort});
}
try{
 for(const [engine,type] of Object.entries({chromium,webkit})){
  const browser=await type.launch();try{
   const context=await browser.newContext();await context.addInitScript(()=>{for(const key of ['RTCPeerConnection','webkitRTCPeerConnection','mozRTCPeerConnection'])Object.defineProperty(globalThis,key,{value:undefined,configurable:true});});
   let page=await setup(context);const failures=[];page.on('pageerror',e=>failures.push(String(e)));
   const controls=await page.evaluate(async()=>{
    const {RemotePublication}=await import('/torrent-remote.js'),sleep=ms=>new Promise(r=>setTimeout(r,ms)),assert=(v,m)=>{if(!v)throw Error(m);};
    let calls=0;const source={publication:{state:'x'},torrent:async()=>({size:8*262144}),bytes:async(_hash,offset,length)=>{calls++;await sleep(offset===0?100:1);return new Uint8Array(length).fill(offset/262144);}};
    let input=await RemotePublication.prototype.stateInput.call(source),reader=input.stream.getReader();const first=reader.read();await sleep(25);assert(calls===4,'Window did not issue four distinct reads or grew past its bound');assert((await first).value[0]===0,'Out-of-order state delivery');await sleep(25);assert(calls===5,'Completed unread pieces did not retain their window slots');await reader.cancel();
    for(const action of ['signal','reader','error','short']){
     let starts=0,aborted=0;const controller=new AbortController(),unhandled=[];const observe=e=>{unhandled.push(String(e.reason));e.preventDefault();};addEventListener('unhandledrejection',observe);
     const fake={publication:{state:'x'},torrent:async()=>({size:8*262144}),bytes:(_hash,offset,length,signal)=>new Promise((resolve,reject)=>{
      starts++;signal.addEventListener('abort',()=>{aborted++;reject(signal.reason);},{once:true});
      if(action==='error'&&offset===262144)setTimeout(()=>reject(Object.assign(Error('Range failed'),{code:'FIXTURE_ERROR'})),5);
      if(action==='short'&&offset===0)setTimeout(()=>resolve(new Uint8Array(1)),5);
     })};
     input=await RemotePublication.prototype.stateInput.call(fake,controller.signal);reader=input.stream.getReader();let code;
     const pending=reader.read().catch(e=>{code=e.code;});await sleep(20);
     if(action==='signal')controller.abort(Object.assign(Error('Cancelled'),{code:'CANCELLED'}));
     if(action==='reader')await reader.cancel();await pending;await sleep(20);
     assert(starts===4&&aborted===4,'Pending parallel reads did not stop together: '+action);
     if(action!=='reader')assert(code===(action==='error'?'FIXTURE_ERROR':action==='short'?'TRANSPORT_ERROR':'CANCELLED'),'Wrong failure: '+action+' '+code);
     assert(unhandled.length===0,'Unobserved read-ahead rejection');removeEventListener('unhandledrejection',observe);
    }
    return {orderedWindow:true,boundedCompletedReads:true,cancel:true,rangeFailure:true,shortRead:true};
   });
   phase=engine+'-cold';mode='delayed';maxActive=0;const cold=await transport(page,{expectMissing:data.length});assert(maxActive>=2,'State HTTP ranges never overlapped');const concurrent=maxActive;await page.close();
   for(const stage of ['warm','offline']){
    phase=engine+'-'+stage;mode=stage==='offline'?'offline':'online';const before=requests.length;page=await setup(context);await transport(page,{slow:true});assert.equal(requests.length,before,'Verified state cache caused a GET on '+stage);await page.close();
   }
   // The state cache is persistent across pages, not merely RAM in one torrent.
   page=await setup(context);
   await page.evaluate(async({hash})=>{const {openTorrentDatabase}=await import('/torrent-store.js'),db=await openTorrentDatabase();await new Promise((resolve,reject)=>{const tx=db.transaction(['pieces'],'readwrite'),store=tx.objectStore('pieces'),get=store.get([hash,0]);get.onsuccess=()=>{const row=get.result;row.data[0]^=255;store.put(row);};tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});db.close();},{hash});
   phase=engine+'-corrupt-offline';mode='offline';await transport(page,{expectMissing:piece,abort:true});
   phase=engine+'-repair';mode='online';let before=requests.length;await transport(page,{expectMissing:piece});assert(requests.slice(before).length>0&&requests.slice(before).every(r=>r.start===0),'Corrupt cache did not repair only the bad piece');
   await page.evaluate(async({hash})=>{const {openTorrentDatabase}=await import('/torrent-store.js'),db=await openTorrentDatabase();await new Promise((resolve,reject)=>{const tx=db.transaction(['pieces'],'readwrite');tx.objectStore('pieces').delete([hash,4]);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});db.close();},{hash});
   phase=engine+'-partial';before=requests.length;await transport(page,{expectMissing:piece});assert(requests.slice(before).length>0&&requests.slice(before).every(r=>r.start===4*piece),'Partial cache fetched unrelated pieces');
   await page.evaluate(async()=>{const {clearTorrentCache}=await import('/torrent-store.js');await clearTorrentCache();});
   phase=engine+'-cancel-network';mode='delayed';before=requests.length;await transport(page,{expectMissing:data.length,abort:true});
   const admitted=requests.slice(before);assert(admitted.length>0&&admitted.every(r=>r.start<4*piece),'Cancellation refilled the state window or downloaded unrelated pieces');
   await page.evaluate(async()=>{const {clearTorrentCache}=await import('/torrent-store.js');await clearTorrentCache();});assert.deepEqual(failures,[]);await page.close();await context.close();
   results.push({engine,...controls,cold,concurrentHttp:concurrent,warmNoGets:true,offline:true,corruptOffline:true,corruptRepair:true,partialCache:true});console.log(JSON.stringify(results.at(-1)));
  }finally{await browser.close();}
 }
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));await mkdir('build/transport-retirement',{recursive:true});await writeFile('build/transport-retirement/torrent-state.json',JSON.stringify({results,requests},null,2)+'\n');}
