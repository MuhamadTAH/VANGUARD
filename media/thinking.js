(function () {
  "use strict";
  const vscode = (typeof acquireVsCodeApi === "function") ? acquireVsCodeApi() : null;

  // ── Elements ────────────────────────────────────────────────────────────────

  const latencyBadge = document.getElementById("latency-badge");
  const sessionHeader = document.getElementById("session-header");
  const sessionVid = document.getElementById("session-vid");
  const sessionPrompt = document.getElementById("session-prompt");
  const sessionAttempt = document.getElementById("session-attempt");

  const phaseReasoning = document.getElementById("phase-reasoning");
  const reasoningContent = document.getElementById("reasoning-content");
  const phaseCode = document.getElementById("phase-code");
  const codeContent = document.getElementById("code-content");
  const phaseValidating = document.getElementById("phase-validating");
  const validatingStatus = document.getElementById("validating-status");

  const retryLog = document.getElementById("retry-log");
  const outcome = document.getElementById("outcome");
  const outcomeIcon = document.getElementById("outcome-icon");
  const outcomeMessage = document.getElementById("outcome-message");
  const outcomeCommit = document.getElementById("outcome-commit");
  const idleState = document.getElementById("idle-state");

  const historyList = document.getElementById("history-list");

  // ── State ────────────────────────────────────────────────────────────────────

  let firstTokenLogged = false;
  let latencyMs = -1;

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function show(el) {
    if (el) el.classList.remove("hidden");
  }

  function hide(el) {
    if (el) el.classList.add("hidden");
  }

  function setText(el, text) {
    if (el) el.textContent = text;
  }

  /**
   * Appends text to a <pre> and auto-scrolls it to the bottom.
   * Uses requestAnimationFrame to batch DOM writes.
   */
  function appendAndScroll(el, delta) {
    if (!el || !delta) return;
    el.textContent += delta;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }

  function flashAmber(el) {
    if (!el) return;
    el.classList.remove("amber-flash-anim");
    // Force reflow to restart animation
    void el.offsetWidth;
    el.classList.add("amber-flash-anim");
    el.addEventListener("animationend", () => {
      el.classList.remove("amber-flash-anim");
    }, { once: true });
  }

  // ── Message handler ──────────────────────────────────────────────────────────

  window.addEventListener("message", (event) => {
    const msg = event.data || {};

    switch (msg.type) {
      case "session/start": {
        // Reset state
        firstTokenLogged = false;
        latencyMs = -1;

        hide(idleState);
        hide(outcome);
        show(sessionHeader);

        setText(sessionVid, `⬡ ${msg.vId || "unknown"}`);
        setText(sessionPrompt, msg.prompt || "");

        if (msg.attempt > 1) {
          show(sessionAttempt);
          setText(sessionAttempt, `Attempt ${msg.attempt}`);
        } else {
          hide(sessionAttempt);
        }

        // Reset phase blocks
        hide(phaseReasoning);
        hide(phaseCode);
        hide(phaseValidating);
        setText(reasoningContent, "");
        setText(codeContent, "");

        // Clear retry log
        if (retryLog) retryLog.innerHTML = "";

        // Reset outcome
        if (outcome) outcome.className = "hidden";
        if (latencyBadge) latencyBadge.className = "badge hidden";

        break;
      }

      case "session/chunk": {
        const phase = msg.phase;
        const delta = msg.delta || "";

        // Record first-token latency once
        if (!firstTokenLogged && typeof msg.firstTokenMs === "number" && msg.firstTokenMs >= 0) {
          latencyMs = msg.firstTokenMs;
          firstTokenLogged = true;
          if (latencyBadge) {
            latencyBadge.textContent = `${latencyMs}ms`;
            latencyBadge.className = "badge";
          }
        }

        if (phase === "reasoning") {
          show(phaseReasoning);
          appendAndScroll(reasoningContent, delta);
        } else if (phase === "code") {
          show(phaseCode);
          appendAndScroll(codeContent, delta);
        } else if (phase === "done") {
          // Final code already written token-by-token; nothing extra needed
        }
        break;
      }

      case "session/validating": {
        show(phaseValidating);
        setText(validatingStatus, "Running v-id integrity check…");
        flashAmber(phaseValidating);
        break;
      }

      case "session/retry": {
        // Flash the validating block amber
        flashAmber(phaseValidating);
        setText(validatingStatus, `Rejected — launching attempt ${msg.attempt}…`);

        // Add entry to retry log
        if (retryLog) {
          const entry = document.createElement("div");
          entry.className = "retry-entry";
          entry.innerHTML = `
            <div class="retry-label">⚠ Retry ${msg.attempt}</div>
            <div class="retry-feedback">${escapeHtml(msg.feedback || "Validator rejected output.")}</div>
          `;
          retryLog.appendChild(entry);
          retryLog.scrollTop = retryLog.scrollHeight;
        }

        // Reset phase blocks for second pass
        hide(phaseReasoning);
        hide(phaseCode);
        setText(reasoningContent, "");
        setText(codeContent, "");
        break;
      }

      case "session/success": {
        hide(phaseValidating);
        show(outcome);
        outcome.className = "outcome-success";

        setText(outcomeIcon, "✓");
        setText(outcomeMessage, "Mutation applied successfully.");

        const commit = msg.commitOid ? msg.commitOid.slice(0, 8) : null;
        setText(outcomeCommit, commit ? `commit ${commit}` : "");

        if (typeof msg.firstTokenMs === "number") {
          latencyMs = msg.firstTokenMs;
        }
        if (latencyBadge && latencyMs >= 0) {
          latencyBadge.textContent = `${latencyMs}ms`;
          latencyBadge.className = "badge success";
        }
        break;
      }

      case "history/refresh": {
        if (vscode) {
          vscode.postMessage({ type: "history/request" });
        }
        break;
      }

      case "history/data": {
        const entries = msg.entries || [];
        if (historyList) {
          historyList.innerHTML = "";
          if (entries.length === 0) {
            historyList.innerHTML = '<div class="muted">No history yet.</div>';
          } else {
            entries.forEach(entry => {
              const el = document.createElement("div");
              el.className = "history-item";
              
              const promptEl = document.createElement("div");
              promptEl.className = "history-item-prompt";
              
              // Extract prompt from commit message, fallback to raw message
              const parts = entry.message.split("\\n\\nprompt: ");
              const promptText = parts.length > 1 ? parts[1].trim() : entry.message;
              promptEl.textContent = promptText;

              const metaEl = document.createElement("div");
              metaEl.className = "history-item-meta";
              
              const timeString = new Date(entry.timestamp).toLocaleTimeString();
              const hashString = entry.oid.slice(0, 7);
              
              const infoEl = document.createElement("span");
              infoEl.textContent = `${timeString} • ${hashString}`;

              const btnEl = document.createElement("button");
              btnEl.className = "restore-btn";
              btnEl.textContent = "Restore";
              btnEl.onclick = () => {
                if (vscode) {
                  vscode.postMessage({ type: "history/restore", oid: entry.oid });
                }
              };

              metaEl.appendChild(infoEl);
              metaEl.appendChild(btnEl);

              el.appendChild(promptEl);
              el.appendChild(metaEl);

              historyList.appendChild(el);
            });
          }
        }
        break;
      }

      default:
        break;
    }
  });

  // Request initial history
  if (vscode) {
    vscode.postMessage({ type: "history/request" });
  }

  // ── Utility ──────────────────────────────────────────────────────────────────

  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
})();
