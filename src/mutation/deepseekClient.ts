import OpenAI from "openai";
import { z } from "zod";
import type { PackedMutationContext } from "./contextPacker";
import { logMutation } from "./mutationLogger";

const aiPayloadSchema = z.object({
  updatedJsx: z.string().min(1),
  explanation: z.string().min(1)
});

interface DeepSeekResult {
  readonly updatedJsx: string;
  readonly notes?: string;
  readonly raw: string;
}

const NITRO_MODEL = "deepseek/deepseek-v3:nitro";
const FALLBACK_MODEL = "deepseek/deepseek-v3";
const PROVIDER_ORDER = ["fireworks", "together"];
const MAX_CLIENT_RETRIES = 3;

export async function requestMutation(
  context: PackedMutationContext,
  attempt: number,
  feedback?: string
): Promise<DeepSeekResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is missing.");
  }

  const client = new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: {
      "HTTP-Referer": "https://vanguard.dev",
      "X-Title": "Vanguard Engine"
    }
  });

  const systemPrompt = buildSystemPrompt(context, attempt, feedback);
  const userPrompt = buildUserPrompt(context);

  let refinementHint = "";
  for (let localTry = 1; localTry <= MAX_CLIENT_RETRIES; localTry += 1) {
    const currentSystem = refinementHint
      ? `${systemPrompt}\nRefinement requirement: ${refinementHint}`
      : systemPrompt;

    const model = NITRO_MODEL;
    try {
      const result = await callOpenRouter(client, {
        model,
        context,
        systemPrompt: currentSystem,
        userPrompt
      });

      const parsed = parseStrictJson(result.text);
      if (!containsStableVId(parsed.updatedJsx, context.vId)) {
        refinementHint = `Output MUST include exactly v-id="${context.vId}" and keep it unchanged.`;
        continue;
      }

      return {
        updatedJsx: parsed.updatedJsx,
        notes: parsed.explanation,
        raw: result.text
      };
    } catch (error) {
      const status = extractHttpStatus(error);
      if (status === 429 || status === 503) {
        logMutation(`Primary model overloaded (${status}). Falling back to ${FALLBACK_MODEL}.`);
        const fallback = await callOpenRouter(client, {
          model: FALLBACK_MODEL,
          context,
          systemPrompt: currentSystem,
          userPrompt
        });
        const parsed = parseStrictJson(fallback.text);
        if (!containsStableVId(parsed.updatedJsx, context.vId)) {
          refinementHint = `Fallback output missing stable v-id="${context.vId}". Regenerate valid JSX.`;
          continue;
        }
        return {
          updatedJsx: parsed.updatedJsx,
          notes: parsed.explanation,
          raw: fallback.text
        };
      }

      const message = error instanceof Error ? error.message : String(error);
      refinementHint = `Previous response invalid: ${message}. Return strict JSON only.`;
      if (localTry === MAX_CLIENT_RETRIES) {
        throw new Error(`OpenRouter mutation failed after retries: ${message}`);
      }
    }
  }

  throw new Error("OpenRouter mutation retries exhausted due to invalid refined output.");
}

async function callOpenRouter(
  client: OpenAI,
  input: {
    model: string;
    context: PackedMutationContext;
    systemPrompt: string;
    userPrompt: string;
  }
): Promise<{ text: string }> {
  const temperature = input.context.route === "fast-stream" ? 0.1 : 0.2;
  const maxTokens = input.context.route === "fast-stream" ? 900 : 1500;
  const provider = {
    order: PROVIDER_ORDER,
    allow_fallbacks: true
  };

  if (input.context.route === "reasoning-heavy") {
    const streamRequest = {
      model: input.model,
      temperature,
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: input.userPrompt }
      ],
      provider
    };
    const stream = await (client.chat.completions.create as unknown as (body: unknown) => Promise<AsyncIterable<unknown>>)(
      streamRequest
    );

    let text = "";
    let reasoningTokens: number | undefined;

    for await (const chunk of stream as AsyncIterable<{ choices?: Array<{ delta?: { content?: string } }>; usage?: { completion_tokens_details?: { reasoning_tokens?: number } } }>) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        text += delta;
      }
      const usage = chunk.usage;
      if (usage?.completion_tokens_details?.reasoning_tokens != null) {
        reasoningTokens = usage.completion_tokens_details.reasoning_tokens;
      }
    }

    if (typeof reasoningTokens === "number") {
      logMutation(`reasoning_tokens=${reasoningTokens} model=${input.model}`);
    } else {
      logMutation(`reasoning_tokens=unavailable model=${input.model}`);
    }
    return { text };
  }

  const nonStreamRequest = {
    model: input.model,
    temperature,
    max_tokens: maxTokens,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: input.userPrompt }
    ],
    provider
  };
  const completion = await (client.chat.completions.create as unknown as (body: unknown) => Promise<{ choices?: Array<{ message?: { content?: string } }> }>)(
    nonStreamRequest
  );

  const content = completion.choices?.[0]?.message?.content ?? "";
  return { text: content };
}

function buildSystemPrompt(context: PackedMutationContext, attempt: number, feedback?: string): string {
  const mode = context.route === "fast-stream" ? "FAST-STREAM CSS PATCH" : "REASONING-HEAVY PATCH";
  return [
    `You are Vanguard deterministic JSX patch engine (${mode}).`,
    "Return exactly one JSON object and nothing else.",
    "Required schema:",
    "{\"updatedJsx\":\"string\",\"explanation\":\"string\"}",
    "Rules:",
    "1) Output full updated JSX element for the targeted node only.",
    `2) Keep v-id exactly as "${context.vId}".`,
    "3) Preserve TSX/JSX syntax.",
    "4) No markdown, no code fences, no extra keys.",
    `External attempt index: ${attempt}.`,
    feedback ? `Validator feedback: ${feedback}` : ""
  ].filter(Boolean).join("\n");
}

function buildUserPrompt(context: PackedMutationContext): string {
  return [
    `Mutation prompt: ${context.prompt}`,
    `Target v-id: ${context.vId}`,
    "Target JSX:",
    context.nodeSource,
    "",
    "Sibling context:",
    context.siblingSources.length > 0 ? context.siblingSources.join("\n---\n") : "(none)",
    "",
    "Parent context:",
    context.parentSource || "(none)",
    "",
    "Tailwind metadata:",
    context.tailwindContext || "(not found)"
  ].join("\n");
}

function parseStrictJson(content: string): z.infer<typeof aiPayloadSchema> {
  const trimmed = content.trim();
  const direct = tryParse(trimmed);
  if (direct) {
    return aiPayloadSchema.parse(direct);
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const sliced = trimmed.slice(firstBrace, lastBrace + 1);
    const parsed = tryParse(sliced);
    if (parsed) {
      return aiPayloadSchema.parse(parsed);
    }
  }
  throw new Error("Model returned non-JSON payload.");
}

function tryParse(input: string): unknown | null {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function containsStableVId(updatedJsx: string, vId: string): boolean {
  const escaped = escapeRegExp(vId);
  const regex = new RegExp(`v-id\\s*=\\s*["']${escaped}["']`);
  return regex.test(updatedJsx);
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractHttpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || !error) {
    return undefined;
  }
  const maybeStatus = (error as { status?: unknown }).status;
  if (typeof maybeStatus === "number") {
    return maybeStatus;
  }
  return undefined;
}
