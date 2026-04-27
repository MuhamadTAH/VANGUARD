import * as path from "node:path";
import * as vscode from "vscode";
import type { BaselineByFile, VIdMapEntry } from "./types";

const BASELINE_FILE = ".vanguard/v-id-baseline.json";

export async function readBaseline(workspaceFolder: vscode.WorkspaceFolder): Promise<BaselineByFile> {
  const uri = vscode.Uri.joinPath(workspaceFolder.uri, BASELINE_FILE);
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(bytes).toString("utf8");
    return JSON.parse(text) as BaselineByFile;
  } catch {
    return {};
  }
}

export async function writeBaseline(
  workspaceFolder: vscode.WorkspaceFolder,
  entries: VIdMapEntry[]
): Promise<void> {
  const baseline: BaselineByFile = {};
  for (const entry of entries) {
    const normalized = normalizeFilePath(entry.filePath);
    if (!baseline[normalized]) {
      baseline[normalized] = {};
    }
    baseline[normalized][entry.key] = entry.vId;
  }

  const target = vscode.Uri.joinPath(workspaceFolder.uri, BASELINE_FILE);
  const dir = vscode.Uri.joinPath(workspaceFolder.uri, ".vanguard");
  await vscode.workspace.fs.createDirectory(dir);
  await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(baseline, null, 2), "utf8"));
}

export function normalizeFilePath(filePath: string): string {
  return path.normalize(filePath);
}

