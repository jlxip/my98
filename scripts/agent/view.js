const $=id=>document.getElementById(id),screen=$('screen'),form=$('login');
const inputId=crypto.randomUUID();
let loginPending=false,pastePending=false;
let token=location.hash.slice(1),state,stopped=false,inputQueue=Promise.resolve(),moveX=0,moveY=0,moving=false;
history.replaceState(null,'',location.pathname);
const message=(text,error=false)=>{$('message').textContent=text;$('message').dataset.error=String(error);};
async function api(command,values={}){
    if(!/^[a-f0-9]{64}$/.test(token))throw new Error('Open this view from the local controller.');
    const response=await fetch('/_agent/view/api',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json','X-My98-View':token,'X-My98-Input':inputId},body:JSON.stringify({command,...values})});
    const result=await response.json();if(!response.ok||!result.ok)throw new Error(result.error||'Local operation failed');return result;
}
function input(command,values={}){inputQueue=inputQueue.then(()=>api(command,values)).catch(error=>message(error.message,true));return inputQueue;}
function update(value){
    state=value;const loaded=!!state.loaded,running=!!state.running;
    $('run').disabled=!loaded;$('save').disabled=!loaded;$('mouse').disabled=!running;$('paste').disabled=!running||pastePending;
    $('run').textContent=running?'Pause':'Resume';$('machine-state').textContent=loaded?(running?'Running':'Paused'):'';
    const network=state.network?.state||'identity-closed';
    $('network-state').textContent=({online:'Internet connected',connecting:'Connecting',offline:'Offline',rejected:'Login rejected','identity-closed':'Offline',closed:'Offline'})[network]||'Offline';
    $('retry').hidden=!['offline','rejected'].includes(network);$('logout').hidden=network==='identity-closed'||network==='closed';
    if(network==='online'&&loginPending){form.elements.password.value='';loginPending=false;}
    if(network==='rejected')loginPending=false;
    if(!running&&document.pointerLockElement)document.exitPointerLock();
}
form.addEventListener('submit',async event=>{
    event.preventDefault();const button=form.querySelector('[type=submit]');button.disabled=true;message('');
    try{const credentials={username:form.elements.username.value,password:form.elements.password.value,machine:form.elements.machine.value};await api('network-login',{credentials});credentials.password='';loginPending=true;await refresh();}
    catch(error){message(error.message,true);}finally{button.disabled=false;}
});
$('logout').onclick=async()=>{try{await api('network-logout');form.elements.password.value='';await refresh();}catch(error){message(error.message,true);}};
$('retry').onclick=async()=>{try{await api('network-retry');await refresh();}catch(error){message(error.message,true);}};
$('run').onclick=async()=>{try{await inputQueue;await api(state?.running?'pause':'resume');await refresh();}catch(error){message(error.message,true);}};
$('save').onclick=async()=>{const button=$('save');button.disabled=true;message('Saving…');try{await inputQueue;await api('save-pause');await refresh();message('Saved.');}catch(error){message(error.message,true);}finally{button.disabled=!state?.loaded;}};
$('paste').onclick=async()=>{
    if(!state?.running||pastePending)return;
    pastePending=true;$('paste').disabled=true;message('');
    let text='',values;
    try{
        try{
            if(!navigator.clipboard?.readText)throw new Error('Clipboard unavailable');
            text=await navigator.clipboard.readText();
        }catch{message('Allow clipboard access, or paste with the keyboard while the screen is focused.',true);return;}
        if(!text){message('Clipboard is empty.');return;}
        if(!state?.running){message('Resume Windows before pasting.',true);return;}
        screen.focus();values={text};text='';
        const pending=inputQueue.then(()=>api('type',values));
        inputQueue=pending.catch(()=>{});
        await pending;message('Pasted.');
    }catch{message('Paste did not complete. Check the destination before trying again.',true);}
    finally{text='';if(values)values.text='';pastePending=false;$('paste').disabled=!state?.running;}
};
async function refresh(){if(stopped)return;try{update(await api('status'));}catch(error){message(error.message,true);}}
async function frame(){
    if(stopped)return;
    try{const response=await fetch('/_agent/view/frame',{cache:'no-store',headers:{'X-My98-View':token,'X-My98-Input':inputId}});if(!response.ok)throw new Error('Screen unavailable');
        const url=URL.createObjectURL(await response.blob()),previous=screen.src;
        await new Promise(resolve=>{screen.onload=resolve;screen.onerror=resolve;screen.src=url;});if(previous.startsWith('blob:'))URL.revokeObjectURL(previous);
    }catch(error){message(error.message,true);}
    if(!stopped)setTimeout(frame,250);
}
function capture(){if(!state?.running)return;screen.focus();if(screen.requestPointerLock)Promise.resolve(screen.requestPointerLock()).catch(error=>message(error.message,true));else message('Drag on the screen to move the pointer; tap to click.');}
$('mouse').onclick=()=>document.pointerLockElement?document.exitPointerLock():capture();
document.addEventListener('pointerlockchange',()=>{$('mouse').textContent=document.pointerLockElement?'Release mouse':'Capture mouse';screen.style.cursor=document.pointerLockElement?'none':'';if(!document.pointerLockElement)void input('release');});
const buttons=event=>[!!(event.buttons&1),!!(event.buttons&4),!!(event.buttons&2)];
screen.addEventListener('mousedown',event=>{event.preventDefault();screen.focus();if(!state?.running)return;if(document.pointerLockElement===screen){void input('pointer',{pointer:{buttons:buttons(event)}});}else capture();});
document.addEventListener('mouseup',event=>{if(document.pointerLockElement===screen)void input('pointer',{pointer:{buttons:buttons(event)}});});
async function flushMove(){if(moving)return;moving=true;try{while(moveX||moveY){const dx=Math.max(-4096,Math.min(4096,moveX)),dy=Math.max(-4096,Math.min(4096,moveY));moveX-=dx;moveY-=dy;await input('pointer',{pointer:{dx,dy}});}}finally{moving=false;}}
document.addEventListener('mousemove',event=>{if(document.pointerLockElement===screen&&state?.running){moveX+=event.movementX;moveY+=event.movementY;void flushMove();}});
screen.addEventListener('wheel',event=>{if(state?.running){event.preventDefault();void input('pointer',{pointer:{wheel:-Math.sign(event.deltaY)}});}},{passive:false});
screen.addEventListener('contextmenu',event=>event.preventDefault());
let touch;
screen.addEventListener('pointerdown',event=>{if(event.pointerType!=='touch'||!state?.running)return;event.preventDefault();screen.focus();touch={x:event.clientX,y:event.clientY,distance:0};screen.setPointerCapture(event.pointerId);});
screen.addEventListener('pointermove',event=>{if(event.pointerType!=='touch'||!touch)return;const scale=screen.naturalWidth/screen.clientWidth,dx=(event.clientX-touch.x)*scale,dy=(event.clientY-touch.y)*scale;touch.distance+=Math.abs(dx)+Math.abs(dy);touch.x=event.clientX;touch.y=event.clientY;moveX+=dx;moveY+=dy;void flushMove();});
screen.addEventListener('pointerup',event=>{if(event.pointerType!=='touch'||!touch)return;if(touch.distance<8)void input('pointer',{pointer:{buttons:[true,false,false]}}).then(()=>input('release'));touch=undefined;});
screen.addEventListener('keydown',event=>{
    if(!state?.running)return;
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='v')return;
    if(['Control','Alt','Shift','Meta'].includes(event.key))return;
    event.preventDefault();
    const names={ArrowUp:'Up',ArrowDown:'Down',ArrowLeft:'Left',ArrowRight:'Right',' ':'Space'};
    if(event.key.length===1&&!event.ctrlKey&&!event.metaKey&&!event.altKey){void input('type',{text:event.key});return;}
    const mods=[];if(event.ctrlKey)mods.push('Ctrl');if(event.metaKey)mods.push('Win');if(event.altKey)mods.push('Alt');if(event.shiftKey)mods.push('Shift');
    void input('key',{key:[...mods,names[event.key]||event.key].join('+')});
});
screen.addEventListener('paste',event=>{event.preventDefault();if(state?.running)void input('type',{text:event.clipboardData.getData('text/plain')});});
window.addEventListener('blur',()=>void input('release'));
window.addEventListener('pagehide',()=>{stopped=true;if(token)void fetch('/_agent/view/api',{method:'POST',keepalive:true,headers:{'Content-Type':'application/json','X-My98-View':token,'X-My98-Input':inputId},body:JSON.stringify({command:'release'})}).catch(()=>{});token='';});
if(token){void refresh();void frame();setInterval(refresh,1000);}else message('Open this view from the local controller.',true);
