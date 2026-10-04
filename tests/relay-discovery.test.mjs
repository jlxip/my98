import assert from 'node:assert/strict';
import test from 'node:test';
import {discoverRelay} from '../src/disk/web/relay-discovery.js';
import {DEFAULT_SERVERS} from '../src/disk/web/network-config.js';
const source=url=>({url,resolution:'routing',discovery:true,seeder:true});
const announcement=url=>({version:1,relay:{url,protocol:'my98-relay.v1',authorization:'ed25519-allowlist'}});
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
test('service discovery uses query sources and verified providers, accepts the first valid announcement',async()=>{
    assert(DEFAULT_SERVERS.every(s=>!('relay' in s)));
    const requests=[];
    const url=await discoverRelay({servers:[source('https://slow.example'),source('https://off.example'),{url:'https://public-query.example',resolution:'routing',discovery:true}],gateways:['https://provider.example'],
        fetcher:async(url,options)=>{
            requests.push({url,options});
            if(url.includes('off.example'))return json({version:1,relay:null});
            if(url.includes('slow.example'))return json(announcement('wss://wrong.example/my98-relay/v1'));
            return json(announcement('wss://provider.example/my98-relay/v1'));
        }});
    assert.equal(url,'wss://provider.example/my98-relay/v1');
    assert.equal(requests.length,3);
    assert(requests.every(r=>r.url.endsWith('/.well-known/my98-relay.json') && r.options.redirect==='error' && r.options.credentials==='omit'));
    assert(requests.every(r=>r.options.signal.aborted));
});
test('rejects cross-origin/port, public authentication, plaintext, credentials, malformed and oversized announcements',async()=>{
    for(const value of [announcement('wss://elsewhere.example/my98-relay/v1'),announcement('wss://seeder.example:444/my98-relay/v1'),
        announcement('ws://seeder.example/my98-relay/v1'),announcement('wss://user@seeder.example/my98-relay/v1'),
        announcement('wss://seeder.example/my98-relay/v1?x=1'),{version:1,relay:{...announcement('wss://seeder.example/my98-relay/v1').relay,authorization:'public'}},
        {version:2,relay:null},{padding:'x'.repeat(4096)}]) {
        await assert.rejects(discoverRelay({servers:[source('https://seeder.example')],fetcher:async()=>json(value)}));
    }
    await assert.rejects(discoverRelay({servers:[source('https://seeder.example')],fetcher:async()=>new Response('<html>',{headers:{'content-type':'text/html'}})}));
    let cancelled=false;
    await assert.rejects(discoverRelay({servers:[source('https://seeder.example')],fetcher:async()=>new Response(new ReadableStream({
        start(c){c.enqueue(new Uint8Array(4097));},cancel(){cancelled=true;}
    }),{headers:{'content-type':'application/json'}})}));
    assert(cancelled);
});
test('bounded timeout and identity cancellation stop outstanding discovery without any fallback',async()=>{
    const hanging=async(url,{signal})=>new Promise((resolve,reject)=>{
        const abort=()=>reject(new DOMException('Aborted','AbortError'));
        signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    });
    await assert.rejects(discoverRelay({servers:[source('https://seeder.example')],timeout:20,fetcher:hanging}));
    const controller=new AbortController();controller.abort();
    await assert.rejects(discoverRelay({servers:[source('https://seeder.example')],signal:controller.signal,fetcher:hanging}));
});
