---
name: opencode-browser
description: Drive the user's real logged-in Chrome via the opencode-browser plugin (browser_* tools). Use when the task involves opening web pages, clicking, filling forms, scraping, screenshots, downloading, or taking over a tab the user is watching. Covers session SOP, selector cheat-sheet, CUA vs selector choice, tab-group discipline, and stale-broker recovery. Keywords: browser, 浏览器, open page, 打开网页, click, 点击, fill form, 填表, screenshot, 截图, scrape, 抓取, download, 下载, tab, 标签页, 接管, claim tab, chrome, login, 登录
---

# OpenCode Browser

You are driving the user's **real, logged-in Chrome** through the `browser_*` tools.
The human handles login; you handle operation. Never ask the user for credentials —
if a page needs login, ask the user to log in in their browser, then continue.

## Standard session SOP

Follow this order for every browser task:

1. `browser_status` — confirm `hostConnected: true`; note existing `session.groupId`.
2. `browser_name_session` — name the session (creates the Chrome tab group) **before** opening tabs. Verify it returns a `groupId`.
3. Open tabs with `browser_open_tab` (`active: false` by default) or `browser_navigate` — they join the session group automatically.
4. Do the work.
5. `browser_mark_tab` for handoff/deliverable tabs; `browser_finalize` when the task ends (explicit, not automatic).

## Foreground discipline

- Default everything to background tabs (`active: false`). Never steal the user's foreground.
- `browser_set_active_tab` only when the user explicitly asks to look at a tab.
- `browser_claim_tab` takes over a tab the user already has open — it stays where it is (not moved into the agent group). Use `force: true` only to steal another agent's tab.
- The temporary `about:blank` group-seed tab is cleaned up automatically once a real tab joins the group.

## Selector cheat-sheet

Prefer selectors over coordinates. In `selector` args you can use:

- `uid:e12` — from the latest `browser_snapshot` (most stable)
- `role:button`, `role:button[name=Submit]`, `role:textbox[name="Email"]`
- `label:City`, `aria:...`, `placeholder:Search`, `name:email`, `text:Submit`, `id:foo`
- `css:...` to force CSS

**Strict multi-match:** action tools without `index` require a unique match. On a
multi-match error, either pass `index` (0-based) or take a `browser_snapshot` and use
the `uid:` of the exact node. Selector tools wait up to 2000ms by default (`timeoutMs: 0` disables).

## CUA vs selector

- **Selector tools first** (`browser_click`, `browser_fill`, ...): robust to layout shifts.
- **Coordinate CUA** (`browser_mouse_click`, `browser_drag`, `browser_get_visible_dom`, `browser_element_info`) only when selectors can't reach the target (canvas, custom widgets). Coordinates are viewport CSS pixels; CUA uses trusted CDP input with a synthetic-event fallback.
- `browser_screenshot` supports `fullPage` and `clip`; `browser_snapshot` gives the uid-stamped a11y tree.

## Recovery

- `Unknown op: ...` → the running broker is stale (claims/groups live in broker memory). Restart it:
  ```bash
  pkill -f ~/.opencode-browser/broker.cjs
  rm -f ~/.opencode-browser/broker.sock
  node ~/.opencode-browser/broker.cjs &
  ```
  Then re-run `browser_name_session` (group state was in memory).
- `hostConnected: false` → the extension lost the native host; wait a few seconds or ask the user to click the extension icon. After any plugin `update`: **reload the extension in chrome://extensions AND restart the broker**.
- Tab-ownership errors → that tabId belongs to another session; omit `tabId` or open a new one.

## Sensitive surfaces

- `browser_history` reads the user's browsing history — only when the task genuinely needs it, with tight `queries`/`from`/`to` bounds.
- `browser_evaluate` is read-only; do not use it to mutate page state (use fill/click/select tools).
- Clipboard tools work without page focus (offscreen), but avoid overwriting the user's clipboard unless the task requires it.

Full tool list: `README.md` in the opencode-browser repo.
