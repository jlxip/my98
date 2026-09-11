import assert from "node:assert/strict";
import { v86 } from "../../build/slop86/src/main.js";

// Stopping must not wait for an arbitrarily delayed idle timer in the yield Worker.
const pending = [], events = [];
const machine = Object.assign(Object.create(v86.prototype), {
    running: true, stopping: false, idle: true, tick_counter: 4,
    cpu: { main_loop() { throw new Error("CPU executed after stop request"); } },
    bus: { send(name) { events.push(name); } },
    yield(delay, tick) { pending.push({ delay, tick }); },
});
machine.stop();
assert.deepEqual(pending, [{ delay: 0, tick: 5 }]);
machine.yield_callback(4); // The old timer must not execute a second tick.
assert.deepEqual(events, []);
machine.yield_callback(5);
assert.equal(machine.running, false);
assert.equal(machine.stopping, false);
assert.deepEqual(events, ["emulator-stopped"]);
machine.stop();
assert.equal(pending.length, 1);
console.log("Stop wakes an idle scheduler and ignores stale ticks");
