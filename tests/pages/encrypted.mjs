// Exercise the authenticated UI with the native compatibility fixture.
export async function unlockIdentity(page) {
    await page.locator("#disk-user").fill("disk fixtures");
    await page.locator("#disk-password").fill("public compatibility password");
    await page.locator("#disk-login button").click();
    await page.waitForFunction(() => !document.querySelector("#disk-workspace").hidden && !document.querySelector("#disk-open").disabled);
}
export async function diskAction(page,id) {
    const action=page.locator('#'+id);
    const dropdown=await action.evaluate(element=>element.closest('.dropdown-menu')?.id);
    if(dropdown&&await page.locator('#'+dropdown+' > button').getAttribute('aria-expanded')!=='true')
        await page.locator('#'+dropdown+' > button').click();
    const menu=await action.evaluate(element=>element.closest('details')?.id);
    if(menu&&!await page.locator('#'+menu).evaluate(element=>element.open))
        await page.locator('#'+menu+' > summary').click();
    await action.click();
}
export async function bootEncrypted(page, file) {
    let stage="unlock";
    try {
        await unlockIdentity(page);
        stage="open";
        const chooser = page.waitForEvent("filechooser");
        await diskAction(page,"disk-open");
        await (await chooser).setFiles(file);
        await page.waitForFunction(() => !document.querySelector("#disk-boot").disabled);
        stage="boot";
        await page.locator("#disk-boot").click();
        await page.waitForFunction(() => !document.querySelector("#session").hidden && !document.querySelector("#pause").disabled);
    } catch(error) {
        // Capture the still-open page before finally closes the browser. Never
        // retry the boot or change its deadline to turn an intermittent fault green.
        let timer;
        try {
            const diagnostic=await Promise.race([
                page.evaluate(()=>({status:document.querySelector('#disk-status')?.textContent,
                    sessionStatus:document.querySelector('#session-status')?.textContent,
                    sessionHidden:document.querySelector('#session')?.hidden,pauseDisabled:document.querySelector('#pause')?.disabled,
                    vm:window.vm?{running:vm.is_running(),halted:vm.v86?.cpu?.in_hlt?.[0]}:null,
                    resources:performance.getEntriesByType('resource').filter(e=>/wasm|bios|speaker/.test(e.name)).map(e=>({name:e.name,duration:e.duration,bytes:e.transferSize}))})),
                new Promise(resolve=>{timer=setTimeout(()=>resolve({unavailable:'page did not respond'}),1000);}),
            ]);
            const detail='Boot diagnostic '+JSON.stringify({stage,...diagnostic});
            console.error(detail);
            error.message+='\n'+detail;
            error.stack+='\n'+detail;
        } catch(diagnosticError){error.message+='\nBoot diagnostic unavailable: '+String(diagnosticError);}
        finally{clearTimeout(timer);}
        throw error;
    }
}
