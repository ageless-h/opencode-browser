import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { createConnection, createServer } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "child_process";
import { createHmac } from "crypto";

const repoRoot = join(import.meta.dir, "..");
const tempDirs: string[] = [];
const children: ReturnType<typeof spawn>[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-browser-process-test-"));
  tempDirs.push(dir);
  return dir;
}

function waitForOutput(
  child: ReturnType<typeof spawn>,
  stream: "stdout" | "stderr",
  pattern: RegExp
): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const source = child[stream];
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${pattern}`)), 5000);
    source?.on("data", (chunk) => {
      output += chunk.toString();
      if (!pattern.test(output)) return;
      clearTimeout(timer);
      resolve(output);
    });
    child.once("exit", (code) => {
      if (!pattern.test(output)) {
        clearTimeout(timer);
        reject(new Error(`Process exited ${code}: ${output}`));
      }
    });
  });
}

async function connectSocket(path: string) {
  return await new Promise<ReturnType<typeof createConnection>>((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function request(socket: ReturnType<typeof createConnection>, message: unknown) {
  return await new Promise<any>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("Timed out waiting for response")), 3000);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      clearTimeout(timer);
      socket.off("data", onData);
      resolve(JSON.parse(buffer.slice(0, newline)));
    };
    socket.on("data", onData);
    socket.write(JSON.stringify(message) + "\n");
  });
}

async function readLine(socket: ReturnType<typeof createConnection>) {
  return await new Promise<any>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("Timed out waiting for line")), 3000);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      clearTimeout(timer);
      socket.off("data", onData);
      resolve(JSON.parse(buffer.slice(0, newline)));
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGTERM");
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("broker keeps a replacement connection's session state", async () => {
  const dir = makeTempDir();
  const socketPath = join(dir, "broker.sock");
  const child = spawn(process.execPath, [join(repoRoot, "bin", "broker.cjs")], {
    cwd: repoRoot,
    env: { ...process.env, OPENCODE_BROWSER_BROKER_SOCKET: socketPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  await waitForOutput(child, "stderr", /listening/);

  const first = await connectSocket(socketPath);
  const replacement = await connectSocket(socketPath);
  first.write(JSON.stringify({ type: "hello", role: "plugin", sessionId: "same-session" }) + "\n");
  replacement.write(
    JSON.stringify({ type: "hello", role: "plugin", sessionId: "same-session" }) + "\n"
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  first.end();
  await new Promise((resolve) => setTimeout(resolve, 50));

  const response = await request(replacement, {
    type: "request",
    id: 1,
    op: "status",
  });
  expect(response.ok).toBeTrue();
  expect(response.data.session.sessionId).toBe("same-session");
  replacement.end();
});

test("agent gateway refuses remote binding without a strong token", async () => {
  const child = spawn(process.execPath, [join(repoRoot, "bin", "agent-gateway.cjs")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      OPENCODE_BROWSER_AGENT_GATEWAY_HOST: "0.0.0.0",
      OPENCODE_BROWSER_AGENT_GATEWAY_TOKEN: "",
      OPENCODE_BROWSER_AGENT_AUTOSTART: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = await waitForOutput(child, "stderr", /Refusing non-loopback listen/);
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  expect(code).toBe(1);
  expect(output).toContain("minimum 32 characters");
});

test("agent gateway rejects a bad HMAC and forwards an authenticated connection", async () => {
  const dir = makeTempDir();
  const upstreamPath = join(dir, "agent.sock");
  let upstreamConnections = 0;
  const upstream = createServer((socket) => {
    upstreamConnections++;
    socket.on("data", (chunk) => socket.write(chunk));
  });
  await new Promise<void>((resolve) => upstream.listen(upstreamPath, resolve));

  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("Missing TCP address");
  const port = address.port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));

  const token = "gateway-test-token-".padEnd(32, "x");
  const child = spawn(process.execPath, [join(repoRoot, "bin", "agent-gateway.cjs")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      OPENCODE_BROWSER_AGENT_GATEWAY_HOST: "127.0.0.1",
      OPENCODE_BROWSER_AGENT_GATEWAY_PORT: String(port),
      OPENCODE_BROWSER_AGENT_GATEWAY_TOKEN: token,
      OPENCODE_BROWSER_AGENT_SOCKET: upstreamPath,
      OPENCODE_BROWSER_AGENT_AUTOSTART: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  await waitForOutput(child, "stdout", /Listening/);

  const rejected = createConnection({ host: "127.0.0.1", port });
  await new Promise<void>((resolve, reject) => {
    rejected.once("connect", resolve);
    rejected.once("error", reject);
  });
  const badChallenge = await readLine(rejected);
  rejected.write(JSON.stringify({ type: "auth", hmac: "wrong" }) + "\n");
  await new Promise<void>((resolve) => rejected.once("close", () => resolve()));
  expect(badChallenge.type).toBe("auth_challenge");
  expect(upstreamConnections).toBe(0);

  const accepted = createConnection({ host: "127.0.0.1", port });
  await new Promise<void>((resolve, reject) => {
    accepted.once("connect", resolve);
    accepted.once("error", reject);
  });
  const challenge = await readLine(accepted);
  const hmac = createHmac("sha256", token).update(challenge.nonce).digest("base64url");
  accepted.write(JSON.stringify({ type: "auth", hmac }) + "\n");
  await new Promise((resolve) => setTimeout(resolve, 25));
  accepted.write(JSON.stringify({ id: "request-1", action: "ping" }) + "\n");
  const echoed = await readLine(accepted);
  expect(echoed).toEqual({ id: "request-1", action: "ping" });
  expect(upstreamConnections).toBe(1);
  accepted.end();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

test("agent-install preserves argv boundaries instead of invoking a shell", async () => {
  if (process.platform === "win32") return;
  const dir = makeTempDir();
  const capturePath = join(dir, "argv.json");
  const fakeNpx = join(dir, "npx");
  writeFileSync(
    fakeNpx,
    `#!${process.execPath}\nrequire("fs").writeFileSync(process.env.CAPTURE_PATH, JSON.stringify(process.argv.slice(2)))\n`
  );
  chmodSync(fakeNpx, 0o755);
  const marker = join(dir, "should-not-exist");
  const maliciousArg = `x; touch ${marker}`;
  const child = spawn(
    process.execPath,
    [join(repoRoot, "bin", "cli.js"), "agent-install", maliciousArg],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH || ""}`,
        CAPTURE_PATH: capturePath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  expect(code).toBe(0);
  expect(JSON.parse(readFileSync(capturePath, "utf8"))).toEqual([
    "agent-browser",
    "install",
    maliciousArg,
  ]);
  expect(() => readFileSync(marker)).toThrow();
});
