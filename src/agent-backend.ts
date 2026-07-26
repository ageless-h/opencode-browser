import net from "net";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "fs";
import { homedir, tmpdir } from "os";
import { basename, dirname, isAbsolute, join, relative, resolve, win32 } from "path";
import { spawn } from "child_process";
import { createRequire } from "module";
import { createHmac } from "crypto";

type AgentResponse =
  | { id: string; success: true; data: any }
  | { id: string; success: false; error: string };

type AgentConnectionInfo =
  | { type: "unix"; path: string }
  | { type: "tcp"; host: string; port: number };

type PendingRequest = {
  socket: net.Socket;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type AgentTabSnapshot = {
  index: number;
  url: string;
  title: string;
  active: boolean;
};

type StableAgentTab = AgentTabSnapshot & {
  id: number;
};

const agentRequire = createRequire(import.meta.url);
const REQUEST_TIMEOUT_MS = 60000;
const DEFAULT_PAGE_TEXT_LIMIT = 20000;
const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_POLL_MS = 200;

const BASE_DIR = join(homedir(), ".opencode-browser");
const DEFAULT_DOWNLOADS_DIR = join(BASE_DIR, "downloads");

export type AgentBackend = {
  mode: "agent";
  session: string;
  connection: AgentConnectionInfo;
  getVersion: () => string | null;
  status: () => Promise<any>;
  requestTool: (tool: string, args: Record<string, any>) => Promise<any>;
};

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

async function authenticateAgentGateway(socket: net.Socket, token: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for agent gateway authentication challenge"));
    }, 5000);

    function cleanup(): void {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("error", onError);
    }

    function onClose(): void {
      cleanup();
      reject(new Error("Agent gateway closed before authentication"));
    }

    function onError(error: Error): void {
      cleanup();
      reject(error);
    }

    function onData(chunk: Buffer): void {
      buffer += chunk.toString("utf8");
      if (buffer.length > 8192) {
        cleanup();
        reject(new Error("Agent gateway authentication challenge is too large"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      let message: any;
      try {
        message = JSON.parse(buffer.slice(0, newline));
      } catch {
        cleanup();
        reject(new Error("Invalid agent gateway authentication challenge"));
        return;
      }
      if (message?.type !== "auth_challenge" || typeof message.nonce !== "string") {
        cleanup();
        reject(new Error("Agent gateway did not provide an authentication challenge"));
        return;
      }
      const hmac = createHmac("sha256", token)
        .update(message.nonce)
        .digest("base64url");
      writeJsonLine(socket, { type: "auth", hmac });
      cleanup();
      resolve();
    }

    socket.on("data", onData);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

async function sleep(ms: number): Promise<void> {
  return await new Promise((resolve) => setTimeout(resolve, ms));
}

function parseEnvNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getAgentSession(sessionId: string): string {
  const override = process.env.OPENCODE_BROWSER_AGENT_SESSION?.trim();
  if (override) return override;
  return `opencode-${sessionId}`;
}

function getAgentPortForSession(session: string): number {
  let hash = 0;
  for (let i = 0; i < session.length; i++) {
    hash = (hash << 5) - hash + session.charCodeAt(i);
    hash |= 0;
  }
  return 49152 + (Math.abs(hash) % 16383);
}

function getAgentConnectionInfo(session: string): AgentConnectionInfo {
  const socketOverride = process.env.OPENCODE_BROWSER_AGENT_SOCKET?.trim();
  if (socketOverride) {
    return { type: "unix", path: socketOverride };
  }

  const hostOverride = process.env.OPENCODE_BROWSER_AGENT_HOST?.trim();
  const portOverride = parseEnvNumber(process.env.OPENCODE_BROWSER_AGENT_PORT);
  const transportOverride = process.env.OPENCODE_BROWSER_AGENT_TRANSPORT?.toLowerCase();
  const forceTcp = transportOverride === "tcp" || process.env.OPENCODE_BROWSER_AGENT_TCP === "1";

  if (hostOverride || portOverride !== null || forceTcp || process.platform === "win32") {
    const host = hostOverride || "127.0.0.1";
    const port = portOverride ?? getAgentPortForSession(session);
    return { type: "tcp", host, port };
  }

  return { type: "unix", path: join(tmpdir(), `agent-browser-${session}.sock`) };
}

function isLocalHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function isPathWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function nearestExistingAncestor(pathValue: string): string {
  let current = pathValue;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

export function resolveAgentDownloadPath(
  downloadsDir: string,
  filename?: string,
  urlValue?: string
): string {
  let name = typeof filename === "string" ? filename.trim() : "";
  if (!name && typeof urlValue === "string") {
    try {
      const u = new URL(urlValue);
      name = basename(u.pathname) || "";
    } catch {
      // ignore invalid URL and use a generated name below
    }
  }
  if (!name) name = `download-${Date.now()}`;
  if (name.includes("\0")) throw new Error("Download filename contains a null byte");
  if (isAbsolute(name) || win32.isAbsolute(name)) {
    throw new Error("Download filename must be relative to the configured downloads directory");
  }

  const root = realpathSync(downloadsDir);
  const fullPath = resolve(root, name);
  if (!isPathWithin(root, fullPath)) {
    throw new Error("Download filename escapes the configured downloads directory");
  }

  const existingAncestor = nearestExistingAncestor(dirname(fullPath));
  const realAncestor = realpathSync(existingAncestor);
  if (!isPathWithin(root, realAncestor)) {
    throw new Error("Download filename escapes the downloads directory through a symbolic link");
  }
  if (existsSync(fullPath) && lstatSync(fullPath).isSymbolicLink()) {
    throw new Error("Refusing to overwrite a symbolic-link download target");
  }

  mkdirSync(dirname(fullPath), { recursive: true });
  const realParent = realpathSync(dirname(fullPath));
  if (!isPathWithin(root, realParent)) {
    throw new Error("Download target parent escapes the configured downloads directory");
  }
  return fullPath;
}

function resolveAgentDaemonPath(): string | null {
  const override = process.env.OPENCODE_BROWSER_AGENT_DAEMON?.trim();
  if (override) return override;
  try {
    return agentRequire.resolve("agent-browser/dist/daemon.js");
  } catch {
    return null;
  }
}

function resolveAgentNodePath(): string {
  const override = process.env.OPENCODE_BROWSER_AGENT_NODE?.trim();
  return override || process.execPath;
}

export function getAgentPackageVersion(): string | null {
  try {
    const pkgPath = agentRequire.resolve("agent-browser/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return typeof pkg?.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

function shouldAutoStartAgent(connection: AgentConnectionInfo): boolean {
  const autoStart = process.env.OPENCODE_BROWSER_AGENT_AUTOSTART?.toLowerCase();
  if (autoStart && ["0", "false", "no"].includes(autoStart)) return false;
  if (connection.type === "unix") return true;
  return connection.type === "tcp" && process.platform === "win32" && isLocalHost(connection.host);
}

async function maybeStartAgentDaemon(connection: AgentConnectionInfo, session: string): Promise<void> {
  if (!shouldAutoStartAgent(connection)) return;
  const daemonPath = resolveAgentDaemonPath();
  if (!daemonPath) {
    throw new Error(
      "agent-browser dependency not found. Install agent-browser or set OPENCODE_BROWSER_AGENT_DAEMON."
    );
  }
  try {
    const child = spawn(resolveAgentNodePath(), [daemonPath], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        AGENT_BROWSER_SESSION: session,
        AGENT_BROWSER_DAEMON: "1",
      },
    });
    child.unref();
  } catch {
    // ignore
  }
}

function buildEvalScript(body: string): string {
  return `(() => { ${body} })()`;
}

function buildAgentTypeScript(selector: string, indexValue: number, text: string, clear: boolean): string {
  const payload = { selector, index: indexValue, text, clear };
  return buildEvalScript(`
    const payload = ${JSON.stringify(payload)};
    let matches = [];
    try {
      matches = Array.from(document.querySelectorAll(payload.selector));
    } catch {
      return { ok: false, error: "Invalid selector" };
    }
    const element = matches[payload.index];
    if (!element) return { ok: false, error: "Element not found" };
    const tag = element.tagName ? element.tagName.toUpperCase() : "";
    if (tag === "INPUT" || tag === "TEXTAREA") {
      if (payload.clear) element.value = "";
      element.value = (element.value || "") + payload.text;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    }
    if (element.isContentEditable) {
      if (payload.clear) element.textContent = "";
      element.textContent = (element.textContent || "") + payload.text;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      return { ok: true };
    }
    return { ok: false, error: "Element is not typable" };
  `);
}

function buildAgentSelectScript(
  selector: string,
  indexValue: number,
  value: string | undefined,
  label: string | undefined,
  optionIndex: number | undefined
): string {
  const payload = {
    selector,
    index: indexValue,
    value: value ?? null,
    label: label ?? null,
    optionIndex: Number.isFinite(optionIndex) ? optionIndex : null,
  };
  return buildEvalScript(`
    const payload = ${JSON.stringify(payload)};
    let matches = [];
    try {
      matches = Array.from(document.querySelectorAll(payload.selector));
    } catch {
      return { ok: false, error: "Invalid selector" };
    }
    const element = matches[payload.index];
    if (!element) return { ok: false, error: "Element not found" };
    if (!element.tagName || element.tagName.toUpperCase() !== "SELECT") {
      return { ok: false, error: "Element is not a select" };
    }
    const options = Array.from(element.options || []);
    let chosen = null;
    if (payload.value !== null) {
      chosen = options.find((option) => option.value === payload.value) || null;
    }
    if (!chosen && payload.label !== null) {
      const target = payload.label.trim();
      chosen = options.find((option) => (option.label || option.textContent || "").trim() === target) || null;
    }
    if (!chosen && payload.optionIndex !== null) {
      chosen = options[payload.optionIndex] || null;
    }
    if (!chosen) return { ok: false, error: "Option not found" };
    element.value = chosen.value;
    chosen.selected = true;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return {
      ok: true,
      value: element.value,
      label: (chosen.label || chosen.textContent || "").trim(),
    };
  `);
}

function buildAgentPageTextScript(limit: number, pattern: string | null, flags: string): string {
  const payload = { limit, pattern, flags };
  return buildEvalScript(`
    const payload = ${JSON.stringify(payload)};
    const safeString = (value) => (typeof value === "string" ? value : "");
    const sensitiveName = /passw|pwd|token|secret|api[-_]?key|otp|csrf|session/i;
    const isSensitiveField = (element) => {
      if (!element || !element.tagName) return false;
      const type = safeString(element.getAttribute && element.getAttribute("type")).toLowerCase();
      if (type === "password" || type === "hidden") return true;
      const autocomplete = safeString(
        element.getAttribute && element.getAttribute("autocomplete")
      ).toLowerCase();
      if (["current-password", "new-password", "one-time-code"].includes(autocomplete)) {
        return true;
      }
      const nameId =
        safeString(element.getAttribute && element.getAttribute("name")) +
        " " +
        safeString(element.id);
      return sensitiveName.test(nameId);
    };
    const bodyText = safeString(document.body ? document.body.innerText : "");
    const inputText = Array.from(
      document.querySelectorAll("input, textarea, select, [contenteditable='true']")
    )
      .map((element) => {
        if (
          element.tagName === "INPUT" ||
          element.tagName === "TEXTAREA" ||
          element.tagName === "SELECT"
        ) {
          if (isSensitiveField(element)) return "[REDACTED]";
          return safeString(element.value);
        }
        if (isSensitiveField(element)) return "[REDACTED]";
        return safeString(element.textContent);
      })
      .filter(Boolean)
      .join("\\n");
    const combined = [bodyText, inputText].filter(Boolean).join("\\n\\n");
    const maxSize = Number.isFinite(payload.limit) ? payload.limit : ${DEFAULT_PAGE_TEXT_LIMIT};
    const text = combined.slice(0, Math.max(0, maxSize));
    let matches = [];
    if (payload.pattern) {
      try {
        const re = new RegExp(payload.pattern, payload.flags || "i");
        let match;
        while ((match = re.exec(text)) && matches.length < 50) {
          matches.push(match[0]);
          if (!re.global) break;
        }
      } catch {
        matches = [];
      }
    }
    return {
      url: location.href,
      title: document.title,
      text,
      matches,
    };
  `);
}

function buildAgentSensitiveValuesScript(): string {
  return buildEvalScript(`
    const safeString = (value) => (typeof value === "string" ? value : "");
    const sensitiveName = /passw|pwd|token|secret|api[-_]?key|otp|csrf|session/i;
    const isSensitiveField = (element) => {
      if (!element || !element.tagName) return false;
      const type = safeString(element.getAttribute && element.getAttribute("type")).toLowerCase();
      if (type === "password" || type === "hidden") return true;
      const autocomplete = safeString(
        element.getAttribute && element.getAttribute("autocomplete")
      ).toLowerCase();
      if (["current-password", "new-password", "one-time-code"].includes(autocomplete)) {
        return true;
      }
      const nameId =
        safeString(element.getAttribute && element.getAttribute("name")) +
        " " +
        safeString(element.id);
      return sensitiveName.test(nameId);
    };
    const values = [];
    for (const element of document.querySelectorAll("input, textarea, select")) {
      if (!isSensitiveField(element)) continue;
      const candidates = [
        element.value,
        element.getAttribute && element.getAttribute("value"),
      ];
      if (element.tagName === "TEXTAREA") candidates.push(element.textContent);
      if (element.tagName === "SELECT") {
        for (const option of element.options || []) {
          if (option.selected) candidates.push(option.value, option.textContent);
        }
      }
      for (const candidate of candidates) {
        const value = safeString(candidate);
        if (value) values.push(value);
      }
    }
    return Array.from(new Set(values));
  `);
}

function redactSensitiveValues(value: any, sensitiveValues: string[]): any {
  const values = [...new Set(sensitiveValues.filter(Boolean))].sort(
    (left, right) => right.length - left.length
  );

  if (typeof value === "string") {
    let redacted = value;
    for (const secret of values) {
      if (secret.length < 3) {
        if (redacted === secret) {
          redacted = "[REDACTED]";
          continue;
        }
        redacted = redacted
          .split(`"${secret}"`)
          .join('"[REDACTED]"')
          .split(`'${secret}'`)
          .join("'[REDACTED]'");
        continue;
      }
      redacted = redacted.split(secret).join("[REDACTED]");
    }
    return redacted;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveValues(item, values));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactSensitiveValues(item, values),
      ])
    );
  }
  return value;
}

function buildAgentListScript(selector: string, limit: number): string {
  const payload = { selector, limit };
  return buildEvalScript(`
    const payload = ${JSON.stringify(payload)};
    let nodes = [];
    try {
      nodes = Array.from(document.querySelectorAll(payload.selector));
    } catch {
      return { ok: false, error: "Invalid selector" };
    }
    const maxItems = Math.min(Math.max(1, payload.limit || ${DEFAULT_LIST_LIMIT}), 200);
    const items = nodes.slice(0, maxItems).map((element) => ({
      text: (element.innerText || element.textContent || "").trim().slice(0, 200),
      tag: (element.tagName || "").toLowerCase(),
      ariaLabel: element.getAttribute ? element.getAttribute("aria-label") : null,
    }));
    return { ok: true, value: { items, count: nodes.length } };
  `);
}

function buildAgentNthValueScript(selector: string, indexValue: number): string {
  const payload = { selector, index: indexValue };
  return buildEvalScript(`
    const payload = ${JSON.stringify(payload)};
    let nodes = [];
    try {
      nodes = Array.from(document.querySelectorAll(payload.selector));
    } catch {
      return { ok: false, error: "Invalid selector" };
    }
    const element = nodes[payload.index];
    if (!element) return { ok: false, error: "Element not found" };
    const value = element.value !== undefined ? element.value : "";
    return { ok: true, value: typeof value === "string" ? value : String(value ?? "") };
  `);
}

function buildAgentNthAttributeScript(selector: string, indexValue: number, attribute: string): string {
  const payload = { selector, index: indexValue, attribute };
  return buildEvalScript(`
    const payload = ${JSON.stringify(payload)};
    let nodes = [];
    try {
      nodes = Array.from(document.querySelectorAll(payload.selector));
    } catch {
      return { ok: false, error: "Invalid selector" };
    }
    const element = nodes[payload.index];
    if (!element) return { ok: false, error: "Element not found" };
    const value = element.getAttribute ? element.getAttribute(payload.attribute) : null;
    return { ok: true, value };
  `);
}

function buildAgentNthPropertyScript(selector: string, indexValue: number, property: string): string {
  const payload = { selector, index: indexValue, property };
  return buildEvalScript(`
    const payload = ${JSON.stringify(payload)};
    let nodes = [];
    try {
      nodes = Array.from(document.querySelectorAll(payload.selector));
    } catch {
      return { ok: false, error: "Invalid selector" };
    }
    const element = nodes[payload.index];
    if (!element) return { ok: false, error: "Element not found" };
    return { ok: true, value: element[payload.property] };
  `);
}

function buildAgentOuterHtmlScript(selector: string, indexValue: number): string {
  const payload = { selector, index: indexValue };
  return buildEvalScript(`
    const payload = ${JSON.stringify(payload)};
    let nodes = [];
    try {
      nodes = Array.from(document.querySelectorAll(payload.selector));
    } catch {
      return { ok: false, error: "Invalid selector" };
    }
    const element = nodes[payload.index];
    if (!element) return { ok: false, error: "Element not found" };
    return { ok: true, value: element.outerHTML };
  `);
}

function buildAgentFocusScript(selector: string, indexValue: number): string {
  const payload = { selector, index: indexValue };
  return buildEvalScript(`
    const payload = ${JSON.stringify(payload)};
    let nodes = [];
    try {
      nodes = Array.from(document.querySelectorAll(payload.selector));
    } catch {
      return { ok: false, error: "Invalid selector" };
    }
    const element = nodes[payload.index];
    if (!element) return { ok: false, error: "Element not found" };
    if (typeof element.focus !== "function") return { ok: false, error: "Element is not focusable" };
    element.focus();
    return {
      ok: document.activeElement === element,
      error: document.activeElement === element ? undefined : "Element did not receive focus",
    };
  `);
}

function ensureEvalResult(result: any, fallback: string): any {
  if (!result || typeof result !== "object" || result.ok !== true) {
    const message = typeof result?.error === "string" ? result.error : fallback;
    throw new Error(message);
  }
  return result.value;
}

export type AgentBackendOptions = {
  // Test seam: replace the low-level connection factory. Production uses the
  // real daemon transport derived from the connection info.
  connect?: () => Promise<net.Socket>;
};

export function createAgentBackend(
  sessionId: string,
  options: AgentBackendOptions = {}
): AgentBackend {
  const session = getAgentSession(sessionId);
  const connection = getAgentConnectionInfo(session);

  const downloadsDir = (() => {
    const raw = process.env.OPENCODE_BROWSER_AGENT_DOWNLOADS_DIR?.trim();
    if (!raw) return DEFAULT_DOWNLOADS_DIR;
    return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  })();

  mkdirSync(downloadsDir, { recursive: true });

  const downloads: Array<{ path: string; filename?: string; url?: string; timestamp: string }> = [];

  function resolveDownloadPath(filename?: string, urlValue?: string): string {
    return resolveAgentDownloadPath(downloadsDir, filename, urlValue);
  }

  function recordDownload(entry: { path: string; filename?: string; url?: string }): void {
    downloads.unshift({ ...entry, timestamp: new Date().toISOString() });
    if (downloads.length > 50) downloads.length = 50;
  }

  let agentSocket: net.Socket | null = null;
  let agentConnecting: Promise<net.Socket> | null = null;
  let agentReqId = 0;
  const agentPending = new Map<string, PendingRequest>();
  let tabOperationTail = Promise.resolve();
  let tabRegistryInitialized = false;
  let nextStableTabId = 0;
  const stableTabs = new Map<number, StableAgentTab>();

  async function connectToAgent(): Promise<net.Socket> {
    if (options.connect) return await options.connect();
    return await new Promise((resolve, reject) => {
      const socket =
        connection.type === "unix"
          ? net.createConnection(connection.path)
          : net.createConnection({ host: connection.host, port: connection.port });
      socket.once("connect", async () => {
        const token = process.env.OPENCODE_BROWSER_AGENT_GATEWAY_TOKEN?.trim();
        try {
          if (connection.type === "tcp" && token) {
            await authenticateAgentGateway(socket, token);
          }
          resolve(socket);
        } catch (error) {
          socket.destroy();
          reject(error);
        }
      });
      socket.once("error", (err) => reject(err));
    });
  }

  function rejectSocketPending(socket: net.Socket, reason: string): void {
    for (const [id, pending] of agentPending) {
      if (pending.socket !== socket) continue;
      agentPending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
  }

  function attachAgentSocket(socket: net.Socket): void {
    socket.setNoDelay(true);
    socket.on(
      "data",
      createJsonLineParser((msg) => {
        if (!msg || msg.id === undefined) return;
        const messageId = typeof msg.id === "string" ? msg.id : String(msg.id);
        const pending = agentPending.get(messageId);
        // Ignore responses that arrive on a stale socket generation.
        if (!pending || pending.socket !== socket) return;
        agentPending.delete(messageId);
        clearTimeout(pending.timer);
        const res = msg as AgentResponse;
        if (!res.success) pending.reject(new Error(res.error || "Agent browser error"));
        else pending.resolve(res.data);
      })
    );

    // A close/error event belongs to exactly one socket generation: it must
    // only reject that generation's pending requests and only clear the
    // global reference if it still points at this socket (issue #36).
    socket.on("close", () => {
      rejectSocketPending(socket, "Agent browser connection closed");
      if (agentSocket === socket) agentSocket = null;
    });

    socket.on("error", () => {
      rejectSocketPending(socket, "Agent browser connection error");
      if (agentSocket === socket) agentSocket = null;
    });
  }

  async function openAgentSocket(): Promise<net.Socket> {
    let socket: net.Socket | null = null;
    try {
      socket = await connectToAgent();
    } catch (firstError) {
      if (options.connect) throw firstError;
      await maybeStartAgentDaemon(connection, session);
      for (let attempt = 0; attempt < 20; attempt++) {
        await sleep(100);
        try {
          socket = await connectToAgent();
          break;
        } catch {}
      }
    }

    if (!socket || socket.destroyed) {
      const target =
        connection.type === "unix" ? connection.path : `${connection.host}:${connection.port}`;
      throw new Error(`Could not connect to agent-browser daemon at ${target}.`);
    }

    attachAgentSocket(socket);
    return socket;
  }

  async function ensureAgentSocket(): Promise<net.Socket> {
    if (agentSocket && !agentSocket.destroyed) return agentSocket;

    // Single-flight: concurrent first-connect/reconnect callers share one
    // connection attempt instead of racing to overwrite the global socket
    // (issue #36).
    if (!agentConnecting) {
      agentConnecting = openAgentSocket()
        .then((socket) => {
          agentSocket = socket;
          return socket;
        })
        .finally(() => {
          agentConnecting = null;
        });
    }
    return await agentConnecting;
  }

  async function agentRequest(action: string, payload: Record<string, any>): Promise<any> {
    const socket = await ensureAgentSocket();
    const id = `a${++agentReqId}`;

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!agentPending.has(id)) return;
        agentPending.delete(id);
        reject(new Error("Timed out waiting for agent-browser response"));
      }, REQUEST_TIMEOUT_MS);
      agentPending.set(id, { socket, resolve, reject, timer });
      writeJsonLine(socket, { id, action, ...payload });
    });
  }

  async function agentCommand(action: string, payload: Record<string, any>): Promise<any> {
    return await agentRequest(action, payload);
  }

  async function withTabOperationLock<T>(action: () => Promise<T>): Promise<T> {
    const previous = tabOperationTail;
    let release: () => void = () => {};
    tabOperationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }

  function normalizeAgentTabs(data: any): AgentTabSnapshot[] {
    const tabs = Array.isArray(data?.tabs) ? data.tabs : [];
    return tabs
      .filter((tab: any) => Number.isFinite(tab?.index))
      .map((tab: any) => ({
        index: Number(tab.index),
        url: typeof tab.url === "string" ? tab.url : "",
        title: typeof tab.title === "string" ? tab.title : "",
        active: tab.active === true,
      }))
      .sort((left: AgentTabSnapshot, right: AgentTabSnapshot) => left.index - right.index);
  }

  function tabFingerprint(tab: Pick<AgentTabSnapshot, "url" | "title">): string {
    return `${tab.url}\u0000${tab.title}`;
  }

  function allocateStableTabId(preferred?: number): number {
    if (Number.isFinite(preferred) && !stableTabs.has(Number(preferred))) {
      const id = Number(preferred);
      nextStableTabId = Math.max(nextStableTabId, id + 1);
      return id;
    }
    while (stableTabs.has(nextStableTabId)) nextStableTabId++;
    return nextStableTabId++;
  }

  function initializeTabRegistry(tabs: AgentTabSnapshot[]): void {
    stableTabs.clear();
    for (const tab of tabs) {
      const id = allocateStableTabId(tab.index);
      stableTabs.set(id, { id, ...tab });
    }
    tabRegistryInitialized = true;
  }

  function reconcileUnexpectedTabChange(tabs: AgentTabSnapshot[]): void {
    const previous = [...stableTabs.values()];
    const usedIds = new Set<number>();
    const nextRecords: StableAgentTab[] = [];

    for (const tab of tabs) {
      const fingerprint = tabFingerprint(tab);
      const candidates = previous.filter(
        (record) => !usedIds.has(record.id) && tabFingerprint(record) === fingerprint
      );
      if (candidates.length === 1) {
        const record = candidates[0];
        usedIds.add(record.id);
        nextRecords.push({ id: record.id, ...tab });
      }
    }

    for (const tab of tabs) {
      if (nextRecords.some((record) => record.index === tab.index)) continue;
      const id = allocateStableTabId();
      nextRecords.push({ id, ...tab });
    }

    stableTabs.clear();
    for (const record of nextRecords) stableTabs.set(record.id, record);
  }

  async function refreshTabRegistry(): Promise<{
    tabs: AgentTabSnapshot[];
    active: number | null;
  }> {
    const data = await agentCommand("tab_list", {});
    const tabs = normalizeAgentTabs(data);
    if (!tabRegistryInitialized) {
      initializeTabRegistry(tabs);
    } else if (tabs.length === stableTabs.size) {
      const byIndex = new Map(tabs.map((tab) => [tab.index, tab]));
      for (const record of stableTabs.values()) {
        const current = byIndex.get(record.index);
        if (current) Object.assign(record, current);
      }
    } else {
      // Out-of-band tab creation/closure cannot be identified perfectly by
      // agent-browser 0.4.x. Preserve only uniquely matching fingerprints;
      // ambiguous pages receive fresh ids so stale ids fail closed.
      reconcileUnexpectedTabChange(tabs);
    }
    return {
      tabs,
      active: Number.isFinite(data?.active) ? Number(data.active) : null,
    };
  }

  function recordForUpstreamIndex(index: number): StableAgentTab | undefined {
    return [...stableTabs.values()].find((record) => record.index === index);
  }

  async function resolveStableTab(tabId: number): Promise<StableAgentTab> {
    await refreshTabRegistry();
    const record = stableTabs.get(tabId);
    if (!record) throw new Error(`Unknown or closed tabId: ${tabId}`);
    return record;
  }

  async function withTab<T>(tabId: number | undefined, action: () => Promise<T>): Promise<T> {
    return await withTabOperationLock(async () => {
      if (Number.isFinite(tabId)) {
        const record = await resolveStableTab(Number(tabId));
        await agentCommand("tab_switch", { index: record.index });
      }
      return await action();
    });
  }

  async function agentEvaluate(script: string): Promise<any> {
    const data = await agentCommand("evaluate", { script });
    return data?.result;
  }

  async function waitForCount(
    selector: string,
    minimum: number,
    timeoutMs: number,
    pollMs: number
  ): Promise<number> {
    const timeout = Math.max(0, timeoutMs);
    const poll = Math.max(0, pollMs || DEFAULT_POLL_MS);
    const start = Date.now();

    while (true) {
      const data = await agentCommand("count", { selector });
      const count = Number(data?.count ?? 0);
      if (count >= minimum) return count;
      if (!timeout || Date.now() - start >= timeout) return count;
      await sleep(poll);
    }
  }

  async function agentQuery(args: Record<string, any>): Promise<{ content: string }> {
    const selector = typeof args.selector === "string" ? args.selector : undefined;
    const mode = typeof args.mode === "string" && args.mode ? args.mode : "text";
    const indexValue = Number.isFinite(args.index) ? args.index : 0;
    const limitValue = Number.isFinite(args.limit)
      ? args.limit
      : mode === "page_text"
        ? DEFAULT_PAGE_TEXT_LIMIT
        : DEFAULT_LIST_LIMIT;
    const timeoutValue = Number.isFinite(args.timeoutMs) ? args.timeoutMs : 0;
    const pollValue = Number.isFinite(args.pollMs) ? args.pollMs : DEFAULT_POLL_MS;
    const pattern = typeof args.pattern === "string" ? args.pattern : null;
    const flags = typeof args.flags === "string" ? args.flags : "i";

    if (mode === "page_text") {
      if (selector && timeoutValue > 0) {
        await waitForCount(selector, 1, timeoutValue, pollValue);
      }
      const pageText = await agentEvaluate(buildAgentPageTextScript(limitValue, pattern, flags));
      return { content: JSON.stringify({ ok: true, value: pageText }, null, 2) };
    }

    if (!selector) throw new Error("selector is required");

    if (mode === "exists") {
      const count = await waitForCount(selector, 1, timeoutValue, pollValue);
      return {
        content: JSON.stringify({ ok: true, value: { exists: count > 0, count } }, null, 2),
      };
    }

    const count = await waitForCount(selector, indexValue + 1, timeoutValue, pollValue);
    if (count <= indexValue) {
      throw new Error(`No matches for selector: ${selector}`);
    }

    if (mode === "text") {
      const data =
        indexValue > 0
          ? await agentCommand("nth", { selector, index: indexValue, subaction: "text" })
          : await agentCommand("innertext", { selector });
      return { content: typeof data?.text === "string" ? data.text : "" };
    }

    if (mode === "value") {
      if (indexValue > 0) {
        const result = ensureEvalResult(
          await agentEvaluate(buildAgentNthValueScript(selector, indexValue)),
          "Value lookup failed"
        );
        return { content: typeof result === "string" ? result : JSON.stringify(result) };
      }
      const data = await agentCommand("inputvalue", { selector });
      return { content: typeof data?.value === "string" ? data.value : "" };
    }

    if (mode === "attribute") {
      if (!args.attribute) throw new Error("attribute is required");
      if (indexValue > 0) {
        const result = ensureEvalResult(
          await agentEvaluate(buildAgentNthAttributeScript(selector, indexValue, args.attribute)),
          "Attribute lookup failed"
        );
        return { content: typeof result === "string" ? result : JSON.stringify(result) };
      }
      const data = await agentCommand("getattribute", { selector, attribute: args.attribute });
      return { content: typeof data?.value === "string" ? data.value : JSON.stringify(data?.value) };
    }

    if (mode === "property") {
      if (!args.property) throw new Error("property is required");
      const result = ensureEvalResult(
        await agentEvaluate(buildAgentNthPropertyScript(selector, indexValue, args.property)),
        "Property lookup failed"
      );
      return { content: typeof result === "string" ? result : JSON.stringify(result) };
    }

    if (mode === "html") {
      const result = ensureEvalResult(
        await agentEvaluate(buildAgentOuterHtmlScript(selector, indexValue)),
        "HTML lookup failed"
      );
      return { content: typeof result === "string" ? result : JSON.stringify(result) };
    }

    if (mode === "list") {
      const listResult = ensureEvalResult(
        await agentEvaluate(buildAgentListScript(selector, limitValue)),
        "List lookup failed"
      );
      return { content: JSON.stringify({ ok: true, value: listResult }, null, 2) };
    }

    throw new Error(`Unknown mode: ${mode}`);
  }

  async function requestTool(tool: string, args: Record<string, any>): Promise<any> {
    switch (tool) {
      case "get_tabs": {
        return await withTabOperationLock(async () => {
          const { tabs } = await refreshTabRegistry();
          const mapped = tabs.map((tab) => {
            const record = recordForUpstreamIndex(tab.index);
            return {
              id: record?.id,
              url: tab.url,
              title: tab.title,
              active: tab.active,
              windowId: 0,
            };
          });
          return { content: JSON.stringify(mapped, null, 2) };
        });
      }
      case "list_downloads": {
        return { content: JSON.stringify({ downloads }, null, 2) };
      }
      case "history": {
        return {
          content: JSON.stringify({
            ok: false,
            unsupported: true,
            message:
              "browser_history requires the Chrome extension backend (chrome.history); agent-browser has no user history API",
          }),
        };
      }
      case "clipboard_read_text":
      case "clipboard_write_text":
      case "all_text_contents":
      case "element_info":
      case "capabilities_list":
      case "viewport_set":
      case "viewport_reset":
      case "locator_all":
      case "press":
      case "download_media":
      case "mouse_move":
      case "mouse_click":
      case "mouse_dblclick":
      case "drag":
      case "get_visible_dom":
      case "element_screenshot": {
        return {
          content: JSON.stringify({
            ok: false,
            unsupported: true,
            message: `${tool} requires the Chrome extension backend (Codex P4a/P4b/P5)`,
          }),
        };
      }
      case "count":
      case "is_visible":
      case "is_enabled":
      case "get_attribute":
      case "text_content":
      case "inner_text":
      case "dblclick":
      case "check":
      case "uncheck":
      case "set_checked":
      case "fill":
      case "wait_for":
      case "wait_for_load_state":
      case "wait_for_url":
      case "evaluate":
      case "export":
      case "get_js_dialog":
      case "title":
      case "url": {
        if (tool === "title" || tool === "url") {
          return await withTab(args.tabId, async () => {
            const data = await agentCommand("get_url", {}).catch(() => null);
            if (tool === "url") {
              return { content: String(data?.url || data || "") };
            }
            // best-effort title via evaluate if available
            try {
              const t = await agentCommand("evaluate", { script: "document.title" });
              return { content: String(t?.result ?? t ?? "") };
            } catch {
              return { content: "" };
            }
          });
        }
        if (tool === "fill") {
          return await withTab(args.tabId, async () => {
            if (!args.selector) throw new Error("Selector is required");
            const text = args.text ?? args.value ?? "";
            await agentCommand("fill", { selector: args.selector, text: String(text) }).catch(async () => {
              await agentCommand("type", { selector: args.selector, text: String(text), clear: true });
            });
            return { content: `Filled ${args.selector}` };
          });
        }
        return {
          content: JSON.stringify({
            ok: false,
            unsupported: true,
            message: `${tool} requires the Chrome extension backend (Codex Playwright subset)`,
          }),
        };
      }
      case "open_tab": {
        return await withTabOperationLock(async () => {
          // Default non-stealing: active false unless explicitly true.
          const active = args.active === true;
          const registry = await refreshTabRegistry();
          const previousActive = active ? null : registry.active;
          const created = await agentCommand("tab_new", {});
          if (!Number.isFinite(created?.index)) {
            throw new Error("agent-browser did not return the new tab index");
          }
          const stableId = allocateStableTabId();
          stableTabs.set(stableId, {
            id: stableId,
            index: Number(created.index),
            url: typeof args.url === "string" ? args.url : "about:blank",
            title: "",
            active,
          });
          if (args.url) {
            await agentCommand("navigate", { url: args.url });
          }
          if (!active && previousActive !== null) {
            await agentCommand("tab_switch", { index: previousActive });
          }
          return { content: { tabId: stableId, url: args.url, active } };
        });
      }
      case "name_session": {
        return {
          content: JSON.stringify({
            ok: true,
            unsupported: true,
            message: "name_session/tab groups require the Chrome extension backend",
            name: args.name || args.title || null,
          }),
        };
      }
      case "mark_tab": {
        return {
          content: JSON.stringify({
            ok: true,
            unsupported: true,
            message: "mark_tab requires the Chrome extension backend",
            tabId: args.tabId,
            status: args.status ?? null,
          }),
        };
      }
      case "finalize": {
        return {
          content: JSON.stringify({
            ok: true,
            unsupported: true,
            message: "finalize requires the Chrome extension backend",
          }),
        };
      }
      case "close_tab": {
        return await withTabOperationLock(async () => {
          const registry = await refreshTabRegistry();
          let record: StableAgentTab | undefined;
          if (Number.isFinite(args.tabId)) {
            record = stableTabs.get(Number(args.tabId));
            if (!record) throw new Error(`Unknown or closed tabId: ${args.tabId}`);
          } else if (registry.active !== null) {
            record = recordForUpstreamIndex(registry.active);
          }
          if (!record) throw new Error("Could not resolve the tab to close");

          const result = await agentCommand("tab_close", { index: record.index });
          stableTabs.delete(record.id);
          for (const remaining of stableTabs.values()) {
            if (remaining.index > record.index) remaining.index--;
          }
          return {
            content: {
              tabId: record.id,
              remaining: result?.remaining,
            },
          };
        });
      }
      case "navigate": {
        return await withTab(args.tabId, async () => {
          if (!args.url) throw new Error("URL is required");
          await agentCommand("navigate", { url: args.url });
          return { content: `Navigated to ${args.url}` };
        });
      }
      case "back": {
        return await withTab(args.tabId, async () => {
          await agentCommand("back", {});
          return { content: JSON.stringify({ ok: true, action: "back" }) };
        });
      }
      case "forward": {
        return await withTab(args.tabId, async () => {
          await agentCommand("forward", {});
          return { content: JSON.stringify({ ok: true, action: "forward" }) };
        });
      }
      case "reload": {
        return await withTab(args.tabId, async () => {
          await agentCommand("reload", {});
          return {
            content: JSON.stringify({
              ok: true,
              action: "reload",
              bypassCache: !!args.bypassCache,
            }),
          };
        });
      }
      case "set_active_tab": {
        if (!Number.isFinite(args.tabId)) throw new Error("tabId is required");
        return await withTabOperationLock(async () => {
          const record = await resolveStableTab(Number(args.tabId));
          await agentCommand("tab_switch", { index: record.index });
          return {
            content: JSON.stringify({ ok: true, tabId: record.id, active: true }),
          };
        });
      }
      case "key": {
        return await withTab(args.tabId, async () => {
          if (!args.key) throw new Error("key is required");
          if (args.code !== undefined || args.keyCode !== undefined) {
            throw new Error(
              "agent-browser backend does not support browser_key code/keyCode overrides"
            );
          }
          if (args.repeat === true) {
            throw new Error("agent-browser backend does not support browser_key repeat=true");
          }
          if (Number.isFinite(args.delayMs) && Number(args.delayMs) > 0) {
            throw new Error("agent-browser backend does not support browser_key delayMs");
          }

          const chord = [
            args.ctrlKey ? "Control" : null,
            args.metaKey ? "Meta" : null,
            args.altKey ? "Alt" : null,
            args.shiftKey ? "Shift" : null,
            String(args.key),
          ]
            .filter(Boolean)
            .join("+");

          const command: Record<string, any> = { key: chord };
          if (typeof args.selector === "string" && args.selector) {
            if (Number.isFinite(args.index)) {
              ensureEvalResult(
                await agentEvaluate(buildAgentFocusScript(args.selector, Number(args.index))),
                "Could not focus browser_key target"
              );
            } else {
              command.selector = args.selector;
            }
          }
          await agentCommand("press", command);
          return {
            content: JSON.stringify({
              ok: true,
              key: String(args.key),
              effectiveKey: chord,
              selector: args.selector || null,
              index: Number.isFinite(args.index) ? Number(args.index) : null,
              backend: "agent-browser",
              method: "press",
            }),
          };
        });
      }
      case "handle_dialog": {
        return await withTab(args.tabId, async () => {
          const action = typeof args.action === "string" ? args.action.toLowerCase() : "accept";
          if (action !== "accept" && action !== "dismiss") {
            throw new Error('action must be "accept" or "dismiss"');
          }
          try {
            await agentCommand("dialog", {
              action,
              promptText: args.promptText,
            });
          } catch (err) {
            throw new Error(
              `handle_dialog unsupported or failed on agent-browser backend: ${
                err instanceof Error ? err.message : String(err)
              }`
            );
          }
          return {
            content: JSON.stringify({ ok: true, action }),
          };
        });
      }
      case "download": {
        return await withTab(args.tabId, async () => {
          const url = typeof args.url === "string" ? args.url.trim() : "";
          const selector = typeof args.selector === "string" ? args.selector.trim() : "";
          const filename = typeof args.filename === "string" ? args.filename.trim() : "";
          const waitValue = args.wait === undefined ? false : !!args.wait;
          const timeoutValue = Number.isFinite(args.downloadTimeoutMs) ? args.downloadTimeoutMs : undefined;

          if (!url && !selector) throw new Error("url or selector is required");
          if (url && selector) throw new Error("Provide either url or selector, not both");

          if (!waitValue) {
            if (selector) {
              await agentCommand("click", { selector });
              return { content: JSON.stringify({ ok: true, started: true, selector }, null, 2) };
            }
            await agentCommand("navigate", { url });
            return { content: JSON.stringify({ ok: true, started: true, url }, null, 2) };
          }

          if (selector) {
            const path = resolveDownloadPath(filename || undefined);
            const data = await agentCommand("download", { selector, path });
            const entry = {
              path: String(data?.path || path),
              filename: typeof data?.suggestedFilename === "string" ? data.suggestedFilename : undefined,
              url: url || undefined,
            };
            recordDownload({ path: entry.path, filename: entry.filename, url: entry.url });
            return { content: JSON.stringify({ ok: true, ...entry }, null, 2) };
          }

          const path = resolveDownloadPath(filename || undefined, url);
          await agentCommand("navigate", { url });
          const data = await agentCommand("waitfordownload", { path, timeout: timeoutValue });
          const entry = {
            path: String(data?.path || path),
            filename: typeof data?.filename === "string" ? data.filename : undefined,
            url: typeof data?.url === "string" ? data.url : url,
          };
          recordDownload({ path: entry.path, filename: entry.filename, url: entry.url });
          return { content: JSON.stringify({ ok: true, ...entry }, null, 2) };
        });
      }
      case "click": {
        return await withTab(args.tabId, async () => {
          if (!args.selector) throw new Error("Selector is required");
          const indexValue = Number.isFinite(args.index) ? args.index : 0;
          if (indexValue) {
            await agentCommand("nth", { selector: args.selector, index: indexValue, subaction: "click" });
          } else {
            await agentCommand("click", { selector: args.selector });
          }
          return { content: `Clicked ${args.selector}` };
        });
      }
      case "type": {
        return await withTab(args.tabId, async () => {
          if (!args.selector) throw new Error("Selector is required");
          if (args.text === undefined) throw new Error("Text is required");
          const indexValue = Number.isFinite(args.index) ? args.index : 0;
          if (!indexValue) {
            await agentCommand("type", {
              selector: args.selector,
              text: String(args.text),
              clear: args.clear,
            });
          } else {
            const result = await agentEvaluate(
              buildAgentTypeScript(args.selector, indexValue, String(args.text), !!args.clear)
            );
            if (!result?.ok) {
              throw new Error(result?.error || "Type failed");
            }
          }
          return { content: `Typed "${args.text}" into ${args.selector}` };
        });
      }
      case "select": {
        return await withTab(args.tabId, async () => {
          if (!args.selector) throw new Error("Selector is required");
          if (args.value === undefined && args.label === undefined && args.optionIndex === undefined) {
            throw new Error("value, label, or optionIndex is required");
          }
          const indexValue = Number.isFinite(args.index) ? args.index : 0;
          let selectedValue = args.value;
          let selectedLabel = args.label;
          if (indexValue || args.label !== undefined || args.optionIndex !== undefined) {
            const result = await agentEvaluate(
              buildAgentSelectScript(
                args.selector,
                indexValue,
                args.value,
                args.label,
                args.optionIndex
              )
            );
            if (!result?.ok) {
              throw new Error(result?.error || "Select failed");
            }
            selectedValue = result.value;
            selectedLabel = result.label;
          } else if (args.value !== undefined) {
            await agentCommand("select", { selector: args.selector, values: args.value });
          }
          const valueText = selectedValue ? String(selectedValue) : "";
          const labelText = selectedLabel ? String(selectedLabel) : "";
          const summary =
            labelText && valueText && labelText !== valueText
              ? `${labelText} (${valueText})`
              : labelText || valueText || "option";
          return { content: `Selected ${summary} in ${args.selector}` };
        });
      }
      case "set_file_input": {
        return await withTab(args.tabId, async () => {
          if (!args.selector) throw new Error("Selector is required");
          if (!args.filePath) throw new Error("filePath is required");
          const rawPath = String(args.filePath).trim();
          if (!rawPath) throw new Error("filePath is required");
          const absPath = isAbsolute(rawPath) ? rawPath : resolve(process.cwd(), rawPath);
          const data = await agentCommand("upload", { selector: args.selector, files: absPath });
          return {
            content: JSON.stringify({ ok: true, selector: args.selector, uploaded: data?.uploaded ?? [absPath] }, null, 2),
          };
        });
      }
      case "screenshot": {
        return await withTab(args.tabId, async () => {
          if (args.clip !== undefined && args.clip !== null) {
            throw new Error(
              "agent-browser backend does not support browser_screenshot clip; use the extension backend"
            );
          }
          const data = await agentCommand("screenshot", {
            format: "png",
            fullPage: args.fullPage === true,
          });
          const base64 = data?.base64 ? String(data.base64) : "";
          if (!base64) throw new Error("Screenshot failed");
          return { content: `data:image/png;base64,${base64}` };
        });
      }
      case "snapshot": {
        return await withTab(args.tabId, async () => {
          const data = await agentCommand("snapshot", {});
          const sensitiveValues = await agentEvaluate(buildAgentSensitiveValuesScript());
          if (!Array.isArray(sensitiveValues)) {
            throw new Error("Could not safely redact agent-browser snapshot values");
          }
          const values = sensitiveValues.filter(
            (value): value is string => typeof value === "string"
          );
          const payload = {
            snapshot: redactSensitiveValues(data?.snapshot ?? "", values),
            refs: redactSensitiveValues(data?.refs ?? {}, values),
          };
          return { content: JSON.stringify(payload, null, 2) };
        });
      }
      case "query": {
        return await withTab(args.tabId, async () => {
          return await agentQuery(args);
        });
      }
      case "scroll": {
        return await withTab(args.tabId, async () => {
          const x = Number.isFinite(args.x) ? args.x : 0;
          const y = Number.isFinite(args.y) ? args.y : 0;
          await agentCommand("scroll", {
            selector: args.selector,
            x,
            y,
          });
          const target = args.selector ? `to ${args.selector}` : `by (${x}, ${y})`;
          return { content: `Scrolled ${target}` };
        });
      }
      case "wait": {
        return await withTab(args.tabId, async () => {
          const ms = Number.isFinite(args.ms) ? args.ms : 1000;
          await agentCommand("wait", { timeout: ms });
          return { content: `Waited ${ms}ms` };
        });
      }
      default:
        throw new Error(`Unsupported tool for agent backend: ${tool}`);
    }
  }

  async function status(): Promise<any> {
    let connected = false;
    let error: string | undefined;
    try {
      await ensureAgentSocket();
      connected = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    return {
      backend: "agent-browser",
      session,
      connection,
      connected,
      error,
      agentBrowserVersion: getAgentPackageVersion(),
    };
  }

  return {
    mode: "agent",
    session,
    connection,
    getVersion: getAgentPackageVersion,
    status,
    requestTool,
  };
}
