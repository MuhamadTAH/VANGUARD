import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { ValidationResult } from "../intelligence/types";

interface PreviewMessage {
  readonly type: string;
  readonly [key: string]: unknown;
}

type SelectionHandler = (selection: {
  vId: string;
  tagName?: string;
}) => Promise<void>;

type SurgicalSelectHandler = (vId: string) => Promise<void>;

type MutationHandler = (request: {
  vId: string;
  prompt: string;
}) => Promise<void>;

type RequestStatusHandler = () => Promise<void>;
type DisposeHandler = () => Promise<void>;

export class VanguardPreviewPanel {
  private static currentPanel: VanguardPreviewPanel | undefined;

  public static createOrShow(
    context: vscode.ExtensionContext,
    outputChannel: vscode.OutputChannel,
    onSelect: SelectionHandler,
    onSurgicalSelect: SurgicalSelectHandler,
    onMutate: MutationHandler,
    onRequestStatus: RequestStatusHandler,
    onDispose: DisposeHandler
  ): VanguardPreviewPanel {
    if (VanguardPreviewPanel.currentPanel) {
      VanguardPreviewPanel.currentPanel.onSelect = onSelect;
      VanguardPreviewPanel.currentPanel.onSurgicalSelect = onSurgicalSelect;
      VanguardPreviewPanel.currentPanel.onMutate = onMutate;
      VanguardPreviewPanel.currentPanel.onRequestStatus = onRequestStatus;
      VanguardPreviewPanel.currentPanel.onDisposeHandler = onDispose;
      VanguardPreviewPanel.currentPanel.panel.reveal(vscode.ViewColumn.Beside);
      return VanguardPreviewPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      "vanguardPreview",
      "Vanguard Preview",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")]
      }
    );

    VanguardPreviewPanel.currentPanel = new VanguardPreviewPanel(
      context,
      panel,
      outputChannel,
      onSelect,
      onSurgicalSelect,
      onMutate,
      onRequestStatus,
      onDispose
    );
    return VanguardPreviewPanel.currentPanel;
  }

  public static get current(): VanguardPreviewPanel | undefined {
    return VanguardPreviewPanel.currentPanel;
  }

  private readonly context: vscode.ExtensionContext;
  private readonly panel: vscode.WebviewPanel;
  private readonly output: vscode.OutputChannel;
  private onSelect: SelectionHandler;
  private onSurgicalSelect: SurgicalSelectHandler;
  private onMutate: MutationHandler;
  private onRequestStatus: RequestStatusHandler;
  private onDisposeHandler: DisposeHandler;

  private constructor(
    context: vscode.ExtensionContext,
    panel: vscode.WebviewPanel,
    outputChannel: vscode.OutputChannel,
    onSelect: SelectionHandler,
    onSurgicalSelect: SurgicalSelectHandler,
    onMutate: MutationHandler,
    onRequestStatus: RequestStatusHandler,
    onDispose: DisposeHandler
  ) {
    this.context = context;
    this.panel = panel;
    this.output = outputChannel;
    this.onSelect = onSelect;
    this.onSurgicalSelect = onSurgicalSelect;
    this.onMutate = onMutate;
    this.onRequestStatus = onRequestStatus;
    this.onDisposeHandler = onDispose;

    this.panel.webview.html = this.render();

    this.panel.onDidDispose(() => {
      if (VanguardPreviewPanel.currentPanel === this) {
        VanguardPreviewPanel.currentPanel = undefined;
      }
      void this.onDisposeHandler();
    });

    this.panel.onDidChangeViewState((event) => {
      void this.onVisibilityChanged(event.webviewPanel.visible);
    });

    this.panel.webview.onDidReceiveMessage((message) => {
      console.log("[Host] Received message from webview:", message);
      this.handleWebviewMessage(message as PreviewMessage);
    });

    void this.onVisibilityChanged(this.panel.visible);
  }

  public async postValidationResult(validation: ValidationResult): Promise<void> {
    await this.panel.webview.postMessage({
      type: "preview/validationFinished",
      filePath: validation.filePath,
      issueCount: validation.issues.length,
      validCount: validation.map.length
    });
  }

  public async postWorkspaceScan(fileCount: number, issueCount: number): Promise<void> {
    await this.panel.webview.postMessage({
      type: "preview/scanFinished",
      fileCount,
      issueCount
    });
  }

  public async postFileSaved(document: vscode.TextDocument): Promise<void> {
    await this.panel.webview.postMessage({
      type: "preview/fileSaved",
      filePath: document.uri.fsPath
    });
  }

  public async postMutationState(state: {
    status: "started" | "succeeded" | "failed";
    vId: string;
    message: string;
  }): Promise<void> {
    await this.panel.webview.postMessage({
      type: "preview/mutationState",
      ...state
    });
  }

  public async postRuntimeStatus(status: string): Promise<void> {
    await this.panel.webview.postMessage({
      type: "preview/runtimeStatus",
      status
    });
  }

  public async postRuntimeLog(line: string, level: "info" | "warn" | "error" = "info"): Promise<void> {
    await this.panel.webview.postMessage({
      type: "preview/runtimeLog",
      line,
      level
    });
  }

  public async postRuntimeUrl(url: string): Promise<void> {
    await this.panel.webview.postMessage({
      type: "preview/runtimeUrl",
      url
    });
  }

  /** Notify the webview that a surgical selector hit was resolved */
  public async postSelectorResult(filePath: string, line: number): Promise<void> {
    await this.panel.webview.postMessage({
      type: "preview/selectorResult",
      filePath,
      line
    });
  }

  private async onVisibilityChanged(visible: boolean): Promise<void> {
    await this.panel.webview.postMessage({
      type: "preview/visibility",
      visible
    });
  }

  // ── IPC Dispatcher ─────────────────────────────────────────────────────────
  private handleWebviewMessage(message: PreviewMessage): void {
    switch (message.type) {
      case "preview/log": {
        const line = typeof message.message === "string" ? message.message : JSON.stringify(message);
        this.output.appendLine(`[preview] ${line}`);
        break;
      }

      // ── Legacy direct-click (fallback) ─────────────────────────────────────
      case "preview/domClick": {
        const vId = typeof message.vId === "string" ? message.vId : "(unknown)";
        const tag  = typeof message.tagName === "string" ? message.tagName : "unknown";
        this.output.appendLine(`[preview] DOM click: ${tag} v-id=${vId}`);
        void vscode.window.setStatusBarMessage(`Vanguard selected ${vId}`, 2500);
        if (typeof message.vId === "string") {
          void this.onSelect({
            vId: message.vId,
            tagName: typeof message.tagName === "string" ? message.tagName : undefined
          });
        }
        break;
      }

      // ── Day 7 — Surgical Selector: "Ghost Layer" click ─────────────────────
      case "preview/selectElement": {
        // HARD RULE: only vId arrives here — never stale line/file info
        const vId = typeof message.vId === "string" ? message.vId.trim() : "";
        if (!vId) {
          this.output.appendLine("[selector] Received empty v-id — ignored.");
          break;
        }

        this.output.appendLine(`[selector] ⚡ Ghost click resolved: ${vId}`);
        void vscode.window.setStatusBarMessage(`🎯 Vanguard: ${vId}`, 3000);

        // Hand off to the extension host's VIdResolver
        void this.onSurgicalSelect(vId);
        break;
      }

      // ── Overlay script delivery: webview requests the overlay.js source ────
      case "preview/requestOverlayScript": {
        void this.sendOverlayScript();
        break;
      }

      // ── Mutation request ───────────────────────────────────────────────────
      case "preview/mutateRequest": {
        const vId   = typeof message.vId    === "string" ? message.vId    : "";
        const prompt = typeof message.prompt === "string" ? message.prompt : "";
        if (!vId || !prompt.trim()) { break; }
        void this.onMutate({ vId, prompt });
        break;
      }

      case "preview/requestStatus":
      case "preview/webviewReady": {
        void this.onRequestStatus();
        break;
      }

      default:
        this.output.appendLine(`[preview] Unknown message: ${JSON.stringify(message)}`);
    }
  }

  /** Reads overlay.js from disk and sends its source text to the webview */
  private async sendOverlayScript(): Promise<void> {
    try {
      const overlayPath = path.join(this.context.extensionUri.fsPath, "media", "overlay.js");
      const script = fs.readFileSync(overlayPath, "utf-8");
      await this.panel.webview.postMessage({
        type: "preview/overlayScript",
        script
      });
    } catch (err) {
      this.output.appendLine(`[selector] Failed to load overlay.js: ${String(err)}`);
    }
  }

  private render(): string {
    const webview = this.panel.webview;
    const nonce = getNonce();
    const styleUri  = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "preview.css"));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "preview.js"));

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    http-equiv="Content-Security-Policy"
    content="
      default-src 'none';
      img-src ${webview.cspSource} data: blob: http: https:;
      style-src ${webview.cspSource} 'unsafe-inline';
      script-src 'self' ${webview.cspSource} 'nonce-${nonce}';
      frame-src http://localhost:* http://127.0.0.1:*;
      connect-src http://localhost:* http://127.0.0.1:*;
    "
  />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Vanguard Preview</title>
  <link rel="stylesheet" href="${styleUri}" />
</head>
<body>
  <header class="topbar">
    <div class="title">VANGUARD PREVIEW</div>
    <div class="topbar-actions">
      <!-- ── Surgical Selector Toggle (Day 7) ── -->
      <button id="selector-toggle" title="Selector: OFF — Click to activate element picker">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="8" cy="8" r="3" stroke="currentColor" stroke-width="1.5"/>
          <line x1="8" y1="1" x2="8" y2="4"  stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          <line x1="8" y1="12" x2="8" y2="15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          <line x1="1" y1="8" x2="4"  y2="8"  stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          <line x1="12" y1="8" x2="15" y2="8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        SELECTOR
        <span id="selector-badge">ON</span>
      </button>
      <div id="status" class="status">Idle</div>
    </div>
  </header>
  <main class="layout">
    <aside class="events">
      <h2>Telemetry</h2>
      <section class="mutate-box">
        <label for="mutate-v-id">v-id</label>
        <input id="mutate-v-id" type="text" placeholder="vg_btn_test" />
        <label for="mutate-prompt">Mutation Prompt</label>
        <textarea id="mutate-prompt" rows="4" placeholder="Translate this button text to Kurdish Sorani."></textarea>
        <button id="mutate-send" type="button">Run Mutation</button>
      </section>
      <div id="events" class="event-list"></div>
    </aside>
    <section class="canvas">
      <iframe id="preview-frame" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>
    </section>
  </main>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}
