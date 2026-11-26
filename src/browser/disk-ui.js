import {setupDiskProgress} from './disk-progress.js';
import {diskControls} from './disk-controls.js';
import {DiskSession} from './disk-session.js';
import {publicationOptions} from './publication-options.js';
import {setupPublicationControls} from './publication-controls.js';
import {addHelp} from './ui-help.js';
import {confirmAction,hasOpenDialog,restoreDialogFocus} from './ui-dialogs.js';

/** Disk/VM controls. Secret contexts stay in the independent disk Worker. */
export function setupDisk(host) {
    const $ = id => document.getElementById("disk-" + id);
    const session=new DiskSession(host);
    let working=false,capturing=false,progressFailed=false,readOnlyAccess=false,seed={active:false};
    const diskMenu=$("menu-disk"),dropdowns=[diskMenu,$("menu-state"),$("menu-tools")];
    for(const menu of dropdowns)menu.querySelector(':scope > button').addEventListener('click',()=>menu.querySelector(':scope > button').focus({preventScroll:true}));
    diskMenu.addEventListener('click',event=>{if(event.target.closest('#disk-empty')&&!$("empty-form").hidden)$("empty-size").focus();});
    addHelp(null,{id:'seedboxes',button:$("replica-info"),content:$("replica-help"),text:$("replica-help").textContent});
    const publicationLabel=document.createElement('span');publicationLabel.textContent='Publication';
    $("seeding").insertBefore(publicationLabel,$("seeding").lastElementChild);
    addHelp(publicationLabel,{id:'publication',text:'Copy magnet: copy the link that follows this identity.\nStop seeding: stop sharing the prepared snapshot from this page.'});
    let operationTrigger,confirmationUsed=false;
    const context = () => [session.client,session.description?.disk_id?.join(','),session.description?.remote?.infoHash,session.description?.remote?.sequence,session.pendingPublication?.sequence];
    async function confirm(title,text,confirmLabel) {
        const before=context();confirmationUsed=true;
        const accepted=await confirmAction({title,message:text,confirmLabel,trigger:operationTrigger});
        if(!accepted){message('Operation cancelled.');return false;}
        if(context().some((value,i)=>value!==before[i])){message('The selection changed. Please try again.',true);return false;}
        return true;
    }
    document.addEventListener('my98:modalchange',()=>{if(!hasOpenDialog())schedulePublicationUpdate();});
    const progress = setupDiskProgress($("progress"), () => session.active && host.hasSession() && session.description?.remote ?
        {client:session.client, adapter:session.adapter, infoHash:session.description.remote.infoHash, busy:working || host.busy()} : null);
    const stateSaveButton=document.getElementById("save-state"), stateLoadButton=document.getElementById("load-state"), stateCancelButton=document.getElementById("cancel-state");
    const message = (text,error=false) => { $("status").textContent=text;$("status").classList.toggle("error",error); if(session.stateAbort) {const target=document.getElementById("session-status");target.textContent=text;target.classList.toggle("error",error);} };
    const stateMessage = (text,error=false) => {
        message(text,error);
        const target=document.getElementById("session-status");
        target.textContent=text;target.classList.toggle("error",error);
    };
    let updatingPublication=false,bootLatest=false,publicationError;
    function publicationStatus(value) {
        renderPublication();
        if(value.fatal&&session.active)void host.fail(Object.assign(new Error(value.error.message),value.error)).catch(()=>{});
        syncControls(host.busy());
    }
    function renderPublication() {
        const element=$('publication-status'),value=session.publication,pending=session.pendingPublication,remote=session.description?.remote;
        const selected=remote?.sequence||value?.selectedSequence;
        let text=value?.state==='checking'?'Checking for updates…':value?.state==='fixed'?'Fixed publication.':value?.error?.message||'Update check completed.';
        if(pending)text=`Version ${pending.sequence} is available.`+(publicationError?.sequence===pending.sequence?' '+publicationError.message:'');
        if(updatingPublication)text='Opening latest publication…';
        element.textContent=(selected?`Version ${selected}. `:'')+text;element.hidden=!value||!session.client;
        element.classList.toggle('error',!!value?.fatal);
        const show=!!pending&&!updatingPublication;
        const label=bootLatest===pending?.sequence?'Boot latest version':session.usedForVm?'Restart with latest version':'Open latest version';
        for(const button of [$('update-publication'),document.getElementById('vm-update-publication')]) {
            button.hidden=!show;button.textContent=label;button.disabled=working||host.busy()||session.analyzing;
        }
        const banner=document.getElementById('vm-publication-update');banner.hidden=!session.active||!pending&&!updatingPublication;
        document.getElementById('vm-publication-status').textContent=element.textContent;
        document.getElementById('vm-cancel-publication').hidden=!updatingPublication;document.getElementById('vm-cancel-publication').disabled=false;
    }
    function schedulePublicationUpdate() {
        if(!working&&!host.busy()&&!updatingPublication&&session.automaticUpdate&&!hasOpenDialog()) {
            queueMicrotask(()=>{
                if(!working&&!host.busy()&&session.automaticUpdate&&!hasOpenDialog())void changePublication(false);
            });
        }
    }
    async function changePublication(manual) {
        if(working||host.busy()||session.analyzing||!session.pendingPublication)return;
        const restart=manual&&session.usedForVm;
        await run('Opening latest publication…',async()=>{
            if(manual&&(restart||session.description.dirty_bytes)&&!await confirm('Open latest publication?', 'The current Windows session, RAM and pending disk changes will be discarded.', 'Open latest version'))return;
            updatingPublication=true;publicationError=undefined;renderPublication();
            try {
                await session.updatePublication({restart,mode:bootLatest===session.pendingPublication?.sequence?'boot':session.remoteMode,discardChanges:manual,onStart:()=>syncControls(true)});
                bootLatest=false;message('Latest publication opened.');
            } catch(error) {publicationError={sequence:session.pendingPublication?.sequence,message:error.message};if(error.code==='NO_PUBLISHED_STATE')bootLatest=session.pendingPublication?.sequence;throw error;}
            finally {updatingPublication=false;renderPublication();}
        });
    }
    $('update-publication').onclick=()=>changePublication(true);
    document.getElementById('vm-update-publication').onclick=$('update-publication').onclick;
    document.getElementById('vm-cancel-publication').onclick=()=>session.cancel();
    function publishingStatus(value) {
        seed=value;
        publicationControls.published(value);
        $("seeding").hidden=!value.active;
        const labels={preparing:"Preparing publication…",announcing:"Announcing publication…",seeding:"Publication announced.",unconfirmed:"Publication announcement not confirmed."};
        $("seed-status").textContent=(labels[value.state]||"")+(value.error?" "+value.error.message:"");
        const replicas=value.replicas||{complete:0,label:'0',unavailable:0};
        $("replica-notice").hidden=!value.active||replicas.complete>0;
        $("replica-count").textContent=replicas.label;
        $("replica-status").textContent=replicas.complete>0?'Complete replica confirmed.':replicas.unavailable?'Some FeedTorrent receivers cannot report progress. Keep this page open.':'Waiting for a complete replica. Keep this page open.';
        if(replicas.complete>0&&replicas.unavailable)$("replica-status").textContent+=' Some receivers cannot report progress.';
        $("seed-local").textContent=value.seedError?'Snapshot retained. Seeding error: '+value.seedError.message:value.active&&value.state!=='preparing'?'This page is seeding the prepared snapshot.':'';
        $("retry-publication").hidden=value.state!=="unconfirmed";
        $("copy-magnet").disabled=!value.magnet;
        syncControls(host.busy());
    }
    window.addEventListener("beforeunload",event=>{if(seed.active&&!(seed.replicas?.complete>0)){event.preventDefault();event.returnValue="";}});
    function syncControls(busy) {
        progress.update();
        const view=diskControls({busy,working,client:session.client,state:session.description,active:session.active,adapter:session.adapter,analyzing:session.analyzing,prepared:session.prepared,capturing,stateAbort:session.stateAbort,quiescent:host.diskQuiescent(),seeding:seed.active});
        $("workspace").hidden=!view.authenticated;
        if(!view.authenticated)$("publication-status").hidden=true;
        $("login").hidden=view.authenticated||readOnlyAccess;
        $("reader").hidden=view.authenticated||!readOnlyAccess;
        $("auth-switch").hidden=view.authenticated;
        $("auth-switch").textContent=readOnlyAccess?"Or log in":"Or use a read key";
        $("brand").hidden=view.authenticated;$("notice").hidden=!view.authenticated;
        document.getElementById("welcome").classList.toggle("authenticated",view.authenticated);
        if(busy||working||!view.authenticated)for(const dropdown of dropdowns)dropdown.close?.(false);
        $("panel").querySelectorAll("button,input,select").forEach(element=>{if(element.classList.contains("ui-info")||element.id==="disk-profiles-close")element.disabled=false;else element.disabled=busy||working;});
        $("workspace").querySelectorAll("[data-disk-action]").forEach(element=>{
            element.hidden=!!view.hidden[element.dataset.diskAction];
        });
        $("primary-actions").hidden=![...$("primary-actions").querySelectorAll("[data-disk-action]")].some(element=>!element.hidden);
        $("boot").dataset.variant=view.hidden['resume-state']?"primary":"secondary";
        $("save-state").disabled=view.disabled['save-state'];
        $("download").textContent=session.description?.readOnly?"Download original encrypted disk":"Download encrypted disk";
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
        const diskActions=[...diskMenu.querySelectorAll('[data-disk-action]')];
        diskMenu.hidden=!diskActions.some(element=>!element.hidden);
        $("menu-trigger").disabled=busy||working||!diskActions.some(element=>!element.hidden&&!element.disabled);
        let groupBefore=false;
        for(const group of $("menu-items").querySelectorAll('[role=group]')) {
            group.hidden=![...group.querySelectorAll('[data-disk-action]')].some(element=>!element.hidden);
            if(group.previousElementSibling?.matches('hr'))group.previousElementSibling.hidden=group.hidden||!groupBefore;
            if(!group.hidden)groupBefore=true;
        }
        for(const menu of dropdowns) {
            const actions=[...menu.querySelectorAll('[data-disk-action]')],trigger=menu.querySelector(':scope > button');
            menu.hidden=!actions.some(e=>!e.hidden);trigger.disabled=busy||working||!actions.some(e=>!e.hidden&&!e.disabled);
            if(menu.hidden||trigger.disabled)menu.close?.(false);
            menu.refresh?.();
        }
        renderPublication();schedulePublicationUpdate();
    }
    async function run(text,work) {
        if(working||host.busy())return;
        operationTrigger=document.activeElement;confirmationUsed=false;progressFailed=false;working=true;host.setBusy(true);message(text);
        try {await work();}
        catch(error) {message(error.code==="CANCELLED"?"Operation cancelled. The previous disk and its pending changes are preserved.":error.message,true);}
        finally {working=false;capturing=false;host.setBusy(false);renderPublication();if(confirmationUsed)restoreDialogFocus(operationTrigger);schedulePublicationUpdate();}
    }
    const publicationControls=setupPublicationControls({session,$,host,run,message,syncControls,confirm,sources:async()=>(await publicationOptions()).sources});
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
        $("publication-status").hidden=true;
        run("Unlocking identity…",async()=>{
            let identity;
            try {identity=await session.unlock(username,password,machine,{onPublication:publicationStatus,onPublishing:publishingStatus,onAnalysis:event=>{
                session.analysisError = event.error;
                message(session.analysisError, true);
                void session.cancelLoadAnalysis().then(() => syncControls(host.busy())).catch(error => message(error.message, true));
            },onProgress:p=>{
                if(p.error){progressFailed=true;stateMessage(p.error.message,true);return;}
                if(progressFailed)return;
                const label=({encrypt:"Encrypting",hash:"Hashing","encrypt-state":"Encrypting state"})[p.phase];
                if(label) {
                    if(!working)return;
                    const known=Number.isSafeInteger(p.total)&&p.total>0&&Number.isSafeInteger(p.completed)&&p.completed>=0;
                    const percent=known?(p.completed>=p.total?100:Math.min(99,Math.floor(100*p.completed/p.total))):undefined;
                    message(percent===undefined?`${label}…`:`${label}: ${percent}%…`);
                    return;
                }
                if(session.stateAbort) {
                    const labels={compress:"Compressing state", "encrypt-state":"Encrypting state", "decrypt-state":"Decrypting state", "download-state":"Downloading state", decompress:"Decompressing state"};
                    message(`${labels[p.phase] || "Preparing state"}: ${(p.completed/1048576).toFixed(1)} MiB…`);
                }
                if(capturing && p.phase==="resolve") message("Finding remote disk…");
                else if(capturing) message(`${({verify:"Verifying",encrypt:"Encrypting",decrypt:"Decrypting",hash:"Hashing",download:"Downloading",resolve:"Finding remote disk"})[p.phase]||"Working"}: ${(p.completed/1048576).toFixed(1)} MiB…`);
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
                    onPublication:publicationStatus,onProgress:p=>{if(p.error)stateMessage(p.error.message,true);}
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
        $("empty-form").hidden=false;$("empty").setAttribute("aria-expanded","true");
    };
    $("empty-cancel").onclick=()=>{
        if(working || host.busy())return;
        $("empty-form").hidden=true;$("empty").setAttribute("aria-expanded","false");$("menu-trigger").focus();
    };
    for(const [panel,close] of [['empty-form','empty-cancel'],['analysis-options','analyze-cancel']])$(panel).addEventListener('keydown',event=>{if(event.key==='Escape'&&!working&&!host.busy()){event.preventDefault();event.stopPropagation();$(close).click();}});
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
            const description=await session.createEmpty(sizeMiB*1048576);download(description.download);$("empty-form").reset();
        });
    };
    $("open").onclick=()=>run("Opening encrypted disk…",async()=>{
        const [file]=await host.pickFiles();if(!file)return;
        await session.open(file);message("Header authenticated. Disk data will be read and verified on demand.");
    });
    async function boot(analyze = false) {
        message("Booting encrypted disk…");
        if(host.hasSession()&&!await confirm("Boot this disk?","Close the current Windows session and boot this disk? Save its disk first.","Boot"))return;
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
        if(host.hasSession()&&!await confirm("Replace current session?","Changes made since it was saved will be lost.","Restore state"))return;
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
    $("analyze-cancel").onclick=()=>{$("analysis-options").hidden=true;$("tools-trigger").focus();};
    async function publish(kind="current") {
        let file;
        if(kind!=="current"){[file]=await host.pickFiles();if(!file)return;}
        const details=await session.client.publicationDetails({sources:(await publicationOptions()).sources,requireBase:false});
        if((details.hasState||details.hasProfiles)&&!await confirm('Replace published disk?','Publishing a disk removes the published state and load profiles.','Publish disk'))return;
        capturing=true;syncControls(true);
        const result=await session.publishDisk({kind,file,sources:await publicationOptions().then(value=>value.sources)});
        message("");
    }
    for(const [id,kind] of [["publish","current"],["publish-file","encrypted"],["publish-raw","raw"]])
        $(id).onclick=()=>run("Preparing publication…",()=>publish(kind));
    for(const [id,format] of [["download","encrypted"],["download-raw","raw"]])$(id).onclick=()=>run("Preparing disk download…",async()=>{
        capturing=true;syncControls(true);
        const result=await session.exportDisk(format);
        const id=Array.from(session.description.disk_id.slice(0,4),n=>n.toString(16).padStart(2,"0")).join("");
        host.download(result.blob,id+(format==="raw"?".img":".my98"));
        message("Disk download prepared. Check that the file was saved.");
    });
    $("stop-seeding").onclick=()=>run("Stopping seed…",async()=>{
        if(!(seed.replicas?.complete>0)&&!await confirm("Stop seeding?","No complete replica has been confirmed. Stopping the seed may make this publication unavailable.","Stop seeding"))return;
        await session.client.stopSeeding();message("Seeding stopped.");
    });
    $("retry-publication").onclick=()=>run("Retrying announcement…",async()=>{capturing=true;syncControls(true);await session.client.retryPublication();message("");});
    $("copy-magnet").onclick=()=>run("Copying magnet…",async()=>{
        await navigator.clipboard.writeText(seed.magnet);message("Magnet copied.");
    });
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
        if(!await confirm("Discard pending writes?","Discard pending writes and close this Windows session? The source file is preserved.","Discard writes"))return;
        await session.discardWrites();message("Writes discarded.");
    });
    $("cancel").onclick=()=>{session.cancel();message("Cancellation requested…");};
    $("close").onclick=()=>run("Closing identity…",async()=>{
        if(!await confirm("Close identity?","Pending changes and the prepared download for this session will be lost."+(seed.active&&!(seed.replicas?.complete>0)?" No complete replica has been confirmed; this also stops seeding.":""),"Close identity"))return;
        publicationControls.close();await session.close();bootLatest=false;$("identity").textContent="";$("analysis-options").hidden=true;
        $("password").value="";$("empty-size").value="1024";
        message("");
    });
    return {syncControls,relaySigner:()=>session.description?.readOnly?undefined:session.client};
}
