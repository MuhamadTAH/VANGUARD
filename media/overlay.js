/**
 * VANGUARD SURGICAL SELECTOR — Overlay Script (Day 7)
 *
 * Injected into the preview iframe via postMessage → the parent webview
 * listens for "preview/iframeReady" and then injects this script.
 *
 * This script runs INSIDE the preview iframe document.
 * It communicates back to the parent webview via window.parent.postMessage.
 *
 * Protocol:
 *   parent → iframe : { type: "vanguard/activateOverlay" }
 *   parent → iframe : { type: "vanguard/deactivateOverlay" }
 *   iframe → parent : { type: "preview/selectElement", vId: string }
 */

(function installVanguardOverlay() {
  "use strict";

  // ── Guard: prevent double-installation ──────────────────────────────────────
  if (window.__vanguardOverlayInstalled) {
    return;
  }
  window.__vanguardOverlayInstalled = true;

  // ── Constants ──────────────────────────────────────────────────────────────
  const VANGUARD_BLUE = "#3b82f6";
  const ATTR_VID = "v-id";

  // ── Overlay DOM element ────────────────────────────────────────────────────
  const overlayEl = document.createElement("div");
  overlayEl.id = "__vanguard_overlay__";
  overlayEl.style.cssText = [
    "position:fixed",
    "top:0",
    "left:0",
    "width:0",
    "height:0",
    "pointer-events:none",
    "z-index:2147483647",
    "outline:none",
    "border-radius:2px",
    "transition:none",
    "display:none",
    `box-shadow:0 0 0 2px ${VANGUARD_BLUE},0 0 0 4px rgba(59,130,246,0.18)`,
  ].join(";");
  document.documentElement.appendChild(overlayEl);

  // ── Label chip ─────────────────────────────────────────────────────────────
  const labelEl = document.createElement("div");
  labelEl.id = "__vanguard_label__";
  labelEl.style.cssText = [
    "position:fixed",
    "pointer-events:none",
    "z-index:2147483647",
    "display:none",
    `background:${VANGUARD_BLUE}`,
    "color:#fff",
    "font:700 10px/1 'SF Mono',Consolas,'Courier New',monospace",
    "padding:2px 6px",
    "border-radius:3px",
    "white-space:nowrap",
    "letter-spacing:0.04em",
    "box-shadow:0 2px 8px rgba(0,0,0,0.35)",
  ].join(";");
  document.documentElement.appendChild(labelEl);

  // ── State ──────────────────────────────────────────────────────────────────
  let active = false;
  let rafId = 0;
  let currentVId = "";
  let pendingX = -1;
  let pendingY = -1;

  // ── Walk up DOM to find innermost v-id owner ────────────────────────────────
  function resolveVId(el) {
    let node = el;
    while (node) {
      const vid = node.getAttribute && node.getAttribute(ATTR_VID);
      if (vid) {
        return { node, vid };
      }
      node = node.parentElement;
    }
    return null;
  }

  // ── Draw highlight around a DOM node ───────────────────────────────────────
  function paintHighlight(node, vid) {
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      hideOverlay();
      return;
    }
    overlayEl.style.display = "block";
    overlayEl.style.top = rect.top + "px";
    overlayEl.style.left = rect.left + "px";
    overlayEl.style.width = rect.width + "px";
    overlayEl.style.height = rect.height + "px";

    // Label — clamp so it never overflows viewport
    labelEl.textContent = vid;
    labelEl.style.display = "block";
    const labelTop = Math.max(0, rect.top - 18);
    const rawLeft = rect.left;
    labelEl.style.top = labelTop + "px";
    labelEl.style.left = Math.max(0, rawLeft) + "px";
  }

  function hideOverlay() {
    overlayEl.style.display = "none";
    labelEl.style.display = "none";
    currentVId = "";
  }

  // ── rAF-batched mouse tracker ───────────────────────────────────────────────
  function scheduleFrame() {
    if (rafId) {
      return;
    }
    rafId = requestAnimationFrame(processFrame);
  }

  function processFrame() {
    rafId = 0;
    if (!active || pendingX < 0) {
      return;
    }

    const x = pendingX;
    const y = pendingY;
    const topEl = document.elementFromPoint(x, y);
    pendingX = -1;
    pendingY = -1;

    if (!topEl) {
      hideOverlay();
      return;
    }

    const hit = resolveVId(topEl);
    if (!hit) {
      hideOverlay();
      return;
    }

    const currentTop = document.elementFromPoint(x, y);
    if (!currentTop || (currentTop !== topEl && !topEl.contains(currentTop))) {
      hideOverlay();
      return;
    }

    currentVId = hit.vid;
    paintHighlight(hit.node, hit.vid);
  }

  function onMouseMove(e) {
    if (!active) {
      return;
    }
    pendingX = e.clientX;
    pendingY = e.clientY;
    scheduleFrame();
  }

  // ── Click interception ─────────────────────────────────────────────────────
  function onMouseDown(e) {
    if (!active || !currentVId) {
      return;
    }
    // Prevent normal click from reaching the app
    e.preventDefault();
    e.stopImmediatePropagation();

    const payload = { type: "preview/selectElement", vId: currentVId };
    // Send to parent webview (the VS Code panel)
    window.parent.postMessage(payload, "*");
  }

  function onSuppressClick(e) {
    if (!active) {
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function onViewportChanged() {
    if (!active) {
      return;
    }
    hideOverlay();
    pendingX = -1;
    pendingY = -1;
  }

  // ── Activation API (driven by parent postMessage) ──────────────────────────
  function activateOverlay() {
    if (active) {
      return;
    }
    active = true;
    document.addEventListener("mousemove", onMouseMove, { passive: true });
    document.addEventListener("mousedown", onMouseDown, { capture: true });
    document.addEventListener("mouseup", onSuppressClick, { capture: true });
    document.addEventListener("click", onSuppressClick, { capture: true });
    window.addEventListener("scroll", onViewportChanged, { capture: true, passive: true });
    window.addEventListener("resize", onViewportChanged, { passive: true });
  }

  function deactivateOverlay() {
    if (!active) {
      return;
    }
    active = false;
    hideOverlay();
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mousedown", onMouseDown, { capture: true });
    document.removeEventListener("mouseup", onSuppressClick, { capture: true });
    document.removeEventListener("click", onSuppressClick, { capture: true });
    window.removeEventListener("scroll", onViewportChanged, { capture: true });
    window.removeEventListener("resize", onViewportChanged);
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    pendingX = -1;
    pendingY = -1;
  }

  // ── Listen for commands from parent webview ────────────────────────────────
  window.addEventListener("message", function (e) {
    const msg = e.data;
    if (!msg || typeof msg.type !== "string") {
      return;
    }
    if (msg.type === "vanguard/activateOverlay") {
      activateOverlay();
    } else if (msg.type === "vanguard/deactivateOverlay") {
      deactivateOverlay();
    }
  });

  // Signal readiness to parent
  window.parent.postMessage({ type: "vanguard/overlayReady" }, "*");
})();
