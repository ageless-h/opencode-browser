const NATIVE_HOST_NAME = "com.opencode.browser_automation"
const KEEPALIVE_ALARM = "keepalive"
const PERMISSION_HINT = "Click the OpenCode Browser extension icon and approve requested permissions."
const OPTIONAL_RUNTIME_PERMISSIONS = ["nativeMessaging", "downloads", "debugger"]
const OPTIONAL_RUNTIME_ORIGINS = ["<all_urls>"]

const runtimeManifest = chrome.runtime.getManifest()
const declaredOptionalPermissions = new Set(runtimeManifest.optional_permissions || [])
const declaredOptionalOrigins = new Set(runtimeManifest.optional_host_permissions || [])

let port = null
let isConnected = false
let connectionAttempts = 0
let nativePermissionHintLogged = false

// Debugger state management for console/error capture
const debuggerState = new Map()
const MAX_LOG_ENTRIES = 1000

async function hasPermissions(query) {
  if (!chrome.permissions?.contains) return true
  try {
    return await chrome.permissions.contains(query)
  } catch {
    return false
  }
}

async function hasNativeMessagingPermission() {
  return await hasPermissions({ permissions: ["nativeMessaging"] })
}

async function hasDebuggerPermission() {
  return await hasPermissions({ permissions: ["debugger"] })
}

async function hasDownloadsPermission() {
  return await hasPermissions({ permissions: ["downloads"] })
}

async function hasHostAccessPermission() {
  return await hasPermissions({ origins: ["<all_urls>"] })
}

async function requestOptionalPermissionsFromClick() {
  if (!chrome.permissions?.contains || !chrome.permissions?.request) {
    return { granted: true, requested: false, permissions: [], origins: [] }
  }

  const permissions = []
  for (const permission of OPTIONAL_RUNTIME_PERMISSIONS) {
    if (!declaredOptionalPermissions.has(permission)) continue
    const granted = await hasPermissions({ permissions: [permission] })
    if (!granted) permissions.push(permission)
  }

  const origins = []
  for (const origin of OPTIONAL_RUNTIME_ORIGINS) {
    if (!declaredOptionalOrigins.has(origin)) continue
    const granted = await hasPermissions({ origins: [origin] })
    if (!granted) origins.push(origin)
  }

  if (!permissions.length && !origins.length) {
    return { granted: true, requested: false, permissions, origins }
  }

  try {
    const granted = await chrome.permissions.request({ permissions, origins })
    return { granted, requested: true, permissions, origins }
  } catch (error) {
    return {
      granted: false,
      requested: true,
      permissions,
      origins,
      error: error?.message || String(error),
    }
  }
}

async function ensureDebuggerAvailable() {
  if (!chrome.debugger?.attach) {
    return {
      ok: false,
      reason: "Debugger API unavailable in this build.",
    }
  }

  const granted = await hasDebuggerPermission()
  if (!granted) {
    return {
      ok: false,
      reason: `Debugger permission not granted. ${PERMISSION_HINT}`,
    }
  }

  return { ok: true }
}

async function ensureDownloadsAvailable() {
  if (!chrome.downloads) {
    throw new Error(`Downloads API unavailable in this build. ${PERMISSION_HINT}`)
  }

  const granted = await hasDownloadsPermission()
  if (!granted) {
    throw new Error(`Downloads permission not granted. ${PERMISSION_HINT}`)
  }
}

function getOrCreateDebuggerState(tabId) {
  let state = debuggerState.get(tabId)
  if (!state) {
    state = {
      attached: false,
      consoleMessages: [],
      pageErrors: [],
      pendingDialog: null,
    }
    debuggerState.set(tabId, state)
  }
  if (state.pendingDialog === undefined) state.pendingDialog = null
  if (!Array.isArray(state.consoleMessages)) state.consoleMessages = []
  if (!Array.isArray(state.pageErrors)) state.pageErrors = []
  return state
}

async function ensureDebuggerAttached(tabId) {
  const availability = await ensureDebuggerAvailable()
  if (!availability.ok) {
    return {
      attached: false,
      unavailableReason: availability.reason,
      consoleMessages: [],
      pageErrors: [],
      pendingDialog: null,
    }
  }

  const state = getOrCreateDebuggerState(tabId)

  // While a JS dialog is open, most CDP commands hang. Trust local attach flag.
  if (state.attached) {
    if (state.pendingDialog) return state
    return state
  }

  try {
    try {
      await chrome.debugger.attach({ tabId }, "1.3")
    } catch (attachError) {
      const msg = attachError?.message || String(attachError)
      // Service worker may have restarted while Chrome kept the debugger session.
      if (!/already attached/i.test(msg)) throw attachError
      state.attached = true
    }
    if (!state.attached) {
      await chrome.debugger.sendCommand({ tabId }, "Runtime.enable")
      await chrome.debugger.sendCommand({ tabId }, "Page.enable")
      state.attached = true
    } else {
      // Reclaim after SW restart: re-enable domains without re-attach.
      try {
        await chrome.debugger.sendCommand({ tabId }, "Runtime.enable")
        await chrome.debugger.sendCommand({ tabId }, "Page.enable")
      } catch (e) {
        // If session is dead, clear and rethrow so caller sees failure.
        state.attached = false
        throw e
      }
    }
    state.unavailableReason = undefined
  } catch (e) {
    console.warn("[OpenCode] Failed to attach debugger:", e.message || e)
    state.attached = false
    state.unavailableReason = e?.message || String(e)
  }

  return state
}

if (chrome.debugger?.onEvent) {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    // Recreate state if the service worker restarted mid-session.
    const state = getOrCreateDebuggerState(source.tabId)
    state.attached = true

    if (method === "Runtime.consoleAPICalled") {
      if (state.consoleMessages.length >= MAX_LOG_ENTRIES) {
        state.consoleMessages.shift()
      }
      state.consoleMessages.push({
        type: params.type,
        text: params.args.map((a) => a.value ?? a.description ?? "").join(" "),
        timestamp: Date.now(),
        source: params.stackTrace?.callFrames?.[0]?.url,
        line: params.stackTrace?.callFrames?.[0]?.lineNumber,
      })
    }

    if (method === "Runtime.exceptionThrown") {
      if (state.pageErrors.length >= MAX_LOG_ENTRIES) {
        state.pageErrors.shift()
      }
      state.pageErrors.push({
        message: params.exceptionDetails.text,
        source: params.exceptionDetails.url,
        line: params.exceptionDetails.lineNumber,
        column: params.exceptionDetails.columnNumber,
        stack: params.exceptionDetails.exception?.description,
        timestamp: Date.now(),
      })
    }

    if (method === "Page.javascriptDialogOpening") {
      state.pendingDialog = {
        type: params.type,
        message: params.message,
        defaultPrompt: params.defaultPrompt,
        url: params.url,
        hasBrowserHandler: params.hasBrowserHandler,
        timestamp: Date.now(),
      }
    }

    if (method === "Page.javascriptDialogClosed") {
      state.pendingDialog = null
    }
  })
}

if (chrome.debugger?.onDetach) {
  chrome.debugger.onDetach.addListener((source) => {
    if (debuggerState.has(source.tabId)) {
      const state = debuggerState.get(source.tabId)
      state.attached = false
      state.pendingDialog = null
    }
  })
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (debuggerState.has(tabId)) {
    if (chrome.debugger?.detach) chrome.debugger.detach({ tabId }).catch(() => {})
    debuggerState.delete(tabId)
  }
})

chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.25 })

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    if (!isConnected) connect().catch(() => {})
  }
})

async function connect() {
  if (port) {
    try {
      port.disconnect()
    } catch {}
    port = null
  }

  const nativeMessagingAllowed = await hasNativeMessagingPermission()
  if (!nativeMessagingAllowed) {
    isConnected = false
    updateBadge(false)
    if (!nativePermissionHintLogged) {
      nativePermissionHintLogged = true
      console.log(`[OpenCode] Native messaging permission not granted. ${PERMISSION_HINT}`)
    }
    return
  }

  nativePermissionHintLogged = false

  try {
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME)

    port.onMessage.addListener((message) => {
      handleMessage(message).catch((e) => {
        console.error("[OpenCode] Message handler error:", e)
      })
    })

    port.onDisconnect.addListener(() => {
      isConnected = false
      port = null
      updateBadge(false)

      const err = chrome.runtime.lastError
      if (err?.message) {
        connectionAttempts++
        if (connectionAttempts === 1) {
          console.log("[OpenCode] Native host not available. Run: npx @ageless-h/opencode-browser install")
        } else if (connectionAttempts % 20 === 0) {
          console.log("[OpenCode] Still waiting for native host...")
        }
      }
    })

    isConnected = true
    connectionAttempts = 0
    updateBadge(true)
  } catch (e) {
    isConnected = false
    updateBadge(false)
    console.error("[OpenCode] connectNative failed:", e)
  }
}

function updateBadge(connected) {
  chrome.action.setBadgeText({ text: connected ? "ON" : "" })
  chrome.action.setBadgeBackgroundColor({ color: connected ? "#22c55e" : "#ef4444" })
}

function send(message) {
  if (!port) return false
  try {
    port.postMessage(message)
    return true
  } catch {
    return false
  }
}

async function handleMessage(message) {
  if (!message || typeof message !== "object") return

  if (message.type === "tool_request") {
    await handleToolRequest(message)
  } else if (message.type === "ping") {
    send({ type: "pong" })
  }
}

async function handleToolRequest(request) {
  const { id, tool, args } = request

  try {
    const result = await executeTool(tool, args || {})
    send({ type: "tool_response", id, result })
  } catch (error) {
    send({
      type: "tool_response",
      id,
      error: { content: error?.message || String(error) },
    })
  }
}

async function executeTool(toolName, args) {
  const tools = {
    get_active_tab: toolGetActiveTab,
    get_tabs: toolGetTabs,
    open_tab: toolOpenTab,
    close_tab: toolCloseTab,
    name_session: toolNameSession,
    group_tabs: toolGroupTabs,
    navigate: toolNavigate,
    back: toolBack,
    forward: toolForward,
    reload: toolReload,
    set_active_tab: toolSetActiveTab,
    key: toolKey,
    handle_dialog: toolHandleDialog,
    click: toolClick,
    type: toolType,
    select: toolSelect,
    screenshot: toolScreenshot,
    snapshot: toolSnapshot,
    query: toolQuery,
    scroll: toolScroll,
    wait: toolWait,
    download: toolDownload,
    list_downloads: toolListDownloads,
    set_file_input: toolSetFileInput,
    highlight: toolHighlight,
    console: toolConsole,
    errors: toolErrors,
    history: toolHistory,
    // Codex Playwright subset
    count: toolCount,
    is_visible: toolIsVisible,
    is_enabled: toolIsEnabled,
    get_attribute: toolGetAttribute,
    text_content: toolTextContent,
    inner_text: toolInnerText,
    dblclick: toolDblclick,
    check: toolCheck,
    uncheck: toolUncheck,
    set_checked: toolSetChecked,
    fill: toolFill,
    wait_for: toolWaitFor,
    wait_for_load_state: toolWaitForLoadState,
    wait_for_url: toolWaitForUrl,
    evaluate: toolEvaluate,
    export: toolExport,
    get_js_dialog: toolGetJsDialog,
    title: toolTitle,
    url: toolUrl,
    // P4a Codex gaps
    clipboard_read_text: toolClipboardReadText,
    clipboard_write_text: toolClipboardWriteText,
    all_text_contents: toolAllTextContents,
    element_info: toolElementInfo,
    // P4b Codex capabilities
    capabilities_list: toolCapabilitiesList,
    viewport_set: toolViewportSet,
    viewport_reset: toolViewportReset,
    // P5 remaining gaps
    locator_all: toolLocatorAll,
    press: toolPress,
    download_media: toolDownloadMedia,
    mouse_move: toolMouseMove,
    mouse_click: toolMouseClick,
    mouse_dblclick: toolMouseDblclick,
    drag: toolDrag,
    get_visible_dom: toolGetVisibleDom,
    element_screenshot: toolElementScreenshot,
  }

  const fn = tools[toolName]
  if (!fn) throw new Error(`Unknown tool: ${toolName}`)
  return await fn(args)
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) throw new Error("No active tab found")
  return tab
}

async function getTabById(tabId) {
  return tabId ? await chrome.tabs.get(tabId) : await getActiveTab()
}

async function runInPage(tabId, command, args) {
  const hasHostAccess = await hasHostAccessPermission()
  if (!hasHostAccess) {
    throw new Error(`Site access permission not granted. ${PERMISSION_HINT}`)
  }

  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: pageOps,
      args: [command, args || {}],
      world: "ISOLATED",
    })
    return result[0]?.result
  } catch (error) {
    const message = error?.message || String(error)
    if (message.includes("Cannot access contents of the page")) {
      throw new Error(`Site access permission not granted for this page. ${PERMISSION_HINT}`)
    }
    throw error
  }
}

async function pageOps(command, args) {
  const options = args || {}
  const MAX_DEPTH = 6
  const DEFAULT_TIMEOUT_MS = 2000

  function safeString(value) {
    return typeof value === "string" ? value : ""
  }

  const SENSITIVE_NAME_RE = /passw|pwd|token|secret|api[-_]?key|otp|csrf|session/i

  function isSensitiveField(el) {
    if (!el || !el.tagName) return false
    const type = String(el.getAttribute?.("type") || "").toLowerCase()
    if (type === "password" || type === "hidden") return true
    const autocomplete = String(el.getAttribute?.("autocomplete") || "").toLowerCase()
    if (["current-password", "new-password", "one-time-code"].includes(autocomplete)) return true
    const nameId = `${el.getAttribute?.("name") || ""} ${el.id || ""}`
    return SENSITIVE_NAME_RE.test(nameId)
  }

  function serializeFormValue(el) {
    if (isSensitiveField(el)) return "[REDACTED]"
    return el.value
  }

  function normalizeSelectorList(selector) {
    if (Array.isArray(selector)) {
      return selector.map((s) => safeString(s).trim()).filter(Boolean)
    }
    // A string is always exactly one selector/locator — never split on commas.
    // CSS comma lists ("button, a") still work natively via querySelectorAll.
    if (typeof selector !== "string") return []
    const trimmed = selector.trim()
    return trimmed ? [trimmed] : []
  }

  function stripQuotes(value) {
    return safeString(value).replace(/^['"]|['"]$/g, "")
  }

  function normalizeText(value) {
    return safeString(value).replace(/\s+/g, " ").trim().toLowerCase()
  }

  function matchesText(value, target) {
    if (!target) return false
    const normTarget = normalizeText(target)
    if (!normTarget) return false
    const normValue = normalizeText(value)
    return normValue === normTarget || normValue.includes(normTarget)
  }

  function normalizeLocatorKey(key) {
    if (key === "css") return "css"
    if (key === "label" || key === "field") return "label"
    if (key === "aria" || key === "aria-label") return "aria"
    if (key === "placeholder") return "placeholder"
    if (key === "name") return "name"
    if (key === "role") return "role"
    if (key === "text") return "text"
    if (key === "id") return "id"
    if (key === "uid") return "uid"
    return null
  }

  function parseRoleValue(value) {
    // role:button[name=Submit] | role:button[name="Submit"] | role:button
    const raw = safeString(value).trim()
    const m = raw.match(/^([^\[]+?)(?:\s*\[\s*name\s*=\s*(['"]?)(.*?)\2\s*\])?$/i)
    if (!m) return { role: raw, name: null }
    return {
      role: safeString(m[1]).trim(),
      name: m[3] != null && m[3] !== "" ? m[3] : null,
    }
  }

  function parseLocator(raw) {
    const trimmed = safeString(raw).trim()
    if (!trimmed) return { kind: "css", value: "", raw: "" }
    const match = trimmed.match(/^([a-zA-Z_-]+)\s*(=|:)\s*(.+)$/)
    if (match) {
      const key = match[1].toLowerCase()
      const kind = normalizeLocatorKey(key)
      if (kind) {
        const value = stripQuotes(match[3])
        if (kind === "role") {
          const parsed = parseRoleValue(match[3].trim())
          return {
            kind: "role",
            value: parsed.role,
            name: parsed.name,
            raw: trimmed,
          }
        }
        return { kind, value, raw: trimmed }
      }
    }
    return { kind: "css", value: trimmed, raw: trimmed }
  }

  function getAccessibleName(el) {
    if (!el) return ""
    const aria = el.getAttribute?.("aria-label")
    if (aria) return aria
    const labelled = getAriaLabelledByText(el)
    if (labelled.trim()) return labelled
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
      if (el.labels && el.labels.length) {
        const parts = []
        for (const label of el.labels) {
          parts.push(label.innerText || label.textContent || "")
        }
        const joined = parts.join(" ").trim()
        if (joined) return joined
      }
      const placeholder = el.getAttribute?.("placeholder")
      if (placeholder) return placeholder
      if (el.tagName === "INPUT" && (el.type === "button" || el.type === "submit" || el.type === "reset")) {
        return el.value || ""
      }
    }
    const alt = el.getAttribute?.("alt")
    if (alt) return alt
    const title = el.getAttribute?.("title")
    if (title) return title
    const txt = safeString(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim()
    return txt.slice(0, 200)
  }

  function getImplicitRole(el) {
    if (!el || !el.tagName) return ""
    const explicit = el.getAttribute?.("role")
    if (explicit) return explicit.toLowerCase()
    const tag = el.tagName.toLowerCase()
    const type = (el.getAttribute?.("type") || "").toLowerCase()
    if (tag === "a" && el.hasAttribute("href")) return "link"
    if (tag === "button") return "button"
    if (tag === "input") {
      if (type === "button" || type === "submit" || type === "reset" || type === "image") return "button"
      if (type === "checkbox") return "checkbox"
      if (type === "radio") return "radio"
      if (type === "range") return "slider"
      if (type === "number") return "spinbutton"
      if (type === "search") return "searchbox"
      return "textbox"
    }
    if (tag === "textarea") return "textbox"
    if (tag === "select") return el.multiple ? "listbox" : "combobox"
    if (tag === "img") return "img"
    if (tag === "nav") return "navigation"
    if (tag === "main") return "main"
    if (tag === "header") return "banner"
    if (tag === "footer") return "contentinfo"
    if (tag === "aside") return "complementary"
    if (tag === "form") return "form"
    if (tag === "table") return "table"
    if (tag === "ul" || tag === "ol") return "list"
    if (tag === "li") return "listitem"
    if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4" || tag === "h5" || tag === "h6") return "heading"
    if (tag === "option") return "option"
    if (tag === "summary") return "button"
    if (el.isContentEditable) return "textbox"
    return tag
  }

  function candidateSummary(el, idx) {
    return {
      index: idx,
      uid: el.getAttribute?.("data-opc-uid") || null,
      role: getImplicitRole(el),
      name: getAccessibleName(el).slice(0, 120),
      tag: (el.tagName || "").toLowerCase(),
      id: el.id || null,
    }
  }

  function strictMatchError(selectorUsed, matches) {
    const candidates = matches.slice(0, 10).map((el, i) => candidateSummary(el, i))
    return {
      ok: false,
      error: `Strict mode: selector matched ${matches.length} elements. Pass index to disambiguate, or use a more specific locator (uid:…).`,
      selectorUsed,
      count: matches.length,
      candidates,
    }
  }

  function isVisible(el) {
    if (!el) return false
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    const style = window.getComputedStyle(el)
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false
    return true
  }

  function deepQuerySelectorAll(sel, rootDoc) {
    const out = []
    const seen = new Set()

    function addAll(nodeList) {
      for (const el of nodeList) {
        if (!el || seen.has(el)) continue
        seen.add(el)
        out.push(el)
      }
    }

    function walkRoot(root, depth) {
      if (!root || depth > MAX_DEPTH) return
      try {
        addAll(root.querySelectorAll(sel))
      } catch {
        return
      }

      const tree = root.querySelectorAll ? root.querySelectorAll("*") : []
      for (const el of tree) {
        if (el.shadowRoot) {
          walkRoot(el.shadowRoot, depth + 1)
        }
      }

      const frames = root.querySelectorAll ? root.querySelectorAll("iframe") : []
      for (const frame of frames) {
        try {
          const doc = frame.contentDocument
          if (doc) walkRoot(doc, depth + 1)
        } catch {}
      }
    }

    walkRoot(rootDoc || document, 0)
    return out
  }

  function getAriaLabelledByText(el) {
    const ids = safeString(el?.getAttribute?.("aria-labelledby")).split(/\s+/).filter(Boolean)
    if (!ids.length) return ""
    const parts = []
    for (const id of ids) {
      const ref = document.getElementById(id)
      if (ref) parts.push(ref.innerText || ref.textContent || "")
    }
    return parts.join(" ")
  }

  function findByAttribute(attr, target, allowedTags) {
    if (!target) return []
    const nodes = deepQuerySelectorAll(`[${attr}]`, document)
    return nodes.filter((el) => {
      if (Array.isArray(allowedTags) && allowedTags.length && !allowedTags.includes(el.tagName)) return false
      return matchesText(el.getAttribute(attr), target)
    })
  }

  function findByLabelText(target) {
    if (!target) return []
    const results = []
    const seen = new Set()
    const labels = deepQuerySelectorAll("label", document)
    for (const label of labels) {
      if (!matchesText(label.innerText || label.textContent || "", target)) continue
      const control = label.control || label.querySelector("input, textarea, select")
      if (control && !seen.has(control)) {
        seen.add(control)
        results.push(control)
      }
    }
    const labelled = deepQuerySelectorAll("[aria-labelledby]", document)
    for (const el of labelled) {
      if (!matchesText(getAriaLabelledByText(el), target)) continue
      if (!seen.has(el)) {
        seen.add(el)
        results.push(el)
      }
    }
    return results
  }

  function findByRole(target, nameFilter) {
    if (!target) return []
    const roleTarget = normalizeText(target)
    if (!roleTarget) return []
    // Prefer interactive / landmark-ish candidates for performance
    const nodes = deepQuerySelectorAll(
      "a, button, input, textarea, select, option, summary, [role], [contenteditable='true'], h1, h2, h3, h4, h5, h6, nav, main, header, footer, aside, form, table, ul, ol, li, img",
      document
    )
    const seen = new Set()
    const out = []
    for (const el of nodes) {
      if (seen.has(el)) continue
      const role = getImplicitRole(el)
      if (!role || normalizeText(role) !== roleTarget) continue
      if (nameFilter) {
        if (!matchesText(getAccessibleName(el), nameFilter)) continue
      }
      seen.add(el)
      out.push(el)
    }
    return out
  }

  function findByUid(target) {
    const uid = safeString(target).trim()
    if (!uid) return []
    const escaped = window.CSS && window.CSS.escape ? window.CSS.escape(uid) : uid.replace(/[^a-zA-Z0-9_-]/g, "\\$&")
    return deepQuerySelectorAll(`[data-opc-uid="${escaped}"]`, document)
  }

  function findByName(target) {
    return findByAttribute("name", target)
  }

  function findByText(target) {
    if (!target) return []
    const results = []
    const seen = new Set()
    const candidates = deepQuerySelectorAll(
      "button, a, label, option, summary, [role='button'], [role='link'], [role='tab'], [role='menuitem'], [role='option'], [role='listitem'], [role='row'], [tabindex]",
      document
    )
    for (const el of candidates) {
      if (!matchesText(el.innerText || el.textContent || "", target)) continue
      if (!seen.has(el)) {
        seen.add(el)
        results.push(el)
      }
    }

    const generic = deepQuerySelectorAll("div, span, li, article", document)
    for (const el of generic) {
      if (!matchesText(el.innerText || el.textContent || "", target)) continue
      const style = window.getComputedStyle(el)
      const likelyInteractive =
        !!el.getAttribute("onclick") ||
        !!el.getAttribute("role") ||
        el.tabIndex >= 0 ||
        style.cursor === "pointer"
      if (!likelyInteractive) continue
      if (!seen.has(el)) {
        seen.add(el)
        results.push(el)
      }
    }

    const inputs = deepQuerySelectorAll("input[type='button'], input[type='submit'], input[type='reset']", document)
    for (const el of inputs) {
      if (!matchesText(el.value || "", target)) continue
      if (!seen.has(el)) {
        seen.add(el)
        results.push(el)
      }
    }
    return results
  }

  function resolveLocator(locator) {
    if (locator.kind === "css") {
      const value = safeString(locator.value)
      if (!value) return []
      return deepQuerySelectorAll(value, document)
    }

    if (locator.kind === "label") return findByLabelText(locator.value)
    if (locator.kind === "aria") return findByAttribute("aria-label", locator.value)
    if (locator.kind === "placeholder") return findByAttribute("placeholder", locator.value, ["INPUT", "TEXTAREA"])
    if (locator.kind === "name") return findByName(locator.value)
    if (locator.kind === "role") return findByRole(locator.value, locator.name)
    if (locator.kind === "text") return findByText(locator.value)
    if (locator.kind === "uid") return findByUid(locator.value)

    if (locator.kind === "id") {
      const idValue = safeString(locator.value).trim()
      if (!idValue) return []
      const escaped = window.CSS && window.CSS.escape ? window.CSS.escape(idValue) : idValue.replace(/[^a-zA-Z0-9_-]/g, "\\$&")
      return deepQuerySelectorAll(`#${escaped}`, document)
    }

    return []
  }

  function resolveMatchesOnce(selectors, index, strict) {
    for (const sel of selectors) {
      const locator = parseLocator(sel)
      if (!locator.value) continue
      const matches = resolveLocator(locator)
      if (!matches.length) continue
      const visible = matches.filter(isVisible)
      const pool = visible.length ? visible : matches
      let chosen = null
      let ambiguous = false
      if (Number.isFinite(index)) {
        chosen = pool[index] || matches[index] || null
      } else if (strict && pool.length > 1) {
        ambiguous = true
        chosen = null
      } else {
        chosen = pool[0] || null
      }
      return {
        selectorUsed: locator.raw,
        matches: pool,
        allMatches: matches,
        chosen,
        ambiguous,
      }
    }
    return { selectorUsed: selectors[0] || "", matches: [], allMatches: [], chosen: null, ambiguous: false }
  }

  async function resolveMatches(selectors, index, timeoutMs, pollMs, strict = false) {
    let match = resolveMatchesOnce(selectors, index, strict)
    if (timeoutMs > 0) {
      const start = Date.now()
      while (!match.matches.length && Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, pollMs))
        match = resolveMatchesOnce(selectors, index, strict)
      }
    }
    return match
  }

  function resolveActionMatch(selectors, index, timeoutMs, pollMs) {
    // Strict: omit index → require unique match. Explicit index disambiguates.
    const hasIndex = Number.isFinite(index)
    return resolveMatches(selectors, hasIndex ? index : undefined, timeoutMs, pollMs, !hasIndex)
  }

  function clickElement(el) {
    try {
      el.scrollIntoView({ block: "center", inline: "center" })
    } catch {}

    const rect = el.getBoundingClientRect()
    const x = Math.min(Math.max(rect.left + rect.width / 2, 0), window.innerWidth - 1)
    const y = Math.min(Math.max(rect.top + rect.height / 2, 0), window.innerHeight - 1)
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }

    try {
      el.dispatchEvent(new MouseEvent("mouseover", opts))
      el.dispatchEvent(new MouseEvent("mousemove", opts))
      el.dispatchEvent(new MouseEvent("mousedown", opts))
      el.dispatchEvent(new MouseEvent("mouseup", opts))
      el.dispatchEvent(new MouseEvent("click", opts))
    } catch {}
  }

  function setNativeValue(el, value) {
    const tag = el.tagName
    if (tag === "INPUT" || tag === "TEXTAREA") {
      const proto = tag === "INPUT" ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set
      if (setter) setter.call(el, value)
      else el.value = value
      return true
    }
    return false
  }

  function setSelectValue(el, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set
    if (setter) setter.call(el, value)
    else el.value = value
  }

  function getInputValues() {
    const out = []
    const nodes = document.querySelectorAll("input, textarea")
    nodes.forEach((el) => {
      try {
        const name = el.getAttribute("aria-label") || el.getAttribute("name") || el.id || el.className || el.tagName
        const value = serializeFormValue(el)
        if (value != null && String(value).trim()) out.push(`${name}: ${value}`)
      } catch {}
    })
    return out.join("\n")
  }

  function getPseudoText() {
    const out = []
    const elements = Array.from(document.querySelectorAll("*"))
    for (let i = 0; i < elements.length && out.length < 2000; i++) {
      const el = elements[i]
      try {
        const style = window.getComputedStyle(el)
        if (style.display === "none" || style.visibility === "hidden") continue
        const before = window.getComputedStyle(el, "::before").content
        const after = window.getComputedStyle(el, "::after").content
        const pushContent = (content) => {
          if (!content) return
          const c = String(content)
          if (!c || c === "none" || c === "normal") return
          const unquoted = c.replace(/^"|"$/g, "").replace(/^'|'$/g, "")
          if (unquoted && unquoted !== "none" && unquoted !== "normal") out.push(unquoted)
        }
        pushContent(before)
        pushContent(after)
      } catch {}
    }
    return out.join("\n")
  }

  function buildMatches(text, pattern, flags) {
    if (!pattern) return []
    try {
      const re = new RegExp(pattern, flags || "")
      const found = []
      let m
      while ((m = re.exec(text)) && found.length < 50) {
        found.push(m[0])
        if (!re.global) break
      }
      return found
    } catch {
      return []
    }
  }

  function getPageText(limit, pattern, flags) {
    const parts = []
    const bodyText = safeString(document.body?.innerText || "")
    if (bodyText.trim()) parts.push(bodyText)
    const inputValues = getInputValues()
    if (inputValues) parts.push(inputValues)
    const pseudo = getPseudoText()
    if (pseudo) parts.push(pseudo)
    const text = parts.filter(Boolean).join("\n\n").slice(0, Math.max(0, limit))
    return {
      url: location.href,
      title: document.title,
      text,
      matches: buildMatches(text, pattern, flags),
    }
  }

  const mode = typeof options.mode === "string" && options.mode ? options.mode : "text"
  const selectors = normalizeSelectorList(options.selector)
  // Preserve undefined so action tools can enforce strict unique-match mode.
  const index = Number.isFinite(options.index) ? options.index : undefined
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : 200
  const limit = Number.isFinite(options.limit) ? options.limit : mode === "page_text" ? 20000 : 50
  const pattern = typeof options.pattern === "string" ? options.pattern : null
  const flags = typeof options.flags === "string" ? options.flags : "i"
  const queryIndex = Number.isFinite(index) ? index : 0

  if (command === "click") {
    const match = await resolveActionMatch(selectors, index, timeoutMs, pollMs)
    if (match.ambiguous) return strictMatchError(match.selectorUsed, match.matches)
    if (!match.chosen) {
      return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
    }
    clickElement(match.chosen)
    return {
      ok: true,
      selectorUsed: match.selectorUsed,
      uid: match.chosen.getAttribute?.("data-opc-uid") || null,
      count: match.matches.length,
    }
  }

  if (command === "type") {
    const text = options.text
    const shouldClear = !!options.clear
    const match = await resolveActionMatch(selectors, index, timeoutMs, pollMs)
    if (match.ambiguous) return strictMatchError(match.selectorUsed, match.matches)
    if (!match.chosen) {
      return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
    }

    try {
      match.chosen.scrollIntoView({ block: "center", inline: "center" })
    } catch {}

    try {
      match.chosen.focus()
    } catch {}

    const tag = match.chosen.tagName
    const isTextInput = tag === "INPUT" || tag === "TEXTAREA"

    if (isTextInput) {
      if (shouldClear) setNativeValue(match.chosen, "")
      setNativeValue(match.chosen, (match.chosen.value || "") + text)
      match.chosen.dispatchEvent(new Event("input", { bubbles: true }))
      match.chosen.dispatchEvent(new Event("change", { bubbles: true }))
      return {
        ok: true,
        selectorUsed: match.selectorUsed,
        uid: match.chosen.getAttribute?.("data-opc-uid") || null,
        count: match.matches.length,
      }
    }

    if (match.chosen.isContentEditable) {
      if (shouldClear) match.chosen.textContent = ""
      try {
        document.execCommand("insertText", false, text)
      } catch {
        match.chosen.textContent = (match.chosen.textContent || "") + text
      }
      match.chosen.dispatchEvent(new Event("input", { bubbles: true }))
      return {
        ok: true,
        selectorUsed: match.selectorUsed,
        uid: match.chosen.getAttribute?.("data-opc-uid") || null,
        count: match.matches.length,
      }
    }

    return { ok: false, error: `Element is not typable: ${match.selectorUsed} (${tag.toLowerCase()})` }
  }

  if (command === "select") {
    const value = typeof options.value === "string" ? options.value : null
    const label = typeof options.label === "string" ? options.label : null
    const optionIndex = Number.isFinite(options.optionIndex) ? options.optionIndex : null
    const match = await resolveActionMatch(selectors, index, timeoutMs, pollMs)
    if (match.ambiguous) return strictMatchError(match.selectorUsed, match.matches)
    if (!match.chosen) {
      return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
    }

    const tag = match.chosen.tagName
    if (tag !== "SELECT") {
      return { ok: false, error: `Element is not a select: ${match.selectorUsed} (${tag.toLowerCase()})` }
    }

    if (value === null && label === null && optionIndex === null) {
      return { ok: false, error: "value, label, or optionIndex is required" }
    }

    const selectEl = match.chosen
    const optionList = Array.from(selectEl.options || [])
    let option = null

    if (value !== null) {
      option = optionList.find((opt) => opt.value === value)
    }

    if (!option && label !== null) {
      const target = label.trim()
      option = optionList.find((opt) => (opt.label || opt.textContent || "").trim() === target)
    }

    if (!option && optionIndex !== null) {
      option = optionList[optionIndex]
    }

    if (!option) {
      return { ok: false, error: "Option not found" }
    }

    try {
      selectEl.scrollIntoView({ block: "center", inline: "center" })
    } catch {}

    try {
      selectEl.focus()
    } catch {}

    setSelectValue(selectEl, option.value)
    option.selected = true
    selectEl.dispatchEvent(new Event("input", { bubbles: true }))
    selectEl.dispatchEvent(new Event("change", { bubbles: true }))

    return {
      ok: true,
      selectorUsed: match.selectorUsed,
      value: selectEl.value,
      label: (option.label || option.textContent || "").trim(),
      uid: selectEl.getAttribute?.("data-opc-uid") || null,
      count: match.matches.length,
    }
  }

  if (command === "set_file_input") {
    const rawFiles = Array.isArray(options.files) ? options.files : options.files ? [options.files] : []
    if (!rawFiles.length) return { ok: false, error: "files is required" }

    const match = await resolveActionMatch(selectors, index, timeoutMs, pollMs)
    if (match.ambiguous) return strictMatchError(match.selectorUsed, match.matches)
    if (!match.chosen) {
      return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
    }

    const tag = match.chosen.tagName
    if (tag !== "INPUT" || match.chosen.type !== "file") {
      return { ok: false, error: `Element is not a file input: ${match.selectorUsed} (${tag.toLowerCase()})` }
    }

    function decodeBase64(value) {
      const raw = safeString(value)
      const b64 = raw.includes(",") ? raw.split(",").pop() : raw
      const binary = atob(b64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      return bytes
    }

    const dt = new DataTransfer()
    const names = []

    for (const fileInfo of rawFiles) {
      const name = safeString(fileInfo?.name) || "upload.bin"
      const mimeType = safeString(fileInfo?.mimeType) || "application/octet-stream"
      const base64 = safeString(fileInfo?.base64)
      if (!base64) return { ok: false, error: "file.base64 is required" }
      const bytes = decodeBase64(base64)
      const file = new File([bytes], name, { type: mimeType, lastModified: Date.now() })
      dt.items.add(file)
      names.push(name)
    }

    try {
      match.chosen.scrollIntoView({ block: "center", inline: "center" })
    } catch {}

    try {
      match.chosen.focus()
    } catch {}

    try {
      match.chosen.files = dt.files
    } catch {
      try {
        Object.defineProperty(match.chosen, "files", { value: dt.files, writable: false })
      } catch {
        return { ok: false, error: "Failed to set file input" }
      }
    }

    match.chosen.dispatchEvent(new Event("input", { bubbles: true }))
    match.chosen.dispatchEvent(new Event("change", { bubbles: true }))

    return { ok: true, selectorUsed: match.selectorUsed, count: dt.files.length, names }
  }

  if (command === "focus") {
    // Resolve + focus only (used by the trusted CDP keyboard path).
    if (!selectors.length) return { ok: false, error: "Selector is required" }
    const match = await resolveActionMatch(selectors, index, timeoutMs, pollMs)
    if (match.ambiguous) return strictMatchError(match.selectorUsed, match.matches)
    if (!match.chosen) {
      return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
    }
    try {
      match.chosen.focus()
    } catch {}
    return {
      ok: true,
      selectorUsed: match.selectorUsed,
      uid: match.chosen.getAttribute?.("data-opc-uid") || null,
    }
  }

  if (command === "key") {
    const key = typeof options.key === "string" ? options.key : ""
    if (!key) return { ok: false, error: "key is required" }

    const code = typeof options.code === "string" && options.code ? options.code : key
    const keyCode = Number.isFinite(options.keyCode) ? options.keyCode : undefined
    const ctrlKey = !!options.ctrlKey
    const metaKey = !!options.metaKey
    const altKey = !!options.altKey
    const shiftKey = !!options.shiftKey
    const repeat = !!options.repeat
    const delayMs = Number.isFinite(options.delayMs) ? Math.max(0, options.delayMs) : 0

    let target = document.activeElement
    if (selectors.length) {
      const match = await resolveActionMatch(selectors, index, timeoutMs, pollMs)
      if (match.ambiguous) return strictMatchError(match.selectorUsed, match.matches)
      if (!match.chosen) {
        return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
      }
      target = match.chosen
      try {
        target.focus()
      } catch {}
    }

    if (!target || target === document.body) {
      target = document.activeElement || document.body || document.documentElement
    }

    const eventInit = {
      key,
      code,
      bubbles: true,
      cancelable: true,
      composed: true,
      ctrlKey,
      metaKey,
      altKey,
      shiftKey,
      repeat,
    }
    if (Number.isFinite(keyCode)) {
      eventInit.keyCode = keyCode
      eventInit.which = keyCode
      eventInit.charCode = key.length === 1 ? keyCode : 0
    }

    const down = new KeyboardEvent("keydown", eventInit)
    target.dispatchEvent(down)

    if (key.length === 1 && !ctrlKey && !metaKey && !altKey) {
      try {
        const tag = (target.tagName || "").toUpperCase()
        const isTextInput = tag === "INPUT" || tag === "TEXTAREA"
        if (isTextInput && !target.readOnly && !target.disabled) {
          const start = typeof target.selectionStart === "number" ? target.selectionStart : target.value.length
          const end = typeof target.selectionEnd === "number" ? target.selectionEnd : start
          const next = String(target.value || "").slice(0, start) + key + String(target.value || "").slice(end)
          const proto = tag === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
          const descriptor = Object.getOwnPropertyDescriptor(proto, "value")
          if (descriptor?.set) descriptor.set.call(target, next)
          else target.value = next
          const pos = start + key.length
          try {
            target.setSelectionRange(pos, pos)
          } catch {}
          target.dispatchEvent(new Event("input", { bubbles: true }))
        } else if (target.isContentEditable) {
          target.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, data: key, inputType: "insertText" }))
          // Best-effort insert for contenteditable when no framework handler
          if (document.getSelection) {
            const sel = document.getSelection()
            if (sel && sel.rangeCount) {
              const range = sel.getRangeAt(0)
              range.deleteContents()
              range.insertNode(document.createTextNode(key))
              range.collapse(false)
              sel.removeAllRanges()
              sel.addRange(range)
            }
          }
          target.dispatchEvent(new InputEvent("input", { bubbles: true, data: key, inputType: "insertText" }))
        }
      } catch {}
    }

    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs))
    }

    const up = new KeyboardEvent("keyup", eventInit)
    target.dispatchEvent(up)

    return {
      ok: true,
      key,
      code,
      target: (target.tagName || "").toLowerCase() || null,
    }
  }

  if (command === "scroll") {
    const scrollX = Number.isFinite(options.x) ? options.x : 0
    const scrollY = Number.isFinite(options.y) ? options.y : 0
    if (selectors.length) {
      const match = await resolveMatches(selectors, queryIndex, timeoutMs, pollMs)
      if (!match.chosen) {
        return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
      }
      if (scrollX || scrollY) {
        try {
          if (typeof match.chosen.scrollBy === "function") {
            match.chosen.scrollBy({ left: scrollX, top: scrollY, behavior: "smooth" })
          } else {
            match.chosen.scrollLeft = Number(match.chosen.scrollLeft || 0) + scrollX
            match.chosen.scrollTop = Number(match.chosen.scrollTop || 0) + scrollY
          }
        } catch {
          match.chosen.scrollLeft = Number(match.chosen.scrollLeft || 0) + scrollX
          match.chosen.scrollTop = Number(match.chosen.scrollTop || 0) + scrollY
        }
        return { ok: true, selectorUsed: match.selectorUsed, elementScroll: { x: scrollX, y: scrollY } }
      }

      try {
        match.chosen.scrollIntoView({ behavior: "smooth", block: "center" })
      } catch {}
      return { ok: true, selectorUsed: match.selectorUsed }
    }
    window.scrollBy(scrollX, scrollY)
    return { ok: true }
  }

  if (command === "highlight") {
    const duration = Number.isFinite(options.duration) ? options.duration : 3000
    const color = typeof options.color === "string" ? options.color : "#ff0000"
    const showInfo = !!options.showInfo

    const match = await resolveActionMatch(selectors, index, timeoutMs, pollMs)
    if (match.ambiguous) return strictMatchError(match.selectorUsed, match.matches)
    if (!match.chosen) {
      return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
    }

    const el = match.chosen
    const rect = el.getBoundingClientRect()

    // Remove any existing highlight overlay
    const existing = document.getElementById("__opc_highlight_overlay")
    if (existing) existing.remove()

    // Create overlay
    const overlay = document.createElement("div")
    overlay.id = "__opc_highlight_overlay"
    overlay.style.cssText = `
      position: fixed;
      top: ${rect.top}px;
      left: ${rect.left}px;
      width: ${rect.width}px;
      height: ${rect.height}px;
      border: 3px solid ${color};
      box-shadow: 0 0 10px ${color};
      pointer-events: none;
      z-index: 2147483647;
      transition: opacity 0.3s;
    `

    if (showInfo) {
      const info = document.createElement("div")
      info.style.cssText = `
        position: absolute;
        top: -25px;
        left: 0;
        background: ${color};
        color: white;
        padding: 2px 8px;
        font-size: 12px;
        font-family: monospace;
        border-radius: 3px;
        white-space: nowrap;
      `
      info.textContent = `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}`
      overlay.appendChild(info)
    }

    document.body.appendChild(overlay)

    setTimeout(() => {
      overlay.style.opacity = "0"
      setTimeout(() => overlay.remove(), 300)
    }, duration)

    return {
      ok: true,
      selectorUsed: match.selectorUsed,
      highlighted: true,
      tag: el.tagName,
      id: el.id || null,
      uid: el.getAttribute?.("data-opc-uid") || null,
    }
  }

  if (command === "query") {
    if (mode === "page_text") {
      if (selectors.length && timeoutMs > 0) {
        await resolveMatches(selectors, queryIndex, timeoutMs, pollMs)
      }
      return { ok: true, value: getPageText(limit, pattern, flags) }
    }

    if (!selectors.length) {
      return { ok: false, error: "Selector is required" }
    }

    const match = await resolveMatches(selectors, queryIndex, timeoutMs, pollMs)

    if (mode === "exists") {
      return {
        ok: true,
        selectorUsed: match.selectorUsed,
        value: { exists: match.matches.length > 0, count: match.matches.length },
      }
    }

    if (!match.chosen) {
      return { ok: false, error: `No matches for selectors: ${selectors.join(", ")}` }
    }

    if (mode === "text") {
      const text = (match.chosen.innerText || match.chosen.textContent || "").trim()
      return { ok: true, selectorUsed: match.selectorUsed, value: text }
    }

    if (mode === "value") {
      const value = match.chosen.value
      return { ok: true, selectorUsed: match.selectorUsed, value: typeof value === "string" ? value : String(value ?? "") }
    }

    if (mode === "attribute") {
      const value = options.attribute ? match.chosen.getAttribute(options.attribute) : null
      return { ok: true, selectorUsed: match.selectorUsed, value }
    }

    if (mode === "property") {
      if (!options.property) return { ok: false, error: "property is required" }
      return { ok: true, selectorUsed: match.selectorUsed, value: match.chosen[options.property] }
    }

    if (mode === "html") {
      return { ok: true, selectorUsed: match.selectorUsed, value: match.chosen.outerHTML }
    }

    if (mode === "list") {
      const maxItems = Math.min(Math.max(1, limit), 200)
      const items = match.matches.slice(0, maxItems).map((el) => ({
        text: (el.innerText || el.textContent || "").trim().slice(0, 200),
        tag: (el.tagName || "").toLowerCase(),
        ariaLabel: el.getAttribute ? el.getAttribute("aria-label") : null,
      }))
      return {
        ok: true,
        selectorUsed: match.selectorUsed,
        value: { items, count: match.matches.length },
      }
    }

    return { ok: false, error: `Unknown mode: ${mode}` }
  }

  // --- Codex Playwright-subset locator ops (flat tools) ---

  if (command === "count") {
    if (!selectors.length) return { ok: false, error: "Selector is required" }
    const match = await resolveMatches(selectors, 0, timeoutMs, pollMs)
    return {
      ok: true,
      selectorUsed: match.selectorUsed,
      count: match.matches.length,
    }
  }

  if (command === "is_visible") {
    if (!selectors.length) return { ok: false, error: "Selector is required" }
    const match = await resolveActionMatch(selectors, index, timeoutMs, pollMs)
    if (match.ambiguous) return strictMatchError(match.selectorUsed, match.matches)
    if (!match.chosen) {
      return { ok: true, selectorUsed: match.selectorUsed, value: false, count: 0 }
    }
    return {
      ok: true,
      selectorUsed: match.selectorUsed,
      value: isVisible(match.chosen),
      count: match.matches.length,
      uid: match.chosen.getAttribute?.("data-opc-uid") || null,
    }
  }

  if (command === "is_enabled") {
    if (!selectors.length) return { ok: false, error: "Selector is required" }
    const match = await resolveActionMatch(selectors, index, timeoutMs, pollMs)
    if (match.ambiguous) return strictMatchError(match.selectorUsed, match.matches)
    if (!match.chosen) {
      return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
    }
    const el = match.chosen
    const disabled =
      !!el.disabled ||
      el.getAttribute?.("aria-disabled") === "true" ||
      el.getAttribute?.("disabled") != null
    return {
      ok: true,
      selectorUsed: match.selectorUsed,
      value: !disabled,
      count: match.matches.length,
      uid: el.getAttribute?.("data-opc-uid") || null,
    }
  }

  if (command === "get_visible_dom") {
    // Codex dom_cua.get_visible_dom — visible interactable nodes with node ids.
    const limit = Math.min(1000, Math.max(1, Number(options.limit) || 500))
    const nodes = []
    let uidCounter = 0
    const interactive = document.querySelectorAll(
      "a, button, input, textarea, select, option, summary, [role='button'], [role='link'], [role='textbox'], [role='checkbox'], [role='radio'], [role='switch'], [role='menuitem'], [role='tab'], [role='option'], [contenteditable='true'], [tabindex]"
    )
    for (const el of interactive) {
      if (!isVisible(el)) continue
      let uid = el.getAttribute?.("data-opc-uid")
      if (!uid) {
        uid = `n${uidCounter++}`
        el.setAttribute("data-opc-uid", uid)
      }
      const rect = el.getBoundingClientRect()
      nodes.push({
        node_id: uid,
        tag: el.tagName.toLowerCase(),
        role: getImplicitRole(el),
        name: getAccessibleName(el).slice(0, 120),
        text: (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100),
        value: "value" in el ? String(serializeFormValue(el) ?? "") : null,
        boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      })
      if (nodes.length >= limit) break
    }
    return { ok: true, nodes, count: nodes.length }
  }

  if (command === "locator_all") {
    // Codex locator.all() — resolve to list of element descriptors
    if (!selectors.length) return { ok: false, error: "Selector is required" }
    const match = await resolveMatches(selectors, 0, Math.max(0, timeoutMs || DEFAULT_TIMEOUT_MS), pollMs)
    const items = match.matches.map((el, i) => ({
      index: i,
      uid: el.getAttribute?.("data-opc-uid") || null,
      tag: el.tagName?.toLowerCase() || "",
      role: getImplicitRole(el),
      name: getAccessibleName(el).slice(0, 120),
      visible: isVisible(el),
    }))
    return { ok: true, selectorUsed: match.selectorUsed, count: match.matches.length, items }
  }

  if (command === "press") {
    // Codex locator.press — focus selector then dispatch key event
    if (!selectors.length) return { ok: false, error: "Selector is required" }
    const key = safeString(options.key || options.keys?.[0] || "")
    if (!key) return { ok: false, error: "key is required" }
    const match = await resolveActionMatch(selectors, index, timeoutMs, pollMs)
    if (match.ambiguous) return strictMatchError(match.selectorUsed, match.matches)
    if (!match.chosen) return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
    try {
      match.chosen.focus()
    } catch {}
    const target = match.chosen
    const code = key.length === 1 ? key : null
    const eventInit = { bubbles: true, cancelable: true, key, code: code || key }
    target.dispatchEvent(new KeyboardEvent("keydown", eventInit))
    if (key.length === 1 && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
      // approximate typing for printable char
      const cur = target.isContentEditable ? target.innerText : target.value || ""
      const next = cur + key
      if (target.isContentEditable) target.innerText = next
      else setNativeValue(target, next)
      target.dispatchEvent(new Event("input", { bubbles: true }))
    }
    target.dispatchEvent(new KeyboardEvent("keyup", eventInit))
    return { ok: true, selectorUsed: match.selectorUsed, key, uid: target.getAttribute?.("data-opc-uid") || null }
  }

  if (command === "mouse_move") {
    const x = Number(options.x)
    const y = Number(options.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: "x and y required" }
    const el = document.elementFromPoint(x, y)
    const evt = new MouseEvent("mousemove", { clientX: x, clientY: y, bubbles: true, cancelable: true })
    ;(el || document.body || document.documentElement).dispatchEvent(evt)
    return { ok: true, x, y }
  }

  if (command === "mouse_click" || command === "mouse_dblclick") {
    const x = Number(options.x)
    const y = Number(options.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: "x and y required" }
    const el = document.elementFromPoint(x, y)
    if (!el) return { ok: false, error: `No element at (${x}, ${y})` }
    try {
      el.scrollIntoView({ block: "center", inline: "center" })
    } catch {}
    const init = { clientX: x, clientY: y, bubbles: true, cancelable: true, view: window }
    el.dispatchEvent(new MouseEvent("mousemove", init))
    el.dispatchEvent(new MouseEvent("mousedown", init))
    el.dispatchEvent(new MouseEvent("mouseup", init))
    el.dispatchEvent(new MouseEvent("click", init))
    if (command === "mouse_dblclick") {
      el.dispatchEvent(new MouseEvent("mousedown", init))
      el.dispatchEvent(new MouseEvent("mouseup", init))
      el.dispatchEvent(new MouseEvent("click", init))
      el.dispatchEvent(new MouseEvent("dblclick", init))
    }
    return {
      ok: true,
      x,
      y,
      tag: el.tagName?.toLowerCase() || "",
      uid: el.getAttribute?.("data-opc-uid") || null,
    }
  }

  if (command === "drag") {
    const path = Array.isArray(options.path) ? options.path : []
    if (path.length < 2) return { ok: false, error: "path must have at least 2 points" }
    const start = path[0]
    const end = path[path.length - 1]
    const fromEl = document.elementFromPoint(start.x, start.y)
    if (!fromEl) return { ok: false, error: `No element at start (${start.x}, ${start.y})` }
    fromEl.dispatchEvent(new MouseEvent("mousedown", { clientX: start.x, clientY: start.y, bubbles: true, cancelable: true, view: window }))
    for (const p of path.slice(1, -1)) {
      const el = document.elementFromPoint(p.x, p.y) || document.body
      el.dispatchEvent(new MouseEvent("mousemove", { clientX: p.x, clientY: p.y, bubbles: true, cancelable: true, view: window }))
      await new Promise((r) => setTimeout(r, 30))
    }
    const toEl = document.elementFromPoint(end.x, end.y) || document.body
    toEl.dispatchEvent(new MouseEvent("mousemove", { clientX: end.x, clientY: end.y, bubbles: true, cancelable: true, view: window }))
    toEl.dispatchEvent(new MouseEvent("mouseup", { clientX: end.x, clientY: end.y, bubbles: true, cancelable: true, view: window }))
    toEl.dispatchEvent(new MouseEvent("click", { clientX: end.x, clientY: end.y, bubbles: true, cancelable: true, view: window }))
    return { ok: true, from: { x: start.x, y: start.y }, to: { x: end.x, y: end.y }, points: path.length }
  }

  if (command === "download_media") {
    // Codex locator.downloadMedia — trigger download for media/link in first matched element
    if (!selectors.length) return { ok: false, error: "Selector is required" }
    const match = await resolveActionMatch(selectors, index, timeoutMs, pollMs)
    if (match.ambiguous) return strictMatchError(match.selectorUsed, match.matches)
    if (!match.chosen) return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
    const el = match.chosen
    let url = null
    if (el.tagName === "A") url = el.href
    else if (el.tagName === "IMG" || el.tagName === "VIDEO" || el.tagName === "AUDIO") url = el.src || el.currentSrc
    else {
      const img = el.querySelector?.("img, video, audio, a[href]")
      if (img) url = img.src || img.currentSrc || img.href
    }
    if (!url) return { ok: false, error: `No downloadable media/link at ${match.selectorUsed}` }
    const a = document.createElement("a")
    a.href = url
    a.download = ""
    a.rel = "noopener"
    a.target = "_blank"
    document.body.appendChild(a)
    a.click()
    a.remove()
    return { ok: true, url, selectorUsed: match.selectorUsed, uid: el.getAttribute?.("data-opc-uid") || null }
  }

  if (command === "element_screenshot") {
    // Codex playwright.elementScreenshot — annotate viewport at point (best-effort without canvas).
    // We return the element info plus probed point; real screenshot overlay can be layered later.
    const x = Number(options.x)
    const y = Number(options.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: "x and y required" }
    const stack = document.elementsFromPoint(x, y) || []
    const elements = []
    for (const el of stack) {
      if (!el || el === document.documentElement || el === document.body) continue
      const rect = el.getBoundingClientRect()
      elements.push({
        tagName: el.tagName.toLowerCase(),
        role: getImplicitRole(el),
        ariaName: getAccessibleName(el) || null,
        boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        uid: el.getAttribute?.("data-opc-uid") || null,
      })
      if (elements.length >= 12) break
    }
    return { ok: true, x, y, elements, note: "Annotation overlay not yet rendered; use browser_screenshot + element_info for visual." }
  }

  if (command === "get_attribute") {
    if (!selectors.length) return { ok: false, error: "Selector is required" }
    const name = typeof options.name === "string" ? options.name : options.attribute
    if (!name) return { ok: false, error: "name is required" }
    const match = await resolveActionMatch(selectors, index, timeoutMs, pollMs)
    if (match.ambiguous) return strictMatchError(match.selectorUsed, match.matches)
    if (!match.chosen) {
      return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
    }
    // Prefer live property for value/checked (HTML attribute stays initial; fill sets .value)
    let value = match.chosen.getAttribute(name)
    if (name === "value" && "value" in match.chosen) value = match.chosen.value
    if (name === "checked" && "checked" in match.chosen) value = String(!!match.chosen.checked)
    return {
      ok: true,
      selectorUsed: match.selectorUsed,
      name,
      value,
      uid: match.chosen.getAttribute?.("data-opc-uid") || null,
    }
  }

  if (command === "text_content") {
    if (!selectors.length) return { ok: false, error: "Selector is required" }
    const match = await resolveActionMatch(selectors, index, timeoutMs, pollMs)
    if (match.ambiguous) return strictMatchError(match.selectorUsed, match.matches)
    if (!match.chosen) {
      return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
    }
    return {
      ok: true,
      selectorUsed: match.selectorUsed,
      value: match.chosen.textContent,
      uid: match.chosen.getAttribute?.("data-opc-uid") || null,
    }
  }

  if (command === "inner_text") {
    if (!selectors.length) return { ok: false, error: "Selector is required" }
    const match = await resolveActionMatch(selectors, index, timeoutMs, pollMs)
    if (match.ambiguous) return strictMatchError(match.selectorUsed, match.matches)
    if (!match.chosen) {
      return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
    }
    return {
      ok: true,
      selectorUsed: match.selectorUsed,
      value: match.chosen.innerText || "",
      uid: match.chosen.getAttribute?.("data-opc-uid") || null,
    }
  }

  if (command === "dblclick") {
    if (!selectors.length) return { ok: false, error: "Selector is required" }
    const match = await resolveActionMatch(selectors, index, timeoutMs, pollMs)
    if (match.ambiguous) return strictMatchError(match.selectorUsed, match.matches)
    if (!match.chosen) {
      return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
    }
    try {
      match.chosen.scrollIntoView({ block: "center", inline: "center" })
    } catch {}
    const opts = { bubbles: true, cancelable: true, view: window, detail: 2 }
    match.chosen.dispatchEvent(new MouseEvent("mousedown", opts))
    match.chosen.dispatchEvent(new MouseEvent("mouseup", opts))
    match.chosen.dispatchEvent(new MouseEvent("click", opts))
    match.chosen.dispatchEvent(new MouseEvent("mousedown", opts))
    match.chosen.dispatchEvent(new MouseEvent("mouseup", opts))
    match.chosen.dispatchEvent(new MouseEvent("click", opts))
    match.chosen.dispatchEvent(new MouseEvent("dblclick", opts))
    return {
      ok: true,
      selectorUsed: match.selectorUsed,
      uid: match.chosen.getAttribute?.("data-opc-uid") || null,
      count: match.matches.length,
    }
  }

  if (command === "set_checked" || command === "check" || command === "uncheck") {
    if (!selectors.length) return { ok: false, error: "Selector is required" }
    let want
    if (command === "check") want = true
    else if (command === "uncheck") want = false
    else want = options.checked !== false && options.checked !== "false"

    const match = await resolveActionMatch(selectors, index, timeoutMs, pollMs)
    if (match.ambiguous) return strictMatchError(match.selectorUsed, match.matches)
    if (!match.chosen) {
      return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
    }
    const el = match.chosen
    const type = (el.getAttribute?.("type") || "").toLowerCase()
    const isCheckable =
      (el.tagName === "INPUT" && (type === "checkbox" || type === "radio")) ||
      el.getAttribute?.("role") === "checkbox" ||
      el.getAttribute?.("role") === "switch" ||
      el.getAttribute?.("role") === "menuitemcheckbox"

    if (!isCheckable && el.tagName !== "INPUT") {
      // Try associated label control or clickable
    }

    try {
      el.scrollIntoView({ block: "center", inline: "center" })
    } catch {}

    if (el.tagName === "INPUT" && (type === "checkbox" || type === "radio")) {
      if (!!el.checked !== !!want) {
        el.click()
      }
      if (!!el.checked !== !!want) {
        el.checked = !!want
        el.dispatchEvent(new Event("input", { bubbles: true }))
        el.dispatchEvent(new Event("change", { bubbles: true }))
      }
      return {
        ok: true,
        selectorUsed: match.selectorUsed,
        checked: !!el.checked,
        uid: el.getAttribute?.("data-opc-uid") || null,
      }
    }

    // ARIA checkbox/switch
    const ariaChecked = el.getAttribute?.("aria-checked")
    const currently = ariaChecked === "true" || ariaChecked === "mixed"
    if (currently !== !!want) {
      el.click()
    }
    return {
      ok: true,
      selectorUsed: match.selectorUsed,
      checked: want,
      uid: el.getAttribute?.("data-opc-uid") || null,
    }
  }

  if (command === "fill") {
    // Codex locator.fill ≈ clear + type
    if (!selectors.length) return { ok: false, error: "Selector is required" }
    if (options.text === undefined && options.value === undefined) {
      return { ok: false, error: "text or value is required" }
    }
    const text = options.text !== undefined ? String(options.text) : String(options.value)
    const match = await resolveActionMatch(selectors, index, timeoutMs, pollMs)
    if (match.ambiguous) return strictMatchError(match.selectorUsed, match.matches)
    if (!match.chosen) {
      return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
    }
    try {
      match.chosen.scrollIntoView({ block: "center", inline: "center" })
    } catch {}
    try {
      match.chosen.focus()
    } catch {}
    const tag = match.chosen.tagName
    const isTextInput = tag === "INPUT" || tag === "TEXTAREA"
    if (isTextInput) {
      setNativeValue(match.chosen, text)
      match.chosen.dispatchEvent(new Event("input", { bubbles: true }))
      match.chosen.dispatchEvent(new Event("change", { bubbles: true }))
      return {
        ok: true,
        selectorUsed: match.selectorUsed,
        uid: match.chosen.getAttribute?.("data-opc-uid") || null,
      }
    }
    if (match.chosen.isContentEditable) {
      match.chosen.textContent = ""
      try {
        document.execCommand("insertText", false, text)
      } catch {
        match.chosen.textContent = text
      }
      match.chosen.dispatchEvent(new Event("input", { bubbles: true }))
      return {
        ok: true,
        selectorUsed: match.selectorUsed,
        uid: match.chosen.getAttribute?.("data-opc-uid") || null,
      }
    }
    return { ok: false, error: `Element is not fillable: ${match.selectorUsed} (${tag.toLowerCase()})` }
  }

  if (command === "wait_for") {
    // Codex locator.waitFor({ state })
    if (!selectors.length) return { ok: false, error: "Selector is required" }
    const state = typeof options.state === "string" ? options.state : "visible"
    const deadline = Date.now() + Math.max(0, timeoutMs || DEFAULT_TIMEOUT_MS)
    const poll = Math.max(50, pollMs || 200)

    while (Date.now() <= deadline) {
      const match = await resolveMatches(selectors, Number.isFinite(index) ? index : 0, 0, poll)
      const el = match.chosen || match.matches[0] || null
      let ok = false
      if (state === "attached") ok = !!el
      else if (state === "detached") ok = !el
      else if (state === "visible") ok = !!el && isVisible(el)
      else if (state === "hidden") ok = !el || !isVisible(el)
      else return { ok: false, error: `Unknown wait_for state: ${state}` }

      if (ok) {
        return {
          ok: true,
          state,
          selectorUsed: match.selectorUsed,
          count: match.matches.length,
          uid: el?.getAttribute?.("data-opc-uid") || null,
        }
      }
      await new Promise((r) => setTimeout(r, poll))
    }
    return { ok: false, error: `Timed out waiting for ${selectors.join(", ")} state=${state}` }
  }

  if (command === "export") {
    // Codex Tab.content.export — contentType html | text | domSnapshot (text body)
    const contentType = typeof options.contentType === "string" ? options.contentType : "text"
    if (contentType === "html") {
      return {
        ok: true,
        contentType,
        value: document.documentElement ? document.documentElement.outerHTML : "",
        title: document.title,
        url: location.href,
      }
    }
    if (contentType === "text") {
      return {
        ok: true,
        contentType,
        value: (document.body?.innerText || document.body?.textContent || "").trim(),
        title: document.title,
        url: location.href,
      }
    }
    if (contentType === "domSnapshot") {
      // Lightweight text export; full a11y tree remains browser_snapshot tool
      return {
        ok: true,
        contentType,
        value: (document.body?.innerText || "").slice(0, 100000),
        title: document.title,
        url: location.href,
        note: "Use browser_snapshot for uid-stamped a11y nodes",
      }
    }
    return { ok: false, error: 'contentType must be "html", "text", or "domSnapshot"' }
  }

  if (command === "all_text_contents") {
    // Codex locator.allTextContents — all matches (not strict unique)
    if (!selectors.length) return { ok: false, error: "Selector is required" }
    const limit = Math.min(500, Math.max(1, Number(options.limit) || 200))
    const match = await resolveMatches(selectors, 0, Math.max(0, timeoutMs || DEFAULT_TIMEOUT_MS), pollMs)
    const texts = []
    for (const el of match.matches.slice(0, limit)) {
      texts.push(el?.textContent == null ? "" : String(el.textContent))
    }
    return {
      ok: true,
      selectorUsed: match.selectorUsed,
      count: match.matches.length,
      values: texts,
      truncated: match.matches.length > limit,
    }
  }

  if (command === "element_info") {
    // Codex playwright.elementInfo({ x, y }) — stack from point
    const x = Number(options.x)
    const y = Number(options.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { ok: false, error: "x and y are required numbers" }
    }
    const includeNonInteractable = options.includeNonInteractable === true
    const stack = document.elementsFromPoint(x, y) || []
    const items = []

    function accessibleName(el) {
      if (!el) return null
      const aria = el.getAttribute?.("aria-label")
      if (aria) return aria
      const labelled = el.getAttribute?.("aria-labelledby")
      if (labelled) {
        const parts = labelled
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent || "")
          .join(" ")
          .replace(/\s+/g, " ")
          .trim()
        if (parts) return parts
      }
      if (el.labels && el.labels[0]) {
        return (el.labels[0].innerText || el.labels[0].textContent || "").trim() || null
      }
      const alt = el.getAttribute?.("alt")
      if (alt) return alt
      const title = el.getAttribute?.("title")
      if (title) return title
      const placeholder = el.getAttribute?.("placeholder")
      if (placeholder) return placeholder
      return null
    }

    function isInteractable(el) {
      if (!el || el.nodeType !== 1) return false
      const tag = el.tagName
      if (tag === "A" || tag === "BUTTON" || tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || tag === "SUMMARY") {
        return true
      }
      if (el.isContentEditable) return true
      const role = el.getAttribute?.("role")
      if (role && /^(button|link|textbox|checkbox|radio|switch|menuitem|tab|option|combobox)$/i.test(role)) {
        return true
      }
      if (el.tabIndex >= 0) return true
      if (el.getAttribute?.("onclick")) return true
      return false
    }

    function selectorCandidates(el) {
      const candidates = []
      const uid = el.getAttribute?.("data-opc-uid")
      if (uid) candidates.push(`uid:${uid}`)
      const testId = el.getAttribute?.("data-testid") || el.getAttribute?.("data-test-id")
      if (testId) candidates.push(`[data-testid="${CSS.escape(testId)}"]`)
      if (el.id) candidates.push(`#${CSS.escape(el.id)}`)
      const name = el.getAttribute?.("name")
      if (name) candidates.push(`[name="${CSS.escape(name)}"]`)
      const role = getImplicitRole(el)
      const an = accessibleName(el)
      if (role && an) candidates.push(`role:${role}[name=${JSON.stringify(an)}]`)
      else if (role) candidates.push(`role:${role}`)
      const tag = el.tagName.toLowerCase()
      if (el.classList?.length) {
        const cls = Array.from(el.classList)
          .slice(0, 3)
          .map((c) => `.${CSS.escape(c)}`)
          .join("")
        candidates.push(`${tag}${cls}`)
      }
      candidates.push(tag)
      return candidates
    }

    for (const el of stack) {
      if (!el || el === document.documentElement || el === document.body) continue
      if (!includeNonInteractable && !isInteractable(el) && !isVisible(el)) continue
      if (!includeNonInteractable && !isInteractable(el)) {
        // still include topmost few non-interactable for context if stack short
        if (items.length > 0) continue
      }
      const rect = el.getBoundingClientRect()
      const role = getImplicitRole(el)
      const ariaName = accessibleName(el)
      const tagName = el.tagName.toLowerCase()
      let visibleText = null
      try {
        if (el.tagName === "SELECT") {
          visibleText = el.selectedOptions?.[0]?.text || el.value || null
        } else if ("value" in el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
          const elType = (el.getAttribute?.("type") || "").toLowerCase()
          const elAc = (el.getAttribute?.("autocomplete") || "").toLowerCase()
          const elNameId = `${el.name || ""} ${el.id || ""}`
          const elSensitive =
            elType === "password" ||
            elType === "hidden" ||
            ["current-password", "new-password", "one-time-code"].includes(elAc) ||
            /passw|pwd|token|secret|api[-_]?key|otp|csrf|session/i.test(elNameId)
          visibleText = elSensitive ? "[REDACTED]" : String(el.value || "").slice(0, 200) || null
        } else {
          visibleText = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200) || null
        }
      } catch {
        visibleText = null
      }
      const testId = el.getAttribute?.("data-testid") || el.getAttribute?.("data-test-id") || null
      const candidates = selectorCandidates(el)
      const preview = `<${tagName}${role ? ` role=${role}` : ""}${ariaName ? ` name="${String(ariaName).slice(0, 40)}"` : ""}>`
      items.push({
        tagName,
        role: role || null,
        ariaName: ariaName || null,
        testId,
        visibleText,
        preview,
        boundingBox: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
        selector: {
          primary: candidates[0] || null,
          candidates,
        },
        nodeId: null,
      })
      if (items.length >= 12) break
    }

    return { ok: true, x, y, elements: items }
  }

  if (command === "clipboard_read_text") {
    try {
      if (navigator.clipboard?.readText) {
        const text = await navigator.clipboard.readText()
        return { ok: true, text: text == null ? "" : String(text) }
      }
    } catch (e) {
      // fall through to execCommand path
      var readErr = e?.message || String(e)
    }
    try {
      const ta = document.createElement("textarea")
      ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0"
      document.body.appendChild(ta)
      ta.focus()
      const ok = document.execCommand("paste")
      const text = ta.value
      ta.remove()
      if (ok || text) return { ok: true, text: String(text || ""), method: "execCommand" }
      return { ok: false, error: readErr || "clipboard read failed (no permission / empty)" }
    } catch (e2) {
      return { ok: false, error: e2?.message || readErr || "clipboard read failed" }
    }
  }

  if (command === "clipboard_write_text") {
    const text = options.text == null ? "" : String(options.text)
    try {
      window.focus()
    } catch {}
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
        return { ok: true, length: text.length }
      }
    } catch (e) {
      var writeErr = e?.message || String(e)
    }
    try {
      const ta = document.createElement("textarea")
      ta.value = text
      ta.setAttribute("readonly", "")
      ta.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.01;z-index:2147483647"
      document.body.appendChild(ta)
      ta.focus()
      ta.select()
      ta.setSelectionRange(0, text.length)
      const ok = document.execCommand("copy")
      ta.remove()
      if (ok) return { ok: true, length: text.length, method: "execCommand" }
      return { ok: false, error: writeErr || "clipboard write failed" }
    } catch (e2) {
      return { ok: false, error: e2?.message || writeErr || "clipboard write failed" }
    }
  }

  return { ok: false, error: `Unknown command: ${String(command)}` }
}

const TAB_GROUP_COLORS = ["blue", "cyan", "green", "grey", "orange", "pink", "purple", "red", "yellow"]

function hashString(input) {
  const s = String(input || "")
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h
}

async function getGroupSafe(groupId) {
  if (!Number.isFinite(groupId)) return null
  try {
    return await chrome.tabGroups.get(groupId)
  } catch {
    return null
  }
}

async function updateGroupSafe(groupId, props) {
  if (!Number.isFinite(groupId)) return null
  try {
    return await chrome.tabGroups.update(groupId, props)
  } catch {
    return null
  }
}

async function addTabsToGroup(tabIds, groupId) {
  const ids = (Array.isArray(tabIds) ? tabIds : [tabIds]).filter((id) => Number.isFinite(id))
  if (!ids.length) throw new Error("tabIds required")
  if (Number.isFinite(groupId)) {
    const existing = await getGroupSafe(groupId)
    if (existing) {
      await chrome.tabs.group({ tabIds: ids, groupId })
      return groupId
    }
  }
  return await chrome.tabs.group({ tabIds: ids })
}

async function toolGetActiveTab() {
  const tab = await getActiveTab()
  return { tabId: tab.id, content: { tabId: tab.id, url: tab.url, title: tab.title } }
}

async function toolOpenTab({ url, active = false, groupId } = {}) {
  // Default active:false — do not steal the user's foreground tab (Codex-aligned).
  // No default URL: Chrome uses about:blank until navigate; seed about:blank from
  // name_session is dropped by the broker once a real agent tab joins the group.
  const createOptions = { active: active === true }
  if (typeof url === "string" && url.trim()) createOptions.url = url.trim()

  const tab = await chrome.tabs.create(createOptions)
  let usedGroupId = null
  if (Number.isFinite(groupId)) {
    try {
      usedGroupId = await addTabsToGroup([tab.id], groupId)
    } catch {
      // Group may be gone; leave tab ungrouped.
      usedGroupId = null
    }
  }

  return {
    tabId: tab.id,
    content: {
      tabId: tab.id,
      url: tab.url,
      active: tab.active,
      groupId: usedGroupId,
      windowId: tab.windowId,
    },
  }
}

async function toolCloseTab({ tabId, tabIds } = {}) {
  const ids = []
  if (Array.isArray(tabIds)) {
    for (const id of tabIds) if (Number.isFinite(id)) ids.push(id)
  }
  if (Number.isFinite(tabId)) ids.push(tabId)
  if (!ids.length) throw new Error("tabId or tabIds is required")
  await chrome.tabs.remove(ids)
  return { tabId: ids[0], content: { tabIds: ids, closed: true, count: ids.length } }
}

async function toolNameSession({ title, groupId, color, collapsed = false } = {}) {
  const name = typeof title === "string" && title.trim() ? title.trim() : "🔎 OpenCode"
  const preferredColor =
    typeof color === "string" && TAB_GROUP_COLORS.includes(color)
      ? color
      : TAB_GROUP_COLORS[hashString(name) % TAB_GROUP_COLORS.length]

  let id = Number.isFinite(groupId) ? groupId : null
  let group = id != null ? await getGroupSafe(id) : null

  if (!group) {
    // Create an empty group via a temporary tab, then close the temp tab if needed.
    // Chrome requires at least one tab to create a group; use a blank discarded tab.
    const temp = await chrome.tabs.create({ active: false, url: "about:blank" })
    id = await chrome.tabs.group({ tabIds: [temp.id] })
    await chrome.tabGroups.update(id, { title: name, color: preferredColor, collapsed: !!collapsed })
    // Keep the temp tab so the group exists; callers open real tabs into it.
    // If a previous groupId was stale, return the new one.
    group = await getGroupSafe(id)
    return {
      content: {
        ok: true,
        groupId: id,
        title: group?.title || name,
        color: group?.color || preferredColor,
        collapsed: !!group?.collapsed,
        created: true,
        seedTabId: temp.id,
      },
    }
  }

  await updateGroupSafe(id, { title: name, color: preferredColor, collapsed: !!collapsed })
  group = await getGroupSafe(id)
  return {
    content: {
      ok: true,
      groupId: id,
      title: group?.title || name,
      color: group?.color || preferredColor,
      collapsed: !!group?.collapsed,
      created: false,
    },
  }
}

async function toolGroupTabs({ tabIds, groupId, title, color } = {}) {
  const ids = (Array.isArray(tabIds) ? tabIds : []).filter((id) => Number.isFinite(id))
  if (!ids.length) throw new Error("tabIds is required")

  let id = await addTabsToGroup(ids, groupId)
  const props = {}
  if (typeof title === "string" && title.trim()) props.title = title.trim()
  if (typeof color === "string" && TAB_GROUP_COLORS.includes(color)) props.color = color
  if (Object.keys(props).length) await updateGroupSafe(id, props)
  const group = await getGroupSafe(id)
  return {
    content: {
      ok: true,
      groupId: id,
      tabIds: ids,
      title: group?.title || null,
      color: group?.color || null,
    },
  }
}

async function waitForTabComplete(tabId, timeoutMs = 30000) {
  await new Promise((resolve) => {
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener)
        resolve()
      }
    }
    chrome.tabs.onUpdated.addListener(listener)
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener)
      resolve()
    }, timeoutMs)
  })
}

async function historyNavigate(tabId, direction) {
  // Prefer Chrome navigation API when available; fall back to in-page history.
  if (direction === "back" && typeof chrome.tabs.goBack === "function") {
    try {
      await chrome.tabs.goBack(tabId)
      return "api"
    } catch (error) {
      // Fall through to history.back()
    }
  }
  if (direction === "forward" && typeof chrome.tabs.goForward === "function") {
    try {
      await chrome.tabs.goForward(tabId)
      return "api"
    } catch (error) {
      // Fall through to history.forward()
    }
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    func: (dir) => {
      if (dir === "back") window.history.back()
      else window.history.forward()
    },
    args: [direction],
    world: "MAIN",
  })
  return "history"
}

async function toolNavigate({ url, tabId }) {
  if (!url) throw new Error("URL is required")
  const tab = await getTabById(tabId)
  await chrome.tabs.update(tab.id, { url })
  await waitForTabComplete(tab.id)
  return { tabId: tab.id, content: `Navigated to ${url}` }
}

async function toolBack({ tabId } = {}) {
  const tab = await getTabById(tabId)
  const via = await historyNavigate(tab.id, "back")
  await waitForTabComplete(tab.id, 10000)
  const updated = await chrome.tabs.get(tab.id)
  return {
    tabId: tab.id,
    content: JSON.stringify({ ok: true, action: "back", via, url: updated.url, title: updated.title }),
  }
}

async function toolForward({ tabId } = {}) {
  const tab = await getTabById(tabId)
  const via = await historyNavigate(tab.id, "forward")
  await waitForTabComplete(tab.id, 10000)
  const updated = await chrome.tabs.get(tab.id)
  return {
    tabId: tab.id,
    content: JSON.stringify({ ok: true, action: "forward", via, url: updated.url, title: updated.title }),
  }
}

async function toolReload({ tabId, bypassCache = false } = {}) {
  const tab = await getTabById(tabId)
  await chrome.tabs.reload(tab.id, { bypassCache: !!bypassCache })
  await waitForTabComplete(tab.id, 30000)
  const updated = await chrome.tabs.get(tab.id)
  return {
    tabId: tab.id,
    content: JSON.stringify({
      ok: true,
      action: "reload",
      bypassCache: !!bypassCache,
      url: updated.url,
      title: updated.title,
    }),
  }
}

async function toolSetActiveTab({ tabId } = {}) {
  if (!Number.isFinite(tabId)) throw new Error("tabId is required")
  const tab = await chrome.tabs.get(tabId)
  await chrome.tabs.update(tab.id, { active: true })
  if (Number.isFinite(tab.windowId)) {
    try {
      await chrome.windows.update(tab.windowId, { focused: true })
    } catch {}
  }
  return {
    tabId: tab.id,
    content: JSON.stringify({
      ok: true,
      tabId: tab.id,
      active: true,
      windowId: tab.windowId,
      url: tab.url,
      title: tab.title,
    }),
  }
}

async function toolKey({
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
} = {}) {
  if (typeof key !== "string" || !key) throw new Error("key is required")
  const tab = await getTabById(tabId)

  // Trusted CDP keyboard path: enables native default actions (Tab traversal,
  // Enter submit, arrow navigation) that synthetic KeyboardEvent cannot trigger.
  const cdp = await cdpInputSession(tab.id)
  if (cdp) {
    if (selector) {
      const focused = await runInPage(tab.id, "focus", { selector, index, timeoutMs, pollMs })
      if (!focused?.ok) throw new Error(formatActionError(focused, "Focus failed"))
    }
    const modifierKeys = []
    if (altKey) modifierKeys.push("Alt")
    if (ctrlKey) modifierKeys.push("Control")
    if (metaKey) modifierKeys.push("Meta")
    if (shiftKey) modifierKeys.push("Shift")
    const modifiers = cdpModifierMask(modifierKeys)
    const info = cdpKeyInfo(key, { code, keyCode })
    await cdpKeyPress(tab.id, info, { modifiers, autoRepeat: !!repeat, delayMs: Number.isFinite(delayMs) ? delayMs : 0 })
    return {
      tabId: tab.id,
      content: JSON.stringify({ ok: true, key, code: info.code, method: "cdp" }),
    }
  }

  const args = {
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
    timeoutMs,
    pollMs,
  }
  if (Number.isFinite(index)) args.index = index
  const result = await runInPage(tab.id, "key", args)
  if (!result?.ok) throw new Error(formatActionError(result, "Key press failed"))
  return {
    tabId: tab.id,
    content: JSON.stringify({
      ok: true,
      key: result.key,
      code: result.code,
      target: result.target,
      method: "synthetic",
    }),
  }
}

function withTimeout(promise, ms, label) {
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    }),
  ])
}

async function toolHandleDialog({ action = "accept", promptText, tabId } = {}) {
  const tab = await getTabById(tabId)
  const normalized = typeof action === "string" ? action.toLowerCase() : "accept"
  if (normalized !== "accept" && normalized !== "dismiss") {
    throw new Error('action must be "accept" or "dismiss"')
  }

  // Prefer existing state: when a dialog is open, attach/enable CDP calls can hang.
  let state = debuggerState.get(tab.id)
  if (!state?.attached) {
    state = await ensureDebuggerAttached(tab.id)
  } else {
    state = getOrCreateDebuggerState(tab.id)
  }

  if (!state.attached) {
    throw new Error(
      state.unavailableReason ||
        "Debugger not attached. DevTools may be open or another debugger is active. " +
          "handle_dialog requires the debugger permission and Page domain."
    )
  }

  const dialog = state.pendingDialog
  const accept = normalized === "accept"
  const params = { accept }
  if (accept && promptText !== undefined) {
    params.promptText = String(promptText)
  }

  // Even if we missed javascriptDialogOpening, try handle once (dialog may still be open).
  try {
    await withTimeout(
      chrome.debugger.sendCommand({ tabId: tab.id }, "Page.handleJavaScriptDialog", params),
      8000,
      "Page.handleJavaScriptDialog"
    )
  } catch (error) {
    const msg = error?.message || String(error)
    if (!dialog) {
      return {
        tabId: tab.id,
        content: JSON.stringify({
          ok: false,
          error:
            "No pending JavaScript dialog (and handle failed). " +
            "Attach debugger before the dialog opens (browser_console/errors/handle_dialog), then open the dialog. " +
            `Detail: ${msg}`,
          pendingDialog: null,
        }),
      }
    }
    throw new Error(`Failed to handle dialog: ${msg}`)
  }

  const handled = dialog ? { ...dialog } : { type: "unknown", message: null, inferred: true }
  state.pendingDialog = null

  return {
    tabId: tab.id,
    content: JSON.stringify({
      ok: true,
      action: normalized,
      dialog: handled,
    }),
  }
}

function formatActionError(result, fallback) {
  if (!result) return fallback
  if (result.candidates) {
    return JSON.stringify(
      {
        error: result.error || fallback,
        selectorUsed: result.selectorUsed,
        count: result.count,
        candidates: result.candidates,
      },
      null,
      2
    )
  }
  return result.error || fallback
}

async function toolClick({ selector, tabId, index, timeoutMs, pollMs }) {
  if (!selector) throw new Error("Selector is required")
  const tab = await getTabById(tabId)

  const args = { selector, timeoutMs, pollMs }
  if (Number.isFinite(index)) args.index = index
  const result = await runInPage(tab.id, "click", args)
  if (!result?.ok) throw new Error(formatActionError(result, "Click failed"))
  const used = result.selectorUsed || selector
  const uid = result.uid ? ` uid=${result.uid}` : ""
  return { tabId: tab.id, content: `Clicked ${used}${uid}` }
}

async function toolCount({ selector, tabId, timeoutMs, pollMs }) {
  if (!selector) throw new Error("Selector is required")
  const tab = await getTabById(tabId)
  const result = await runInPage(tab.id, "count", { selector, timeoutMs, pollMs })
  if (!result?.ok) throw new Error(formatActionError(result, "Count failed"))
  return {
    tabId: tab.id,
    content: JSON.stringify({ count: result.count, selectorUsed: result.selectorUsed }, null, 2),
  }
}

async function toolIsVisible({ selector, tabId, index, timeoutMs, pollMs }) {
  if (!selector) throw new Error("Selector is required")
  const tab = await getTabById(tabId)
  const args = { selector, timeoutMs, pollMs }
  if (Number.isFinite(index)) args.index = index
  const result = await runInPage(tab.id, "is_visible", args)
  if (!result?.ok) throw new Error(formatActionError(result, "is_visible failed"))
  return { tabId: tab.id, content: JSON.stringify(result, null, 2) }
}

async function toolIsEnabled({ selector, tabId, index, timeoutMs, pollMs }) {
  if (!selector) throw new Error("Selector is required")
  const tab = await getTabById(tabId)
  const args = { selector, timeoutMs, pollMs }
  if (Number.isFinite(index)) args.index = index
  const result = await runInPage(tab.id, "is_enabled", args)
  if (!result?.ok) throw new Error(formatActionError(result, "is_enabled failed"))
  return { tabId: tab.id, content: JSON.stringify(result, null, 2) }
}

async function toolGetAttribute({ selector, name, attribute, tabId, index, timeoutMs, pollMs }) {
  if (!selector) throw new Error("Selector is required")
  const attrName = name || attribute
  if (!attrName) throw new Error("name is required")
  const tab = await getTabById(tabId)
  const args = { selector, name: attrName, timeoutMs, pollMs }
  if (Number.isFinite(index)) args.index = index
  const result = await runInPage(tab.id, "get_attribute", args)
  if (!result?.ok) throw new Error(formatActionError(result, "get_attribute failed"))
  return { tabId: tab.id, content: JSON.stringify(result, null, 2) }
}

async function toolTextContent({ selector, tabId, index, timeoutMs, pollMs }) {
  if (!selector) throw new Error("Selector is required")
  const tab = await getTabById(tabId)
  const args = { selector, timeoutMs, pollMs }
  if (Number.isFinite(index)) args.index = index
  const result = await runInPage(tab.id, "text_content", args)
  if (!result?.ok) throw new Error(formatActionError(result, "text_content failed"))
  return { tabId: tab.id, content: result.value == null ? "" : String(result.value) }
}

async function toolInnerText({ selector, tabId, index, timeoutMs, pollMs }) {
  if (!selector) throw new Error("Selector is required")
  const tab = await getTabById(tabId)
  const args = { selector, timeoutMs, pollMs }
  if (Number.isFinite(index)) args.index = index
  const result = await runInPage(tab.id, "inner_text", args)
  if (!result?.ok) throw new Error(formatActionError(result, "inner_text failed"))
  return { tabId: tab.id, content: result.value == null ? "" : String(result.value) }
}

async function toolDblclick({ selector, tabId, index, timeoutMs, pollMs }) {
  if (!selector) throw new Error("Selector is required")
  const tab = await getTabById(tabId)
  const args = { selector, timeoutMs, pollMs }
  if (Number.isFinite(index)) args.index = index
  const result = await runInPage(tab.id, "dblclick", args)
  if (!result?.ok) throw new Error(formatActionError(result, "Double-click failed"))
  const used = result.selectorUsed || selector
  const uid = result.uid ? ` uid=${result.uid}` : ""
  return { tabId: tab.id, content: `Double-clicked ${used}${uid}` }
}

async function toolCheck({ selector, tabId, index, timeoutMs, pollMs }) {
  if (!selector) throw new Error("Selector is required")
  const tab = await getTabById(tabId)
  const args = { selector, timeoutMs, pollMs }
  if (Number.isFinite(index)) args.index = index
  const result = await runInPage(tab.id, "check", args)
  if (!result?.ok) throw new Error(formatActionError(result, "Check failed"))
  return { tabId: tab.id, content: JSON.stringify(result, null, 2) }
}

async function toolUncheck({ selector, tabId, index, timeoutMs, pollMs }) {
  if (!selector) throw new Error("Selector is required")
  const tab = await getTabById(tabId)
  const args = { selector, timeoutMs, pollMs }
  if (Number.isFinite(index)) args.index = index
  const result = await runInPage(tab.id, "uncheck", args)
  if (!result?.ok) throw new Error(formatActionError(result, "Uncheck failed"))
  return { tabId: tab.id, content: JSON.stringify(result, null, 2) }
}

async function toolSetChecked({ selector, checked = true, tabId, index, timeoutMs, pollMs }) {
  if (!selector) throw new Error("Selector is required")
  const tab = await getTabById(tabId)
  const args = { selector, checked, timeoutMs, pollMs }
  if (Number.isFinite(index)) args.index = index
  const result = await runInPage(tab.id, "set_checked", args)
  if (!result?.ok) throw new Error(formatActionError(result, "set_checked failed"))
  return { tabId: tab.id, content: JSON.stringify(result, null, 2) }
}

async function toolFill({ selector, text, value, tabId, index, timeoutMs, pollMs }) {
  if (!selector) throw new Error("Selector is required")
  const tab = await getTabById(tabId)
  const args = { selector, text, value, timeoutMs, pollMs }
  if (Number.isFinite(index)) args.index = index
  const result = await runInPage(tab.id, "fill", args)
  if (!result?.ok) throw new Error(formatActionError(result, "Fill failed"))
  const used = result.selectorUsed || selector
  return { tabId: tab.id, content: `Filled ${used}` }
}

async function toolWaitFor({ selector, state = "visible", tabId, index, timeoutMs, pollMs }) {
  if (!selector) throw new Error("Selector is required")
  const tab = await getTabById(tabId)
  const args = { selector, state, timeoutMs: timeoutMs ?? 30000, pollMs }
  if (Number.isFinite(index)) args.index = index
  const result = await runInPage(tab.id, "wait_for", args)
  if (!result?.ok) throw new Error(formatActionError(result, "wait_for failed"))
  return { tabId: tab.id, content: JSON.stringify(result, null, 2) }
}

async function toolWaitForLoadState({ state = "load", timeoutMs = 30000, tabId } = {}) {
  const tab = await getTabById(tabId)
  const want = typeof state === "string" ? state : "load"
  const timeout = clampNumber(timeoutMs, 0, 120000, 30000)
  const start = Date.now()

  if (want === "load" || want === "domcontentloaded") {
    while (Date.now() - start < timeout) {
      const t = await chrome.tabs.get(tab.id)
      if (t.status === "complete") {
        return { tabId: tab.id, content: JSON.stringify({ ok: true, state: want, status: t.status }) }
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error(`Timed out waiting for load state ${want}`)
  }

  if (want === "networkidle") {
    // Approximate: wait for complete then settle 500ms without status churn
    while (Date.now() - start < timeout) {
      const t = await chrome.tabs.get(tab.id)
      if (t.status === "complete") {
        await new Promise((r) => setTimeout(r, 500))
        const t2 = await chrome.tabs.get(tab.id)
        if (t2.status === "complete") {
          return { tabId: tab.id, content: JSON.stringify({ ok: true, state: "networkidle", approx: true }) }
        }
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error("Timed out waiting for networkidle (approx)")
  }

  throw new Error('state must be "load", "domcontentloaded", or "networkidle"')
}

async function toolWaitForUrl({ url, timeoutMs = 30000, tabId } = {}) {
  if (!url) throw new Error("url is required")
  const tab = await getTabById(tabId)
  const timeout = clampNumber(timeoutMs, 0, 120000, 30000)
  const start = Date.now()
  const pattern = String(url)

  function matches(current) {
    if (!current) return false
    if (pattern.startsWith("re:")) {
      try {
        return new RegExp(pattern.slice(3)).test(current)
      } catch {
        return false
      }
    }
    if (pattern.includes("*")) {
      // simple glob
      const re = new RegExp("^" + pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$")
      return re.test(current)
    }
    return current === pattern || current.includes(pattern)
  }

  while (Date.now() - start < timeout) {
    const t = await chrome.tabs.get(tab.id)
    if (matches(t.url || "")) {
      return {
        tabId: tab.id,
        content: JSON.stringify({ ok: true, url: t.url, matched: pattern }),
      }
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  const t = await chrome.tabs.get(tab.id)
  throw new Error(`Timed out waiting for url ${pattern}; current=${t.url || ""}`)
}

async function toolEvaluate({ expression, fn, arg, selector, tabId, index, timeoutMs, pollMs } = {}) {
  const tab = await getTabById(tabId)
  const code = typeof expression === "string" && expression.trim() ? expression.trim() : typeof fn === "string" ? fn.trim() : ""
  if (!code) throw new Error("expression (or fn) is required — read-only page evaluate (Codex playwright.evaluate)")

  // MV3 extension isolated world blocks new Function/eval (CSP). Use CDP Runtime.evaluate
  // in the page main world — same path Codex needs for real evaluate semantics.
  const state = await ensureDebuggerAttached(tab.id)
  if (!state?.attached) {
    throw new Error(
      state?.unavailableReason
        ? `evaluate requires debugger: ${state.unavailableReason}`
        : "evaluate requires chrome.debugger (attach failed)"
    )
  }

  const argJson = JSON.stringify(arg === undefined ? null : arg)
  const selJson = JSON.stringify(selector || null)
  const idxJson = Number.isFinite(index) ? String(index) : "null"
  const codeJson = JSON.stringify(code)

  // Build a single expression: optional locator resolve + page/element evaluate
  const expressionToRun = `(() => {
    const __code = ${codeJson};
    const __arg = ${argJson};
    const __sel = ${selJson};
    const __idx = ${idxJson};
    function __resolveOne(sel, idx) {
      if (!sel) return null;
      if (String(sel).startsWith("uid:")) {
        return document.querySelector('[data-opc-uid="' + String(sel).slice(4).replace(/"/g, '\\\\"') + '"]');
      }
      const list = Array.from(document.querySelectorAll(sel));
      if (typeof idx === "number" && Number.isFinite(idx)) return list[idx] || null;
      if (list.length > 1) {
        const err = new Error("Strict mode: selector matched " + list.length + " elements");
        err.count = list.length;
        throw err;
      }
      return list[0] || null;
    }
    function __run(fnArgs) {
      const isFn = __code.includes("=>") || __code.startsWith("function");
      if (isFn) {
        const f = (0, eval)("(" + __code + ")");
        return f.apply(null, fnArgs);
      }
      if (fnArgs.length >= 2) {
        return (0, eval)("(function(el, arg){ return (" + __code + "); })")(fnArgs[0], fnArgs[1]);
      }
      return (0, eval)("(function(arg){ return (" + __code + "); })")(fnArgs[0]);
    }
    if (__sel) {
      const el = __resolveOne(__sel, __idx);
      if (!el) throw new Error("Element not found: " + __sel);
      return __run([el, __arg]);
    }
    return __run([__arg]);
  })()`

  let remote
  try {
    remote = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
      expression: expressionToRun,
      returnByValue: true,
      awaitPromise: true,
      userGesture: false,
    })
  } catch (e) {
    throw new Error(e?.message || String(e) || "Runtime.evaluate failed")
  }

  if (remote?.exceptionDetails) {
    const msg =
      remote.exceptionDetails.exception?.description ||
      remote.exceptionDetails.text ||
      "evaluate threw"
    throw new Error(msg)
  }

  let value = remote?.result?.value
  if (remote?.result?.type === "undefined") value = null
  try {
    value = JSON.parse(JSON.stringify(value === undefined ? null : value))
  } catch {
    value = String(value)
  }
  return { tabId: tab.id, content: JSON.stringify({ ok: true, value }, null, 2) }
}

async function toolExport({ contentType = "text", tabId } = {}) {
  const tab = await getTabById(tabId)
  if (contentType === "domSnapshot") {
    // Prefer full snapshot tool path for a11y tree
    const snap = await toolSnapshot({ tabId: tab.id })
    return {
      tabId: tab.id,
      content: typeof snap.content === "string" ? snap.content : JSON.stringify(snap.content),
    }
  }
  const result = await runInPage(tab.id, "export", { contentType })
  if (!result?.ok) throw new Error(result?.error || "export failed")
  return {
    tabId: tab.id,
    content: JSON.stringify(
      {
        contentType: result.contentType,
        title: result.title,
        url: result.url,
        value: result.value,
      },
      null,
      2
    ),
  }
}

async function toolGetJsDialog({ tabId } = {}) {
  const tab = await getTabById(tabId)
  let state = debuggerState.get(tab.id)
  if (!state?.attached) {
    try {
      state = await ensureDebuggerAttached(tab.id)
    } catch {
      state = getOrCreateDebuggerState(tab.id)
    }
  } else {
    state = getOrCreateDebuggerState(tab.id)
  }
  const dialog = state?.pendingDialog || null
  return {
    tabId: tab.id,
    content: JSON.stringify({ dialog }, null, 2),
  }
}

async function toolTitle({ tabId } = {}) {
  const tab = await getTabById(tabId)
  return { tabId: tab.id, content: tab.title || "" }
}

async function toolUrl({ tabId } = {}) {
  const tab = await getTabById(tabId)
  return { tabId: tab.id, content: tab.url || "" }
}

async function toolType({ selector, text, tabId, clear = false, index, timeoutMs, pollMs }) {
  if (!selector) throw new Error("Selector is required")
  if (text === undefined) throw new Error("Text is required")
  const tab = await getTabById(tabId)

  const args = { selector, text, clear, timeoutMs, pollMs }
  if (Number.isFinite(index)) args.index = index
  const result = await runInPage(tab.id, "type", args)
  if (!result?.ok) throw new Error(formatActionError(result, "Type failed"))
  const used = result.selectorUsed || selector
  const uid = result.uid ? ` uid=${result.uid}` : ""
  return { tabId: tab.id, content: `Typed "${text}" into ${used}${uid}` }
}

async function toolSelect({ selector, value, label, optionIndex, tabId, index, timeoutMs, pollMs }) {
  if (!selector) throw new Error("Selector is required")
  if (value === undefined && label === undefined && optionIndex === undefined) {
    throw new Error("value, label, or optionIndex is required")
  }
  const tab = await getTabById(tabId)

  const args = { selector, value, label, optionIndex, timeoutMs, pollMs }
  if (Number.isFinite(index)) args.index = index
  const result = await runInPage(tab.id, "select", args)
  if (!result?.ok) throw new Error(formatActionError(result, "Select failed"))
  const used = result.selectorUsed || selector
  const valueText = result.value ? String(result.value) : ""
  const labelText = result.label ? String(result.label) : ""
  const summary = labelText && valueText && labelText !== valueText ? `${labelText} (${valueText})` : labelText || valueText
  const uid = result.uid ? ` uid=${result.uid}` : ""
  return { tabId: tab.id, content: `Selected ${summary || "option"} in ${used}${uid}` }
}

async function toolScreenshot({ tabId, fullPage = false, clip } = {}) {
  const tab = await getTabById(tabId)
  const wantFull = fullPage === true
  const hasClip =
    clip &&
    Number.isFinite(clip.x) &&
    Number.isFinite(clip.y) &&
    Number.isFinite(clip.width) &&
    Number.isFinite(clip.height)

  // chrome.tabs.captureVisibleTab always captures the window's ACTIVE tab.
  // A background target tab must go through CDP Page.captureScreenshot.
  const isActiveTab = tab.active === true
  const needCdp = wantFull || hasClip || !isActiveTab

  // Codex ScreenshotOptions: fullPage / clip — prefer CDP when needed
  if (needCdp) {
    const state = await ensureDebuggerAttached(tab.id)
    if (!state?.attached) {
      if (!isActiveTab) {
        throw new Error(
          state?.unavailableReason
            ? `cannot screenshot background tab without debugger: ${state.unavailableReason}`
            : "cannot screenshot background tab without debugger"
        )
      }
      if (wantFull) {
        throw new Error(
          state?.unavailableReason
            ? `fullPage screenshot requires debugger: ${state.unavailableReason}`
            : "fullPage screenshot requires chrome.debugger"
        )
      }
      // clip-only without debugger: capture visible then note clip unsupported
      const png = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" })
      return {
        tabId: tab.id,
        content: png,
        note: "clip ignored without debugger; returned viewport capture",
      }
    }

    const params = { format: "png", fromSurface: true }
    if (wantFull) params.captureBeyondViewport = true
    if (hasClip) {
      params.clip = {
        x: clip.x,
        y: clip.y,
        width: clip.width,
        height: clip.height,
        scale: 1,
      }
    }

    let remote
    try {
      remote = await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.captureScreenshot", params)
    } catch (e) {
      if (!isActiveTab) {
        // Never fall back to captureVisibleTab for a background tab — it would
        // silently capture the wrong (active) tab.
        throw new Error(`cannot screenshot background tab without debugger: CDP capture failed (${e?.message || e})`)
      }
      // fallback: viewport capture if CDP path fails
      try {
        const png = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" })
        return {
          tabId: tab.id,
          content: png,
          note: `CDP capture failed (${e?.message || e}); returned viewport`,
        }
      } catch {
        throw new Error(e?.message || String(e) || "screenshot failed")
      }
    }
    const b64 = remote?.data
    if (!b64) throw new Error("screenshot failed: empty CDP data")
    return { tabId: tab.id, content: `data:image/png;base64,${b64}` }
  }

  // Plain viewport capture — only when the target tab IS the active tab.
  const png = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" })
  return { tabId: tab.id, content: png }
}

/** Prefer MV3 offscreen document for clipboard (no page focus required). */
async function ensureClipboardOffscreen() {
  if (!chrome.offscreen?.createDocument) {
    return { ok: false, error: "chrome.offscreen unavailable" }
  }
  try {
    const has = await chrome.offscreen.hasDocument?.()
    if (has) return { ok: true }
  } catch {}
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["CLIPBOARD"],
      justification: "Codex tab.clipboard readText/writeText without requiring a focused page",
    })
    return { ok: true }
  } catch (e) {
    const msg = e?.message || String(e)
    // Already exists races
    if (/already exists|Only a single offscreen/i.test(msg)) return { ok: true }
    return { ok: false, error: msg }
  }
}

function offscreenClipboardRequest(type, payload = {}) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ target: "offscreen", type, ...payload }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message })
          return
        }
        resolve(response || { ok: false, error: "empty offscreen response" })
      })
    } catch (e) {
      resolve({ ok: false, error: e?.message || String(e) })
    }
  })
}

/** Fallback: focus target tab briefly (page clipboard still needs document focus). */
async function withTabFocusedForClipboard(tabId, fn) {
  let previous = null
  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (active?.id && active.id !== tabId) previous = { tabId: active.id, windowId: active.windowId }
    const tab = await chrome.tabs.get(tabId)
    if (tab.windowId != null) {
      try {
        await chrome.windows.update(tab.windowId, { focused: true })
      } catch {}
    }
    await chrome.tabs.update(tabId, { active: true })
    await new Promise((r) => setTimeout(r, 150))
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "ISOLATED",
        func: () => {
          try {
            window.focus()
          } catch {}
          try {
            document.body?.focus?.()
          } catch {}
        },
      })
    } catch {}
    return await fn()
  } finally {
    if (previous && Number.isFinite(previous.tabId)) {
      try {
        await chrome.tabs.update(previous.tabId, { active: true })
      } catch {}
    }
  }
}

async function toolClipboardReadText({ tabId } = {}) {
  const tab = await getTabById(tabId)
  // 1) Offscreen (preferred — Codex tab.clipboard without page focus)
  const off = await ensureClipboardOffscreen()
  if (off.ok) {
    const res = await offscreenClipboardRequest("clipboard_read_text")
    if (res?.ok) {
      return { tabId: tab.id, content: res.text == null ? "" : String(res.text) }
    }
  }

  // 2) Focused page fallback
  return await withTabFocusedForClipboard(tab.id, async () => {
    try {
      const result = await runInPage(tab.id, "clipboard_read_text", {})
      if (result?.ok) {
        return { tabId: tab.id, content: result.text == null ? "" : String(result.text) }
      }
      var pageErr = result?.error
    } catch (e) {
      var pageErr = e?.message || String(e)
    }

    const state = await ensureDebuggerAttached(tab.id)
    if (state?.attached) {
      try {
        const remote = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
          expression: `navigator.clipboard.readText()`,
          awaitPromise: true,
          returnByValue: true,
        })
        if (!remote?.exceptionDetails) {
          return { tabId: tab.id, content: remote?.result?.value == null ? "" : String(remote.result.value) }
        }
      } catch {}
    }
    throw new Error(pageErr || off.error || "clipboard readText failed")
  })
}

async function toolClipboardWriteText({ text, tabId } = {}) {
  if (text === undefined || text === null) throw new Error("text is required")
  const tab = await getTabById(tabId)
  const payload = String(text)

  const off = await ensureClipboardOffscreen()
  if (off.ok) {
    const res = await offscreenClipboardRequest("clipboard_write_text", { text: payload })
    if (res?.ok) {
      return {
        tabId: tab.id,
        content: JSON.stringify({
          ok: true,
          length: payload.length,
          method: res.method || "offscreen",
        }),
      }
    }
  }

  return await withTabFocusedForClipboard(tab.id, async () => {
    try {
      const result = await runInPage(tab.id, "clipboard_write_text", { text: payload })
      if (result?.ok) {
        return {
          tabId: tab.id,
          content: JSON.stringify({ ok: true, length: payload.length, method: result.method || "clipboard" }),
        }
      }
      var pageErr = result?.error
    } catch (e) {
      var pageErr = e?.message || String(e)
    }

    const state = await ensureDebuggerAttached(tab.id)
    if (state?.attached) {
      try {
        const remote = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
          expression: `navigator.clipboard.writeText(${JSON.stringify(payload)})`,
          awaitPromise: true,
          returnByValue: true,
        })
        if (!remote?.exceptionDetails) {
          return {
            tabId: tab.id,
            content: JSON.stringify({ ok: true, length: payload.length, method: "cdp" }),
          }
        }
      } catch {}
    }
    throw new Error(pageErr || off.error || "clipboard writeText failed")
  })
}

// --- P4b: capabilities + viewport (Codex browser.capabilities) ---

const CAPABILITIES_REGISTRY = {
  browser: [
    {
      id: "viewport",
      description:
        "Browser viewport override via CDP Emulation.setDeviceMetricsOverride. Use set only when user asks for specific dimensions; call reset before finishing unless asked to keep.",
      supported: true,
    },
  ],
  tab: [
    {
      id: "pageAssets",
      description: "List/bundle page assets (not implemented yet on extension backend).",
      supported: false,
    },
    {
      id: "cdp",
      description: "Raw CDP surface (prefer higher-level tools; full cdp capability not exposed).",
      supported: false,
    },
    {
      id: "browserAuth",
      description: "Secure credential handoff (ChatGPT-specific; not mirrored).",
      supported: false,
    },
  ],
}

// tabId -> { width, height } when override active
const viewportOverrides = new Map()

async function toolCapabilitiesList() {
  return {
    content: JSON.stringify(
      {
        ok: true,
        family: "extension",
        type: "extension",
        capabilities: {
          browser: CAPABILITIES_REGISTRY.browser.map(({ id, description, supported }) => ({
            id,
            description,
            supported,
          })),
          tab: CAPABILITIES_REGISTRY.tab.map(({ id, description, supported }) => ({
            id,
            description,
            supported,
          })),
        },
      },
      null,
      2
    ),
  }
}

async function toolViewportSet({ width, height, tabId } = {}) {
  const w = Number(width)
  const h = Number(height)
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) {
    throw new Error("width and height must be positive numbers (Codex ViewportSize)")
  }
  const tab = await getTabById(tabId)
  const state = await ensureDebuggerAttached(tab.id)
  if (!state?.attached) {
    throw new Error(
      state?.unavailableReason
        ? `viewport.set requires debugger: ${state.unavailableReason}`
        : "viewport.set requires chrome.debugger"
    )
  }
  await chrome.debugger.sendCommand({ tabId: tab.id }, "Emulation.setDeviceMetricsOverride", {
    width: Math.round(w),
    height: Math.round(h),
    deviceScaleFactor: 1,
    mobile: false,
  })
  viewportOverrides.set(tab.id, { width: Math.round(w), height: Math.round(h) })
  return {
    tabId: tab.id,
    content: JSON.stringify({
      ok: true,
      width: Math.round(w),
      height: Math.round(h),
    }),
  }
}

async function toolViewportReset({ tabId } = {}) {
  const tab = await getTabById(tabId)
  const state = await ensureDebuggerAttached(tab.id)
  if (!state?.attached) {
    // Nothing to clear if debugger never attached
    viewportOverrides.delete(tab.id)
    return {
      tabId: tab.id,
      content: JSON.stringify({ ok: true, reset: true, note: "debugger not attached; cleared local override state" }),
    }
  }
  try {
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Emulation.clearDeviceMetricsOverride", {})
  } catch (e) {
    // still clear local
    viewportOverrides.delete(tab.id)
    throw new Error(e?.message || String(e) || "viewport.reset failed")
  }
  viewportOverrides.delete(tab.id)
  return {
    tabId: tab.id,
    content: JSON.stringify({ ok: true, reset: true }),
  }
}

async function toolAllTextContents({ selector, tabId, timeoutMs, pollMs, limit } = {}) {
  if (!selector) throw new Error("Selector is required")
  const tab = await getTabById(tabId)
  const result = await runInPage(tab.id, "all_text_contents", {
    selector,
    timeoutMs,
    pollMs,
    limit,
  })
  if (!result?.ok) throw new Error(formatActionError(result, "all_text_contents failed"))
  return {
    tabId: tab.id,
    content: JSON.stringify(
      {
        ok: true,
        selectorUsed: result.selectorUsed,
        count: result.count,
        values: result.values || [],
        truncated: !!result.truncated,
      },
      null,
      2
    ),
  }
}

async function toolElementInfo({ x, y, includeNonInteractable = false, tabId } = {}) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("x and y are required numbers")
  const tab = await getTabById(tabId)
  const result = await runInPage(tab.id, "element_info", {
    x,
    y,
    includeNonInteractable: includeNonInteractable === true,
  })
  if (!result?.ok) throw new Error(result?.error || "element_info failed")
  return {
    tabId: tab.id,
    content: JSON.stringify(
      {
        ok: true,
        x: result.x,
        y: result.y,
        elements: result.elements || [],
      },
      null,
      2
    ),
  }
}

async function toolLocatorAll({ selector, tabId, timeoutMs, pollMs } = {}) {
  if (!selector) throw new Error("Selector is required")
  const tab = await getTabById(tabId)
  const result = await runInPage(tab.id, "locator_all", { selector, timeoutMs, pollMs })
  if (!result?.ok) throw new Error(formatActionError(result, "locator_all failed"))
  return {
    tabId: tab.id,
    content: JSON.stringify(
      {
        ok: true,
        selectorUsed: result.selectorUsed,
        count: result.count,
        items: result.items || [],
      },
      null,
      2
    ),
  }
}

async function toolPress({ selector, key, keys, tabId, index, timeoutMs, pollMs } = {}) {
  if (!selector) throw new Error("Selector is required")
  const k = key || (Array.isArray(keys) && keys.length ? keys[0] : null)
  if (!k) throw new Error("key is required (Codex locator.press)")
  const tab = await getTabById(tabId)

  // Trusted CDP keyboard path (see toolKey).
  const cdp = await cdpInputSession(tab.id)
  if (cdp) {
    const focused = await runInPage(tab.id, "focus", { selector, index, timeoutMs, pollMs })
    if (!focused?.ok) throw new Error(formatActionError(focused, "press failed"))
    const info = cdpKeyInfo(k)
    await cdpKeyPress(tab.id, info, {})
    return {
      tabId: tab.id,
      content: JSON.stringify({
        ok: true,
        selectorUsed: focused.selectorUsed,
        key: k,
        uid: focused.uid ?? null,
        method: "cdp",
      }),
    }
  }

  const result = await runInPage(tab.id, "press", {
    selector,
    key: k,
    index,
    timeoutMs,
    pollMs,
  })
  if (!result?.ok) throw new Error(formatActionError(result, "press failed"))
  return { tabId: tab.id, content: JSON.stringify({ ...result, method: "synthetic" }) }
}

// --- Trusted input via CDP (Codex browser-client parity: Input.dispatchMouseEvent) ---
// Falls back to in-page synthetic dispatchEvent when the debugger is unavailable.

const CDP_MOUSE_BUTTONS = { 1: "left", 2: "middle", 3: "right", 4: "back", 5: "forward" }
// CDP `buttons` bitmask (Left=1, Right=2, Middle=4, Back=16, Forward=32).
// mousePressed without `buttons` is silently dropped by some Chrome builds.
const CDP_BUTTONS_MASK = { left: 1, right: 2, middle: 4, back: 16, forward: 32, none: 0 }

function cdpModifierMask(keypress) {
  if (!Array.isArray(keypress)) return 0
  let mask = 0
  for (const k of keypress) {
    const key = String(k).toLowerCase()
    if (key === "alt" || key === "option") mask |= 1
    else if (key === "ctrl" || key === "control") mask |= 2
    else if (key === "meta" || key === "cmd" || key === "command") mask |= 4
    else if (key === "shift") mask |= 8
  }
  return mask
}

/** Attach debugger for input; returns null when unavailable (caller may fallback). */
async function cdpInputSession(tabId) {
  const state = await ensureDebuggerAttached(tabId)
  if (!state?.attached) return null
  return { tabId }
}

async function cdpDispatchMouse(tabId, type, { x, y, button = "none", clickCount = 0, modifiers = 0, buttons } = {}) {
  const buttonsMask = buttons ?? (type === "mousePressed" ? CDP_BUTTONS_MASK[button] ?? 0 : 0)
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button,
    buttons: buttonsMask,
    clickCount,
    modifiers,
  })
}

// --- Trusted keyboard via CDP (Input.dispatchKeyEvent) ---
// Synthetic KeyboardEvent dispatch fires listeners but skips native default
// actions (Tab traversal, Enter submit, arrow navigation); the CDP path does not.

const CDP_KEY_MAP = {
  Enter: { code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
  Tab: { code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
  Escape: { code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
  Backspace: { code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
  Delete: { code: "Delete", windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 },
  ArrowLeft: { code: "ArrowLeft", windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 },
  ArrowUp: { code: "ArrowUp", windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 },
  ArrowRight: { code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 },
  ArrowDown: { code: "ArrowDown", windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 },
  Home: { code: "Home", windowsVirtualKeyCode: 36, nativeVirtualKeyCode: 36 },
  End: { code: "End", windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35 },
  PageUp: { code: "PageUp", windowsVirtualKeyCode: 33, nativeVirtualKeyCode: 33 },
  PageDown: { code: "PageDown", windowsVirtualKeyCode: 34, nativeVirtualKeyCode: 34 },
  " ": { code: "Space", windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 },
}

function cdpKeyInfo(key, { code, keyCode } = {}) {
  let info
  if (Object.prototype.hasOwnProperty.call(CDP_KEY_MAP, key)) {
    info = { key, ...CDP_KEY_MAP[key] }
  } else if (typeof key === "string" && key.length === 1) {
    const upper = key.toUpperCase()
    const isLetter = /^[A-Z]$/.test(upper)
    const isDigit = /^[0-9]$/.test(upper)
    info = {
      key,
      code: isLetter ? `Key${upper}` : isDigit ? `Digit${upper}` : key,
      windowsVirtualKeyCode: (isLetter || isDigit ? upper : key).charCodeAt(0),
      nativeVirtualKeyCode: (isLetter || isDigit ? upper : key).charCodeAt(0),
    }
  } else {
    // Unknown named key: best effort.
    info = { key, code: key, windowsVirtualKeyCode: 0, nativeVirtualKeyCode: 0 }
  }
  if (typeof code === "string" && code) info.code = code
  if (Number.isFinite(keyCode)) {
    info.windowsVirtualKeyCode = keyCode
    info.nativeVirtualKeyCode = keyCode
  }
  return info
}

async function cdpDispatchKey(
  tabId,
  { type, key, code, windowsVirtualKeyCode, nativeVirtualKeyCode, modifiers = 0, text, unmodifiedText, autoRepeat = false } = {}
) {
  const params = { type, key, code, windowsVirtualKeyCode, nativeVirtualKeyCode, modifiers, autoRepeat }
  if (text !== undefined) params.text = text
  if (unmodifiedText !== undefined) params.unmodifiedText = unmodifiedText
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", params)
}

/** Full trusted key press: rawKeyDown (+ char for text-producing keys), then keyUp. */
async function cdpKeyPress(tabId, info, { modifiers = 0, autoRepeat = false, delayMs = 0 } = {}) {
  const printable = typeof info.key === "string" && info.key.length === 1
  // Enter must emit a char ("\r") — implicit form submission / keypress default
  // actions trigger on the char event, not on rawKeyDown.
  const charText = printable ? info.key : info.key === "Enter" ? "\r" : null
  await cdpDispatchKey(tabId, { type: "rawKeyDown", ...info, modifiers, autoRepeat })
  if (charText !== null) {
    await cdpDispatchKey(tabId, {
      type: "char",
      ...info,
      modifiers,
      text: charText,
      unmodifiedText: charText,
      autoRepeat,
    })
  }
  if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
  await cdpDispatchKey(tabId, { type: "keyUp", ...info, modifiers })
}

async function toolMouseMove({ x, y, tabId } = {}) {
  const tab = await getTabById(tabId)
  const cdp = await cdpInputSession(tab.id)
  if (cdp) {
    await cdpDispatchMouse(tab.id, "mouseMoved", { x, y })
    return { tabId: tab.id, content: JSON.stringify({ ok: true, x, y, method: "cdp" }) }
  }
  const result = await runInPage(tab.id, "mouse_move", { x, y })
  if (!result?.ok) throw new Error(result?.error || "mouse_move failed")
  return { tabId: tab.id, content: JSON.stringify(result) }
}

async function toolMouseClick({ x, y, button = 1, keypress, tabId } = {}) {
  const tab = await getTabById(tabId)
  const cdpButton = CDP_MOUSE_BUTTONS[button] || "left"
  const modifiers = cdpModifierMask(keypress)
  const cdp = await cdpInputSession(tab.id)
  if (cdp) {
    await cdpDispatchMouse(tab.id, "mouseMoved", { x, y, modifiers })
    await cdpDispatchMouse(tab.id, "mousePressed", { x, y, button: cdpButton, clickCount: 1, modifiers })
    await cdpDispatchMouse(tab.id, "mouseReleased", { x, y, button: cdpButton, clickCount: 1, modifiers })
    return {
      tabId: tab.id,
      content: JSON.stringify({ ok: true, x, y, button: cdpButton, method: "cdp" }),
    }
  }
  const result = await runInPage(tab.id, "mouse_click", { x, y, button, keypress })
  if (!result?.ok) throw new Error(result?.error || "mouse_click failed")
  return { tabId: tab.id, content: JSON.stringify(result) }
}

async function toolMouseDblclick({ x, y, keypress, tabId } = {}) {
  const tab = await getTabById(tabId)
  const modifiers = cdpModifierMask(keypress)
  const cdp = await cdpInputSession(tab.id)
  if (cdp) {
    await cdpDispatchMouse(tab.id, "mouseMoved", { x, y, modifiers })
    await cdpDispatchMouse(tab.id, "mousePressed", { x, y, button: "left", clickCount: 1, modifiers })
    await cdpDispatchMouse(tab.id, "mouseReleased", { x, y, button: "left", clickCount: 1, modifiers })
    await cdpDispatchMouse(tab.id, "mousePressed", { x, y, button: "left", clickCount: 2, modifiers })
    await cdpDispatchMouse(tab.id, "mouseReleased", { x, y, button: "left", clickCount: 2, modifiers })
    return { tabId: tab.id, content: JSON.stringify({ ok: true, x, y, method: "cdp" }) }
  }
  const result = await runInPage(tab.id, "mouse_dblclick", { x, y, keypress })
  if (!result?.ok) throw new Error(result?.error || "mouse_dblclick failed")
  return { tabId: tab.id, content: JSON.stringify(result) }
}

async function toolDrag({ path, keys, tabId } = {}) {
  if (!Array.isArray(path) || path.length < 2) throw new Error("path must be an array of at least 2 points")
  const tab = await getTabById(tabId)
  const modifiers = cdpModifierMask(keys)
  const start = path[0]
  const end = path[path.length - 1]
  const cdp = await cdpInputSession(tab.id)
  if (cdp) {
    await cdpDispatchMouse(tab.id, "mouseMoved", { x: start.x, y: start.y, modifiers })
    await cdpDispatchMouse(tab.id, "mousePressed", { x: start.x, y: start.y, button: "left", clickCount: 1, modifiers })
    for (const p of path.slice(1, -1)) {
      await cdpDispatchMouse(tab.id, "mouseMoved", { x: p.x, y: p.y, modifiers })
      await new Promise((r) => setTimeout(r, 30))
    }
    await cdpDispatchMouse(tab.id, "mouseMoved", { x: end.x, y: end.y, modifiers })
    await cdpDispatchMouse(tab.id, "mouseReleased", { x: end.x, y: end.y, button: "left", clickCount: 1, modifiers })
    return {
      tabId: tab.id,
      content: JSON.stringify({ ok: true, from: start, to: end, points: path.length, method: "cdp" }),
    }
  }
  const result = await runInPage(tab.id, "drag", { path, keys })
  if (!result?.ok) throw new Error(result?.error || "drag failed")
  return { tabId: tab.id, content: JSON.stringify(result) }
}

async function toolGetVisibleDom({ tabId, limit } = {}) {
  const tab = await getTabById(tabId)
  const result = await runInPage(tab.id, "get_visible_dom", { limit })
  if (!result?.ok) throw new Error(result?.error || "get_visible_dom failed")
  return {
    tabId: tab.id,
    content: JSON.stringify(
      {
        ok: true,
        nodes: result.nodes || [],
        count: result.count || 0,
      },
      null,
      2
    ),
  }
}

async function toolDownloadMedia({ selector, tabId, index, timeoutMs, pollMs } = {}) {
  if (!selector) throw new Error("Selector is required")
  const tab = await getTabById(tabId)
  const result = await runInPage(tab.id, "download_media", {
    selector,
    index,
    timeoutMs,
    pollMs,
  })
  if (!result?.ok) throw new Error(formatActionError(result, "download_media failed"))
  return { tabId: tab.id, content: JSON.stringify(result) }
}

async function toolElementScreenshot({ x, y, includeNonInteractable = false, tabId } = {}) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("x and y required")
  const tab = await getTabById(tabId)
  const result = await runInPage(tab.id, "element_screenshot", {
    x,
    y,
    includeNonInteractable: includeNonInteractable === true,
  })
  if (!result?.ok) throw new Error(result?.error || "element_screenshot failed")
  return { tabId: tab.id, content: JSON.stringify(result, null, 2) }
}

async function toolSnapshot({ tabId }) {
  const tab = await getTabById(tabId)

  const result = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      function safeText(s) {
        return typeof s === "string" ? s : ""
      }

      const SENSITIVE_NAME_RE = /passw|pwd|token|secret|api[-_]?key|otp|csrf|session/i

      function isSensitiveField(el) {
        if (!el || !el.tagName) return false
        const type = String(el.getAttribute?.("type") || "").toLowerCase()
        if (type === "password" || type === "hidden") return true
        const autocomplete = String(el.getAttribute?.("autocomplete") || "").toLowerCase()
        if (["current-password", "new-password", "one-time-code"].includes(autocomplete)) return true
        const nameId = `${el.getAttribute?.("name") || ""} ${el.id || ""}`
        return SENSITIVE_NAME_RE.test(nameId)
      }

      function serializeFormValue(el) {
        if (isSensitiveField(el)) return "[REDACTED]"
        return el.value
      }

      function isVisible(el) {
        if (!el) return false
        const rect = el.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return false
        const style = window.getComputedStyle(el)
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false
        return true
      }

      function pseudoText(el) {
        try {
          const before = window.getComputedStyle(el, "::before").content
          const after = window.getComputedStyle(el, "::after").content
          const norm = (v) => {
            const s = safeText(v)
            if (!s || s === "none") return ""
            return s.replace(/^"|"$/g, "")
          }
          return { before: norm(before), after: norm(after) }
        } catch {
          return { before: "", after: "" }
        }
      }

      function getAriaLabelledByText(el) {
        const ids = safeText(el?.getAttribute?.("aria-labelledby")).split(/\s+/).filter(Boolean)
        if (!ids.length) return ""
        const parts = []
        for (const id of ids) {
          const ref = document.getElementById(id)
          if (ref) parts.push(ref.innerText || ref.textContent || "")
        }
        return parts.join(" ")
      }

      function getImplicitRole(el) {
        if (!el || !el.tagName) return ""
        const explicit = el.getAttribute?.("role")
        if (explicit) return explicit.toLowerCase()
        const tag = el.tagName.toLowerCase()
        const type = (el.getAttribute?.("type") || "").toLowerCase()
        if (tag === "a" && el.hasAttribute("href")) return "link"
        if (tag === "button") return "button"
        if (tag === "input") {
          if (type === "button" || type === "submit" || type === "reset" || type === "image") return "button"
          if (type === "checkbox") return "checkbox"
          if (type === "radio") return "radio"
          if (type === "range") return "slider"
          if (type === "number") return "spinbutton"
          if (type === "search") return "searchbox"
          return "textbox"
        }
        if (tag === "textarea") return "textbox"
        if (tag === "select") return el.multiple ? "listbox" : "combobox"
        if (tag === "img") return "img"
        if (tag === "nav") return "navigation"
        if (tag === "main") return "main"
        if (tag === "header") return "banner"
        if (tag === "footer") return "contentinfo"
        if (tag === "aside") return "complementary"
        if (tag === "form") return "form"
        if (tag === "table") return "table"
        if (tag === "ul" || tag === "ol") return "list"
        if (tag === "li") return "listitem"
        if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4" || tag === "h5" || tag === "h6") return "heading"
        if (tag === "option") return "option"
        if (tag === "summary") return "button"
        if (el.isContentEditable) return "textbox"
        return tag
      }

      function getName(el) {
        const aria = el.getAttribute("aria-label")
        if (aria) return aria
        const labelled = getAriaLabelledByText(el)
        if (labelled.trim()) return labelled.slice(0, 200)
        if (el.labels && el.labels.length) {
          const parts = []
          for (const label of el.labels) {
            parts.push(label.innerText || label.textContent || "")
          }
          const joined = parts.join(" ").trim()
          if (joined) return joined.slice(0, 200)
        }
        const alt = el.getAttribute("alt")
        if (alt) return alt
        const title = el.getAttribute("title")
        if (title) return title
        const placeholder = el.getAttribute("placeholder")
        if (placeholder) return placeholder
        if (el.tagName === "INPUT" && (el.type === "button" || el.type === "submit" || el.type === "reset")) {
          if (el.value) return el.value
        }
        const txt = safeText(el.innerText).replace(/\s+/g, " ").trim()
        if (txt) return txt.slice(0, 200)
        const pt = pseudoText(el)
        const combo = `${pt.before} ${pt.after}`.trim()
        if (combo) return combo.slice(0, 200)
        return ""
      }

      // Clear previous snapshot stamps so stale uids do not linger after DOM changes.
      try {
        document.querySelectorAll("[data-opc-uid]").forEach((el) => el.removeAttribute("data-opc-uid"))
      } catch {}

      function build(el, depth = 0, uid = 0) {
        if (!el || depth > 12) return { nodes: [], nextUid: uid }
        const nodes = []

        if (!isVisible(el)) return { nodes: [], nextUid: uid }

        const isInteractive =
          ["A", "BUTTON", "INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) ||
          el.getAttribute("onclick") ||
          !!el.getAttribute("role") ||
          el.isContentEditable ||
          el.tabIndex >= 0

        const name = getName(el)
        const pt = pseudoText(el)
        const role = getImplicitRole(el)

        const shouldInclude = isInteractive || name.trim() || pt.before || pt.after

        if (shouldInclude) {
          const uidStr = `e${uid}`
          try {
            el.setAttribute("data-opc-uid", uidStr)
          } catch {}

          const node = {
            uid: uidStr,
            role,
            name,
            tag: el.tagName.toLowerCase(),
            visible: true,
          }

          if (pt.before) node.before = pt.before
          if (pt.after) node.after = pt.after
          if (el.href) node.href = el.href

          if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
            if (el.type) node.type = el.type
            if (el.value != null) node.value = serializeFormValue(el)
            if (el.readOnly) node.readOnly = true
            if (el.disabled) node.disabled = true
            if (el.checked != null && (el.type === "checkbox" || el.type === "radio")) node.checked = !!el.checked
          } else if (el.disabled) {
            node.disabled = true
          }

          if (el.id) node.selector = `#${el.id}`
          else if (el.className && typeof el.className === "string") {
            const cls = el.className.trim().split(/\s+/).slice(0, 2).join(".")
            if (cls) node.selector = `${el.tagName.toLowerCase()}.${cls}`
          }

          nodes.push(node)
          uid++
        }

        if (el.shadowRoot) {
          for (const child of el.shadowRoot.children || []) {
            const r = build(child, depth + 1, uid)
            nodes.push(...r.nodes)
            uid = r.nextUid
          }
        }

        for (const child of el.children) {
          const r = build(child, depth + 1, uid)
          nodes.push(...r.nodes)
          uid = r.nextUid
        }

        return { nodes, nextUid: uid }
      }

      function getAllLinks() {
        const links = []
        const seen = new Set()
        document.querySelectorAll("a[href]").forEach((a) => {
          const href = a.href
          if (href && !seen.has(href) && !href.startsWith("javascript:")) {
            seen.add(href)
            const text = a.innerText?.trim().slice(0, 100) || a.getAttribute("aria-label") || ""
            links.push({
              href,
              text,
              uid: a.getAttribute("data-opc-uid") || null,
            })
          }
        })
        return links.slice(0, 200)
      }

      let pageText = ""
      try {
        pageText = safeText(document.body?.innerText || "").slice(0, 20000)
      } catch {}

      const built = build(document.body).nodes.slice(0, 800)

      return {
        url: location.href,
        title: document.title,
        text: pageText,
        nodes: built,
        links: getAllLinks(),
      }
    },
    world: "ISOLATED",
  })

  return { tabId: tab.id, content: JSON.stringify(result[0]?.result, null, 2) }
}

async function toolGetTabs() {
  const tabs = await chrome.tabs.query({})
  const groupCache = new Map()
  const out = []
  for (const t of tabs) {
    const entry = {
      id: t.id,
      url: t.url,
      title: t.title,
      active: t.active,
      windowId: t.windowId,
      groupId: t.groupId != null && t.groupId !== -1 ? t.groupId : null,
      groupTitle: null,
    }
    if (entry.groupId != null) {
      if (!groupCache.has(entry.groupId)) {
        groupCache.set(entry.groupId, await getGroupSafe(entry.groupId))
      }
      const g = groupCache.get(entry.groupId)
      entry.groupTitle = g?.title || null
    }
    out.push(entry)
  }
  return { content: JSON.stringify(out, null, 2) }
}

async function toolQuery({
  tabId,
  selector,
  mode = "text",
  attribute,
  property,
  limit,
  index = 0,
  timeoutMs,
  pollMs,
  pattern,
  flags,
}) {
  if (!selector && mode !== "page_text") throw new Error("selector is required")
  const tab = await getTabById(tabId)

  const result = await runInPage(tab.id, "query", {
    selector,
    mode,
    attribute,
    property,
    limit,
    index,
    timeoutMs,
    pollMs,
    pattern,
    flags,
  })

  if (!result?.ok) throw new Error(result?.error || "Query failed")

  if (mode === "list" || mode === "property" || mode === "exists" || mode === "page_text") {
    return { tabId: tab.id, content: JSON.stringify(result, null, 2) }
  }

  return { tabId: tab.id, content: typeof result.value === "string" ? result.value : JSON.stringify(result.value) }
}

async function toolScroll({ x = 0, y = 0, selector, tabId, timeoutMs, pollMs }) {
  const tab = await getTabById(tabId)

  const result = await runInPage(tab.id, "scroll", { x, y, selector, timeoutMs, pollMs })
  if (!result?.ok) throw new Error(result?.error || "Scroll failed")
  const target = result.selectorUsed ? `to ${result.selectorUsed}` : `by (${x}, ${y})`
  return { tabId: tab.id, content: `Scrolled ${target}` }
}

async function toolWait({ ms = 1000, tabId }) {
  await new Promise((resolve) => setTimeout(resolve, ms))
  return { tabId, content: `Waited ${ms}ms` }
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

function normalizeDownloadTimeoutMs(value) {
  return clampNumber(value, 0, 60000, 60000)
}

function waitForNextDownloadCreated(timeoutMs) {
  const timeout = normalizeDownloadTimeoutMs(timeoutMs)
  return new Promise((resolve, reject) => {
    const listener = (item) => {
      cleanup()
      resolve(item)
    }

    const timer = timeout
      ? setTimeout(() => {
          cleanup()
          reject(new Error("Timed out waiting for download to start"))
        }, timeout)
      : null

    function cleanup() {
      chrome.downloads.onCreated.removeListener(listener)
      if (timer) clearTimeout(timer)
    }

    chrome.downloads.onCreated.addListener(listener)
  })
}

async function getDownloadById(downloadId) {
  const items = await chrome.downloads.search({ id: downloadId })
  return items && items.length ? items[0] : null
}

async function waitForDownloadCompletion(downloadId, timeoutMs) {
  const timeout = normalizeDownloadTimeoutMs(timeoutMs)
  const pollMs = 200
  const endAt = Date.now() + timeout

  while (true) {
    const item = await getDownloadById(downloadId)
    if (item && (item.state === "complete" || item.state === "interrupted")) return item
    if (!timeout || Date.now() >= endAt) return item
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

async function toolDownload({
  url,
  selector,
  filename,
  conflictAction,
  saveAs = false,
  wait = false,
  downloadTimeoutMs,
  tabId,
  index = 0,
  timeoutMs,
  pollMs,
}) {
  const hasUrl = typeof url === "string" && url.trim()
  const hasSelector = typeof selector === "string" && selector.trim()

  await ensureDownloadsAvailable()

  if (!hasUrl && !hasSelector) throw new Error("url or selector is required")
  if (hasUrl && hasSelector) throw new Error("Provide either url or selector, not both")

  let downloadId = null

  if (hasUrl) {
    const options = { url: url.trim() }
    if (typeof filename === "string" && filename.trim()) options.filename = filename.trim()
    if (typeof conflictAction === "string" && conflictAction.trim()) options.conflictAction = conflictAction.trim()
    if (typeof saveAs === "boolean") options.saveAs = saveAs

    downloadId = await chrome.downloads.download(options)
  } else {
    const tab = await getTabById(tabId)
    const created = waitForNextDownloadCreated(downloadTimeoutMs)
    const clicked = await runInPage(tab.id, "click", { selector, index, timeoutMs, pollMs })
    if (!clicked?.ok) throw new Error(clicked?.error || "Click failed")
    const createdItem = await created
    downloadId = createdItem?.id
  }

  if (!Number.isFinite(downloadId)) throw new Error("Download did not start")

  if (!wait) {
    const item = await getDownloadById(downloadId)
    return { content: { downloadId, item } }
  }

  const item = await waitForDownloadCompletion(downloadId, downloadTimeoutMs)
  return { content: { downloadId, item } }
}

async function toolListDownloads({ limit = 20, state } = {}) {
  await ensureDownloadsAvailable()

  const limitValue = clampNumber(limit, 1, 200, 20)
  const query = { orderBy: ["-startTime"], limit: limitValue }
  if (typeof state === "string" && state.trim()) query.state = state.trim()

  const downloads = await chrome.downloads.search(query)
  const out = downloads.map((d) => ({
    id: d.id,
    url: d.url,
    filename: d.filename,
    state: d.state,
    bytesReceived: d.bytesReceived,
    totalBytes: d.totalBytes,
    startTime: d.startTime,
    endTime: d.endTime,
    error: d.error,
    mime: d.mime,
  }))

  return { content: JSON.stringify({ downloads: out }, null, 2) }
}

/**
 * Codex browser.user.history(options) → BrowserHistoryEntry[]
 * options: { from?, to?, limit?, queries? }
 */
function parseHistoryTime(value, label) {
  if (value == null || value === "") return null
  if (typeof value === "number" && Number.isFinite(value)) return value
  const ms = Date.parse(String(value))
  if (!Number.isFinite(ms)) {
    throw new Error(`Invalid ${label}: expected ISO 8601 date string, got ${JSON.stringify(value)}`)
  }
  return ms
}

async function toolHistory({ queries, from, to, limit } = {}) {
  if (!chrome.history || typeof chrome.history.search !== "function") {
    throw new Error(
      "chrome.history is unavailable. Ensure the extension has the history permission and Reload it (chrome://extensions)."
    )
  }

  const maxResults = clampNumber(limit, 1, 1000, 100)
  const startTime = parseHistoryTime(from, "from")
  const endTime = parseHistoryTime(to, "to")

  let terms = []
  if (Array.isArray(queries)) {
    terms = queries.map((q) => String(q ?? "").trim()).filter(Boolean)
  } else if (typeof queries === "string" && queries.trim()) {
    terms = [queries.trim()]
  }
  if (!terms.length) terms = [""]

  const byKey = new Map()

  for (const text of terms) {
    const query = {
      text,
      maxResults,
      // Chrome defaults startTime to 24h ago when omitted; use epoch for full history.
      startTime: startTime != null ? startTime : 0,
    }
    if (endTime != null) query.endTime = endTime

    const items = await chrome.history.search(query)
    for (const item of items || []) {
      if (!item || !item.url) continue
      const visitMs = item.lastVisitTime != null ? Number(item.lastVisitTime) : NaN
      if (!Number.isFinite(visitMs)) continue
      if (startTime != null && visitMs < startTime) continue
      if (endTime != null && visitMs > endTime) continue
      const dateVisited = new Date(visitMs).toISOString()
      const key = `${item.url}\0${dateVisited}`
      if (byKey.has(key)) continue
      byKey.set(key, {
        dateVisited,
        url: item.url,
        ...(item.title ? { title: item.title } : {}),
      })
    }
  }

  const entries = Array.from(byKey.values()).sort((a, b) => {
    const ta = Date.parse(a.dateVisited)
    const tb = Date.parse(b.dateVisited)
    return tb - ta
  })

  return { content: JSON.stringify(entries.slice(0, maxResults), null, 2) }
}

async function toolSetFileInput({ selector, tabId, index, timeoutMs, pollMs, files }) {
  if (!selector) throw new Error("Selector is required")
  const tab = await getTabById(tabId)

  const args = { selector, timeoutMs, pollMs, files }
  if (Number.isFinite(index)) args.index = index
  const result = await runInPage(tab.id, "set_file_input", args)
  if (!result?.ok) throw new Error(formatActionError(result, "Failed to set file input"))
  const used = result.selectorUsed || selector
  return { tabId: tab.id, content: JSON.stringify({ selector: used, ...result }, null, 2) }
}

async function toolHighlight({ selector, tabId, index, duration, color, showInfo, timeoutMs, pollMs }) {
  if (!selector) throw new Error("Selector is required")
  const tab = await getTabById(tabId)

  const args = {
    selector,
    duration,
    color,
    showInfo,
    timeoutMs,
    pollMs,
  }
  if (Number.isFinite(index)) args.index = index
  const result = await runInPage(tab.id, "highlight", args)
  if (!result?.ok) throw new Error(formatActionError(result, "Highlight failed"))
  return {
    tabId: tab.id,
    content: JSON.stringify({
      highlighted: true,
      tag: result.tag,
      id: result.id,
      uid: result.uid || null,
      selectorUsed: result.selectorUsed,
    }),
  }
}

async function toolConsole({ tabId, clear = false, filter } = {}) {
  const tab = await getTabById(tabId)
  const state = await ensureDebuggerAttached(tab.id)

  if (!state.attached) {
    return {
      tabId: tab.id,
      content: JSON.stringify({
        error: state.unavailableReason || "Debugger not attached. DevTools may be open or another debugger is active.",
        messages: [],
      }),
    }
  }

  let messages = [...state.consoleMessages]

  if (filter && typeof filter === "string") {
    const filterType = filter.toLowerCase()
    messages = messages.filter((m) => m.type === filterType)
  }

  if (clear) {
    state.consoleMessages = []
  }

  return {
    tabId: tab.id,
    content: JSON.stringify(messages, null, 2),
  }
}

async function toolErrors({ tabId, clear = false } = {}) {
  const tab = await getTabById(tabId)
  const state = await ensureDebuggerAttached(tab.id)

  if (!state.attached) {
    return {
      tabId: tab.id,
      content: JSON.stringify({
        error: state.unavailableReason || "Debugger not attached. DevTools may be open or another debugger is active.",
        errors: [],
      }),
    }
  }

  const errors = [...state.pageErrors]

  if (clear) {
    state.pageErrors = []
  }

  return {
    tabId: tab.id,
    content: JSON.stringify(errors, null, 2),
  }
}

chrome.runtime.onInstalled.addListener(() => connect().catch(() => {}))
chrome.runtime.onStartup.addListener(() => connect().catch(() => {}))

if (chrome.permissions?.onAdded) {
  chrome.permissions.onAdded.addListener(() => connect().catch(() => {}))
}

chrome.action.onClicked.addListener(async () => {
  const permissionResult = await requestOptionalPermissionsFromClick()
  if (!permissionResult.granted) {
    updateBadge(false)
    if (permissionResult.error) {
      console.warn("[OpenCode] Permission request failed:", permissionResult.error)
    } else {
      console.warn("[OpenCode] Permission request denied.")
    }
    return
  }

  if (permissionResult.requested) {
    const requestedPermissions = permissionResult.permissions.join(", ") || "none"
    const requestedOrigins = permissionResult.origins.join(", ") || "none"
    console.log(`[OpenCode] Requested permissions -> permissions: ${requestedPermissions}; origins: ${requestedOrigins}`)
  }

  await connect()
})

connect().catch(() => {})
