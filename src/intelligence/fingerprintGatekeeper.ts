import traverse, { type NodePath } from "@babel/traverse";
import type {
  JSXAttribute,
  JSXElement,
  JSXIdentifier,
  JSXMemberExpression,
  JSXNamespacedName,
  JSXOpeningElement,
  StringLiteral
} from "@babel/types";
import { z } from "zod";
import { parseTsxOrJsx } from "./ast";
import type {
  BaselineByFile,
  FingerprintIssue,
  SourceRange,
  ValidationResult,
  VIdMapEntry
} from "./types";

const vIdFormat = /^vg_[a-z0-9][a-z0-9_:-]*$/i;

const validateInputSchema = z.object({
  filePath: z.string().min(1),
  source: z.string(),
  baselineByFile: z.record(z.record(z.string())).optional()
});

interface ValidateInput {
  readonly filePath: string;
  readonly source: string;
  readonly baselineByFile?: BaselineByFile;
}

interface ElementFrame {
  jsxChildIndex: number;
}

function toRange(loc: NonNullable<JSXAttribute["loc"]>): SourceRange {
  return {
    start: { line: loc.start.line, column: loc.start.column + 1 },
    end: { line: loc.end.line, column: loc.end.column + 1 }
  };
}

function getElementName(
  name: JSXIdentifier | JSXMemberExpression | JSXNamespacedName
): string {
  if (name.type === "JSXIdentifier") {
    return name.name;
  }
  if (name.type === "JSXMemberExpression") {
    return `${getElementName(name.object)}.${getElementName(name.property)}`;
  }
  return `${getElementName(name.namespace)}:${getElementName(name.name)}`;
}

function getVIdAttribute(openingElement: JSXOpeningElement): JSXAttribute | null {
  for (const attr of openingElement.attributes) {
    if (attr.type !== "JSXAttribute") {
      continue;
    }
    if (attr.name.type === "JSXIdentifier" && attr.name.name === "v-id") {
      return attr;
    }
  }
  return null;
}

function createIssue(
  issue: Omit<FingerprintIssue, "filePath">,
  filePath: string
): FingerprintIssue {
  return {
    ...issue,
    filePath
  };
}

export function validateFingerprints(rawInput: ValidateInput): ValidationResult {
  const input = validateInputSchema.parse(rawInput);
  const ast = parseTsxOrJsx(input.source, input.filePath);

  const issues: FingerprintIssue[] = [];
  const map: VIdMapEntry[] = [];
  const duplicateCheck = new Map<string, VIdMapEntry>();
  const elementFrameStack: ElementFrame[] = [{ jsxChildIndex: 0 }];

  traverse(ast, {
    JSXElement: {
      enter(path: NodePath<JSXElement>) {
        const parentFrame = elementFrameStack[elementFrameStack.length - 1];
        const thisIndex = parentFrame.jsxChildIndex++;
        elementFrameStack.push({ jsxChildIndex: 0 });

        const openingElement = path.node.openingElement;
        if (!openingElement.loc) {
          return;
        }

        const elementName = getElementName(openingElement.name);
        const ancestryIndexes = elementFrameStack
          .slice(1, -1)
          .map((frame) => String(frame.jsxChildIndex - 1));
        const pathKey = [...ancestryIndexes, String(thisIndex)].join(".");
        const key = `${elementName}|${pathKey}`;

        const vIdAttr = getVIdAttribute(openingElement);
        if (!vIdAttr || !vIdAttr.loc) {
          issues.push(
            createIssue(
              {
                kind: "missing-v-id",
                key,
                message: `Missing v-id on <${elementName}>.`,
                range: toRange(openingElement.loc)
              },
              input.filePath
            )
          );
          return;
        }

        const attrValue = vIdAttr.value;
        if (!attrValue || attrValue.type !== "StringLiteral") {
          issues.push(
            createIssue(
              {
                kind: "invalid-v-id",
                key,
                message: `v-id on <${elementName}> must be a static string literal.`,
                range: toRange(vIdAttr.loc)
              },
              input.filePath
            )
          );
          return;
        }

        const vId = (attrValue as StringLiteral).value.trim();
        if (!vIdFormat.test(vId)) {
          issues.push(
            createIssue(
              {
                kind: "invalid-v-id",
                key,
                vId,
                message: `Invalid v-id "${vId}". Expected format: vg_* with deterministic suffix.`,
                range: toRange(vIdAttr.loc)
              },
              input.filePath
            )
          );
          return;
        }

        const mapEntry: VIdMapEntry = {
          vId,
          filePath: input.filePath,
          elementName,
          key,
          attributeRange: toRange(vIdAttr.loc)
        };
        map.push(mapEntry);

        const existing = duplicateCheck.get(vId);
        if (existing) {
          issues.push(
            createIssue(
              {
                kind: "duplicate-v-id",
                key,
                vId,
                message: `Duplicate v-id "${vId}". First seen at line ${existing.attributeRange.start.line}, column ${existing.attributeRange.start.column}.`,
                range: mapEntry.attributeRange
              },
              input.filePath
            )
          );
        } else {
          duplicateCheck.set(vId, mapEntry);
        }

        const baselineForFile = input.baselineByFile?.[input.filePath];
        if (baselineForFile && baselineForFile[key] && baselineForFile[key] !== vId) {
          issues.push(
            createIssue(
              {
                kind: "drifted-v-id",
                key,
                vId,
                message: `ID drift detected for <${elementName}> at key "${key}". Baseline is "${baselineForFile[key]}", current is "${vId}".`,
                range: mapEntry.attributeRange
              },
              input.filePath
            )
          );
        }
      },
      exit() {
        elementFrameStack.pop();
      }
    }
  });

  return {
    filePath: input.filePath,
    issues,
    map,
    isValid: issues.length === 0
  };
}
