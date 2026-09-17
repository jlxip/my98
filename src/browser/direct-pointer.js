// Absolute input for a guest already configured to accept VMware mouse packets.
// No guest probing or cursor manipulation: the native browser cursor stays visible.
export function setupDirectPointer({ display, getSurface, getMachine, focus = () => {} })
{
    let enabled = false, vm = null, gesture = null, buttons = [false, false, false];
    let previousMouseEnabled = true, previousCursor = "";
    const listeners = [];
    const listen = (target, type, handler, options) => {
        target.addEventListener(type, handler, options);
        listeners.push(() => target.removeEventListener(type, handler, options));
    };
    const running = () => vm && getMachine() === vm && vm.is_running();
    function position(event, clamp = false)
    {
        const surface = getSurface();
        if(!surface) return null;
        const r = surface.getBoundingClientRect();
        if(r.width <= 0 || r.height <= 0) return null;
        const x = event.clientX - r.left, y = event.clientY - r.top;
        if(!clamp && (x < 0 || y < 0 || x >= r.width || y >= r.height)) return null;
        return [Math.max(0, Math.min(r.width, x)), Math.max(0, Math.min(r.height, y)), r.width, r.height];
    }
    function move(point)
    {
        vm.bus.send("mouse-pointer-lock", false);
        vm.bus.send("mouse-absolute", point);
    }
    function release()
    {
        const previous = gesture;
        gesture = null;
        if(buttons.some(Boolean)) vm?.bus.send("mouse-click", [false, false, false]);
        buttons = [false, false, false];
        if(previous && display.hasPointerCapture(previous.id)) display.releasePointerCapture(previous.id);
    }
    function consume(event)
    {
        event.preventDefault();
        event.stopImmediatePropagation();
    }
    function unlocked()
    {
        if(!enabled) return;
        if(document.pointerLockElement) document.exitPointerLock();
        vm?.bus.send("mouse-pointer-lock", false);
    }
    function setEnabled(value)
    {
        value = !!value;
        if(value === enabled) return;
        release();
        if(value)
        {
            vm = getMachine();
            if(!vm) return;
            // Clear the legacy adapter's private button latches before suspending it.
            // Its normal mouseup handler owns these latches; a bus release alone does not.
            const surface = getSurface() || display;
            for(const button of [0, 1, 2]) surface.dispatchEvent(new MouseEvent("mouseup", { button, bubbles: true }));
            vm.bus.send("mouse-click", [false, false, false]);
            previousMouseEnabled = vm.mouse_adapter?.emu_enabled ?? true;
            vm.mouse_set_enabled(false);
            previousCursor = display.style.cursor;
            display.style.cursor = "default";
            enabled = true;
            unlocked();
        }
        else
        {
            enabled = false;
            display.style.cursor = previousCursor;
            vm?.mouse_set_enabled(previousMouseEnabled);
            vm = null;
        }
    }
    listen(display, "pointerdown", event => {
        if(!enabled) return;
        consume(event);
        if(!running() || document.pointerLockElement) return;
        const point = position(event);
        if(event.pointerType !== "mouse")
        {
            if(gesture || !event.isPrimary) { release(); return; }
            if(!point) return;
            gesture = { id: event.pointerId, touch: true, x: event.clientX, y: event.clientY, cancelled: false };
        }
        else
        {
            if(!point || event.button > 2) return;
            if(gesture?.touch) release();
            move(point);
            buttons = [!!(event.buttons & 1), !!(event.buttons & 4), !!(event.buttons & 2)];
            vm.bus.send("mouse-click", [...buttons]);
            gesture = { id: event.pointerId, touch: false };
        }
        focus();
        display.setPointerCapture(event.pointerId);
    }, true);
    listen(display, "pointermove", event => {
        if(!enabled) return;
        consume(event);
        if(!running()) { release(); return; }
        if(gesture?.touch)
        {
            if(gesture.id === event.pointerId && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 8)
                gesture.cancelled = true;
            return;
        }
        if(event.pointerType !== "mouse" || document.pointerLockElement) return;
        if(gesture && !event.buttons) release();
        const point = position(event, !!gesture);
        if(point) move(point);
        if(gesture)
        {
            const next = [!!(event.buttons & 1), !!(event.buttons & 4), !!(event.buttons & 2)];
            if(next.some((value, i) => value !== buttons[i])) {
                buttons = next;
                vm.bus.send("mouse-click", [...buttons]);
            }
        }
    }, true);
    listen(display, "pointerup", event => {
        if(!enabled) return;
        consume(event);
        if(!gesture || gesture.id !== event.pointerId) return;
        if(!running()) { release(); return; }
        if(gesture.touch)
        {
            const point = position(event);
            const click = point && !gesture.cancelled && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) <= 8;
            release();
            if(click)
            {
                move(point);
                vm.bus.send("mouse-click", [true, false, false]);
                vm.bus.send("mouse-click", [false, false, false]);
            }
        }
        else
        {
            const point = position(event, true);
            if(point) move(point);
            buttons = [!!(event.buttons & 1), !!(event.buttons & 4), !!(event.buttons & 2)];
            vm.bus.send("mouse-click", [...buttons]);
            if(!buttons.some(Boolean)) release();
        }
    }, true);
    for(const type of ["pointercancel", "lostpointercapture"])
        listen(display, type, event => { if(enabled && gesture?.id === event.pointerId) release(); }, true);
    // A second finger anywhere cancels a pending tap, including in the letterbox or controls.
    listen(document, "pointerdown", event => {
        if(enabled && gesture && event.pointerType !== "mouse" && event.pointerId !== gesture.id) release();
    }, true);
    listen(display, "wheel", event => {
        if(!enabled) return;
        consume(event);
        const point = position(event);
        if(!running() || !point || document.pointerLockElement) return;
        move(point);
        vm.bus.send("mouse-wheel", [-Math.sign(event.deltaY), -Math.sign(event.deltaX)]);
    }, { capture: true, passive: false });
    // Suppress compatibility events and the adapter's window-level touch handlers.
    for(const type of ["mousedown", "mouseup", "mousemove", "click", "dblclick", "contextmenu", "touchstart", "touchmove", "touchend", "touchcancel"])
        listen(display, type, event => { if(enabled) consume(event); }, { capture: true, passive: false });
    listen(window, "blur", release);
    listen(document, "visibilitychange", () => { if(document.hidden) release(); });
    listen(document, "pointerlockchange", unlocked);
    return {
        get enabled() { return enabled; },
        activate() { setEnabled(true); },
        deactivate() { setEnabled(false); },
        release,
        destroy() { setEnabled(false); for(const remove of listeners) remove(); },
    };
}
