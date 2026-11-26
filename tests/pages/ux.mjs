import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium,firefox,webkit} from 'playwright';
import {serveSite,quietAudio} from './server.mjs';
import {diskFixture} from './fixture.mjs';
import {bootEncrypted,unlockIdentity,diskAction} from './encrypted.mjs';
import {browserOptions} from '../browser-options.mjs';

const output='build/pages-tests/ux';await mkdir(output,{recursive:true});
const fixture=await diskFixture(),server=await serveSite({headers:true});
try {for(const [name,engine] of Object.entries({chromium,firefox,webkit}).filter(([name])=>!process.env.MY98_UX_BROWSERS||process.env.MY98_UX_BROWSERS.split(',').includes(name))) {
    const browser=await engine.launch(browserOptions(name));
    try {
        const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
        page.on('pageerror',error=>errors.push(String(error)));
        page.on('dialog',dialog=>{errors.push('Unexpected native dialog: '+dialog.message());dialog.dismiss();});
        await page.addInitScript(quietAudio);
        await page.goto(server.url);await page.waitForFunction(()=>!document.body.inert);
        await page.evaluate(async()=>{
            const {DiskSession}=await import('/src/browser/disk-session.js'),unlock=DiskSession.prototype.unlock;
            DiskSession.prototype.unlock=function(...args){window.uxSession=this;return unlock.apply(this,args);};
            const {Slop86Disk}=await import('/build/disk/web/client.js'),create=Slop86Disk.create;
            Slop86Disk.create=async function(events){window.uxPublishing=events.onPublishing;window.uxClient=await create.call(this,events);return uxClient;};
            const {V86}=await import('/build/libv86.mjs'),run=V86.prototype.run;
            V86.prototype.run=function(...args){window.uxVm=this;return run.apply(this,args);};
            Element.prototype.requestFullscreen=undefined;Element.prototype.webkitRequestFullscreen=undefined;
        });
        const dialog=page.locator('#ui-confirm-dialog'),surface=dialog.locator(':scope > div');
        const idle=()=>page.waitForFunction(()=>!document.querySelector('#disk-close').disabled);
        async function dismiss(how='escape') {
            await surface.waitFor({state:'visible'});
            assert(await dialog.locator('.ui-close').isEnabled());assert(await dialog.locator('#ui-confirm-accept').isEnabled());
            if(how==='cross')await dialog.locator('.ui-close').click();
            else if(how==='outside')await page.mouse.click(1,1);
            else await page.keyboard.press('Escape');
            await surface.waitFor({state:'hidden'});await idle();
        }
        // Public dialog contract: no browser confirm mock and no destructive application call.
        for(const how of ['cross','escape','outside','accept','drag']) {
            await page.evaluate(async()=>{
                const {confirmAction}=await import('/src/browser/ui-dialogs.js');
                let trigger=document.getElementById('ux-trigger');if(!trigger){trigger=document.createElement('button');trigger.id='ux-trigger';trigger.textContent='Fixture action';document.body.prepend(trigger);}
                trigger.focus();window.uxAnswers=[];
                confirmAction({title:'Discard fixture changes?',message:'Only a public fixture.',confirmLabel:'Discard',trigger}).then(value=>uxAnswers.push(value));
            });
            await surface.waitFor({state:'visible'});assert(await dialog.locator('.ui-close').evaluate(e=>e===document.activeElement));
            if(how==='accept')await dialog.locator('#ui-confirm-accept').click();
            else if(how==='drag') {
                const box=await dialog.locator('header').boundingBox();await page.mouse.move(box.x+8,box.y+8);await page.mouse.down();await page.mouse.move(1,1);await page.mouse.up();assert(await surface.isVisible());await page.keyboard.press('Escape');
            } else if(how==='cross')await dialog.locator('.ui-close').click();
            else if(how==='outside')await page.mouse.click(1,1);
            else await page.keyboard.press('Escape');
            await page.waitForFunction(()=>uxAnswers.length===1);assert.deepEqual(await page.evaluate(()=>uxAnswers),[how==='accept']);
            assert(await page.locator('#ux-trigger').evaluate(e=>e===document.activeElement));
        }
        await page.evaluate(async()=>{
            const {confirmAction}=await import('/src/browser/ui-dialogs.js');window.uxAnswers=[];
            confirmAction({title:'First',message:'One approval only.',confirmLabel:'Accept'}).then(v=>uxAnswers.push(v));
            confirmAction({title:'Second',message:'Never queued.',confirmLabel:'Accept'}).then(v=>uxAnswers.push(v));
        });
        await dialog.locator('#ui-confirm-accept').click();await page.waitForFunction(()=>uxAnswers.length===2);assert.deepEqual(await page.evaluate(()=>uxAnswers),[false,true]);
        await unlockIdentity(page);
        await diskAction(page,'disk-empty');await page.locator('#disk-empty-size').fill('17');await page.keyboard.press('Escape');
        assert(await page.locator('#disk-empty-form').isHidden());assert(await page.locator('#disk-menu-trigger').evaluate(e=>e===document.activeElement));
        await diskAction(page,'disk-empty');assert.equal(await page.locator('#disk-empty-size').inputValue(),'17');await page.locator('#disk-empty-cancel').click();
        await page.locator('#disk-tools-trigger').focus();await page.keyboard.press('ArrowDown');assert.equal(await page.locator('#disk-tools-trigger').getAttribute('aria-expanded'),'true');await page.keyboard.press('Escape');
        assert(await page.locator('#disk-tools-trigger').evaluate(e=>e===document.activeElement));
        await page.evaluate(()=>{
            window.uxCopied=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{async writeText(text){uxCopied.push(text);}}});
            uxClient.stopSeeding=async()=>{window.uxStopped=(window.uxStopped||0)+1;uxPublishing({active:false,state:'stopped'});};
            uxPublishing({active:true,state:'seeding',magnet:'magnet:?xs=urn:btpk:'+'11'.repeat(32),replicas:{complete:0,label:'0'}});
        });
        assert.equal(await page.locator('#disk-copy-magnet').getAttribute('data-icon'),'magnet');assert.equal(await page.locator('#disk-stop-seeding').getAttribute('data-icon'),'pause');assert.equal(await page.locator('#disk-close').getAttribute('data-icon'),'log-out');
        await page.locator('#disk-copy-magnet').click();await idle();assert.equal(await page.evaluate(()=>uxCopied.length),1);
        await page.locator('#disk-replica-info').click();assert(await page.locator('#disk-replica-help').isVisible());
        await page.locator('#disk-identity').hover();assert(await page.locator('#disk-replica-help').isVisible(),'click pins the help');
        await page.locator('#disk-identity').click();assert(await page.locator('#disk-replica-help').isHidden(),'outside click closes without refocusing/reopening');
        await page.locator('#disk-replica-info').focus();await page.keyboard.press('Tab');
        assert(!(await page.locator('#disk-replica-info').evaluate(e=>e===document.activeElement)),'Tab must not be trapped by help dismissal');
        assert(await page.locator('#disk-replica-help').isHidden());await page.keyboard.press('Escape');
        await page.locator('#disk-replica-info').click();assert(await page.locator('#disk-replica-help').isVisible());
        await page.locator('#disk-replica-info').click();assert(await page.locator('#disk-replica-help').isHidden(),'second click unpins and closes');
        await page.locator('#disk-identity').click();await page.locator('#disk-replica-info').focus();assert(await page.locator('#disk-replica-help').isVisible());await page.keyboard.press('Escape');assert(await page.locator('#disk-replica-help').isHidden());
        await page.locator('#disk-stop-seeding').click();await dismiss('cross');assert.equal(await page.evaluate(()=>window.uxStopped||0),0);
        await page.locator('#disk-stop-seeding').click();await dialog.locator('#ui-confirm-accept').click();await idle();assert.equal(await page.evaluate(()=>uxStopped),1);
        const identity=await page.locator('#disk-identity').textContent();await page.locator('#disk-close').click();await dismiss('outside');assert.equal(await page.locator('#disk-identity').textContent(),identity);
        await page.locator('#disk-close').click();await dialog.locator('#ui-confirm-accept').click();await page.locator('#disk-login').waitFor({state:'visible'});
        await bootEncrypted(page,fixture.file);await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('#vm-view').classList.contains('expanded'));
        await page.waitForFunction(()=>uxVm.v86.cpu.in_hlt[0]&&!document.querySelector('#disk-publish').disabled);
        await page.locator('#machine-info').hover();assert(await page.locator('#machine-help').isVisible());await page.keyboard.press('Escape');assert(await page.locator('#machine-help').isHidden());
        await page.locator('#pause').click();await page.waitForFunction(()=>!document.querySelector('#pause').disabled);await page.locator('#machine-info').focus();assert.match(await page.locator('#machine-help').textContent(),/Resume/);await page.keyboard.press('Escape');
        await page.locator('#pause').click();await page.waitForFunction(()=>!document.querySelector('#disk-publish').disabled);
        await page.evaluate(()=>{
            window.uxOriginal=structuredClone(uxSession.description);
            uxSession.description.remote={infoHash:'ab'.repeat(20),publicationInfoHash:'cd'.repeat(20),stateInfoHash:'ef'.repeat(20),sequence:'1',following:true};
            uxClient.publicationDetails=async()=>({hasState:true,hasProfiles:true,profiles:[]});
        });
        // Cancel every remaining application confirmation before its effect.
        await diskAction(page,'disk-analyze');await page.locator('#disk-analyze-boot').click();await dismiss();
        const chooser=page.waitForEvent('filechooser');await diskAction(page,'disk-load-state');await(await chooser).setFiles({name:'fixture.my98state',mimeType:'application/octet-stream',buffer:Buffer.alloc(16)});await dismiss();
        await diskAction(page,'disk-publish');await dismiss();
        await diskAction(page,'disk-discard');await dismiss();
        await diskAction(page,'disk-remove-state');await dismiss();
        await page.evaluate(()=>uxSession.publication={state:'complete',sequence:'2',infoHash:'12'.repeat(20)});
        await page.locator('#disk-update-publication').waitFor({state:'visible'});await page.locator('#disk-update-publication').click();await dismiss();
        // A changed context cannot reuse an approval for closing the old identity/disk.
        await page.locator('#disk-close').click();await surface.waitFor({state:'visible'});
        await page.evaluate(()=>uxSession.description.disk_id=[42]);await dialog.locator('#ui-confirm-accept').click();await idle();
        assert.match(await page.locator('#disk-status').textContent(),/selection changed/);assert(await page.locator('#disk-workspace').isVisible());
        await page.evaluate(()=>{uxSession.description=uxOriginal;uxSession.publication=undefined;});
        await page.locator('#fullscreen').click();
        await page.evaluate(async()=>{const {confirmAction}=await import('/src/browser/ui-dialogs.js');window.uxAnswers=[];confirmAction({title:'Fullscreen fixture',message:'Escape closes this dialog only.',confirmLabel:'Accept'}).then(v=>uxAnswers.push(v));});
        await page.keyboard.press('Escape');await page.waitForFunction(()=>uxAnswers.length===1);assert(await page.locator('#vm-view').evaluate(e=>e.classList.contains('expanded')));await page.keyboard.press('Escape');
        for(const width of [1280,390,320]) {
            await page.setViewportSize({width,height:900});await page.locator('#pause').focus();await page.locator('#machine-info').focus();
            const box=await page.locator('#machine-help').boundingBox();assert(box&&box.x>=0&&box.x+box.width<=width+1,JSON.stringify(box));
            await page.screenshot({path:output+'/'+name+'-'+width+'.png',fullPage:true});await page.keyboard.press('Escape');
            assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),JSON.stringify(await page.evaluate(()=>[...document.querySelectorAll('body *')].map(e=>{const r=e.getBoundingClientRect();return {id:e.id,tag:e.tagName,left:r.left,right:r.right,width:r.width};}).filter(r=>r.width&&r.right>innerWidth+1))));
        }
        await page.setViewportSize({width:320,height:220});
        await page.evaluate(async()=>{const {confirmAction}=await import('/src/browser/ui-dialogs.js');confirmAction({title:'Close identity?',message:'Pending changes and prepared downloads will be lost. '.repeat(5),confirmLabel:'Close identity'});});
        const bounds=await dialog.locator(':scope > div').boundingBox();assert(bounds&&bounds.y>=0&&bounds.y+bounds.height<=221,JSON.stringify(bounds));await dialog.locator('#ui-confirm-accept').scrollIntoViewIfNeeded();await page.keyboard.press('Escape');
        assert.deepEqual(errors,[]);
        const touch=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
        try {
            await touch.goto(server.url);await touch.waitForFunction(()=>!document.body.inert);
            await touch.evaluate(()=>{document.querySelector('#disk-workspace').hidden=false;document.querySelector('#disk-seeding').hidden=false;});
            const info=touch.locator('#disk-replica-info'),help=touch.locator('#disk-replica-help');
            const target=await info.boundingBox();assert(target.width>=44&&target.height>=44);
            await info.tap();assert(await help.isVisible());await info.tap();assert(await help.isHidden());
            await info.tap();assert(await help.isVisible());await touch.locator('#disk-brand').tap();assert(await help.isHidden());
        } finally {await touch.close();}
        console.log(name+': eight confirmations, busy/context/duplicate guards, grouped help/click/exterior/Tab/touch, drafts, icons and mobile PASS');
    } finally {await browser.close();}
}} finally {await server.close();await fixture.close();}
