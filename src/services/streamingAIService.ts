import * as https from "node:https";
import * as http from "node:http";
import { createParser, type EventSourceMessage } from "eventsource-parser";
import type { PackedMutationContext } from "../mutation/contextPacker";

// ─── Types ────────────────────────────────────────────────────────────────────

export type StreamPhase = "connecting" | "reasoning" | "code" | "validating" | "done";

export interface StreamChunk {
  readonly phase: StreamPhase;
  /** Incremental text for this chunk (reasoning token or code token). */
  readonly delta: string;
  /** Set only on phase=done. Full assembled code string. */
  readonly finalCode?: string;
  /** First-token latency in milliseconds, set on the first non-empty chunk. */
  readonly firstTokenMs?: number;
}

export type StreamCallback = (chunk: StreamChunk) => void;

interface OpenRouterSSEChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning?: string;
    };
    finish_reason?: string | null;
  }>;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const OPENROUTER_HOST = "openrouter.ai";
const OPENROUTER_PATH = "/api/v1/chat/completions";
const REASONING_MODEL = "deepseek/deepseek-r1-0528";
const FAST_MODEL = "deepseek/deepseek-chat-v3-0324";

// ─── Main streaming function ──────────────────────────────────────────────────

/**
 * Calls OpenRouter with streaming enabled.
 * Emits StreamChunk callbacks for each token so the UI can update live.
 * Separates reasoning tokens (inside <vanguard_reasoning> or the `reasoning` delta field)
 * from code tokens.
 *
 * Returns the assembled final code string.
 */
export async function streamMutation(input: {
  context: PackedMutationContext;
  attempt: number;
  feedback?: string;
  apiKey: string;
  abortSignal?: AbortSignal;
  onChunk: StreamCallback;
}): Promise<{ finalCode: string; firstTokenMs: number }> {
  const { context, attempt, feedback, apiKey, abortSignal, onChunk } = input;
  const useReasoning = context.route === "reasoning-heavy";
  const model = useReasoning ? REASONING_MODEL : FAST_MODEL;

  const systemPrompt = buildSystemPrompt(context, attempt, feedback);
  const userPrompt = buildUserPrompt(context);

  const body = JSON.stringify({
    model,
    stream: true,
    temperature: useReasoning ? 0.1 : 0.05,
    max_tokens: useReasoning ? 3200 : 2200,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]
  });

  onChunk({ phase: "connecting", delta: "" });

  const startMs = Date.now();
  let firstTokenMs = -1;
  let firstTokenFired = false;

  // Buffers
  let reasoningBuf = "";
  let codeBuf = "";
  let isInsideReasoningTag = false;

  await consumeSSEStream({
    host: OPENROUTER_HOST,
    path: OPENROUTER_PATH,
    apiKey,
    body,
    abortSignal,
    onEvent: (parsed: EventSourceMessage) => {
      // Check if aborted before processing event
      if (abortSignal?.aborted) {
        return;
      }

      if (!parsed.data || parsed.data === "[DONE]") {
        return;
      }

      let chunk: OpenRouterSSEChunk;
      try {
        chunk = JSON.parse(parsed.data) as OpenRouterSSEChunk;
      } catch {
        return;
      }

      const choice = chunk.choices?.[0];
      if (!choice) {
        return;
      }

      const reasoningDelta = choice.delta?.reasoning ?? "";
      const contentDelta = choice.delta?.content ?? "";

      // Track first token
      const hasNewTokens = reasoningDelta.length > 0 || contentDelta.length > 0;
      if (hasNewTokens && !firstTokenFired) {
        firstTokenMs = Date.now() - startMs;
        firstTokenFired = true;
      }

      // Emit reasoning tokens
      if (reasoningDelta.length > 0) {
        reasoningBuf += reasoningDelta;
        onChunk({
          phase: "reasoning",
          delta: reasoningDelta,
          ...(firstTokenMs >= 0 && !firstTokenFired ? { firstTokenMs } : {})
        });
      }

      // Emit code tokens
      if (contentDelta.length > 0) {
        // Detect inline <vanguard_reasoning>...</vanguard_reasoning> blocks
        // that some models embed in the content stream
        const inlineProcessed = processInlineReasoning(contentDelta, {
          isInsideReasoningTag,
          onReasoning: (text) => {
            reasoningBuf += text;
            onChunk({ phase: "reasoning", delta: text });
          },
          onCode: (text) => {
            codeBuf += text;
            onChunk({ phase: "code", delta: text });
          },
          setInsideTag: (val) => {
            isInsideReasoningTag = val;
          }
        });
        isInsideReasoningTag = inlineProcessed.isInsideReasoningTag;
      }
    }
  });

  // Strip any remaining <vanguard_reasoning> wrapper from codeBuf if present
  const finalCode = extractCodeFromBuffer(codeBuf.trim());

  const resolvedFirstTokenMs = firstTokenMs >= 0 ? firstTokenMs : Date.now() - startMs;

  onChunk({
    phase: "done",
    delta: "",
    finalCode,
    firstTokenMs: resolvedFirstTokenMs
  });

  return { finalCode, firstTokenMs: resolvedFirstTokenMs };
}

// ─── Inline reasoning tag processor ──────────────────────────────────────────

interface InlineReasoningState {
  isInsideReasoningTag: boolean;
  onReasoning: (text: string) => void;
  onCode: (text: string) => void;
  setInsideTag: (val: boolean) => void;
}

function processInlineReasoning(
  delta: string,
  state: InlineReasoningState
): { isInsideReasoningTag: boolean } {
  let { isInsideReasoningTag } = state;
  let remaining = delta;

  while (remaining.length > 0) {
    if (isInsideReasoningTag) {
      const closeIdx = remaining.indexOf("</vanguard_reasoning>");
      if (closeIdx === -1) {
        state.onReasoning(remaining);
        remaining = "";
      } else {
        state.onReasoning(remaining.slice(0, closeIdx));
        isInsideReasoningTag = false;
        state.setInsideTag(false);
        remaining = remaining.slice(closeIdx + "</vanguard_reasoning>".length);
      }
    } else {
      const openIdx = remaining.indexOf("<vanguard_reasoning>");
      if (openIdx === -1) {
        state.onCode(remaining);
        remaining = "";
      } else {
        if (openIdx > 0) {
          state.onCode(remaining.slice(0, openIdx));
        }
        isInsideReasoningTag = true;
        state.setInsideTag(true);
        remaining = remaining.slice(openIdx + "<vanguard_reasoning>".length);
      }
    }
  }

  return { isInsideReasoningTag };
}

// ─── Code extraction ──────────────────────────────────────────────────────────

function extractCodeFromBuffer(raw: string): string {
  if (!raw) {
    return "";
  }

  // Strip ```tsx / ```jsx / ``` fences
  if (raw.startsWith("```")) {
    const lines = raw.split(/\r?\n/);
    const body = lines
      .slice(1, lines[lines.length - 1]?.startsWith("```") ? -1 : lines.length)
      .join("\n")
      .trim();
    return extractCodeFromBuffer(body);
  }

  // Strip trailing <vanguard_reasoning>...</vanguard_reasoning> if model appended it to code
  const reasoningTagPattern = /<vanguard_reasoning>[\s\S]*?<\/vanguard_reasoning>/g;
  return raw.replace(reasoningTagPattern, "").trim();
}

// ─── Low-level SSE consumer ───────────────────────────────────────────────────

interface SSEStreamOptions {
  host: string;
  path: string;
  apiKey: string;
  body: string;
  abortSignal?: AbortSignal;
  onEvent: (parsed: EventSourceMessage) => void;
}

function consumeSSEStream(options: SSEStreamOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const { host, path, apiKey, body, abortSignal, onEvent } = options;

    // Setup abort listener
    if (abortSignal?.aborted) {
      reject(new Error("Mutation cancelled"));
      return;
    }

    const abortListener = () => {
      req.destroy();
      reject(new Error("Mutation cancelled during stream"));
    };

    if (abortSignal) {
      abortSignal.addEventListener("abort", abortListener, { once: true });
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "HTTP-Referer": "https://vanguard.dev",
      "X-Title": "Vanguard Engine",
      "Accept": "text/event-stream",
      "Content-Length": Buffer.byteLength(body).toString()
    };

    const reqOptions: https.RequestOptions = {
      hostname: host,
      port: 443,
      path,
      method: "POST",
      headers
    };

    const parser = createParser({ onEvent });

    const req = https.request(reqOptions, (res: http.IncomingMessage) => {
      if ((res.statusCode ?? 0) >= 400) {
        const code = res.statusCode ?? 0;
        let errBody = "";
        res.on("data", (chunk: Buffer) => {
          errBody += chunk.toString();
        });
        res.on("end", () => {
          reject(new Error(`OpenRouter SSE error ${code}: ${errBody.slice(0, 300)}`));
        });
        return;
      }

      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        parser.feed(chunk);
      });
      res.on("end", () => {
        if (abortSignal) {
          abortSignal.removeEventListener("abort", abortListener);
        }
        resolve();
      });
      res.on("error", (err: Error) => {
        if (abortSignal) {
          abortSignal.removeEventListener("abort", abortListener);
        }
        reject(err);
      });
    });

    req.on("error", (err: Error) => {
      if (abortSignal) {
        abortSignal.removeEventListener("abort", abortListener);
      }
      reject(err);
    });

    req.write(body);
    req.end();
  });
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

function buildSystemPrompt(
  context: PackedMutationContext,
  attempt: number,
  feedback?: string
): string {
  return [
    "You are a surgical mutation engine for Next.js + Tailwind 4.0 codebases.",
    "RULES:",
    "1. Preserve ALL existing v-id and data-v-id attributes exactly — never rename, drop, or mutate them.",
    "2. If you add a new named component or top-level layout element, assign a NEW unique v-id starting with \"vg_\".",
    "3. Output the full updated file with NO truncation.",
    "4. Wrap your thinking in <vanguard_reasoning>...</vanguard_reasoning> BEFORE the final code.",
    "5. After the reasoning block, output ONLY the modified code — no markdown fences, no commentary.",
    `Attempt: ${attempt}`,
    feedback ? `Validator feedback: ${feedback}` : "",
    `Target v-id: ${context.vId}`
  ]
    .filter(Boolean)
    .join("\n");
}

function buildUserPrompt(context: PackedMutationContext): string {
  return [
    `Mutation request: ${context.prompt}`,
    "",
    "Target JSX node to rewrite:",
    context.nodeSource,
    "",
    "Parent context:",
    context.parentSource ?? "(none)",
    "",
    "Sibling context:",
    context.siblingSources.length > 0 ? context.siblingSources.join("\n---\n") : "(none)"
  ].join("\n");
}
