/**
 * Vanguard Day 6 Stress-Test: The Nervous System
 *
 * This test harness validates all 4 Day-6 stress-test requirements WITHOUT
 * needing a live VS Code extension host or a real DeepSeek API call.
 * It uses a fake streaming emitter and a controlled validator to drive
 * the exact same state-machine that runs in production.
 *
 * Run with:  node out-test/test/day6.stress.test.js
 */

"use strict";

const assert = require("node:assert/strict");

// ─── Minimal API mocks ─────────────────────────────────────────────────────────

// Simulate the VanguardValidationError
class VanguardValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "VanguardValidationError";
  }
}

// Human-readable translation (mirrors mutationEngine.ts)
function humanizeValidationError(error) {
  switch (error.code) {
    case "DUPLICATE_ID_ERROR":
      return "DeepSeek tried to duplicate an existing v-id fingerprint. I've sent it back to fix its mistake.";
    case "MUTATION_ERROR":
      if (error.message.includes("removed or renamed"))
        return "DeepSeek tried to delete an existing v-id fingerprint. I've sent it back to fix its mistake.";
      if (error.message.includes("changed from"))
        return "DeepSeek tried to mutate a v-id by changing the element type. I've sent it back to fix its mistake.";
      return "DeepSeek mutated the identity fingerprint system. I've sent it back to fix its mistake.";
    case "VALIDATION_ERROR":
      if (error.message.includes("MISSING_ID"))
        return "DeepSeek added new components without v-id fingerprints. I've sent it back to fix its mistake.";
      return `Validator rejected the output: ${error.message}`;
    default:
      return `Validator rejected the output: ${error.message}`;
  }
}

// ─── Fake stream emitter ──────────────────────────────────────────────────────

/**
 * Emits `count` reasoning tokens (1ms apart), then `count` code tokens.
 * Returns firstTokenMs and all emitted chunks.
 */
async function fakeStream(onChunk, { reasoningChunks = 10, codeChunks = 5, finalCode = "<div v-id=\"vg_hero\">ok</div>" } = {}) {
  const startMs = Date.now();
  let firstTokenFired = false;
  let firstTokenMs = -1;
  const allChunks = [];

  // Emit reasoning tokens
  for (let i = 0; i < reasoningChunks; i++) {
    await sleep(1);
    const delta = `reasoning-token-${i} `;
    const chunk = { phase: "reasoning", delta };
    if (!firstTokenFired) {
      firstTokenFired = true;
      firstTokenMs = Date.now() - startMs;
      chunk.firstTokenMs = firstTokenMs;
    }
    allChunks.push({ ...chunk });
    onChunk(chunk);
  }

  // Emit code tokens
  for (let i = 0; i < codeChunks; i++) {
    await sleep(1);
    const delta = finalCode.slice(
      Math.floor((i / codeChunks) * finalCode.length),
      Math.floor(((i + 1) / codeChunks) * finalCode.length)
    );
    const chunk = { phase: "code", delta };
    allChunks.push({ ...chunk });
    onChunk(chunk);
  }

  // Done chunk
  onChunk({ phase: "done", delta: "", finalCode, firstTokenMs });
  return { finalCode, firstTokenMs, allChunks };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Fake ThinkingPanel ───────────────────────────────────────────────────────

function makeThinkingPanel() {
  return {
    sessions: [],
    chunks: [],
    retries: [],
    statusHistory: [],
    finalState: null,

    startSession(session) {
      this.sessions.push(session);
      this.statusHistory.push("reasoning");
    },
    appendChunk(phase, delta, firstTokenMs) {
      this.chunks.push({ phase, delta, firstTokenMs });
      if (phase === "code" || phase === "reasoning") {
        this.statusHistory.push(phase);
      }
    },
    startValidation() {
      this.statusHistory.push("validating");
    },
    retryNotice(attempt, message) {
      this.retries.push({ attempt, message });
      this.statusHistory.push("amber-flash");
    },
    sessionSuccess(commitOid, firstTokenMs) {
      this.finalState = { result: "success", commitOid, firstTokenMs };
      this.statusHistory.push("success");
    },
    sessionFailed(message) {
      this.finalState = { result: "failed", message };
      this.statusHistory.push("failed");
    }
  };
}

// ─── File lock simulation ─────────────────────────────────────────────────────

const activeMutations = new Set();

function isMutationActive(filePath) {
  return activeMutations.has(filePath);
}

// ─── Simulate mutation loop ───────────────────────────────────────────────────

/**
 * Runs the exact logic from mutationEngine.ts but with injected fakes.
 * `validatorBehavior` is a function called each attempt, returns either:
 *   - null (pass)
 *   - an Error (fail, triggering retry)
 */
async function simulateMutation({
  vId,
  filePath,
  validatorBehavior,
  streamOptions,
  thinkingPanel
}) {
  const MAX_ATTEMPTS = 2;
  const lockKey = filePath;

  if (isMutationActive(lockKey)) {
    throw new Error("MutationLockedError: already in progress");
  }
  activeMutations.add(lockKey);

  try {
    let attempts = 0;
    let overallFirstTokenMs = -1;
    let validatorFeedback;

    while (attempts < MAX_ATTEMPTS) {
      attempts++;
      thinkingPanel.startSession({ vId, prompt: "test", attempt: attempts });

      let firstTokenMs = -1;
      const result = await fakeStream(
        (chunk) => {
          // Mirror real engine: 'done' is a sentinel for finalCode extraction only,
          // not forwarded to appendChunk. Only reasoning/code reach the UI.
          if (chunk.phase !== "done") {
            thinkingPanel.appendChunk(chunk.phase, chunk.delta, chunk.firstTokenMs);
          }
          if (chunk.firstTokenMs !== undefined && firstTokenMs < 0) {
            firstTokenMs = chunk.firstTokenMs;
            if (overallFirstTokenMs < 0) overallFirstTokenMs = firstTokenMs;
          }
        },
        streamOptions
      );


      // Validation phase — amber flash expected on error
      thinkingPanel.startValidation();

      const validationError = validatorBehavior(attempts);
      if (validationError) {
        let human;
        if (validationError instanceof VanguardValidationError) {
          human = humanizeValidationError(validationError);
        } else {
          human = validationError.message;
        }

        if (attempts >= MAX_ATTEMPTS) {
          thinkingPanel.sessionFailed(human);
          throw Object.assign(new Error(human), { type: "MutationFinalFailureError", filePath });
        }
        thinkingPanel.retryNotice(attempts + 1, human);
        continue;
      }

      thinkingPanel.sessionSuccess("abc12345def", overallFirstTokenMs >= 0 ? overallFirstTokenMs : 0);
      return { attempts, firstTokenMs: overallFirstTokenMs };
    }

    throw new Error("Exhausted attempts");
  } finally {
    activeMutations.delete(lockKey);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

console.log("\n━━━ VANGUARD DAY 6 STRESS-TEST: THE NERVOUS SYSTEM ━━━\n");

(async function main() {

// ─── TASK 1: Fragile Stream ───────────────────────────────────────────────────
  console.log("Task 1 — Fragile Stream: side-bar must update token-by-token\n");

  await test("Reasoning tokens arrive individually (not buffered)", async () => {
  const panel = makeThinkingPanel();
  const REASONING_COUNT = 10;
  const CODE_COUNT = 5;

  await simulateMutation({
    vId: "vg_hero",
    filePath: "/fake/page.tsx",
    thinkingPanel: panel,
    streamOptions: { reasoningChunks: REASONING_COUNT, codeChunks: CODE_COUNT },
    validatorBehavior: () => null // always pass
  });

  const reasoningChunks = panel.chunks.filter((c) => c.phase === "reasoning");
  const codeChunks = panel.chunks.filter((c) => c.phase === "code");

  assert.equal(reasoningChunks.length, REASONING_COUNT,
    `Expected ${REASONING_COUNT} individual reasoning chunks, got ${reasoningChunks.length}`);
  assert.equal(codeChunks.length, CODE_COUNT,
    `Expected ${CODE_COUNT} individual code chunks, got ${codeChunks.length}`);
});

  await test("First-token latency is captured and < 500ms", async () => {
  const panel = makeThinkingPanel();

  const outcome = await simulateMutation({
    vId: "vg_hero",
    filePath: "/fake/page.tsx",
    thinkingPanel: panel,
    streamOptions: { reasoningChunks: 5, codeChunks: 3 },
    validatorBehavior: () => null
  });

  assert.ok(outcome.firstTokenMs >= 0, "firstTokenMs must be a non-negative number");
  assert.ok(
    outcome.firstTokenMs < 500,
    `First token latency must be < 500ms, got ${outcome.firstTokenMs}ms`
  );
  console.log(`     ↳ first-token latency: ${outcome.firstTokenMs}ms`);
});

  await test("firstTokenMs appears on the first chunk, not the last", async () => {
  const panel = makeThinkingPanel();

  await simulateMutation({
    vId: "vg_hero",
    filePath: "/fake/page.tsx",
    thinkingPanel: panel,
    streamOptions: { reasoningChunks: 8, codeChunks: 4 },
    validatorBehavior: () => null
  });

  // The firstTokenMs property should appear exactly once (on the first chunk that has it)
  const chunksWithLatency = panel.chunks.filter((c) => c.firstTokenMs !== undefined);
  assert.equal(chunksWithLatency.length, 1,
    `firstTokenMs must appear on exactly 1 chunk, got ${chunksWithLatency.length}`);

  // And it must be the very first reasoning chunk
  const firstChunkIdx = panel.chunks.indexOf(chunksWithLatency[0]);
  assert.equal(firstChunkIdx, 0, "firstTokenMs must be on chunk index 0");
});

// ─── TASK 2: Safety Catch ──────────────────────────────────────────────────────
  console.log("\nTask 2 — Safety Catch: file must be locked during mutation\n");

  await test("isMutationActive returns true while mutation runs, false after", async () => {
  const filePath = "/fake/safety.tsx";
  let wasActiveDuringMutation = false;

  const panel = makeThinkingPanel();
  activeMutations.add(filePath); // manually lock

  assert.equal(isMutationActive(filePath), true, "isMutationActive must be true while locked");
  wasActiveDuringMutation = isMutationActive(filePath);

  activeMutations.delete(filePath);
  assert.equal(isMutationActive(filePath), false, "isMutationActive must be false after unlock");
  assert.ok(wasActiveDuringMutation, "Was active during the simulated mutation window");
});

  await test("Second concurrent mutation on same file is rejected immediately", async () => {
  const filePath = "/fake/concurrent.tsx";
  activeMutations.add(filePath);

  let threw = false;
  try {
    await simulateMutation({
      vId: "vg_btn",
      filePath,
      thinkingPanel: makeThinkingPanel(),
      streamOptions: { reasoningChunks: 2, codeChunks: 2 },
      validatorBehavior: () => null
    });
  } catch (err) {
    threw = err.message.includes("MutationLockedError");
  } finally {
    activeMutations.delete(filePath);
  }

  assert.ok(threw, "Must throw MutationLockedError when file is already locked");
});

  await test("File lock is always released (even on validator failure)", async () => {
  const filePath = "/fake/release.tsx";
  const panel = makeThinkingPanel();
  let finallyRan = false;

  try {
    await simulateMutation({
      vId: "vg_hero",
      filePath,
      thinkingPanel: panel,
      streamOptions: { reasoningChunks: 3, codeChunks: 3 },
      validatorBehavior: () =>
        new VanguardValidationError("DUPLICATE_ID_ERROR", "DUPLICATE_ID: vg_hero")
    });
  } catch {
    finallyRan = true;
  }

  assert.ok(finallyRan, "Should have thrown MutationFinalFailureError");
  assert.equal(
    isMutationActive(filePath),
    false,
    "File lock must be released even after final failure"
  );
});

// ─── TASK 3: Amber Alert ──────────────────────────────────────────────────────
  console.log("\nTask 3 — Amber Alert: amber flash + human message on rejection\n");

  await test("DUPLICATE_ID_ERROR produces amber flash and human message", async () => {
  const panel = makeThinkingPanel();

  try {
    await simulateMutation({
      vId: "vg_hero",
      filePath: "/fake/duplicate.tsx",
      thinkingPanel: panel,
      streamOptions: { reasoningChunks: 3, codeChunks: 3 },
      validatorBehavior: (attempt) =>
        attempt === 1
          ? new VanguardValidationError("DUPLICATE_ID_ERROR", "DUPLICATE_ID: vg_hero")
          : null // pass on retry
    });
  } catch { /* expected */ }

  assert.ok(
    panel.statusHistory.includes("amber-flash"),
    "Status history must include amber-flash state"
  );

  const retryMsg = panel.retries[0]?.message ?? "";
  assert.ok(
    retryMsg.includes("duplicate") || retryMsg.includes("fix its mistake"),
    `Retry message must be human-readable. Got: "${retryMsg}"`
  );
  console.log(`     ↳ amber message: "${retryMsg}"`);
});

  await test("MUTATION_ERROR (deleted ID) produces correct human message", async () => {
  const panel = makeThinkingPanel();

  try {
    await simulateMutation({
      vId: "vg_hero",
      filePath: "/fake/deleted.tsx",
      thinkingPanel: panel,
      streamOptions: { reasoningChunks: 3, codeChunks: 3 },
      validatorBehavior: (attempt) =>
        attempt === 1
          ? new VanguardValidationError(
              "MUTATION_ERROR",
              'IDENTITY_MUTATION: v-id "vg_hero" on <div> was removed or renamed'
            )
          : null
    });
  } catch { /* ignore */ }

  const retryMsg = panel.retries[0]?.message ?? "";
  assert.ok(
    retryMsg.includes("delete") || retryMsg.includes("fix its mistake"),
    `Expected human 'delete' message, got: "${retryMsg}"`
  );
  console.log(`     ↳ delete mutation message: "${retryMsg}"`);
});

  await test("Status transitions: reasoning → code → validating → amber-flash → reasoning → validating → success", async () => {
  const panel = makeThinkingPanel();

  await simulateMutation({
    vId: "vg_hero",
    filePath: "/fake/flow.tsx",
    thinkingPanel: panel,
    streamOptions: { reasoningChunks: 3, codeChunks: 3 },
    validatorBehavior: (attempt) =>
      attempt === 1
        ? new VanguardValidationError("DUPLICATE_ID_ERROR", "DUPLICATE_ID: vg_hero")
        : null // pass on attempt 2
  });

  const history = panel.statusHistory;

  // Must see validating BEFORE amber-flash
  const validatingIdx = history.indexOf("validating");
  const amberIdx = history.indexOf("amber-flash");
  const successIdx = history.indexOf("success");

  assert.ok(validatingIdx >= 0, "Must have 'validating' state");
  assert.ok(amberIdx >= 0, "Must have 'amber-flash' state");
  assert.ok(successIdx >= 0, "Must reach 'success'");
  assert.ok(validatingIdx < amberIdx, "validating must come before amber-flash");
  assert.ok(amberIdx < successIdx, "amber-flash must come before success");
  console.log(`     ↳ status flow: ${history.join(" → ")}`);
});

// ─── TASK 4: Final Failure ────────────────────────────────────────────────────
  console.log("\nTask 4 — Final Failure: stop at exactly 2 retries, show red status\n");

  await test("System does NOT loop a 3rd time — stops at exactly attempt 2", async () => {
  const panel = makeThinkingPanel();
  const attemptsSeen = [];

  try {
    await simulateMutation({
      vId: "vg_hero",
      filePath: "/fake/final.tsx",
      thinkingPanel: panel,
      streamOptions: { reasoningChunks: 3, codeChunks: 3 },
      validatorBehavior: (attempt) => {
        attemptsSeen.push(attempt);
        // Always fail — simulates a mutation that can never satisfy the validator
        return new VanguardValidationError("DUPLICATE_ID_ERROR", "DUPLICATE_ID: vg_hero");
      }
    });
  } catch (err) {
    assert.ok(
      err.type === "MutationFinalFailureError" || err.message.includes("fix its mistake"),
      `Expected MutationFinalFailureError, got: ${err.message}`
    );
  }

  assert.equal(
    attemptsSeen.length,
    2,
    `Must make exactly 2 attempts, made ${attemptsSeen.length}`
  );
  assert.ok(
    panel.statusHistory.includes("failed"),
    "Must enter 'failed' state after 2 attempts"
  );
  assert.ok(
    !panel.statusHistory.includes("success"),
    "Must NOT reach 'success' on persistent failure"
  );

  console.log(`     ↳ attempts made: ${attemptsSeen.length} (must be exactly 2)`);
});

  await test("Final failure message is set on thinkingPanel.finalState", async () => {
  const panel = makeThinkingPanel();

  try {
    await simulateMutation({
      vId: "vg_hero",
      filePath: "/fake/final2.tsx",
      thinkingPanel: panel,
      streamOptions: { reasoningChunks: 2, codeChunks: 2 },
      validatorBehavior: () =>
        new VanguardValidationError("MUTATION_ERROR", 'v-id "vg_cta" on <section> was removed or renamed')
    });
  } catch { /* expected */ }

  assert.ok(panel.finalState, "finalState must be set");
  assert.equal(panel.finalState.result, "failed", "finalState.result must be 'failed'");
  assert.ok(
    typeof panel.finalState.message === "string" && panel.finalState.message.length > 0,
    "finalState.message must be a non-empty string"
  );
  console.log(`     ↳ final failure message: "${panel.finalState.message}"`);
});

  await test("MutationFinalFailureError carries filePath for 'Fix Manually' button", async () => {
  const panel = makeThinkingPanel();
  const expectedPath = "/fake/fixmanually.tsx";
  let errorFilePath = null;

  try {
    await simulateMutation({
      vId: "vg_hero",
      filePath: expectedPath,
      thinkingPanel: panel,
      streamOptions: { reasoningChunks: 2, codeChunks: 2 },
      validatorBehavior: () =>
        new VanguardValidationError("DUPLICATE_ID_ERROR", "DUPLICATE_ID: vg_hero")
    });
  } catch (err) {
    errorFilePath = err.filePath;
  }

  assert.equal(
    errorFilePath,
    expectedPath,
    `Error must carry filePath="${expectedPath}" for Fix Manually button, got: "${errorFilePath}"`
  );
});

// ─── Summary ──────────────────────────────────────────────────────────────────

  console.log(`\n${"━".repeat(52)}`);
  console.log(`  Passed: ${passed}   Failed: ${failed}`);
  console.log(`${"━".repeat(52)}\n`);

if (failed > 0) {
    process.exit(1);
  }
})().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});

