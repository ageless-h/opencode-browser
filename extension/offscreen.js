// Offscreen document for clipboard access (MV3; avoids page-focus requirement).
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== "offscreen") return false

  ;(async () => {
    try {
      if (message.type === "clipboard_write_text") {
        const text = message.text == null ? "" : String(message.text)
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text)
          sendResponse({ ok: true, length: text.length, method: "offscreen-clipboard" })
          return
        }
        const ta = document.createElement("textarea")
        ta.value = text
        document.body.appendChild(ta)
        ta.select()
        const ok = document.execCommand("copy")
        ta.remove()
        if (!ok) throw new Error("execCommand copy failed")
        sendResponse({ ok: true, length: text.length, method: "offscreen-execCommand" })
        return
      }

      if (message.type === "clipboard_read_text") {
        if (navigator.clipboard?.readText) {
          const text = await navigator.clipboard.readText()
          sendResponse({ ok: true, text: text == null ? "" : String(text), method: "offscreen-clipboard" })
          return
        }
        throw new Error("navigator.clipboard.readText unavailable in offscreen")
      }

      sendResponse({ ok: false, error: `Unknown offscreen type: ${message.type}` })
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) })
    }
  })()

  return true
})
