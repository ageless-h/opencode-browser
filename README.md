# OpenCode Browser

Browser automation plugin for [OpenCode](https://opencode.ai).

Control your real Chromium browser (Chrome/Brave/Arc/Edge) using your existing profile (logins, cookies, bookmarks). No DevTools Protocol, no security prompts.


https://github.com/user-attachments/assets/1496b3b3-419b-436c-b412-8cda2fed83d6


## Why this architecture

This version is optimized for reliability and predictable multi-session behavior:
- **No MCP** -> just opencode plugin
- **No WebSocket port** → no port conflicts
- **Chrome Native Messaging** between extension and a local host process
- A local **broker** multiplexes multiple OpenCode plugin sessions and enforces **per-tab ownership**

## Installation

> Help me improve this! 

```bash
bunx @different-ai/opencode-browser@latest install
```

Supports macOS, Linux, and Windows (Chrome/Edge/Brave/Chromium).


https://github.com/user-attachments/assets/d5767362-fbf3-4023-858b-90f06d9f0b25




The installer will:

1. Copy the extension to `~/.opencode-browser/extension/`
2. Walk you through loading + pinning it in `chrome://extensions`
3. Resolve a fixed extension ID (no copy/paste) and install a **Native Messaging Host manifest**
4. Update your `opencode.json` or `opencode.jsonc` to load the plugin

To override the extension ID, pass `--extension-id <id>` or set `OPENCODE_BROWSER_EXTENSION_ID`.

### Configure OpenCode

> Note: if you run the installer you'll be prompted to include this automatically. If you said "yes", you can skip this part.

Your `opencode.json` or `opencode.jsonc` should contain:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@different-ai/opencode-browser"]
}
```

### Update

```bash
bunx @different-ai/opencode-browser@latest update
```

## CLI tool runner (for local debugging)

Run plugin tools directly from the package CLI (without starting an OpenCode session):

```bash
# list available browser_* tools
npx @different-ai/opencode-browser tools

# run a single tool
npx @different-ai/opencode-browser tool browser_status
npx @different-ai/opencode-browser tool browser_query --args '{"mode":"page_text"}'

# run built-in end-to-end smoke test (click + text selector + container scroll)
npx @different-ai/opencode-browser self-test
```

This is useful for debugging issue reports (for example inbox/chat UIs) before involving a full OpenCode workflow.
After `update`, reload the unpacked extension in `chrome://extensions` before running `self-test`.

## Chrome Web Store maintainer flow

Build a store-ready extension package:

```bash
bun run build:cws
```

Outputs:

- `artifacts/chrome-web-store/opencode-browser-cws-v<version>.zip`
- `artifacts/chrome-web-store/manifest.chrome-web-store.json`

Submission checklist and guidance:

- `CHROME_WEB_STORE.md`
- `CHROME_WEB_STORE_REQUEST_TEMPLATE.md`
- `PRIVACY.md`

## How it works

```
OpenCode Plugin <-> Local Broker (unix socket) <-> Native Host <-> Chrome Extension
```

- The extension connects to the native host.
- The plugin talks to the broker over a local unix socket.
- The broker forwards tool requests to the extension and enforces tab ownership.

## Agent Browser mode (alpha)

This branch adds an alternate backend powered by `agent-browser` (Playwright). It runs headless and does **not** reuse your existing Chrome profile.

### Enable locally

1. Install `agent-browser` and Chromium:

```bash
npm install -g agent-browser
agent-browser install
```

2. Set the backend mode:

```bash
export OPENCODE_BROWSER_BACKEND=agent
```

Optional overrides:
- `OPENCODE_BROWSER_AGENT_SESSION` (custom session name)
- `OPENCODE_BROWSER_AGENT_SOCKET` (unix socket path)
- `OPENCODE_BROWSER_AGENT_AUTOSTART=0` (disable auto-start)
- `OPENCODE_BROWSER_AGENT_DAEMON` (explicit daemon path)

### Tailnet/remote host

On the host (e.g., `home-server.taild435d7.ts.net`), run the TCP gateway:

```bash
OPENCODE_BROWSER_AGENT_GATEWAY_PORT=9833 node bin/agent-gateway.cjs
```

On the client:

```bash
export OPENCODE_BROWSER_BACKEND=agent
export OPENCODE_BROWSER_AGENT_HOST=home-server.taild435d7.ts.net
export OPENCODE_BROWSER_AGENT_PORT=9833
```

## Per-tab ownership

- Each session owns its own tabs; tabs are never shared between sessions.
- If a session has no tab yet, the broker auto-creates a **background** tab on first tool use (`active: false`).
- `browser_open_tab` creates and claims an **agent** tab (default `active: false` — does not steal the user's foreground tab). Pass `active: true` only when you intentionally focus it.
- `browser_claim_tab` claims an existing **user** tab and does **not** move it into the agent Chrome tab group.
- Call `browser_name_session` early to name the session and create/update its Chrome tab group; subsequent agent tabs join that group.
- `browser_mark_tab` + `browser_finalize` mirror Codex handoff/deliverable cleanup (explicit only; not automatic on disconnect).
- Claims expire after inactivity (`OPENCODE_BROWSER_CLAIM_TTL_MS`, default 5 minutes).
- Use `browser_status` or `browser_list_claims` for debugging (includes `origin` / `mark` / session `groupId`).

## Available tools

Core primitives:
- `browser_status`
- `browser_get_tabs` (includes `groupId` / `groupTitle` when present)
- `browser_list_claims`
- `browser_claim_tab`
- `browser_release_tab`
- `browser_name_session`
- `browser_mark_tab`
- `browser_finalize`
- `browser_open_tab` (default `active: false`; joins session tab group)
- `browser_close_tab`
- `browser_set_active_tab` (only explicit way to steal foreground)
- `browser_navigate`
- `browser_back` / `browser_forward` / `browser_reload` (optional `bypassCache`)
- `browser_query` (modes: `text`, `value`, `list`, `exists`, `page_text`; optional `timeoutMs`/`pollMs`)
- `browser_click` (optional `timeoutMs`/`pollMs`)
- `browser_type` (optional `timeoutMs`/`pollMs`)
- `browser_select` (optional `timeoutMs`/`pollMs`)
- `browser_fill` / `browser_dblclick` / `browser_check` / `browser_uncheck` / `browser_set_checked`
- `browser_count` / `browser_is_visible` / `browser_is_enabled` / `browser_get_attribute` / `browser_text_content` / `browser_inner_text`
- `browser_all_text_contents` (all matches; Codex `locator.allTextContents`)
- `browser_wait_for` / `browser_wait_for_load_state` / `browser_wait_for_url`
- `browser_evaluate` (read-only)
- `browser_element_info` (`x`,`y` → Codex `playwright.elementInfo`)
- `browser_export` (`html` | `text` | `domSnapshot`)
- `browser_title` / `browser_url`
- `browser_get_js_dialog`
- `browser_clipboard_read_text` / `browser_clipboard_write_text` (Codex `tab.clipboard`; offscreen preferred)
- `browser_screenshot` (optional `fullPage`, `clip:{x,y,width,height}`)
- `browser_capabilities_list` (Codex capabilities discovery)
- `browser_viewport_set` / `browser_viewport_reset` (Codex viewport capability; CDP)
- `browser_locator_all` (Codex `locator.all`)
- `browser_press` (Codex `locator.press`)
- `browser_download_media` (Codex `locator.downloadMedia` / `dom_cua.downloadMedia`)
- `browser_mouse_move` / `browser_mouse_click` / `browser_mouse_dblclick` / `browser_drag` (Codex CUA subset)
- `browser_get_visible_dom` (Codex `dom_cua.get_visible_dom`)
- `browser_element_screenshot` (Codex `playwright.elementScreenshot` metadata)
- `browser_key` (keyboard press; optional selector/modifiers)
- `browser_handle_dialog` (accept/dismiss JS dialogs; requires debugger)
- `browser_scroll` (optional `timeoutMs`/`pollMs`)
- `browser_wait`

Downloads:
- `browser_download`
- `browser_list_downloads`

User context (Codex `browser.user.history`):
- `browser_history` — high-sensitivity; use only when needed (`queries` / `from` / `to` / `limit`)

Uploads:
- `browser_set_file_input` (extension backend supports small files; use agent backend for larger uploads)

Selector helpers (usable in `selector`):
- `uid:e12` — stable id from the latest `browser_snapshot` (`data-opc-uid`)
- `role:button`, `role:button[name=Submit]`, `role:textbox[name="Email"]` (implicit ARIA roles + optional name)
- `label:Mailing Address: City`
- `aria:Principal Address: City`
- `placeholder:Search`, `name:email`, `text:Submit`, `id:foo`
- `css:label:has(input)` to force CSS

Strict multi-match (actions: click/type/select/key+selector/highlight/set_file_input):
- Omit `index` → require a unique match; if multiple, error includes `count` + `candidates` (index/uid/role/name/tag)
- Pass `index` (0-based) to pick the nth match, or prefer `uid:eN` from snapshot

Selector-based tools wait up to 2000ms by default; set `timeoutMs: 0` to disable.

Diagnostics:
- `browser_snapshot` (stamps `data-opc-uid`, returns `uid`/`role`/`name`/form state per node)
- `browser_screenshot`
- `browser_console` / `browser_errors` (debugger)
- `browser_version`

## Roadmap

- [x] Add tab management tools (`browser_set_active_tab`)
- [x] Add navigation helpers (`browser_back`, `browser_forward`, `browser_reload`)
- [x] Add keyboard input tool (`browser_key`)
- [x] Add JS dialog handling (`browser_handle_dialog`)
- [x] Add download support (`browser_download`, `browser_list_downloads`)
- [x] Add upload support (`browser_set_file_input`)
- [x] P1: Snapshot/locator semantics (uid/role/name, multi-match count)
- [x] P2: Session tab groups + default non-stealing active tab policy
- [x] P3: `browser_history` (Codex `browser.user.history`; no domain allow/block hard gate)
- [x] Codex Playwright subset (flat): count/is_visible/fill/check/waitFor*/evaluate/export/title/url/getJsDialog
- [x] P4a: clipboard readText/writeText, screenshot fullPage/clip, all_text_contents, element_info
- [x] P4b: capabilities_list + viewport set/reset (CDP); seed about:blank auto-drop
- [x] P5: locator_all, press, download_media, CUA subset (mouse_move/click/dblclick/drag), get_visible_dom, element_screenshot metadata
- [ ] Not mirrored (Codex extension unsupported / architecture-level): full locator object graph / frameLocator chain, Tabs.content batch, pageAssets, browserAuth, agent.browsers REPL

## Troubleshooting

**Extension says native host not available**
- Re-run `npx @different-ai/opencode-browser install`
- If you loaded a custom extension ID, rerun with `--extension-id <id>`

**Tab ownership errors**
- Errors usually mean you passed a `tabId` owned by another session
- Use `browser_open_tab` to create a tab for your session (or omit `tabId` to use your default)
- Use `browser_status` or `browser_list_claims` for debugging

## Uninstall

```bash
npx @different-ai/opencode-browser uninstall
```

Then remove the unpacked extension in `chrome://extensions` and remove the plugin from `opencode.json` or `opencode.jsonc`.

## Privacy

- Privacy policy: `PRIVACY.md`
