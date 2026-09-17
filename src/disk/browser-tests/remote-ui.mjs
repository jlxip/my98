export async function runRemoteUi(gateway) {
    const checks=[],check=(name,value)=>{if(!value)throw Error(name);checks.push(name);};
    const html=await(await fetch('/index.html')).text();const doc=new DOMParser().parseFromString(html,'text/html');document.body.replaceChildren(...doc.body.childNodes);
    if(!document.querySelector('link[href="/win98.css"]')) {
        const link=document.createElement('link');link.rel='stylesheet';link.href='/win98.css';
        const loaded=new Promise((resolve,reject)=>{link.onload=resolve;link.onerror=reject;});document.head.append(link);await loaded;
    }
    // Scripts from the parsed page stay inert; operate its real disk controls with a disposable host.
    const {setupDisk}=await import('/src/browser/disk-ui.js');
    const {Slop86Disk}=await import('/build/disk/web/client.js');
    const originalOpen=Slop86Disk.prototype.openRemote;
    Slop86Disk.prototype.openRemote=function(options){return originalOpen.call(this,{...options,onlyLocalhost:true,gateway});};
    let busy=false,controller,adapter,hasSession=false;let stops=0;
    window.confirm=()=>true;
    controller=setupDisk({busy:()=>busy,setBusy:b=>{busy=b;controller?.syncControls(b);},pickFiles:async()=>[],download:()=>{},hasSession:()=>hasSession,
        stop:async()=>{stops++;},close:async()=>{hasSession=false;},fail:async()=>{stops++;},resume:async()=>{},
        boot:async a=>{adapter=a;hasSession=true;await new Promise(r=>a.get_and_cache(0,512,r));}});
    controller.syncControls(false);const $=id=>document.getElementById('disk-'+id);
    const idle=async()=>{while(busy)await new Promise(r=>setTimeout(r,5));};
    const click=async id=>{$(id).click();await idle();};
    $('panel').open=true;$('user').value='disk fixtures';$('password').value='public compatibility password';$('login').requestSubmit();await idle();
    check('unlock alone does not open remote disk',!$('remote').disabled&&$('boot').disabled);
    await window.setGatewayMode('missing');await click('remote');
    check('unavailable disk leaves identity unlocked',!$('workspace').hidden&&!$('remote').disabled&&$('boot').disabled);
    await window.setGatewayMode('large');await click('remote');
    check('remote disk enables boot and prevents replacement',!$('boot').disabled&&$('remote').disabled&&$('open').disabled&&$('create').disabled);
    check('remote opening explained',$('status').textContent.includes('downloads in the background'));
    await click('boot');check('remote disk attached to VM',hasSession&&adapter.byteLength>0);
    await new Promise(r=>adapter.set(17,new Uint8Array([211]),r));
    await window.setGatewayMode('missing');await adapter.client.clearCaches();
    let complete=false;adapter.get(600000,1,()=>{complete=true;});
    while(!adapter.failed)await new Promise(r=>setTimeout(r,5));
    check('remote UI offers recovery',!$('resume').hidden&&!complete&&stops>0);
    await window.setGatewayMode('large');await click('resume');check('remote UI resumes ordered I/O',complete&&!adapter.failed);
    await click('close');check('close clears remote identity',$('workspace').hidden&&!hasSession);
    // Leave the page showing an authenticated remote disk for visual QA.
    $('user').value='disk fixtures';$('password').value='public compatibility password';$('login').requestSubmit();await idle();await click('remote');
    window.closeRemoteUi=async()=>{try{await click('close');}finally{Slop86Disk.prototype.openRemote=originalOpen;}};
    return checks;
}
