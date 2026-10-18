import {setupDiskProgress} from './disk-progress.js';
import {diskControls} from './disk-controls.js';
import {DiskSession} from './disk-session.js';
import {publicationOptions} from './publication-options.js';

/** Disk/VM controls. Secret contexts stay in the independent disk Worker. */
export function setupDisk(host) {
    const $ = id => document.getElementById("disk-" + id);
    const session=new DiskSession(host);
    let working=false,capturing=false,readOnlyAccess=false;
    const menus=[...$("workspace").querySelectorAll(".disk-menu")];
    function closeMenu(menu,restoreFocus=false) {
        const focused=menu.querySelector(".disk-menu-items").contains(document.activeElement);
        menu.open=false;
        if((focused||restoreFocus)&&!menu.hidden)menu.querySelector("summary").focus();
    }
    for(const menu of menus) {
        menu.querySelector("summary").addEventListener("click",event=>{
            if(working||host.busy())event.preventDefault();
        });
        menu.addEventListener("toggle",()=>{
            if(menu.open)for(const other of menus)if(other!==menu)closeMenu(other);
        });
    }
    $("workspace").addEventListener("click",event=>{
        if(event.target.closest(".disk-menu-items button"))for(const menu of menus)if(menu.open)closeMenu(menu);
    });
    document.addEventListener("click",event=>{
        if(!event.target.closest(".disk-menu"))for(const menu of menus)if(menu.open)closeMenu(menu);
    });
    $("workspace").addEventListener("keydown",event=>{
        const menu=event.target.closest(".disk-menu");
        if(event.key==="Escape"&&menu?.open){event.preventDefault();event.stopPropagation();closeMenu(menu,true);}
    });
    const progress = setupDiskProgress($("progress"), () => session.active && host.hasSession() && session.description?.remote ?
        {client:session.client, adapter:session.adapter, infoHash:session.description.remote.infoHash, busy:working || host.busy()} : null);
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
        $("workspace").hidden=!view.authenticated;
        $("login").hidden=view.authenticated||readOnlyAccess;
        $("reader").hidden=view.authenticated||!readOnlyAccess;
        $("auth-switch").hidden=view.authenticated;
        $("auth-switch").textContent=readOnlyAccess?"Or log in":"Or use a read key";
        $("brand").hidden=view.authenticated;$("notice").hidden=!view.authenticated;
        document.getElementById("welcome").classList.toggle("authenticated",view.authenticated);
        if(busy||working||!view.authenticated)for(const menu of menus)if(menu.open)closeMenu(menu);
        $("panel").querySelectorAll("button,input").forEach(element=>element.disabled=busy||working);
        $("workspace").querySelectorAll("[data-disk-action]").forEach(element=>{
            element.hidden=!!view.hidden[element.dataset.diskAction];
        });
        $("primary-actions").hidden=![...$("primary-actions").querySelectorAll("[data-disk-action]")].some(element=>!element.hidden);
        $("boot").dataset.variant=view.hidden['resume-state']?"primary":"secondary";
        $("save-state").disabled=view.disabled['save-state'];
        for(const menu of menus) {
            menu.hidden=![...menu.querySelectorAll("[data-disk-action]")].some(element=>!element.hidden);
            menu.querySelector("summary").setAttribute("aria-disabled",String(busy||working));
            if(menu.hidden&&menu.open)closeMenu(menu);
        }
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
    $("auth-switch").onclick=()=>{
        if(working || host.busy() || session.client)return;
        readOnlyAccess=!readOnlyAccess;
        syncControls(false);
        $(readOnlyAccess?"read-key":"user").focus();
    };
    $("login").onsubmit=event=>{
        event.preventDefault();
        if(working || host.busy() || session.client)return;

        let username=$("user").value,password=$("password").value,machine=$("machine").value;$("password").value="";
        run("Unlocking identity…",async()=>{
            let identity;
            try {identity=await session.unlock(username,password,machine,{onAnalysis:event=>{
                session.analysisError = event.error;
                message(session.analysisError, true);
                void session.cancelLoadAnalysis().then(() => syncControls(host.busy())).catch(error => message(error.message, true));
            },onProgress:p=>{
                if(p.error){stateMessage(p.error.message,true);return;}
                if(session.stateAbort) {
                    const labels={compress:"Compressing state", "encrypt-state":"Encrypting state", "decrypt-state":"Decrypting state", "download-state":"Downloading state", decompress:"Decompressing state"};
                    message(`${labels[p.phase] || "Preparing state"}: ${(p.completed/1048576).toFixed(1)} MiB…`);
                }
                if(capturing && p.phase==="resolve") message("Finding remote disk…");
                else if(capturing) message(`${({verify:"Verifying",encrypt:"Encrypting",download:"Downloading",resolve:"Finding remote disk"})[p.phase]||"Working"}: ${(p.completed/1048576).toFixed(1)} MiB…`);
            }});} finally {username=password=machine="";}
            $("identity").textContent=identity.publicKey.map(n=>n.toString(16).padStart(2,"0")).join("");
            message("Opening publication…");capturing=true;syncControls(true);
            await session.openRemote(await publicationOptions());
            message("Publication opened.");
        });
    };
    $("reader").onsubmit=event=>{
        event.preventDefault();
        if(working || host.busy() || session.client)return;
        let readKey=$("read-key").value;
        $("read-key").value="";
        run("Opening read-only publication…",async()=>{
            capturing=true;syncControls(true);
            try {
                const description=await session.openRemoteReadOnly({readKey,...await publicationOptions()},{
                    onProgress:p=>{if(p.error)stateMessage(p.error.message,true);}
                });
                $("identity").textContent=description.remote.publicKey;
                message("Read-only publication opened. Pending changes stay in memory.");
            } finally {readKey="";}
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
        $("empty-form").hidden=true;$("empty").setAttribute("aria-expanded","false");$("menu-disk").querySelector("summary").focus();
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
        return restoreState({publication:true},{analyze,published:true});
    }
    $("load-state").onclick=()=>run("Restoring state…",()=>restoreLocalState());
    if(stateLoadButton) stateLoadButton.onclick=$("load-state").onclick;
    $("save-state").onclick=()=>run("Saving state…",saveMachineState);
    if(stateSaveButton) stateSaveButton.onclick=$("save-state").onclick;
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
    $("clear-cache").onclick=()=>run("Clearing cache…",async()=>{
        capturing=true;syncControls(true);
        await session.clearCaches();
        message("Cached pieces cleared. Pending writes are preserved. The VM remains stopped.");
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
        $("password").value="";$("empty-size").value="1024";
        message("");
    });
    return {syncControls,relaySigner:()=>session.description?.readOnly?undefined:session.client};
}
