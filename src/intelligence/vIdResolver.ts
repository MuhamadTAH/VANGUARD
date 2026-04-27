/**
 * VIdResolver — Day 7 Surgical Selector
 *
 * Central nervous system that maps a fingerprint (v-id) to a physical file
 * location using live AST-based indexing.
 *
 * Design rules:
 *  1. AST traversal only — no grep/regex to ensure JSX attribute precision.
 *  2. Line numbers are NEVER cached across file saves — the index is rebuilt
 *     per-file on every onDidSaveTextDocument event.
 *  3. The Webview is NOT consulted for location info. The Host is the
 *     single source of truth.
 *  4. The full rebuild (on activation) scans all .tsx/.jsx files once.
 *     Subsequent incremental updates are O(1-file).
 */

import * as vscode from "vscode";
import { WorkspaceVIdIndex } from "./vIdIndex";
import type { VIdMapEntry } from "./types";

export interface SurgicalSelectResult {
  readonly entry: VIdMapEntry;
  readonly editor: vscode.TextEditor;
}

export class VIdResolver {
  private readonly index: WorkspaceVIdIndex;
  private readonly output: vscode.OutputChannel;
  private readonly subscriptions: vscode.Disposable[] = [];

  public constructor(index: WorkspaceVIdIndex, outputChannel: vscode.OutputChannel) {
    this.index  = index;
    this.output = outputChannel;
  }

  /**
   * Register VSCode event hooks.
   * Call once from `activate()`.  Call `dispose()` on deactivation.
   */
  public register(): void {
    // ── Incremental Re-scan: only re-parse the saved file ──────────────────
    // TRAP LOGIC: stale line numbers are "poison" — every cached line below
    // a newly added line is wrong.  We update the entry on every save.
    const saveListener = vscode.workspace.onDidSaveTextDocument((doc) => {
      this.output.appendLine(`[VIdResolver] Incremental re-scan: ${doc.uri.fsPath}`);
      this.index.updateDocument(doc);
    });
    this.subscriptions.push(saveListener);
  }

  public dispose(): void {
    for (const sub of this.subscriptions) {
      sub.dispose();
    }
    this.subscriptions.length = 0;
  }

  /**
   * Resolve a v-id to a physical file location, open the file, and
   * move the editor cursor/selection to the exact JSX attribute line.
   *
   * Latency target: < 100ms from call to editor highlight.
   *
   * @returns The resolved entry and the resulting editor, or null if not found.
   */
  public async resolve(vId: string): Promise<SurgicalSelectResult | null> {
    const t0 = Date.now();

    // Fast path: index hit
    let matches = this.index.get(vId);

    // Slow path: index miss → full rebuild (should be rare)
    if (matches.length === 0) {
      this.output.appendLine(`[VIdResolver] Index miss for "${vId}" — triggering rebuild.`);
      await this.index.rebuild();
      matches = this.index.get(vId);
    }

    if (matches.length === 0) {
      this.output.appendLine(`[VIdResolver] ❌ "${vId}" not found in any .tsx/.jsx file.`);
      void vscode.window.showWarningMessage(
        `Vanguard: no source mapping found for "${vId}". Is the file saved?`
      );
      return null;
    }

    if (matches.length > 1) {
      this.output.appendLine(
        `[VIdResolver] ⚠ "${vId}" has ${matches.length} duplicate hits — using first match.`
      );
      void vscode.window.showWarningMessage(
        `Vanguard: "${vId}" maps to ${matches.length} elements. Opening first match.`
      );
    }

    const entry = matches[0];

    // ── Open the file and reveal the exact attribute line ──────────────────
    const doc    = await vscode.workspace.openTextDocument(entry.filePath);
    const editor = await vscode.window.showTextDocument(doc, {
      preview: false,
      preserveFocus: false,
      viewColumn: vscode.ViewColumn.One
    });

    // Convert 1-indexed AST positions → 0-indexed VSCode positions
    const startLine = Math.max(0, entry.attributeRange.start.line   - 1);
    const startCol  = Math.max(0, entry.attributeRange.start.column - 1);
    const endLine   = Math.max(0, entry.attributeRange.end.line     - 1);
    const endCol    = Math.max(0, entry.attributeRange.end.column   - 1);

    const start = new vscode.Position(startLine, startCol);
    const end   = new vscode.Position(endLine,   endCol);
    const range = new vscode.Range(start, end);

    // Snap cursor + highlight selection
    editor.selection = new vscode.Selection(start, end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);

    const elapsed = Date.now() - t0;
    this.output.appendLine(
      `[VIdResolver] ✅ "${vId}" → ${entry.filePath}:${entry.attributeRange.start.line} (${elapsed}ms)`
    );

    // Warn if we exceeded the 100ms latency target
    if (elapsed > 100) {
      this.output.appendLine(
        `[VIdResolver] ⚠ Latency target exceeded: ${elapsed}ms > 100ms.`
      );
    }

    return { entry, editor };
  }
}
