import {bindDialog} from "./ui-dialogs.js";
import {compatibility} from './machine-factory.js';

/** State/profile publication leaves the running VM and its pinned disk untouched. */
export function setupPublicationControls({session,$,host,run,message,syncControls,sources,confirm}) {
    const dialog=$('profiles-dialog'),status=$('profiles-status');
    let imported=[],owner,disk,awaitingProfiles=false;
    const drafts=new Map();
    const saveDraft=()=>{if(owner&&disk)drafts.set(disk,{imported,boot:$('profile-boot').value,state:$('profile-state').value,files:Array.from($('profile-file').files),status:status.textContent,error:status.classList.contains('error')});};
    const note=(text,error=false)=>{status.textContent=text;status.classList.toggle('error',error);};
    const reset=()=>{drafts.delete(disk);$('profiles-form').reset();imported=[];note('');};
    const config=async()=>({sources:await sources(),compatibility:await compatibility()});
    async function publishState(file) {
        const options=await config();
        // Check the base before pausing/capturing the user's machine.
        await session.client.publicationDetails(options);
        if(!file){const captured=await session.saveMachineState(()=>syncControls(true));file=captured.blob;}
        await session.client.publishUpdate({...options,action:'state',file});
        message('State publication prepared.');
    }
    $('publish-state').onclick=()=>run('Preparing state publication…',()=>publishState());
    $('publish-state-file').onclick=()=>run('Preparing state publication…',async()=>{const [file]=await host.pickFiles();if(file)await publishState(file);});
    $('remove-state').onclick=()=>run('Removing published state…',async()=>{
        const options=await config(),details=await session.client.publicationDetails(options);
        if(!details.hasState){message('This publication has no state.');return;}
        if(!await confirm('Remove published state?', 'Remove the published state and its resume profile? The base disk and boot profile are preserved.', 'Remove state'))return;
        await session.client.publishUpdate({...options,action:'remove-state'});message('State removal prepared.');
    });
    $('profiles').onclick=()=>run('Checking published profiles…',async()=>{
        const client=session.client,base=session.description.remote.infoHash;
        if(owner!==client||disk!==base){
            saveDraft();if(owner!==client)drafts.clear();$('profiles-form').reset();imported=[];note('');owner=client;disk=base;
            const draft=drafts.get(base);if(draft){imported=draft.imported;$('profile-boot').value=draft.boot;$('profile-state').value=draft.state;const files=new DataTransfer();for(const file of draft.files)files.items.add(file);$('profile-file').files=files.files;note(draft.status,draft.error);}
        }
        const details=await client.publicationDetails({sources:await sources()});
        for(const kind of ['boot','state']) {
            $('profile-'+kind+'-current').textContent=details.profiles.some(p=>p.origin.kind===kind)?'Published':'Not published';
            const select=$('profile-'+kind);
            select.querySelector('[value=generated]').disabled=!session.loadProfiles.some(p=>p.origin.kind===kind&&p.infoHash===base);
            select.querySelector('[value=file]').disabled=!imported.some(p=>p.origin.kind===kind);
        }
        dialog.showModal();
    });
    $('profiles-close').onclick=()=>dialog.close();
    bindDialog(dialog);
    $('profile-file').onchange=async()=>{
        const file=$('profile-file').files[0];if(!file)return;
        try {
            if(file.size>65536)throw Error('Load profiles exceed 64 KiB.');
            const value=JSON.parse(await file.text());
            if(!Array.isArray(value)||!value.length||value.length>2||value.some(p=>!['boot','state'].includes(p?.origin?.kind))||new Set(value.map(p=>p.origin.kind)).size!==value.length)throw Error('Choose a load profiles JSON array.');
            imported=value;
            for(const p of imported){const select=$('profile-'+p.origin.kind);select.querySelector('[value=file]').disabled=false;select.value='file';}
            note('Profiles imported.');
        }catch(error){note(error.message,true);}
    };
    $('profiles-form').onsubmit=event=>{
        event.preventDefault();
        const profiles=[],remove=[];
        for(const kind of ['boot','state']) {
            const action=$('profile-'+kind).value;
            if(action==='remove')remove.push(kind);
            if(action==='generated'||action==='file') {
                const profile=(action==='generated'?session.loadProfiles:imported).find(p=>p.origin.kind===kind);
                if(!profile){note('Select an available profile for '+kind+'.',true);return;}
                profiles.push(profile);
            }
        }
        if(!profiles.length&&!remove.length){note('Choose a profile to publish or remove.');return;}
        run('Preparing load profiles…',async()=>{
            try {
                const result=await session.client.publishUpdate({...await config(),action:'profiles',profiles,remove});
                if(result.state!=='seeding'){awaitingProfiles={client:session.client,base:session.description.remote.infoHash};throw Object.assign(new Error(result.error?.message||'Announcement not confirmed. Retry the retained publication.'),result.error);}
                reset();dialog.close();message('Load profiles published.');
            }
            catch(error){note(error.message,true);throw error;}
        });
    };
    return {published(value){if(awaitingProfiles&&value.state==='seeding'){const pending=awaitingProfiles;awaitingProfiles=false;if(owner===pending.client&&disk===pending.base){reset();dialog.close();}else drafts.delete(pending.base);}},close(){awaitingProfiles=false;dialog.close();reset();owner=disk=undefined;drafts.clear();}};
}
