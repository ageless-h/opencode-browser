# PRD — OpenCode Browser Dual Backend (Native + Agent)

## Summary
OpenCode Browser should feel like a single browser automation capability that can run against two backends: the **native OpenCode Browser extension** (real Chrome profile) and **agent-browser** (headless Playwright). The default experience must work with agent-browser out of the box, while preserving the native-extension path for authenticated, profile-driven workflows. Users should think: “I pick which browser to run on, and the task runs there.”

## Problem
- The plugin has two backends with different setup paths and capabilities, but users lack a clear, unified mental model for choosing between them.
- Agent-browser currently requires explicit env configuration, so it is not the default path even when installed.
- The system lacks a consistent way to signal which backend is active, how to switch, and what capabilities are available.

## Goals
1. Make agent-browser the default backend when available, without requiring env flags.
2. Preserve the native extension backend for workflows that depend on a real browser profile.
3. Provide a clean mental model: **“Pick the browser target, run tasks there.”**
4. Offer clear UX affordances (CLI + UI + prompt-level) to pick or override the browser.
5. Gracefully degrade with explicit guidance when a backend isn’t available.

## Non-Goals
- Implementing new browser automation tools or APIs.
- Replacing the Chrome extension architecture.
- Perfect parity between backends (some feature gaps are acceptable).

## Personas
- **Power user (desktop)**: Wants tasks to run in their real Chrome profile (logged in, bookmarks, extensions).
- **Headless automation user**: Wants fast, repeatable headless runs in a clean profile.
- **Remote operator**: Runs automation on a separate host (server or tailnet) and needs stable headless sessions.

## Mental Model
- There is one **Browser toolset** with two **browser targets**:
  - **Native Browser**: Chrome extension + native host, uses the user’s live profile.
  - **Agent Browser**: Playwright-driven, headless, isolated profile.
- The user chooses which target to use for a task or session. If they don’t choose, OpenCode picks the best available default.

## Key User Stories
1. As a user, I can choose “Native Browser” when I need my logged-in profile.
2. As a user, I can choose “Agent Browser” for headless, repeatable automation.
3. As a user, I can set a default browser once and have it persist.
4. As a user, I can override the default for a specific task.
5. As a user, I can see which backend is in use and why.
6. As a user, I get a clear error if a backend is unavailable and instructions to fix it.

## Functional Requirements
### Default Selection
- Default backend mode is **auto** with **agent-browser priority**:
  1. If agent-browser is installed and reachable, use agent-browser.
  2. Else, if the native extension broker is reachable, use native.
  3. Else, surface a “no browser available” error with setup instructions.
- Explicit user choice always overrides auto-selection.

### Backend Selection Surface Area
- **Config-level (global):** persisted default (`browser.backend = agent|native|auto`).
- **Session-level:** a per-session override selected in UI or CLI flags.
- **Task-level:** prompt annotation or tool parameter (e.g., `@browser agent`, `@browser native`).

### Capability Signaling
- `browser_status` returns:
  - `backend`: `agent-browser` or `extension`
  - `capabilities`: `profile_access`, `headless`, `tab_claims`, `file_uploads`, `downloads`
  - `active_session`: backend session identifier
- UI should expose the active backend and show a short rationale if auto-selected.

### Graceful Degradation
- If a task requests `native` but extension is unavailable, return a structured error plus setup steps.
- If a task requests `agent` but agent-browser is missing, offer installation instructions and fallback to native if user permits.

### Compatibility Requirements
- Existing env vars (`OPENCODE_BROWSER_BACKEND`, agent-browser overrides) continue to work and override auto mode.
- No changes required to agent-browser CLI usage.

## UX/Flows
### Onboarding / First Use
1. User installs OpenCode Browser plugin.
2. OpenCode checks backend availability.
3. Default picks agent-browser if installed, else native extension.
4. UI or CLI surfaces the choice: “Using Agent Browser (headless). Switch → Native Browser.”

### Switching Backends
- UI: a “Browser Target” selector in Settings.
- CLI: `opencode run --browser=agent|native`.
- Prompt: `@browser agent` / `@browser native`.

### Error UX
- Structured error with:
  - Missing backend
  - How to install or enable
  - Offer fallback (if allowed)

## Technical Considerations (Design Only)
- Introduce a **backend router** that encapsulates selection logic and capability reporting.
- Maintain feature matrix for parity gaps (e.g., tab claims not supported on agent-browser).
- Auto-detection uses lightweight health checks on both backends.

## Capability Matrix (Target Behavior)
| Feature | Native Browser | Agent Browser | Notes |
| --- | --- | --- | --- |
| Real profile (cookies/logins) | ✅ | ❌ | Agent is isolated |
| Headless | ❌ | ✅ | Agent only |
| Tab ownership/claims | ✅ | ❌ | Current constraint |
| File uploads (large) | ⚠️ | ✅ | Agent preferred |
| Remote host | ⚠️ | ✅ | Agent gateway |
| Stability / replays | ✅ | ✅ | Both expected |

## Analytics / Telemetry
- Track backend usage (agent vs native) and selection reason (auto vs manual).
- Track backend errors and fallback frequency.

## Risks & Mitigations
- **User confusion about “two browsers”** → Always show active backend in status/UX.
- **Backend mismatch with task expectations** → Provide explicit “requires profile” hints in docs.
- **Agent-browser missing dependency** → Clear install instructions + native fallback.

## Rollout Plan
1. Ship auto-backend selection with agent-first priority.
2. Add UI/CLI controls for backend override.
3. Add capability matrix + status reporting in `browser_status`.
4. Collect telemetry + adjust defaults if reliability issues appear.

## Open Questions
- Should agent-browser be bundled or remain optional dependency?
- What is the best UX surface in OpenWork for backend selection?
- Do we allow per-tool overrides or only per-session?
- How should “tab claims” limitations be surfaced to users?
- What is the policy for auto-fallback (silent vs explicit)?
