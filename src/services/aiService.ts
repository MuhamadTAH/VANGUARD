import * as fs from "node:fs";
import * as path from "node:path";
import OpenAI from "openai";
import * as vscode from "vscode";
import type { PackedMutationContext } from "../mutation/contextPacker";

const SECRET_KEY_NAME = "vanguard.openrouter.apiKey";
const DEFAULT_MODEL = "deepseek/deepseek-chat-v3-0324";
const REASONING_MODEL = "deepseek/deepseek-r1-0528";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface AIService {
  callMutation(input: {
    context: PackedMutationContext;
    attempt: number;
    feedback?: string;
  }): Promise<{ updatedCode: string }>;
}

class OpenRouterAIService implements AIService {
  private readonly secrets: vscode.SecretStorage;
  private readonly context: vscode.ExtensionContext;

  public constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.secrets = context.secrets;
  }

  public async callMutation(input: {
    context: PackedMutationContext;
    attempt: number;
    feedback?: string;
  }): Promise<{ updatedCode: string }> {
    const apiKey = await this.resolveApiKey();
    const model = input.context.route === "reasoning-heavy" ? REASONING_MODEL : DEFAULT_MODEL;

    const client = new OpenAI({
      apiKey,
      baseURL: OPENROUTER_BASE_URL,
      defaultHeaders: {
        "HTTP-Referer": "https://vanguard.dev",
        "X-Title": "Vanguard Engine"
      }
    });

    const completion = await client.chat.completions.create({
      model,
      temperature: input.context.route === "reasoning-heavy" ? 0.1 : 0.05,
      max_tokens: input.context.route === "reasoning-heavy" ? 3200 : 2200,
      messages: [
        {
          role: "system",
          content: buildSystemPrompt(input.context, input.attempt, input.feedback)
        },
        {
          role: "user",
          content: buildUserPrompt(input.context)
        }
      ]
    });

    const text = completion.choices?.[0]?.message?.content ?? "";
    const updatedCode = extractCodeOnly(text);
    if (!updatedCode) {
      throw new Error("AI returned empty mutation output.");
    }

    return { updatedCode };
  }

  private async resolveApiKey(): Promise<string> {
    const secret = await this.secrets.get(SECRET_KEY_NAME);
    if (secret && secret.trim().length > 0) {
      return secret.trim();
    }

    const envApiKey = process.env.OPENROUTER_API_KEY || process.env.DEEPSEEK_API_KEY;
    if (envApiKey && envApiKey.trim().length > 0) {
      await this.secrets.store(SECRET_KEY_NAME, envApiKey.trim());
      return envApiKey.trim();
    }

    const fromDotEnv = await readApiKeyFromDotEnvCandidates(this.context.extensionUri.fsPath);
    if (fromDotEnv) {
      await this.secrets.store(SECRET_KEY_NAME, fromDotEnv);
      return fromDotEnv;
    }

    throw new Error(
      "Missing API key. Set OPENROUTER_API_KEY in .env or environment once; Vanguard stores it in VS Code SecretStorage."
    );
  }
}

export function createAIService(context: vscode.ExtensionContext): AIService {
  return new OpenRouterAIService(context);
}

function buildSystemPrompt(context: PackedMutationContext, attempt: number, feedback?: string): string {
  return [
    "You are a surgical mutation engine. You must ONLY return the modified code block.",
    "You MUST preserve all existing v-id/data-v-id attributes.",
    "Do not add markdown unless requested.",
    "Never output backticks or template literals.",
    "If you add a new component, you MUST generate a new unique v-id starting with \"vg_\".",
    `Attempt: ${attempt}`,
    feedback ? `Validator feedback: ${feedback}` : "",
    `Target v-id: ${context.vId}`
  ].filter(Boolean).join("\n");
}

function buildUserPrompt(context: PackedMutationContext): string {
  return [
    `Mutation request: ${context.prompt}`,
    "",
    "Target JSX node to rewrite:",
    context.nodeSource,
    "",
    "Parent context:",
    context.parentSource || "(none)",
    "",
    "Sibling context:",
    context.siblingSources.length > 0 ? context.siblingSources.join("\n---\n") : "(none)"
  ].join("\n");
}

function extractCodeOnly(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) {
    return "";
  }

  if (trimmed.startsWith("```")) {
    const lines = trimmed.split(/\r?\n/);
    const body = lines.slice(1, lines[lines.length - 1]?.startsWith("```") ? -1 : lines.length).join("\n").trim();
    return extractCodeOnly(body);
  }

  if (!trimmed.startsWith("<")) {
    const jsx = extractFirstJsxElement(trimmed);
    if (jsx) {
      return jsx;
    }
  }

  return trimmed;
}

function extractFirstJsxElement(input: string): string | null {
  const pair = /<([A-Za-z][A-Za-z0-9._-]*)(\s[^<>]*?)?>[\s\S]*?<\/\1>/m;
  const selfClosing = /<([A-Za-z][A-Za-z0-9._-]*)(\s[^<>]*?)?\/>/m;
  const pairMatch = input.match(pair);
  const selfMatch = input.match(selfClosing);

  if (pairMatch && selfMatch) {
    const pairIndex = pairMatch.index ?? Number.MAX_SAFE_INTEGER;
    const selfIndex = selfMatch.index ?? Number.MAX_SAFE_INTEGER;
    return pairIndex <= selfIndex ? pairMatch[0].trim() : selfMatch[0].trim();
  }
  if (pairMatch) {
    return pairMatch[0].trim();
  }
  if (selfMatch) {
    return selfMatch[0].trim();
  }
  return null;
}

async function readApiKeyFromDotEnvCandidates(extensionRoot: string): Promise<string | null> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const candidates = new Set<string>();

  for (const folder of folders) {
    candidates.add(path.join(folder.uri.fsPath, ".env"));
  }
  candidates.add(path.join(extensionRoot, ".env"));

  for (const envPath of candidates) {
    try {
      const raw = await fs.promises.readFile(envPath, "utf8");
      const key = parseDotEnvKey(raw, "OPENROUTER_API_KEY") ?? parseDotEnvKey(raw, "DEEPSEEK_API_KEY");
      if (key && key.trim().length > 0) {
        return key.trim();
      }
    } catch {
      // keep scanning other roots
    }
  }
  return null;
}

function parseDotEnvKey(content: string, key: string): string | null {
  for (const line of content.split(/\r?\n/)) {
    const cleaned = line.trim();
    if (!cleaned || cleaned.startsWith("#")) {
      continue;
    }
    const idx = cleaned.indexOf("=");
    if (idx <= 0) {
      continue;
    }
    const parsedKey = cleaned.slice(0, idx).trim();
    if (parsedKey !== key) {
      continue;
    }
    const value = cleaned.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
    return value || null;
  }
  return null;
}
