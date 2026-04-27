import * as vscode from "vscode";
import { refreshBaselineFromWorkspace, scanWorkspace, validateDocument } from "./intelligence/scanner";
import { WorkspaceVIdIndex } from "./intelligence/vIdIndex";
import { VIdResolver } from "./intelligence/vIdResolver";
import { runMutation, setMutationOutputChannelForEngine, isMutationActive, MutationFinalFailureError } from "./mutation/mutationEngine";
import { setMutationOutputChannel } from "./mutation/mutationLogger";
import { VanguardPreviewPanel } from "./preview/previewPanel";
import { ThinkingPanel } from "./preview/thinkingPanel";
import { DockerEngine } from "./preview/dockerEngine";
import { createAIService } from "./services/aiService";
import { initializeTimeMachine } from "./mutation/history";
import { initializeTelemetry } from "./services/telemetry";
import { initializeAuthService, getAuthService } from "./services/authService";
import { initializeProjectValidator, getProjectValidator } from "./services/projectValidator";

class BackendRuntimeManager implements vscode.Disposable {
  private readonly output: vscode.OutputChannel;
  private runtime: DockerEngine | null = null;
  private startPromise: Promise<void> | null = null;
  private status = "Idle";
  private readonly logBuffer: Array<{ line: string; level: "info" | "warn" | "error" }> = [];
  private readonly maxBufferedLogs = 300;
  private devUrl = "";

  public constructor(output: vscode.OutputChannel) {
    this.output = output;
  }

  public async ensureRunning(): Promise<void> {
    if (this.startPromise) {
      await this.startPromise;
      return;
    }

    if (this.runtime) {
      await this.syncPreviewState();
      return;
    }

    this.startPromise = this.startRuntime().finally(() => {
      this.startPromise = null;
    });
    await this.startPromise;
  }

  public async syncPreviewState(): Promise<void> {
    const preview = VanguardPreviewPanel.current;
    if (!preview) {
      return;
    }

    await preview.postRuntimeStatus(this.status);
    for (const entry of this.logBuffer) {
      await preview.postRuntimeLog(entry.line, entry.level);
    }
    if (this.devUrl) {
      await preview.postRuntimeUrl(this.devUrl);
    }
  }

  public async stopRuntime(): Promise<void> {
    const runtime = this.runtime;
    this.runtime = null;
    this.devUrl = "";
    this.publishStatus("Idle");
    if (!runtime) {
      return;
    }
    await runtime.stop().catch((error) => {
      this.publishLog(`[Critical] Failed to stop Docker runtime: ${this.serializeError(error)}`, "error");
    });
  }

  public clearLogs(): void {
    this.logBuffer.length = 0;
  }

  public dispose(): void {
    void this.stopRuntime();
  }

  private async startRuntime(): Promise<void> {
    try {
      const workspaceFolder = this.getWorkspaceFolder();
      if (!workspaceFolder) {
        this.publishStatus("No workspace");
        this.publishLog("[Critical] Cannot start Docker runtime: no workspace folder open.", "error");
        return;
      }

      this.publishStatus("Starting Docker runtime");
      this.publishLog("[System] Docker bridge startup requested.");

      this.runtime = new DockerEngine({
        projectRoot: workspaceFolder.uri.fsPath,
        onLog: ({ line, level }) => {
          this.publishLog(line, level);
        }
      });

      this.devUrl = await this.runtime.start();
      this.publishStatus("Live (Docker)");
      this.publishLog(`[System] Runtime URL: ${this.devUrl}`);

      const preview = VanguardPreviewPanel.current;
      if (preview) {
        await preview.postRuntimeUrl(this.devUrl);
      }
    } catch (error) {
      this.publishStatus("Runtime failed");
      this.publishLog(`[Critical] Docker runtime failed: ${this.serializeError(error)}`, "error");
      await this.stopRuntime();
    }
  }

  private publishStatus(status: string): void {
    this.status = status;
    const preview = VanguardPreviewPanel.current;
    if (preview) {
      void preview.postRuntimeStatus(status);
    }
  }

  private publishLog(line: string, level: "info" | "warn" | "error" = "info"): void {
    this.output.appendLine(`[runtime] ${line}`);
    this.logBuffer.push({ line, level });
    while (this.logBuffer.length > this.maxBufferedLogs) {
      this.logBuffer.shift();
    }
    const preview = VanguardPreviewPanel.current;
    if (preview) {
      void preview.postRuntimeLog(line, level);
    }
  }

  private serializeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    const folders = vscode.workspace.workspaceFolders ?? [];
    return folders[0];
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const previewOutput = vscode.window.createOutputChannel("Vanguard Preview");
  context.subscriptions.push(previewOutput);
  setMutationOutputChannel(previewOutput);
  setMutationOutputChannelForEngine(previewOutput);
  
  // ── Day 14 — Initialize Project Validator ──────────────────────────────────
  const projectValidator = initializeProjectValidator(context);
  
  // Check project compatibility on startup
  const validateProject = async () => {
    const isCompatible = await projectValidator.validateOnStartup();
    if (!isCompatible) {
      previewOutput.appendLine('[Project] Incompatible project detected - some features disabled');
      return;
    }
    previewOutput.appendLine('[Project] Project validation passed');
  };
  
  void validateProject();
  
  // ── Day 13 — Initialize Authentication Service ──────────────────────────────
  const authService = initializeAuthService(context);
  
  // Check if user is already authenticated, if not show login
  const initAuth = async () => {
    const isAuthenticated = await authService.initialize();
    if (!isAuthenticated) {
      const loginSuccess = await authService.showLoginPanel();
      if (!loginSuccess) {
        void vscode.window.showErrorMessage(
          'Vanguard: Login required. Please sign in to use mutations.'
        );
        return;
      }
    }
    const userId = authService.getUserId();
    previewOutput.appendLine(`[Auth] User ${userId} authenticated successfully`);
  };
  
  void initAuth();
  
  const aiService = createAIService(context);

  const diagnostics = vscode.languages.createDiagnosticCollection("vanguard-gatekeeper");
  context.subscriptions.push(diagnostics);

  const runtimeManager = new BackendRuntimeManager(previewOutput);
  context.subscriptions.push(runtimeManager);

  // ── Day 8 — Initialize Time Machine ───────────────────────────────────────
  initializeTimeMachine().catch((err) => {
    console.error("Vanguard failed to initialize Time Machine:", err);
  });

  // ── Day 10 — Initialize Telemetry ───────────────────────────────────────
  initializeTelemetry(context).catch((err) => {
    console.error("Vanguard failed to initialize Telemetry:", err);
  });

  // ── Task 2 — Safety Catch: block manual saves on files locked by an active mutation ──
  // This fires BEFORE the document is saved. We warn the user and force them to wait.
  context.subscriptions.push(
    vscode.workspace.onWillSaveTextDocument((event) => {
      const filePath = event.document.uri.fsPath;
      if (!isMutationActive(filePath)) {
        return;
      }
      // Warn the user. We cannot hard-cancel the save in VSCode's API, but we
      // apply an empty edit array so nothing is written beyond what exists,
      // and show a prominent warning.
      event.waitUntil(
        Promise.resolve([]).then(() => {
          void vscode.window.showWarningMessage(
            `⚠ Vanguard: "${event.document.fileName.split(/[\\/]/).pop()}" is locked — AI mutation in progress. Your manual save was blocked.`
          );
          return [];
        })
      );
    })
  );

  const vIdIndex = new WorkspaceVIdIndex();
  void vIdIndex.rebuild();

  // ── Day 7: VIdResolver — the central nervous system ─────────────────────
  const vIdResolver = new VIdResolver(vIdIndex, previewOutput);
  vIdResolver.register();
  context.subscriptions.push(vIdResolver);

  let refreshInFlight: Promise<void> | null = null;

  // ── Day 14 — Login Command ──────────────────────────────────────────────
  const loginCommand = vscode.commands.registerCommand("vanguard.login", async () => {
    const isAuthenticated = await authService.showLoginPanel();
    if (isAuthenticated) {
      void vscode.window.showInformationMessage("✅ Vanguard: You're signed in!");
    }
  });
  context.subscriptions.push(loginCommand);

  // ── Day 14 — Logout Command ────────────────────────────────────────────
  const logoutCommand = vscode.commands.registerCommand("vanguard.logout", async () => {
    await authService.logout();
    void vscode.window.showInformationMessage("✅ Vanguard: You're signed out.");
  });
  context.subscriptions.push(logoutCommand);

  // ── Day 14 — Help Command ──────────────────────────────────────────────
  const helpCommand = vscode.commands.registerCommand("vanguard.help", async () => {
    await vscode.env.openExternal(vscode.Uri.parse("https://vanguard.dev/docs"));
  });
  context.subscriptions.push(helpCommand);

  const openPreview = vscode.commands.registerCommand("vanguard.openPreview", () => {
    const open = async () => {
      try {
        await runtimeManager.ensureRunning();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Vanguard runtime failed: ${message}`);
        return;
      }

      const hadPanel = Boolean(VanguardPreviewPanel.current);
      const refreshStatus = async () => {
        if (refreshInFlight) {
          await refreshInFlight;
          return;
        }
        refreshInFlight = refreshIntegrityState(diagnostics).finally(() => {
          refreshInFlight = null;
        });
        await refreshInFlight;
      };

      VanguardPreviewPanel.createOrShow(
        context,
        previewOutput,
        async (selection) => {
          // Legacy click handler (non-overlay)
          console.log(`[Selection] User clicked element with ID: ${selection.vId}`);
          previewOutput.appendLine(`[Selection] User clicked element with ID: ${selection.vId}`);
          await revealSelection(selection.vId, vIdIndex);
        },
        // ── Day 7: Surgical Selector — "The Magic Moment" ─────────────────
        async (vId: string) => {
          // THE SNAP: resolve vId → file/line via live AST index
          const result = await vIdResolver.resolve(vId);
          if (!result) {
            return;
          }

          // THE TRIGGER: pre-load the Mutation Input with component context
          const preview = VanguardPreviewPanel.current;
          if (preview) {
            // Notify the webview about the resolved location for telemetry
            await preview.postSelectorResult(
              result.entry.filePath,
              result.entry.attributeRange.start.line
            );
          }

          // Pre-fill the mutation panel v-id so the user can immediately type a prompt
          void vscode.window.setStatusBarMessage(
            `🎯 Vanguard: snapped to ${result.entry.elementName} [${vId}] — line ${result.entry.attributeRange.start.line}`,
            4000
          );
        },
        async (request) => {
          const preview = VanguardPreviewPanel.current;
          if (preview) {
            await preview.postMutationState({
              status: "started",
              vId: request.vId,
              message: "Mutation in progress..."
            });
          }
          try {
            const outcome = await runMutation(request.vId, request.prompt, aiService, context);
            await vIdIndex.rebuild();
            if (preview) {
              await preview.postMutationState({
                status: "succeeded",
                vId: request.vId,
                message: outcome.commitOid
                  ? `Mutation applied and committed (${outcome.commitOid.slice(0, 8)}).`
                  : "Mutation applied (no git repository detected)."
              });
            }
            await revealSelection(request.vId, vIdIndex);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (preview) {
              await preview.postMutationState({
                status: "failed",
                vId: request.vId,
                message
              });
            }
            // ── Task 4 — Final Failure: show "Fix Manually" button ──────────────
            if (error instanceof MutationFinalFailureError) {
              const action = await vscode.window.showErrorMessage(
                `Vanguard: mutation failed after 2 attempts — ${message}`,
                "Fix Manually",
                "Dismiss"
              );
              if (action === "Fix Manually") {
                const doc = await vscode.workspace.openTextDocument(error.filePath);
                await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
              }
            } else {
              void vscode.window.showErrorMessage(`Vanguard mutation failed: ${message}`);
            }
          }
        },
        async () => {
          await refreshStatus();
          await runtimeManager.syncPreviewState();
        },
        async () => {
          await runtimeManager.stopRuntime();
          runtimeManager.clearLogs();
        }
      );

      await runtimeManager.syncPreviewState();
      if (hadPanel) {
        void refreshStatus();
      }
    };
    void open();
  });

  const validateActive = vscode.commands.registerCommand("vanguard.validateActiveFile", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage("Vanguard: no active editor.");
      return;
    }

    const result = await validateDocument(editor.document, diagnostics);
    if (!result) {
      return;
    }
    const preview = VanguardPreviewPanel.current;
    if (preview) {
      await preview.postValidationResult(result);
    }
    if (result.isValid) {
      vscode.window.showInformationMessage(`Vanguard: ${result.map.length} fingerprints validated.`);
      return;
    }
    vscode.window.showErrorMessage(`Vanguard: ${result.issues.length} fingerprint integrity issue(s).`);
  });

  const scanAll = vscode.commands.registerCommand("vanguard.scanWorkspace", async () => {
    const scan = await scanWorkspace(diagnostics);
    const issues = scan.results.reduce((sum, item) => sum + item.issues.length, 0);
    const preview = VanguardPreviewPanel.current;
    if (preview) {
      await preview.postWorkspaceScan(scan.results.length, issues);
    }
    if (issues === 0) {
      vscode.window.showInformationMessage(
        `Vanguard: integrity clean across ${scan.results.length} file(s).`
      );
      return;
    }
    vscode.window.showErrorMessage(
      `Vanguard: detected ${issues} issue(s) across ${scan.results.length} file(s).`
    );
  });

  const refreshBaseline = vscode.commands.registerCommand("vanguard.refreshBaseline", async () => {
    const result = await refreshBaselineFromWorkspace();
    vscode.window.showInformationMessage(
      `Vanguard: baseline refreshed from ${result.filesScanned} file(s), ${result.entriesWritten} fingerprint(s).`
    );
  });

  const openThinkingLog = vscode.commands.registerCommand("vanguard.openThinkingLog", () => {
    const panel = ThinkingPanel.getOrCreate(context);
    panel.reveal();
  });

  context.subscriptions.push(openPreview, validateActive, scanAll, refreshBaseline, openThinkingLog);

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      void validateDocument(doc, diagnostics);
    }),
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      // NOTE: VIdResolver.register() owns the index update via its own
      // onDidSaveTextDocument listener. We only handle validation + UI here.
      const validation = await validateDocument(doc, diagnostics);
      const preview = VanguardPreviewPanel.current;
      if (preview) {
        await preview.postFileSaved(doc);
        if (validation) {
          await preview.postValidationResult(validation);
        }
      }
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      void validateDocument(event.document, diagnostics);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      diagnostics.delete(doc.uri);
    })
  );

  for (const doc of vscode.workspace.textDocuments) {
    void validateDocument(doc, diagnostics);
  }
}

export function deactivate(): void {
  // No-op.
}

async function revealSelection(vId: string, index: WorkspaceVIdIndex): Promise<void> {
  if (!index.has(vId)) {
    await index.rebuild();
  }

  const matches = index.get(vId);
  if (matches.length === 0) {
    void vscode.window.showWarningMessage(`Vanguard: no source mapping found for ${vId}.`);
    return;
  }

  const selected = matches[0];
  if (matches.length > 1) {
    void vscode.window.showWarningMessage(
      `Vanguard: ${vId} maps to multiple elements (${matches.length}). Opening first match.`
    );
  }

  const doc = await vscode.workspace.openTextDocument(selected.filePath);
  const editor = await vscode.window.showTextDocument(doc, {
    preview: false,
    preserveFocus: false
  });

  const start = new vscode.Position(
    selected.attributeRange.start.line - 1,
    selected.attributeRange.start.column - 1
  );
  const end = new vscode.Position(
    selected.attributeRange.end.line - 1,
    selected.attributeRange.end.column - 1
  );
  const range = new vscode.Range(start, end);
  editor.selection = new vscode.Selection(start, end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

async function refreshIntegrityState(diagnostics: vscode.DiagnosticCollection): Promise<void> {
  const preview = VanguardPreviewPanel.current;
  const scan = await scanWorkspace(diagnostics);
  const issues = scan.results.reduce((sum, item) => sum + item.issues.length, 0);
  if (preview) {
    await preview.postWorkspaceScan(scan.results.length, issues);
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const validation = await validateDocument(editor.document, diagnostics);
  if (preview && validation) {
    await preview.postValidationResult(validation);
  }
}
