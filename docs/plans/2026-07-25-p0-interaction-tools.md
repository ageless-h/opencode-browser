# P0 Implementation Plan: Interaction Tools

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Codex-aligned navigation/keyboard/dialog tools on the 4.6.1 extension+broker path.

**Architecture:** Plugin exposes new `browser_*` tools → broker forwards `tool` ops → extension `executeTool` table → Tabs API or page script / CDP dialog handling.

**Tech Stack:** TypeScript plugin (`src/plugin.ts`), extension service worker (`extension/background.js`), optional agent-backend parity (`src/agent-backend.ts`).

---

### Task 1: Extension tool implementations

**Files:**
- Modify: `extension/background.js`

- [x] Register tools in `executeTool` map: `back`, `forward`, `reload`, `set_active_tab`, `key`, `handle_dialog`
- [x] Implement `toolBack` / `toolForward` / `toolReload` / `toolSetActiveTab` via Chrome Tabs API
- [x] Implement `toolKey` via `runInPage("key", …)` + `pageOps` keyboard dispatch
- [x] Extend debugger attach with `Page.enable`; track `Page.javascriptDialogOpening`; implement `toolHandleDialog`

### Task 2: Plugin tool wrappers

**Files:**
- Modify: `src/plugin.ts`

- [x] Add `browser_back`, `browser_forward`, `browser_reload`, `browser_set_active_tab`, `browser_key`, `browser_handle_dialog`

### Task 3: Agent-backend parity (best-effort)

**Files:**
- Modify: `src/agent-backend.ts`

- [x] Map tools where agent-browser has equivalents; otherwise throw clear Unsupported errors

### Task 4: Docs + verify

**Files:**
- Modify: `README.md`

- [x] List new tools; check P0 roadmap items
- [x] `node --check extension/background.js`
- [x] `bun run build`
- [x] `node bin/cli.js tools` includes new names
