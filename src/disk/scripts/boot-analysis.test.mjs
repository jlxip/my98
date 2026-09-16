import assert from 'node:assert/strict';
import {test} from 'node:test';
import {BootAnalysis, MAX_ANALYSIS_UNITS} from '../web/boot-analysis.js';
import {selectBootRanges} from './range-profile.mjs';

test('first-touch order, repeated and crossing reads match the range generator', () => {
    const a = new BootAnalysis('snapshot', 16 * 65536);
    a.observe(8 * 65536, 512);
    a.observe(65536 - 1, 65538);
    a.observe(8 * 65536, 512);
    a.observe(-1, 1); a.observe(a.size, 1); a.observe(10, 0);
    assert.deepEqual([...a.units], [8, 0, 1, 2]);
    const {details, rankSum, ...expected} = selectBootRanges([8, 0, 1, 2]);
    const result = a.finish();
    assert.deepEqual(result, [{version:1, cid:'snapshot', unitBytes:65536, ...expected}]);
    a.observe(12 * 65536, 512);
    assert.deepEqual(a.finish(), result);
});

test('frozen snapshot survives generation failure and never acquires later reads', () => {
    const a = new BootAnalysis('snapshot', 655360);
    a.observe(0, 512);
    // Simulate a generator failure without altering the production generator.
    a.units.add(-1);
    assert.throws(() => a.finish(), /Invalid/);
    a.observe(5 * 65536, 512);
    a.units.delete(-1);
    assert.equal(a.finish()[0].observedUnits, 1);
    const fresh = new BootAnalysis('other', a.size);
    assert.equal(fresh.finish()[0].observedUnits, 0);
});

test('200,000 unique units are accepted; overflow is reported once and cannot export', () => {
    const a = new BootAnalysis('snapshot', (MAX_ANALYSIS_UNITS + 2) * 65536);
    assert.equal(a.observe(0, MAX_ANALYSIS_UNITS * 65536), false);
    assert.equal(a.units.size, MAX_ANALYSIS_UNITS);
    assert.equal(a.observe(0, 512), false);
    assert.equal(a.recording, true);
    assert.equal(a.observe(MAX_ANALYSIS_UNITS * 65536, 512), true);
    assert.equal(a.observe((MAX_ANALYSIS_UNITS + 1) * 65536, 512), false);
    assert.equal(a.units.size, MAX_ANALYSIS_UNITS);
    assert.throws(() => a.finish(), {code:'ANALYSIS_INCOMPLETE'});
});
