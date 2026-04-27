import * as path from "node:path";
import traverse, { type NodePath } from "@babel/traverse";
import type { File, JSXAttribute, JSXElement, StringLiteral } from "@babel/types";
import * as vscode from "vscode";
import { parseTsxOrJsx } from "../intelligence/ast";
import { normalizeFilePath } from "../intelligence/baselineStore";

export interface PackedMutationContext {
  readonly filePath: string;
  readonly vId: string;
  readonly prompt: string;
  readonly nodeRange: vscode.Range;
  readonly nodeSource: string;
  readonly parentSource: string;
  readonly siblingSources: string[];
  readonly tailwindContext: string;
  readonly route: "fast-stream" | "reasoning-heavy";
}

interface LocatedNode {
  readonly path: NodePath<JSXElement>;
  readonly nodeSource: string;
  readonly range: vscode.Range;
}

export async function packMutationContext(vId: string, prompt: string): Promise<PackedMutationContext> {
  const candidates = await vscode.workspace.findFiles(
    "**/*.{tsx,jsx}",
    "**/{node_modules,.next,out,dist,build}/**"
  );

  for (const uri of candidates) {
    const document = await vscode.workspace.openTextDocument(uri);
    const source = document.getText();
    const ast = safeParse(source, uri.fsPath);
    if (!ast) {
      continue;
    }
    const located = locateVIdNode(ast, source, vId);
    if (!located) {
      continue;
    }

    const parent = located.path.findParent((p) => p.isJSXElement()) as NodePath<JSXElement> | null;
    const parentSource = extractNodeSource(source, parent?.node?.start, parent?.node?.end);
    const siblingSources = collectSiblings(source, located.path, parent);
    const tailwindContext = await loadTailwindContext(uri);
    const route = chooseRoute(prompt);

    return {
      filePath: normalizeFilePath(uri.fsPath),
      vId,
      prompt,
      nodeRange: located.range,
      nodeSource: located.nodeSource,
      parentSource,
      siblingSources,
      tailwindContext,
      route
    };
  }

  throw new Error(`No JSX node found for ${vId}.`);
}

function safeParse(source: string, filePath: string): File | null {
  try {
    return parseTsxOrJsx(source, filePath);
  } catch {
    return null;
  }
}

function locateVIdNode(ast: File, source: string, vId: string): LocatedNode | null {
  let found: LocatedNode | null = null;
  traverse(ast, {
    JSXElement(path) {
      if (found) {
        path.stop();
        return;
      }
      const opening = path.node.openingElement;
      const attr = getVIdAttribute(opening.attributes as JSXAttribute[]);
      if (!attr?.value || attr.value.type !== "StringLiteral") {
        return;
      }
      if ((attr.value as StringLiteral).value !== vId) {
        return;
      }
      if (!path.node.loc || path.node.start == null || path.node.end == null) {
        return;
      }
      found = {
        path,
        nodeSource: source.slice(path.node.start, path.node.end),
        range: new vscode.Range(
          new vscode.Position(path.node.loc.start.line - 1, path.node.loc.start.column),
          new vscode.Position(path.node.loc.end.line - 1, path.node.loc.end.column)
        )
      };
    }
  });
  return found;
}

function getVIdAttribute(attributes: JSXAttribute[]): JSXAttribute | null {
  for (const attribute of attributes) {
    if (attribute.type !== "JSXAttribute" || attribute.name.type !== "JSXIdentifier") {
      continue;
    }
    if (attribute.name.name === "v-id") {
      return attribute;
    }
  }
  return null;
}

function collectSiblings(
  source: string,
  currentPath: NodePath<JSXElement>,
  parent: NodePath<JSXElement> | null
): string[] {
  if (!parent) {
    return [];
  }
  const siblings: string[] = [];
  for (const child of parent.node.children) {
    if (child.type !== "JSXElement") {
      continue;
    }
    if (child === currentPath.node) {
      continue;
    }
    const snippet = extractNodeSource(source, child.start, child.end);
    if (snippet) {
      siblings.push(snippet);
    }
    if (siblings.length >= 4) {
      break;
    }
  }
  return siblings;
}

function extractNodeSource(source: string, start: number | null | undefined, end: number | null | undefined): string {
  if (start == null || end == null || start < 0 || end < start) {
    return "";
  }
  return source.slice(start, end);
}

async function loadTailwindContext(targetFile: vscode.Uri): Promise<string> {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(targetFile);
  if (!workspaceFolder) {
    return "";
  }

  const candidates = await vscode.workspace.findFiles(
    "{tailwind.config.js,tailwind.config.ts,tailwind.config.mjs,tailwind.config.cjs,postcss.config.js,package.json}",
    "**/{node_modules,.next,out,dist,build}/**",
    8
  );

  const chunks: string[] = [];
  for (const file of candidates) {
    const folder = vscode.workspace.getWorkspaceFolder(file);
    if (!folder || folder.uri.toString() !== workspaceFolder.uri.toString()) {
      continue;
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(file);
      const text = Buffer.from(bytes).toString("utf8");
      chunks.push(`FILE: ${path.basename(file.fsPath)}\n${truncate(text, 1800)}`);
    } catch {
      // Ignore read failures.
    }
  }
  return chunks.join("\n\n");
}

function truncate(input: string, max: number): string {
  if (input.length <= max) {
    return input;
  }
  return `${input.slice(0, max)}\n/* truncated */`;
}

function chooseRoute(prompt: string): "fast-stream" | "reasoning-heavy" {
  const low = prompt.toLowerCase();
  const styleWords = [
    "tailwind",
    "class",
    "style",
    "color",
    "rounded",
    "margin",
    "padding",
    "font",
    "bg-",
    "text-",
    "border-",
    "shadow"
  ];
  const logicWords = [
    "state",
    "hook",
    "function",
    "if",
    "fetch",
    "query",
    "mutation",
    "onClick",
    "handler",
    "map(",
    "useeffect",
    "usestate"
  ];
  const hasStyle = styleWords.some((word) => low.includes(word));
  const hasLogic = logicWords.some((word) => low.includes(word));
  return hasStyle && !hasLogic ? "fast-stream" : "reasoning-heavy";
}
