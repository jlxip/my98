import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {createPublicKey,verify,randomBytes} from 'node:crypto';
import {chromium,webkit} from 'playwright';
const assets=JSON.parse(await readFile('scripts/site-assets.json','utf8'));
assets['_agent/network.js']='scripts/agent/network.js';
const server=createServer(async(req,res)=>{
    res.setHeader('Cross-Origin-Opener-Policy','same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
    try{
        if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Agent network fixture</title>');return;}
        const file=assets[req.url.slice(1)];if(!file){res.writeHead(404).end();return;}
        res.setHeader('Content-Type',file.endsWith('.js')||file.endsWith('.mjs')?'text/javascript':file.endsWith('.wasm')?'application/wasm':'application/octet-stream');
        res.end(await readFile(file));
    }catch{res.writeHead(500).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
const url='wss://agent-fixture.invalid/my98-relay/v1';
const framed=bytes=>{const n=Buffer.alloc(4);n.writeUInt32BE(bytes.length);return Buffer.concat([n,bytes]);};
try{for(const [name,type] of Object.entries({chromium,webkit})){
    const browser=await type.launch();
    try{
        const page=await browser.newPage(),errors=[],sockets=[];let accepted=0;
        page.on('pageerror',e=>errors.push(String(e)));
        await page.routeWebSocket(url,route=>{
            sockets.push(route);let publicKey,challenge;
            route.onMessage(message=>{
                try{
                    const value=JSON.parse(String(message));
                    if(value.type==='hello'){
                        publicKey=Buffer.from(value.publicKey,'hex');assert.equal(publicKey.length,32);
                        challenge={type:'challenge',url,origin,nonce:randomBytes(32).toString('hex'),expires:Math.floor(Date.now()/1000)+10};
                        route.send(JSON.stringify(challenge));
                    }else if(value.type==='authenticate'){
                        const expiry=Buffer.alloc(8);expiry.writeBigUInt64BE(BigInt(challenge.expires));
                        const bytes=Buffer.concat([Buffer.from('my98/relay-challenge/v1\0'),...[publicKey,Buffer.from(url),Buffer.from(origin),Buffer.from(challenge.nonce,'hex'),expiry].map(framed)]);
                        const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),publicKey]),format:'der',type:'spki'});
                        assert(verify(null,bytes,key,Buffer.from(value.signature,'hex')),'independent Ed25519 signature verification');
                        accepted++;route.send('{"type":"ready"}');
                    }else throw Error('Unexpected relay message');
                }catch(error){errors.push(String(error));route.close({code:1008,reason:'Fixture rejection'});}
            });
        });
        await page.goto(origin);
        const login=await page.evaluate(async url=>{
            const {AgentNetwork}=await import('/_agent/network.js');
            window.network=new AgentNetwork();
            // The relay is attached to this existing bus; no VM constructor is used.
            window.handlers=new Map();window.vm={marker:crypto.randomUUID(),ram:new Uint8Array([3,1,4]),bus:{register:(name,fn)=>handlers.set(name,fn),unregister:name=>handlers.delete(name),send(){}}};
            window.before={marker:vm.marker,ram:Array.from(vm.ram)};
            return network.login(vm,{username:'agent network fixture',password:'public test password',machine:'main',relayURL:url});
        },url);
        assert.match(login.publicKey,/^[a-f0-9]{64}$/);
        await page.waitForFunction(()=>network.status().state==='online');assert.equal(accepted,1);
        const current=sockets.at(-1);current.close({code:1012,reason:'Fixture interruption'});
        await page.waitForFunction(()=>network.status().state==='online'&&vm.network_adapter.generation>1);
        assert.equal(accepted,2);
        const check=await page.evaluate(async()=>{
            const same=before.marker===vm.marker&&JSON.stringify(before.ram)===JSON.stringify(Array.from(vm.ram));
            let invalid=false;try{await network.login(vm,{username:'x',password:'x',machine:'x',relayURL:'ws://insecure.invalid/my98-relay/v1'});}catch{invalid=true;}
            const intact=network.state==='online';
            await network.logout();return {same,invalid,intact,state:network.state,listeners:handlers.size,adapterClosed:vm.network_adapter.closed};
        });
        assert.deepEqual(check,{same:true,invalid:true,intact:true,state:'identity-closed',listeners:0,adapterClosed:true});
        assert.deepEqual(errors,[]);console.log(name+': signed authentication, automatic recovery, same VM/RAM, invalid URL isolation and logout PASS');
    }finally{await browser.close();}
}}finally{await new Promise(resolve=>server.close(resolve));}
