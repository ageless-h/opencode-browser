import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
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

class MockSocket extends EventEmitter {
  destroyed = false;
  written: string[] = [];

  setNoDelay(): void {}

  write(data: string): boolean {
    this.written.push(data);
    return true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  }

  writtenMessages(): any[] {
    return this.written
      .flatMap((chunk) => chunk.split("\n"))
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  }

  respond(id: string, data: any): void {
    this.emit("data", Buffer.from(JSON.stringify({ id, success: true, data }) + "\n"));
  }

  respondAll(data: any = {}): void {
    for (const message of this.writtenMessages()) {
      this.respond(String(message.id), data);
    }
    this.written = [];
  }
}

type MockTab = {
  url: string;
  title: string;
  value: string;
};

class TabDaemonSocket extends EventEmitter {
  destroyed = false;
  tabs: MockTab[] = [
    { url: "https://a.example", title: "A", value: "" },
    { url: "https://b.example", title: "B", value: "" },
    { url: "https://c.example", title: "C", value: "" },
  ];
  activeIndex = 0;
  switchDelayMs = 0;
  actions: Array<{ action: string; index: number }> = [];

  setNoDelay(): void {}

  write(data: string): boolean {
    for (const line of data.split("\n").filter((value) => value.trim())) {
      const message = JSON.parse(line);
      void this.handle(message);
    }
    return true;
  }

  private async handle(message: any): Promise<void> {
    let data: any = {};
    if (message.action === "tab_list") {
      data = {
        tabs: this.tabs.map((tab, index) => ({
          index,
          url: tab.url,
          title: tab.title,
          active: index === this.activeIndex,
        })),
        active: this.activeIndex,
      };
    } else if (message.action === "tab_switch") {
      this.activeIndex = message.index;
      this.actions.push({ action: "tab_switch", index: message.index });
      if (this.switchDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, this.switchDelayMs));
      }
      data = { index: message.index };
    } else if (message.action === "type") {
      this.actions.push({ action: "type", index: this.activeIndex });
      this.tabs[this.activeIndex].value = message.text;
    } else if (message.action === "navigate") {
      this.actions.push({ action: "navigate", index: this.activeIndex });
      this.tabs[this.activeIndex].url = message.url;
    } else if (message.action === "tab_close") {
      const index = Number.isFinite(message.index) ? message.index : this.activeIndex;
      this.tabs.splice(index, 1);
      if (this.activeIndex >= this.tabs.length) this.activeIndex = this.tabs.length - 1;
      else if (this.activeIndex > index) this.activeIndex--;
      data = { closed: index, remaining: this.tabs.length };
    } else if (message.action === "tab_new") {
      this.tabs.push({ url: "about:blank", title: "", value: "" });
      this.activeIndex = this.tabs.length - 1;
      data = { index: this.activeIndex, total: this.tabs.length };
    }
    this.emit(
      "data",
      Buffer.from(JSON.stringify({ id: message.id, success: true, data }) + "\n")
    );
  }
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

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

describe("agent socket connection races (issue #36)", () => {
  test("concurrent first connects share a single socket (single-flight)", async () => {
    let connectCalls = 0;
    let releaseConnect: ((socket: MockSocket) => void) | null = null;
    const socket = new MockSocket();
    const backend = createAgentBackend("single-flight-test", {
      connect: () =>
        new Promise<Socket>((resolve) => {
          connectCalls++;
          releaseConnect = resolve as (socket: MockSocket) => void;
        }),
    });

    const first = backend.status();
    const second = backend.status();
    await tick();
    expect(connectCalls).toBe(1);

    releaseConnect!(socket as unknown as Socket);
    await expect(first).resolves.toMatchObject({ connected: true });
    await expect(second).resolves.toMatchObject({ connected: true });

    // Once connected, further status calls reuse the same socket.
    await expect(backend.status()).resolves.toMatchObject({ connected: true });
    expect(connectCalls).toBe(1);
  });

  test("a stale socket close must not reject the new generation's pending requests", async () => {
    const sockets: MockSocket[] = [];
    const backend = createAgentBackend("generation-test", {
      connect: async () => {
        const socket = new MockSocket();
        sockets.push(socket);
        return socket as unknown as Socket;
      },
    });

    // Generation A: establish the first connection without a pending request.
    await expect(backend.status()).resolves.toMatchObject({ connected: true });
    expect(sockets.length).toBe(1);
    const socketA = sockets[0];

    // A half-open failure: the socket is dead but its close event has not
    // been delivered yet, so the next request reconnects to generation B and
    // leaves a pending request on that new socket.
    socketA.destroyed = true;
    const pendingOnB = backend.requestTool("wait", { ms: 1 });
    await tick();
    expect(sockets.length).toBe(2);
    const socketB = sockets[1];

    // The stale close of A arrives late: B's pending request and the live
    // global socket must survive.
    socketA.emit("close");

    socketB.respondAll();
    await expect(pendingOnB).resolves.toBeTruthy();

    // The global socket still points at live B: no third connection.
    const third = backend.requestTool("wait", { ms: 1 });
    await tick();
    expect(sockets.length).toBe(2);
    socketB.respondAll();
    await expect(third).resolves.toBeTruthy();
  });

  test("a socket error rejects that generation's pending requests", async () => {
    const sockets: MockSocket[] = [];
    const backend = createAgentBackend("error-test", {
      connect: async () => {
        const socket = new MockSocket();
        sockets.push(socket);
        return socket as unknown as Socket;
      },
    });

    const pending = backend.requestTool("wait", { ms: 1 });
    const caught = pending.catch((error) => error);
    await tick();
    sockets[0].emit("error", new Error("boom"));
    const error = await caught;
    expect(error).toBeInstanceOf(Error);
    expect(String(error.message)).toContain("error");

    // After the error the backend reconnects instead of reusing the dead socket.
    const next = backend.requestTool("wait", { ms: 1 });
    await tick();
    expect(sockets.length).toBe(2);
    sockets[1].respondAll();
    await expect(next).resolves.toBeTruthy();
  });
});

describe("agent tab isolation (issues #38 and #39)", () => {
  test("serializes tab switch and action across concurrent targeted operations", async () => {
    const socket = new TabDaemonSocket();
    socket.tabs = socket.tabs.slice(0, 2);
    socket.switchDelayMs = 15;
    const backend = createAgentBackend("tab-mutex-test", {
      connect: async () => socket as unknown as Socket,
    });

    await Promise.all([
      backend.requestTool("type", { tabId: 0, selector: "#name", text: "for-A" }),
      backend.requestTool("type", { tabId: 1, selector: "#name", text: "for-B" }),
    ]);

    expect(socket.tabs.map((tab) => tab.value)).toEqual(["for-A", "for-B"]);
    expect(socket.actions).toEqual([
      { action: "tab_switch", index: 0 },
      { action: "type", index: 0 },
      { action: "tab_switch", index: 1 },
      { action: "type", index: 1 },
    ]);
  });

  test("keeps stable tab ids after closing an earlier tab and never reuses a closed id", async () => {
    const socket = new TabDaemonSocket();
    const backend = createAgentBackend("stable-tab-id-test", {
      connect: async () => socket as unknown as Socket,
    });

    const initial = JSON.parse((await backend.requestTool("get_tabs", {})).content);
    expect(initial.map((tab: any) => tab.id)).toEqual([0, 1, 2]);

    const closed = await backend.requestTool("close_tab", { tabId: 0 });
    expect(closed.content.tabId).toBe(0);
    await backend.requestTool("navigate", {
      tabId: 1,
      url: "https://target-for-b.example",
    });

    expect(socket.tabs.map((tab) => tab.url)).toEqual([
      "https://target-for-b.example",
      "https://c.example",
    ]);
    const afterClose = JSON.parse((await backend.requestTool("get_tabs", {})).content);
    expect(afterClose.map((tab: any) => tab.id)).toEqual([1, 2]);
    await expect(backend.requestTool("navigate", {
      tabId: 0,
      url: "https://must-not-navigate.example",
    })).rejects.toThrow("Unknown or closed tabId");

    const opened = await backend.requestTool("open_tab", {
      url: "https://d.example",
      active: true,
    });
    expect(opened.content.tabId).toBe(3);
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
