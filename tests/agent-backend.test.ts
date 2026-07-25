import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer, type Socket } from "net";
import { createHmac } from "crypto";
import {
  createAgentBackend,
  resolveAgentDownloadPath,
} from "../src/agent-backend";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-browser-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("agent download boundary", () => {
  test("keeps legitimate nested filenames inside the configured root", () => {
    const root = makeTempDir();
    const target = resolveAgentDownloadPath(root, "reports/result.csv");
    expect(target).toBe(join(realpathSync(root), "reports", "result.csv"));
  });

  test("rejects traversal and POSIX/Windows absolute paths", () => {
    const root = makeTempDir();
    expect(() => resolveAgentDownloadPath(root, "../../outside.txt")).toThrow("escapes");
    expect(() => resolveAgentDownloadPath(root, "/tmp/outside.txt")).toThrow("must be relative");
    expect(() => resolveAgentDownloadPath(root, "C:\\Users\\alice\\outside.txt")).toThrow(
      "must be relative"
    );
  });

  test("rejects an existing parent symlink that escapes the root", () => {
    const root = makeTempDir();
    const outside = makeTempDir();
    mkdirSync(join(outside, "target"));
    symlinkSync(join(outside, "target"), join(root, "linked"), "dir");
    expect(() => resolveAgentDownloadPath(root, "linked/outside.txt")).toThrow(
      "symbolic link"
    );
  });
});

test("agent protocol authenticates TCP and preserves key/screenshot semantics", async () => {
  const messages: any[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    const nonce = "test-nonce";
    socket.write(JSON.stringify({ type: "auth_challenge", nonce }) + "\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        messages.push(message);
        if (message.type === "auth") continue;
        socket.write(
          JSON.stringify({
            id: message.id,
            success: true,
            data: message.action === "screenshot" ? { base64: "cG5n" } : {},
          }) + "\n"
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing TCP address");

  const originalEnv = { ...process.env };
  process.env.OPENCODE_BROWSER_AGENT_TRANSPORT = "tcp";
  process.env.OPENCODE_BROWSER_AGENT_HOST = "127.0.0.1";
  process.env.OPENCODE_BROWSER_AGENT_PORT = String(address.port);
  process.env.OPENCODE_BROWSER_AGENT_AUTOSTART = "0";
  process.env.OPENCODE_BROWSER_AGENT_GATEWAY_TOKEN = "a".repeat(32);
  try {
    const backend = createAgentBackend("protocol-test");
    const keyResult = await backend.requestTool("key", {
      key: "a",
      selector: "#target",
      ctrlKey: true,
      shiftKey: true,
    });
    const screenshotResult = await backend.requestTool("screenshot", { fullPage: true });

    expect(messages[0]).toEqual({
      type: "auth",
      hmac: createHmac("sha256", "a".repeat(32)).update("test-nonce").digest("base64url"),
    });
    expect(messages.find((message) => message.action === "press")).toMatchObject({
      action: "press",
      key: "Control+Shift+a",
      selector: "#target",
    });
    expect(messages.find((message) => message.action === "screenshot")).toMatchObject({
      action: "screenshot",
      format: "png",
      fullPage: true,
    });
    expect(JSON.parse(keyResult.content)).toMatchObject({
      ok: true,
      effectiveKey: "Control+Shift+a",
      backend: "agent-browser",
    });
    expect(screenshotResult.content).toBe("data:image/png;base64,cG5n");
    await expect(backend.requestTool("key", { key: "a", repeat: true })).rejects.toThrow(
      "repeat=true"
    );
    await expect(
      backend.requestTool("screenshot", { clip: { x: 0, y: 0, width: 10, height: 10 } })
    ).rejects.toThrow("does not support");
  } finally {
    process.env = originalEnv;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
