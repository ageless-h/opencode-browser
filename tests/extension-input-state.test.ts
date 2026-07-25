import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const source = readFileSync(
  join(import.meta.dir, "..", "extension", "background.js"),
  "utf8"
);
const start = source.indexOf("const CDP_MOUSE_BUTTONS");
const end = source.indexOf("\nasync function toolMouseMove", start);
if (start === -1 || end === -1) throw new Error("Could not extract CDP input helpers");
const helperSource = source.slice(start, end);

function loadHelpers(sendCommand: (...args: any[]) => Promise<any>) {
  const factory = new Function(
    "chrome",
    "ensureDebuggerAttached",
    `${helperSource}
     return {
       cdpDispatchMouse,
       getCdpMouseState,
       resetCdpMouseState,
       cdpKeyChord,
     }`
  );
  return factory(
    { debugger: { sendCommand } },
    async () => ({ attached: true })
  );
}

describe("CDP input state", () => {
  test("clears each modifier bit before that modifier's keyUp", async () => {
    const events: any[] = [];
    const helpers = loadHelpers(async (_target: unknown, method: string, params: any) => {
      if (method === "Input.dispatchKeyEvent") events.push(params);
    });
    await helpers.cdpKeyChord(1, ["Control", "Shift", "a"]);

    const keyUps = events.filter((event) => event.type === "keyUp");
    expect(keyUps.map((event) => [event.key, event.modifiers])).toEqual([
      ["a", 10],
      ["Shift", 2],
      ["Control", 0],
    ]);
  });

  test("does not commit a pressed mouse button when CDP send fails", async () => {
    const helpers = loadHelpers(async () => {
      throw new Error("detached");
    });
    await expect(
      helpers.cdpDispatchMouse(7, "mousePressed", {
        x: 10,
        y: 20,
        button: "left",
        clickCount: 1,
      })
    ).rejects.toThrow("detached");
    expect(helpers.getCdpMouseState(7).buttons).toBe(0);
  });
});

test("download listener ignores unrelated tabs and origins and is cancellable", async () => {
  const blockStart = source.indexOf("function clampNumber");
  const blockEnd = source.indexOf("\nasync function getDownloadById", blockStart);
  if (blockStart === -1 || blockEnd === -1) throw new Error("Could not extract download waiter");
  const listeners = new Set<(item: any) => void>();
  const debuggerListeners = new Set<(source: any, method: string, params: any) => void>();
  const chrome = {
    runtime: { id: "test-extension" },
    debugger: {
      onEvent: {
        addListener(listener: (source: any, method: string, params: any) => void) {
          debuggerListeners.add(listener);
        },
        removeListener(listener: (source: any, method: string, params: any) => void) {
          debuggerListeners.delete(listener);
        },
      },
    },
    downloads: {
      onCreated: {
        addListener(listener: (item: any) => void) {
          listeners.add(listener);
        },
        removeListener(listener: (item: any) => void) {
          listeners.delete(listener);
        },
      },
    },
  };
  const factory = new Function(
    "chrome",
    `${source.slice(blockStart, blockEnd)}; return waitForNextDownloadCreated`
  );
  const waitForNextDownloadCreated = factory(chrome);
  const waiter = waitForNextDownloadCreated({
    timeoutMs: 1000,
    tabId: 4,
    pageUrl: "https://example.com/page",
    startedAt: Date.now(),
  });

  for (const listener of listeners) {
    listener({
      id: 1,
      tabId: 99,
      referrer: "https://other.example/page",
      startTime: new Date().toISOString(),
    });
  }
  expect(listeners.size).toBe(1);
  for (const listener of debuggerListeners) {
    listener(
      { tabId: 99 },
      "Page.downloadWillBegin",
      { url: "https://example.com/file.txt", suggestedFilename: "file.txt" }
    );
  }
  for (const listener of listeners) {
    listener({
      id: 2,
      tabId: 4,
      url: "https://example.com/file.txt",
      referrer: "https://example.com/page",
      startTime: new Date().toISOString(),
    });
  }
  expect(listeners.size).toBe(1);
  for (const listener of debuggerListeners) {
    listener(
      { tabId: 4 },
      "Page.downloadWillBegin",
      { url: "https://example.com/file.txt", suggestedFilename: "file.txt" }
    );
  }
  expect((await waiter.promise).id).toBe(2);
  expect(listeners.size).toBe(0);
  expect(debuggerListeners.size).toBe(0);

  const cancelled = waitForNextDownloadCreated({
    timeoutMs: 1000,
    tabId: 4,
    pageUrl: "https://example.com/page",
    startedAt: Date.now(),
  });
  cancelled.cancel();
  expect(await cancelled.promise).toBeNull();
  expect(listeners.size).toBe(0);
  expect(debuggerListeners.size).toBe(0);
});
