'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseList, statusBarText, fmtDuration, labelOf } = require('../lib');

const NOW = 1_800_000_000;
const iso = (secs) => new Date((NOW + secs) * 1000).toISOString();
const row = (n, over = {}) => ({
    number: n, email: `user${n}@example.com`, active: false, usageStatus: 'ok',
    usage: { fiveHour: { pct: 10, resetsAt: iso(3600) }, sevenDay: { pct: 20, resetsAt: iso(86400 * 3) } },
    ...over,
});
const doc = (accounts) => JSON.stringify({ schemaVersion: 1, activeAccountNumber: 1, accounts });

test('parses the documented list --json shape', () => {
    const m = parseList(doc([row(1, { active: true, alias: 'main' }), row(2)]), NOW);
    assert.equal(m.accounts.length, 2);
    assert.equal(m.active.label, 'main');
    assert.equal(m.active.five.pct, 10);
    assert.equal(m.active.five.resetIn, '1h 0m');
    assert.equal(m.accounts[1].label, 'user2');
    assert.equal(m.accounts[1].state, 'switch');
});

test('rejects bad input instead of rendering it', () => {
    assert.match(parseList('not json', NOW).error, /not JSON/);
    assert.match(parseList(JSON.stringify({ schemaVersion: 2, accounts: [] }), NOW).error, /schema/);
    assert.match(parseList(JSON.stringify({ schemaVersion: 1, error: { message: 'boom' } }), NOW).error, /boom/);
    assert.equal(parseList(doc([{ number: 'x' }, null, row(1)]), NOW).accounts.length, 1);
});

test('best target: lowest peak among usable accounts, never active/disabled/full/stale', () => {
    const m = parseList(doc([
        row(1, { active: true }),
        row(2, { usage: { fiveHour: { pct: 5, resetsAt: iso(60) }, sevenDay: { pct: 70, resetsAt: iso(999) } } }),
        row(3, { usage: { fiveHour: { pct: 40, resetsAt: iso(60) }, sevenDay: { pct: 30, resetsAt: iso(999) } } }),
        row(4, { disabled: true, usage: { fiveHour: { pct: 0 }, sevenDay: { pct: 0 } } }),
        row(5, { usage: { fiveHour: { pct: 0 }, sevenDay: { pct: 100, resetsAt: iso(999) } } }),
        row(6, { usageStatus: 'unavailable', usage: null, lastGoodUsage: { fiveHour: { pct: 0 }, sevenDay: { pct: 1 } } }),
    ]), NOW);
    assert.equal(m.best.number, 3);  // peak 40 beats account 2's peak 70
    assert.equal(m.accounts.find((a) => a.number === 5).state, 'full');
    assert.equal(m.accounts.find((a) => a.number === 6).stale, true);
});

test('no target when nothing qualifies', () => {
    assert.equal(parseList(doc([row(1, { active: true })]), NOW).best, null);
});

test('a window whose reset has passed shows as empty, not the old number', () => {
    const m = parseList(doc([row(1, { active: true, usage: { fiveHour: { pct: 97, resetsAt: iso(-60) }, sevenDay: { pct: 50, resetsAt: iso(500) } } })]), NOW);
    assert.equal(m.active.five.pct, 0);
    assert.equal(m.active.five.resetIn, '');
    assert.equal(m.active.full, false);
});

test('re-login states and unknown statuses never render as healthy', () => {
    const m = parseList(doc([
        row(1, { active: true }),
        row(2, { usageStatus: 'relogin_required', usage: null }),
        row(3, { usageStatus: 'something_new', usage: null }),
    ]), NOW);
    assert.equal(m.accounts[1].state, 'relogin');
    assert.equal(m.accounts[1].statusText, 'Re-login needed');
    assert.equal(m.accounts[2].status, 'unavailable');
    assert.equal(m.accounts[2].state, 'nodata');
});

test('pace: projected run-out surfaces only when it will not last', () => {
    const m = parseList(doc([row(1, { active: true, usage: { sevenDay: { pct: 91, resetsAt: iso(86400), willLastToReset: false, projectedExhaustionAt: iso(3600), aheadOfPace: true } } })]), NOW);
    assert.equal(m.active.week.willLast, false);
    assert.equal(m.active.week.runsOutAt, NOW + 3600);
    assert.equal(m.active.five, null);  // a window the account does not have is omitted
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
    assert.equal(fmtDuration(4 * 86400 + 23 * 3600), '4d 23h');
    assert.equal(labelOf({ number: 7 }), 'Account 7');
});
