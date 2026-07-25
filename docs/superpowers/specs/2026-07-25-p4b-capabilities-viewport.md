# Design: P4b capabilities_list + viewport

**Date:** 2026-07-25  
**Status:** Done (live smoke passed 2026-07-25: capabilities_list, viewport set/reset via CDP, clipboard via offscreen)  
**Base:** P4a + seed-tab drop  

## Mapping

| Codex | Flat tool |
|-------|-----------|
| `browser.capabilities.list` | `browser_capabilities_list` |
| `viewport.set({width,height})` | `browser_viewport_set` |
| `viewport.reset()` | `browser_viewport_reset` |

## Implementation

- Static registry of browser/tab cap IDs from Codex surface; `supported` flag honest.
- Viewport via CDP `Emulation.setDeviceMetricsOverride` / `clearDeviceMetricsOverride` (debugger).
- Clipboard hardened via MV3 `offscreen` + `clipboardRead`/`clipboardWrite` (manifest 4.6.3).

## Out of scope

- pageAssets, browserAuth, botDetection, raw cdp capability surface
- Full locator graph / CUA
