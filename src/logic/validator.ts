import { parseModule } from "meriyah";

const REQUIRED_LAYOUT_TAGS = new Set(["section", "main", "header", "footer"]);

export type VanguardValidationErrorCode =
  | "VALIDATION_ERROR"
  | "DUPLICATE_ID_ERROR"
  | "MUTATION_ERROR";

export class VanguardValidationError extends Error {
  public readonly code: VanguardValidationErrorCode;

  public constructor(code: VanguardValidationErrorCode, message: string) {
    super(message);
    this.name = "VanguardValidationError";
    this.code = code;
  }
}

type UnknownNode = Record<string, unknown>;

export function buildVanguardIdentityState(sourceCode: string): Map<string, string> {
  const ast = parseJsxSource(sourceCode);
  const state = new Map<string, string>();

  walkAst(ast, (node) => {
    if (!isJsxOpeningElement(node)) {
      return;
    }

    const tagName = getJsxName(node.name);
    if (!tagName) {
      return;
    }

    const vId = getVanguardId(node.attributes);
    if (!vId) {
      return;
    }

    state.set(vId, tagName);
  });

  return state;
}

export function validateVanguardOutput(
  incomingCode: string,
  previousState: Map<string, string>
): Map<string, string> {
  const ast = parseJsxSource(incomingCode);
  const missingIdTargets: string[] = [];
  const seenIds = new Set<string>();
  const duplicateIds = new Set<string>();
  const mutationEvents: string[] = [];
  const incomingState = new Map<string, string>();

  walkAst(ast, (node) => {
    if (!isJsxOpeningElement(node)) {
      return;
    }

    const tagName = getJsxName(node.name);
    if (!tagName) {
      return;
    }

    const vId = getVanguardId(node.attributes);
    const requiresId = isNamedComponent(tagName) || REQUIRED_LAYOUT_TAGS.has(tagName);

    if (requiresId && !vId) {
      missingIdTargets.push(tagName);
      return;
    }

    if (!vId) {
      return;
    }

    if (seenIds.has(vId)) {
      duplicateIds.add(vId);
    }
    seenIds.add(vId);
    incomingState.set(vId, tagName);

    const previousTag = previousState.get(vId);
    if (previousTag && previousTag !== tagName) {
      mutationEvents.push(`v-id "${vId}" changed from <${previousTag}> to <${tagName}>`);
    }
  });

  if (missingIdTargets.length > 0) {
    throw new VanguardValidationError(
      "VALIDATION_ERROR",
      `MISSING_ID: Required elements missing v-id/data-v-id: ${missingIdTargets.join(", ")}`
    );
  }

  if (duplicateIds.size > 0) {
    throw new VanguardValidationError(
      "DUPLICATE_ID_ERROR",
      `DUPLICATE_ID: Duplicate IDs detected: ${Array.from(duplicateIds).join(", ")}`
    );
  }

  if (mutationEvents.length > 0) {
    throw new VanguardValidationError("MUTATION_ERROR", `IDENTITY_MUTATION: ${mutationEvents.join("; ")}`);
  }

  for (const [previousId, previousTag] of previousState.entries()) {
    if (!incomingState.has(previousId)) {
      mutationEvents.push(`v-id "${previousId}" on <${previousTag}> was removed or renamed`);
    }
  }

  if (mutationEvents.length > 0) {
    throw new VanguardValidationError("MUTATION_ERROR", `IDENTITY_MUTATION: ${mutationEvents.join("; ")}`);
  }

  return incomingState;
}

function parseJsxSource(sourceCode: string): UnknownNode {
  try {
    return parseModule(sourceCode, {
      next: true,
      module: true,
      jsx: true,
      loc: true,
      ranges: true
    }) as unknown as UnknownNode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new VanguardValidationError("VALIDATION_ERROR", `Parse failure while validating JSX: ${message}`);
  }
}

function walkAst(node: unknown, visit: (node: UnknownNode) => void): void {
  if (!node || typeof node !== "object") {
    return;
  }

  const typed = node as UnknownNode;
  visit(typed);

  for (const value of Object.values(typed)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        walkAst(item, visit);
      }
      continue;
    }
    walkAst(value, visit);
  }
}

function isJsxOpeningElement(node: UnknownNode): node is UnknownNode & {
  type: "JSXOpeningElement";
  name: unknown;
  attributes: unknown[];
} {
  return node.type === "JSXOpeningElement" && Array.isArray(node.attributes);
}

function getJsxName(nameNode: unknown): string | null {
  if (!nameNode || typeof nameNode !== "object") {
    return null;
  }

  const typed = nameNode as UnknownNode;

  if (typed.type === "JSXIdentifier" && typeof typed.name === "string") {
    return typed.name;
  }

  if (typed.type === "JSXMemberExpression") {
    const objectName = getJsxName(typed.object);
    const propertyName = getJsxName(typed.property);
    if (objectName && propertyName) {
      return `${objectName}.${propertyName}`;
    }
  }

  return null;
}

function getVanguardId(attributes: unknown[]): string | null {
  for (const attribute of attributes) {
    if (!attribute || typeof attribute !== "object") {
      continue;
    }

    const typed = attribute as UnknownNode;
    if (typed.type !== "JSXAttribute" || !typed.name || typeof typed.name !== "object") {
      continue;
    }

    const nameNode = typed.name as UnknownNode;
    if (nameNode.type !== "JSXIdentifier" || (nameNode.name !== "v-id" && nameNode.name !== "data-v-id")) {
      continue;
    }

    const rawValue = readAttributeValue(typed.value);
    if (rawValue) {
      return rawValue;
    }
    return null;
  }

  return null;
}

function readAttributeValue(valueNode: unknown): string | null {
  if (!valueNode || typeof valueNode !== "object") {
    return null;
  }

  const value = valueNode as UnknownNode;

  if (value.type === "Literal" && typeof value.value === "string") {
    const normalized = value.value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  if (value.type === "JSXExpressionContainer" && value.expression && typeof value.expression === "object") {
    const expression = value.expression as UnknownNode;
    if (expression.type === "Literal" && typeof expression.value === "string") {
      const normalized = expression.value.trim();
      return normalized.length > 0 ? normalized : null;
    }
    if (expression.type === "TemplateLiteral" && Array.isArray(expression.quasis) && expression.quasis.length === 1) {
      const first = expression.quasis[0] as UnknownNode;
      if (first.value && typeof first.value === "object") {
        const cooked = (first.value as UnknownNode).cooked;
        if (typeof cooked === "string") {
          const normalized = cooked.trim();
          return normalized.length > 0 ? normalized : null;
        }
      }
    }
  }

  return null;
}

function isNamedComponent(tagName: string): boolean {
  const baseName = tagName.includes(".") ? tagName.split(".")[0] : tagName;
  const first = baseName.charAt(0);
  return first.length > 0 && first === first.toUpperCase() && first !== first.toLowerCase();
}
