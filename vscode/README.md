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

- **Active account**: session (5hr) and weekly bars, per-model weekly limits, reset countdowns, and a warning when
  the current pace runs out before the reset.
- **If you run out**: the account with the lowest peak usage that is fresh, enabled and below 100% everywhere.
- **Accounts**: every saved account; click one for its bars and a Switch button.
- **Status bar**: `work 13% · 91% ⇄ personal`. Orange from 85%, red at 100%. Click it to open the side bar.

Settings: `claudeSwap.path` (where `cswap` is) and `claudeSwap.pollSeconds` (default 60).
