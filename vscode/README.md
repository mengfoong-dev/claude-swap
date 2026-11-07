# Claude Swap Sidebar

A VS Code side bar and status bar for [claude-swap](https://github.com/realiti4/claude-swap):
every saved account's 5-hour and weekly usage, the account with the most room left, and one-click switching.

It is a thin front end over the `cswap` CLI: usage comes from `cswap list --json` (the documented JSON contract in
`docs/json-output.md`) and switching runs `cswap switch <n> --json`. It never reads or writes credentials itself,
and claude-swap's own usage store paces every network request.

## Install

Needs claude-swap (`pipx install claude-swap`), then:

```
node --test test/                                   # unit tests
npx --yes @vscode/vsce@3.2.1 package
code --install-extension claude-swap-sidebar-*.vsix
```

## What it shows

One flat list, laid out like `cswap watch`:

- **Active account first**, with every limit (5-hour, weekly, per-model), reset countdowns, and a warning when the
  current pace runs out before the weekly reset.
- **Then the other accounts, most room first.** The best pick is marked ★ (lowest peak usage; on a near-tie, the one
  whose weekly window resets sooner, so quota is not left to expire). Each has a **Switch** button.
- **Accounts at 100%** shrink to one line: `full · back in 2d 4h`.
- **Warnings at the foot only when needed**: re-login required, or a login that ends within 7 days.
- **Status bar**: `work 13% · 91% ⇄ personal`. Orange from 85%, red at 100%. Click it to open the side bar.
- **Header**: switch (quick pick) and refresh; the ⋯ menu has add account, switch to best, auto-switch, and the
  full terminal dashboard.

## Auto-switch (off by default)

The toggle at the top runs one tick of claude-swap's own engine (`cswap auto --once --threshold N --model all`)
after each poll. When the active account reaches the line on any limit, claude-swap moves Claude Code to the
account with the most room, with its own cooldown and hysteresis. It asks for confirmation the first time.

Settings: `claudeSwap.path`, `claudeSwap.pollSeconds` (default 60), `claudeSwap.autoSwitch`,
`claudeSwap.autoSwitchThreshold` (default 90).
