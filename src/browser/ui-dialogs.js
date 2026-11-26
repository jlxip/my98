const bound = new WeakSet();
let confirmation, pending;

export const hasOpenDialog = () => !!document.querySelector('dialog[open]');

export function restoreDialogFocus(trigger) {
    const candidates = [trigger, trigger?.closest('.dropdown-menu')?.querySelector(':scope > button'),
        ...document.querySelectorAll('#disk-menu-trigger, #disk-state-trigger, #disk-user, #display')];
    candidates.find(element => element?.isConnected && !element.disabled && element.getClientRects().length)?.focus({preventScroll:true});
}

/** Native focus trapping, with one consistent exterior/×/Escape dismissal. */
export function bindDialog(dialog) {
    if(bound.has(dialog)) return;
    bound.add(dialog);
    let backdrop = false;
    dialog.addEventListener('pointerdown', event => {backdrop = event.target === dialog;});
    dialog.addEventListener('click', event => {if(backdrop && event.target === dialog) dialog.close('cancel');});
    dialog.addEventListener('keydown', event => {if(event.key === 'Escape') event.stopPropagation();});
    dialog.addEventListener('cancel', event => event.stopPropagation());
    new MutationObserver(() => document.dispatchEvent(new Event('my98:modalchange')))
        .observe(dialog, {attributes:true, attributeFilter:['open']});
}

/** A second request is rejected, never queued or approved with the first. */
export function confirmAction({title, message, confirmLabel, trigger = document.activeElement}) {
    if(pending) return Promise.resolve(false);
    if(!confirmation) {
        confirmation = document.createElement('dialog');
        confirmation.id = 'ui-confirm-dialog';
        confirmation.className = 'alert-dialog ui-confirm';
        confirmation.setAttribute('aria-labelledby', 'ui-confirm-title');
        confirmation.setAttribute('aria-describedby', 'ui-confirm-message');
        confirmation.innerHTML = '<div><header><h2 id="ui-confirm-title"></h2><button type="button" class="btn ui-close" data-variant="ghost" aria-label="Close" autofocus>×</button></header><section><p id="ui-confirm-message"></p></section><footer><button type="button" class="btn" data-variant="destructive" id="ui-confirm-accept"></button></footer></div>';
        confirmation.querySelector('.ui-close').onclick = () => confirmation.close('cancel');
        confirmation.querySelector('#ui-confirm-accept').onclick = () => confirmation.close('accept');
        bindDialog(confirmation);
        confirmation.addEventListener('close', () => {
            const request = pending;
            if(!request) return;
            pending = undefined;
            request.resolve(confirmation.returnValue === 'accept');
            queueMicrotask(() => restoreDialogFocus(request.trigger));
        });
    }
    const container = document.fullscreenElement || document.webkitFullscreenElement || document.body;
    if(confirmation.parentNode !== container) container.append(confirmation);
    confirmation.querySelector('#ui-confirm-title').textContent = title;
    confirmation.querySelector('#ui-confirm-message').textContent = message;
    confirmation.querySelector('#ui-confirm-accept').textContent = confirmLabel;
    confirmation.returnValue = 'cancel';
    return new Promise(resolve => {
        pending = {resolve, trigger};
        try {
            document.exitPointerLock?.();
            confirmation.showModal();
            confirmation.querySelector('.ui-close').focus();
        } catch(error) {pending = undefined; resolve(false); throw error;}
    });
}
