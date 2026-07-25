import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import net from "net";
import { createAgentBackend, type AgentBackend } from "./agent-backend.js";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "fs";
import { homedir, tmpdir, userInfo } from "os";
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";


const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_JSON_PATH = join(__dirname, "..", "package.json");

let cachedVersion: string | null = null;

function getPackageVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));
    if (typeof pkg?.version === "string") {
      cachedVersion = pkg.version;
      return cachedVersion;
    }
  } catch {
    // ignore
  }
  cachedVersion = "unknown";
  return cachedVersion;
}

const { schema } = tool;

const BASE_DIR = join(homedir(), ".opencode-browser");
const SOCKET_PATH = getBrokerSocketPath();
const LOG_PATH = join(BASE_DIR, "plugin.log");

function getSafePipeName(): string {
  try {
    const username = userInfo().username || "user";
    return `opencode-browser-${username}`.replace(/[^a-zA-Z0-9._-]/g, "_");
  } catch {
    return "opencode-browser";
  }
}

function getBrokerSocketPath(): string {
  const override = process.env.OPENCODE_BROWSER_BROKER_SOCKET;
  if (override) return override;
  if (process.platform === "win32") return `\\\\.\\pipe\\${getSafePipeName()}`;
  return join(BASE_DIR, "broker.sock");
}

mkdirSync(BASE_DIR, { recursive: true });

function logDebug(message: string): void {
  try {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${message}\n`, "utf8");
  } catch {
    // ignore
  }
}

logDebug(`plugin loaded v${getPackageVersion()} pid=${process.pid} socket=${SOCKET_PATH}`);

const DEFAULT_MAX_UPLOAD_BYTES = 512 * 1024;
const MAX_UPLOAD_BYTES = (() => {
  const raw = process.env.OPENCODE_BROWSER_MAX_UPLOAD_BYTES;
  const value = raw ? Number(raw) : NaN;
  if (Number.isFinite(value) && value > 0) return value;
  return DEFAULT_MAX_UPLOAD_BYTES;
})();

function resolveUploadPath(filePath: string): string {
  const trimmed = typeof filePath === "string" ? filePath.trim() : "";
  if (!trimmed) throw new Error("filePath is required");
  return isAbsolute(trimmed) ? trimmed : resolve(process.cwd(), trimmed);
}

const BLOCKED_UPLOAD_BASENAMES = new Set(["id_rsa", "id_ed25519"]);
const BLOCKED_UPLOAD_EXTENSIONS = new Set([".pem", ".key"]);
const ENV_FILE_SEGMENT_RE = /^\.env($|\.)/i;

function isPathWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function getBlockedUploadDirs(): string[] {
  const home = homedir();
  const raw = [
    join(home, ".ssh"),
    join(home, ".aws"),
    join(home, ".gnupg"),
    join(home, ".config", "opencode"),
    join(home, ".opencode-browser"),
    join(home, "Library", "Keychains"),
  ];
  // Check both raw and realpath'd forms (home itself may be symlinked).
  const dirs = new Set<string>();
  for (const dir of raw) {
    dirs.add(dir);
    dirs.add(realpathOrSelf(dir));
  }
  return [...dirs];
}

function getAllowedUploadRoots(): string[] {
  const roots: string[] = [process.cwd(), tmpdir()];
  const extra = process.env.OPENCODE_BROWSER_UPLOAD_DIRS;
  if (extra) {
    for (const part of extra.split(delimiter)) {
      const dir = part.trim();
      if (dir && isAbsolute(dir)) roots.push(dir);
    }
  }
  const out: string[] = [];
  for (const root of roots) {
    const real = realpathOrSelf(root);
    if (!out.includes(real)) out.push(real);
  }
  return out;
}

function assertUploadAllowed(absPath: string): string {
  let real: string;
  try {
    real = realpathSync(absPath);
  } catch {
    throw new Error(`Cannot read file: ${absPath}`);
  }

  // Hard blocklist — always refused, even inside allowed roots.
  for (const blockedDir of getBlockedUploadDirs()) {
    if (isPathWithin(real, blockedDir)) {
      throw new Error(
        `Refusing to read sensitive path: ${real}. This location is always blocked ` +
          `(credential/config directories such as ~/.ssh, ~/.aws, ~/.gnupg, ~/.config/opencode, ` +
          `~/.opencode-browser, ~/Library/Keychains) regardless of upload boundary settings.`
      );
    }
  }
  const segments = real.split(sep);
  for (const segment of segments) {
    if (ENV_FILE_SEGMENT_RE.test(segment)) {
      throw new Error(
        `Refusing to read sensitive file: ${real}. Paths containing .env files are always blocked.`
      );
    }
  }
  const base = basename(real).toLowerCase();
  if (BLOCKED_UPLOAD_BASENAMES.has(base) || BLOCKED_UPLOAD_EXTENSIONS.has(extname(base))) {
    throw new Error(
      `Refusing to read sensitive file: ${real}. Private keys and certificate files ` +
        `(id_rsa, id_ed25519, *.pem, *.key) are always blocked.`
    );
  }

  // Boundary check AFTER realpath so symlink escapes fail closed.
  const roots = getAllowedUploadRoots();
  if (!roots.some((root) => isPathWithin(real, root))) {
    throw new Error(
      `Refusing to read file outside the allowed upload boundary: ${real}. ` +
        `Allowed roots: the workspace (${realpathOrSelf(process.cwd())}) and the OS temp dir (${realpathOrSelf(tmpdir())}). ` +
        `To allow this file, move it into the workspace or set OPENCODE_BROWSER_UPLOAD_DIRS ` +
        `(OS PATH-delimited absolute directories: ";" on Windows, ":" on macOS/Linux).`
    );
  }
  return real;
}

function buildFileUploadPayload(
  filePath: string,
  fileName?: string,
  mimeType?: string
): { name: string; mimeType?: string; base64: string } {
  const absPath = assertUploadAllowed(resolveUploadPath(filePath));
  const stats = statSync(absPath);
  if (!stats.isFile()) throw new Error(`Not a file: ${absPath}`);
  if (stats.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `File too large (${stats.size} bytes). Max is ${MAX_UPLOAD_BYTES} bytes (OPENCODE_BROWSER_MAX_UPLOAD_BYTES). ` +
        `For larger uploads, use OPENCODE_BROWSER_BACKEND=agent.`
    );
  }
  const base64 = readFileSync(absPath).toString("base64");
  const name = typeof fileName === "string" && fileName.trim() ? fileName.trim() : basename(absPath);
  const mt = typeof mimeType === "string" && mimeType.trim() ? mimeType.trim() : undefined;
  return { name, mimeType: mt, base64 };
}

type BrokerResponse =
  | { type: "response"; id: number; ok: true; data: any }
  | { type: "response"; id: number; ok: false; error: string };

function createJsonLineParser(onMessage: (msg: any) => void): (chunk: Buffer) => void {
  let buffer = "";
  return (chunk: Buffer) => {
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

function writeJsonLine(socket: net.Socket, msg: any): void {
  socket.write(JSON.stringify(msg) + "\n");
}

function maybeStartBroker(): void {
  const brokerPath = join(BASE_DIR, "broker.cjs");
  if (!existsSync(brokerPath)) return;

  try {
    const child = spawn(process.execPath, [brokerPath], { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // ignore
  }
}

async function connectToBroker(): Promise<net.Socket> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET_PATH);
    socket.once("connect", () => resolve(socket));
    socket.once("error", (err) => {
      lastBrokerError = err instanceof Error ? err : new Error(String(err));
      logDebug(`broker connect error socket=${SOCKET_PATH} error=${lastBrokerError.message}`);
      reject(err);
    });
  });
}

async function sleep(ms: number): Promise<void> {
  return await new Promise((r) => setTimeout(r, ms));
}

const BACKEND_MODE = (process.env.OPENCODE_BROWSER_BACKEND ?? process.env.OPENCODE_BROWSER_MODE ?? "extension")
  .toLowerCase()
  .trim();
const USE_AGENT_BACKEND = ["agent", "agent-browser", "agentbrowser"].includes(BACKEND_MODE);

let socket: net.Socket | null = null;
let connectingPromise: Promise<net.Socket> | null = null;
let lastBrokerError: Error | null = null;
let sessionId = Math.random().toString(36).slice(2);
let reqId = 0;
const pending = new Map<
  number,
  { socket: net.Socket; resolve: (v: any) => void; reject: (e: Error) => void }
>();

const agentBackend: AgentBackend | null = USE_AGENT_BACKEND ? createAgentBackend(sessionId) : null;

async function ensureBrokerSocket(): Promise<net.Socket> {
  if (socket && !socket.destroyed) return socket;
  if (connectingPromise) return await connectingPromise;

  connectingPromise = (async () => {
    let connectedSocket: net.Socket | null = null;
    // Try to connect; if missing, try to start broker and retry.
    try {
      connectedSocket = await connectToBroker();
    } catch {
      maybeStartBroker();
      for (let i = 0; i < 20; i++) {
        await sleep(100);
        try {
          connectedSocket = await connectToBroker();
          break;
        } catch {}
      }
    }

    if (!connectedSocket || connectedSocket.destroyed) {
      const errorMessage = lastBrokerError?.message ? ` (${lastBrokerError.message})` : "";
      throw new Error(
        `Could not connect to local broker at ${SOCKET_PATH}${errorMessage}. ` +
          "Run `npx @ageless-h/opencode-browser install` and ensure the extension is loaded."
      );
    }

    socket = connectedSocket;
    connectedSocket.setNoDelay(true);
    logDebug(`broker connected socket=${SOCKET_PATH}`);
    connectedSocket.on(
      "data",
      createJsonLineParser((msg) => {
        if (msg?.type !== "response" || typeof msg.id !== "number") return;
        const p = pending.get(msg.id);
        if (!p || p.socket !== connectedSocket) return;
        pending.delete(msg.id);
        const res = msg as BrokerResponse;
        if (!res.ok) p.reject(new Error(res.error));
        else p.resolve(res.data);
      })
    );

    const rejectSocketPending = (reason: string) => {
      for (const [id, p] of pending.entries()) {
        if (p.socket !== connectedSocket) continue;
        pending.delete(id);
        p.reject(new Error(reason));
      }
    };

    connectedSocket.on("close", () => {
      rejectSocketPending("Broker connection closed");
      if (socket === connectedSocket) socket = null;
    });

    connectedSocket.on("error", (err) => {
      rejectSocketPending(`Broker connection error: ${err.message}`);
      if (socket === connectedSocket) socket = null;
    });

    writeJsonLine(connectedSocket, { type: "hello", role: "plugin", sessionId, pid: process.pid });
    return connectedSocket;
  })();

  try {
    return await connectingPromise;
  } finally {
    connectingPromise = null;
  }
}

async function brokerRequest(op: string, payload: Record<string, any>): Promise<any> {
  const s = await ensureBrokerSocket();
  const id = ++reqId;

  return await new Promise((resolve, reject) => {
    pending.set(id, { socket: s, resolve, reject });
    try {
      writeJsonLine(s, { type: "request", id, op, ...payload });
    } catch (err) {
      pending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error("Timed out waiting for broker response"));
    }, 60000);
  });
}

async function brokerOnlyRequest(op: string, payload: Record<string, any>): Promise<any> {
  if (USE_AGENT_BACKEND) {
    throw new Error("Tab claims are not supported with agent-browser backend");
  }
  return await brokerRequest(op, payload);
}

function toolResultText(data: any, fallback: string): string {
  if (typeof data?.content === "string") return data.content;
  if (typeof data === "string") return data;
  if (data?.content != null) return JSON.stringify(data.content);
  return fallback;
}

function screenshotResultText(data: any, fallback: string): string {
  // The extension may embed a structured envelope
  // ({ ok, method, degraded, note, data }) inside content for screenshots.
  // Surface the metadata so degraded captures are not silently indistinguishable.
  const content = data?.content;
  if (typeof content === "string") {
    const trimmed = content.trimStart();
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object") {
          const meta: string[] = [];
          if (parsed.method != null) meta.push(`method: ${parsed.method}`);
          if (parsed.degraded != null) meta.push(`degraded: ${parsed.degraded}`);
          if (parsed.note != null) meta.push(`note: ${parsed.note}`);
          const image =
            typeof parsed.data === "string"
              ? parsed.data
              : typeof parsed.content === "string"
                ? parsed.content
                : null;
          if (meta.length > 0) {
            return image ? `${image}\n[${meta.join(", ")}]` : `[${meta.join(", ")}]`;
          }
        }
      } catch {
        // not a JSON envelope — fall through
      }
    }
    // Plain image data (data URL / base64) — return exactly as-is.
    return content;
  }
  const text = toolResultText(data, fallback);
  if (typeof data?.note === "string" && data.note) return `${text}\n[note: ${data.note}]`;
  return text;
}

async function toolRequest(toolName: string, args: Record<string, any>): Promise<any> {
  if (USE_AGENT_BACKEND) {
    if (!agentBackend) {
      throw new Error("Agent backend unavailable: configuration failed to initialize");
    }
    return await agentBackend.requestTool(toolName, args);
  }
  return await brokerRequest("tool", { tool: toolName, args });
}

async function statusRequest(): Promise<any> {
  if (USE_AGENT_BACKEND) {
    if (!agentBackend) {
      return {
        backend: "agent-browser",
        connected: false,
        error: "Agent backend unavailable: configuration failed to initialize",
      };
    }
    return await agentBackend.status();
  }
  return await brokerRequest("status", {});
}

const plugin: Plugin = async (ctx) => {

  return {
    tool: {
      browser_debug: tool({
        description: "Debug plugin loading and connection status.",
        args: {},
        async execute(args, ctx) {
          const lines = [
            "loaded: true",
            `sessionId: ${sessionId}`,
            `pid: ${process.pid}`,
            `backend: ${USE_AGENT_BACKEND ? "agent-browser" : "extension"}`,
            `brokerSocket: ${SOCKET_PATH}`,
            `agentSession: ${agentBackend?.session ?? ""}`,
            `agentConnection: ${JSON.stringify(agentBackend?.connection ?? null)}`,
            `agentBrowserVersion: ${agentBackend?.getVersion?.() ?? ""}`,
            `pluginVersion: ${getPackageVersion()}`,
            `timestamp: ${new Date().toISOString()}`,
          ];
          return lines.join("\n");
        },
      }),

      browser_version: tool({
        description: "Return the installed @ageless-h/opencode-browser plugin version.",
        args: {},
        async execute(args, ctx) {
          return JSON.stringify({
            name: "@ageless-h/opencode-browser",
            version: getPackageVersion(),
            sessionId,
            pid: process.pid,
            backend: USE_AGENT_BACKEND ? "agent-browser" : "extension",
            agentBrowserVersion: agentBackend?.getVersion?.() ?? null,
          });
        },
      }),

      browser_status: tool({
        description: "Check backend connection status and current tab claims.",
        args: {},
        async execute(args, ctx) {
          const data = await statusRequest();
          return JSON.stringify(data);
        },
      }),

      browser_get_tabs: tool({
        description: "List all open browser tabs",
        args: {},
        async execute(args, ctx) {
          const data = await toolRequest("get_tabs", {});
          return toolResultText(data, "ok");
        },
      }),

      browser_list_claims: tool({
        description: "List tab ownership claims",
        args: {},
        async execute(args, ctx) {
          const data = await brokerOnlyRequest("list_claims", {});
          return JSON.stringify(data);
        },
      }),

      browser_claim_tab: tool({
        description:
          "Claim an existing user tab for this session without moving it into the agent tab group (Codex claimTab).",
        args: {
          tabId: schema.number(),
          force: schema.boolean().optional(),
        },
        async execute({ tabId, force }, ctx) {
          const data = await brokerOnlyRequest("claim_tab", { tabId, force });
          return JSON.stringify(data);
        },
      }),

      browser_release_tab: tool({
        description: "Release a claimed browser tab",
        args: {
          tabId: schema.number(),
        },
        async execute({ tabId }, ctx) {
          const data = await brokerOnlyRequest("release_tab", { tabId });
          return JSON.stringify(data);
        },
      }),

      browser_name_session: tool({
        description:
          "Name this browser session and create/update its Chrome tab group (Codex nameSession). " +
          "Call early; subsequent open_tab agent tabs join the group.",
        args: {
          name: schema.string(),
          color: schema.string().optional(),
          collapsed: schema.boolean().optional(),
        },
        async execute({ name, color, collapsed }, ctx) {
          const data = await brokerOnlyRequest("name_session", { name, color, collapsed });
          return toolResultText(data, JSON.stringify(data));
        },
      }),

      browser_mark_tab: tool({
        description:
          "Mark a claimed tab as handoff or deliverable for finalize (Codex markHandoff/markDeliverable). " +
          "status null clears the mark.",
        args: {
          tabId: schema.number(),
          status: schema.string(),
        },
        async execute({ tabId, status }, ctx) {
          const normalized = status === "null" || status === "" ? null : status;
          const data = await brokerOnlyRequest("mark_tab", { tabId, status: normalized });
          return toolResultText(data, JSON.stringify(data));
        },
      }),

      browser_finalize: tool({
        description:
          "Explicitly clean up session tabs (Codex tabs.finalize). Unmarked agent tabs close; " +
          "user claims and handoff/deliverable tabs are released and left open. Does not disconnect.",
        args: {
          keep: schema.string().optional(),
        },
        async execute({ keep }, ctx) {
          let keepList: any[] | undefined;
          if (typeof keep === "string" && keep.trim()) {
            try {
              keepList = JSON.parse(keep);
            } catch {
              throw new Error('keep must be JSON array like [{"tabId":1,"status":"handoff"}]');
            }
          }
          const data = await brokerOnlyRequest("finalize", { keep: keepList });
          return toolResultText(data, JSON.stringify(data));
        },
      }),

      browser_open_tab: tool({
        description:
          "Open a new agent tab (default active:false — does not steal foreground). " +
          "Joins the session Chrome tab group when available.",
        args: {
          url: schema.string().optional(),
          active: schema.boolean().optional(),
        },
        async execute({ url, active }, ctx) {
          const data = await toolRequest("open_tab", { url, active });
          return toolResultText(data, "Opened new tab");
        },
      }),

      browser_close_tab: tool({
        description: "Close a browser tab owned by this session",
        args: {
          tabId: schema.number().optional(),
        },
        async execute({ tabId }, ctx) {
          const data = await toolRequest("close_tab", { tabId });
          return toolResultText(data, "Closed tab");
        },
      }),

      browser_navigate: tool({
        description: "Navigate to a URL in the browser",
        args: {
          url: schema.string(),
          tabId: schema.number().optional(),
        },
        async execute({ url, tabId }, ctx) {
          const data = await toolRequest("navigate", { url, tabId });
          return toolResultText(data, `Navigated to ${url}`);
        },
      }),

      browser_back: tool({
        description: "Navigate the tab back in history",
        args: {
          tabId: schema.number().optional(),
        },
        async execute({ tabId }, ctx) {
          const data = await toolRequest("back", { tabId });
          return toolResultText(data, "Navigated back");
        },
      }),

      browser_forward: tool({
        description: "Navigate the tab forward in history",
        args: {
          tabId: schema.number().optional(),
        },
        async execute({ tabId }, ctx) {
          const data = await toolRequest("forward", { tabId });
          return toolResultText(data, "Navigated forward");
        },
      }),

      browser_reload: tool({
        description: "Reload the current page",
        args: {
          tabId: schema.number().optional(),
          bypassCache: schema.boolean().optional(),
        },
        async execute({ tabId, bypassCache }, ctx) {
          const data = await toolRequest("reload", { tabId, bypassCache });
          return toolResultText(data, "Reloaded");
        },
      }),

      browser_set_active_tab: tool({
        description: "Activate a claimed browser tab (bring it to the foreground)",
        args: {
          tabId: schema.number(),
        },
        async execute({ tabId }, ctx) {
          const data = await toolRequest("set_active_tab", { tabId });
          return toolResultText(data, `Activated tab ${tabId}`);
        },
      }),

      browser_key: tool({
        description:
          "Press a keyboard key on the focused element (or an optional selector). " +
          "Use for Enter, Escape, Tab, arrows, and modifier combinations.",
        args: {
          key: schema.string(),
          code: schema.string().optional(),
          keyCode: schema.number().optional(),
          ctrlKey: schema.boolean().optional(),
          metaKey: schema.boolean().optional(),
          altKey: schema.boolean().optional(),
          shiftKey: schema.boolean().optional(),
          repeat: schema.boolean().optional(),
          delayMs: schema.number().optional(),
          selector: schema.string().optional(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute(
          { key, code, keyCode, ctrlKey, metaKey, altKey, shiftKey, repeat, delayMs, selector, index, tabId, timeoutMs, pollMs },
          ctx
        ) {
          const data = await toolRequest("key", {
            key,
            code,
            keyCode,
            ctrlKey,
            metaKey,
            altKey,
            shiftKey,
            repeat,
            delayMs,
            selector,
            index,
            tabId,
            timeoutMs,
            pollMs,
          });
          return toolResultText(data, `Pressed ${key}`);
        },
      }),

      browser_handle_dialog: tool({
        description:
          "Accept or dismiss a pending JavaScript dialog (alert/confirm/prompt). " +
          "Requires debugger permission; attach before the dialog opens (calling this tool, browser_console, or browser_errors attaches).",
        args: {
          action: schema.string().optional(),
          promptText: schema.string().optional(),
          tabId: schema.number().optional(),
        },
        async execute({ action, promptText, tabId }, ctx) {
          const data = await toolRequest("handle_dialog", { action, promptText, tabId });
          return toolResultText(data, "Handled dialog");
        },
      }),

      browser_click: tool({
        description:
          "Click an element. selector supports CSS and locators: uid:e12, role:button[name=Submit], " +
          "label:, aria:, text:, placeholder:, name:, id:. Omit index → strict unique match; multi-match returns candidates.",
        args: {
          selector: schema.string(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, index, tabId, timeoutMs, pollMs }, ctx) {
          const data = await toolRequest("click", { selector, index, tabId, timeoutMs, pollMs });
          return toolResultText(data, `Clicked ${selector}`);
        },
      }),

      browser_type: tool({
        description:
          "Type text into an input. selector supports CSS and locators (uid:/role:/label:/…); " +
          "omit index for strict unique match.",
        args: {
          selector: schema.string(),
          text: schema.string(),
          clear: schema.boolean().optional(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, text, clear, index, tabId, timeoutMs, pollMs }, ctx) {
          const data = await toolRequest("type", { selector, text, clear, index, tabId, timeoutMs, pollMs });
          return toolResultText(data, `Typed "${text}" into ${selector}`);
        },
      }),

      browser_select: tool({
        description:
          "Select an option in a native select. selector supports CSS and locators (uid:/role:/…); " +
          "omit index for strict unique match.",
        args: {
          selector: schema.string(),
          value: schema.string().optional(),
          label: schema.string().optional(),
          optionIndex: schema.number().optional(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, value, label, optionIndex, index, tabId, timeoutMs, pollMs }, ctx) {
          const data = await toolRequest("select", { selector, value, label, optionIndex, index, tabId, timeoutMs, pollMs });
          const summary = value ?? label ?? (optionIndex != null ? String(optionIndex) : "option");
          return toolResultText(data, `Selected ${summary} in ${selector}`);
        },
      }),

      // --- Codex Playwright subset (flat tools) ---
      browser_count: tool({
        description: "Count elements matching selector (Codex locator.count). Prefer before click when uniqueness is unclear.",
        args: {
          selector: schema.string(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, tabId, timeoutMs, pollMs }, ctx) {
          const data = await toolRequest("count", { selector, tabId, timeoutMs, pollMs });
          return toolResultText(data, "0");
        },
      }),

      browser_is_visible: tool({
        description: "Whether the matched element is visible (Codex locator.isVisible). Strict unique match when index omitted.",
        args: {
          selector: schema.string(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, index, tabId, timeoutMs, pollMs }, ctx) {
          const data = await toolRequest("is_visible", { selector, index, tabId, timeoutMs, pollMs });
          return toolResultText(data, "false");
        },
      }),

      browser_is_enabled: tool({
        description: "Whether the matched element is enabled (Codex locator.isEnabled).",
        args: {
          selector: schema.string(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, index, tabId, timeoutMs, pollMs }, ctx) {
          const data = await toolRequest("is_enabled", { selector, index, tabId, timeoutMs, pollMs });
          return toolResultText(data, "false");
        },
      }),

      browser_get_attribute: tool({
        description: "Read one attribute from a matched element (Codex locator.getAttribute).",
        args: {
          selector: schema.string(),
          name: schema.string(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, name, index, tabId, timeoutMs, pollMs }, ctx) {
          const data = await toolRequest("get_attribute", { selector, name, index, tabId, timeoutMs, pollMs });
          return toolResultText(data, "null");
        },
      }),

      browser_text_content: tool({
        description: "Element textContent (Codex locator.textContent).",
        args: {
          selector: schema.string(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, index, tabId, timeoutMs, pollMs }, ctx) {
          const data = await toolRequest("text_content", { selector, index, tabId, timeoutMs, pollMs });
          return toolResultText(data, "");
        },
      }),

      browser_inner_text: tool({
        description: "Element innerText (Codex locator.innerText).",
        args: {
          selector: schema.string(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, index, tabId, timeoutMs, pollMs }, ctx) {
          const data = await toolRequest("inner_text", { selector, index, tabId, timeoutMs, pollMs });
          return toolResultText(data, "");
        },
      }),

      browser_dblclick: tool({
        description: "Double-click an element (Codex locator.dblclick). Strict unique match when index omitted.",
        args: {
          selector: schema.string(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, index, tabId, timeoutMs, pollMs }, ctx) {
          const data = await toolRequest("dblclick", { selector, index, tabId, timeoutMs, pollMs });
          return toolResultText(data, `Double-clicked ${selector}`);
        },
      }),

      browser_check: tool({
        description: "Check a checkbox/radio (Codex locator.check).",
        args: {
          selector: schema.string(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, index, tabId, timeoutMs, pollMs }, ctx) {
          const data = await toolRequest("check", { selector, index, tabId, timeoutMs, pollMs });
          return toolResultText(data, "checked");
        },
      }),

      browser_uncheck: tool({
        description: "Uncheck a checkbox (Codex locator.uncheck).",
        args: {
          selector: schema.string(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, index, tabId, timeoutMs, pollMs }, ctx) {
          const data = await toolRequest("uncheck", { selector, index, tabId, timeoutMs, pollMs });
          return toolResultText(data, "unchecked");
        },
      }),

      browser_set_checked: tool({
        description: "Set checkbox/radio checked state (Codex locator.setChecked).",
        args: {
          selector: schema.string(),
          checked: schema.boolean().optional(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, checked, index, tabId, timeoutMs, pollMs }, ctx) {
          const data = await toolRequest("set_checked", {
            selector,
            checked: checked !== false,
            index,
            tabId,
            timeoutMs,
            pollMs,
          });
          return toolResultText(data, "set_checked");
        },
      }),

      browser_fill: tool({
        description: "Fill an input (clear then set value; Codex locator.fill).",
        args: {
          selector: schema.string(),
          text: schema.string(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, text, index, tabId, timeoutMs, pollMs }, ctx) {
          const data = await toolRequest("fill", { selector, text, index, tabId, timeoutMs, pollMs });
          return toolResultText(data, `Filled ${selector}`);
        },
      }),

      browser_wait_for: tool({
        description:
          "Wait for locator state (Codex locator.waitFor). state: attached|detached|visible|hidden.",
        args: {
          selector: schema.string(),
          state: schema.string().optional(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, state, index, tabId, timeoutMs, pollMs }, ctx) {
          const data = await toolRequest("wait_for", {
            selector,
            state: state || "visible",
            index,
            tabId,
            timeoutMs,
            pollMs,
          });
          return toolResultText(data, "ok");
        },
      }),

      browser_wait_for_load_state: tool({
        description: 'Wait for page load state (Codex waitForLoadState): "load" | "domcontentloaded" | "networkidle".',
        args: {
          state: schema.string().optional(),
          timeoutMs: schema.number().optional(),
          tabId: schema.number().optional(),
        },
        async execute({ state, timeoutMs, tabId }, ctx) {
          const data = await toolRequest("wait_for_load_state", {
            state: state || "load",
            timeoutMs,
            tabId,
          });
          return toolResultText(data, "ok");
        },
      }),

      browser_wait_for_url: tool({
        description:
          "Wait until tab URL matches (Codex waitForURL). url can be exact, substring, glob with *, or re:pattern.",
        args: {
          url: schema.string(),
          timeoutMs: schema.number().optional(),
          tabId: schema.number().optional(),
        },
        async execute({ url, timeoutMs, tabId }, ctx) {
          const data = await toolRequest("wait_for_url", { url, timeoutMs, tabId });
          return toolResultText(data, "ok");
        },
      }),

      browser_evaluate: tool({
        description:
          "Execute arbitrary JavaScript in the page's main world (Codex playwright.evaluate) with FULL side-effect capability: it can mutate the DOM, read/write localStorage/cookies, fire network requests, click elements, and submit forms. NOT read-only — do not treat as a safe observation step. Prefer dedicated tools for actions (browser_click, browser_type, browser_fill, browser_select) and for observation (browser_query, browser_snapshot, browser_screenshot); use evaluate only when no dedicated tool suffices. Pass expression string; optional selector scopes to element as `el`. Returns the JSON-serialized result of the expression.",
        args: {
          expression: schema.string(),
          selector: schema.string().optional(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
        },
        async execute({ expression, selector, index, tabId }, ctx) {
          const data = await toolRequest("evaluate", { expression, selector, index, tabId });
          return toolResultText(data, "null");
        },
      }),

      browser_export: tool({
        description:
          'Export page content (Codex Tab.content.export). contentType: "html" | "text" | "domSnapshot".',
        args: {
          contentType: schema.string().optional(),
          tabId: schema.number().optional(),
        },
        async execute({ contentType, tabId }, ctx) {
          const data = await toolRequest("export", { contentType: contentType || "text", tabId });
          return toolResultText(data, "");
        },
      }),

      browser_get_js_dialog: tool({
        description:
          "Return pending JS dialog if any (Codex Tab.getJsDialog). Prefer attaching via console/errors/handle_dialog before dialog opens.",
        args: {
          tabId: schema.number().optional(),
        },
        async execute({ tabId }, ctx) {
          const data = await toolRequest("get_js_dialog", { tabId });
          return toolResultText(data, '{"dialog":null}');
        },
      }),

      browser_title: tool({
        description: "Current tab title (Codex Tab.title).",
        args: {
          tabId: schema.number().optional(),
        },
        async execute({ tabId }, ctx) {
          const data = await toolRequest("title", { tabId });
          return toolResultText(data, "");
        },
      }),

      browser_url: tool({
        description: "Current tab URL (Codex Tab.url).",
        args: {
          tabId: schema.number().optional(),
        },
        async execute({ tabId }, ctx) {
          const data = await toolRequest("url", { tabId });
          return toolResultText(data, "");
        },
      }),

      browser_screenshot: tool({
        description:
          "Take a screenshot of the tab (Codex tab.screenshot). Returns base64 image data URL. " +
          "Options: fullPage (capture beyond viewport via CDP), clip:{x,y,width,height}.",
        args: {
          tabId: schema.number().optional(),
          fullPage: schema.boolean().optional(),
          clip: schema.any().optional(),
        },
        async execute({ tabId, fullPage, clip }, ctx) {
          const data = await toolRequest("screenshot", { tabId, fullPage, clip });
          return screenshotResultText(data, "Screenshot failed");
        },
      }),

      browser_clipboard_read_text: tool({
        description: "Read plain text from the browser clipboard (Codex tab.clipboard.readText).",
        args: {
          tabId: schema.number().optional(),
        },
        async execute({ tabId }, ctx) {
          const data = await toolRequest("clipboard_read_text", { tabId });
          return toolResultText(data, "");
        },
      }),

      browser_clipboard_write_text: tool({
        description: "Write plain text to the browser clipboard (Codex tab.clipboard.writeText).",
        args: {
          text: schema.string(),
          tabId: schema.number().optional(),
        },
        async execute({ text, tabId }, ctx) {
          const data = await toolRequest("clipboard_write_text", { text, tabId });
          return toolResultText(data, "ok");
        },
      }),

      browser_all_text_contents: tool({
        description:
          "Return textContent for all elements matched by the locator (Codex locator.allTextContents). Not strict-unique.",
        args: {
          selector: schema.string(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
          limit: schema.number().optional(),
        },
        async execute({ selector, tabId, timeoutMs, pollMs, limit }, ctx) {
          const data = await toolRequest("all_text_contents", {
            selector,
            tabId,
            timeoutMs,
            pollMs,
            limit,
          });
          return toolResultText(data, "[]");
        },
      }),

      browser_element_info: tool({
        description:
          "Return locator-oriented metadata for elements at a screenshot coordinate (Codex playwright.elementInfo).",
        args: {
          x: schema.number(),
          y: schema.number(),
          includeNonInteractable: schema.boolean().optional(),
          tabId: schema.number().optional(),
        },
        async execute({ x, y, includeNonInteractable, tabId }, ctx) {
          const data = await toolRequest("element_info", {
            x,
            y,
            includeNonInteractable,
            tabId,
          });
          return toolResultText(data, "[]");
        },
      }),

      browser_locator_all: tool({
        description:
          "Resolve locator to a list of element descriptors (Codex locator.all).",
        args: {
          selector: schema.string(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, tabId, timeoutMs, pollMs }, ctx) {
          const data = await toolRequest("locator_all", { selector, tabId, timeoutMs, pollMs });
          return toolResultText(data, "[]");
        },
      }),

      browser_press: tool({
        description:
          "Press a keyboard key while the locator is focused (Codex locator.press).",
        args: {
          selector: schema.string(),
          key: schema.string().optional(),
          keys: schema.array(schema.string()).optional(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, key, keys, index, tabId, timeoutMs, pollMs }, ctx) {
          const data = await toolRequest("press", { selector, key, keys, index, tabId, timeoutMs, pollMs });
          return toolResultText(data, "ok");
        },
      }),

      browser_download_media: tool({
        description:
          "Trigger download for media or file link in the matched element (Codex locator.downloadMedia / dom_cua.downloadMedia).",
        args: {
          selector: schema.string(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, index, tabId, timeoutMs, pollMs }, ctx) {
          const data = await toolRequest("download_media", { selector, index, tabId, timeoutMs, pollMs });
          return toolResultText(data, "ok");
        },
      }),

      browser_mouse_move: tool({
        description:
          "Move the mouse to a viewport coordinate (Codex CUA move).",
        args: {
          x: schema.number(),
          y: schema.number(),
          tabId: schema.number().optional(),
        },
        async execute({ x, y, tabId }, ctx) {
          const data = await toolRequest("mouse_move", { x, y, tabId });
          return toolResultText(data, "ok");
        },
      }),

      browser_mouse_click: tool({
        description:
          "Click at a coordinate in the current viewport (Codex CUA click).",
        args: {
          x: schema.number(),
          y: schema.number(),
          button: schema.number().optional(),
          keypress: schema.array(schema.string()).optional(),
          tabId: schema.number().optional(),
        },
        async execute({ x, y, button, keypress, tabId }, ctx) {
          const data = await toolRequest("mouse_click", { x, y, button, keypress, tabId });
          return toolResultText(data, "ok");
        },
      }),

      browser_mouse_dblclick: tool({
        description:
          "Double click at a coordinate in the current viewport (Codex CUA double_click).",
        args: {
          x: schema.number(),
          y: schema.number(),
          keypress: schema.array(schema.string()).optional(),
          tabId: schema.number().optional(),
        },
        async execute({ x, y, keypress, tabId }, ctx) {
          const data = await toolRequest("mouse_dblclick", { x, y, keypress, tabId });
          return toolResultText(data, "ok");
        },
      }),

      browser_drag: tool({
        description:
          "Drag from point to point by the provided path (Codex CUA drag).",
        args: {
          path: schema.array(schema.any()),
          keys: schema.array(schema.string()).optional(),
          tabId: schema.number().optional(),
        },
        async execute({ path, keys, tabId }, ctx) {
          const data = await toolRequest("drag", { path, keys, tabId });
          return toolResultText(data, "ok");
        },
      }),

      browser_get_visible_dom: tool({
        description:
          "Return filtered visible DOM with node ids for interactable elements (Codex dom_cua.get_visible_dom).",
        args: {
          tabId: schema.number().optional(),
          limit: schema.number().optional(),
        },
        async execute({ tabId, limit }, ctx) {
          const data = await toolRequest("get_visible_dom", { tabId, limit });
          return toolResultText(data, "[]");
        },
      }),

      browser_element_screenshot: tool({
        description:
          "Capture element-oriented metadata at coordinate (Codex playwright.elementScreenshot). " +
          "Returns bounds/probed point; combine with browser_screenshot for visual.",
        args: {
          x: schema.number(),
          y: schema.number(),
          includeNonInteractable: schema.boolean().optional(),
          tabId: schema.number().optional(),
        },
        async execute({ x, y, includeNonInteractable, tabId }, ctx) {
          const data = await toolRequest("element_screenshot", {
            x,
            y,
            includeNonInteractable,
            tabId,
          });
          return toolResultText(data, "[]");
        },
      }),

      browser_capabilities_list: tool({
        description:
          "List browser/tab capabilities advertised by this backend (Codex browser.capabilities.list). " +
          "Only use capability IDs returned here; check supported flags.",
        args: {},
        async execute(_args, ctx) {
          const data = await toolRequest("capabilities_list", {});
          return toolResultText(data, "[]");
        },
      }),

      browser_viewport_set: tool({
        description:
          "Apply browser viewport override (Codex viewport capability set). " +
          "Only when user asks for specific dimensions / responsive testing. Call browser_viewport_reset before finish unless asked to keep.",
        args: {
          width: schema.number(),
          height: schema.number(),
          tabId: schema.number().optional(),
        },
        async execute({ width, height, tabId }, ctx) {
          const data = await toolRequest("viewport_set", { width, height, tabId });
          return toolResultText(data, "ok");
        },
      }),

      browser_viewport_reset: tool({
        description: "Clear explicit viewport override (Codex viewport capability reset).",
        args: {
          tabId: schema.number().optional(),
        },
        async execute({ tabId }, ctx) {
          const data = await toolRequest("viewport_reset", { tabId });
          return toolResultText(data, "ok");
        },
      }),

      browser_snapshot: tool({
        description:
          "Get a page snapshot with uid-stamped nodes (data-opc-uid). Use returned uid values as " +
          "selector uid:eN for strict actions. Nodes include role, name, tag, visible, and form state.",
        args: {
          tabId: schema.number().optional(),
        },
        async execute({ tabId }, ctx) {
          const data = await toolRequest("snapshot", { tabId });
          return toolResultText(data, "Snapshot failed");
        },
      }),

      browser_scroll: tool({
        description: "Scroll the page or scroll an element into view",
        args: {
          selector: schema.string().optional(),
          x: schema.number().optional(),
          y: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, x, y, tabId, timeoutMs, pollMs }, ctx) {
          const data = await toolRequest("scroll", { selector, x, y, tabId, timeoutMs, pollMs });
          return toolResultText(data, "Scrolled");
        },
      }),

      browser_wait: tool({
        description: "Wait for a specified duration",
        args: {
          ms: schema.number().optional(),
          tabId: schema.number().optional(),
        },
        async execute({ ms, tabId }, ctx) {
          const data = await toolRequest("wait", { ms, tabId });
          return toolResultText(data, "Waited");
        },
      }),

      browser_query: tool({
        description:
          "Read data from the page using selectors, optional wait, or page_text extraction (shadow DOM + same-origin iframes).",
        args: {
          selector: schema.string().optional(),
          mode: schema.string().optional(),
          attribute: schema.string().optional(),
          property: schema.string().optional(),
          index: schema.number().optional(),
          limit: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
          pattern: schema.string().optional(),
          flags: schema.string().optional(),
          tabId: schema.number().optional(),
        },
        async execute({ selector, mode, attribute, property, index, limit, timeoutMs, pollMs, pattern, flags, tabId }, ctx) {
          const data = await toolRequest("query", {
            selector,
            mode,
            attribute,
            property,
            index,
            limit,
            timeoutMs,
            pollMs,
            pattern,
            flags,
            tabId,
          });
          return toolResultText(data, "Query failed");
        },
      }),

      browser_download: tool({
        description: "Download a file via URL or by clicking an element on the page.",
        args: {
          url: schema.string().optional(),
          selector: schema.string().optional(),
          filename: schema.string().optional(),
          conflictAction: schema.string().optional(),
          saveAs: schema.boolean().optional(),
          wait: schema.boolean().optional(),
          downloadTimeoutMs: schema.number().optional(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute(
          { url, selector, filename, conflictAction, saveAs, wait, downloadTimeoutMs, index, tabId, timeoutMs, pollMs },
          ctx
        ) {
          const data = await toolRequest("download", {
            url,
            selector,
            filename,
            conflictAction,
            saveAs,
            wait,
            downloadTimeoutMs,
            index,
            tabId,
            timeoutMs,
            pollMs,
          });
          return toolResultText(data, "Download started");
        },
      }),

      browser_list_downloads: tool({
        description: "List recent downloads (Chrome backend) or session downloads (agent backend).",
        args: {
          limit: schema.number().optional(),
          state: schema.string().optional(),
        },
        async execute({ limit, state }, ctx) {
          const data = await toolRequest("list_downloads", { limit, state });
          return toolResultText(data, "[]");
        },
      }),

      browser_history: tool({
        description:
          "List recent browsing history ordered by dateVisited descending (Codex browser.user.history). " +
          "High-sensitivity: call only when necessary for the request, never speculatively; " +
          "prefer one focused call with date bounds and a small known set of queries.",
        args: {
          queries: schema.string().optional(),
          from: schema.string().optional(),
          to: schema.string().optional(),
          limit: schema.number().optional(),
        },
        async execute({ queries, from, to, limit }, ctx) {
          let queryList: string[] | undefined;
          if (typeof queries === "string" && queries.trim()) {
            try {
              const parsed = JSON.parse(queries);
              if (Array.isArray(parsed)) {
                queryList = parsed.map((q) => String(q));
              } else {
                queryList = [queries.trim()];
              }
            } catch {
              queryList = [queries.trim()];
            }
          }
          const data = await toolRequest("history", {
            queries: queryList,
            from,
            to,
            limit,
          });
          return toolResultText(data, "[]");
        },
      }),

      browser_set_file_input: tool({
        description:
          "HIGH SENSITIVITY: reads a local file and uploads it into a web page. " +
          "Set a file input's selected file via local path. selector supports locators (uid:/…); " +
          "omit index for strict unique match. " +
          "File reads are restricted: by default only files under the current workspace " +
          "(process.cwd()) and the OS temp dir are allowed; extra roots can be added via the " +
          "OPENCODE_BROWSER_UPLOAD_DIRS env var (OS PATH-delimited absolute dirs: ';' on Windows, " +
          "':' on macOS/Linux). Credential " +
          "locations (~/.ssh, ~/.aws, ~/.gnupg, ~/.config/opencode, ~/.opencode-browser, " +
          "~/Library/Keychains), .env files, and key files (id_rsa, id_ed25519, *.pem, *.key) " +
          "are always refused. Only upload files the user explicitly asked to upload.",
        args: {
          selector: schema.string(),
          filePath: schema.string(),
          fileName: schema.string().optional(),
          mimeType: schema.string().optional(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, filePath, fileName, mimeType, index, tabId, timeoutMs, pollMs }, ctx) {
          if (USE_AGENT_BACKEND) {
            // Enforce the same upload boundary before handing the path to the agent backend.
            const allowedPath = assertUploadAllowed(resolveUploadPath(filePath));
            const data = await toolRequest("set_file_input", {
              selector,
              filePath: allowedPath,
              tabId,
              index,
              timeoutMs,
              pollMs,
            });
            return toolResultText(data, "Set file input");
          }

          const file = buildFileUploadPayload(filePath, fileName, mimeType);
          const data = await toolRequest("set_file_input", {
            selector,
            tabId,
            index,
            timeoutMs,
            pollMs,
            files: [file],
          });
          return toolResultText(data, "Set file input");
        },
      }),

      browser_highlight: tool({
        description:
          "Highlight an element with a colored border. selector supports locators (uid:/role:/…); " +
          "omit index for strict unique match.",
        args: {
          selector: schema.string(),
          index: schema.number().optional(),
          duration: schema.number().optional(),
          color: schema.string().optional(),
          showInfo: schema.boolean().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, index, duration, color, showInfo, tabId, timeoutMs, pollMs }, ctx) {
          const data = await toolRequest("highlight", {
            selector,
            index,
            duration,
            color,
            showInfo,
            tabId,
            timeoutMs,
            pollMs,
          });
          return toolResultText(data, "Highlight failed");
        },
      }),

      browser_console: tool({
        description:
          "Read console log messages from the page. Uses chrome.debugger API for complete capture. " +
          "The debugger attaches lazily on first call and may show a banner in the browser.",
        args: {
          tabId: schema.number().optional(),
          clear: schema.boolean().optional(),
          filter: schema.string().optional(),
        },
        async execute({ tabId, clear, filter }, ctx) {
          const data = await toolRequest("console", { tabId, clear, filter });
          return toolResultText(data, "[]");
        },
      }),

      browser_errors: tool({
        description:
          "Read JavaScript errors from the page. Uses chrome.debugger API for complete capture. " +
          "The debugger attaches lazily on first call and may show a banner in the browser.",
        args: {
          tabId: schema.number().optional(),
          clear: schema.boolean().optional(),
        },
        async execute({ tabId, clear }, ctx) {
          const data = await toolRequest("errors", { tabId, clear });
          return toolResultText(data, "[]");
        },
      }),
    },
  };
};

export default plugin;
