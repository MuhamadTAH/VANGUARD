import * as path from "node:path";
import * as vscode from "vscode";
import { normalizeFilePath, readBaseline, writeBaseline } from "./baselineStore";
import { validateFingerprints } from "./fingerprintGatekeeper";
import type { BaselineByFile, ValidationResult, VIdMapEntry } from "./types";

export interface ScanResult {
  readonly results: ValidationResult[];
  readonly map: VIdMapEntry[];
}

function diagnosticsFromValidation(validation: ValidationResult): vscode.Diagnostic[] {
  return validation.issues.map((issue) => {
    const range = new vscode.Range(
      new vscode.Position(issue.range.start.line - 1, issue.range.start.column - 1),
      new vscode.Position(issue.range.end.line - 1, issue.range.end.column - 1)
    );
    const diagnostic = new vscode.Diagnostic(range, issue.message, vscode.DiagnosticSeverity.Error);
    diagnostic.source = "vanguard-gatekeeper";
    diagnostic.code = issue.kind;
    return diagnostic;
  });
}

function toWorkspaceRelativeBaseline(
  workspaceFolder: vscode.WorkspaceFolder,
  baselineRaw: BaselineByFile
): BaselineByFile {
  const result: BaselineByFile = {};
  for (const [key, value] of Object.entries(baselineRaw)) {
    const absolute = path.isAbsolute(key)
      ? key
      : path.join(workspaceFolder.uri.fsPath, key);
    result[normalizeFilePath(absolute)] = value;
  }
  return result;
}

export async function validateDocument(
  document: vscode.TextDocument,
  diagnostics: vscode.DiagnosticCollection
): Promise<ValidationResult | null> {
  if (!isFingerprintLanguage(document)) {
    return null;
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!workspaceFolder) {
    return null;
  }

  const baselineRaw = await readBaseline(workspaceFolder);
  const baseline = toWorkspaceRelativeBaseline(workspaceFolder, baselineRaw);
  const filePath = normalizeFilePath(document.uri.fsPath);

  let validation: ValidationResult;
  try {
    validation = validateFingerprints({
      filePath,
      source: document.getText(),
      baselineByFile: baseline
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown parser failure";
    const fallback = new vscode.Diagnostic(
      new vscode.Range(0, 0, 0, 1),
      `Vanguard parser failed: ${msg}`,
      vscode.DiagnosticSeverity.Error
    );
    fallback.source = "vanguard-gatekeeper";
    diagnostics.set(document.uri, [fallback]);
    return null;
  }

  diagnostics.set(document.uri, diagnosticsFromValidation(validation));
  return validation;
}

export async function scanWorkspace(
  diagnostics: vscode.DiagnosticCollection
): Promise<ScanResult> {
  const files = await vscode.workspace.findFiles(
    "**/*.{tsx,jsx}",
    "**/{node_modules,.next,out,dist,build}/**"
  );
  const results: ValidationResult[] = [];
  const map: VIdMapEntry[] = [];

  const baselineByFolder = new Map<string, BaselineByFile>();

  for (const uri of files) {
    const document = await vscode.workspace.openTextDocument(uri);
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
      continue;
    }

    const folderKey = folder.uri.toString();
    let folderBaseline = baselineByFolder.get(folderKey);
    if (!folderBaseline) {
      const raw = await readBaseline(folder);
      folderBaseline = toWorkspaceRelativeBaseline(folder, raw);
      baselineByFolder.set(folderKey, folderBaseline);
    }

    const validation = validateFingerprints({
      filePath: normalizeFilePath(uri.fsPath),
      source: document.getText(),
      baselineByFile: folderBaseline
    });
    diagnostics.set(uri, diagnosticsFromValidation(validation));

    results.push(validation);
    map.push(...validation.map);
  }

  return { results, map };
}

export async function refreshBaselineFromWorkspace(): Promise<{
  filesScanned: number;
  entriesWritten: number;
}> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const files = await vscode.workspace.findFiles(
    "**/*.{tsx,jsx}",
    "**/{node_modules,.next,out,dist,build}/**"
  );

  const entriesByFolder = new Map<string, VIdMapEntry[]>();
  for (const folder of folders) {
    entriesByFolder.set(folder.uri.toString(), []);
  }

  for (const uri of files) {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
      continue;
    }
    const text = await vscode.workspace.openTextDocument(uri);
    const validation = validateFingerprints({
      filePath: normalizeFilePath(uri.fsPath),
      source: text.getText()
    });
    const bucket = entriesByFolder.get(folder.uri.toString());
    if (bucket) {
      bucket.push(...validation.map);
    }
  }

  let entriesWritten = 0;
  for (const folder of folders) {
    const entries = entriesByFolder.get(folder.uri.toString()) ?? [];
    entriesWritten += entries.length;
    await writeBaseline(folder, entries);
  }

  return {
    filesScanned: files.length,
    entriesWritten
  };
}

function isFingerprintLanguage(document: vscode.TextDocument): boolean {
  return document.languageId === "javascriptreact" || document.languageId === "typescriptreact";
}

