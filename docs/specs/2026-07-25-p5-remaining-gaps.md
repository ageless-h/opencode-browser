# Design: Remaining Codex gaps (P5)

**Date:** 2026-07-25  
**Status:** Done (live smoke passed 2026-07-25; pure Codex mirror, flat tools)  
**Base:** 4.6.3 (P0–P3 + Playwright subset + P4a + P4b)  
**Constraint:** Pure Codex mirror, no local invention  

## Scope (from Codex api.json)

### 1. Locator extras (flat tools)
- `browser_locator_all` — `locator.all()` → array of `{index, uid, selector}` descriptors
- `browser_press` — `locator.press(key)` = focus selector + existing key tool
- `browser_download_media` — `locator.downloadMedia` / `dom_cua.downloadMedia`
- `browser_nth` / `browser_first` / `browser_last` — index sugar → resolved via `index` param on existing tools (or `uid:`)
- `browser_filter` — hasText/hasNotText/visible → composed selector
- `browser_get_by_label` / `browser_get_by_text` / `browser_get_by_placeholder` / `browser_get_by_test_id` / `browser_get_by_role` — selector string builders (page already supports `label:`, `text:`, `role:`)
- `browser_element_screenshot` — `playwright.elementScreenshot` (x,y annotate)

### 2. Frame support
- `frame_selector` / `frame_index` option on existing selector tools → scope resolve/action into same-origin iframe
- `browser_frame_locator` — helper returning a frame-scoped selector string

### 3. CUA subset
- `browser_mouse_move` (x,y) — dispatch mousemove
- `browser_mouse_click` (x,y) — elementFromPoint + click
- `browser_drag` (path) — mousedown/mousemove/mouseup along points
- `browser_get_visible_dom` — visible interactable nodes with node ids (map to uid)

### 4. Deferred (not flat-feasible / Codex unsupported on extension)
- Full locator object graph / frameLocator chain / REPL
- `Tabs.content` batch (Codex: unsupported on extension)
- `browserAuth` / `botDetection` / raw full CDP capability
- `pageAssets` (can add later)
- hover/focus/cookies/storage/network — **not in Codex API** (skip)

## Implementation strategy
- Keep one pageOps; add `frame_selector` resolution path (same-origin only).
- New flat tools reuse existing `runInPage`/`resolveMatches` plumbing.
- CUA mouse ops dispatch synthetic MouseEvent at coordinates (documented as approximation; no CDP Input domain for now).

## Acceptance
- build + syntax check
- live smoke: locator_all, press, nth/first/last, filter hasText, get_by_*, frame_selector click inside same-origin iframe, mouse_click, drag, get_visible_dom, download_media on link
