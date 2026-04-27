import * as vscode from "vscode";
import { validateFingerprints } from "../intelligence/fingerprintGatekeeper";
import { buildVanguardIdentityState, validateVanguardOutput, VanguardValidationError } from "../logic/validator";
import type { AIService } from "../services/aiService";
import { streamMutation } from "../services/streamingAIService";
import { packMutationContext } from "./contextPacker";
import { commitMutationToHistory } from "./history";
import { ThinkingPanel } from "../preview/thinkingPanel";
import { vfs } from "../logic/vfs";
import { telemetryService } from "../services/telemetry";

export interface MutationOutcome {
  readonly filePath: string;
  readonly vId: string;
  readonly attempts: number;
  readonly commitOid: string | null;
  readonly firstTokenMs: number;
}

// ── File lock: prevents overlapping mutations on the same file ─────────────────
//
// This Set tracks files that are actively being mutated. It serves two purposes:
//   1. Prevents a second `runMutation` call on the same file from proceeding.
//   2. Is checked by the `onWillSaveTextDocument` interceptor registered in
//      extension.ts to block manual user saves during AI mutation.
const activeMutations = new Set<string>();

/**
 * Returns whether the given file path is currently locked for mutation.
 * Used by the extension's onWillSaveTextDocument interceptor.
 */
export function isMutationActive(filePath: string): boolean {
  return activeMutations.has(filePath);
}

/**
 * Global abort controller for cancelling in-flight mutations
 * Maps file path → AbortController so rollback can signal cancellation
 */
const mutationAbortControllers = new Map<string, AbortController>();

export function getMutationAbortController(filePath: string): AbortController | undefined {
  return mutationAbortControllers.get(filePath);
}

/**
 * Signal rollback cancellation for a specific file's mutation
 * Aborts the in-flight stream and cleanup
 */
export function signalMutationRollback(filePath: string): void {
  const controller = mutationAbortControllers.get(filePath);
  if (controller) {
    controller.abort();
    mutationAbortControllers.delete(filePath);
  }
}

export async function runMutation(
  vId: string,
  prompt: string,
  aiService: AIService,
  context: vscode.ExtensionContext
): Promise<MutationOutcome> {
  // ── Pack context ─────────────────────────────────────────────────────────────
  const mutationContext = await packMutationContext(vId, prompt);

  // ── Exclusive file lock ───────────────────────────────────────────────────────
  const lockKey = mutationContext.filePath;
  if (activeMutations.has(lockKey)) {
    throw new MutationLockedError(
      `Vanguard: mutation in progress for ${mutationContext.filePath}. Wait for it to complete.`
    );
  }
  activeMutations.add(lockKey);

  const thinkingPanel = ThinkingPanel.getOrCreate(context);
  
  // Create abort controller for this mutation
  const abortController = new AbortController();
  mutationAbortControllers.set(lockKey, abortController);

  try {
    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Vanguard: mutating \`${vId}\``,
        cancellable: false
      },
      async (progress) => {
        return executeWithProgress(vId, prompt, mutationContext, aiService, context, thinkingPanel, progress, abortController);
      }
    );
  } finally {
    activeMutations.delete(lockKey);
    mutationAbortControllers.delete(lockKey);
  }
}

// ── Custom error types ────────────────────────────────────────────────────────

export class MutationLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MutationLockedError";
  }
}

export class MutationFinalFailureError extends Error {
  public readonly filePath: string;
  public readonly rawMessage: string;

  constructor(filePath: string, rawMessage: string) {
    super(rawMessage);
    this.name = "MutationFinalFailureError";
    this.filePath = filePath;
    this.rawMessage = rawMessage;
  }
}

// ── Core mutation loop ────────────────────────────────────────────────────────

async function executeWithProgress(
  vId: string,
  prompt: string,
  mutationContext: Awaited<ReturnType<typeof packMutationContext>>,
  aiService: AIService,
  context: vscode.ExtensionContext,
  thinkingPanel: ThinkingPanel,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  abortController: AbortController
): Promise<MutationOutcome> {
  // State 1: Load baseline
  progress.report({ message: "Loading baseline…", increment: 0 });

  // ── Task 4 "Dirty Change" Guard ───────────────────────────────────────────────
  const doc = await vscode.workspace.openTextDocument(mutationContext.filePath);
  if (doc.isDirty) {
    throw new MutationLockedError("Save your manual changes before letting Vanguard mutate this file.");
  }

  const original = doc.getText();

  // Validate baseline integrity before touching anything
  const baselineValidation = validateFingerprints({
    filePath: mutationContext.filePath,
    source: original
  });
  const baselineIssues = baselineValidation.issues
    .filter((i) => i.kind === "missing-v-id" || i.kind === "invalid-v-id")
    .slice(0, 5);
  if (baselineIssues.length > 0) {
    const details = baselineIssues
      .map((i) => `${i.kind} at line ${i.range.start.line}`)
      .join("; ");
    throw new Error(`Target file violates Vanguard identity rules. Fix before mutating: ${details}`);
  }

  const previousIdentityState = buildVanguardIdentityState(original);
  const apiKey = await resolveApiKey(context);

  let validatorFeedback: string | undefined;
  let attempts = 0;
  let overallFirstTokenMs = -1;
  const MAX_ATTEMPTS = 2; // Per spec: exactly 2 self-correction attempts. Not 3, not 5.

  while (attempts < MAX_ATTEMPTS) {
    attempts += 1;

    // Check for rollback signal (abort)
    if (abortController.signal.aborted) {
      const msg = "Mutation cancelled by user rollback";
      thinkingPanel.sessionFailed(msg);
      throw new Error(msg);
    }

    // State 2: Streaming AI
    progress.report({
      message: `Streaming AI (attempt ${attempts}/${MAX_ATTEMPTS})…`,
      increment: attempts === 1 ? 20 : 0
    });

    thinkingPanel.startSession({ vId, prompt, attempt: attempts });

    let finalCode = "";
    let firstTokenMs = -1;

    // ── Stream from OpenRouter ──────────────────────────────────────────────
    try {
      const result = await streamMutation({
        context: mutationContext,
        attempt: attempts,
        feedback: validatorFeedback,
        apiKey,
        abortSignal: abortController.signal,
        onChunk: (chunk) => {
          // Check for abort before processing chunk
          if (abortController.signal.aborted) {
            return;
          }
          
          // Every token goes straight to the sidebar — no buffering
          thinkingPanel.appendChunk(chunk.phase, chunk.delta, chunk.firstTokenMs);

          // Capture first-token latency exactly once across all attempts
          if (chunk.firstTokenMs !== undefined && firstTokenMs < 0) {
            firstTokenMs = chunk.firstTokenMs;
            if (overallFirstTokenMs < 0) {
              overallFirstTokenMs = firstTokenMs;
            }
            const ch = getOutputChannel();
            if (ch) {
              ch.appendLine(
                `[latency] first-token=${firstTokenMs}ms vId=${vId} attempt=${attempts}`
              );
            }
          }
        }
      });

      // Check again after stream completes
      if (abortController.signal.aborted) {
        const msg = "Mutation cancelled during stream";
        thinkingPanel.sessionFailed(msg);
        throw new Error(msg);
      }

      finalCode = result.finalCode;
      if (firstTokenMs < 0 && result.firstTokenMs >= 0) {
        firstTokenMs = result.firstTokenMs;
        if (overallFirstTokenMs < 0) overallFirstTokenMs = firstTokenMs;
      }
    } catch (streamError) {
      // If cancelled, propagate immediately without retry
      if (abortController.signal.aborted) {
        throw streamError;
      }

      const msg = streamError instanceof Error ? streamError.message : String(streamError);
      validatorFeedback = `Stream error: ${msg}`;
      if (attempts >= MAX_ATTEMPTS) {
        thinkingPanel.sessionFailed(`Streaming failed after ${attempts} attempt(s): ${msg}`);
        throw new MutationFinalFailureError(
          mutationContext.filePath,
          `Streaming failed after ${attempts} attempt(s): ${msg}`
        );
      }
      thinkingPanel.retryNotice(attempts + 1, humanizeValidatorMessage(validatorFeedback));
      continue;
    }

    if (!finalCode) {
      validatorFeedback = "empty-output";
      const human = "DeepSeek returned an empty response. Sending it back to try again.";
      if (attempts >= MAX_ATTEMPTS) {
        thinkingPanel.sessionFailed("AI returned empty output after 2 attempts.");
        throw new MutationFinalFailureError(mutationContext.filePath, "AI returned empty output.");
      }
      thinkingPanel.retryNotice(attempts + 1, human);
      continue;
    }

    // Check target v-id is present
    if (!containsTargetIdentity(finalCode, vId)) {
      validatorFeedback = `Output missing required v-id="${vId}".`;
      const human = `DeepSeek dropped the required fingerprint \`${vId}\`. I've sent it back to restore it.`;
      if (attempts >= MAX_ATTEMPTS) {
        thinkingPanel.sessionFailed(validatorFeedback);
        throw new MutationFinalFailureError(mutationContext.filePath, validatorFeedback);
      }
      thinkingPanel.retryNotice(attempts + 1, human);
      continue;
    }

    // ── Task 2 Safety Catch: verify no manual edits snuck in during streaming ──
    const currentText = doc.getText();
    if (currentText !== original) {
      const msg =
        "The file was modified manually while the AI was streaming. " +
        "Mutation aborted to protect fingerprint integrity. Please retry.";
      thinkingPanel.sessionFailed(msg);
      throw new Error(msg);
    }

    // State 3: Validate fingerprints — this is where the amber flash fires
    progress.report({ message: "Validating fingerprints…", increment: 60 });
    thinkingPanel.startValidation();

    const patched = applyRangeReplace(original, mutationContext.nodeRange, finalCode);

    let validationPassed = false;

    try {
      const validation = validateFingerprints({
        filePath: mutationContext.filePath,
        source: patched
      });

      if (!validation.map.some((entry) => entry.vId === vId)) {
        validatorFeedback = `Patch removed required v-id ${vId}.`;
        const human = `DeepSeek deleted the \`${vId}\` fingerprint. I've sent it back to fix its mistake.`;
        if (attempts >= MAX_ATTEMPTS) {
          thinkingPanel.sessionFailed(validatorFeedback);
          throw new MutationFinalFailureError(mutationContext.filePath, validatorFeedback);
        }
        thinkingPanel.retryNotice(attempts + 1, human);
        continue;
      }

      const badIssues = validation.issues.filter(
        (i) => i.kind === "missing-v-id" || i.kind === "invalid-v-id"
      );
      if (badIssues.length > 0) {
        const details = badIssues
          .slice(0, 5)
          .map((i) => `line ${i.range.start.line}`)
          .join(", ");
        validatorFeedback = `Patch produced missing/invalid fingerprints at ${details}.`;
        const human = `DeepSeek introduced elements without required v-id fingerprints (${details}). I've sent it back to fix its mistake.`;
        if (attempts >= MAX_ATTEMPTS) {
          thinkingPanel.sessionFailed(validatorFeedback);
          throw new MutationFinalFailureError(mutationContext.filePath, validatorFeedback);
        }
        thinkingPanel.retryNotice(attempts + 1, human);
        continue;
      }

      // Run identity mutation check (duplicate / deleted / renamed IDs)
      validateVanguardOutput(patched, previousIdentityState);

      validationPassed = true;
    } catch (error) {
      if (error instanceof MutationFinalFailureError) {
        throw error; // already handled above
      }

      // Translate VanguardValidationError codes → human messages
      let human: string;
      let raw: string;

      if (error instanceof VanguardValidationError) {
        raw = error.message;
        human = humanizeValidationError(error);
      } else {
        raw = error instanceof Error ? error.message : String(error);
        human = `Validator rejected the output: ${raw}`;
      }

      validatorFeedback = `Validator failed: ${raw}`;

      if (attempts >= MAX_ATTEMPTS) {
        thinkingPanel.sessionFailed(human);
        throw new MutationFinalFailureError(mutationContext.filePath, raw);
      }
      thinkingPanel.retryNotice(attempts + 1, human);
      continue;
    }

    if (!validationPassed) {
      continue;
    }

    // State 4: Buffer in VFS, then if green, Flush to Physical Disk
    progress.report({ message: "Applying edit to VFS…", increment: 80 });

    vfs.bufferUpdate(mutationContext.filePath, patched);

    // Flush to Disk!
    try {
      await vfs.flushToDisk();
    } catch (vfsError) {
      throw new Error(`Failed to flush VFS changes: ${vfsError instanceof Error ? vfsError.message : String(vfsError)}`);
    }

    const commitOid = await commitMutationToHistory({
      filePath: mutationContext.filePath,
      vId,
      prompt
    });

    telemetryService.markMutation(mutationContext.filePath, prompt, patched);

    progress.report({ message: "Done.", increment: 100 });

    const resolvedFirstTokenMs = overallFirstTokenMs >= 0 ? overallFirstTokenMs : 0;
    thinkingPanel.sessionSuccess(commitOid, resolvedFirstTokenMs);

    return {
      filePath: mutationContext.filePath,
      vId,
      attempts,
      commitOid,
      firstTokenMs: resolvedFirstTokenMs
    };
  }

  // Should not be reachable — TypeScript requires a return after the loop
  throw new MutationFinalFailureError(
    mutationContext.filePath,
    `Mutation exhausted ${MAX_ATTEMPTS} attempts.`
  );
}

// ── Human-readable error translation ─────────────────────────────────────────

/**
 * Converts internal VanguardValidationError codes into the language a developer
 * would actually want to read in the Thinking Log.
 */
function humanizeValidationError(error: VanguardValidationError): string {
  switch (error.code) {
    case "DUPLICATE_ID_ERROR":
      return "DeepSeek tried to duplicate an existing v-id fingerprint. I've sent it back to fix its mistake.";

    case "MUTATION_ERROR":
      if (error.message.includes("removed or renamed")) {
        return "DeepSeek tried to delete an existing v-id fingerprint. I've sent it back to fix its mistake.";
      }
      if (error.message.includes("changed from")) {
        return "DeepSeek tried to mutate a v-id by changing the element type it's attached to. I've sent it back to fix its mistake.";
      }
      return "DeepSeek mutated the identity fingerprint system. I've sent it back to fix its mistake.";

    case "VALIDATION_ERROR":
      if (error.message.includes("MISSING_ID")) {
        return "DeepSeek added new named components or layout elements without assigning v-id fingerprints. I've sent it back to fix its mistake.";
      }
      return `Validator rejected the output: ${error.message}`;

    default:
      return `Validator rejected the output: ${error.message}`;
  }
}

function humanizeValidatorMessage(rawFeedback: string): string {
  if (rawFeedback.includes("DUPLICATE_ID")) {
    return "DeepSeek tried to duplicate an existing v-id fingerprint. I've sent it back to fix its mistake.";
  }
  if (rawFeedback.includes("IDENTITY_MUTATION") || rawFeedback.includes("removed or renamed")) {
    return "DeepSeek tried to delete an existing v-id fingerprint. I've sent it back to fix its mistake.";
  }
  return rawFeedback;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function containsTargetIdentity(candidate: string, vId: string): boolean {
  const escaped = vId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const vIdPattern = new RegExp(`\\bv-id\\s*=\\s*["']${escaped}["']`);
  const dataVIdPattern = new RegExp(`\\bdata-v-id\\s*=\\s*["']${escaped}["']`);
  return vIdPattern.test(candidate) || dataVIdPattern.test(candidate);
}

function applyRangeReplace(source: string, range: vscode.Range, replacement: string): string {
  const start = offsetFromPosition(source, range.start);
  const end = offsetFromPosition(source, range.end);
  return `${source.slice(0, start)}${replacement}${source.slice(end)}`;
}

function offsetFromPosition(source: string, position: vscode.Position): number {
  let offset = 0;
  let line = 0;
  while (line < position.line && offset < source.length) {
    const nextBreak = source.indexOf("\n", offset);
    if (nextBreak < 0) return source.length;
    offset = nextBreak + 1;
    line += 1;
  }
  return Math.min(source.length, offset + position.character);
}

// ── Output channel ────────────────────────────────────────────────────────────

let _outputChannel: vscode.OutputChannel | undefined;

export function setMutationOutputChannelForEngine(channel: vscode.OutputChannel): void {
  _outputChannel = channel;
}

function getOutputChannel(): vscode.OutputChannel | undefined {
  return _outputChannel;
}

// ── API key resolution ────────────────────────────────────────────────────────

const SECRET_KEY_NAME = "vanguard.openrouter.apiKey";

async function resolveApiKey(context: vscode.ExtensionContext): Promise<string> {
  const stored = await context.secrets.get(SECRET_KEY_NAME);
  if (stored && stored.trim().length > 0) {
    return stored.trim();
  }

  const env = process.env.OPENROUTER_API_KEY ?? process.env.DEEPSEEK_API_KEY;
  if (env && env.trim().length > 0) {
    await context.secrets.store(SECRET_KEY_NAME, env.trim());
    return env.trim();
  }

  throw new Error(
    "Missing API key. Set OPENROUTER_API_KEY in .env or environment variables."
  );
}
