import assert from 'node:assert/strict';
import test from 'node:test';
import {RelayNetworkAdapter} from '../src/browser/relay-network.js';
class Socket {
    static list=[];
    constructor(url,protocol){this.url=url;this.protocol=protocol;this.readyState=0;this.bufferedAmount=0;this.sent=[];Socket.list.push(this);}
    send(data){this.sent.push(data);}
    close(){this.readyState=3;}
    open(){this.readyState=1;this.onopen();}
    async message(data){await this.onmessage({data});}
}
test('Ethernet is gated by ready; reconnect keeps the bus, explicit policy retry, teardown',async()=>{
    Socket.list=[];const received=[],states=[];let handler,removed=false;
    const bus={register(name,fn){handler=fn;},unregister(name,fn){assert.equal(fn,handler);removed=true;},send(name,frame){received.push(frame);}};
    const origin='https://my98.lol',url='wss://relay.example/my98-relay/v1';
    const signer={relayPublicKey:async()=>new Uint8Array(32),signRelayChallenge:async()=>new Uint8Array(64)};
    const adapter=new RelayNetworkAdapter(bus,{url,signer,origin,onState:s=>states.push(s),WebSocketClass:Socket});
    await new Promise(r=>setImmediate(r));
    const first=Socket.list[0];first.open();handler(new Uint8Array(42));assert.equal(first.sent.length,1);
    await first.message(JSON.stringify({type:'challenge',url,origin,nonce:'42'.repeat(32),expires:Math.floor(Date.now()/1000)+10}));
    handler(new Uint8Array(42));assert.equal(first.sent.length,2);
    await first.message('{"type":"ready"}');handler(new Uint8Array(42));assert.equal(first.sent.length,3);
    await first.message(new Uint8Array(42).buffer);assert.equal(received.length,1);
    first.onclose({code:1008});assert.equal(adapter.status,'rejected');assert.equal(adapter.retryTimer,undefined);
    await adapter.retry();const second=Socket.list[1];assert.notEqual(first,second);assert.equal(removed,false);
    await first.message(new Uint8Array(42).buffer);assert.equal(received.length,1);
    second.open();second.onclose({code:1006});assert.equal(adapter.status,'offline');assert.equal(adapter.delay,2000);
    adapter.destroy();assert.equal(removed,true);assert.equal(adapter.signer,undefined);
    assert.deepEqual(states.slice(0,3),['connecting','online','rejected']);
});
test('misbound challenge never calls the signer',async()=>{
    let signed=0;const bus={register(){},unregister(){}};
    const adapter=new RelayNetworkAdapter(bus,{url:'wss://relay.example/my98-relay/v1',origin:'https://my98.lol',WebSocketClass:Socket,
        signer:{relayPublicKey:async()=>new Uint8Array(32),signRelayChallenge:async()=>{signed++;}}});
    await new Promise(r=>setImmediate(r));const ws=Socket.list.at(-1);ws.open();
    await ws.message(JSON.stringify({type:'challenge',url:'wss://evil.example/my98-relay/v1',origin:'https://my98.lol',nonce:'00'.repeat(32),expires:Math.floor(Date.now()/1000)+10}));
    assert.equal(signed,0);assert.equal(adapter.status,'rejected');adapter.destroy();
});
test('discovery is repeated after transient failure; identity closure cancels discovery without opening a socket',async()=>{
    Socket.list=[];let discoveries=0,closed,signal;
    const adapter=new RelayNetworkAdapter({register(){},unregister(){}},{origin:'https://my98.lol',WebSocketClass:Socket,
        signer:{relayPublicKey:async()=>new Uint8Array(32),onClosed:fn=>{closed=fn;return()=>{};}},
        resolveURL:async s=>{signal=s;discoveries++;return 'wss://found.example/my98-relay/v1';}});
    await new Promise(r=>setImmediate(r));assert.equal(Socket.list[0].url,'wss://found.example/my98-relay/v1');
    await adapter.retry();assert.equal(discoveries,2);closed();assert(signal.aborted);assert.equal(adapter.closed,true);
    let resolve;
    const waiting=new RelayNetworkAdapter({register(){},unregister(){}},{WebSocketClass:Socket,
        signer:{relayPublicKey:async()=>new Uint8Array(32)},resolveURL:()=>new Promise(r=>{resolve=r;})});
    await new Promise(r=>setImmediate(r));waiting.destroy();resolve('wss://late.example/my98-relay/v1');
    await new Promise(r=>setImmediate(r));assert.equal(Socket.list.length,2);
});
