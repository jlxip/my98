import test from 'node:test';
import assert from 'node:assert/strict';
import bencode from 'bencode';
import {WindowTorrentPort} from '../src/disk/web/torrent-port.js';
import {metadataInfoHash} from '../src/disk/web/torrent-protocol.js';
const metadata=name=>new Uint8Array(bencode.encode({info:{name,length:1,'piece length':16384,pieces:Buffer.alloc(20)}}));
function setup(){
 const events=[],transports=[];
 const host=new WindowTorrentPort({start(){},close(){}},()=>{
  const id=transports.length,t={trackPublication(){},replicas:{close(){events.push(['tracker-close',id]);}},
   async seedPrepared({metadata:m}){events.push(['seed',id]);return {infoHash:await metadataInfoHash(m)};},
   async referencePublication(){events.push(['reference',id]);},async releaseSeed(hash){events.push(['release',id,hash]);},async close(){events.push(['close',id]);}};
  transports.push(t);return t;
 });
 const call=(session,op,args={})=>host.execute(op,{session,...args},new AbortController().signal);
 return {host,events,call};
}
test('handover preserves shared seed handles and releases each component at its last owner',async()=>{
 const {host,events,call}=setup(),a='publication:1',b='publication:2';
 const disk=metadata('disk.my98'),old=metadata('old-catalog'),next=metadata('new-catalog'),hash=await metadataInfoHash(disk);
 await call(a,'create',{root:'ab'.repeat(20)});await call(a,'seed',{metadata:disk});await call(a,'seed',{metadata:old});
 await call(b,'create',{root:'cd'.repeat(20)});await call(b,'reference',{infoHash:hash,metadata:disk});await call(b,'seed',{metadata:next});
 await call(a,'close');assert(!events.some(e=>e[0]==='release'&&e[2]===hash));assert(!events.some(e=>e[0]==='close'&&e[1]===0));assert.equal(host.retired.size,1);
 await call(b,'close');assert.equal(events.filter(e=>e[0]==='release'&&e[2]===hash).length,1);assert.equal(events.filter(e=>e[0]==='close').length,2);assert.equal(host.retired.size,0);assert.equal(host.publicationSeeds.size,0);
 await host.close();
});
test('identical prepared seeds share a handle and candidate cancellation cannot close the reader',async()=>{
 const {host,events,call}=setup(),m=metadata('disk.my98');
 await call('torrent:1','create');await call('publication:1','create',{root:'ab'.repeat(20)});await call('publication:1','seed',{metadata:m});
 await call('publication:2','create',{root:'cd'.repeat(20)});await call('publication:2','seed',{metadata:m});
 assert.equal(events.filter(e=>e[0]==='seed').length,1);
 await call('publication:2','close');assert(!events.some(e=>e[0]==='release'));assert(host.sessions.has('torrent:1'));
 await call('publication:1','close');assert.equal(events.filter(e=>e[0]==='release').length,1);assert(host.sessions.has('torrent:1'));
 await host.close();assert.equal(events.filter(e=>e[0]==='close').length,3);
});

test('a late reference after candidate closure cannot retain an orphaned seed owner',async()=>{
 const {host,call}=setup(),m=metadata('disk.my98'),hash=await metadataInfoHash(m);
 await call('publication:1','create',{root:'ab'.repeat(20)});await call('publication:1','seed',{metadata:m});
 await call('publication:2','create',{root:'cd'.repeat(20)});let release;
 host.sessions.get('publication:2').referencePublication=()=>new Promise(resolve=>{release=resolve;});
 const pending=call('publication:2','reference',{metadata:m,infoHash:hash});
 await call('publication:2','close');release();await assert.rejects(pending,{code:'CANCELLED'});
 assert.deepEqual([...host.publicationSeeds.get(hash).owners],['publication:1']);await host.close();
});
