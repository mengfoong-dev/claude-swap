// Webview side of the Claude Swap sidebar: one flat list, like `cswap watch`. Builds the DOM with textContent only:
// account names and emails come from cswap output and are never parsed as HTML.
(function () {
    'use strict';
    const vscode = acquireVsCodeApi();
    const app = document.getElementById('app');

    const el = (tag, cls, text) => {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    };
    const level = (p) => (p == null ? 'none' : p >= 85 ? 'danger' : p >= 60 ? 'warn' : 'ok');
    const send = (msg) => vscode.postMessage(msg);
    const clock = (epoch) => new Date(epoch * 1000).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

    function windowRow(w) {
        const row = el('div', 'row');
        const track = el('span', 'bar');
        const fill = el('i', 'fill ' + level(w.pct));
        fill.style.width = Math.min(100, Math.max(0, w.pct || 0)) + '%';
        track.append(fill);
        row.append(el('span', 'lab', w.name), track, el('span', 'pct ' + level(w.pct), w.pct == null ? '—' : w.pct + '%'),
            el('span', 'rs', w.resetIn));
        if (w.reset) row.title = `${w.name}: resets ${clock(w.reset)}`;
        return row;
    }

    function switchButton(a) {
        const b = el('button', 'sw', 'Switch');
        b.title = `Switch Claude Code to ${a.label}`;
        b.addEventListener('click', () => { b.disabled = true; b.textContent = '…'; send({ type: 'switch', number: a.number }); });
        return b;
    }

    function accountBlock(a, m) {
        // Full, disabled or no-data accounts collapse to one line.
        if (a.state === 'full' || a.state === 'disabled' || a.state === 'nodata' || a.state === 'relogin') {
            const line = el('div', 'line state-' + a.state);
            line.append(el('span', 'name', a.label));
            const tag = a.state === 'full' ? (a.backIn ? `full · back in ${a.backIn}` : 'full')
                : a.state === 'disabled' ? 'disabled' : a.statusText || 'no data';
            line.append(el('span', 'tag', tag));
            line.title = a.email;
            return line;
        }
        const box = el('div', 'acct' + (a.active ? ' active' : ''));
        const head = el('div', 'head');
        if (a.active) head.append(el('span', 'dot', '●'));
        head.append(el('span', 'name', a.label));
        head.title = a.email;
        const tag = el('span', 'tag');
        if (a.active) { tag.textContent = 'active'; tag.classList.add('t-active'); }
        else if (m.best && m.best.number === a.number) { tag.textContent = '★ most room'; tag.classList.add('t-best'); }
        head.append(tag);
        if (!a.active) head.append(switchButton(a));
        box.append(head);
        for (const w of a.shown) box.append(windowRow(w));
        if (a.stale) box.append(el('div', 'note', 'Older numbers (usage check is backing off)'));
        if (a.active && m.pace) box.append(el('div', 'warn', `⚠ ${m.pace.window} full around ${clock(m.pace.at)} — switch soon`));
        return box;
    }

    function autoBar(m) {
        const bar = el('label', 'auto');
        bar.title = 'When the active account reaches the line, claude-swap moves you to the account with the most room.';
        const box = el('input');
        box.type = 'checkbox';
        box.checked = !!m.auto.on;
        box.addEventListener('change', () => { box.checked = !box.checked; send({ type: 'auto', on: !m.auto.on }); });
        bar.append(el('span', null, `Auto-switch at ${m.auto.threshold}%`), box, el('span', 'tog'));
        return bar;
    }

    function draw(m) {
        app.replaceChildren();
        if (m.auto) app.append(autoBar(m));
        if (m.error) app.append(el('div', 'error', m.error));
        if (!m.hasData) { if (!m.error) app.append(el('p', 'muted', 'Loading…')); return; }
        if (!m.accounts.length) {
            app.append(el('p', 'muted', 'No saved accounts yet. Log in with /login in Claude Code, then use ⋯ → Add account.'));
            return;
        }
        for (const a of m.accounts) app.append(accountBlock(a, m));
        if (m.warnings.length) {
            const foot = el('div', 'foot');
            for (const w of m.warnings) foot.append(el('div', null, '⚠ ' + w));
            app.append(foot);
        }
        if (m.busy) app.append(el('div', 'busy'));
    }

    window.addEventListener('message', (e) => { if (e.data && e.data.type === 'model') draw(e.data.model); });
    send({ type: 'ready' });
})();
