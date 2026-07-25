# P1 Implementation Plan: Snapshot / Locator Semantics

**Goal:** Make `browser_snapshot` the locator ground truth (stable `uid` + role/name), and make actions resolve locators without silent first-match.

**Architecture:** Snapshot stamps `data-opc-uid` on included elements in the live DOM. Action tools resolve `uid:eN`, enhanced `role:…`, and existing prefixes via the same `pageOps` locator path. Multi-match without explicit `index` returns count + candidates.

---

### Task 1: Snapshot stamps + richer nodes
- [x] Stamp `data-opc-uid` on each included node
- [x] Add disabled/visible/value/checked where relevant; keep existing fields

### Task 2: Locator resolution
- [x] `uid:e12` → `[data-opc-uid="e12"]`
- [x] `role:button` with implicit ARIA roles
- [x] Optional name filter: `role:button[name=Submit]` / `role:button[name="Submit"]`
- [x] Keep existing label/aria/text/css/name/id prefixes

### Task 3: Strict multi-match
- [x] click/type/select/key(with selector)/highlight/set_file_input: if count>1 and index omitted → error JSON with candidates
- [x] Explicit `index` still selects nth (0-based)

### Task 4: Docs + verify
- [x] README selector helpers
- [x] `node --check` + `bun run build` + copy to `~/.opencode-browser/extension`
- [x] Live smoke after Reload:
  - snapshot stamps `uid`/`visible`/`role`/`name` (+ form value)
  - `role:button` multi-match → candidates (count=4)
  - `role:button[name=Solo]` / `uid:e2` / `role:textbox[name=Email]` / `button`+`index:1` OK
