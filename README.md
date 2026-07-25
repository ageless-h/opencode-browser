# OpenCode Browser

**让 OpenCode 接管你正在用的真实浏览器。**

这是一个 OpenCode 插件 + Chrome 扩展：OpenCode 的 agent 通过它直接操作你自己的 Chrome/Edge/Brave —— 用的是**你日常登录着的那个浏览器**，你的登录态、Cookie、书签、已开的标签页都在。

> Forked from [`different-ai/opencode-browser`](https://github.com/different-ai/opencode-browser)，本仓库为独立维护版本，已断开上游。

## 为什么是"接管你自己的浏览器"

很多 agent 浏览器方案会起一个干净的无头浏览器 —— 但那里没有你登录过的任何账号。一旦任务碰到需要登录的网站（邮箱、后台、内网系统、社交账号），agent 就卡住了。

本项目走另一条路：**正常的登录场景由你人来完成** —— 像平时一样打开 Chrome、扫码、输密码、过二次验证。登录完之后，agent 接管这个浏览器继续干活：

- **你负责登录**：和日常使用完全一样，在真实 Chrome 里完成所有认证
- **agent 负责操作**：导航、点击、填表、截图、抓取、下载，全部发生在你已登录的会话里
- **不偷前台**：agent 默认在后台标签页工作（`active: false`），并归入一个独立的 Chrome 标签组，不打断你手头的事
- **也能接管你已开的页**：`browser_claim_tab` 可以把你正在看的某个标签页交给 agent 继续操作

```
OpenCode Plugin <-> Local Broker (unix socket) <-> Native Host <-> Chrome Extension
```

- **Extension**：装在你的 Chrome 里，通过 Chrome API 执行浏览器操作
- **Native Host**：Chrome Native Messaging 桥
- **Broker**：本地多路复用，多个 OpenCode 会话各自隔离、互不抢标签
- **Plugin**：OpenCode 侧的 `browser_*` 工具集

无需 DevTools Protocol，无端口冲突，无安全弹窗。

## 安装

```bash
git clone https://github.com/ageless-h/opencode-browser.git
cd opencode-browser
bun install
node bin/cli.js install
```

支持 macOS、Linux、Windows（Chrome / Edge / Brave / Chromium）。

安装器会：

1. 把扩展复制到 `~/.opencode-browser/extension/`
2. 引导你在 `chrome://extensions` 加载并固定扩展
3. 解析固定扩展 ID 并安装 **Native Messaging Host manifest**
4. 更新你的 `opencode.json` / `opencode.jsonc` 加载插件

### 配置 OpenCode

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///path/to/opencode-browser"]
}
```

### 更新

```bash
node bin/cli.js update
```

然后到 `chrome://extensions` 点一下 Reload。

## 典型用法

```text
你:   帮我看看 Gmail 有没有新的账单邮件，汇总一下金额
agent: browser_open_tab → gmail.com（你已登录）→ 读取 → 汇总

你:   这个页面你接着操作（你正看着一个后台系统）
agent: browser_claim_tab → 接管当前标签页 → 继续填表/点审批
```

### CLI 调试

```bash
npx . tools                    # 列出全部 browser_* 工具
npx . tool browser_status      # 单跑一个工具
npx . self-test                # 端到端冒烟
```

## Chrome Web Store 打包（维护者）

```bash
bun run build:cws
```

产物与提交清单见：

- `docs/chrome-web-store/README.md`
- `docs/chrome-web-store/REQUEST_TEMPLATE.md`
- `PRIVACY.md`

## 会话与标签归属

- 每个 OpenCode 会话拥有自己的标签页，互不共享
- 会话没有标签时，broker 首次用工具时自动创建**后台**标签（`active: false`）
- `browser_open_tab` 创建 agent 标签（默认不抢前台）并加入会话标签组
- `browser_claim_tab` 接管用户已有标签，**不会**把它挪进 agent 标签组
- `browser_name_session` 命名会话并创建/更新 Chrome 标签组；建组用的临时 `about:blank` 会在真实标签入组后自动清理
- `browser_mark_tab` + `browser_finalize` 对齐 Codex 的 handoff/deliverable 清理
- 闲置 claim 默认 5 分钟过期（`OPENCODE_BROWSER_CLAIM_TTL_MS`）

## 可用工具

**核心：**
`browser_status` / `browser_get_tabs` / `browser_list_claims` / `browser_claim_tab` / `browser_release_tab` / `browser_name_session` / `browser_mark_tab` / `browser_finalize` / `browser_open_tab` / `browser_close_tab` / `browser_set_active_tab` / `browser_navigate` / `browser_back` / `browser_forward` / `browser_reload`

**页面交互（Codex Playwright 子集）：**
`browser_click` / `browser_type` / `browser_select` / `browser_fill` / `browser_dblclick` / `browser_check` / `browser_uncheck` / `browser_set_checked` / `browser_press` / `browser_key` / `browser_scroll` / `browser_wait` / `browser_wait_for` / `browser_wait_for_load_state` / `browser_wait_for_url` / `browser_handle_dialog` / `browser_get_js_dialog`

**查询与导出：**
`browser_query` / `browser_count` / `browser_is_visible` / `browser_is_enabled` / `browser_get_attribute` / `browser_text_content` / `browser_inner_text` / `browser_all_text_contents` / `browser_locator_all` / `browser_evaluate` / `browser_export` / `browser_title` / `browser_url`

**视觉与坐标（Codex CUA 子集）：**
`browser_screenshot`（支持 `fullPage` / `clip`）/ `browser_snapshot` / `browser_highlight` / `browser_element_info` / `browser_element_screenshot` / `browser_mouse_move` / `browser_mouse_click` / `browser_mouse_dblclick` / `browser_drag` / `browser_get_visible_dom`

**系统能力：**
`browser_clipboard_read_text` / `browser_clipboard_write_text`（offscreen）/ `browser_history`（高敏感，按需使用）/ `browser_download` / `browser_list_downloads` / `browser_download_media` / `browser_set_file_input` / `browser_capabilities_list` / `browser_viewport_set` / `browser_viewport_reset` / `browser_console` / `browser_errors` / `browser_version`

**选择器（`selector` 参数）：**
`uid:e12`（来自 snapshot）、`role:button[name=Submit]`、`label:...`、`aria:...`、`placeholder:...`、`name:...`、`text:...`、`id:...`、`css:...`

**严格多匹配：** 操作类工具省略 `index` 时要求唯一匹配；多匹配会报错并返回 `count` + `candidates`，传 `index` 或用 `uid:eN` 消歧。

## Roadmap

- [x] P0–P3：导航/键盘/对话框、snapshot uid 定位、会话标签组、`browser_history`
- [x] Playwright 子集（扁平工具）：count/fill/check/waitFor*/evaluate/export/title/url/getJsDialog
- [x] P4a/P4b：clipboard（offscreen）、screenshot fullPage/clip、all_text_contents、element_info、capabilities_list、viewport set/reset
- [x] P5：locator_all、press、download_media、CUA 子集（mouse_move/click/dblclick/drag）、get_visible_dom、element_screenshot
- [ ] 不镜像（Codex extension 不支持或架构级）：完整 locator 对象图/frameLocator 链、Tabs.content batch、pageAssets、browserAuth、agent.browsers REPL

## 排障

**扩展提示 native host not available**
- 重跑 `node bin/cli.js install`；若自定义过扩展 ID，加 `--extension-id <id>` 重跑

**`Unknown op: name_session` / `Unknown op: mark_tab`**
- 说明**正在跑的 broker 进程是旧的**（磁盘代码已更新，进程内存未热重载）。重启 broker：
  ```bash
  pkill -f ~/.opencode-browser/broker.cjs
  rm -f ~/.opencode-browser/broker.sock
  node ~/.opencode-browser/broker.cjs &
  ```
- claims、会话名、`groupId` 都在 broker 进程内存里，重启后丢失 —— 重跑 `browser_name_session` 即可
- 经验法则：每次 `node bin/cli.js update` 后，**重启 broker + Reload 扩展** 两件一起做

**标签归属错误（owned by another session）**
- 该 tabId 属于别的会话；用 `browser_open_tab` 开新标签，或省略 `tabId` 用本会话默认标签
- 用 `browser_status` / `browser_list_claims` 排查

**推荐 SOP**：`browser_status`（确认 hostConnected / groupId）→ 先 `browser_name_session` → 再并行 `browser_open_tab(active:false)` → 结束时 `browser_mark_tab` / `browser_finalize`

## 卸载

```bash
node bin/cli.js uninstall
```

然后在 `chrome://extensions` 移除扩展，并从 `opencode.json` 中删掉插件项。

## 隐私

见 `PRIVACY.md`。

## License

MIT · 原作者 Benjamin Shafii（different-ai），本仓库独立维护。
