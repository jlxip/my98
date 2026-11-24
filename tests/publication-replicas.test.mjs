import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import bencode from 'bencode';
import {PublicationReplicas} from '../src/disk/web/publication-replicas.js';

const root='ab'.repeat(20);
const fullReceipt=id=>bencode.encode({v:1,root:Buffer.from(root,'hex'),node:Buffer.alloc(32,id),parts:[{id:Buffer.from(root,'hex'),size:100,have:100},{id:Buffer.from('cd'.repeat(20),'hex'),size:100,have:100}]});
class Wire extends EventEmitter {
    constructor(){super();this.bits=new Set();this.peerPieces={get:i=>this.bits.has(i)};this.lt_donthave=new EventEmitter();}
    use(Extension){this[Extension.prototype.name]=new Extension(this);}
    extended(name,value){this.request={name,value};}
    count(n){this.bits=new Set(Array.from({length:n},(_,i)=>i));this.emit('bitfield');}
    identify(id,{client='FeedTorrent/0.0.7-alpha',scope=root,version=1}={}){
        this.ft_replica.onExtendedHandshake({v:client,m:{ft_replica:42}});
        this.ft_replica.onMessage(bencode.encode({v:version,root:Buffer.from(scope,'hex'),node:Buffer.alloc(32,id)}));
    }
}
function fixture(t,length=100,pieceLength=1){
    const registry=new PublicationReplicas(root);t.after(()=>registry.close());
    for(const kind of ['catalog','disk'])registry.add(kind,Object.assign(new EventEmitter(),{infoHash:kind==='catalog'?root:'cd'.repeat(20),length,pieceLength,pieces:new Array(Math.ceil(length/pieceLength)),wires:[]}));
    const wire=(kind,id,n)=>{const w=new Wire();registry.attach(kind,w);if(id!==null)w.identify(id);w.count(n);return w;};
    const node=(id,n)=>[wire('catalog',id,n),wire('disk',id,n)];
    return {registry,wire,node,value:()=>registry.snapshot()};
}
test('uses the largest partial receiver, then adds complete replicas',t=>{
    const f=fixture(t);assert.equal(f.value().label,'0');const a=f.node(1,30),b=f.node(2,51);
    assert.equal(f.value().label,'0.51');b.forEach(w=>w.count(100));assert.equal(f.value().label,'1.30');
    a.forEach(w=>w.count(100));assert.equal(f.value().label,'2');
});
test('retains full copies on disconnect, excludes disconnected partial progress',t=>{
    const f=fixture(t),a=f.node(1,100),b=f.node(2,51);assert.equal(f.value().label,'1.51');
    b.forEach(w=>w.emit('close'));assert.equal(f.value().label,'1');a.forEach(w=>w.emit('close'));assert.equal(f.value().label,'1');
});
test('reconnections and duplicate wires do not add copies; explicit loss revokes completion',t=>{
    const f=fixture(t),a=f.node(1,100);a.forEach(w=>w.emit('close'));f.node(1,100);assert.equal(f.value().complete,1);
    const duplicate=f.node(1,100);assert.equal(f.value().complete,1);
    duplicate[1].count(30);assert.equal(f.value().complete,0);assert.equal(f.value().label,'0.65');
});
test('never combines different seedboxes or treats the catalog alone as a complete copy',t=>{
    const f=fixture(t);f.wire('catalog',1,100);f.wire('disk',2,100);assert.equal(f.value().complete,0);assert.equal(f.value().label,'0.50');
});
test('requires every declared component and measures the short last piece by bytes',t=>{
    const f=fixture(t,5,4);f.wire('catalog',1,2);const disk=f.wire('disk',1,1);
    assert.equal(f.value().label,'0.90');assert.equal(f.value().complete,0);disk.count(2);assert.equal(f.value().label,'1');
});
test('partial rounding cannot promote an incomplete receiver to a full copy',t=>{
    const f=fixture(t,10000,1);f.node(1,9999);assert.equal(f.value().label,'0.99');assert.equal(f.value().complete,0);
});
test('distinguishes unsupported FeedTorrent from no receivers and excludes browsers',t=>{
    const f=fixture(t),old=f.wire('disk',null,51);old.emit('extended','handshake',{v:Buffer.from('FeedTorrent/old'),m:{}});
    assert.equal(f.value().label,'—');assert.equal(f.value().unavailable,1);old.emit('close');assert.equal(f.value().label,'0');
    const browser=f.wire('disk',null,100);browser.identify(3,{client:'WebTorrent/3'});assert.equal(f.value().label,'0');assert.equal(f.value().unavailable,0);
});
test('ignores malformed, wrong-version and wrong-publication replies',t=>{
    const f=fixture(t),w=f.wire('disk',null,100);w.identify(1,{version:2});assert.equal(f.registry.nodes.size,0);
    w.identify(1,{scope:'cd'.repeat(20)});assert.equal(f.registry.nodes.size,0);
    w.ft_replica.onMessage(new Uint8Array(129));assert.equal(f.registry.nodes.size,0);
    w.identify(1);assert.equal(f.registry.nodes.size,1);assert.equal(f.value().complete,0);
});
test('a fresh publication starts at zero; closing removes listeners and timers',t=>{
    const f=fixture(t),w=f.node(1,100)[0];f.registry.close();assert.equal(w.listenerCount('bitfield'),0);
    const next=new PublicationReplicas('cd'.repeat(20));assert.equal(next.snapshot().label,'0');next.close();
});
test('accepts verified manifest progress received elsewhere, without combining machines',t=>{
    const f=fixture(t),disk=f.wire('disk',1,51);
    const report=(catalog,diskBytes=51)=>bencode.encode({v:1,root:Buffer.from(root,'hex'),node:Buffer.alloc(32,1),parts:[{id:Buffer.from(root,'hex'),size:100,have:catalog},{id:Buffer.from('cd'.repeat(20),'hex'),size:100,have:diskBytes}]});
    disk.ft_replica.onMessage(report(100));assert.equal(f.value().label,'0.75');
    disk.count(100);assert.equal(f.value().label,'1');disk.ft_replica.onMessage(report(100,0));assert.equal(f.value().label,'1');
    disk.ft_replica.onMessage(report(0));assert.equal(f.value().complete,0);
    disk.emit('close');assert.equal(f.value().label,'0');
});
test('rejects unrelated or mismatched manifest reports atomically',t=>{
    const f=fixture(t),disk=f.wire('disk',1,100);
    const parts=[{id:Buffer.from(root,'hex'),size:101,have:101},{id:Buffer.from('cd'.repeat(20),'hex'),size:100,have:100}];
    const send=()=>disk.ft_replica.onMessage(bencode.encode({v:1,root:Buffer.from(root,'hex'),node:Buffer.alloc(32,1),parts}));
    send();assert.equal(f.value().complete,0);parts[0].size=100;parts[0].have=100;parts[0].id=Buffer.alloc(20,255);send();assert.equal(f.value().complete,0);
});
test('an identity-only update preserves confirmation while measurements are unknown',t=>{
    const f=fixture(t),wires=f.node(1,100);
    for(const wire of wires)wire.identify(1);
    assert.equal(f.value().label,'1');
    assert(wires.every(wire=>wire.request.value.watch===1),'identity alone must not release a connection before fresh measurements arrive');
    wires.forEach(wire=>wire.ft_replica.onMessage(fullReceipt(1)));
    assert(wires.every(wire=>wire.request.value.watch===undefined),'fresh complete receipts release the status subscriptions');
    wires.forEach(wire=>wire.emit('close'));assert.equal(f.value().label,'1');
});
test('a peer disabling its extension during departure cannot abort transfer progress',t=>{
    const f=fixture(t),wires=f.node(1,50);
    for(const wire of wires)wire.extended=()=>{throw Error('Peer disabled extension');};
    assert.doesNotThrow(()=>wires.forEach(wire=>wire.count(100)));
    assert.doesNotThrow(()=>wires.forEach(wire=>wire.ft_replica.onMessage(fullReceipt(1))));
    assert.equal(f.value().label,'1');
});
test('a historical receipt does not hide fresh loss on a restarted connection',t=>{
    const f=fixture(t);f.node(1,100).forEach(w=>w.emit('close'));
    const reconnect=new Wire();f.registry.attach('disk',reconnect);reconnect.identify(1);
    assert.equal(f.value().label,'1');assert.equal(reconnect.request.value.watch,1);
    reconnect.count(20);assert.equal(f.value().complete,0);
});

test('a four-component publication requires state and profile on the same receiver',t=>{
    let value;const registry=new PublicationReplicas(root,v=>value=v,['disk','state','profile','catalog']);t.after(()=>registry.close());
    const hashes={disk:'cd'.repeat(20),state:'ef'.repeat(20),profile:'01'.repeat(20),catalog:root};
    for(const kind of ['disk','state','profile'])registry.expect(kind,{hash:hashes[kind],length:100,pieceLength:1,count:100});
    const torrent=new EventEmitter();Object.assign(torrent,{infoHash:root,length:100,pieceLength:1,pieces:Array(100),wires:[]});registry.add('catalog',torrent);
    const wire=new Wire();registry.attach('catalog',wire);wire.identify(1);wire.count(100);
    const send=state=>wire.ft_replica.onMessage(bencode.encode({v:1,root:Buffer.from(root,'hex'),node:Buffer.alloc(32,1),parts:Object.entries(hashes).map(([kind,id])=>({id:Buffer.from(id,'hex'),size:100,have:kind==='state'?state:100}))}));
    send(0);assert.equal(registry.snapshot().complete,0);assert.equal(registry.snapshot().label,'0.75');
    send(100);assert.equal(registry.snapshot().complete,1);wire.emit('close');assert.equal(registry.snapshot().complete,1);
});
