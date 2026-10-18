// Exercise the authenticated UI with the native compatibility fixture.
export async function unlockIdentity(page) {
    await page.locator("#disk-user").fill("disk fixtures");
    await page.locator("#disk-password").fill("public compatibility password");
    await page.locator("#disk-login button").click();
    await page.waitForFunction(() => !document.querySelector("#disk-workspace").hidden && !document.querySelector("#disk-open").disabled);
}
export async function diskAction(page,id) {
    const action=page.locator('#'+id);
    const menu=await action.evaluate(element=>element.closest('details')?.id);
    if(menu&&!await page.locator('#'+menu).evaluate(element=>element.open))
        await page.locator('#'+menu+' > summary').click();
    await action.click();
}
export async function bootEncrypted(page, file) {
    await unlockIdentity(page);
    const chooser = page.waitForEvent("filechooser");
    await diskAction(page,"disk-open");
    await (await chooser).setFiles(file);
    await page.waitForFunction(() => !document.querySelector("#disk-boot").disabled);
    await page.locator("#disk-boot").click();
    await page.waitForFunction(() => !document.querySelector("#session").hidden && !document.querySelector("#pause").disabled);
}
