import {readFile} from 'node:fs/promises';
import {randomBytes,timingSafeEqual} from 'node:crypto';
const commands=new Set(['status','pause','resume','checkpoint','save-pause','type','key','pointer','release','network-login','network-logout','network-retry']);
export function createViewer({run,frame}){
    const token=randomBytes(32).toString('hex');
    const permitted=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)&&timingSafeEqual(Buffer.from(value),Buffer.from(token));
    let inputOwner,timer;
    const release=()=>{clearTimeout(timer);inputOwner=undefined;void run({command:'release'}).catch(()=>{});};
    const renew=()=>{clearTimeout(timer);timer=setTimeout(release,1500);timer.unref?.();};
    return {dispose:()=>{clearTimeout(timer);},url:origin=>origin+'/_agent/view#'+token,async handle(req,res,url){
        const route=url.pathname;
        if(!route.startsWith('/_agent/view'))return false;
        res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
        res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
        if(req.method==='GET'&&['/_agent/view','/_agent/view.js','/_agent/view.css'].includes(route)){
            const name=route==='/_agent/view'?'view.html':route.endsWith('.js')?'view.js':'view.css';
            res.setHeader('Content-Type',name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.js')?'text/javascript':'text/css');
            res.end(await readFile(new URL(name,import.meta.url)));return true;
        }
        if(!permitted(req.headers['x-my98-view'])){res.writeHead(401).end('Local access key required');return true;}
        try{
            if(route==='/_agent/view/frame'&&req.method==='GET'){
                const shot=await frame();
                if(inputOwner&&req.headers['x-my98-input']===inputOwner)renew();
                if(!shot.data.startsWith('data:image/png;base64,'))throw new Error('Frame unavailable');
                res.setHeader('Content-Type','image/png');res.end(Buffer.from(shot.data.split(',')[1],'base64'));return true;
            }
            if(route!=='/_agent/view/api'||req.method!=='POST'){res.writeHead(404).end();return true;}
            let bytes=0,input='';for await(const b of req){bytes+=b.length;if(bytes>65536)throw new Error('Request too large');input+=b;}
            let request;try{request=JSON.parse(input);}catch{throw new Error('Invalid request');}finally{input='';}
            if(!commands.has(request?.command))throw new Error('Command unavailable in the local view');
            res.setHeader('Content-Type','application/json');
            try{
                const result=await run(request);
                if(request.command==='pointer'&&request.pointer?.buttons){
                    if(request.pointer.buttons.some(Boolean)){inputOwner=req.headers['x-my98-input']||'unattached';renew();}
                    else{clearTimeout(timer);inputOwner=undefined;}
                }
                if(request.command==='release'){clearTimeout(timer);inputOwner=undefined;}
                res.end(JSON.stringify({ok:true,...result}));
            }
            finally{if(request.credentials)request.credentials.password='';if(request.command==='type')request.text='';}
        }catch(error){res.statusCode=400;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:false,error:error.message||'Local operation failed'}));}
        return true;
    }};
}
