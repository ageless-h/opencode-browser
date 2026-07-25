# AGENTS.md - OpenCode Browser

Guidelines for AI agents working on this codebase.

## Project Overview

OpenCode Browser provides browser automation tools to OpenCode via an OpenCode **plugin**, backed by a Chrome/Chromium **extension**.

Architecture:

```
OpenCode Plugin <-> Local Broker (unix socket) <-> Native Host <-> Chrome Extension
```

Components:

1. **Plugin** (`src/plugin.ts`) - OpenCode plugin that talks to the broker
2. **Broker** (`bin/broker.cjs`) - local multiplexer + per-tab ownership
3. **Native Host** (`bin/native-host.cjs`) - Chrome Native Messaging bridge to the broker
4. **Extension** (`extension/`) - executes browser commands via Chrome APIs

## Build & Run Commands

```bash
# Install dependencies
bun install

# CLI install/uninstall/status
node bin/cli.js install
node bin/cli.js status
node bin/cli.js uninstall

# Validate scripts
node --check bin/broker.cjs
node --check bin/native-host.cjs
```

## Testing Changes

To test end-to-end you need:

1. The extension loaded in `chrome://extensions`
2. Native host manifest installed (via `npx @different-ai/opencode-browser install`)
3. OpenCode configured with the plugin

Then run in a fresh OpenCode process:

```bash
opencode run "use browser_status"
opencode run "use browser_get_tabs"
```

## Code Style Guidelines

### TypeScript (src/)

- 2-space indentation
- Double quotes
- Semicolons required

### JavaScript (extension/)

- 2-space indentation
- Double quotes
- No semicolons

## Important Notes

- Native messaging requires the extension ID in the manifest (`allowed_origins`).
- Broker enforces **per-tab ownership**; first touch auto-claims.

## Browser Session SOP (learned from production incident)

Claims, session names, and `groupId` live in the **broker process memory** — not on disk.
A stale broker process can serve an older op set than the code on disk (symptom:
`Unknown op: name_session` / `Unknown op: mark_tab` even though the installed broker
source supports them).

Standard order of operations for browser work:

1. `browser_status` first — check `hostConnected` and existing `session.groupId`.
2. Call `browser_name_session` **before** opening tabs; verify it returns `groupId`.
3. If you get `Unknown op: ...`, the running broker is stale:
   - restart it: `pkill -f ~/.opencode-browser/broker.cjs; rm -f ~/.opencode-browser/broker.sock; node ~/.opencode-browser/broker.cjs &`
   - the extension/native host will reconnect automatically (brief "native host offline" is expected); claims and `groupId` from before the restart are lost — re-run `browser_name_session`.
4. Only then fan out `browser_open_tab` (`active: false`) — tabs will join the session group.
5. Use `browser_mark_tab` for handoff/deliverable tabs and `browser_finalize` at the end as needed.

After any `node bin/cli.js update` or extension/manifest change: reload the extension in
`chrome://extensions` **and** restart the broker — file updates alone do not hot-reload
the running process.
