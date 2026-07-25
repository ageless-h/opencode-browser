#!/usr/bin/env node
"use strict";

const net = require("net");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const session =
  (process.env.OPENCODE_BROWSER_AGENT_SESSION || process.env.AGENT_BROWSER_SESSION || "default").trim();
const socketPath =
  process.env.OPENCODE_BROWSER_AGENT_SOCKET || path.join(os.tmpdir(), `agent-browser-${session}.sock`);

function getPortForSession(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
    hash |= 0;
  }
  return 49152 + (Math.abs(hash) % 16383);
}

const host = process.env.OPENCODE_BROWSER_AGENT_GATEWAY_HOST || process.env.OPENCODE_BROWSER_AGENT_HOST || "127.0.0.1";
const port =
  Number(process.env.OPENCODE_BROWSER_AGENT_GATEWAY_PORT || process.env.OPENCODE_BROWSER_AGENT_PORT) ||
  getPortForSession(session);
const gatewayToken = (process.env.OPENCODE_BROWSER_AGENT_GATEWAY_TOKEN || "").trim();

function isLoopbackHost(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized) ||
    /^::ffff:127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

if (!isLoopbackHost(host) && gatewayToken.length < 32) {
  console.error(
    "[agent-gateway] Refusing non-loopback listen without OPENCODE_BROWSER_AGENT_GATEWAY_TOKEN " +
      "(minimum 32 characters)."
  );
  process.exit(1);
}

function tokensEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ""), "utf8");
  const expectedBuffer = Buffer.from(String(expected || ""), "utf8");
  return (
    actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

async function authenticateClient(client) {
  if (!gatewayToken) return Buffer.alloc(0);

  return await new Promise((resolve, reject) => {
    const nonce = crypto.randomBytes(32).toString("base64url");
    const expectedHmac = crypto
      .createHmac("sha256", gatewayToken)
      .update(nonce)
      .digest("base64url");
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Authentication timed out"));
    }, 5000);

    function cleanup() {
      clearTimeout(timer);
      client.off("data", onData);
      client.off("close", onClose);
      client.off("error", onError);
    }

    function onClose() {
      cleanup();
      reject(new Error("Client disconnected before authentication"));
    }

    function onError(err) {
      cleanup();
      reject(err);
    }

    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 8192) {
        cleanup();
        reject(new Error("Authentication message too large"));
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) return;

      let message;
      try {
        message = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
      } catch {
        cleanup();
        reject(new Error("Invalid authentication message"));
        return;
      }
      if (message?.type !== "auth" || !tokensEqual(message.hmac, expectedHmac)) {
        cleanup();
        reject(new Error("Authentication failed"));
        return;
      }
      const remainder = buffer.subarray(newline + 1);
      client.pause();
      cleanup();
      resolve(remainder);
    }

    client.on("data", onData);
    client.once("close", onClose);
    client.once("error", onError);
    client.write(JSON.stringify({ type: "auth_challenge", nonce }) + "\n");
  });
}

function resolveDaemonPath() {
  const override = process.env.OPENCODE_BROWSER_AGENT_DAEMON;
  if (override) return override;
  try {
    return require.resolve("agent-browser/dist/daemon.js");
  } catch {
    return null;
  }
}

function shouldAutoStart() {
  const autoStart = (process.env.OPENCODE_BROWSER_AGENT_AUTOSTART || "").toLowerCase();
  return !["0", "false", "no"].includes(autoStart);
}

function startDaemon() {
  if (!shouldAutoStart()) return;
  const daemonPath = resolveDaemonPath();
  if (!daemonPath) {
    console.error("[agent-gateway] agent-browser dependency not found.");
    return;
  }
  try {
    const child = spawn(process.execPath, [daemonPath], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        AGENT_BROWSER_SESSION: session,
        AGENT_BROWSER_DAEMON: "1",
      },
    });
    child.unref();
  } catch (err) {
    console.error("[agent-gateway] Failed to start daemon:", err?.message || err);
  }
}

async function sleep(ms) {
  return await new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectAgentSocket() {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", (err) => reject(err));
  });
}

async function createAgentConnection() {
  try {
    return await connectAgentSocket();
  } catch {
    startDaemon();
    for (let attempt = 0; attempt < 20; attempt++) {
      await sleep(100);
      try {
        return await connectAgentSocket();
      } catch {}
    }
    throw new Error(`Could not connect to agent-browser socket at ${socketPath}`);
  }
}

const server = net.createServer(async (client) => {
  let upstream = null;
  try {
    const remainder = await authenticateClient(client);
    if (!gatewayToken) client.pause();
    upstream = await createAgentConnection();
    if (remainder.length) upstream.write(remainder);
  } catch (err) {
    client.end();
    console.error("[agent-gateway] Connection failed:", err?.message || err);
    return;
  }

  client.pipe(upstream);
  upstream.pipe(client);
  client.resume();

  const close = () => {
    try {
      client.destroy();
    } catch {}
    try {
      upstream.destroy();
    } catch {}
  };

  client.on("error", close);
  upstream.on("error", close);
  client.on("close", close);
  upstream.on("close", close);
});

server.on("error", (err) => {
  console.error("[agent-gateway] Server error:", err?.message || err);
  process.exit(1);
});

server.listen(port, host, () => {
  console.log(`[agent-gateway] Listening on ${host}:${port}`);
  console.log(`[agent-gateway] Proxying to ${socketPath}`);
  if (gatewayToken) console.log("[agent-gateway] Token authentication enabled");
});
