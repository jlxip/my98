import {execFileSync, spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {readFile, writeFile, mkdir, mkdtemp, rm, open} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createIPNSRecord, marshalIPNSRecord} from 'ipns';
import {generateKeyPair} from '@libp2p/crypto/keys';
export const repo=fileURLToPath(new URL('../../../',import.meta.url));
const compat=resolve(repo,'build/disk-target/release/examples/compat');
export async function fixture({small:customSmall} = {}) {
    const out=resolve(repo,'build/ipfs');await mkdir(out,{recursive:true});
    const binary=process.env.KUBO_BINARY || resolve(repo,'build/ipfs-tools/kubo/ipfs');
    if(!existsSync(binary)) throw Error('Set KUBO_BINARY to an installed Kubo executable.');
    const directory=await mkdtemp(resolve(out,'kubo-'));
    const env={...process.env,IPFS_PATH:directory};
    const logPath=resolve(out,basename(directory)+".log");
    const ipfs=(...args)=>execFileSync(binary,args,{env,encoding:'utf8',maxBuffer:8*1048576});
    let daemon, proxy, log;
    try {
        if(!existsSync(resolve(out,'large.json'))) {
            const source=resolve(out,'large.img'),file=resolve(out,'large.my98');
            const handle=await open(source,'w');await handle.truncate(1073741824);await handle.close();
            const result=execFileSync(compat,['pack',source,file],{cwd:repo,encoding:'utf8'});
            await writeFile(resolve(out,'large.json'),result);
        }
        const large=JSON.parse(await readFile(resolve(out,'large.json'),'utf8'));
        const small=customSmall || JSON.parse(await readFile(resolve(repo,'build/disk/native.json'),'utf8'))[0];
        ipfs('init','--profile=test');
        ipfs('config','Addresses.API','/ip4/127.0.0.1/tcp/0');
        ipfs('config','Addresses.Gateway','/ip4/127.0.0.1/tcp/0');
        ipfs('config','--json','Bootstrap','[]');
        ipfs('config','--json','Gateway.HTTPHeaders.Access-Control-Allow-Origin','["*"]');
        const add=(path,...args)=>ipfs('add','--offline','-Q','--pin=true',...args,resolve(repo,path)).trim();
        const cid0=add(small.file,'--cid-version=0','--raw-leaves=false');
        const cid1=add(small.file,'--cid-version=1','--raw-leaves=true');
        const largeCid=add(large.file,'--cid-version=1','--raw-leaves=true');
        const directoryCid=add(small.file,'--cid-version=1','--wrap-with-directory');
        const identity=JSON.parse(execFileSync(compat,['identity'],{cwd:repo,encoding:'utf8'}));
        const key={type:'Ed25519',sign:async bytes=>new Uint8Array(Buffer.from(execFileSync(compat,['sign',Buffer.from(bytes).toString('hex')],{cwd:repo,encoding:'utf8'}).trim(),'hex'))};
        const record=async(cid,seq=1,lifetime=3600000,signer=key)=>marshalIPNSRecord(await createIPNSRecord(signer,`/ipfs/${cid}`,BigInt(seq),lifetime,{v1Compatible:false}));
        const records={small:await record(cid0),v1:await record(cid1),large:await record(largeCid),path:await record(directoryCid+'/'+basename(small.file)),expired:await record(cid0,1,-60000),wrong:await record(cid0,1,3600000,await generateKeyPair('Ed25519'))};
        const recordPath=resolve(directory,'record.ipns');await writeFile(recordPath,records.small);
        ipfs('routing','put','--allow-offline',`/ipns/${identity.ipnsName}`,recordPath);
        log=await open(logPath,'w');
        daemon=spawn(binary,['daemon','--offline'],{env,stdio:['ignore',log.fd,log.fd]});
        let gateway;
        for(let i=0;i<200;i++) {
            if(daemon.exitCode!==null)throw Error('Kubo exited before ready');
            const text=await readFile(logPath,'utf8');
            const match=/Gateway server listening on \/ip4\/127\.0\.0\.1\/tcp\/(\d+)/.exec(text);
            if(match && text.includes('Daemon is ready')) {gateway="http://127.0.0.1:"+match[1];break;}
            await new Promise(r=>setTimeout(r,50));
        }
        if(!gateway)throw Error('Kubo startup timeout');
        let mode='small';const requests=[];
        proxy=createServer(async(req,res)=>{
            res.setHeader('Access-Control-Allow-Origin','*');
            res.setHeader('Access-Control-Allow-Headers','Accept');
            if(req.method==='OPTIONS'){res.writeHead(204).end();return;}
            const url=new URL(req.url,'http://localhost');
            requests.push({path:url.pathname,mode});
            if(mode==='hang'){req.on('close',()=>res.destroy());return;}
            if(mode==='missing'){res.writeHead(404).end();return;}
            if(url.pathname.startsWith('/ipns/') && mode!=='kubo') {
                const data=records[mode]||records.small;
                res.writeHead(200,{'Content-Type':'application/vnd.ipfs.ipns-record'}).end(data);return;
            }
            try {
                const response=await fetch(gateway+req.url,{headers:{accept:req.headers.accept||'*/*'}});
                let data=new Uint8Array(await response.arrayBuffer());
                if(mode==='corrupt' && url.pathname.startsWith('/ipfs/')) {data=data.slice();data[data.length-1]^=1;}
                if(mode==='truncated' && url.pathname.startsWith('/ipfs/'))data=data.slice(0,-1);
                res.writeHead(response.status,{'Content-Type':response.headers.get('content-type')||'application/octet-stream'}).end(data);
            }catch{res.writeHead(502).end();}
        });
        await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
        const endpoint=`http://127.0.0.1:${proxy.address().port}`;
        return {endpoint,gateway,identity,small,large,cid0,cid1,largeCid,requests,out,
            setMode:value=>{mode=value;},
            close:async()=>{proxy.closeAllConnections();await new Promise(r=>proxy.close(r));daemon.kill('SIGTERM');await new Promise(r=>daemon.once('exit',r));await log.close();await rm(directory,{recursive:true,force:true});},
        };
    }catch(error){proxy?.closeAllConnections();proxy?.close();if(daemon&&daemon.exitCode===null){daemon.kill('SIGTERM');await new Promise(r=>daemon.once('exit',r));}await log?.close();await rm(directory,{recursive:true,force:true});throw error;}
}
