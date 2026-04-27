import * as vscode from "vscode";
import type { StreamPhase } from "../services/streamingAIService";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ThinkingSession {
  readonly vId: string;
  readonly prompt: string;
  readonly attempt: number;
}

// ─── Status bar color states ──────────────────────────────────────────────────
//
//  Idle          → default VS Code blue
//  Reasoning     → teal pulse
//  Generating    → teal steady
//  Validating    → amber flash (also on rejection)
//  Success       → green for 3 s then revert
//  Failed        → red, then revert

const STATUS_BAR_COLORS = {
  idle: undefined,
  reasoning: new vscode.ThemeColor("statusBarItem.warningBackground"), // warm amber during think
  generating: new vscode.ThemeColor("statusBarItem.prominentBackground"),
  validating: new vscode.ThemeColor("statusBarItem.warningBackground"),
  success: new vscode.ThemeColor("statusBarItem.prominentBackground"),
  failed: new vscode.ThemeColor("statusBarItem.errorBackground")
} as const;

// ─── ThinkingPanel ───────────────────────────────────────────────────────────

export class ThinkingPanel implements vscode.Disposable {
  private static instance: ThinkingPanel | undefined;

  /** Obtain or create the singleton panel. */
  public static getOrCreate(context: vscode.ExtensionContext): ThinkingPanel {
    if (!ThinkingPanel.instance) {
      ThinkingPanel.instance = new ThinkingPanel(context);
    }
    return ThinkingPanel.instance;
  }

  public static get current(): ThinkingPanel | undefined {
    return ThinkingPanel.instance;
  }

  // ── Instance ────────────────────────────────────────────────────────────────

  private readonly panel: vscode.WebviewPanel;
  private readonly statusItem: vscode.StatusBarItem;
  private revertTimer: ReturnType<typeof setTimeout> | undefined;

  private activeSession: ThinkingSession | undefined;

  private constructor(private readonly context: vscode.ExtensionContext) {
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusItem.text = "$(sparkle) Vanguard";
    this.statusItem.tooltip = "Vanguard mutation engine";
    this.statusItem.show();

    this.panel = vscode.window.createWebviewPanel(
      "vanguardThinking",
      "Vanguard · Agentic Stream",
      { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")]
      }
    );

    this.panel.webview.html = this.renderHtml();

    this.panel.webview.onDidReceiveMessage((message) => {
      this.handleWebviewMessage(message);
    });

    this.panel.onDidDispose(() => {
      ThinkingPanel.instance = undefined;
      this.statusItem.dispose();
    });
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Call when a mutation starts. Clears previous session. */
  public startSession(session: ThinkingSession): void {
    this.activeSession = session;
    this.panel.reveal(vscode.ViewColumn.Two, true);
    this.setStatusBarState("reasoning", `$(sync~spin) Vanguard: reasoning (${session.vId})`);
    void this.panel.webview.postMessage({
      type: "session/start",
      vId: session.vId,
      prompt: session.prompt,
      attempt: session.attempt
    });
  }

  /** Called on every streaming chunk. */
  public appendChunk(phase: StreamPhase, delta: string, firstTokenMs?: number): void {
    if (phase === "reasoning") {
      this.setStatusBarState("reasoning", `$(sync~spin) Vanguard: reasoning…`);
    } else if (phase === "code") {
      this.setStatusBarState("generating", `$(sync~spin) Vanguard: generating…`);
    } else if (phase === "validating") {
      this.setStatusBarState("validating", `$(sync~spin) Vanguard: validating…`);
    }

    void this.panel.webview.postMessage({
      type: "session/chunk",
      phase,
      delta,
      firstTokenMs
    });
  }

  /** Call when validation is running. Fires amber flash. */
  public startValidation(): void {
    this.setStatusBarState("validating", `$(sync~spin) Vanguard: validating…`);
    void this.panel.webview.postMessage({ type: "session/validating" });
  }

  /** Call when the validator rejected the output and retrying. */
  public retryNotice(attempt: number, feedback: string): void {
    this.flashAmber();
    void this.panel.webview.postMessage({
      type: "session/retry",
      attempt,
      feedback
    });
  }

  /** Call when mutation succeeded. */
  public sessionSuccess(commitOid: string | null, firstTokenMs: number): void {
    this.setStatusBarState("success", `$(check) Vanguard: done · ${firstTokenMs}ms`);
    void this.panel.webview.postMessage({
      type: "session/success",
      commitOid,
      firstTokenMs
    });
    this.refreshHistory();
    this.revertStatusBarAfter(4000);
  }

  /** Call when mutation failed (after max retries). */
  public sessionFailed(message: string): void {
    this.setStatusBarState("failed", `$(error) Vanguard: failed`);
    void this.panel.webview.postMessage({ type: "session/failed", message });
    this.revertStatusBarAfter(6000);
  }

  /** Reloads the history in the sidebar implicitly */
  public refreshHistory(): void {
    void this.panel.webview.postMessage({ type: "history/refresh" });
  }

  public dispose(): void {
    if (this.revertTimer) {
      clearTimeout(this.revertTimer);
    }
    this.statusItem.dispose();
    this.panel.dispose();
    ThinkingPanel.instance = undefined;
  }

  public reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Two, true);
  }

  // ── Status bar helpers ──────────────────────────────────────────────────────

  private setStatusBarState(
    state: keyof typeof STATUS_BAR_COLORS,
    text: string
  ): void {
    if (this.revertTimer) {
      clearTimeout(this.revertTimer);
      this.revertTimer = undefined;
    }
    this.statusItem.text = text;
    this.statusItem.backgroundColor = STATUS_BAR_COLORS[state];
  }

  private flashAmber(): void {
    this.statusItem.backgroundColor = STATUS_BAR_COLORS.validating;
    this.statusItem.text = "$(warning) Vanguard: rejected — retrying…";
  }

  private revertStatusBarAfter(ms: number): void {
    this.revertTimer = setTimeout(() => {
      this.statusItem.text = "$(sparkle) Vanguard";
      this.statusItem.backgroundColor = STATUS_BAR_COLORS.idle;
      this.revertTimer = undefined;
    }, ms);
  }

  // ── IPC ───────────────────────────────────────────────────────────────────

  private handleWebviewMessage(message: any): void {
    if (message.type === "history/request") {
      import("../mutation/history").then((mod) => {
        mod.getMutationHistory(10).then((entries) => {
          void this.panel.webview.postMessage({
            type: "history/data",
            entries
          });
        });
      });
    } else if (message.type === "history/restore") {
      const oid = message.oid;
      if (oid) {
        import("../mutation/history").then((mod) => {
          mod.restoreMutation(oid).then(() => {
            vscode.window.showInformationMessage("Vanguard Time Machine: Workspace restored.");
            // Re-fetch baseline maybe? But UI will just reset or we can leave it.
          }).catch(err => {
            vscode.window.showErrorMessage(`Time Machine failed: ${err.message}`);
          });
        });
      }
    }
  }

  // ── HTML renderer ──────────────────────────────────────────────────────────

  private renderHtml(): string {
    const nonce = getNonce();
    const styleUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "thinking.css")
    );
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "thinking.js")
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${this.panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Vanguard · Thinking</title>
  <link rel="stylesheet" href="${styleUri}" />
</head>
<body>
  <div id="topbar">
    <span id="title-text">VANGUARD · AGENTIC STREAM</span>
    <div id="latency-badge" class="badge hidden">— ms</div>
  </div>

  <div id="session-header" class="hidden">
    <div id="session-vid"></div>
    <div id="session-prompt"></div>
    <div id="session-attempt" class="attempt-badge"></div>
  </div>

  <div id="phases">
    <div id="phase-reasoning" class="phase-block hidden">
      <div class="phase-label">
        <span class="phase-icon">🧠</span> Reasoning
      </div>
      <pre id="reasoning-content" class="phase-content"></pre>
    </div>

    <div id="phase-code" class="phase-block hidden">
      <div class="phase-label">
        <span class="phase-icon">⚡</span> Code Generation
      </div>
      <pre id="code-content" class="phase-content code"></pre>
    </div>

    <div id="phase-validating" class="phase-block hidden">
      <div class="phase-label">
        <span class="phase-icon amber-flash">🛡</span> Validating
      </div>
      <div id="validating-status">Running v-id integrity check…</div>
    </div>
  </div>

  <div id="retry-log"></div>

  <div id="outcome" class="hidden">
    <div id="outcome-icon"></div>
    <div id="outcome-message"></div>
    <div id="outcome-commit" class="muted"></div>
  </div>

  <div id="idle-state">
    <div class="idle-icon">⬡</div>
    <div class="idle-text">Waiting for mutation request…</div>
  </div>

  <div id="history-sidebar">
    <h3>Time Machine</h3>
    <div id="history-list"></div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}
