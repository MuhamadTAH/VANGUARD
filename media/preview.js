(function () {
  "use strict";
  if (typeof acquireVsCodeApi !== "function") {
    return;
  }

  const vscode = acquireVsCodeApi();

  // ── DOM refs ────────────────────────────────────────────────────────────────
  const statusEl       = document.getElementById("status");
  const eventsEl       = document.getElementById("events");
  const frameEl        = document.getElementById("preview-frame");
  const vIdInputEl     = document.getElementById("mutate-v-id");
  const promptInputEl  = document.getElementById("mutate-prompt");
  const sendButtonEl   = document.getElementById("mutate-send");
  const selectorBtnEl  = document.getElementById("selector-toggle");
  const selectorBadge  = document.getElementById("selector-badge");

  // ── Telemetry helpers ───────────────────────────────────────────────────────
  function addEventLine(line, level) {
    if (!eventsEl) { return; }
    const row = document.createElement("div");
    row.className = "event-row" + (level === "error" ? " event-error" : level === "warn" ? " event-warn" : "");
    row.textContent = line;
    eventsEl.prepend(row);
  }

  function setStatus(status) {
    if (!statusEl) { return; }
    statusEl.textContent = status;
  }

  // ── URL helpers ─────────────────────────────────────────────────────────────
  function withCacheBuster(url) {
    try {
      const u = new URL(url);
      u.searchParams.set("__vanguard_ts", String(Date.now()));
      return u.toString();
    } catch { return url; }
  }

  function setPreviewUrl(url) {
    if (!frameEl || typeof url !== "string" || url.length === 0) { return; }
    const freshUrl = withCacheBuster(url);
    frameEl.src = freshUrl;
    addEventLine("[runtime] url=" + freshUrl, "info");
  }

  function refreshPreviewFrame() {
    if (!frameEl || !frameEl.src) { return; }
    frameEl.src = withCacheBuster(frameEl.src);
    addEventLine("[runtime] iframe refresh requested", "info");
  }

  // ── Mutation UI ─────────────────────────────────────────────────────────────
  function postMutationRequest() {
    const vId   = String(vIdInputEl?.value  || "").trim();
    const prompt = String(promptInputEl?.value || "").trim();
    if (!vId || !prompt) {
      addEventLine("Mutation blocked: both v-id and prompt are required.", "warn");
      return;
    }
    vscode.postMessage({ type: "preview/mutateRequest", vId, prompt });
    addEventLine("[mutation] request sent for " + vId, "info");
  }

  if (sendButtonEl) {
    sendButtonEl.addEventListener("click", postMutationRequest);
  }
  if (promptInputEl) {
    promptInputEl.addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { postMutationRequest(); }
    });
  }

  // ── ═══════════════════════════════════════════════════════════════════════ ──
  //   SURGICAL SELECTOR — Day 7
  // ── ═══════════════════════════════════════════════════════════════════════ ──

  let selectorActive = false;
  let overlayReady   = false;
  let overlayScriptText = null;   // fetched once from the extension host

  /**
   * Inject the overlay.js script into the iframe document.
   * We must do this every time the iframe navigates (src changes).
   * Safe to call multiple times — the overlay guards against double-install.
   */
  function injectOverlayIntoIframe() {
    if (!frameEl) { return; }
    const iframeWin = frameEl.contentWindow;
    if (!iframeWin) { return; }

    if (!overlayScriptText) {
      // Not yet fetched — request it from the host (synchronous workaround via
      // the host postMessage channel is unavailable here, so we store on load)
      return;
    }

    try {
      const iframeDoc = frameEl.contentDocument || iframeWin.document;
      const script = iframeDoc.createElement("script");
      script.textContent = overlayScriptText;
      iframeDoc.head.appendChild(script);
    } catch (err) {
      // Cross-origin — the iframe may block injection. That is expected when
      // the dev server runs on a different origin. In production Next.js dev
      // mode on localhost this succeeds.
      addEventLine("[selector] WARNING: overlay injection blocked (cross-origin?): " + String(err), "warn");
    }
  }

  /**
   * Re-injects overlay after every iframe load so that navigation doesn't lose
   * the ghost layer.
   */
  if (frameEl) {
    frameEl.addEventListener("load", function () {
      overlayReady = false;
      if (selectorActive) {
        injectOverlayIntoIframe();
      }
    });
  }

  /** Send a command to the iframe overlay */
  function sendToOverlay(type) {
    if (!frameEl || !frameEl.contentWindow) { return; }
    frameEl.contentWindow.postMessage({ type }, "*");
  }

  /** Toggle the Surgical Selector mode */
  function setSelectorMode(enabled) {
    selectorActive = enabled;
    if (selectorBtnEl) {
      selectorBtnEl.classList.toggle("selector-active", enabled);
      selectorBtnEl.title = enabled ? "Selector: ON — Click an element to jump to source" : "Selector: OFF";
    }
    if (selectorBadge) {
      selectorBadge.style.display = enabled ? "inline-block" : "none";
    }

    if (enabled) {
      injectOverlayIntoIframe();
      sendToOverlay("vanguard/activateOverlay");
      addEventLine("[selector] 🎯 Surgical Selector activated — click any element", "info");
    } else {
      sendToOverlay("vanguard/deactivateOverlay");
      addEventLine("[selector] Selector deactivated", "info");
    }
  }

  if (selectorBtnEl) {
    selectorBtnEl.addEventListener("click", function () {
      setSelectorMode(!selectorActive);
    });
  }

  // ── HARD RULE: The webview is NOT allowed to send line numbers or file paths.
  //   It only forwards the vId up to the Extension Host which is the source of truth.
  window.addEventListener("message", function (e) {
    const msg = e.data;
    if (!msg || typeof msg.type !== "string") { return; }

    // ── Messages from the iframe overlay ──────────────────────────────────────
    if (msg.type === "vanguard/overlayReady") {
      overlayReady = true;
      if (selectorActive) {
        sendToOverlay("vanguard/activateOverlay");
      }
      return;
    }

    if (msg.type === "preview/selectElement") {
      // Relay to Extension Host — ONLY the vId, never stale coords
      if (typeof msg.vId !== "string" || !msg.vId.trim()) { return; }
      addEventLine("[selector] ⚡ Selected: " + msg.vId, "info");

      // Auto-fill the mutation panel v-id field for convenience
      if (vIdInputEl) { vIdInputEl.value = msg.vId; }

      // ─────────────────────────────────────────────────────────────────────
      // DISPATCH TO HOST — clean minimal payload
      // ─────────────────────────────────────────────────────────────────────
      vscode.postMessage({ type: "preview/selectElement", vId: msg.vId });
      return;
    }

    // ── Messages FROM Extension Host (postMessage via webview channel) ─────
    const message = msg;
    switch (message.type) {
      case "preview/runtimeStatus":
        setStatus(String(message.status || "Idle"));
        break;
      case "preview/runtimeUrl":
        setPreviewUrl(String(message.url || ""));
        break;
      case "preview/runtimeLog":
        addEventLine(String(message.line || ""), String(message.level || "info"));
        break;
      case "preview/mutationState":
        addEventLine("[mutation] " + message.status + ": " + message.message,
          message.status === "failed" ? "error" : "info");
        // If a mutation just completed, re-activate selector so user can keep picking
        if (message.status === "succeeded" && selectorActive) {
          setSelectorMode(true);
        }
        break;
      case "preview/validationFinished":
        addEventLine(
          "[validation] " + message.filePath + ": " +
          message.issueCount + " issue(s), " + message.validCount + " fingerprint(s)",
          Number(message.issueCount) > 0 ? "warn" : "info"
        );
        break;
      case "preview/scanFinished":
        addEventLine(
          "[scan] files=" + message.fileCount + " issues=" + message.issueCount,
          Number(message.issueCount) > 0 ? "warn" : "info"
        );
        break;
      case "preview/fileSaved":
        addEventLine("[save] " + message.filePath, "info");
        refreshPreviewFrame();
        break;
      case "preview/overlayScript":
        // Host sends us the overlay.js source text so we can inject it
        if (typeof message.script === "string") {
          overlayScriptText = message.script;
          if (selectorActive) {
            injectOverlayIntoIframe();
          }
        }
        break;
      case "preview/selectorResult":
        addEventLine("[selector] → " + message.filePath + ":" + message.line, "info");
        break;
      default:
        break;
    }
  });

  // ── Bootstrap ───────────────────────────────────────────────────────────────
  vscode.postMessage({ type: "preview/webviewReady" });
  // Ask host to send overlay script source (will arrive as preview/overlayScript)
  vscode.postMessage({ type: "preview/requestOverlayScript" });
})();
