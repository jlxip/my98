/** Local file/VM controls. Secret contexts stay in the independent disk Worker. */
export function setupDisk(host) {
    const $ = id => document.getElementById("disk-" + id);
    let client, BufferClass, state, adapter, active = false, working = false, capturing = false, prepared = false;
    const message = (text,error=false) => { $("status").textContent=text;$("status").classList.toggle("error",error); };
    function syncControls(busy) {
        $("workspace").hidden=!client;$("login").hidden=!!client;
        $("panel").querySelectorAll("button,input").forEach(e=>e.disabled=busy||working);
        $("create").disabled ||= !!state;$("open").disabled ||= !!state;$("remote").disabled ||= !!state;$("gateway").disabled ||= !!state;
        for(const id of ["boot","save","download","discard","verify"]) $(id).disabled ||= !state;
        $("boot").disabled ||= active || !!adapter?.failed;
        $("save").disabled ||= !active || !!adapter?.failed;
        $("download").disabled ||= !!state?.dirty_bytes;
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
        event.preventDefault();let username=$("user").value,password=$("password").value,machine=$("machine").value;$("password").value="";
        run("Unlocking identity…",async()=>{
            const module=await import("../../build/disk/web/client.js");BufferClass=module.DiskBuffer;
            const candidate=await module.Slop86Disk.create({onProgress:p=>{
                if(capturing && p.phase==="resolve") message("Finding remote disk…");
                else if(capturing) message(`${({verify:"Verifying",encrypt:"Encrypting",download:"Downloading",resolve:"Finding remote disk"})[p.phase]||"Working"}: ${(p.completed/1048576).toFixed(1)} MiB…`);
            }});
            try {const identity=await candidate.unlock(username,password,machine);client=candidate;$("identity").textContent=identity.ipnsName;message("Identity unlocked. Create a disk, open a .my98 file, or find your remote disk.");}
            catch(error){await candidate.close().catch(()=>{});throw error;}
            finally {username=password=machine="";}
        });
    };
    $("create").onclick=()=>run("Choosing image…",async()=>{
        const [file]=await host.pickFiles();if(!file)return;
        capturing=true;syncControls(true);state=await client.createFromImage(file);download(state.download);
    });
    $("open").onclick=()=>run("Opening encrypted disk…",async()=>{
        const [file]=await host.pickFiles();if(!file)return;
        state=await client.open(file);prepared=false;message("Header authenticated. Disk data will be read and verified on demand.");
    });
    $("remote").onclick=()=>run("Finding remote disk…",async()=>{
        capturing=true;syncControls(true);
        state=await client.openRemote({gateway:$("gateway").value});prepared=false;
        message("Remote disk authenticated. The full disk downloads in the background while you use it. Changes are saved locally.");
    });
    $("boot").onclick=()=>run("Booting encrypted disk…",async()=>{
        if(state.size%512)throw new Error("The image is preserved exactly, but its length does not allow booting it as an HDD.");
        if(host.hasSession()&&!window.confirm("Close the current Windows session and boot this disk? Save its disk or state first."))return;
        await client.read(0,512);
        adapter?.dispose();adapter=new BufferClass(client,state.size,async error=>{await host.fail(error);message("Disk stopped: "+error.message+". You can retry the operation.",true);syncControls(host.busy());});
        await host.boot(adapter,"Encrypted disk");active=true;message("Windows is using the encrypted disk. Shut it down before saving.");
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
        await client.close();client=state=undefined;prepared=false;$("identity").textContent="";message("Identity closed.");
    });
    return {syncControls};
}
