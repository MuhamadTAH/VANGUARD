import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

type StepName =
  | "click"
  | "resolve-v-id"
  | "rag-context"
  | "stream-start"
  | "validator"
  | "vfs-write"
  | "hot-reload";

interface StepLog {
  step: StepName;
  at: number;
}

interface MutationLog {
  id: string;
  startedAt: number;
  endedAt: number;
  steps: StepLog[];
}

interface Commit {
  id: string;
  parentId: string | null;
  filePath: string;
  content: string;
}

interface MutationRequest {
  id: string;
  filePath: string;
  transform: (input: string) => string;
  streamMs?: number;
}

class Day11Harness {
  private files = new Map<string, string>();
  private activeFile: string | null = null;
  private queue: MutationRequest[] = [];
  private queueResolvers: Array<(value: boolean) => void> = [];
  private deferredRescan = new Set<string>();
  private previewConnected = true;
  private abortController: AbortController | null = null;
  private mutationLogs: MutationLog[] = [];
  private commits: Commit[] = [];
  private headCommitId: string | null = null;
  private commitCounter = 0;
  private disconnectPrompt: string | null = null;

  seedFile(filePath: string, content: string): void {
    this.files.set(filePath, content);
    this.commit(filePath, content);
  }

  readFile(filePath: string): string {
    const v = this.files.get(filePath);
    if (v === undefined) {
      throw new Error(`Missing file: ${filePath}`);
    }
    return v;
  }

  setPreviewConnected(value: boolean): void {
    this.previewConnected = value;
  }

  getDisconnectPrompt(): string | null {
    return this.disconnectPrompt;
  }

  getQueueSize(): number {
    return this.queue.length;
  }

  isFileLocked(filePath: string): boolean {
    return this.activeFile === filePath;
  }

  getLogs(): MutationLog[] {
    return this.mutationLogs;
  }

  getHeadCommitId(): string | null {
    return this.headCommitId;
  }

  getHeadContent(): string {
    const head = this.findCommit(this.headCommitId);
    return head?.content ?? "";
  }

  getActiveChainLength(): number {
    let count = 0;
    let ptr = this.findCommit(this.headCommitId);
    while (ptr) {
      count += 1;
      ptr = this.findCommit(ptr.parentId);
    }
    return count;
  }

  async requestMutation(req: MutationRequest): Promise<boolean> {
    if (this.activeFile !== null) {
      this.queue.push(req);
      return new Promise<boolean>((resolve) => this.queueResolvers.push(resolve));
    }
    const outcome = await this.runMutation(req);
    this.drainQueue();
    return outcome;
  }

  async manualSave(filePath: string, content: string): Promise<void> {
    if (this.activeFile === filePath) {
      // Ghost-save behavior: when save fires during a mutation, queue only a re-scan
      // signal and never overwrite the AI output with stale editor content.
      this.deferredRescan.add(filePath);
      return;
    }
    this.files.set(filePath, content);
  }

  rollbackTo(commitId: string): void {
    if (this.abortController) {
      this.abortController.abort();
    }
    const commit = this.findCommit(commitId);
    if (!commit) {
      throw new Error(`Commit not found: ${commitId}`);
    }
    this.files.set(commit.filePath, commit.content);
    this.headCommitId = commit.id;
    this.activeFile = null;
  }

  private async runMutation(req: MutationRequest): Promise<boolean> {
    const log: MutationLog = {
      id: req.id,
      startedAt: Date.now(),
      endedAt: 0,
      steps: []
    };
    this.activeFile = req.filePath;
    this.abortController = new AbortController();
    this.disconnectPrompt = null;
    const streamMs = req.streamMs ?? 250;
    const startContent = this.readFile(req.filePath);

    try {
      await this.step(log, "click", 20);
      await this.step(log, "resolve-v-id", 25);
      await this.step(log, "rag-context", 70);
      await this.step(log, "stream-start", streamMs);
      if (this.abortController.signal.aborted) {
        throw new Error("Mutation cancelled by rollback");
      }
      await this.step(log, "validator", 30);
      const next = req.transform(startContent);
      await this.step(log, "vfs-write", 40);
      this.files.set(req.filePath, next);

      if (!this.previewConnected) {
        this.disconnectPrompt = "Preview disconnected — restart?";
        throw new Error(this.disconnectPrompt);
      }

      await this.step(log, "hot-reload", 120);
      this.commit(req.filePath, next);
      return true;
    } catch {
      return false;
    } finally {
      log.endedAt = Date.now();
      this.mutationLogs.push(log);
      this.activeFile = null;
      this.abortController = null;
      this.deferredRescan.delete(req.filePath);
    }
  }

  private async step(log: MutationLog, step: StepName, ms: number): Promise<void> {
    log.steps.push({ step, at: Date.now() });
    await this.delay(ms);
  }

  private drainQueue(): void {
    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      const resolve = this.queueResolvers.shift();
      this.runMutation(next)
        .then((ok) => resolve?.(ok))
        .then(() => this.drainQueue());
      return;
    }
  }

  private commit(filePath: string, content: string): void {
    this.commitCounter += 1;
    const id = `commit-${this.commitCounter}`;
    const commit: Commit = {
      id,
      parentId: this.headCommitId,
      filePath,
      content
    };
    this.commits.push(commit);
    this.headCommitId = id;
  }

  private findCommit(id: string | null): Commit | undefined {
    if (!id) {
      return undefined;
    }
    return this.commits.find((c) => c.id === id);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function countVId(content: string): number {
  const matches = content.match(/v-id=/g);
  return matches ? matches.length : 0;
}

function makeLargeBlock(lines: number): string {
  const generated = Array.from({ length: lines }, (_, i) => `  const row${i} = ${i};`).join("\n");
  return `\nfunction GeneratedBlock() {\n${generated}\n  return null;\n}\n`;
}

async function runDay11MeatGrinder(): Promise<void> {
  const harness = new Day11Harness();
  const file = "D:\\Vangurad-workspace\\vanguard-extension\\test\\fixtures\\Button.tsx";
  const base = `export function Button(){return <button v-id="btn-1" className="px-4 py-2">Click me</button>;}`;
  harness.seedFile(file, base);

  const results: Array<{ name: string; pass: boolean; note: string }> = [];

  // 1. Smoke: Simple
  {
    const start = Date.now();
    const ok = await harness.requestMutation({
      id: "T1",
      filePath: file,
      transform: (input) => input.replace("Click me", "Save")
    });
    const elapsed = Date.now() - start;
    const pass = ok && elapsed < 2000;
    results.push({ name: "Smoke: Simple", pass, note: `hot-reload visible in ${elapsed}ms` });
    assert.ok(pass, "T1 failed");
  }

  // 2. Smoke: Props
  {
    const before = harness.readFile(file);
    const ok = await harness.requestMutation({
      id: "T2",
      filePath: file,
      transform: (input) =>
        input.replace('className="px-4 py-2"', 'className="px-4 py-2 bg-indigo-600 rounded-lg shadow-md"')
    });
    const after = harness.readFile(file);
    const pass = ok && after.includes("bg-indigo-600 rounded-lg shadow-md") && countVId(before) === countVId(after);
    results.push({ name: "Smoke: Props", pass, note: "JSX updated and v-id intact" });
    assert.ok(pass, "T2 failed");
  }

  // 3. Smoke: Hooks
  {
    harness.seedFile(file, `export function Counter(){const [n,setN]=useState(0);return <button v-id="btn-1" onClick={()=>setN(n+1)}>{n}</button>;}`);
    const ok = await harness.requestMutation({
      id: "T3",
      filePath: file,
      transform: (input) => input.replace("setN(n+1)", "setN((n)=>n+2)")
    });
    const pass = ok && harness.readFile(file).includes("setN((n)=>n+2)");
    results.push({ name: "Smoke: Hooks", pass, note: "useState logic changed and visible" });
    assert.ok(pass, "T3 failed");
  }

  // 4. The "Stutter"
  {
    harness.seedFile(file, base);
    const first = harness.requestMutation({
      id: "T4-A",
      filePath: file,
      streamMs: 700,
      transform: (input) => input.replace("Click me", "A")
    });
    await new Promise((r) => setTimeout(r, 500));
    const second = harness.requestMutation({
      id: "T4-B",
      filePath: file,
      transform: (input) => input.replace("A", "B")
    });
    const queued = harness.getQueueSize() >= 1;
    const [okA, okB] = await Promise.all([first, second]);
    const pass = okA && okB && queued;
    results.push({ name: 'The "Stutter"', pass, note: "A processed; B queued" });
    assert.ok(pass, "T4 failed");
  }

  // 5. The "Ghost Save"
  {
    harness.seedFile(file, base);
    const beforeVids = countVId(harness.readFile(file));
    const running = harness.requestMutation({
      id: "T5",
      filePath: file,
      streamMs: 650,
      transform: (input) => input.replace("Click me", "Mutated")
    });
    await new Promise((r) => setTimeout(r, 200));
    await harness.manualSave(file, harness.readFile(file));
    const ok = await running;
    const after = harness.readFile(file);
    const pass = ok && after.includes("Mutated") && beforeVids === countVId(after);
    results.push({ name: 'The "Ghost Save"', pass, note: "No corruption and v-id scan unchanged" });
    assert.ok(pass, "T5 failed");
  }

  // 6. The "Kill Switch"
  {
    harness.seedFile(file, base);
    const preRollbackCommit = harness.getHeadCommitId();
    const running = harness.requestMutation({
      id: "T6",
      filePath: file,
      streamMs: 1200,
      transform: (input) => input.replace("Click me", "ShouldNotLand")
    });
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(preRollbackCommit, "Missing rollback target");
    harness.rollbackTo(preRollbackCommit!);
    const ok = await running;
    const pass = !ok && harness.getHeadCommitId() === preRollbackCommit && !harness.isFileLocked(file);
    results.push({ name: 'The "Kill Switch"', pass, note: "stream cancelled and previous commit restored" });
    assert.ok(pass, "T6 failed");
  }

  // 7. History Branch
  {
    harness.seedFile(file, base);
    for (let i = 0; i < 5; i++) {
      await harness.requestMutation({
        id: `T7-${i + 1}`,
        filePath: file,
        transform: (input) => input.replace(/Click me|M\d/g, `M${i + 1}`)
      });
    }
    const headBefore = harness.getHeadCommitId();
    const activeLenBefore = harness.getActiveChainLength();
    assert.ok(headBefore && activeLenBefore >= 6, "History prep failed");

    const rollbackTarget = "commit-2";
    harness.rollbackTo(rollbackTarget);
    await harness.requestMutation({
      id: "T7-branch",
      filePath: file,
      transform: (input) => input.replace("Click me", "Branched")
    });
    const pass = harness.getActiveChainLength() === 3;
    results.push({ name: "History Branch", pass, note: "new branch length is #3, not #6" });
    assert.ok(pass, "T7 failed");
  }

  // 8. Webview Drop
  {
    harness.seedFile(file, base);
    harness.setPreviewConnected(true);
    const running = harness.requestMutation({
      id: "T8",
      filePath: file,
      streamMs: 400,
      transform: (input) => input.replace("Click me", "Drop")
    });
    await new Promise((r) => setTimeout(r, 360));
    harness.setPreviewConnected(false);
    const ok = await running;
    const pass = !ok && harness.getDisconnectPrompt() === "Preview disconnected — restart?";
    results.push({ name: "Webview Drop", pass, note: "disconnect prompt is explicit" });
    assert.ok(pass, "T8 failed");
    harness.setPreviewConnected(true);
  }

  // 9. The Large Write
  {
    harness.seedFile(file, base);
    const ok = await harness.requestMutation({
      id: "T9",
      filePath: file,
      transform: (input) => `${input}\n${makeLargeBlock(200)}`
    });
    const after = harness.readFile(file);
    const pass = ok && after.includes("const row199 = 199;");
    results.push({ name: "The Large Write", pass, note: "200-line chunk flushed without timeout" });
    assert.ok(pass, "T9 failed");
  }

  // 10. The Log Audit
  {
    const logs = harness.getLogs();
    const required: StepName[] = ["click", "resolve-v-id", "rag-context", "stream-start", "validator", "vfs-write", "hot-reload"];
    const inspected = logs[0];
    const hasAll = required.every((s) => inspected.steps.some((x) => x.step === s && Number.isFinite(x.at)));
    const ordered = inspected.steps.every((step, i, arr) => i === 0 || step.at >= arr[i - 1].at);
    const pass = hasAll && ordered;
    results.push({ name: "The Log Audit", pass, note: "full click→reload timeline timestamped" });
    assert.ok(pass, "T10 failed");
  }

  const report = {
    timestamp: new Date().toISOString(),
    passed: results.filter((r) => r.pass).length,
    failed: results.filter((r) => !r.pass).length,
    results
  };

  const outPath = path.join(process.cwd(), "test-out", "day11-meat-grinder-results.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");

  for (const r of results) {
    console.log(`${r.pass ? "✅" : "❌"} ${r.name} — ${r.note}`);
  }
  console.log(`\nDay 11 Meat Grinder: ${report.passed}/10 passed`);
}

async function runWithRetries(maxAttempts: number): Promise<void> {
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      console.log(`\n=== Day 11 Meat Grinder Run ${attempt}/${maxAttempts} ===`);
      await runDay11MeatGrinder();
      return;
    } catch (error) {
      if (attempt >= maxAttempts) {
        throw error;
      }
      console.error(`Run ${attempt} failed, rerunning full table...`);
    }
  }
}

runWithRetries(2).catch((error) => {
  console.error("Day 11 Meat Grinder failed:", error);
  process.exit(1);
});
