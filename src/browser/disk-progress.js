/** Session coverage only; observing progress never reads or downloads disk data. */
export function setupDiskProgress(element, getSession) {
    if(!element) return {update() {}};
    const arc = element.querySelector("circle:last-child"), label = element.querySelector("span");
    let timer, pending = false, source, generation = 0;
    const same = (a, b) => a?.client === b?.client && a?.adapter === b?.adapter && a?.cid === b?.cid;
    function hide() {
        element.hidden = true;
        element.removeAttribute("aria-valuenow");
        label.textContent = "";
        arc.setAttribute("stroke-dasharray", "0 100");
    }
    function schedule() {
        clearTimeout(timer);
        if(source && !document.hidden) timer = setTimeout(update, 500);
    }
    async function poll(current, epoch) {
        pending = true;
        try {
            const stats = await current.client.readStats();
            const latest = getSession();
            if(epoch !== generation || !same(current, latest) || latest.busy || document.hidden) return;
            const {coveredBytes, totalBytes} = stats.remote || {};
            if(!Number.isSafeInteger(totalBytes) || totalBytes <= 0 || !Number.isSafeInteger(coveredBytes) || coveredBytes < 0 || coveredBytes > totalBytes) {hide();return;}
            const value = 100 * coveredBytes / totalBytes;
            const percent = coveredBytes === totalBytes ? 100 : Math.min(99, Math.floor(value));
            label.textContent = `${percent}%`;
            arc.setAttribute("stroke-dasharray", `${value} 100`);
            element.setAttribute("aria-valuenow", String(percent));
            element.hidden = false;
        } catch {
            if(epoch === generation && same(current, getSession())) hide();
        } finally {
            pending = false;
            schedule();
        }
    }
    function update() {
        clearTimeout(timer);
        const current = getSession();
        if(!same(current, source)) {generation++;hide();}
        source = current;
        if(!source) {hide();return;}
        if(document.hidden) return;
        if(!pending && !current.busy) void poll(current, generation);
        else schedule();
    }
    document.addEventListener("visibilitychange", update);
    hide();
    return {update};
}
