# Design: Codex Playwright Subset (flat `browser_*`)

**Date:** 2026-07-25  
**Status:** Done (live smoke passed 2026-07-25; pure Codex mirror, no local innovation)  
**Base:** 4.6.1 extension + broker

## Goal

Expose Codex `Tab.playwright` + closely related `Tab`/`Content` methods as flat tools, reusing existing selector/locator language (`uid:` / `role:` / CSS…).

**Not in scope:** full locator object graph, frameLocator chain, CUA, `agent.browsers` REPL.

## Mapping

| Codex | Tool |
|-------|------|
| `playwright.domSnapshot` | existing `browser_snapshot` |
| `locator.count` | `browser_count` |
| `locator.isVisible` | `browser_is_visible` |
| `locator.isEnabled` | `browser_is_enabled` |
| `locator.getAttribute` | `browser_get_attribute` |
| `locator.textContent` | `browser_text_content` |
| `locator.innerText` | `browser_inner_text` |
| `locator.dblclick` | `browser_dblclick` |
| `locator.check` / `uncheck` / `setChecked` | `browser_check` / `browser_uncheck` / `browser_set_checked` |
| `locator.fill` | `browser_fill` (clear + type) |
| `playwright.evaluate` (read-only) | `browser_evaluate` |
| `waitForLoadState` | `browser_wait_for_load_state` |
| `waitForURL` | `browser_wait_for_url` |
| `locator.waitFor` | `browser_wait_for` |
| `Tab.content.export` | `browser_export` (`html` \| `text` \| `domSnapshot`) |
| `Tab.getJsDialog` | `browser_get_js_dialog` |
| `Tab.title` / `Tab.url` | `browser_title` / `browser_url` |

Strict multi-match: same as click/type (omit index → unique required).

## Acceptance

- build + syntax check
- live smoke: count, is_visible, fill/check path on fixture, wait_for_url after navigate, export text, get_js_dialog null when none
