# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [4.6.3] - 2026-07-25

### Added
- **P5 Codex remaining gaps**: `browser_locator_all`, `browser_press`, `browser_download_media`, `browser_mouse_move`, `browser_mouse_click`, `browser_mouse_dblclick`, `browser_drag`, `browser_get_visible_dom`, `browser_element_screenshot`
- **P4b Codex capabilities**: `browser_capabilities_list`, `browser_viewport_set`, `browser_viewport_reset` (CDP `Emulation.setDeviceMetricsOverride`)
- **P4a Codex gaps**: `browser_clipboard_read_text` / `browser_clipboard_write_text` (offscreen document preferred), `browser_screenshot` `fullPage`/`clip`, `browser_all_text_contents`, `browser_element_info`
- **Codex Playwright subset**: `browser_count`, `browser_is_visible`, `browser_is_enabled`, `browser_get_attribute`, `browser_text_content`, `browser_inner_text`, `browser_dblclick`, `browser_check`, `browser_uncheck`, `browser_set_checked`, `browser_fill`, `browser_wait_for`, `browser_wait_for_load_state`, `browser_wait_for_url`, `browser_evaluate`, `browser_export`, `browser_title`, `browser_url`, `browser_get_js_dialog`
- **P3**: `browser_history` (Codex `browser.user.history`; no domain allow/block hard gate)
- **P2**: Session Chrome tab groups + default non-stealing `active: false` open_tab; `browser_name_session`, `browser_mark_tab`, `browser_finalize`; claim user tab without moving into group
- **P1**: Snapshot `data-opc-uid` stamps + `uid:`/`role:` locator support + strict multi-match error with candidates
- **P0**: `browser_back`, `browser_forward`, `browser_reload`, `browser_set_active_tab`, `browser_key`, `browser_handle_dialog`

### Changed
- Seed `about:blank` tab created for Chrome tab group bootstrap is **auto-dropped** once a real agent tab joins the group
- `browser_open_tab` defaults to `active: false` (Codex-aligned non-stealing policy)
- `browser_evaluate` now uses CDP `Runtime.evaluate` to avoid MV3 CSP `unsafe-eval` restrictions
- `get_attribute` reads live property for `value`/`checked` instead of static HTML attribute

### Fixed
- Clipboard operations no longer require the target tab to be focused (MV3 offscreen document)
- Extension icon and manifest metadata aligned with Chrome Web Store requirements

### Not mirrored (intentional)
- Full locator object graph / `frameLocator` chain (architecture-level)
- `Tabs.content` batch (Codex: unsupported on extension backend)
- `pageAssets`, `browserAuth`, `botDetection` capabilities
- `agent.browsers` Node REPL
- hover/focus/cookies/storage/network (not present in Codex API)

## [4.6.1] - Previous baseline
- 4.6.1 extension + broker + native host + plugin baseline
