/** Exercise application dialogs, never replace the production confirmation API. */
export async function autoConfirm(page, choice = true) {
    await page.exposeFunction('__fixtureConfirmation', () => typeof choice === 'function' ? choice() : choice);
    const install = () => {
        if(window.fixtureConfirmationObserver) return;
        const answering = new WeakSet();
        const answer = () => {
            for(const dialog of document.querySelectorAll('#ui-confirm-dialog[open]')) {
                if(answering.has(dialog)) continue;
                answering.add(dialog);
                window.__fixtureConfirmation().then(accepted => {
                    if(dialog.open) dialog.querySelector(accepted ? '#ui-confirm-accept' : '.ui-close').click();
                    answering.delete(dialog);
                });
            }
        };
        window.fixtureConfirmationObserver = new MutationObserver(answer);
        fixtureConfirmationObserver.observe(document,{subtree:true,childList:true,attributes:true,attributeFilter:['open']});
        answer();
    };
    await page.addInitScript(install);
    await page.evaluate(install);
}
