import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {chromium,webkit} from 'playwright';
const raw=Buffer.concat([Buffer.from('d6:lengthi1e4:name9:disk.my9812:piece lengthi262144e6:pieces20:'),Buffer.alloc(20,1),Buffer.from('e')]);
const hash=createHash('sha1').update(raw).digest('hex'),metadata=Buffer.concat([Buffer.from('d4:info'),raw,Buffer.from('e')]);
const files=new Map();
for(const name of ['torrent-window','torrent-store','torrent-protocol','torrent-sources'])files.set('/'+name+'.js',await readFile('src/disk/web/'+name+'.js'));
files.set('/torrent/webtorrent.min.js',await readFile('build/torrent/webtorrent.min.js'));
let current;const unexpected=[];
const servers=Array.from({length:3},(_,index)=>createServer((req,res)=>{
    res.setHeader('Access-Control-Allow-Origin','*');
    if(files.has(req.url)){res.setHeader('Content-Type','text/javascript');res.end(files.get(req.url));return;}
    if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html>');return;}
    if(req.url==='/favicon.ico'){res.writeHead(404).end();return;}
    if(req.url!=='/v2/info/'+hash){unexpected.push(req.url);res.writeHead(404).end();return;}
    const sample=current;sample.requests[index]++;
    if(index===0) {
        const timer=setTimeout(()=>{sample.slowCompleted=true;res.end(raw);},2000);
        res.once('close',()=>{clearTimeout(timer);if(!res.writableFinished)sample.slowCancelled++;});
    } else if(index===1)res.end('de');
    else sample.fast=res;
    // Hold the valid reply until every source has received its request. This
    // proves parallel dispatch and makes cancellation observable on the server.
    if(sample.fast&&sample.requests.every(Boolean))sample.fast.end(raw);
}));
await Promise.all(servers.map(server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))));
const apis=servers.map(server=>'http://127.0.0.1:'+server.address().port);
try {
    for(const [engine,type] of Object.entries({chromium,webkit})) {
        current={requests:[0,0,0],slowCancelled:0,slowCompleted:false,fast:null};
        const browser=await type.launch();
        try {
            const page=await browser.newPage();await page.goto(apis[0]+'/');
            const result=await page.evaluate(async({apis,hash,expected})=>{
                const {WindowTorrents}=await import('/torrent-window.js');
                const client=new WindowTorrents({sources:{apis,trackers:[],webseeds:[]}});
                try {
                    const value=await client.discoverMetadata(hash,'disk');
                    return {valid:value.length===expected.length&&value.every((byte,index)=>byte===expected[index]),pending:client.discoveries.size};
                } finally {await client.close();}
            },{apis,hash,expected:[...metadata]});
            assert(result.valid);assert.equal(result.pending,0);assert.deepEqual(current.requests,[1,1,1]);assert(!current.slowCompleted);
            for(let i=0;i<100&&!current.slowCancelled;i++)await new Promise(resolve=>setTimeout(resolve,20));
            assert.equal(current.slowCancelled,1);assert.deepEqual(unexpected,[]);
            console.log(JSON.stringify({engine,allThreeSourcesStarted:true,invalidFastReplyRejected:true,validLaterSourceWon:true,slowSourceCancelled:true,noPayloadRequests:true}));
        } finally {await browser.close();}
    }
} finally {
    await Promise.all(servers.map(server=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));}));
}
