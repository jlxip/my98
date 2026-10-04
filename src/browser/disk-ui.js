import {setupDiskProgress} from './disk-progress.js';
import {diskControls} from './disk-controls.js';
import {DiskSession} from './disk-session.js';

/** Local file/VM controls. Secret contexts stay in the independent disk Worker. */
export function setupDisk(host) {
    const $ = id => document.getElementById("disk-" + id);
    const session=new DiskSession(host);
    let working=false,capturing=false;
    const progress = setupDiskProgress($("progress"), () => session.active && host.hasSession() && session.description?.remote ?
        {client:session.client, adapter:session.adapter, cid:session.description.remote.cid, busy:working || host.busy()} : null);
    const cachePreference='my98-cache-publication';
    $('cache-publication').checked=false;
    try {$('cache-publication').checked=localStorage.getItem(cachePreference)==='true';}catch{}
    $('cache-publication').onchange=()=>{try{localStorage.setItem(cachePreference,String($('cache-publication').checked));}catch{}};
    const stateSaveButton=document.getElementById("save-state"), stateLoadButton=document.getElementById("load-state"), stateCancelButton=document.getElementById("cancel-state");
    const message = (text,error=false) => { $("status").textContent=text;$("status").classList.toggle("error",error); if(session.stateAbort) {const target=document.getElementById("session-status");target.textContent=text;target.classList.toggle("error",error);} };
    const stateMessage = (text,error=false) => {
        message(text,error);
        const target=document.getElementById("session-status");
        target.textContent=text;target.classList.toggle("error",error);
    };
    function syncControls(busy) {
        progress.update();
        const view=diskControls({busy,working,client:session.client,state:session.description,active:session.active,adapter:session.adapter,analyzing:session.analyzing,prepared:session.prepared,capturing,stateAbort:session.stateAbort});
        $("workspace").hidden=!view.authenticated;$("login").hidden=view.authenticated;
        $("brand").hidden=view.authenticated;$("notice").hidden=!view.authenticated;
        document.getElementById("welcome").classList.toggle("authenticated",view.authenticated);
        $("panel").querySelectorAll("button,input").forEach(element=>element.disabled=busy||working);
        if(view.hideEmptyForm) {$("empty-form").hidden=true;$("empty").setAttribute("aria-expanded","false");}
        $("analyze").textContent=view.analyzing ? "Stop analyzing" : "Analyze loads";
        $("resume").hidden=!view.showRetry;
        $("cancel").hidden=!view.showCancel;
        if(stateCancelButton) stateCancelButton.hidden=!view.showStateCancel;
        for(const [id,disabled] of Object.entries(view.disabled)) {
            if(id==='load-state') {
                $(id).disabled=disabled;
                if(stateLoadButton)stateLoadButton.disabled=disabled;
                continue;
            }
            const element=id==='save-state' ? stateSaveButton : id==='cancel-state' ? stateCancelButton : $(id);
            if(element)element.disabled=disabled;
        }
    }
    async function run(text,work) {
        if(working||host.busy())return;
        working=true;host.setBusy(true);message(text);
        try {await work();}
        catch(error) {message(error.code==="CANCELLED"?"Operation cancelled. The previous disk and its pending changes are preserved.":error.message,true);}
        finally {working=false;capturing=false;host.setBusy(false);}
    }
    function download(result) {
        session.prepared=true;
        host.download(result.blob,`${session.description.disk_id.slice(0,4).map(n=>n.toString(16).padStart(2,"0")).join("")}.my98`);
        message(`Full download prepared (${(result.size/1048576).toFixed(2)} MiB). Check that the file was saved.`);
    }
    $("login").onsubmit=event=>{
        event.preventDefault();
        if(working || host.busy() || session.client)return;
        const autoBoot=$("autoboot").checked;
        let username=$("user").value,password=$("password").value,machine=$("machine").value;$("password").value="";
        run("Unlocking identity…",async()=>{
            let identity;
            try {identity=await session.unlock(username,password,machine,{onAnalysis:event=>{
                session.analysisError = event.error;
                message(session.analysisError, true);
                void session.cancelLoadAnalysis().then(() => syncControls(host.busy())).catch(error => message(error.message, true));
            },onProgress:p=>{
                if(p.phase==="cache-error") {$("cache-notice").hidden=false;return;}
                if(session.stateAbort) {
                    const labels={compress:"Compressing state", "encrypt-state":"Encrypting state", "decrypt-state":"Decrypting state", "download-state":"Downloading state", decompress:"Decompressing state"};
                    message(`${labels[p.phase] || "Preparing state"}: ${(p.completed/1048576).toFixed(1)} MiB…`);
                }
                if(capturing && p.phase==="resolve") message("Finding remote disk…");
                else if(capturing) message(`${({verify:"Verifying",encrypt:"Encrypting",download:"Downloading",resolve:"Finding remote disk"})[p.phase]||"Working"}: ${(p.completed/1048576).toFixed(1)} MiB…`);
            }});} finally {username=password=machine="";}
            $("identity").textContent=identity.ipnsName;message("Identity unlocked. Create a disk, open a .my98 file, or find your remote disk.");
            if(autoBoot) {
                await openRemote();
                if(session.description.remote?.stateCid && !$("cold-login").checked) await restorePublishedState();
                else await boot();
            }
        });
    };
    $("create").onclick=()=>run("Choosing image…",async()=>{
        const [file]=await host.pickFiles();if(!file)return;
        capturing=true;syncControls(true);const description=await session.createFromImage(file);download(description.download);
    });
    $("relay-key").onclick=()=>run("Copying relay public key…",async()=>{
        const publicKey=await session.client.relayPublicKey();
        const text=Array.from(publicKey,b=>b.toString(16).padStart(2,'0')).join('');
        await navigator.clipboard.writeText(text);
        message("Relay public key copied.");
    });
    $("empty").onclick=()=>{
        if(!session.client || session.description || working || host.busy())return;
        $("empty-form").hidden=false;$("empty").setAttribute("aria-expanded","true");$("empty-size").focus();
    };
    $("empty-cancel").onclick=()=>{
        if(working || host.busy())return;
        $("empty-form").hidden=true;$("empty").setAttribute("aria-expanded","false");$("empty").focus();
    };
    $("empty-form").onsubmit=event=>{
        event.preventDefault();
        if(!session.client || session.description || working || host.busy())return;
        const sizeMiB=$("empty-size").valueAsNumber;
        if(!$("empty-form").reportValidity())return;
        if(!Number.isSafeInteger(sizeMiB) || sizeMiB < 1 || sizeMiB > 1048576) {
            message("Enter a whole number from 1 to 1048576 MiB.",true);return;
        }
        run("Creating empty disk…",async()=>{
            capturing=true;syncControls(true);
            const description=await session.createEmpty(sizeMiB*1048576);download(description.download);
        });
    };
    $("open").onclick=()=>run("Opening encrypted disk…",async()=>{
        const [file]=await host.pickFiles();if(!file)return;
        await session.open(file);message("Header authenticated. Disk data will be read and verified on demand.");
    });
    $("only-localhost").checked=false;
    $("only-localhost").onchange=()=>syncControls(host.busy());
    async function openRemote() {
        message("Finding remote disk…");capturing=true;syncControls(true);
        try {
            await session.openRemote({gateway:$("only-localhost").checked ? "http://127.0.0.1:8080" : undefined, onlyLocalhost:$("only-localhost").checked,prefetch:{enabled:false},persistentCache:{publication:$("cache-publication").checked}});
            message("Remote disk authenticated. Choose Boot or a state; its load profile is downloaded first, then the rest of the disk. Changes are saved locally.");
        } finally {capturing=false;syncControls(true);}
    }
    $("remote").onclick=()=>run("Finding remote disk…",openRemote);
    $("cold-login").checked=false;
    async function boot(analyze = false) {
        message("Booting encrypted disk…");
        if(host.hasSession()&&!window.confirm("Close the current Windows session and boot this disk? Save its disk first."))return;
        capturing=true;syncControls(true);
        await session.boot({analyze,onDiskError:async error=>{await host.fail(error);message("Disk stopped: "+error.message+". You can retry the operation.",true);syncControls(host.busy());}});
        message(session.analysisError || (session.analyzing ? "Recording disk reads. Perform the expected actions, then select Stop analyzing to download the profile." : "Windows is using the encrypted disk. Shut it down before saving."), !!session.analysisError);
    }
    async function saveMachineState() {
        try {
            const result=await session.saveMachineState(()=>syncControls(true));
            host.download(result.blob,`${result.id}.my98state`);
            stateMessage("State download prepared. Keep the original base disk with this state.");
        } catch(error) {stateMessage(error.message,true);throw error;}
    }
    async function restoreState(input, {analyze=false,published=false}={}) {
        if(host.hasSession()&&!window.confirm("Replace the current session with this state? Changes made since it was saved will be lost."))return;
        try {
            await session.restoreState(input,{analyze,onStart:()=>syncControls(true)});
            stateMessage(analyze ? "Recording disk reads. Perform the expected actions, then select Stop analyzing to download the profile." : "State restored. Pending disk writes were replaced by the saved state.");
        } catch(error) {
            if(published && error.code!=="CANCELLED") error.message=error.message.replace(/[.!?]$/,"")+". Retry Resume state or select Boot to start from the base disk.";
            stateMessage(error.message,true);
            throw error;
        }
    }
    async function restoreLocalState(analyze=false) {
        const [file]=await host.pickFiles();
        if(file)await restoreState(file,{analyze});
    }
    function restorePublishedState(analyze=false) {
        return restoreState({published:true},{analyze,published:true});
    }
    $("load-state").onclick=()=>run("Restoring state…",()=>restoreLocalState());
    if(stateLoadButton) stateLoadButton.onclick=$("load-state").onclick;
    if(stateSaveButton) stateSaveButton.onclick=()=>run("Saving state…",saveMachineState);
    if(stateCancelButton) stateCancelButton.onclick=()=>session.stateAbort?.abort();
    $("resume-state").onclick=()=>run("Restoring published state…",()=>restorePublishedState());
    $("boot").onclick=()=>run("Booting encrypted disk…",()=>boot());
    $("analyze").onclick=()=>{
        if(!session.analyzing) {$("analysis-options").hidden=!$("analysis-options").hidden;syncControls(host.busy());return;}
        return run("Generating load profile…",async()=>{
        const profile = await session.finishLoadAnalysis();
        const id = session.description.disk_id.slice(0,4).map(n=>n.toString(16).padStart(2,"0")).join("");
        host.download(new Blob([JSON.stringify(profile, null, 2) + "\n"], {type:"application/json"}), `${id}-load-profile.json`);
        message("Load profile prepared. Check that the JSON was saved. Windows can continue running.");
    });};
    for(const [id,action] of [['boot',()=>boot(true)],['resume',()=>restorePublishedState(true)],['file',()=>restoreLocalState(true)]]) {
        $("analyze-"+id).onclick=()=>run("Starting load analysis…",async()=>{
            $("analysis-options").hidden=true;
            try {await action();}catch(error){if(id!=='boot')await session.cancelLoadAnalysis().catch(()=>{});session.analyzing=false;throw error;}
        });
    }
    $("analyze-cancel").onclick=()=>{$("analysis-options").hidden=true;};
    $("save").onclick=()=>run("Preparing save…",async()=>{
        if(!window.confirm("Has Windows finished shutting down? Confirm to stop the VM and save the full disk.")){message("Save cancelled.");return;}
        capturing=true;syncControls(true);const saved=await session.saveDisk();
        if(saved.outcome==="unchanged")message("No changes. The VM remains stopped.");else download(saved.download);
    });
    $("download").onclick=()=>run("Preparing full download…",async()=>{capturing=true;syncControls(true);download(await session.downloadCurrent());});
    $("retry").onclick=()=>run("Retrying download…",async()=>download(await session.retryDownload()));
    $("verify").onclick=()=>run("Verifying full disk…",async()=>{
        capturing=true;syncControls(true);const hash=await session.verifyImage();
        message("Disk verified. SHA-256: "+Array.from(hash,b=>b.toString(16).padStart(2,"0")).join("")+". The VM remains stopped.");
    });
    $("resume").onclick=()=>run("Retrying disk access…",async()=>{await session.retryAdapter();message("Disk access restored. Windows retains its RAM and writes.");});
    $("discard").onclick=()=>run("Discarding writes…",async()=>{
        if(!window.confirm("Discard pending writes and close this Windows session? The source file is preserved."))return;
        await session.discardWrites();message("Writes discarded.");
    });
    $("cancel").onclick=()=>{session.cancel();message("Cancellation requested…");};
    $("close").onclick=()=>run("Closing identity…",async()=>{
        if(!window.confirm("Close the identity? Pending changes and the prepared download for this session will be lost."))return;
        await session.close();$("identity").textContent="";$("analysis-options").hidden=true;
        $("cache-notice").hidden=true;$("password").value="";$("autoboot").checked=true;$("cold-login").checked=false;$("empty-size").value="1024";
        message("");
    });
    return {syncControls,relaySigner:()=>session.client,
        relayGateways:async()=>((await session.client?.readStats())?.remote?.endpoints || []).map(e=>e.url)};
}
