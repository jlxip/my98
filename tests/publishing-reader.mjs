/** Cold, shipped Worker/transport reader with one transient gateway failure. */
import assert from 'node:assert/strict';
import {quietAudio} from './pages/server.mjs';

export async function coldReader(browser,{site,gateway,tracker}) {
    const context=await browser.newContext({ignoreHTTPSErrors:true});
    await context.addInitScript(quietAudio);
    await context.addInitScript(()=>{
        const Original=RTCPeerConnection;
        globalThis.RTCPeerConnection=new Proxy(Original,{construct(T,args,N){args[0]={...args[0],iceServers:[]};return Reflect.construct(T,args,N);}});
    });
    let requests=0;const legacy=[];
    context.on('request',request=>{if(/\/v2\/|\/content\//.test(request.url()))legacy.push(request.url());});
    await context.route(gateway.url+'/dht/mutable/**',route=>{
        if(++requests===1)return route.fulfill({status:200,contentType:'text/event-stream',headers:{'Access-Control-Allow-Origin':'*'},body:'event: done\ndata: '+JSON.stringify({record:null,error:{status:503,message:'DHT gateway unavailable'}})+'\n\n'});
        return route.continue();
    });
    const page=await context.newPage();page.setDefaultTimeout(120000);
    await page.goto(tracker.page);await page.goto(gateway.page);await page.goto(site.url);await page.waitForFunction(()=>!document.body.inert);
    await page.evaluate(async()=>{
        const {Slop86Disk}=await import('/build/disk/web/client.js'),create=Slop86Disk.create;
        window.readerWires=[];
        Slop86Disk.create=async function(...args){
            const client=await create.apply(this,args);window.readerDisk=client;
            const make=client.torrentHost.createTransport;
            client.torrentHost.createTransport=(...args)=>{
                const transport=make(...args),factory=transport.clientFactory;
                transport.clientFactory=async()=>{
                    const Original=await factory();
                    return class extends Original {add(...args){const torrent=super.add(...args);torrent.on('wire',wire=>readerWires.push(wire.type));return torrent;}};
                };
                return transport;
            };
            return client;
        };
    });
    return {context,page,async verify(){
        assert.deepEqual(legacy,[],'Reader used a retired transport endpoint');
        assert(requests>=2,'Shipped Worker did not recover from the transient SSE503');
        const wires=await page.evaluate(()=>readerWires);
        assert(wires.length>0&&wires.every(type=>type==='webrtc'),'Expected only real WebRTC payload wires: '+JSON.stringify(wires));
        return {transientSSE503Recovered:true,webRTCOnly:true,noLegacyRequests:true,requests};
    }};
}

export async function unavailableReader(browser,{site,tracker}) {
    const context=await browser.newContext({ignoreHTTPSErrors:true});
    try {
        const page=await context.newPage();await page.goto(tracker.page);await page.goto(site.url);await page.waitForFunction(()=>!document.body.inert);
        const code=await page.evaluate(async tracker=>{
            const {Slop86Disk}=await import('/build/disk/web/client.js');
            const client=await Slop86Disk.create();
            const transport=client.torrentHost.createTransport({gateways:[],trackers:[tracker]},()=>{});transport.timeout=500;
            try{await transport.open({infoHash:'0'.repeat(40),kind:'catalog'});return 'UNEXPECTED_SUCCESS';}
            catch(error){return error.code;}
            finally{await transport.close();await client.close();}
        },tracker.url);
        assert.equal(code,'TRANSPORT_TIMEOUT','An uncached unavailable publication must fail without inventing data');
        return true;
    } finally {await context.close();}
}
