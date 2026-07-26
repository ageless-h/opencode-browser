# OpenCode Browser Privacy Policy

Last updated: 2026-07-25

OpenCode Browser is a browser automation stack for OpenCode: an OpenCode plugin,
a local broker, a Chrome Native Messaging host, and a Chrome/Chromium extension.
It executes browser actions requested through OpenCode on your local machine.

## 1. What the extension and plugin can access

Capabilities depend on the browser permissions granted and the build you installed.
"Required" / "Optional" below compares the unpacked (developer) build with the
Chrome Web Store (CWS) build, where several permissions become optional and
`<all_urls>` host access moves to `optional_host_permissions`.

| Permission / Capability | Tools using it | Data category | Unpacked build | CWS build |
| --- | --- | --- | --- | --- |
| `debugger` (CDP) | `browser_screenshot` (fullPage/clip/background tabs), `browser_console`, `browser_errors`, `browser_handle_dialog`, CDP mouse/keyboard input (`browser_mouse_*`, `browser_key`, `browser_drag`) | Screenshots, console messages, JS errors, trusted input events | Required | Optional |
| `history` | `browser_history` | Browsing history (URLs, titles, visit times) | Required | Required |
| `clipboardRead` | `browser_clipboard_read_text` | Clipboard text contents | Required | Required |
| `clipboardWrite` | `browser_clipboard_write_text` | Writes text to clipboard | Required | Required |
| `downloads` | `browser_download`, `browser_list_downloads`, `browser_download_media` | Download metadata and initiated downloads | Required | Optional |
| `nativeMessaging` | All tools (bridge between extension and local broker/plugin) | Tool commands and results | Required | Optional |
| `<all_urls>` host access + `scripting` | `browser_snapshot`, `browser_query`, `browser_export`, `browser_evaluate`, `browser_get_visible_dom`, form tools (`browser_click`, `browser_type`, `browser_fill`, `browser_select`, …) | Page content: DOM text, attributes, form values, links | Required | Optional (host access) |
| `tabs` / `activeTab` / `tabGroups` | `browser_get_tabs`, `browser_open_tab`, `browser_close_tab`, `browser_navigate`, `browser_url`, `browser_title`, session grouping tools | Tab URLs, titles, and tab metadata | Required | Required |
| `offscreen` | Clipboard offscreen document | Clipboard read/write without page focus | Required | Required |
| `storage` / `alarms` / `notifications` | Internal plumbing only (state, keep-alive, status notices) | Extension-internal state | Required | `notifications` dropped; rest required |
| Local file read (plugin-side, no browser permission) | `browser_set_file_input` | Contents of local files uploaded into web pages | N/A | N/A |
| Arbitrary page JavaScript | `browser_evaluate` | Anything page JS can reach: DOM, cookies, localStorage, network requests | Required (via `scripting`) | Optional (host access) |

### Local file reading (`browser_set_file_input`)

The plugin reads local files to satisfy file-upload requests. Fails closed:

- Default boundary: only files under the current workspace (`process.cwd()`) and
  the OS temp directory are readable. Paths are resolved with `realpathSync` and
  the boundary is enforced after symlink resolution.
- Extra roots can be added with the `OPENCODE_BROWSER_UPLOAD_DIRS` environment
  variable (absolute directories separated with the operating system PATH
  delimiter: `;` on Windows, `:` on macOS/Linux).
- Always refused, even inside allowed roots: `~/.ssh`, `~/.aws`, `~/.gnupg`,
  `~/.config/opencode`, `~/.opencode-browser`, `~/Library/Keychains`, any
  `.env*` path segment, and files named `id_rsa`, `id_ed25519`, `*.pem`, `*.key`.
- Size limit defaults to 512 KiB (`OPENCODE_BROWSER_MAX_UPLOAD_BYTES`).

## 2. Data flow

- Tool results (screenshots, page text, snapshots, history entries, clipboard
  text, uploaded file contents) are returned to the OpenCode agent.
- From there they are processed by whatever model provider you configured in
  OpenCode. If that provider is remote, this data — including browsing history,
  clipboard contents, file contents, and page data — is sent to that provider
  under your OpenCode configuration. The extension/plugin does not choose or
  contact any model provider itself.
- Local-only components: the broker (`bin/broker.cjs`) and the native messaging
  host (`bin/native-host.cjs`) communicate over a local unix socket / named pipe
  and Chrome Native Messaging. They make no network connections.
- The optional agent-browser gateway (`bin/agent-gateway.cjs`) is a TCP bridge.
  It listens only on `127.0.0.1` by default. A non-loopback bind is refused
  unless a high-entropy `OPENCODE_BROWSER_AGENT_GATEWAY_TOKEN` is configured;
  authentication uses a per-connection nonce and HMAC to prevent token
  disclosure and replay. Remote gateway traffic can contain page data and
  browser commands and should additionally be carried over a trusted encrypted
  network such as a controlled VPN or SSH tunnel.
- The extension contains no third-party analytics SDKs or ad trackers and does
  not send data to the extension authors.

## 3. Sensitive-field redaction

Snapshot, `page_text`, visible-DOM, and export paths redact values of sensitive
form fields by default: inputs of type `password` or `hidden`, fields with
`autocomplete` values such as `current-password` / `new-password` /
`one-time-code`, and fields whose name/id match patterns like `passw`, `pwd`,
`token`, `secret`, `api-key`, `otp`, `csrf`, `session`. HTML export also
redacts matching metadata, sensitive select options, and sensitive keys in
inline JSON state.

Limits: redaction is heuristic and only applies to structured extraction tools.
Explicit `browser_query` value/property reads and `browser_evaluate` are not
redacted; screenshots capture whatever is visually on screen; visible
(non-redacted) page text may still contain secrets displayed by the site.

## 4. User control

- Revoke browser permissions any time in `chrome://extensions` (CWS build:
  optional permissions and site access can be removed individually).
- Uninstall everything with `npx @ageless-h/opencode-browser uninstall`, then
  remove the extension in `chrome://extensions` and the plugin from your
  OpenCode configuration.
- Permission model difference: the unpacked build requests all permissions up
  front; the CWS build marks `debugger`, `downloads`, and `nativeMessaging`
  optional, moves `<all_urls>` host access to optional, and drops
  `notifications`. The first extension-icon click requests only
  `nativeMessaging`; downloads, debugger, and site access remain independently
  grantable in Chrome. Site-specific grants are accepted, so `<all_urls>` is
  not required. Some tools fail with a clear error until their matching
  optional permission or site access is granted.
- Prompt-injection boundary: page content can contain instructions aimed at the
  agent. Prefer dedicated action tools (`browser_click`, `browser_type`,
  `browser_fill`, `browser_select`), which act on specific elements.
  `browser_evaluate` executes arbitrary JavaScript with full side-effect
  capability — treat it as untrusted-territory and use it only when no dedicated
  tool suffices.

## 5. Data retention

- Most data is processed in memory for the active automation session.
- Console/error buffers are in-memory rolling buffers, cleared when tabs close,
  the extension restarts, or they are explicitly cleared by tool calls.
- Native host configuration files are stored locally for installation/runtime
  setup. The plugin writes a local log at `~/.opencode-browser/plugin.log`.

## Contact

Questions or concerns:

- Project: https://github.com/ageless-h/opencode-browser
- Issues: https://github.com/ageless-h/opencode-browser/issues
