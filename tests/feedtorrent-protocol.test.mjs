import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyMetadata,verifyCatalogItem,verifyCatalogSource,parseRecord,compareRecords,sequence,unhex} from '../src/disk/web/torrent-protocol.js';
import {torrentSources} from '../src/disk/web/torrent-sources.js';
import {encode,sha1,key,record,torrent,catalog,checkSignature} from './feedtorrent-fixture.mjs';
const disk=torrent(Buffer.alloc(32769,7)),feed=catalog([['disk.torrent',disk]]);
const check=(t,kind)=>verifyMetadata(t.metadata,t.hash,kind);

test('standard BEP49 root authenticates child metadata and exact file role',async()=>{
    const root=await check(feed,'catalog');assert.equal(root.pieceLength,16384);assert.equal(root.totalLength,feed.bytes.length);
    verifyCatalogSource(root.source,key);const child=await verifyCatalogItem(feed.bytes,root.items[0]);
    assert.equal(child.infoHash,disk.hash);assert.equal(child.size,32769);assert.equal(child.pieceLength,16384);
    await assert.rejects(()=>verifyCatalogItem(Buffer.from(feed.bytes).fill(0,10,11),root.items[0]),/checksum/);
    assert.throws(()=>verifyCatalogSource(root.source,'ff'.repeat(32)),/identity/);
});
test('gateway wire preserves signed extension fields and full i64 sequences',()=>{
    for(const seq of ['0','9','10','9007199254740994','9223372036854775807']) {
        const wire=record(feed.hash,seq,{extension:[Buffer.from('signed extension'),9223372036854775807n]});const parsed=parseRecord(JSON.stringify(wire),key,checkSignature);
        assert.equal(parsed.sequence,seq);assert.equal(parsed.infoHash,feed.hash);assert.equal(parsed.value,wire.value);
    }
    const a=parseRecord(JSON.stringify(record(feed.hash,'9')),key,checkSignature),b=parseRecord(JSON.stringify(record(feed.hash,'10')),key,checkSignature);
    assert(compareRecords(a,b));assert.throws(()=>compareRecords(b,a),{code:'PUBLICATION_CONFLICT'});
    const conflict=parseRecord(JSON.stringify(record(feed.hash,'10',{extension:Buffer.from('different signed record')})),key,checkSignature);
    assert.throws(()=>compareRecords(b,conflict),{code:'PUBLICATION_CONFLICT'});
    for(const seq of ['01','-1','9223372036854775808','1.0',3])assert.throws(()=>sequence(seq));
    assert.throws(()=>unhex('abc',1.5));
    assert.throws(()=>parseRecord(JSON.stringify({...record(feed.hash),sequence:'9007199254740995'}),key,checkSignature),/signature/);
});
test('catalog rejects unknown roles, duplicates, absent disk and unsafe paths',async()=>{
    for(const entries of [[['other.torrent',disk]],[['state.torrent',disk]],[['disk.torrent',disk],['disk.torrent',disk]],[['../disk.torrent',disk]]])await assert.rejects(()=>check(catalog(entries),'catalog'),{code:'INVALID_PUBLICATION'});
    await assert.rejects(()=>verifyMetadata(feed.metadata,'ff'.repeat(20),'catalog'),/infohash/);
    const legacy=torrent(Buffer.from('{"version":1}'),'publication.json');await assert.rejects(()=>check(legacy,'catalog'));
});
test('single useful multifile component supports padding and variable piece sizes',async()=>{
    const bytes=Buffer.concat([Buffer.alloc(16384),disk.bytes]);
    const info={name:'disk',files:[{attr:'p',length:16384,path:['.pad','16384']},{length:disk.bytes.length,path:['disk.my98']}],'piece length':65536,pieces:sha1(bytes)};
    const parsed=await verifyMetadata(encode({info}),sha1(encode(info)).toString('hex'),'disk');assert.equal(parsed.payloadOffset,16384);assert.equal(parsed.size,disk.bytes.length);assert.equal(parsed.totalLength,bytes.length);
    for(const piece of [0,12345,256*1024*1024]){const changed={...info,'piece length':piece};await assert.rejects(()=>verifyMetadata(encode({info:changed}),sha1(encode(changed)).toString('hex'),'disk'));}
});
test('only configured HTTPS gateways and WebRTC signaling are accepted',()=>{
    assert.deepEqual(torrentSources({gateways:['https://gateway.test/','https://gateway.test'],trackers:['wss://tracker.test/announce']}),{gateways:['https://gateway.test'],trackers:['wss://tracker.test/announce']});
    assert.throws(()=>torrentSources({apis:['https://old.test'],webseeds:[]}));assert.throws(()=>torrentSources({gateways:['http://outside.test'],trackers:[]}));
    assert.throws(()=>torrentSources({gateways:[],trackers:['https://tracker.test']}));
});
