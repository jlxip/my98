// Touch uses the same PS/2 bus as V86's mouse adapter, without Pointer Lock.
export function setupTouch({ display, view, drag, right, getMachine, focus })
{
    let gesture = null, dragArmed = false;
    const machine = () => {
        const vm = getMachine();
        return vm?.is_running() ? vm : null;
    };
    function arm(value)
    {
        dragArmed = value;
        drag.setAttribute("aria-pressed", String(value));
        drag.textContent = value ? "Dragging…" : "Drag";
    }
    function release()
    {
        const previous = gesture;
        gesture = null;
        if(previous?.dragging) previous.vm.bus.send("mouse-click", [false, false, false]);
        if(previous && display.hasPointerCapture(previous.id)) display.releasePointerCapture(previous.id);
        arm(false);
    }
    function click(vm, secondary = false)
    {
        vm.bus.send("mouse-click", [!secondary, false, secondary]);
        vm.bus.send("mouse-click", [false, false, false]);
    }
    display.addEventListener("pointerdown", event => {
        if(event.pointerType === "mouse") return;
        event.preventDefault();
        view.classList.add("touch-input");
        focus();
        if(gesture) { release(); return; } // Cancel multi-finger gestures safely.
        const vm = machine();
        if(!vm || !event.isPrimary) return;
        display.setPointerCapture(event.pointerId);
        gesture = { id: event.pointerId, vm, x: event.clientX, y: event.clientY,
            distance: 0, started: performance.now(), dragging: dragArmed };
        // A guest with an absolute pointer driver still needs relative trackpad motion.
        vm.bus.send("mouse-pointer-lock", true);
        if(dragArmed) vm.bus.send("mouse-click", [true, false, false]);
    });
    display.addEventListener("pointermove", event => {
        if(!gesture || gesture.id !== event.pointerId) return;
        event.preventDefault();
        if(machine() !== gesture.vm) { release(); return; }
        const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
        gesture.x = event.clientX; gesture.y = event.clientY;
        gesture.distance += Math.hypot(dx, dy);
        gesture.vm.bus.send("mouse-delta", [dx, -dy]);
    });
    display.addEventListener("pointerup", event => {
        if(!gesture || gesture.id !== event.pointerId) return;
        event.preventDefault();
        const tap = !gesture.dragging && gesture.distance <= 8 && performance.now() - gesture.started < 350;
        const vm = gesture.vm;
        release();
        if(tap && machine() === vm) click(vm);
    });
    for(const type of ["pointercancel", "lostpointercapture"])
        display.addEventListener(type, event => { if(gesture?.id === event.pointerId) release(); });
    // Stop V86's legacy window touch listeners from handling a gesture twice.
    // Explicit non-passive listeners also cover older WebKit gesture scrolling.
    for(const type of ["touchstart", "touchmove", "touchend", "touchcancel"])
        display.addEventListener(type, event => { event.preventDefault(); event.stopPropagation(); }, { passive: false });
    display.addEventListener("contextmenu", event => event.preventDefault());
    display.addEventListener("pointerdown", event => {
        if(event.pointerType === "mouse") {
            release();
            machine()?.bus.send("mouse-pointer-lock", !!document.pointerLockElement);
        }
    });
    drag.addEventListener("click", () => {
        const next = !dragArmed;
        release();
        if(machine()) arm(next);
        focus();
    });
    right.addEventListener("click", () => {
        release();
        const vm = machine();
        if(vm) click(vm, true);
        focus();
    });
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", () => { if(document.hidden) release(); });
    return { release };
}

export function setupFullscreen({ view, exitButton, fit, focus, status, release })
{
    let expanded = false, native = false, revision = 0;
    const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement;
    function resize()
    {
        const viewport = window.visualViewport;
        view.style.setProperty("--view-height", (viewport?.height || innerHeight) + "px");
        view.style.setProperty("--view-width", (viewport?.width || innerWidth) + "px");
        view.style.setProperty("--view-top", (viewport?.offsetTop || 0) + "px");
        view.style.setProperty("--view-left", (viewport?.offsetLeft || 0) + "px");
        fit();
    }
    function show(value)
    {
        expanded = value;
        view.classList.toggle("expanded", value);
        document.documentElement.classList.toggle("vm-expanded", value);
        exitButton.hidden = !value;
        release();
        resize();
    }
    async function exitNative()
    {
        if(fullscreenElement() !== view) return;
        try { await (document.exitFullscreen || document.webkitExitFullscreen).call(document); }
        catch { /* The browser may already be leaving fullscreen. */ }
    }
    async function exit()
    {
        revision++;
        show(false);
        await exitNative();
        native = false;
        focus();
    }
    async function enter()
    {
        if(expanded) return;
        const current = ++revision;
        show(true);
        try
        {
            const request = view.requestFullscreen || view.webkitRequestFullscreen;
            if(!request) throw new Error("Fullscreen unavailable");
            await request.call(view);
            if(current !== revision) { await exitNative(); return; }
            native = fullscreenElement() === view;
        }
        catch
        {
            if(current === revision && expanded)
            {
                const touch = matchMedia("(any-pointer: coarse)").matches || view.classList.contains("touch-input");
                status("Windows fills the browser. " + (touch ? "Use Controls" : "Press Esc") + " to leave this view.");
            }
        }
        resize();
    }
    exitButton.addEventListener("click", exit);
    for(const type of ["fullscreenchange", "webkitfullscreenchange"])
        document.addEventListener(type, () => {
            if(fullscreenElement() === view) native = true;
            else if(native) { native = false; revision++; show(false); focus(); }
            resize();
        });
    document.addEventListener("keydown", event => {
        if(event.key === "Escape" && expanded && !fullscreenElement()) {
            event.preventDefault();
            exit();
        }
    });
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("scroll", resize);
    return { enter, exit, get expanded() { return expanded; } };
}
