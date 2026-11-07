// Claude Swap sidebar: every claude-swap account's 5-hour and weekly usage in a VS Code side bar view and the status
// bar, with one-click switching. All data and every action go through the `cswap` CLI and its documented JSON
// output (docs/json-output.md); this extension never reads or writes credentials itself.
'use strict';
const vscode = require('vscode');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { parseList, statusBarText } = require('./lib');

const cfg = () => vscode.workspace.getConfiguration('claudeSwap');

// VS Code launched from the Dock does not inherit the shell PATH, so look in pipx/uv's bin dir before PATH.
function cswapPath() {
    const set = cfg().get('path');
    if (set) return set.replace(/^~(?=\/|$)/, os.homedir());
    const local = path.join(os.homedir(), '.local', 'bin', 'cswap');
    return fs.existsSync(local) ? local : 'cswap';
}

function cswap(args, timeout = 60000) {
    return new Promise((resolve) => {
        execFile(cswapPath(), args, { timeout, env: { ...process.env, NO_COLOR: '1' }, maxBuffer: 4 * 1024 * 1024 },
            (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
    });
}

let raw = null;          // last good `list --json` stdout; re-parsed on every render so countdowns stay current
let lastError = null;    // message from the last failed poll (the panel keeps showing the last good data under it)
let inflight = null;
let busy = false;
let view = null;
let statusItem = null;

function model() {
    const m = raw ? parseList(raw) : { accounts: [], active: null, best: null };
    return { ...m, error: lastError || m.error || null, busy, hasData: !!raw };
}

function render() {
    const m = model();
    if (statusItem) {
        statusItem.text = statusBarText(m.hasData ? { ...m, error: null } : m);
        const a = m.active;
        statusItem.tooltip = a
            ? `Claude account: ${a.label}${a.email ? ` (${a.email})` : ''}\n5-hour: ${a.five && a.five.pct != null ? a.five.pct + '%' : '—'}`
              + `  ·  weekly: ${a.week && a.week.pct != null ? a.week.pct + '%' : '—'}`
              + (m.best ? `\nMost room: ${m.best.label}` : '') + '\nClick to open the Claude Swap sidebar'
            : 'Claude Swap: click to open';
        statusItem.backgroundColor = a && a.full ? new vscode.ThemeColor('statusBarItem.errorBackground')
            : a && a.peak != null && a.peak >= 85 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    }
    if (view) view.webview.postMessage({ type: 'model', model: m, now: Math.floor(Date.now() / 1000) });
}

// One `cswap list --json` at a time. claude-swap's usage store decides whether any account is actually fetched
// from the network, so calling this often never exceeds its own pacing.
function refresh() {
    if (inflight) return inflight;
    busy = true; render();
    inflight = (async () => {
        const r = await cswap(['list', '--json']);
        if (r.err && r.err.code === 'ENOENT') {
            lastError = 'cswap not found. Install claude-swap (pipx install claude-swap) or set claudeSwap.path.';
        } else {
            const parsed = parseList(r.stdout);
            if (parsed.error) lastError = parsed.error + (r.stderr.trim() ? ` ${r.stderr.trim().split('\n').pop()}` : '');
            else { raw = r.stdout; lastError = null; }
        }
    })().finally(() => { inflight = null; busy = false; render(); });
    return inflight;
}

async function switchTo(target) {
    const args = target === 'best' ? ['switch', '--strategy', 'best', '--json'] : ['switch', String(target), '--json'];
    if (target !== 'best' && !Number.isInteger(target)) return;
    busy = true; render();
    const r = await cswap(args, 120000);
    let doc = null;
    try { doc = JSON.parse(r.stdout); } catch { /* reported below */ }
    if (doc && doc.error) vscode.window.showErrorMessage(`Claude Swap: ${doc.error.message || doc.error.kind || 'switch failed'}`);
    else if (!doc) vscode.window.showErrorMessage(`Claude Swap: switch failed. ${(r.stderr || (r.err && r.err.message) || '').trim().split('\n').pop()}`);
    else if (doc.switched === false) vscode.window.showInformationMessage(`Claude Swap: ${doc.message || doc.reason || 'already on that account'}`);
    else vscode.window.showInformationMessage(`Claude Swap: ${doc.message || 'switched'}. Claude Code picks it up within about 30 s.`);
    busy = false;
    await refresh();
}

async function pickAndSwitch() {
    if (!raw) await refresh();
    const m = model();
    if (!m.accounts.length) { vscode.window.showWarningMessage('Claude Swap: no saved accounts yet.'); return; }
    const p = (w) => (w && w.pct != null ? `${w.pct}%` : '—');
    const pick = await vscode.window.showQuickPick(m.accounts.map((a) => ({
        label: `${a.active ? '$(circle-filled) ' : ''}${a.label}`,
        description: `5h ${p(a.five)} · week ${p(a.week)}${a.statusText ? ' · ' + a.statusText : ''}`,
        detail: a.email, number: a.number,
    })), { placeHolder: 'Switch Claude account' });
    if (pick) await switchTo(pick.number);
}

function terminal(name, cmd) {
    const t = vscode.window.createTerminal({ name, iconPath: new vscode.ThemeIcon('pulse') });
    t.show();
    t.sendText(cmd);
}
const quoted = () => `"${cswapPath().replace(/(["\\$`])/g, '\\$1')}"`;

async function addAccount() {
    const go = await vscode.window.showInformationMessage('Add a Claude account', {
        modal: true,
        detail: 'First log in to the new account in Claude Code (/login). Do not /logout first: it can revoke the account you are leaving. '
            + 'Then continue: a terminal runs `cswap add`, which saves whichever account is logged in now.',
    }, 'I have logged in, add it');
    if (go) { terminal('Claude Swap: add', `${quoted()} add`); setTimeout(refresh, 8000); }
}

function html(webview, root) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = (f) => webview.asWebviewUri(vscode.Uri.joinPath(root, 'media', f));
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('style.css')}"></head>
<body><div id="app"><p class="muted">Loading…</p></div>
<script nonce="${nonce}" src="${uri('main.js')}"></script></body></html>`;
}

function activate(context) {
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusItem.command = 'claudeSwap.accounts.focus';
    statusItem.show();

    context.subscriptions.push(statusItem, vscode.window.registerWebviewViewProvider('claudeSwap.accounts', {
        resolveWebviewView(v) {
            view = v;
            v.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] };
            v.webview.html = html(v.webview, context.extensionUri);
            v.webview.onDidReceiveMessage((msg) => {
                if (!msg || typeof msg !== 'object') return;
                if (msg.type === 'ready') render();
                else if (msg.type === 'refresh') refresh();
                else if (msg.type === 'switch' && (Number.isInteger(msg.number) || msg.number === 'best')) switchTo(msg.number);
                else if (msg.type === 'add') addAccount();
                else if (msg.type === 'dashboard') vscode.commands.executeCommand('claudeSwap.dashboard');
            });
            v.onDidChangeVisibility(() => { if (v.visible) refresh(); });
            v.onDidDispose(() => { view = null; });
            refresh();
        },
    }, { webviewOptions: { retainContextWhenHidden: false } }));

    context.subscriptions.push(
        vscode.commands.registerCommand('claudeSwap.refresh', refresh),
        vscode.commands.registerCommand('claudeSwap.switch', pickAndSwitch),
        vscode.commands.registerCommand('claudeSwap.switchBest', () => switchTo('best')),
        vscode.commands.registerCommand('claudeSwap.addAccount', addAccount),
        vscode.commands.registerCommand('claudeSwap.dashboard', () => terminal('Claude Swap', `${quoted()} watch`)),
    );

    // Poll on a timer (claude-swap's store paces the network), and re-render every 30 s so countdowns move.
    const secs = Math.max(30, Number(cfg().get('pollSeconds')) || 60);
    const poll = setInterval(refresh, secs * 1000);
    const tick = setInterval(render, 30 * 1000);
    context.subscriptions.push({ dispose: () => { clearInterval(poll); clearInterval(tick); } });
    refresh();
}

function deactivate() {}

module.exports = { activate, deactivate };
