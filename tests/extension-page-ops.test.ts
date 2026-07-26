import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import { existsSync, readFileSync } from "fs";
import type { Socket } from "net";
import { chromium, type Browser, type Page } from "playwright-core";
import { join } from "path";
import { createAgentBackend } from "../src/agent-backend";

const sourcePath = join(import.meta.dir, "..", "extension", "background.js");
const source = readFileSync(sourcePath, "utf8");
const start = source.indexOf("async function pageOps(command, args) {");
const end = source.indexOf("\nconst TAB_GROUP_COLORS", start);
if (start === -1 || end === -1) throw new Error("Could not extract pageOps");
const pageOpsSource = source.slice(start, end);
const snapshotStart = source.indexOf("async function toolSnapshot({ tabId })");
const snapshotEnd = source.indexOf("\nasync function toolScroll", snapshotStart);
if (snapshotStart === -1 || snapshotEnd === -1) throw new Error("Could not extract toolSnapshot");
const toolSnapshotSource = source.slice(snapshotStart, snapshotEnd);

const chromeCandidates = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].filter((value): value is string => !!value);
const executablePath = chromeCandidates.find((candidate) => existsSync(candidate));

let browser: Browser;
let page: Page;

class PageAgentSocket extends EventEmitter {
  destroyed = false;
  private readonly page: Page;
  private readonly failEvaluate: boolean;

  constructor(pageValue: Page, failEvaluate = false) {
    super();
    this.page = pageValue;
    this.failEvaluate = failEvaluate;
  }

  setNoDelay(): void {}

  write(data: string): boolean {
    for (const line of data.split("\n").filter((value) => value.trim())) {
      const message = JSON.parse(line);
      void this.respondTo(message);
    }
    return true;
  }

  private async respondTo(message: any): Promise<void> {
    let data: any = {};
    if (message.action === "evaluate") {
      if (this.failEvaluate) {
        this.emit(
          "data",
          Buffer.from(
            JSON.stringify({
              id: message.id,
              success: false,
              error: "evaluate unavailable",
            }) + "\n"
          )
        );
        return;
      }
      const result = await this.page.evaluate((script) => (0, eval)(script), message.script);
      data = { result };
    } else if (message.action === "snapshot") {
      data = {
        snapshot: [
          '- textbox "Password" value="super-secret-password"',
          '- textbox "PIN" value="q7"',
          '- textbox "API key" value="secret-api-key"',
          '- textbox "Display name" value="safe-name"',
        ].join("\n"),
        refs: {
          e1: { role: "textbox", value: "super-secret-password" },
          e2: { role: "textbox", value: "q7" },
          e3: { role: "textbox", value: "secret-api-key" },
          e4: { role: "textbox", value: "safe-name" },
        },
      };
    }
    this.emit(
      "data",
      Buffer.from(JSON.stringify({ id: message.id, success: true, data }) + "\n")
    );
  }
}

async function runPageOp(command: string, args: Record<string, unknown> = {}) {
  return await page.evaluate(
    async ({ functionSource, commandName, commandArgs }) => {
      const fn = (0, eval)(`(${functionSource})`);
      return await fn(commandName, commandArgs);
    },
    { functionSource: pageOpsSource, commandName: command, commandArgs: args }
  );
}

async function runSnapshot() {
  const chrome = {
    scripting: {
      executeScript: async ({ func }: { func: Function }) => [
        {
          result: await page.evaluate(
            async ({ functionSource }) => {
              const fn = (0, eval)(`(${functionSource})`);
              return await fn();
            },
            { functionSource: func.toString() }
          ),
        },
      ],
    },
  };
  const factory = new Function(
    "chrome",
    "getTabById",
    `${toolSnapshotSource}; return toolSnapshot`
  );
  const toolSnapshot = factory(chrome, async () => ({ id: 1 }));
  return await toolSnapshot({ tabId: 1 });
}

beforeAll(async () => {
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
  page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
});

afterAll(async () => {
  await browser?.close();
});

describe("extension page operation regressions", () => {
  test("redacts sensitive fields from page text and HTML export", async () => {
    await page.setContent(`
      <input type="password" value="super-secret-password">
      <input type="password" value="q7">
      <input type="hidden" name="csrf_token" value="secret-token">
      <input name="api_key" value="secret-api-key">
      <input name="display_name" value="safe-name">
    `);

    const pageText = await runPageOp("query", { mode: "page_text" });
    const visibleDom = await runPageOp("get_visible_dom", {});
    const exported = await runPageOp("export", { contentType: "html" });
    const snapshot = await runSnapshot();
    const combined = JSON.stringify({ pageText, visibleDom, exported, snapshot });
    expect(combined).not.toContain("super-secret-password");
    expect(combined).not.toContain("q7");
    expect(combined).not.toContain("secret-token");
    expect(combined).not.toContain("secret-api-key");
    expect(combined).toContain("safe-name");
    expect(combined).toContain("[REDACTED]");
  });

  test("fails closed when an agent snapshot cannot inspect sensitive values", async () => {
    const socket = new PageAgentSocket(page, true);
    const backend = createAgentBackend("snapshot-redaction-failure-test", {
      connect: async () => socket as unknown as Socket,
    });

    await expect(backend.requestTool("snapshot", {})).rejects.toThrow(
      "evaluate unavailable"
    );
  });

  test("redacts sensitive agent-backend page text and snapshot values", async () => {
    await page.setContent(`
      <input type="password" value="super-secret-password">
      <input type="hidden" name="csrf_token" value="secret-token">
      <input name="api_key" value="secret-api-key">
      <input name="display_name" value="safe-name">
    `);

    const socket = new PageAgentSocket(page);
    const backend = createAgentBackend("sensitive-export-test", {
      connect: async () => socket as unknown as Socket,
    });
    const pageText = await backend.requestTool("query", { mode: "page_text" });
    const snapshot = await backend.requestTool("snapshot", {});
    const combined = JSON.stringify({ pageText, snapshot });

    expect(combined).not.toContain("super-secret-password");
    expect(combined).not.toContain("secret-token");
    expect(combined).not.toContain("secret-api-key");
    expect(combined).toContain("safe-name");
    expect(combined).toContain("[REDACTED]");
  });

  test("redacts sensitive select, metadata, and inline state from HTML export", async () => {
    await page.setContent(`
      <meta name="csrf-token" content="meta-secret-token">
      <select name="access_token">
        <option value="select-secret-token" selected>select-secret-label</option>
      </select>
      <script type="application/json">
        {"profile":{"name":"Alice"},"auth":{"access_token":"json-secret-token"}}
      </script>
      <script>window.__STATE__ = {"apiKey":"inline-secret-key"}</script>
      <input name="display_name" value="safe-name">
    `);

    const exported = await runPageOp("export", { contentType: "html" });
    expect(exported.value).not.toContain("meta-secret-token");
    expect(exported.value).not.toContain("select-secret-token");
    expect(exported.value).not.toContain("select-secret-label");
    expect(exported.value).not.toContain("json-secret-token");
    expect(exported.value).not.toContain("inline-secret-key");
    expect(exported.value).toContain("safe-name");
    expect(exported.value).toContain("Alice");
    expect(exported.value).toContain("[REDACTED]");
  });

  test("fails closed for hidden and intercepted click targets", async () => {
    await page.setContent(`
      <button id="hidden" style="display:none">Hidden</button>
      <button id="target" style="position:absolute;left:200px;top:200px;width:120px;height:40px">Target</button>
      <div id="overlay" style="position:fixed;inset:0;z-index:10"></div>
    `);

    const hidden = await runPageOp("resolve_point", { selector: "#hidden", index: 0 });
    const intercepted = await runPageOp("resolve_point", { selector: "#target", index: 0 });
    expect(hidden.ok).toBeFalse();
    expect(hidden.error).toContain("not visible");
    expect(intercepted.ok).toBeFalse();
    expect(intercepted.error).toContain("intercepted");
    expect(intercepted.interceptedBy.id).toBe("overlay");
  });

  test("applies index before actionability filtering", async () => {
    await page.setContent(`
      <button class="row" hidden>hidden-0</button>
      <button class="row" id="visible-1" style="position:absolute;left:100px;top:100px;width:100px;height:40px">one</button>
      <button class="row" id="visible-2" style="position:absolute;left:400px;top:100px;width:100px;height:40px">two</button>
    `);

    const hidden = await runPageOp("resolve_point", { selector: ".row", index: 0 });
    const secondDomItem = await runPageOp("resolve_point", { selector: ".row", index: 1 });
    expect(hidden.ok).toBeFalse();
    expect(secondDomItem.ok).toBeTrue();
    expect(secondDomItem.x).toBeGreaterThan(100);
    expect(secondDomItem.x).toBeLessThan(250);
  });

  test("converts same-origin iframe coordinates to the top viewport", async () => {
    await page.setContent(`
      <iframe id="frame"
        style="position:absolute;left:400px;top:300px;width:300px;height:200px;border:0"
        srcdoc="<button id='inside' style='position:absolute;left:20px;top:30px;width:100px;height:40px'>Inside</button>">
      </iframe>
    `);
    await page.waitForFunction(() => {
      const frame = document.querySelector("iframe");
      return !!frame?.contentDocument?.querySelector("#inside");
    });

    const point = await runPageOp("resolve_point", { selector: "#inside", index: 0 });
    expect(point.ok).toBeTrue();
    expect(point.x).toBeGreaterThan(450);
    expect(point.x).toBeLessThan(500);
    expect(point.y).toBeGreaterThan(340);
    expect(point.y).toBeLessThan(380);
  });

  test("accounts for iframe CSS transforms and shadow-DOM hit targets", async () => {
    await page.setContent(`
      <iframe id="frame"
        style="position:absolute;left:300px;top:200px;width:200px;height:120px;border:0;transform:scale(1.5);transform-origin:top left">
      </iframe>
    `);
    await page.evaluate(() => {
      const frame = document.querySelector("iframe");
      const doc = frame?.contentDocument;
      if (!doc) throw new Error("Missing iframe document");
      const host = doc.createElement("div");
      host.id = "host";
      host.style.cssText = "position:absolute;left:20px;top:20px";
      doc.body.appendChild(host);
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = '<button id="inside" style="width:80px;height:40px">Inside</button>';
    });

    const point = await runPageOp("resolve_point", { selector: "#inside", index: 0 });
    expect(point.ok).toBeTrue();
    expect(point.x).toBeGreaterThan(380);
    expect(point.x).toBeLessThan(410);
    expect(point.y).toBeGreaterThan(245);
    expect(point.y).toBeLessThan(275);
  });

  test("rejects non-checkable controls and observes unchanged ARIA state", async () => {
    await page.setContent(`
      <input id="text" type="text">
      <div id="aria" role="checkbox" aria-checked="false">Option</div>
    `);

    const text = await runPageOp("set_checked", {
      selector: "#text",
      checked: true,
      inspectOnly: true,
    });
    const aria = await runPageOp("set_checked", {
      selector: "#aria",
      checked: true,
    });
    expect(text.ok).toBeFalse();
    expect(text.error).toContain("not checkable");
    expect(aria.ok).toBeFalse();
    expect(aria.checked).toBeFalse();
  });
});
