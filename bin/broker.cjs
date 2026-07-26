#!/usr/bin/env node
"use strict";

const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BASE_DIR = path.join(os.homedir(), ".opencode-browser");
const SOCKET_PATH = getBrokerSocketPath();

function getSafePipeName() {
  try {
    const username = os.userInfo().username || "user";
    return `opencode-browser-${username}`.replace(/[^a-zA-Z0-9._-]/g, "_");
  } catch {
    return "opencode-browser";
  }
}

function getBrokerSocketPath() {
  const override = process.env.OPENCODE_BROWSER_BROKER_SOCKET;
  if (override) return override;
  if (process.platform === "win32") return `\\\\.\\pipe\\${getSafePipeName()}`;
  return path.join(BASE_DIR, "broker.sock");
}

fs.mkdirSync(BASE_DIR, { recursive: true });

const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000;
const LEASE_TTL_MS = (() => {
  const raw = process.env.OPENCODE_BROWSER_CLAIM_TTL_MS;
  const value = Number(raw);
  if (Number.isFinite(value) && value >= 0) return value;
  return DEFAULT_LEASE_TTL_MS;
})();
const LEASE_SWEEP_MS =
  LEASE_TTL_MS > 0 ? Math.min(Math.max(10000, Math.floor(LEASE_TTL_MS / 2)), 60000) : 0;

function nowMs() {
  return Date.now();
}

function nowIso() {
  return new Date().toISOString();
}

function createJsonLineParser(onMessage) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.toString("utf8");
    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) return;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        // ignore
      }
    }
  };
}

function writeJsonLine(socket, msg) {
  socket.write(JSON.stringify(msg) + "\n");
}

function wantsTab(toolName) {
  return ![
    "get_tabs",
    "get_active_tab",
    "open_tab",
    "list_downloads",
    "name_session",
    "group_tabs",
    "history",
    "capabilities_list",
  ].includes(toolName);
}

// --- State ---
let host = null; // { socket }
let nextExtId = 0;
const extPending = new Map(); // extId -> { pluginSocket, pluginRequestId, sessionId }

const clients = new Set();
const sessionClients = new Map();

// Tab ownership: tabId -> { sessionId, claimedAt, lastSeenAt, origin, mark }
const claims = new Map();
// Session state: sessionId -> { defaultTabId, lastSeenAt, name, groupId }
const sessionState = new Map();

function listClaims() {
  const out = [];
  for (const [tabId, info] of claims.entries()) {
    out.push({
      tabId,
      sessionId: info.sessionId,
      claimedAt: info.claimedAt,
      lastSeenAt: new Date(info.lastSeenAt).toISOString(),
      origin: info.origin || "agent",
      mark: info.mark || null,
    });
  }
  out.sort((a, b) => a.tabId - b.tabId);
  return out;
}

function sessionHasClaims(sessionId) {
  for (const info of claims.values()) {
    if (info.sessionId === sessionId) return true;
  }
  return false;
}

function listSessionClaims(sessionId) {
  const out = [];
  for (const [tabId, info] of claims.entries()) {
    if (info.sessionId === sessionId) out.push({ tabId, ...info });
  }
  return out;
}

function getSessionState(sessionId) {
  if (!sessionId) return null;
  let state = sessionState.get(sessionId);
  if (!state) {
    state = { defaultTabId: null, lastSeenAt: nowMs(), name: null, groupId: null, seedTabId: null };
    sessionState.set(sessionId, state);
  }
  if (state.name === undefined) state.name = null;
  if (state.groupId === undefined) state.groupId = null;
  if (state.seedTabId === undefined) state.seedTabId = null;
  return state;
}

/** Close about:blank group seed once a real agent tab exists (Chrome needs a tab to create groups). */
async function dropSeedTabIfReplaced(sessionId, keepTabId) {
  const state = getSessionState(sessionId);
  if (!state || !Number.isFinite(state.seedTabId)) return;
  const seedId = state.seedTabId;
  if (seedId === keepTabId) return;
  state.seedTabId = null;
  try {
    await callExtension("close_tab", { tabId: seedId }, sessionId);
  } catch {
    // seed may already be gone
  }
  releaseClaim(seedId);
}

function touchSession(sessionId) {
  const state = getSessionState(sessionId);
  if (!state) return null;
  state.lastSeenAt = nowMs();
  // Keep the group seed's claim alive while the session is active. The seed tab is
  // never used by tool calls, so without renewal its claim expires mid-session, the
  // session state gets swept, and the next tool call creates a fresh orphan group
  // (leaked blank tab groups in Chrome).
  if (Number.isFinite(state.seedTabId)) {
    const seedClaim = claims.get(state.seedTabId);
    if (seedClaim && seedClaim.sessionId === sessionId) seedClaim.lastSeenAt = state.lastSeenAt;
  }
  return state;
}

function setDefaultTab(sessionId, tabId) {
  const state = getSessionState(sessionId);
  if (!state) return;
  state.defaultTabId = tabId;
  state.lastSeenAt = nowMs();
}

function clearDefaultTab(sessionId, tabId) {
  const state = sessionState.get(sessionId);
  if (!state) return;
  if (tabId === undefined || state.defaultTabId === tabId) {
    state.defaultTabId = null;
  }
  state.lastSeenAt = nowMs();
}

function releaseClaim(tabId) {
  const info = claims.get(tabId);
  if (!info) return;
  claims.delete(tabId);
  clearDefaultTab(info.sessionId, tabId);
}

// Extension lifecycle events (#17): self-heal stale tab/group references
// immediately instead of waiting for the claim TTL.
function handleExtensionEvent(message) {
  if (message.event === "tab_removed" && Number.isFinite(message.tabId)) {
    const tabId = message.tabId;
    if (claims.has(tabId)) {
      console.error(`[browser-broker] tab ${tabId} removed; releasing claim`);
      releaseClaim(tabId);
    }
    for (const [sessionId, state] of sessionState.entries()) {
      let touched = false;
      if (state.defaultTabId === tabId) {
        state.defaultTabId = null;
        touched = true;
      }
      if (state.seedTabId === tabId) {
        state.seedTabId = null;
        touched = true;
      }
      if (touched) {
        console.error(`[browser-broker] cleared stale tab reference ${tabId} for session ${sessionId}`);
      }
    }
    return;
  }
  if (message.event === "tab_group_removed" && Number.isFinite(message.groupId)) {
    const groupId = message.groupId;
    for (const [sessionId, state] of sessionState.entries()) {
      if (state.groupId === groupId) {
        state.groupId = null;
        console.error(`[browser-broker] cleared removed group ${groupId} for session ${sessionId}`);
      }
    }
  }
}

function releaseClaimsForSession(sessionId) {
  for (const [tabId, info] of claims.entries()) {
    if (info.sessionId === sessionId) claims.delete(tabId);
  }
  clearDefaultTab(sessionId);
  // Keep sessionState (name/groupId/seedTabId) across disconnects: short-lived
  // clients that connect per call must reconnect into the SAME session group
  // instead of creating a new one every call. Idle sessions are reaped by
  // cleanupStaleClaims(), which also closes the group seed tab — deleting the
  // state here would orphan the seed's blank group in Chrome immediately.
}

function unregisterSessionClient(client) {
  if (client.role !== "plugin" || !client.sessionId) return false;
  const set = sessionClients.get(client.sessionId);
  if (!set) return true;
  set.delete(client);
  if (set.size) return false;
  sessionClients.delete(client.sessionId);
  return true;
}

function registerSessionClient(client, role, sessionId) {
  unregisterSessionClient(client);
  client.role = role || "unknown";
  client.sessionId = sessionId || null;
  if (client.role !== "plugin" || !client.sessionId) return;
  let set = sessionClients.get(client.sessionId);
  if (!set) {
    set = new Set();
    sessionClients.set(client.sessionId, set);
  }
  set.add(client);
}

function checkClaim(tabId, sessionId) {
  const existing = claims.get(tabId);
  if (!existing) return { ok: true };
  if (existing.sessionId === sessionId) return { ok: true };
  return { ok: false, error: `Tab ${tabId} is owned by another OpenCode session (${existing.sessionId})` };
}

function setClaim(tabId, sessionId, options = {}) {
  const existing = claims.get(tabId);
  const origin = options.origin || existing?.origin || "agent";
  const mark = options.mark !== undefined ? options.mark : existing?.mark || null;
  claims.set(tabId, {
    sessionId,
    claimedAt: existing ? existing.claimedAt : nowIso(),
    lastSeenAt: nowMs(),
    origin,
    mark,
  });
}

function touchClaim(tabId, sessionId, options = {}) {
  const existing = claims.get(tabId);
  if (existing && existing.sessionId !== sessionId) return;
  if (existing) {
    existing.lastSeenAt = nowMs();
    if (options.origin) existing.origin = options.origin;
    if (options.mark !== undefined) existing.mark = options.mark;
  } else {
    setClaim(tabId, sessionId, options);
  }
}

function defaultSessionTitle(sessionId) {
  const short = String(sessionId || "session").slice(0, 8);
  return `🔎 OpenCode ${short}`;
}

async function ensureSessionGroup(sessionId) {
  const state = getSessionState(sessionId);
  if (!state) throw new Error("Missing sessionId");
  const title = state.name || defaultSessionTitle(sessionId);
  const res = await callExtension(
    "name_session",
    { title, groupId: Number.isFinite(state.groupId) ? state.groupId : undefined },
    sessionId
  );
  const content = res && res.content != null ? res.content : res;
  const groupId = content && Number.isFinite(content.groupId) ? content.groupId : null;
  if (groupId != null) state.groupId = groupId;
  if (!state.name) state.name = title;
  const seedTabId = content && Number.isFinite(content.seedTabId) ? content.seedTabId : null;
  // Seed tab is temporary about:blank scaffolding so Chrome can create an empty group.
  if (seedTabId != null) {
    state.seedTabId = seedTabId;
    setClaim(seedTabId, sessionId, { origin: "agent", mark: null });
  }
  return { groupId: state.groupId, title: state.name, seedTabId, raw: content };
}

/** Best-effort close of an about:blank group seed so its scaffolding group disappears. */
function closeSeedTabBestEffort(sessionId, seedId) {
  callExtension("close_tab", { tabId: seedId }, sessionId).catch(() => {
    // seed may already be gone, or the host is offline
  });
}

function cleanupStaleClaims() {
  if (!LEASE_TTL_MS) return;
  const now = nowMs();
  for (const [tabId, info] of claims.entries()) {
    if (now - info.lastSeenAt > LEASE_TTL_MS) {
      releaseClaim(tabId);
      // If this was a session's group seed, close the about:blank tab so the
      // now-forgotten scaffolding group does not leak in Chrome.
      const seedState = sessionState.get(info.sessionId);
      if (seedState && seedState.seedTabId === tabId) {
        seedState.seedTabId = null;
        closeSeedTabBestEffort(info.sessionId, tabId);
      }
    }
  }
  for (const [sessionId, state] of sessionState.entries()) {
    if (!sessionHasClaims(sessionId) && now - state.lastSeenAt > LEASE_TTL_MS) {
      sessionState.delete(sessionId);
      // Session forgotten: close any remaining group seed so its group cannot
      // become an unnamed orphan.
      if (Number.isFinite(state.seedTabId)) {
        closeSeedTabBestEffort(sessionId, state.seedTabId);
        state.seedTabId = null;
      }
    }
  }
}

function ensureHost() {
  if (host && host.socket && !host.socket.destroyed) return;
  throw new Error("Chrome extension is not connected (native host offline)");
}

function callExtension(tool, args, sessionId) {
  ensureHost();
  const extId = ++nextExtId;

  return new Promise((resolve, reject) => {
    extPending.set(extId, { resolve, reject, sessionId });
    writeJsonLine(host.socket, {
      type: "to_extension",
      message: { type: "tool_request", id: extId, tool, args },
    });

    const timeout = setTimeout(() => {
      if (!extPending.has(extId)) return;
      extPending.delete(extId);
      reject(new Error("Timed out waiting for extension"));
    }, 60000);

    // attach timeout to resolver
    const pending = extPending.get(extId);
    if (pending) pending.timeout = timeout;
  });
}

async function ensureSessionTab(sessionId) {
  if (!sessionId) throw new Error("Missing sessionId for tab creation");
  const state = getSessionState(sessionId);
  let groupId = state && Number.isFinite(state.groupId) ? state.groupId : null;
  if (groupId == null) {
    const g = await ensureSessionGroup(sessionId);
    groupId = g.groupId;
  }
  const res = await callExtension("open_tab", { active: false, groupId }, sessionId);
  const tabId = res && typeof res.tabId === "number" ? res.tabId : undefined;
  if (!tabId) throw new Error("Failed to create a new tab for this session");
  const content = res && res.content != null ? res.content : {};
  if (Number.isFinite(content.groupId)) state.groupId = content.groupId;
  setClaim(tabId, sessionId, { origin: "agent", mark: null });
  setDefaultTab(sessionId, tabId);
  await dropSeedTabIfReplaced(sessionId, tabId);
  return tabId;
}

async function handleNameSession(sessionId, args = {}) {
  if (!sessionId) throw new Error("sessionId is required");
  const state = getSessionState(sessionId);
  const title =
    typeof args.name === "string" && args.name.trim()
      ? args.name.trim()
      : typeof args.title === "string" && args.title.trim()
        ? args.title.trim()
        : state.name || defaultSessionTitle(sessionId);
  state.name = title;
  const res = await callExtension(
    "name_session",
    {
      title,
      groupId: Number.isFinite(state.groupId) ? state.groupId : undefined,
      color: args.color,
      collapsed: args.collapsed,
    },
    sessionId
  );
  const content = res && res.content != null ? res.content : res;
  if (content && Number.isFinite(content.groupId)) state.groupId = content.groupId;
  if (content && Number.isFinite(content.seedTabId)) {
    state.seedTabId = content.seedTabId;
    setClaim(content.seedTabId, sessionId, { origin: "agent", mark: null });
  }
  // If session already has a real default tab, drop the about:blank seed immediately.
  if (Number.isFinite(state.defaultTabId) && state.defaultTabId !== state.seedTabId) {
    await dropSeedTabIfReplaced(sessionId, state.defaultTabId);
  }
  return {
    content: {
      ok: true,
      sessionId,
      name: state.name,
      groupId: state.groupId,
      color: content?.color || null,
      created: !!content?.created,
      seedTabId: state.seedTabId || null,
    },
  };
}

async function handleMarkTab(sessionId, args = {}) {
  const tabId = args.tabId;
  const status = args.status;
  if (!Number.isFinite(tabId)) throw new Error("tabId is required");
  if (status !== "handoff" && status !== "deliverable" && status !== null) {
    throw new Error('status must be "handoff", "deliverable", or null');
  }
  const existing = claims.get(tabId);
  if (!existing || existing.sessionId !== sessionId) {
    throw new Error(`Tab ${tabId} is not claimed by this session`);
  }
  existing.mark = status;
  existing.lastSeenAt = nowMs();
  return { content: { ok: true, tabId, status: existing.mark, origin: existing.origin } };
}

async function handleFinalize(sessionId, args = {}) {
  if (!sessionId) throw new Error("sessionId is required");
  const keepList = Array.isArray(args.keep) ? args.keep : [];
  const keepMap = new Map();
  for (const item of keepList) {
    const tabId = item && Number.isFinite(item.tabId) ? item.tabId : null;
    if (tabId == null) continue;
    const status = item.status === "handoff" || item.status === "deliverable" ? item.status : "handoff";
    keepMap.set(tabId, status);
  }

  const sessionClaims = listSessionClaims(sessionId);
  const toClose = [];
  const released = [];
  const kept = [];

  for (const claim of sessionClaims) {
    const keepStatus = keepMap.has(claim.tabId) ? keepMap.get(claim.tabId) : claim.mark;
    if (keepStatus === "handoff" || keepStatus === "deliverable") {
      releaseClaim(claim.tabId);
      kept.push({ tabId: claim.tabId, status: keepStatus, origin: claim.origin });
      continue;
    }
    if (claim.origin === "user") {
      releaseClaim(claim.tabId);
      released.push({ tabId: claim.tabId, origin: "user" });
    } else {
      toClose.push(claim.tabId);
    }
  }

  if (toClose.length) {
    try {
      await callExtension("close_tab", { tabIds: toClose }, sessionId);
    } catch (err) {
      // Close what we can; still drop claims.
    }
    for (const tabId of toClose) releaseClaim(tabId);
  }

  const state = getSessionState(sessionId);
  // Keep name/groupId for continued work after finalize; claims may be empty.
  return {
    content: {
      ok: true,
      closed: toClose,
      released,
      kept,
      session: {
        sessionId,
        name: state?.name || null,
        groupId: state?.groupId || null,
        defaultTabId: state?.defaultTabId || null,
      },
    },
  };
}

async function handleTool(pluginSocket, req) {
  const { tool, args = {}, sessionId } = req;
  if (!tool) throw new Error("Missing tool");

  if (sessionId) touchSession(sessionId);

  // Session-level tools (no default tab resolution)
  if (tool === "name_session") return await handleNameSession(sessionId, args);
  if (tool === "mark_tab") return await handleMarkTab(sessionId, args);
  if (tool === "finalize") return await handleFinalize(sessionId, args);

  let tabId = args.tabId;
  const toolArgs = { ...args };

  const isCloseTool = tool === "close_tab";
  const isOpenTool = tool === "open_tab";

  if (isOpenTool) {
    // Codex-aligned: default active false; agent tabs join session group.
    if (toolArgs.active === undefined) toolArgs.active = false;
    const state = getSessionState(sessionId);
    if (!Number.isFinite(toolArgs.groupId)) {
      let groupId = state && Number.isFinite(state.groupId) ? state.groupId : null;
      if (groupId == null && sessionId) {
        const g = await ensureSessionGroup(sessionId);
        groupId = g.groupId;
      }
      if (Number.isFinite(groupId)) toolArgs.groupId = groupId;
    }
  }

  let resolvedFromDefault = false;
  if (wantsTab(tool)) {
    if (typeof tabId !== "number") {
      const state = getSessionState(sessionId);
      const defaultTabId = state && Number.isFinite(state.defaultTabId) ? state.defaultTabId : null;
      if (Number.isFinite(defaultTabId)) {
        tabId = defaultTabId;
        resolvedFromDefault = true;
      } else if (!isCloseTool) {
        tabId = await ensureSessionTab(sessionId);
      } else {
        throw new Error("No tab owned by this session. Open a new tab first.");
      }
    }

    const claimCheck = checkClaim(tabId, sessionId);
    if (!claimCheck.ok) throw new Error(claimCheck.error);
  }

  const groupIdFromSession = isOpenTool && Number.isFinite(toolArgs.groupId);

  let res;
  try {
    res = await callExtension(tool, { ...toolArgs, tabId }, sessionId);
  } catch (err) {
    const errText = err && err.message ? err.message : String(err);
    if (/no tab with id/i.test(errText) && typeof tabId === "number") {
      // Self-heal (#17): the extension reports a tab we still track as gone
      // (e.g. the user closed it). Drop the stale state immediately.
      console.error(`[browser-broker] tab ${tabId} is gone; releasing stale state`);
      releaseClaim(tabId);
      clearDefaultTab(sessionId, tabId);
      if (resolvedFromDefault && !isCloseTool) {
        // Retry once with a fresh background tab.
        console.error(`[browser-broker] retrying ${tool} with a fresh background tab`);
        tabId = await ensureSessionTab(sessionId);
        res = await callExtension(tool, { ...toolArgs, tabId }, sessionId);
      } else {
        throw err;
      }
    } else if (isOpenTool && groupIdFromSession && /no group with id/i.test(errText)) {
      // Self-heal (#17): the session tab group was removed; drop it and
      // retry once ungrouped.
      const state = getSessionState(sessionId);
      if (state) state.groupId = null;
      delete toolArgs.groupId;
      console.error(`[browser-broker] session group was removed; retrying ${tool} ungrouped`);
      res = await callExtension(tool, { ...toolArgs, tabId }, sessionId);
    } else {
      throw err;
    }
  }

  const usedTabId =
    res && typeof res.tabId === "number" ? res.tabId : typeof tabId === "number" ? tabId : undefined;
  if (typeof usedTabId === "number") {
    if (isCloseTool) {
      if (claims.has(usedTabId)) {
        releaseClaim(usedTabId);
      } else {
        clearDefaultTab(sessionId, usedTabId);
      }
      // Also release any extra closed ids from batch close
      const closedIds = res?.content?.tabIds;
      if (Array.isArray(closedIds)) {
        for (const id of closedIds) {
          if (Number.isFinite(id) && id !== usedTabId) releaseClaim(id);
        }
      }
    } else if (isOpenTool) {
      setClaim(usedTabId, sessionId, { origin: "agent", mark: null });
      setDefaultTab(sessionId, usedTabId);
      const content = res && res.content != null ? res.content : {};
      const state = getSessionState(sessionId);
      if (state && Number.isFinite(content.groupId)) state.groupId = content.groupId;
      await dropSeedTabIfReplaced(sessionId, usedTabId);
    } else {
      touchClaim(usedTabId, sessionId);
      setDefaultTab(sessionId, usedTabId);
    }
  }

  return res;
}

function handleClientMessage(socket, client, msg) {
  if (msg && msg.type === "hello") {
    registerSessionClient(client, msg.role, msg.sessionId);
    if (client.sessionId) touchSession(client.sessionId);
    if (client.role === "native-host") {
      host = { socket };
      // allow host to see current state
      writeJsonLine(socket, { type: "host_ready", claims: listClaims() });
    }
    return;
  }

  if (msg && msg.type === "from_extension") {
    const message = msg.message;
    if (message && message.type === "tool_response" && typeof message.id === "number") {
      const pending = extPending.get(message.id);
      if (!pending) return;
      extPending.delete(message.id);
      if (pending.timeout) clearTimeout(pending.timeout);

      if (message.error) {
        pending.reject(new Error(message.error.content || String(message.error)));
      } else {
        // Forward full result payload so callers can read tabId
        pending.resolve(message.result);
      }
      return;
    }
    if (message && message.type === "event") {
      handleExtensionEvent(message);
    }
    return;
  }

  if (msg && msg.type === "request" && typeof msg.id === "number") {
    const requestId = msg.id;
    const sessionId = msg.sessionId || client.sessionId;
    if (sessionId) touchSession(sessionId);

    const replyOk = (data) => writeJsonLine(socket, { type: "response", id: requestId, ok: true, data });
    const replyErr = (err) =>
      writeJsonLine(socket, { type: "response", id: requestId, ok: false, error: err.message || String(err) });

    (async () => {
      try {
        if (msg.op === "status") {
          const state = sessionId ? sessionState.get(sessionId) : null;
          const sessionInfo = state
            ? {
                sessionId,
                defaultTabId: state.defaultTabId,
                lastSeenAt: new Date(state.lastSeenAt).toISOString(),
                name: state.name || null,
                groupId: Number.isFinite(state.groupId) ? state.groupId : null,
              }
            : null;
          replyOk({
            broker: true,
            hostConnected: !!host && !!host.socket && !host.socket.destroyed,
            claims: listClaims(),
            leaseTtlMs: LEASE_TTL_MS,
            session: sessionInfo,
          });
          return;
        }

        if (msg.op === "list_claims") {
          replyOk({ claims: listClaims() });
          return;
        }

        if (msg.op === "claim_tab") {
          // Codex: claim user tab without moving into agent tab group.
          const tabId = msg.tabId;
          const force = !!msg.force;
          if (typeof tabId !== "number") throw new Error("tabId is required");
          const existing = claims.get(tabId);
          if (existing && existing.sessionId !== sessionId && !force) {
            throw new Error(`Tab ${tabId} is owned by another OpenCode session (${existing.sessionId})`);
          }
          if (existing && existing.sessionId !== sessionId && force) {
            clearDefaultTab(existing.sessionId, tabId);
          }
          setClaim(tabId, sessionId, { origin: "user", mark: null });
          setDefaultTab(sessionId, tabId);
          replyOk({ ok: true, tabId, sessionId, origin: "user" });
          return;
        }

        if (msg.op === "release_tab") {
          const tabId = msg.tabId;
          if (typeof tabId !== "number") throw new Error("tabId is required");
          const existing = claims.get(tabId);
          if (!existing) {
            replyOk({ ok: true, tabId, released: false });
            return;
          }
          if (existing.sessionId !== sessionId) {
            throw new Error(`Tab ${tabId} is owned by another OpenCode session (${existing.sessionId})`);
          }
          releaseClaim(tabId);
          replyOk({ ok: true, tabId, released: true });
          return;
        }

        if (msg.op === "name_session") {
          const result = await handleNameSession(sessionId, msg);
          replyOk(result);
          return;
        }

        if (msg.op === "mark_tab") {
          const result = await handleMarkTab(sessionId, msg);
          replyOk(result);
          return;
        }

        if (msg.op === "finalize") {
          const result = await handleFinalize(sessionId, msg);
          replyOk(result);
          return;
        }

        if (msg.op === "tool") {
          // Codex parity: a browser session gets its tab group eagerly — as soon as
          // the agent starts using browser tools, not only on the first tab-mutating
          // call. Pure diagnostics (status/capabilities) do not create a group.
          if (sessionId && !["capabilities_list"].includes(msg.tool)) {
            const state = getSessionState(sessionId);
            if (state && !Number.isFinite(state.groupId)) {
              try {
                await ensureSessionGroup(sessionId);
              } catch {
                // Group creation is best-effort; tool dispatch must not fail on it.
              }
            }
          }
          const result = await handleTool(socket, { tool: msg.tool, args: msg.args || {}, sessionId });
          replyOk(result);
          return;
        }

        throw new Error(`Unknown op: ${msg.op}`);
      } catch (e) {
        replyErr(e);
      }
    })();

    return;
  }
}

// --- Startup self-arbitration (#16) ---
// Multiple spawn sites (plugin, native host) can race to start a broker.
// Probe the socket before unlinking, and serialize via a pid lockfile.
const LOCK_PATH = process.platform === "win32" ? null : `${SOCKET_PATH}.lock`;

function acquireLock() {
  if (!LOCK_PATH) return true;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(LOCK_PATH, "wx");
      try {
        fs.writeFileSync(fd, `${process.pid}\n`);
      } catch {}
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err;
      let pid = NaN;
      try {
        pid = Number(fs.readFileSync(LOCK_PATH, "utf8").trim());
      } catch {}
      if (Number.isFinite(pid) && pid > 0) {
        try {
          process.kill(pid, 0); // throws if dead
          return false; // another live broker holds the lock
        } catch {
          // stale lock from a dead process; remove and retry once
        }
      }
      try {
        fs.unlinkSync(LOCK_PATH);
      } catch {}
    }
  }
  return false;
}

function releaseLock() {
  if (!LOCK_PATH) return;
  try {
    fs.unlinkSync(LOCK_PATH);
  } catch {}
}

function start() {
  const bind = () => {
    if (!acquireLock()) {
      console.error("[browser-broker] another live broker holds the lock; exiting");
      process.exit(0);
    }

    // The probe and lock proved nothing is listening; a leftover socket file is stale.
    if (process.platform !== "win32") {
      try {
        if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);
      } catch {
        // ignore
      }
    }

    const server = net.createServer((socket) => {
      socket.setNoDelay(true);

      const client = { role: "unknown", sessionId: null };
      clients.add(client);

      socket.on(
        "data",
        createJsonLineParser((msg) => handleClientMessage(socket, client, msg))
      );

      socket.on("close", () => {
        clients.delete(client);
        if (client.role === "native-host" && host && host.socket === socket) {
          host = null;
          // fail pending extension requests
          for (const [extId, pending] of extPending.entries()) {
            extPending.delete(extId);
            if (pending.timeout) clearTimeout(pending.timeout);
            pending.reject(new Error("Native host disconnected"));
          }
        }
        const disconnectedSessionId = client.sessionId;
        const wasLastSessionClient = unregisterSessionClient(client);
        if (disconnectedSessionId && wasLastSessionClient) {
          releaseClaimsForSession(disconnectedSessionId);
        }
      });

      socket.on("error", () => {
        // close handler will clean up
      });
    });

    server.listen(SOCKET_PATH, () => {
      // Make socket group-readable; ignore errors
      try {
        fs.chmodSync(SOCKET_PATH, 0o600);
      } catch {}
      console.error(`[browser-broker] listening on ${SOCKET_PATH}`);
    });

    server.on("error", (err) => {
      if (err && err.code === "EADDRINUSE") {
        // Lost the startup race despite the probe; never unlink someone else's active socket.
        console.error("[browser-broker] socket already in use; exiting");
        releaseLock();
        process.exit(0);
      }
      console.error("[browser-broker] server error", err);
      releaseLock();
      process.exit(1);
    });

    process.on("exit", releaseLock);
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      process.on(sig, () => {
        releaseLock();
        process.exit(0);
      });
    }
  };

  if (process.platform === "win32") {
    bind();
    return;
  }

  // If another broker already owns the socket, defer to it.
  const probe = net.createConnection(SOCKET_PATH);
  probe.once("connect", () => {
    try {
      probe.end();
    } catch {}
    console.error("[browser-broker] another broker already owns the socket; exiting");
    process.exit(0);
  });
  probe.once("error", () => {
    // ECONNREFUSED/ENOENT: stale socket file, safe to take over.
    try {
      probe.destroy();
    } catch {}
    bind();
  });
}

if (LEASE_TTL_MS > 0 && LEASE_SWEEP_MS > 0) {
  const timer = setInterval(cleanupStaleClaims, LEASE_SWEEP_MS);
  if (typeof timer.unref === "function") timer.unref();
}

start();
