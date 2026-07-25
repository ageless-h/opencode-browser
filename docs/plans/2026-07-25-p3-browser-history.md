# P3 Implementation Plan: Browser History (Codex-aligned)

## Scope

Mirror Codex `browser.user.history` only. No domain policy.

## Tasks

- [x] Design: `docs/superpowers/specs/2026-07-25-p3-browser-history-design.md`
- [x] Parent design P3 wording: drop allow/block hard gate
- [x] Manifest: `"history"` permission
- [x] Extension: `history` tool → `chrome.history.search` → `BrowserHistoryEntry[]`
- [x] Broker: `history` in no-tab tools
- [x] Plugin: `browser_history` (`queries`/`from`/`to`/`limit`)
- [x] Agent-backend: unsupported stub
- [x] README tools + roadmap
- [x] `bun run build` + `node bin/cli.js update`
- [x] Extension Reload (user) + live smoke

## Smoke (passed 2026-07-25)

- `history limit:3` → array len≤3, ordered by `dateVisited` desc
- `queries:["example"]` → example.com/org hits
- `from`/`to` 30d + `queries:["http"]` → shapeOk + withinBounds
- multi-query merge OK
