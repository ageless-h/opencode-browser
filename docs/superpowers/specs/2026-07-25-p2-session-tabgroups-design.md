# P2 Design: Session Tab Groups + Non-Stealing Active Tab (Codex-aligned)

**Date:** 2026-07-25  
**Status:** Approved (user: align with Codex)  
**Base:** 4.6.1 extension + broker

## Goals

Match Codex Chrome session semantics on the OpenCode flat `browser_*` tool surface:

1. **Named session → Chrome Tab Group** (`nameSession`)
2. **Agent-created tabs join the group**; **claimed user tabs do not** (`claimTab`)
3. **Default non-stealing active tab** (`open` with `active: false`)
4. **Marks + explicit finalize** (`markDeliverable` / `markHandoff` / `tabs.finalize`)

## Non-goals

- Auto-finalize on turn end or plugin disconnect
- Full `user.openTabs` separate API (use `browser_get_tabs`)
- Computer Use / REPL host APIs

## Architecture

```
Plugin browser_* tools
  → Broker (session name, groupId, claim origin/mark, finalize policy)
  → Extension (tabGroups + tabs APIs)
```

- **Broker** owns session semantics and claim metadata.
- **Extension** owns Chrome `tabGroups` / `tabs` execution.
- `sessionId` stays broker-side; extension receives concrete `groupId` / `tabIds`.

## Claim metadata

```
claims[tabId] = {
  sessionId,
  claimedAt,
  lastSeenAt,
  origin: "agent" | "user",
  mark: null | "handoff" | "deliverable"
}
sessionState[sessionId] = {
  defaultTabId,
  lastSeenAt,
  name: string | null,
  groupId: number | null
}
```

## Tools

| Tool | Behavior |
|------|----------|
| `browser_name_session` | Set display name; create/update Chrome tab group; store `groupId` |
| `browser_open_tab` | Default `active: false`; origin=`agent`; add to session group (lazy-create group if needed) |
| `browser_claim_tab` | origin=`user`; **do not** move into agent group |
| `browser_mark_tab` | `status: handoff \| deliverable` on a claimed tab |
| `browser_finalize` | Explicit cleanup (see rules); does not disconnect session |
| `browser_set_active_tab` | Only explicit way to steal foreground |
| `browser_list_claims` / `browser_status` | Include origin, mark, name, groupId when present |
| `browser_get_tabs` | Optional `groupId` / `groupTitle` fields |

## Finalize rules (Codex)

For each claim in the session:

| Origin | Not kept / unmarked | keep or mark handoff/deliverable |
|--------|---------------------|----------------------------------|
| agent | **Close** tab + drop claim | Release claim; leave tab open (group may remain) |
| user | **Release** claim only | Release claim; leave tab open |

`keep: [{ tabId, status }]` overrides prior marks for that finalize call.

## Active tab policy

- Default: never activate tabs unless `active: true` on open or `browser_set_active_tab`.
- navigate/click/type/etc. never call `tabs.update({ active: true })`.

## Permissions

- Add `tabGroups` to extension manifest.

## Acceptance

1. `name_session` → two `open_tab` → same Chrome group; user foreground tab unchanged  
2. `claim_tab` → not moved into agent group  
3. mark handoff + finalize → intermediate agent tabs closed; handoff + user claims left open  
4. Explicit `active: true` still focuses tab  

## Agent-backend

- `name_session` / `mark_tab` / `finalize`: soft no-op or clear Unsupported message; primary path is extension.
