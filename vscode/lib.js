// Pure logic for the Claude Swap sidebar: turns `cswap list --json` into the model the panel and status bar draw.
// No vscode import here, so it runs under `node --test` (test/lib.test.js).
'use strict';

// Every usageStatus `cswap list --json` emits (claude_swap/json_output.py). Unknown values are treated like
// 'unavailable' so a future status never renders as healthy.
const STATUS_TEXT = {
    ok: null,
    unavailable: 'No recent data',
    token_expired: 'Token expired',
    relogin_required: 'Re-login needed',
    no_credentials: 'No saved login',
    api_key: 'API key (no quota)',
};
const RELOGIN = new Set(['relogin_required', 'token_expired', 'no_credentials']);
const LOGIN_WARN_DAYS = 7;   // warn this many days before a stored login ends
const MODEL_SHOW_PCT = 60;   // a per-model window is shown for a non-active account only from this level

const toEpoch = (iso) => {
    if (typeof iso !== 'string') return null;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? Math.floor(t / 1000) : null;
};
const pctOf = (w) => (w && typeof w.pct === 'number' && Number.isFinite(w.pct) ? Math.round(w.pct) : null);

// "2h 5m", "4d 23h", "12m", "now". Computed from the reset time at render, not cswap's countdown string, which
// is frozen at the moment of the last poll.
function fmtDuration(secs) {
    if (secs == null) return '';
    if (secs <= 0) return 'now';
    const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600), m = Math.floor((secs % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${Math.max(m, 1)}m`;
}

// A window whose reset has passed is a new, empty window until cswap fetches again: show 0%, not the old number.
function windowView(name, w, now) {
    if (!w) return null;
    const reset = toEpoch(w.resetsAt);
    const rolled = reset != null && reset <= now;
    return {
        name,
        pct: rolled ? 0 : pctOf(w),
        reset: rolled ? null : reset,
        resetIn: rolled ? '' : fmtDuration(reset == null ? null : reset - now),
        willLast: rolled ? true : w.willLastToReset !== false,
        runsOutAt: rolled ? null : toEpoch(w.projectedExhaustionAt),
    };
}

function labelOf(a) {
    if (a.alias) return a.alias;
    if (typeof a.email === 'string' && a.email.includes('@')) return a.email.split('@')[0];
    return `Account ${a.number}`;
}

// One account row in display shape.
function accountView(a, now) {
    const u = a.usage || a.lastGoodUsage || null;  // lastGoodUsage: shown, but never used to pick a switch target
    const windows = [
        windowView('5h', u && u.fiveHour, now),
        windowView('7d', u && u.sevenDay, now),
        ...(Array.isArray(u && u.scoped) ? u.scoped.filter((s) => s && s.name).map((s) => windowView(String(s.name), s, now)) : []),
    ].filter(Boolean);
    const status = Object.prototype.hasOwnProperty.call(STATUS_TEXT, a.usageStatus) ? a.usageStatus : 'unavailable';
    const pcts = windows.map((w) => w.pct).filter((p) => p != null);
    const fullWins = windows.filter((w) => w.pct != null && w.pct >= 100);
    // Usable again when every full window has reset: the latest of their resets.
    const backAt = fullWins.length && fullWins.every((w) => w.reset != null) ? Math.max(...fullWins.map((w) => w.reset)) : null;
    const loginExpires = toEpoch(a.loginExpiresAt);
    let state;
    if (a.active) state = 'active';
    else if (RELOGIN.has(status)) state = 'relogin';
    else if (a.disabled) state = 'disabled';
    else if (fullWins.length) state = 'full';
    else if (status === 'ok') state = 'usable';
    else state = 'nodata';
    return {
        number: a.number,
        label: labelOf(a),
        email: typeof a.email === 'string' ? a.email : '',
        active: !!a.active,
        disabled: !!a.disabled,
        status,
        statusText: STATUS_TEXT[status],
        state,
        full: fullWins.length > 0,
        peak: pcts.length ? Math.max(...pcts) : null,
        backAt,
        backIn: backAt == null ? '' : fmtDuration(backAt - now),
        stale: !a.usage && !!a.lastGoodUsage,
        error: a.usageError || null,
        windows,
        weekReset: (windows.find((w) => w.name === '7d') || {}).reset ?? null,
        loginExpires,
        loginDaysLeft: loginExpires == null ? null : Math.floor((loginExpires - now) / 86400),
    };
}

// Lowest peak usage wins; on a near-tie (within 5 points) the account whose weekly window resets sooner, so quota
// that would expire unused is spent first.
function byRoom(a, b) {
    if (Math.abs(a.peak - b.peak) > 5) return a.peak - b.peak;
    return (a.weekReset ?? Infinity) - (b.weekReset ?? Infinity) || a.peak - b.peak;
}

// The account to suggest: not active, not disabled, fresh ('ok') usage, nothing at 100%. Null when there is none.
function bestTarget(accounts) {
    const ok = accounts.filter((a) => !a.active && !a.disabled && a.status === 'ok' && !a.full && a.peak != null);
    return ok.sort(byRoom)[0] || null;
}

// Display order: active, usable by most room, then no data / re-login / disabled, then full by soonest back.
const RANK = { active: 0, usable: 1, nodata: 2, relogin: 3, disabled: 4, full: 5 };
function sortAccounts(accounts) {
    return [...accounts].sort((a, b) => (RANK[a.state] - RANK[b.state])
        || (a.state === 'usable' ? byRoom(a, b) : 0)
        || (a.state === 'full' ? (a.backAt ?? Infinity) - (b.backAt ?? Infinity) : 0)
        || a.number - b.number);
}

// Warnings shown at the foot of the panel; empty when nothing needs attention.
function footWarnings(accounts, now) {
    const out = [];
    for (const a of accounts) {
        if (a.state === 'relogin') out.push(`${a.label}: ${a.statusText.toLowerCase()} (log in, then Add)`);
        else if (a.loginDaysLeft != null && a.loginDaysLeft < LOGIN_WARN_DAYS) {
            out.push(a.loginDaysLeft <= 0 ? `${a.label}: login ends today` : `${a.label}: login ends in ${a.loginDaysLeft} day${a.loginDaysLeft === 1 ? '' : 's'}`);
        }
    }
    return out;
}

// The active account's pace warning: the first weekly window that will not last to its reset.
function paceWarning(active) {
    if (!active) return null;
    const w = active.windows.find((x) => x.name !== '5h' && !x.willLast && x.runsOutAt && x.pct < 100);
    if (!w) return null;
    return { window: w.name === '7d' ? 'Weekly' : `${w.name} weekly`, at: w.runsOutAt };
}

// Which windows to draw for a row: all of them for the active account; for others 5h and 7d, plus any per-model
// window that is getting high.
function visibleWindows(a) {
    if (a.active) return a.windows;
    return a.windows.filter((w) => w.name === '5h' || w.name === '7d' || (w.pct != null && w.pct >= MODEL_SHOW_PCT));
}

// Parse `cswap list --json` stdout -> { accounts (display order), active, best, warnings, pace } or { error }.
function parseList(text, now = Math.floor(Date.now() / 1000)) {
    let doc;
    try { doc = JSON.parse(text); } catch { return { error: 'cswap returned output that is not JSON.' }; }
    if (!doc || typeof doc !== 'object') return { error: 'cswap returned an empty document.' };
    if (doc.error) return { error: (doc.error && (doc.error.message || doc.error.kind)) || 'cswap reported an error.' };
    if (doc.schemaVersion !== 1) return { error: `Unsupported cswap JSON schema (${doc.schemaVersion}); update this extension.` };
    if (!Array.isArray(doc.accounts)) return { error: 'cswap JSON has no accounts list.' };
    const accounts = sortAccounts(doc.accounts.filter((a) => a && Number.isInteger(a.number)).map((a) => accountView(a, now)))
        .map((a) => ({ ...a, shown: visibleWindows(a) }));
    const active = accounts.find((a) => a.active) || null;
    return {
        accounts,
        active,
        best: bestTarget(accounts),
        warnings: footWarnings(accounts, now),
        pace: paceWarning(active),
    };
}

// Status bar: "work 13% · 91% ⇄ personal".
function statusBarText(model) {
    if (!model || model.error) return '$(pulse) Claude Swap';
    const a = model.active;
    if (!a) return '$(pulse) no active account';
    const p = (name) => { const w = a.windows.find((x) => x.name === name); return w && w.pct != null ? `${w.pct}%` : '—'; };
    const next = model.best ? ` $(arrow-swap) ${model.best.label}` : '';
    return `$(pulse) ${a.label} ${p('5h')} · ${p('7d')}${next}`;
}

module.exports = { parseList, accountView, bestTarget, sortAccounts, statusBarText, fmtDuration, labelOf, LOGIN_WARN_DAYS };
