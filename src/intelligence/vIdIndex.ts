import * as vscode from "vscode";
import { validateFingerprints } from "./fingerprintGatekeeper";
import { normalizeFilePath } from "./baselineStore";
import type { VIdMapEntry } from "./types";

export class WorkspaceVIdIndex {
  private readonly byId = new Map<string, VIdMapEntry[]>();
  private readonly byFile = new Map<string, VIdMapEntry[]>();

  public async rebuild(): Promise<void> {
    this.byId.clear();
    this.byFile.clear();

    const files = await vscode.workspace.findFiles(
      "**/*.{tsx,jsx}",
      "**/{node_modules,.next,out,dist,build}/**"
    );

    for (const uri of files) {
      const document = await vscode.workspace.openTextDocument(uri);
      this.updateFromText(document.uri.fsPath, document.getText());
    }
  }

  public updateDocument(document: vscode.TextDocument): void {
    if (!isFingerprintLanguage(document.languageId)) {
      return;
    }
    this.updateFromText(document.uri.fsPath, document.getText());
  }

  public get(vId: string): VIdMapEntry[] {
    return this.byId.get(vId) ?? [];
  }

  public has(vId: string): boolean {
    return this.byId.has(vId);
  }

  private updateFromText(filePathRaw: string, source: string): void {
    const filePath = normalizeFilePath(filePathRaw);
    const previous = this.byFile.get(filePath) ?? [];
    for (const entry of previous) {
      const bucket = this.byId.get(entry.vId);
      if (!bucket) {
        continue;
      }
      const next = bucket.filter((candidate) => {
        return !(candidate.filePath === entry.filePath && candidate.key === entry.key);
      });
      if (next.length === 0) {
        this.byId.delete(entry.vId);
      } else {
        this.byId.set(entry.vId, next);
      }
    }

    try {
      const result = validateFingerprints({
        filePath,
        source
      });
      this.byFile.set(filePath, result.map);
      for (const entry of result.map) {
        const bucket = this.byId.get(entry.vId);
        if (bucket) {
          bucket.push(entry);
        } else {
          this.byId.set(entry.vId, [entry]);
        }
      }
    } catch {
      this.byFile.set(filePath, []);
    }
  }
}

function isFingerprintLanguage(languageId: string): boolean {
  return languageId === "javascriptreact" || languageId === "typescriptreact";
}

