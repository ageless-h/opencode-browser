# OpenCode Browser ↔ Codex Chrome 能力对齐设计

**日期:** 2026-07-25  
**仓库:** `ageless-h/opencode-browser`（基于 `@different-ai/opencode-browser@4.6.1`）  
**状态:** 已批准执行（路线 B）

## 1. 目标

在 **4.6.1 扩展 + Native Messaging + 本地 broker** 底座上，分阶段把 OpenCode Browser 的**可观测与可操作能力**尽量对齐本机 Codex Chrome 插件（`openai-bundled/chrome`），而不是 1:1 复制其 Node REPL / `agent.browsers` 宿主 API。

成功标准（产品层）：

1. 日常网页任务（导航、点击、输入、键盘、截图、a11y snapshot、下载/上传）可用且稳定。
2. Agent 工作流接近 Codex：**先 observe（snapshot/screenshot）→ 再 act → 廉价校验**。
3. 会话语义接近 Codex：**任务标签分组、尽量不抢用户当前前台标签**。
4. 用户上下文接近 Codex：**`user.history` 受控访问**（P3；无硬域名 allow/block API）。

明确非目标：

- 不实现完整 `agent.browsers` / Node REPL 控制面。
- 不默认依赖纯 CDP（v5 `opencode-chrome-devtools`）。
- 不实现完整 Computer Use 像素环（vision CUA 可作为远期可选）。

## 2. 现状与差距

### 2.1 当前架构

```
OpenCode Plugin (src/plugin.ts)
  ↔ Local Broker (bin/broker.cjs)  // 多路复用 + per-tab ownership
  ↔ Native Host (bin/native-host.cjs)
  ↔ Chrome Extension (extension/background.js)
```

可选：`OPENCODE_BROWSER_BACKEND=agent` 走 agent-browser 后端（能力子集）。

### 2.2 当前工具（4.6.1）

核心：`status` / `get_tabs` / `claim|release|open|close` / `navigate` / `query` / `click` / `type` / `select` / `scroll` / `wait`  
下载上传：`download` / `list_downloads` / `set_file_input`  
诊断：`snapshot` / `screenshot` / `highlight` / `console` / `errors` / `version` / `debug`

### 2.3 Codex Chrome 能力参考（本机插件 API）

- **Tab 导航:** `goto` / `back` / `forward` / `reload` / `close` / `title` / `url` / `screenshot`
- **Observe-Act:** `playwright.domSnapshot` + locator 策略；`cua` / `dom_cua` 作为兜底
- **键盘 / 对话框:** `keypress`；`getJsDialog` + accept/dismiss
- **会话:** claim 用户标签、task tab group、markDeliverable / markHandoff
- **用户上下文:** `user.history` / `user.openTabs` / `user.claimTab`（history 需确认）
- **可选能力:** clipboard、content export、dev.logs、CDP developer mode

### 2.4 主要缺口

| 层 | 缺口 |
|----|------|
| P0 交互 | `back` / `forward` / `reload` / `key` / `set_active_tab`；JS dialog 处理 |
| P1 定位 | snapshot 作为 locator 真源；uid/role/name 点击；歧义 count |
| P2 会话 | Chrome tab group 绑定 session；默认不抢用户 active tab |
| P3 用户上下文 | `browser_history`（对齐 `browser.user.history`；无硬域名门禁） |
| P4 可选 | Playwright 子集语义、clipboard、content export |

## 3. 路线（已选 B：分层对齐）

保留现有扁平 `browser_*` 工具名（OpenCode 插件契约），内部收敛为三层：

1. **Session** — claim、tab group、active tab 策略  
2. **Observe-Act** — snapshot 真源 + 稳定定位 + 动作 + 廉价校验  
3. **User context** — history（及后续可选 export）；安全确认走 agent 文档而非硬门禁

实现上继续走 **extension tool table + plugin tool wrappers**；agent-backend 同步支持同一 tool 名，避免双后端分叉过大。

## 4. 分期交付

### P0 — 交互补齐（本期实现）

新增 / 补齐工具：

| OpenCode tool | Extension op | 行为 |
|---------------|--------------|------|
| `browser_back` | `back` | `chrome.tabs.goBack` 等价：history back |
| `browser_forward` | `forward` | history forward |
| `browser_reload` | `reload` | reload（可选 bypassCache） |
| `browser_set_active_tab` | `set_active_tab` | `tabs.update({ active: true })`（需 claim） |
| `browser_key` | `key` | 向页面/聚焦元素派发键盘事件（Enter/Escape/Tab/组合键等） |
| `browser_handle_dialog` | `handle_dialog` | 接受/取消当前 JS dialog（alert/confirm/prompt） |

实现要点：

- **back/forward/reload/set_active_tab** 用 Chrome Tabs API，不进 `pageOps`。
- **key** 用 `scripting.executeScript` 在 ISOLATED world 派发 `keydown`/`keyup`/`keypress`（及可选 `input`）。
- **dialog** 在 extension service worker 注册 `chrome.webNavigation`/`chrome.debugger` 成本高；优先用 `chrome.scripting` 无法拦截原生 dialog。4.6.1 无 debugger 权限时，采用：
  - 注入页面 hook：`window.alert/confirm/prompt` 包装（仅脚本 dialog）；
  - 或声明可选 `debugger` 权限处理原生 dialog（P0 先做脚本 hook + 文档说明原生 dialog 限制）。
- broker 继续按 tab claim 校验（与 navigate 相同路径）。
- agent-backend：映射到 agent-browser 等价命令（若无则明确报 Unsupported，不静默失败）。

验收：

- `node --check extension/background.js`
- `bun run build`
- CLI/`tool-test` 能列出新工具
- 有扩展连接时：`browser_navigate` → `browser_back` → `browser_forward` → `browser_reload` 链路可用
- `browser_key` 在输入框触发 Enter/Escape

### P1 — 定位语义

- snapshot 输出稳定 `uid` + role/name/value/disabled/visible
- click/type/select 支持 `uid` 或 `role`+`name`（兼容现有 selector 前缀）
- 多匹配时返回 count + 候选，禁止 silent `.first()`

### P2 — 会话语义（已实现）

- session 创建/加入 Chrome `tabGroups`（`browser_name_session`）
- `open_tab` 默认进 session group，且默认 `active: false`
- claim 用户标签不入 agent group；`mark_tab` + 显式 `finalize`
- 文档化“不抢用户当前标签”默认策略（仅 `set_active_tab` / `active:true` 抢前台）

### P3 — 用户上下文（Codex `user.history`）

- `browser_history`：对齐 `BrowserHistoryOptions` / `BrowserHistoryEntry`
- 无 `policy.json` 域名硬门禁（Codex 插件 API 无此项；确认靠 agent 指引）
- 调用策略：非推测性、带时间窗与少量 `queries`（见 Codex api-use-behavior）

### P4 — 可选增强

- locator 子集 API 文档化（仍暴露为 tools，不引入 REPL）
- clipboard read/write（权限允许时）
- content export

## 5. 工具命名与兼容

- 全部保持 `browser_*` 前缀。
- 旧工具行为不变；新工具只追加。
- README Roadmap 勾选随分期更新。

## 6. 风险

| 风险 | 缓解 |
|------|------|
| 原生 `window.alert` 阻塞扩展 | P0 文档限制；P1+ 评估 debugger |
| 键盘事件站点自定义处理不一致 | 支持 key/code/modifiers；失败返回明确错误 |
| agent-backend 能力不全 | 显式 Unsupported，主路径以 extension 为准 |
| 权限扩张（tabGroups/history） | P2/P3 再改 manifest；history 需 Reload |

## 7. 决策记录

- 底座：**坚持 4.6.1 扩展 + broker**（用户确认）
- 范围：**全面对齐，分阶段**（用户确认）
- 路线：**B 分层对齐**（用户确认“可以，执行”）
