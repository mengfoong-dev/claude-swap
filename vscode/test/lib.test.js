'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseList, statusBarText, fmtDuration, labelOf } = require('../lib');

const NOW = 1_800_000_000;
const DAY = 86400;
const iso = (secs) => new Date((NOW + secs) * 1000).toISOString();
const win = (pct, resetIn, extra = {}) => ({ pct, resetsAt: iso(resetIn), ...extra });
const row = (n, over = {}) => ({
    number: n, email: `user${n}@example.com`, active: false, usageStatus: 'ok',
    usage: { fiveHour: win(10, 3600), sevenDay: win(20, DAY * 3) },
    ...over,
});
const doc = (accounts) => JSON.stringify({ schemaVersion: 1, activeAccountNumber: 1, accounts });
const byNum = (m, n) => m.accounts.find((a) => a.number === n);

test('parses the documented list --json shape', () => {
    const m = parseList(doc([row(1, { active: true, alias: 'main' }), row(2)]), NOW);
    assert.equal(m.accounts.length, 2);
    assert.equal(m.active.label, 'main');
    const five = m.active.windows.find((w) => w.name === '5h');
    assert.equal(five.pct, 10);
    assert.equal(five.resetIn, '1h 0m');
    assert.equal(byNum(m, 2).label, 'user2');
    assert.equal(byNum(m, 2).state, 'usable');
});

test('rejects bad input instead of rendering it', () => {
    assert.match(parseList('not json', NOW).error, /not JSON/);
    assert.match(parseList(JSON.stringify({ schemaVersion: 2, accounts: [] }), NOW).error, /schema/);
    assert.match(parseList(JSON.stringify({ schemaVersion: 1, error: { message: 'boom' } }), NOW).error, /boom/);
    assert.equal(parseList(doc([{ number: 'x' }, null, row(1)]), NOW).accounts.length, 1);
});

test('order: active, usable by most room, then problems, then full by soonest back', () => {
    const m = parseList(doc([
        row(1, { usage: { fiveHour: win(0, 60), sevenDay: win(100, DAY * 3) } }),        // full, back in 3d
        row(2, { usage: { fiveHour: win(40, 60), sevenDay: win(30, DAY * 2) } }),        // peak 40
        row(3, { active: true }),
        row(4, { usage: { fiveHour: win(5, 60), sevenDay: win(10, DAY * 6) } }),         // peak 10
        row(5, { usage: { fiveHour: win(0, 60), sevenDay: win(100, DAY) } }),            // full, back in 1d
        row(6, { usageStatus: 'relogin_required', usage: null }),
    ]), NOW);
    assert.deepEqual(m.accounts.map((a) => a.number), [3, 4, 2, 6, 5, 1]);
    assert.equal(byNum(m, 5).backIn, '1d 0h');
});

test('best target: lowest peak; near-tie goes to the sooner weekly reset; never active/disabled/full/stale', () => {
    const m = parseList(doc([
        row(1, { active: true }),
        row(2, { usage: { fiveHour: win(5, 60), sevenDay: win(70, 999) } }),
        row(3, { usage: { fiveHour: win(40, 60), sevenDay: win(30, DAY * 5) } }),
        row(4, { disabled: true, usage: { fiveHour: win(0, 60), sevenDay: win(0, 60) } }),
        row(5, { usage: { fiveHour: win(0, 60), sevenDay: win(100, 999) } }),
        row(6, { usageStatus: 'unavailable', usage: null, lastGoodUsage: { fiveHour: win(0, 60), sevenDay: win(1, 60) } }),
        row(7, { usage: { fiveHour: win(38, 60), sevenDay: win(30, DAY * 2) } }),    // within 5 of #3, resets sooner
    ]), NOW);
    assert.equal(m.best.number, 7);
    assert.equal(byNum(m, 5).state, 'full');
    assert.equal(byNum(m, 6).stale, true);
    assert.equal(parseList(doc([row(1, { active: true })]), NOW).best, null);
});

test('a window whose reset has passed shows as empty, not the old number', () => {
    const m = parseList(doc([row(1, { active: true, usage: { fiveHour: win(97, -60), sevenDay: win(50, 500) } })]), NOW);
    const five = m.active.windows.find((w) => w.name === '5h');
    assert.equal(five.pct, 0);
    assert.equal(five.resetIn, '');
    assert.equal(m.active.full, false);
});

test('re-login states and unknown statuses never render as healthy', () => {
    const m = parseList(doc([
        row(1, { active: true }),
        row(2, { usageStatus: 'relogin_required', usage: null }),
        row(3, { usageStatus: 'something_new', usage: null }),
    ]), NOW);
    assert.equal(byNum(m, 2).state, 'relogin');
    assert.equal(byNum(m, 3).status, 'unavailable');
    assert.equal(byNum(m, 3).state, 'nodata');
    assert.deepEqual(m.warnings, ['user2: re-login needed (log in, then Add)']);
});

test('login-ending warning only inside 7 days', () => {
    const m = parseList(doc([
        row(1, { active: true, loginExpiresAt: iso(DAY * 3 + 60) }),
        row(2, { loginExpiresAt: iso(DAY * 20) }),
        row(3, { loginExpiresAt: iso(DAY + 60) }),
    ]), NOW);
    assert.deepEqual(m.warnings, ['user1: login ends in 3 days', 'user3: login ends in 1 day']);
});

test('pace warning: the first weekly window that will not last', () => {
    const m = parseList(doc([row(1, { active: true, usage: {
        fiveHour: win(50, 60, { willLastToReset: false }),
        sevenDay: win(91, DAY, { willLastToReset: false, projectedExhaustionAt: iso(3600) }),
    } })]), NOW);
    assert.deepEqual(m.pace, { window: 'Weekly', at: NOW + 3600 });
    assert.equal(parseList(doc([row(1, { active: true })]), NOW).pace, null);
});

test('visible windows: all for active; 5h/7d plus high per-model windows for others', () => {
    const scoped = [{ name: 'ModelA', ...win(15, DAY) }, { name: 'ModelB', ...win(80, DAY) }];
    const m = parseList(doc([
        row(1, { active: true, usage: { fiveHour: win(1, 60), sevenDay: win(2, DAY), scoped } }),
        row(2, { usage: { fiveHour: win(1, 60), sevenDay: win(2, DAY), scoped } }),
    ]), NOW);
    assert.deepEqual(m.active.shown.map((w) => w.name), ['5h', '7d', 'ModelA', 'ModelB']);
    assert.deepEqual(byNum(m, 2).shown.map((w) => w.name), ['5h', '7d', 'ModelB']);
});

test('status bar text', () => {
    const m = parseList(doc([row(1, { active: true, alias: 'main' }), row(2, { alias: 'spare' })]), NOW);
    assert.equal(statusBarText(m), '$(pulse) main 10% · 20% $(arrow-swap) spare');
    assert.equal(statusBarText({ error: 'x' }), '$(pulse) Claude Swap');
});

test('durations and labels', () => {
    assert.equal(fmtDuration(0), 'now');
    assert.equal(fmtDuration(30), '1m');
    assert.equal(fmtDuration(3 * 3600 + 120), '3h 2m');
    assert.equal(fmtDuration(4 * DAY + 23 * 3600), '4d 23h');
    assert.equal(labelOf({ number: 7 }), 'Account 7');
});
