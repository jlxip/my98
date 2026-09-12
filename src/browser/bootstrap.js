// Register the upstream worker directly: its window-side automatic reloads are
// intentionally not executed. Its worker defaults to COEP: require-corp.
export function prepareIsolation()
{
    const workerURL = new URL("../../coi-serviceworker.js", import.meta.url);
    const marker = "my98-coi-reload:" + workerURL.pathname;
    if(window.crossOriginIsolated) {
        try { sessionStorage.removeItem(marker); } catch { /* Storage is optional. */ }
        return Promise.resolve(true);
    }
    if(!window.isSecureContext || !navigator.serviceWorker || window.crossOriginIsolated !== false)
        return Promise.resolve(false);
    // A reload must have a durable loop guard, including in restricted/private contexts.
    try {
        if(sessionStorage.getItem(marker)) return Promise.resolve(false);
        sessionStorage.setItem(marker + ":probe", "1");
        sessionStorage.removeItem(marker + ":probe");
    } catch { return Promise.resolve(false); }

    return new Promise(resolve => {
        let finished = false;
        const workers = navigator.serviceWorker;
        const finish = isolated => {
            if(finished) return;
            finished = true;
            clearTimeout(timer);
            workers.removeEventListener("controllerchange", controlled);
            resolve(isolated);
        };
        const controlled = () => {
            if(finished || workers.controller?.scriptURL !== workerURL.href) return;
            try { sessionStorage.setItem(marker, "1"); }
            catch { finish(false); return; }
            // End the bootstrap's ownership of reloads before navigating. Delayed
            // registrations and future worker updates cannot reload an active app.
            finished = true;
            clearTimeout(timer);
            workers.removeEventListener("controllerchange", controlled);
            window.location.reload();
        };
        const timer = setTimeout(() => finish(false), 10000);
        workers.addEventListener("controllerchange", controlled);
        try {
            workers.register(workerURL.href, { updateViaCache: "none" }).then(controlled, () => finish(false));
        } catch { finish(false); }
    });
}

export async function start()
{
    document.querySelectorAll("button, input, select").forEach(element => element.disabled = true);
    const status = document.getElementById("acceleration-status");
    status.textContent = "Preparing Windows…";
    const isolated = await prepareIsolation();
    status.textContent = isolated ? "" : "Your browser could not enable acceleration. Windows may run more slowly.";
    await import("./win98.js");
    document.body.inert = false;
}
