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
function windowView(w, now) {
    if (!w) return null;
    const reset = toEpoch(w.resetsAt);
    const rolled = reset != null && reset <= now;
    return {
        pct: rolled ? 0 : pctOf(w),
        reset: rolled ? null : reset,
        resetIn: rolled ? '' : fmtDuration(reset == null ? null : reset - now),
        aheadOfPace: !rolled && w.aheadOfPace === true,
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
    const five = windowView(u && u.fiveHour, now), week = windowView(u && u.sevenDay, now);
    const models = Array.isArray(u && u.scoped)
        ? u.scoped.filter((s) => s && s.name).map((s) => ({ name: String(s.name), ...windowView(s, now) }))
        : [];
    const status = Object.prototype.hasOwnProperty.call(STATUS_TEXT, a.usageStatus) ? a.usageStatus : 'unavailable';
    const pcts = [five, week, ...models].map((w) => w && w.pct).filter((p) => p != null);
    const full = pcts.some((p) => p >= 100);
    const peak = pcts.length ? Math.max(...pcts) : null;
    let state;
    if (a.active) state = 'active';
    else if (status === 'relogin_required' || status === 'token_expired' || status === 'no_credentials') state = 'relogin';
    else if (a.disabled) state = 'disabled';
    else if (full) state = 'full';
    else if (status === 'ok') state = 'switch';
    else state = 'nodata';
    return {
        number: a.number,
        label: labelOf(a),
        email: typeof a.email === 'string' ? a.email : '',
        org: a.organizationName || '',
        plan: (a.plan && a.plan.label) || '',
        active: !!a.active,
        disabled: !!a.disabled,
        status,
        statusText: STATUS_TEXT[status],
        state,
        full,
        peak,
        stale: !a.usage && !!a.lastGoodUsage,
        ageSec: typeof a.usageAgeSeconds === 'number' ? a.usageAgeSeconds : (typeof a.lastGoodAgeSeconds === 'number' ? a.lastGoodAgeSeconds : null),
        error: a.usageError || null,
        five,
        week,
        models,
        loginExpires: toEpoch(a.loginExpiresAt),
    };
}

// The account to suggest when the active one runs out: lowest peak usage among accounts that are not active,
// not disabled, have fresh ('ok') usage and nothing at 100%. Null when there is none.
function bestTarget(accounts) {
    let best = null;
    for (const a of accounts) {
        if (a.active || a.disabled || a.status !== 'ok' || a.full || a.peak == null) continue;
        if (!best || a.peak < best.peak) best = a;
    }
    return best;
}

// Parse `cswap list --json` stdout -> { accounts, active, best } or { error }.
function parseList(text, now = Math.floor(Date.now() / 1000)) {
    let doc;
    try { doc = JSON.parse(text); } catch { return { error: 'cswap returned output that is not JSON.' }; }
    if (!doc || typeof doc !== 'object') return { error: 'cswap returned an empty document.' };
    if (doc.error) return { error: (doc.error && (doc.error.message || doc.error.kind)) || 'cswap reported an error.' };
    if (doc.schemaVersion !== 1) return { error: `Unsupported cswap JSON schema (${doc.schemaVersion}); update this extension.` };
    if (!Array.isArray(doc.accounts)) return { error: 'cswap JSON has no accounts list.' };
    const accounts = doc.accounts.filter((a) => a && Number.isInteger(a.number)).map((a) => accountView(a, now));
    return { accounts, active: accounts.find((a) => a.active) || null, best: bestTarget(accounts) };
}

// Status bar: "work 13% · 91%", with the next-best account when there is one.
function statusBarText(model) {
    if (!model || model.error) return '$(pulse) Claude Swap';
    const a = model.active;
    if (!a) return '$(pulse) no active account';
    const p = (w) => (w && w.pct != null ? `${w.pct}%` : '—');
    const nums = a.five || a.week ? ` ${p(a.five)} · ${p(a.week)}` : '';
    const next = model.best ? ` $(arrow-swap) ${model.best.label}` : '';
    return `$(pulse) ${a.label}${nums}${next}`;
}

// Severity of a percentage, for colour: same bands as the cc-usage-bar meters.
const level = (pct) => (pct == null ? 'none' : pct >= 85 ? 'danger' : pct >= 60 ? 'warn' : 'ok');

module.exports = { parseList, accountView, bestTarget, statusBarText, fmtDuration, level, labelOf };
