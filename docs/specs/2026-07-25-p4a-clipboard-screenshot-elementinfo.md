# Design: P4a Codex gaps — clipboard / screenshot options / allTextContents / elementInfo

**Date:** 2026-07-25  
**Status:** Done (live smoke passed 2026-07-25; clipboard via offscreen + focused-page fallback; seed about:blank auto-drop)  
**Base:** 4.6.1 + P0–P3 + Playwright subset  

## Goal

Pure Codex mirror for the next high-value flat tools (no local invention).

## Mapping

| Codex | Flat tool |
|-------|-----------|
| `tab.clipboard.readText` | `browser_clipboard_read_text` |
| `tab.clipboard.writeText` | `browser_clipboard_write_text` |
| `tab.screenshot({ fullPage?, clip? })` | enhance `browser_screenshot` |
| `locator.allTextContents` | `browser_all_text_contents` |
| `playwright.elementInfo({x,y})` | `browser_element_info` |

## Out of scope

- binary clipboard `read`/`write`
- full CUA, frameLocator, Tabs.content batch
- hover/focus/cookies/storage/network (not in Codex API)

## Acceptance

- build + syntax check
- live smoke: writeText → readText roundtrip; all_text_contents on multi-match; element_info at known coords; screenshot default + fullPage
