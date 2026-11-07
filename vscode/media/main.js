// Webview side of the Claude Swap sidebar. Builds the DOM with textContent only: account names and emails come
// from cswap output and are never parsed as HTML.
(function () {
    'use strict';
    const vscode = acquireVsCodeApi();
    const app = document.getElementById('app');
    const open = new Set((vscode.getState() || {}).open || []);

    const el = (tag, cls, text) => {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    };
    const level = (p) => (p == null ? 'none' : p >= 85 ? 'danger' : p >= 60 ? 'warn' : 'ok');
    const pct = (w) => (w && w.pct != null ? w.pct + '%' : '—');
    const send = (msg) => vscode.postMessage(msg);
    const clock = (epoch) => (epoch ? new Date(epoch * 1000).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '');

    function button(text, cls, onClick, title) {
        const b = el('button', cls, text);
        if (title) b.title = title;
        b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
        return b;
    }

    function meter(name, w) {
        const row = el('div', 'meter');
        const head = el('div', 'meter-head');
        head.append(el('span', 'meter-name', name), el('span', 'meter-pct ' + level(w && w.pct), pct(w)));
        const track = el('div', 'track');
        const fill = el('div', 'fill ' + level(w && w.pct));
        fill.style.width = Math.min(100, Math.max(0, (w && w.pct) || 0)) + '%';
        track.append(fill);
        row.append(head, track);
        if (w && w.resetIn) row.append(el('div', 'meter-note', 'Resets in ' + w.resetIn + (w.reset ? ' · ' + clock(w.reset) : '')));
        if (w && !w.willLast && w.runsOutAt) row.append(el('div', 'meter-note warn-text', 'At this pace: full around ' + clock(w.runsOutAt)));
        return row;
    }

    function section(title, extra) {
        const s = el('section', 'section');
        const h = el('h3', null, title);
        if (extra) h.append(el('span', 'muted small', ' ' + extra));
        s.append(h);
        return s;
    }

    const ICON = { active: '●', switch: '⇄', full: '⦸', relogin: '⚠', disabled: '◌', nodata: '…' };
    const TIP = { active: 'Active account', switch: 'You can switch here', full: 'A limit is at 100%',
        relogin: 'Needs re-login', disabled: 'Disabled (held out of rotation)', nodata: 'No recent data' };

    function summary(a) {
        if (a.statusText && a.status !== 'ok' && !a.stale) return a.statusText;
        const s = pct(a.five) + ' · ' + pct(a.week);
        return a.stale ? s + ' (old)' : s;
    }

    function accountRow(a) {
        const item = el('div', 'account' + (open.has(a.number) ? ' open' : ''));
        const head = el('div', 'account-head');
        head.tabIndex = 0;
        const icon = el('span', 'icon state-' + a.state, ICON[a.state] || '');
        icon.title = TIP[a.state] || '';
        head.append(icon, el('span', 'name', a.label), el('span', 'summary', summary(a)));
        const toggle = () => {
            open.has(a.number) ? open.delete(a.number) : open.add(a.number);
            vscode.setState({ open: [...open] });
            item.classList.toggle('open');
        };
        head.addEventListener('click', toggle);
        head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
        const body = el('div', 'account-body');
        if (a.email) body.append(el('div', 'muted small', a.email + (a.org ? ' · ' + a.org : '') + (a.plan ? ' · ' + a.plan : '')));
        if (a.five) body.append(meter('Session (5hr)', a.five));
        if (a.week) body.append(meter('Weekly (7 day)', a.week));
        for (const m of a.models) body.append(meter(m.name + ' (weekly)', m));
        if (a.statusText) body.append(el('div', 'meter-note warn-text', a.statusText + (a.error ? ' (' + a.error + ')' : '')));
        if (!a.active) body.append(button('Switch to ' + a.label, 'primary', () => send({ type: 'switch', number: a.number })));
        item.append(head, body);
        return item;
    }

    function draw(m) {
        app.replaceChildren();
        const bar = el('div', 'toolbar');
        bar.append(
            button(m.busy ? 'Refreshing…' : '↻ Refresh', 'link', () => send({ type: 'refresh' }), 'Check usage again'),
            button('＋ Add', 'link', () => send({ type: 'add' }), 'Save another Claude login'),
            button('Dashboard', 'link', () => send({ type: 'dashboard' }), 'Open the full cswap dashboard in a terminal'));
        app.append(bar);

        if (m.error) app.append(el('div', 'error', m.error));
        if (!m.hasData) { if (!m.error) app.append(el('p', 'muted', 'Loading…')); return; }
        if (!m.accounts.length) {
            app.append(el('p', 'muted', 'No saved accounts. Log in with /login in Claude Code, then press ＋ Add.'));
            return;
        }

        const a = m.active;
        if (a) {
            const s = section('Active account');
            s.append(el('div', 'active-name', a.label), el('div', 'muted small', a.email + (a.plan ? ' · ' + a.plan : '')));
            if (a.five) s.append(meter('Session (5hr)', a.five));
            if (a.week) s.append(meter('Weekly (7 day)', a.week));
            for (const x of a.models) s.append(meter(x.name + ' (weekly)', x));
            if (a.statusText) s.append(el('div', 'meter-note warn-text', a.statusText));
            app.append(s);
        }

        const runOut = section('If you run out');
        if (m.best) {
            const row = el('div', 'best');
            row.append(el('span', 'name', m.best.label), el('span', 'summary', summary(m.best)),
                button('Switch', 'primary small-btn', () => send({ type: 'switch', number: m.best.number })));
            runOut.append(row);
        } else runOut.append(el('p', 'muted small', m.accounts.length > 1 ? 'No account to switch to right now.' : 'Add another account to have one to switch to.'));
        app.append(runOut);

        const list = section('Accounts', m.accounts.length + ' saved');
        for (const x of m.accounts) list.append(accountRow(x));
        app.append(list);
    }

    window.addEventListener('message', (e) => { if (e.data && e.data.type === 'model') draw(e.data.model); });
    send({ type: 'ready' });
})();
