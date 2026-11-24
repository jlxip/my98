import test from 'node:test';
import assert from 'node:assert/strict';
import {DiskSession} from '../src/browser/disk-session.js';
import {WorkerProtocol} from '../src/disk/web/worker-protocol.js';
const description=(sequence='1',hash='a',sourceId='old')=>({size:512,dirty_bytes:0,remote:{following:true,sequence,publicationInfoHash:hash,sourceId}});
function fixture() {
 const logs=[],host={preparePublicationUpdate:async(view,mode)=>{logs.push('prepare '+mode);return {adapter:{}};},pausePublicationUpdate:async()=>{logs.push('pause');return {};},resumePublicationUpdate:async()=>logs.push('resume'),discardPublicationUpdate:async()=>logs.push('discard VM'),installPublicationUpdate:async()=>logs.push('install')};
 const session=new DiskSession(host);session.description=description();session.client={describe:async()=>session.description,prepareRemoteUpdate:async()=>({token:1,description:description('2','b','new')}),remoteUpdateDisk:()=>({}),commitRemoteUpdate:async()=>{logs.push('commit');return description('2','b','new');},discardRemoteUpdate:async()=>logs.push('discard token'),cancel(){}};
 session.observePublication({sourceId:'old',sequence:'2',infoHash:'b'});return {session,host,logs};
}
test('automatic replacement is limited to unused, clean, named sessions',()=>{
 const {session}=fixture();assert(session.automaticUpdate);session.usedForVm=true;assert(!session.automaticUpdate);
 session.publication.infoHash='a';assert(session.automaticUpdate);session.publication.infoHash='b';session.usedForVm=false;session.description.dirty_bytes=1;assert(!session.automaticUpdate);
 session.description.remote.following=false;assert(!session.pendingPublication);
});
test('events coalesce monotonically and stale sources cannot replace current events',()=>{
 const {session}=fixture();session.observePublication({sequence:'3',infoHash:'c',sourceId:'old'});session.observePublication({sequence:'2',infoHash:'b',sourceId:'old'});
 assert.equal(session.pendingPublication.sequence,'3');assert.equal(session.observePublication({sequence:'9',sourceId:'retired'}),false);assert.equal(session.pendingPublication.sequence,'3');
});
test('Boot and local restoration mark used before their first asynchronous work',async()=>{
 const {session,host}=fixture();let release;session.client.setLoadPrefetch=()=>new Promise(r=>release=r);session.client.read=async()=>new Uint8Array(512);session.BufferClass=class {};
 host.boot=async()=>{};const boot=session.boot();assert(session.usedForVm);assert.equal(session.remoteMode,'boot');assert(!session.automaticUpdate);release();await boot;
 host.restoreState=async()=>({adapter:{},description:session.description});await session.restoreState({publication:true});assert.equal(session.remoteMode,'resume');await session.restoreState(new Blob());assert.equal(session.remoteMode,'resume');
});
test('restart preserves remote mode and commits only after preparing VM and draining old VM',async()=>{
 const {session,logs}=fixture();session.usedForVm=true;session.remoteMode='resume';await session.updatePublication({restart:true,discardChanges:true});
 assert.deepEqual(logs,['prepare resume','pause','commit','install','discard token']);assert.equal(session.description.remote.sequence,'2');assert.equal(session.remoteMode,'resume');
});
test('a newer signed version during commit re-prepares the complete candidate',async()=>{
 const {session,logs}=fixture();let calls=0;session.client.commitRemoteUpdate=async()=>{if(!calls++){session.observePublication({sourceId:'old',sequence:'3',infoHash:'c'});throw Object.assign(Error('Newer version'),{code:'PUBLICATION_CHANGED'});}return description('3','c','new');};
 await session.updatePublication({restart:true,discardChanges:true});assert.equal(calls,2);assert(logs.includes('discard VM')&&logs.includes('resume'));assert.equal(session.description.remote.sequence,'3');
});
for(const code of ['NO_PUBLISHED_STATE','CANCELLED','TRANSPORT_ERROR','PUBLICATION_UNAVAILABLE'])test(code+' preserves the old VM and makes the update manually retryable',async()=>{
 const {session,host,logs}=fixture(),before=session.description;session.usedForVm=true;session.active=true;host.preparePublicationUpdate=async()=>{throw Object.assign(Error(code),{code});};
 await assert.rejects(session.updatePublication({restart:true}),{code});assert.equal(session.description,before);assert(session.active);assert.equal(session.failedUpdate,'2');assert(!logs.includes('commit'));assert(logs.includes('discard token'));
});
test('same catalog metadata update never touches a running machine',async()=>{
 const {session,logs}=fixture();session.usedForVm=true;session.publication.infoHash='a';session.client.prepareRemoteUpdate=async()=>({unchanged:true,description:description('2')});await session.updatePublication();assert.deepEqual(logs,[]);assert.equal(session.description.remote.sequence,'2');
});

test('an update believed metadata-only cannot silently swap a used VM after a newer record races it',async()=>{
 const {session,logs}=fixture();session.usedForVm=true;session.publication.infoHash='a';assert(session.automaticUpdate);
 await assert.rejects(session.updatePublication(),{code:'SESSION_USED'});assert.equal(session.description.remote.sequence,'1');assert(!logs.includes('commit'));
});
test('callbacks from a previous identity generation are ignored',()=>{
 const {session}=fixture(),old=session.publicationEvents();session.publicationEvents();old.onPublication({sequence:'9',sourceId:'old'});assert.equal(session.pendingPublication.sequence,'2');
});

for(const active of [false,true])test('publication cancellation preserves queued guest reads ('+(active?'active':'queued')+')',async()=>{
 const previous=globalThis.self,replies=[];globalThis.self={postMessage:value=>replies.push(value)};
 let entered,globalCancels=0;const started=new Promise(r=>entered=r);
 const protocol=new WorkerProtocol({ready:Promise.resolve(),getInitError:()=>null,onRequest(){},onCancel(){globalCancels++;},onCancelled(){globalCancels++;},execute:async op=>{
  if(op==='read')return 77;entered();await new Promise((resolve,reject)=>protocol.signal.addEventListener('abort',()=>reject(Error('Aborted')),{once:true}));
 }});
 try {
  protocol.handle({id:1,op:'prepareRemoteUpdate',args:{},epoch:0,publicationEpoch:0});
  if(active)await started;
  protocol.handle({id:2,op:'read',args:{},epoch:0,publicationEpoch:0});protocol.handle({op:'cancelRemoteUpdate',epoch:1});await protocol.sequence;
  assert.equal(replies[0].error.code,'CANCELLED');assert.deepEqual(replies[1],{id:2,ok:true,result:77});assert.equal(globalCancels,0);
 } finally {globalThis.self=previous;}
});
