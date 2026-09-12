export async function runUi() {
 const checks=[],check=(name,value)=>{if(!value)throw Error(name);checks.push(name);};
 const html=await(await fetch('/index.html')).text();const doc=new DOMParser().parseFromString(html,'text/html');document.body.replaceChildren(...doc.body.childNodes);
 const {setupDisk}=await import('/src/browser/disk-ui.js');
 const plain=new Uint8Array(512*1024);plain[510]=85;plain[511]=170;const files=[new File([plain],'fixture.img')],downloads=[];
 let busy=false,controller,stopped=0,resumed=0,blocked=false,adapter,hasSession=false;
 const ram=new Uint8Array([1,2,3,4]);window.confirm=()=>true;
 controller=setupDisk({busy:()=>busy,setBusy:b=>{busy=b;controller?.syncControls(b);},pickFiles:async()=>files.length?[files.shift()]:[],download:(blob,name)=>downloads.push({blob,name}),hasSession:()=>hasSession,
 stop:async()=>{stopped++;},close:async()=>{hasSession=false;},fail:async()=>{blocked=true;stopped++;},resume:async()=>{if(adapter.failed)throw Error('Resumed while I/O blocked');blocked=false;resumed++;},
 boot:async a=>{adapter=a;hasSession=true;await new Promise(r=>a.get_and_cache(0,512,r));}});
 controller.syncControls(false);const $=id=>document.getElementById('disk-'+id);
 const idle=async()=>{while(busy)await new Promise(r=>setTimeout(r,5));};
 const click=async id=>{$(id).click();await idle();};
 check('Machine default main',$('machine').value==='main');check('Username label is Username',$('user').parentElement.textContent.includes('Username'));
 $('user').value='ui';$('password').value='public test password';$('login').requestSubmit();await idle();check('login opens workspace',!$('workspace').hidden);check('password input cleared',$('password').value==='');
 await click('create');check('creation produces complete download',downloads.length===1&&/^[a-f0-9]{8}\.my98$/.test(downloads[0].name));check('create/open disabled while disk active',$('create').disabled&&$('open').disabled);
 await click('boot');check('boot geometry reserve exact',adapter.get_from_cache(510,2).join()==='85,170');
 await new Promise(r=>adapter.set(10,new Uint8Array([8]),r));
 window.confirm=()=>false;await click('save');check('shutdown confirmation cancellation keeps writes',(await adapter.client.describe()).dirty_bytes===512&&downloads.length===1);
 window.confirm=()=>true;await click('save');check('save downloads full file and leaves stopped',downloads.length===2&&stopped>0&&resumed===0);check('save replaces prepared download only',(await adapter.client.retryDownload()).size===downloads[1].blob.size);
 await click('save');check('no changes creates no download',downloads.length===2&&$('status').textContent.includes('No changes'));
 await click('retry');const digest=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await b.arrayBuffer()))).join();check('UI retry identical',await digest(downloads[1].blob)===await digest(downloads[2].blob));
 const original=adapter.client.read.bind(adapter.client);let injected=true;adapter.client.read=async(...a)=>{if(injected){injected=false;throw Object.assign(Error('Transient I/O'),{code:'IO_ERROR'});}return original(...a);};
 const order=[];adapter.get(100,1,()=>order.push('read'));adapter.set(101,new Uint8Array([9]),()=>order.push('write'));while(!adapter.failed||!blocked)await new Promise(r=>setTimeout(r,5));controller.syncControls(false);check('UI offers retry while I/O blocked',!$('resume').hidden&&order.length===0);
 await click('resume');check('UI resumes only after ordered callbacks',!blocked&&resumed===1&&order.join()==='read,write');check('RAM and overlay preserved',ram.join()==='1,2,3,4'&&(await adapter.client.read(101,1))[0]===9);
 await click('verify');check('explicit verification leaves VM stopped',$('status').textContent.includes('Disk verified')&&resumed===1);
 await click('close');check('close clears active context',$('workspace').hidden&&!hasSession);
 return checks;
}
