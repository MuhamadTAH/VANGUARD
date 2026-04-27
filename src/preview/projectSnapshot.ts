import * as path from "node:path";
import * as vscode from "vscode";

interface WebContainerFileNode {
  file: {
    contents: string;
  };
}

interface WebContainerDirectoryNode {
  directory: Record<string, WebContainerNode>;
}

type WebContainerNode = WebContainerFileNode | WebContainerDirectoryNode;
type WebContainerTree = Record<string, WebContainerNode>;

export interface ProjectSnapshot {
  readonly rootPath: string;
  readonly tree: WebContainerTree;
  readonly diagnostics: string[];
}

const EXCLUDED_DIRS = new Set([
  ".git",
  ".next",
  "node_modules",
  "dist",
  "build",
  "out",
  ".turbo",
  ".vscode"
]);

const MAX_TOTAL_BYTES = 1 * 1024 * 1024;
const MAX_FILE_BYTES = 300 * 1024;
const HEAVY_MODE_MAX_FILE_BYTES = 64 * 1024;

export async function buildProjectSnapshot(workspaceFolder: vscode.WorkspaceFolder): Promise<ProjectSnapshot> {
  const diagnostics: string[] = [];
  let totalBytes = 0;
  let heavyMode = false;
  const tree: WebContainerTree = {};
  const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

  async function walk(dirUri: vscode.Uri, relativeDir: string): Promise<void> {
    const entries = await vscode.workspace.fs.readDirectory(dirUri);
    for (const [name, type] of entries) {
      if (type === vscode.FileType.SymbolicLink) {
        continue;
      }
      if (type === vscode.FileType.Directory) {
        if (EXCLUDED_DIRS.has(name)) {
          continue;
        }
        const nextRelative = relativeDir ? `${relativeDir}/${name}` : name;
        await walk(vscode.Uri.joinPath(dirUri, name), nextRelative);
        continue;
      }
      if (type !== vscode.FileType.File) {
        continue;
      }
      if (name === "package-lock.json") {
        continue;
      }

      const fileUri = vscode.Uri.joinPath(dirUri, name);
      const relPath = relativeDir ? `${relativeDir}/${name}` : name;
      const bytes = await vscode.workspace.fs.readFile(fileUri);

      if (heavyMode && bytes.byteLength > HEAVY_MODE_MAX_FILE_BYTES) {
        diagnostics.push(`Heavy mode skip (large text): ${relPath}`);
        continue;
      }

      if (bytes.byteLength > MAX_FILE_BYTES) {
        diagnostics.push(`Skipped large file: ${relPath}`);
        continue;
      }

      if (totalBytes + bytes.byteLength > MAX_TOTAL_BYTES) {
        if (!heavyMode) {
          heavyMode = true;
          diagnostics.push(
            `Heavy Project warning: snapshot exceeded ${Math.round(MAX_TOTAL_BYTES / 1024)}KB. Enabling aggressive file skips.`
          );
        }
        diagnostics.push(`Skipped due to snapshot budget: ${relPath}`);
        continue;
      }

      let contents: string;
      try {
        contents = utf8Decoder.decode(bytes);
      } catch {
        diagnostics.push(`Skipped binary file: ${relPath}`);
        continue;
      }

      totalBytes += bytes.byteLength;
      insertIntoTree(tree, relPath, contents);
    }
  }

  await walk(workspaceFolder.uri, "");

  return {
    rootPath: normalizeRoot(workspaceFolder.uri.fsPath),
    tree,
    diagnostics
  };
}

function insertIntoTree(tree: WebContainerTree, relPath: string, contents: string): void {
  const parts = relPath.split("/").filter(Boolean);
  if (parts.length === 0) {
    return;
  }

  let cursor: WebContainerTree = tree;
  for (let i = 0; i < parts.length; i += 1) {
    const name = parts[i];
    const isLast = i === parts.length - 1;

    if (isLast) {
      cursor[name] = { file: { contents } };
      return;
    }

    const existing = cursor[name];
    if (!existing || !("directory" in existing)) {
      const directoryNode: WebContainerDirectoryNode = { directory: {} };
      cursor[name] = directoryNode;
      cursor = directoryNode.directory;
      continue;
    }
    cursor = existing.directory;
  }
}

function normalizeRoot(input: string): string {
  return path.normalize(input).replace(/\\/g, "/");
}
