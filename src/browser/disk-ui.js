/** Local file/VM controls. Secret contexts stay in the independent disk Worker. */
export function setupDisk(host) {
    const $ = id => document.getElementById("disk-" + id);
    let client, BufferClass, state, adapter, active = false, working = false, capturing = false, prepared = false;
    let analyzing = false, analysisError;
    const message = (text,error=false) => { $("status").textContent=text;$("status").classList.toggle("error",error); };
    function syncControls(busy) {
        $("workspace").hidden=!client;$("login").hidden=!!client;
        $("brand").hidden=!!client;$("notice").hidden=!client;
        document.getElementById("welcome").classList.toggle("authenticated", !!client);
        $("panel").querySelectorAll("button,input").forEach(e=>e.disabled=busy||working);
        if(!client || state) {$("empty-form").hidden=true;$("empty").setAttribute("aria-expanded","false");}
        for(const id of ["empty", "empty-size", "empty-submit", "empty-cancel"]) $(id).disabled ||= !!state;
        $("create").disabled ||= !!state;$("open").disabled ||= !!state;$("remote").disabled ||= !!state;
        $("only-localhost").disabled ||= !!state;
        for(const id of ["boot","save","download","discard","verify"]) $(id).disabled ||= !state;
        $("boot").disabled ||= active || !!adapter?.failed;
        $("save").disabled ||= !active || !!adapter?.failed;
        $("download").disabled ||= !!state?.dirty_bytes;
        $("analyze").textContent = analyzing ? "Stop analyzing" : "Analyze boot";
        $("analyze").disabled ||= !analyzing && (!state?.remote || !!state.dirty_bytes || active || !!adapter?.failed);
        if(analyzing) for(const id of ["save", "download", "verify", "discard", "retry"]) $(id).disabled = true;
        $("retry").disabled ||= !prepared;
        $("resume").hidden=!adapter?.failed;$("resume").disabled=busy||working||!adapter?.failed;
        $("cancel").hidden=!capturing;$("cancel").disabled=!capturing;
    }
    async function run(text,work) {
        if(working||host.busy())return;
        working=true;host.setBusy(true);message(text);
        try {await work();}
        catch(error) {message(error.code==="CANCELLED"?"Operation cancelled. The previous disk and its pending changes are preserved.":error.message,true);}
        finally {working=false;capturing=false;host.setBusy(false);}
    }
    function download(result) {
        prepared=true;
        host.download(result.blob,`${state.disk_id.slice(0,4).map(n=>n.toString(16).padStart(2,"0")).join("")}.my98`);
        message(`Full download prepared (${(result.size/1048576).toFixed(2)} MiB). Check that the file was saved.`);
    }
    $("login").onsubmit=event=>{
        event.preventDefault();
        if(working || host.busy() || client)return;
        const autoBoot=$("autoboot").checked;
        let username=$("user").value,password=$("password").value,machine=$("machine").value;$("password").value="";
        run("Unlocking identity…",async()=>{
            const module=await import("../../build/disk/web/client.js");BufferClass=module.DiskBuffer;
            const candidate=await module.Slop86Disk.create({onAnalysis:event=>{
                analysisError = event.error;
                message(analysisError, true);
                void client.cancelBootAnalysis().then(() => { analyzing = false; syncControls(host.busy()); }).catch(error => message(error.message, true));
            },onProgress:p=>{
                if(capturing && p.phase==="resolve") message("Finding remote disk…");
                else if(capturing) message(`${({verify:"Verifying",encrypt:"Encrypting",download:"Downloading",resolve:"Finding remote disk"})[p.phase]||"Working"}: ${(p.completed/1048576).toFixed(1)} MiB…`);
            }});
            try {const identity=await candidate.unlock(username,password,machine);client=candidate;$("identity").textContent=identity.ipnsName;message("Identity unlocked. Create a disk, open a .my98 file, or find your remote disk.");}
            catch(error){await candidate.close().catch(()=>{});throw error;}
            finally {username=password=machine="";}
            if(autoBoot) { await openRemote(); await boot(); }
        });
    };
    $("create").onclick=()=>run("Choosing image…",async()=>{
        const [file]=await host.pickFiles();if(!file)return;
        capturing=true;syncControls(true);state=await client.createFromImage(file);download(state.download);
    });
    $("empty").onclick=()=>{
        if(!client || state || working || host.busy())return;
        $("empty-form").hidden=false;$("empty").setAttribute("aria-expanded","true");$("empty-size").focus();
    };
    $("empty-cancel").onclick=()=>{
        if(working || host.busy())return;
        $("empty-form").hidden=true;$("empty").setAttribute("aria-expanded","false");$("empty").focus();
    };
    $("empty-form").onsubmit=event=>{
        event.preventDefault();
        if(!client || state || working || host.busy())return;
        const sizeMiB=$("empty-size").valueAsNumber;
        if(!$("empty-form").reportValidity())return;
        if(!Number.isSafeInteger(sizeMiB) || sizeMiB < 1 || sizeMiB > 1048576) {
            message("Enter a whole number from 1 to 1048576 MiB.",true);return;
        }
        run("Creating empty disk…",async()=>{
            capturing=true;syncControls(true);
            state=await client.createEmpty(sizeMiB*1048576);download(state.download);
        });
    };
    $("open").onclick=()=>run("Opening encrypted disk…",async()=>{
        const [file]=await host.pickFiles();if(!file)return;
        state=await client.open(file);prepared=false;message("Header authenticated. Disk data will be read and verified on demand.");
    });
    $("only-localhost").checked=false;
    $("only-localhost").onchange=()=>syncControls(host.busy());
    async function openRemote() {
        message("Finding remote disk…");capturing=true;syncControls(true);
        try {
            state=await client.openRemote({gateway:$("only-localhost").checked ? "http://127.0.0.1:8080" : undefined, onlyLocalhost:$("only-localhost").checked});prepared=false;
            message("Remote disk authenticated. The full disk downloads in the background while you use it. Changes are saved locally.");
        } finally {capturing=false;syncControls(true);}
    }
    $("remote").onclick=()=>run("Finding remote disk…",openRemote);
    async function boot(analyze = false) {
        message("Booting encrypted disk…");
        if(state.size%512)throw new Error("The image is preserved exactly, but its length does not allow booting it as an HDD.");
        if(host.hasSession()&&!window.confirm("Close the current Windows session and boot this disk? Save its disk first."))return;
        try {
            if(analyze) { await client.startBootAnalysis(); analyzing = true; analysisError = undefined; }
            await client.read(0,512);
            adapter?.dispose();adapter=new BufferClass(client,state.size,async error=>{await host.fail(error);message("Disk stopped: "+error.message+". You can retry the operation.",true);syncControls(host.busy());});
            await host.boot(adapter,"Encrypted disk",{autoFullscreen:!analyze});active=true;
            message(analysisError || (analyzing ? "Recording disk reads. When startup is complete, select Stop analyzing to download the ranges." : "Windows is using the encrypted disk. Shut it down before saving."), !!analysisError);
        } catch(error) {
            if(analyze) { await client.cancelBootAnalysis().catch(()=>{}); analyzing = false; }
            throw error;
        }
    }
    $("boot").onclick=()=>run("Booting encrypted disk…",()=>boot());
    $("analyze").onclick=()=>run(analyzing ? "Generating boot ranges…" : "Starting boot analysis…",async()=>{
        if(!analyzing) { await boot(true); return; }
        const profile = await client.finishBootAnalysis();
        analyzing = false;
        const id = state.disk_id.slice(0,4).map(n=>n.toString(16).padStart(2,"0")).join("");
        host.download(new Blob([JSON.stringify(profile, null, 2) + "\n"], {type:"application/json"}), `${id}-boot-ranges.json`);
        message("Boot ranges prepared. Check that the JSON was saved. Windows can continue running.");
    });
    $("save").onclick=()=>run("Preparing save…",async()=>{
        if(!window.confirm("Has Windows finished shutting down? Confirm to stop the VM and save the full disk.")){message("Save cancelled.");return;}
        await host.stop();capturing=true;syncControls(true);const saved=await client.save();state=saved;
        if(saved.outcome==="unchanged")message("No changes. The VM remains stopped.");else download(saved.download);
    });
    $("download").onclick=()=>run("Preparing full download…",async()=>{await host.stop();capturing=true;syncControls(true);download(await client.downloadCurrent());});
    $("retry").onclick=()=>run("Retrying download…",async()=>download(await client.retryDownload()));
    $("verify").onclick=()=>run("Verifying full disk…",async()=>{
        await host.stop();capturing=true;syncControls(true);const hash=await client.verifyImage();
        message("Disk verified. SHA-256: "+Array.from(hash,b=>b.toString(16).padStart(2,"0")).join("")+". The VM remains stopped.");
    });
    $("resume").onclick=()=>run("Retrying disk access…",async()=>{await adapter.retry();await host.resume();message("Disk access restored. Windows retains its RAM and writes.");});
    $("discard").onclick=()=>run("Discarding writes…",async()=>{
        if(!window.confirm("Discard pending writes and close this Windows session? The source file is preserved."))return;
        if(active){await host.stop();adapter?.dispose();adapter=undefined;await host.close();active=false;}
        state=await client.discardWrites();message("Writes discarded.");
    });
    $("cancel").onclick=()=>{client?.cancel();message("Cancellation requested…");};
    $("close").onclick=()=>run("Closing identity…",async()=>{
        if(!window.confirm("Close the identity? Pending changes and the prepared download for this session will be lost."))return;
        if(active)await host.stop();adapter?.dispose();adapter=undefined;await host.close();active=false;
        await client.close();client=state=undefined;prepared=false;analyzing=false;analysisError=undefined;$("identity").textContent="";
        $("password").value="";$("autoboot").checked=true;$("empty-size").value="1024";
        message("");
    });
    return {syncControls};
}
