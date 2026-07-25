# P3 Design: Browser History (Codex-aligned)

**Date:** 2026-07-25  
**Status:** Approved (user: pure Codex mirror, no local innovation)  
**Base:** 4.6.1 extension + broker

## Goals

Mirror Codex Chrome `browser.user.history` on the flat `browser_*` tool surface:

```ts
history(options: BrowserHistoryOptions): Promise<Array<BrowserHistoryEntry>>
```

## Non-goals (explicitly out of P3)

- Domain allow/block / `policy.json` hard gate (not in Codex plugin API)
- `needs_confirmation` broker intercept for navigate/open
- webNavigation host interception
- Soft “risky action” confirmations (agent skill/docs only, same as Codex)

## Codex reference

| Codex | OpenCode tool |
|-------|----------------|
| `browser.user.history(options)` | `browser_history` |

**BrowserHistoryOptions** (Codex `api.json`):

- `from?: string | Date` — lower bound for visit timestamps
- `to?: string | Date` — upper bound
- `limit?: number` — max entries
- `queries?: string[]` — optional filter terms

**BrowserHistoryEntry**:

- `dateVisited: string` — ISO 8601
- `title?: string`
- `url: string`

**Agent behavior** (Codex `api-use-behavior.md`):

- History may prompt user approval (host/runtime); call only when necessary, never speculatively
- One focused call with date bounds and a small known set of `queries`

## Architecture

```
Plugin browser_history
  → Broker (no tab claim; pass-through)
  → Extension chrome.history.search
```

- **Extension** owns Chrome History API.
- **Broker** does not require tab ownership (`history` is session-global user context, like Codex `BrowserUser`).
- **agent-backend**: unsupported stub (Codex marks history unsupported on iab/cdp; our agent path has no Chrome history).

## Tool

| Tool | Behavior |
|------|----------|
| `browser_history` | Search Chrome browsing history; return entries ordered by `dateVisited` descending |

### Args

| Arg | Type | Notes |
|-----|------|--------|
| `queries` | `string[]` optional | Empty/omit → unfiltered search (`text: ""`) |
| `from` | string optional | ISO 8601 or parseable date; maps to `startTime` ms |
| `to` | string optional | ISO 8601 or parseable date; maps to `endTime` ms |
| `limit` | number optional | Default `100`, hard cap `1000` |

### Result

JSON array of `{ dateVisited, title?, url }`.

### Multi-query merge

If `queries` has multiple terms: run one `chrome.history.search` per term, merge by `url + dateVisited`, sort descending by `dateVisited`, apply `limit`.

## Permissions

- Manifest: add `"history"`
- After install/update: extension **Reload** required

## Errors

- Missing `history` permission / API unavailable → clear error asking user to Reload extension after update
- Invalid `from`/`to` → error with parse message
- agent-backend → `{ unsupported: true, message: "..." }`

## Acceptance

1. `node --check extension/background.js` + `bun run build`
2. `node bin/cli.js update` + extension Reload
3. Broker smoke: `history` with `queries:["example"]`, `limit:5` returns array shape
4. With `from`/`to` bounds, results stay inside window
5. No `policy.json` / no navigate intercept added

## Docs

- README: P3 = history tool (Codex `user.history`); drop domain allow/block from P3 wording
- Parent alignment design P3 section updated to match
