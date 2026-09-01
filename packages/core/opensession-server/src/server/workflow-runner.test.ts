import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  cancelWorkflow,
  checkScriptSyntax,
  controlWorkflowAgent,
  parseWorkflowMeta,
  pauseWorkflow,
  recoverWorkflow,
  resumeWorkflow,
  startWorkflow,
  type StartWorkflowOpts,
} from "./workflow-runner";
import {
  getWorkflowRun,
  markInterruptedWorkflows,
  readWorkflowJournal,
  readWorkflowScript,
  unregisterLiveWorkflow,
  updateWorkflowRun,
} from "./workflow-store";
import {
  WORKFLOW_LIMITS,
  isMcpJournalEntry,
  isSessionJournalEntry,
  type WorkflowAgentOutcome,
  type WorkflowAgentRequest,
  type WorkflowExecCtx,
  type WorkflowExecutor,
  type WorkflowJournalEntry,
  type WorkflowRunSnapshot,
  type WorkflowSessionController,
  type WorkflowSessionStatus,
  type WorkflowSpawnedSession,
  type WorkflowSpawnSessionOpts,
} from "./workflow-types";
import type { WorkflowMcpHost } from "./workflow-mcp";

const savedEnv = process.env.OPENSESSION_WORKFLOWS_DIR;
const dirs: string[] = [];

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "wf-runner-test-"));
  dirs.push(dir);
  process.env.OPENSESSION_WORKFLOWS_DIR = dir;
});

afterAll(() => {
  if (savedEnv === undefined) delete process.env.OPENSESSION_WORKFLOWS_DIR;
  else process.env.OPENSESSION_WORKFLOWS_DIR = savedEnv;
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

type ExecCall = { req: WorkflowAgentRequest; ctx: WorkflowExecCtx };

function fakeExecutor(
  fn: (
    req: WorkflowAgentRequest,
    ctx: WorkflowExecCtx,
  ) => WorkflowAgentOutcome | Promise<WorkflowAgentOutcome>,
): WorkflowExecutor & { calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  return {
    calls,
    async execute(req, ctx) {
      calls.push({ req, ctx });
      return fn(req, ctx);
    },
  };
}

/** Echo executor: resolves every prompt to "R:<prompt>". */
function echoExecutor(tokens?: { input: number; output: number }) {
  return fakeExecutor((req) => ({
    ok: true,
    text: `R:${req.prompt}`,
    ...(tokens ? { tokens } : {}),
  }));
}

async function waitUntil<T>(
  fn: () => T | undefined | false | null,
  timeoutMs = 8_000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function waitForFinished(runId: string): Promise<WorkflowRunSnapshot> {
  return waitUntil(() => {
    const s = getWorkflowRun(runId);
    return s && s.status !== "running" ? s : undefined;
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function start(
  overrides: Partial<StartWorkflowOpts> & {
    script: string;
    executor: WorkflowExecutor;
  },
) {
  return startWorkflow({
    sessionId: "bks-wf-test",
    cwd: "/tmp",
    ...overrides,
  });
}

// ── parseWorkflowMeta ────────────────────────────────────────────────────────

describe("parseWorkflowMeta", () => {
  test("valid meta parses and the export is stripped from the body", () => {
    const script = `export const meta = { name: "audit", description: "check things" };\nreturn 1;`;
    const { meta, body } = parseWorkflowMeta(script);
    expect(meta.name).toBe("audit");
    expect(meta.description).toBe("check things");
    expect(body).not.toContain("export");
    expect(body).toContain("return 1;");
  });

  test("nested object literals (phases) survive the balanced-brace scan", () => {
    const script = [
      "export const meta = {",
      '\tname: "nested",',
      "\tphases: [",
      '\t\t{ title: "One", detail: "curly } in a string" },',
      '\t\t{ title: "Two" },',
      "\t],",
      "};",
      'return "body";',
    ].join("\n");
    const { meta, body } = parseWorkflowMeta(script);
    expect(meta.phases?.map((p) => p.title)).toEqual(["One", "Two"]);
    expect(body.trim()).toBe('return "body";');
  });

  test("missing meta throws", () => {
    expect(() => parseWorkflowMeta("return 1;")).toThrow(/export const meta/);
  });

  test("non-literal meta throws", () => {
    expect(() =>
      parseWorkflowMeta("export const meta = buildMeta();\nreturn 1;"),
    ).toThrow(/object literal/);
    expect(() =>
      parseWorkflowMeta(
        "export const meta = { name: undefinedRef() };\nreturn 1;",
      ),
    ).toThrow(/object literal/);
    expect(() =>
      parseWorkflowMeta('export const meta = { name: "" };\nreturn 1;'),
    ).toThrow(/meta\.name/);
  });
});

// ── Workflow execution ───────────────────────────────────────────────────────

describe("workflow runner", () => {
  test("happy path: phases, agents, logs, journal, result", async () => {
    const executor = echoExecutor({ input: 5, output: 7 });
    const { runId } = start({
      script: [
        'export const meta = { name: "happy", phases: [{ title: "Gather" }, { title: "Summarize" }] };',
        'phase("Gather");',
        'log("starting");',
        'const a = await agent("list things", { label: "lister" });',
        'phase("Summarize");',
        'const b = await agent("summarize: " + a);',
        "return { a, b };",
      ].join("\n"),
      executor,
      user: "alex",
      defaultModel: "claude-sonnet-5",
    });

    const s = await waitForFinished(runId);
    expect(s.status).toBe("done");
    expect(s.result).toEqual({
      a: "R:list things",
      b: "R:summarize: R:list things",
    });
    expect(s.name).toBe("happy");
    expect(s.phases).toEqual(["Gather", "Summarize"]);
    expect(s.currentPhase).toBe("Summarize");
    expect(s.logs.map((l) => l.message)).toEqual(["starting"]);
    expect(s.agents.length).toBe(2);
    expect(s.agents[0].label).toBe("lister");
    expect(s.agents[0].phase).toBe("Gather");
    expect(s.agents[0].status).toBe("done");
    expect(s.agents[1].phase).toBe("Summarize");
    expect(s.agents[1].status).toBe("done");
    expect(s.agents[1].label).toBe("summarize: R:list things");
    expect(s.totals).toEqual({ agents: 2, tokensIn: 10, tokensOut: 14 });
    expect(s.endedAt).toBeTruthy();

    // Executor got the run context.
    expect(executor.calls[0].ctx.sessionId).toBe("bks-wf-test");
    expect(executor.calls[0].ctx.cwd).toBe("/tmp");
    expect(executor.calls[0].ctx.user).toBe("alex");
    expect(executor.calls[0].ctx.defaultModel).toBe("claude-sonnet-5");

    const journal = readWorkflowJournal(runId) as WorkflowJournalEntry[];
    expect(journal.length).toBe(2);
    expect(journal[0].prompt).toBe("list things");
    expect(journal[0].outcome.text).toBe("R:list things");
    expect(journal[0].hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("parallel: a thrown thunk resolves to null, others land", async () => {
    const executor = echoExecutor();
    const { runId } = start({
      script: [
        'export const meta = { name: "par" };',
        "return await parallel([",
        '\t() => agent("one"),',
        '\t() => { throw new Error("boom"); },',
        '\t() => agent("two"),',
        "]);",
      ].join("\n"),
      executor,
    });
    const s = await waitForFinished(runId);
    expect(s.status).toBe("done");
    expect(s.result).toEqual(["R:one", null, "R:two"]);
    expect(executor.calls.length).toBe(2);
  });

  test("pipeline: no barrier between stages", async () => {
    const seen: string[] = [];
    const holdS1B = deferred<WorkflowAgentOutcome>();
    const executor = fakeExecutor((req) => {
      seen.push(req.prompt);
      if (req.prompt === "s1:B") return holdS1B.promise;
      return { ok: true, text: `R:${req.prompt}` };
    });
    const { runId } = start({
      script: [
        'export const meta = { name: "pipe" };',
        "return await pipeline(args.items,",
        '\t(item) => agent("s1:" + item),',
        '\t(prev, item) => agent("s2:" + item + ":" + prev),',
        ");",
      ].join("\n"),
      args: { items: ["A", "B"] },
      executor,
    });

    // Item A reaches stage 2 while item B's stage 1 is still in flight —
    // that's the no-barrier property.
    await waitUntil(() => seen.includes("s2:A:R:s1:A"));
    expect(seen).toContain("s1:B");
    expect(getWorkflowRun(runId)?.status).toBe("running");
    holdS1B.resolve({ ok: true, text: "R:s1:B" });

    const s = await waitForFinished(runId);
    expect(s.status).toBe("done");
    expect(s.result).toEqual(["R:s2:A:R:s1:A", "R:s2:B:R:s1:B"]);
  });

  test("pipeline: a throwing stage drops the item to null and skips its remaining stages", async () => {
    const executor = echoExecutor();
    const { runId } = start({
      script: [
        'export const meta = { name: "pipe-throw" };',
        'return await pipeline(["A", "B"],',
        '\t(item) => { if (item === "A") throw new Error("nope"); return agent("s1:" + item); },',
        '\t(prev) => agent("s2:" + prev),',
        ");",
      ].join("\n"),
      executor,
    });
    const s = await waitForFinished(runId);
    expect(s.status).toBe("done");
    expect(s.result).toEqual([null, "R:s2:R:s1:B"]);
    // Item A never reached the executor at all.
    expect(executor.calls.map((c) => c.req.prompt).sort()).toEqual([
      "s1:B",
      "s2:R:s1:B",
    ]);
  });

  test("schema pass-through: structured outcome reaches the script as an object", async () => {
    const executor = fakeExecutor(() => ({
      ok: true,
      text: '{"answer":42}',
      structured: { answer: 42 },
    }));
    const { runId } = start({
      script: [
        'export const meta = { name: "schema" };',
        'const r = await agent("q", { schema: { type: "object" } });',
        "return r.answer;",
      ].join("\n"),
      executor,
    });
    const s = await waitForFinished(runId);
    expect(s.status).toBe("done");
    expect(s.result).toBe(42);
    expect(s.agents[0].structured).toBe(true);
    expect(executor.calls[0].req.opts.schema).toEqual({ type: "object" });
  });

  test("agent error: script receives null, snapshot marks error, run completes", async () => {
    const executor = fakeExecutor(() => ({ ok: false, error: "boom" }));
    const { runId } = start({
      script: [
        'export const meta = { name: "err" };',
        'const r = await agent("bad");',
        "return r === null;",
      ].join("\n"),
      executor,
    });
    const s = await waitForFinished(runId);
    expect(s.status).toBe("done");
    expect(s.result).toBe(true);
    expect(s.agents[0].status).toBe("error");
    expect(s.agents[0].error).toBe("boom");
  });

  test("semaphore: concurrent executor calls never exceed the limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const executor = fakeExecutor(async (req) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight--;
      return { ok: true, text: `R:${req.prompt}` };
    });
    const { runId } = start({
      script: [
        'export const meta = { name: "sem" };',
        "const thunks = [];",
        'for (let i = 0; i < 20; i++) thunks.push(() => agent("job " + i));',
        "const out = await parallel(thunks);",
        "return out.length;",
      ].join("\n"),
      executor,
    });
    const s = await waitForFinished(runId);
    expect(s.status).toBe("done");
    expect(s.result).toBe(20);
    expect(executor.calls.length).toBe(20);
    expect(maxInFlight).toBeLessThanOrEqual(
      WORKFLOW_LIMITS.maxConcurrentAgents,
    );
    expect(maxInFlight).toBeGreaterThan(1);
  });

  test("Date.now / argless new Date / Math.random throw inside scripts; new Date(ms) works", async () => {
    const executor = echoExecutor();
    const { runId } = start({
      script: [
        'export const meta = { name: "poison" };',
        "const out = [];",
        'try { Date.now(); out.push("now-ok"); } catch { out.push("now-threw"); }',
        'try { new Date(); out.push("date-ok"); } catch { out.push("date-threw"); }',
        'try { Math.random(); out.push("rand-ok"); } catch { out.push("rand-threw"); }',
        'out.push(new Date(0).getTime() === 0 ? "date-ms-ok" : "date-ms-bad");',
        "return out;",
      ].join("\n"),
      executor,
    });
    const s = await waitForFinished(runId);
    expect(s.status).toBe("done");
    expect(s.result).toEqual([
      "now-threw",
      "date-threw",
      "rand-threw",
      "date-ms-ok",
    ]);
  });

  test("script throw → run status error with the message", async () => {
    const executor = echoExecutor();
    const { runId } = start({
      script:
        'export const meta = { name: "throws" };\nthrow new Error("script exploded");',
      executor,
    });
    const s = await waitForFinished(runId);
    expect(s.status).toBe("error");
    expect(s.error).toBe("script exploded");
  });

  test("budget: total/spent/remaining track executor output tokens", async () => {
    const executor = echoExecutor({ input: 10, output: 250 });
    const { runId } = start({
      script: [
        'export const meta = { name: "budget" };',
        "const before = budget.remaining();",
        'await agent("a");',
        "return { total: budget.total, spent: budget.spent(), before, after: budget.remaining() };",
      ].join("\n"),
      executor,
      budgetTotal: 1000,
    });
    const s = await waitForFinished(runId);
    expect(s.status).toBe("done");
    expect(s.result).toEqual({
      total: 1000,
      spent: 250,
      before: 1000,
      after: 750,
    });
  });

  test("budget: unbounded when no total given", async () => {
    const executor = echoExecutor();
    const { runId } = start({
      script: [
        'export const meta = { name: "budget-unbounded" };',
        "return { total: budget.total, unbounded: budget.remaining() === Infinity };",
      ].join("\n"),
      executor,
    });
    const s = await waitForFinished(runId);
    expect(s.result).toEqual({ total: null, unbounded: true });
  });

  test("cancelWorkflow mid-run: status cancelled, signal aborted, worker gone", async () => {
    let capturedCtx: WorkflowExecCtx | undefined;
    const executor = fakeExecutor(
      (_req, ctx) =>
        new Promise<WorkflowAgentOutcome>((resolve) => {
          capturedCtx = ctx;
          ctx.signal.addEventListener("abort", () =>
            resolve({ ok: false, error: "aborted" }),
          );
        }),
    );
    const { runId } = start({
      script: [
        'export const meta = { name: "cancel-me" };',
        'await agent("block forever");',
        'return "never";',
      ].join("\n"),
      executor,
    });

    await waitUntil(() => executor.calls.length === 1);
    expect(cancelWorkflow(runId)).toBe(true);

    const s = await waitForFinished(runId);
    expect(s.status).toBe("cancelled");
    expect(s.result).toBeUndefined();
    expect(s.agents[0].status).toBe("cancelled");
    expect(capturedCtx?.signal.aborted).toBe(true);
    // Unregistered: a second cancel finds no live run.
    expect(cancelWorkflow(runId)).toBe(false);
  });

  test("startWorkflow validates script size", () => {
    expect(() =>
      start({
        script:
          'export const meta = { name: "big" };\n' +
          "//".padEnd(WORKFLOW_LIMITS.maxScriptChars, "x"),
        executor: echoExecutor(),
      }),
    ).toThrow(/too large/);
  });

  test("journal replay: identical resume answers every call from the journal", async () => {
    const script = [
      'export const meta = { name: "replay" };',
      'const a = await agent("first");',
      'const b = await agent("second:" + a);',
      "return [a, b];",
    ].join("\n");
    const executor1 = echoExecutor();
    const { runId } = start({ script, executor: executor1 });
    const first = await waitForFinished(runId);
    expect(first.status).toBe("done");
    expect(executor1.calls.length).toBe(2);

    const executor2 = echoExecutor();
    const { runId: resumedId } = start({
      script,
      executor: executor2,
      resumeFromRunId: runId,
    });
    const resumed = await waitForFinished(resumedId);
    expect(resumed.status).toBe("done");
    expect(resumed.result).toEqual(first.result);
    expect(executor2.calls.length).toBe(0);
    expect(resumed.agents.map((a) => a.cached)).toEqual([true, true]);
    // Cached entries were re-journaled, so resuming the resumed run works too.
    expect(readWorkflowJournal(resumedId).length).toBe(2);
  });

  test("journal replay: a changed prompt re-executes from the changed call, unrelated calls stay cached", async () => {
    const scriptV1 = [
      'export const meta = { name: "replay2" };',
      'const a = await agent("alpha");',
      'const b = await agent("beta");',
      'const c = await agent("gamma:" + a);',
      "return [a, b, c];",
    ].join("\n");
    const executor1 = echoExecutor();
    const { runId } = start({ script: scriptV1, executor: executor1 });
    await waitForFinished(runId);
    expect(executor1.calls.length).toBe(3);

    const scriptV2 = scriptV1.replace('"alpha"', '"alpha-v2"');
    const executor2 = echoExecutor();
    const { runId: resumedId } = start({
      script: scriptV2,
      executor: executor2,
      resumeFromRunId: runId,
    });
    const resumed = await waitForFinished(resumedId);
    expect(resumed.status).toBe("done");
    expect(resumed.result).toEqual([
      "R:alpha-v2",
      "R:beta",
      "R:gamma:R:alpha-v2",
    ]);
    // The changed call and its downstream re-executed; the untouched one
    // replayed from the journal.
    expect(executor2.calls.map((c) => c.req.prompt).sort()).toEqual([
      "alpha-v2",
      "gamma:R:alpha-v2",
    ]);
    const bySeq = new Map(resumed.agents.map((a) => [a.seq, a]));
    expect(bySeq.get(0)?.cached).toBeUndefined();
    expect(bySeq.get(1)?.cached).toBe(true);
    expect(bySeq.get(2)?.cached).toBeUndefined();
  });
});

// ── Review-pass fixes (2026-07-10) ───────────────────────────────────────────

describe("hostile meta (static parser, zero evaluation)", () => {
  test("IIFE in a value is rejected and never executes", () => {
    (globalThis as any).__wfMetaPwned = undefined;
    expect(() =>
      parseWorkflowMeta(
        'export const meta = { name: (() => { globalThis.__wfMetaPwned = 1; return "x"; })() };\nreturn 1;',
      ),
    ).toThrow(/pure object literal/);
    expect((globalThis as any).__wfMetaPwned).toBeUndefined();
  });

  test("getters, computed keys, assignments, templates and identifier values are rejected", () => {
    const hostile = [
      'export const meta = { get name() { return "x"; } };',
      'export const meta = { ["na" + "me"]: "x" };',
      'export const meta = { name: globalThis.__x = "y" };',
      "export const meta = { name: `tpl${1}` };",
      "export const meta = { name: process.env.HOME };",
      'export const meta = { name: "ok", phases: [{ title: Date }] };',
    ];
    for (const script of hostile) {
      expect(() => parseWorkflowMeta(script + "\nreturn 1;")).toThrow(
        /pure object literal/,
      );
    }
  });

  test("prototype-polluting keys are dropped, comments and trailing commas parse", () => {
    const { meta } = parseWorkflowMeta(
      [
        "export const meta = {",
        "\t// a comment",
        '\tname: "safe", /* inline */',
        "\t__proto__: { polluted: true },",
        "};",
        "return 1;",
      ].join("\n"),
    );
    expect(meta.name).toBe("safe");
    expect(({} as any).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(meta)).toBe(Object.prototype);
  });
});

describe("journal replay determinism", () => {
  const RACY_SCRIPT = [
    'export const meta = { name: "racy" };',
    "const [x, y] = await parallel([",
    '\tasync () => { const a1 = await agent("a1"); return agent("a2:" + a1); },',
    '\tasync () => { const b1 = await agent("b1"); return agent("b2:" + b1); },',
    "]);",
    "return [x, y];",
  ].join("\n");

  test("parallel dependent chains replay fully even when live completion order differed", async () => {
    // Live run: a1 deliberately slow, so b's chain finishes first and the
    // journal's call order is a1, b1, b2, a2 — NOT replay call order.
    const executor1 = fakeExecutor(async (req) => {
      if (req.prompt === "a1") await new Promise((r) => setTimeout(r, 120));
      return { ok: true, text: `R:${req.prompt}` };
    });
    const { runId } = start({ script: RACY_SCRIPT, executor: executor1 });
    const first = await waitForFinished(runId);
    expect(first.status).toBe("done");
    expect(executor1.calls.length).toBe(4);

    const executor2 = echoExecutor();
    const { runId: resumedId } = start({
      script: RACY_SCRIPT,
      executor: executor2,
      resumeFromRunId: runId,
    });
    const resumed = await waitForFinished(resumedId);
    expect(resumed.status).toBe("done");
    expect(resumed.result).toEqual(first.result);
    expect(executor2.calls.length).toBe(0);
    expect(resumed.agents.every((a) => a.cached)).toBe(true);
  });

  test("identical parallel agent calls replay in invocation order", async () => {
    const script = [
      'export const meta = { name: "identical-agents" };',
      'return await parallel([() => agent("same"), () => agent("same")]);',
    ].join("\n");
    const firstResult = deferred<WorkflowAgentOutcome>();
    let invocation = 0;
    const executor1 = fakeExecutor(() => {
      const current = invocation++;
      return current === 0 ? firstResult.promise : { ok: true, text: "second" };
    });
    const { runId } = start({ script, executor: executor1 });
    await waitUntil(() => readWorkflowJournal(runId).length === 1);
    firstResult.resolve({ ok: true, text: "first" });
    const first = await waitForFinished(runId);
    expect(first.result).toEqual(["first", "second"]);
    // The faster second call is physically appended first.
    expect(
      readWorkflowJournal(runId)
        .filter(
          (entry): entry is WorkflowJournalEntry => !isMcpJournalEntry(entry),
        )
        .map((entry) => entry.seq),
    ).toEqual([1, 0]);

    const executor2 = echoExecutor();
    const { runId: resumedId } = start({
      script,
      executor: executor2,
      resumeFromRunId: runId,
    });
    const resumed = await waitForFinished(resumedId);
    expect(resumed.result).toEqual(first.result);
    expect(executor2.calls).toHaveLength(0);
  });

  test("failed outcomes are journaled but re-executed on resume", async () => {
    const script = [
      'export const meta = { name: "retry" };',
      'const bad = await agent("flaky");',
      'const good = await agent("solid");',
      "return [bad, good];",
    ].join("\n");
    const executor1 = fakeExecutor((req) =>
      req.prompt === "flaky"
        ? { ok: false, error: "transient" }
        : { ok: true, text: `R:${req.prompt}` },
    );
    const { runId } = start({ script, executor: executor1 });
    const first = await waitForFinished(runId);
    expect(first.result).toEqual([null, "R:solid"]);
    // Both outcomes are journaled (audit trail)…
    expect(readWorkflowJournal(runId).length).toBe(2);

    // …but only the ok one replays; the failure gets a fresh execution.
    const executor2 = echoExecutor();
    const { runId: resumedId } = start({
      script,
      executor: executor2,
      resumeFromRunId: runId,
    });
    const resumed = await waitForFinished(resumedId);
    expect(resumed.result).toEqual(["R:flaky", "R:solid"]);
    expect(executor2.calls.map((c) => c.req.prompt)).toEqual(["flaky"]);
  });

  test("budget.spent() replays identically (original tokensOut reported for cached calls)", async () => {
    const script = [
      'export const meta = { name: "budgeted" };',
      'await agent("one");',
      'await agent("two");',
      "return budget.spent();",
    ].join("\n");
    const executor1 = echoExecutor({ input: 10, output: 100 });
    const { runId } = start({ script, executor: executor1, budgetTotal: 1000 });
    const first = await waitForFinished(runId);
    expect(first.result).toBe(200);

    const executor2 = echoExecutor();
    const { runId: resumedId } = start({
      script,
      executor: executor2,
      resumeFromRunId: runId,
      budgetTotal: 1000,
    });
    const resumed = await waitForFinished(resumedId);
    expect(resumed.result).toBe(200);
    expect(executor2.calls.length).toBe(0);
    // Display totals stay this-run-only (cached calls cost nothing now).
    expect(resumed.totals.tokensOut).toBe(0);
  });
});

describe("worker containment & lifecycle", () => {
  test("script sees no Bun/process/fetch/WebSocket/globalThis (exfil/spawn surface shadowed)", async () => {
    const script = [
      'export const meta = { name: "scrubbed" };',
      "return [typeof Bun, typeof process, typeof fetch, typeof WebSocket, typeof XMLHttpRequest, typeof globalThis].join(',');",
    ].join("\n");
    const { runId } = start({ script, executor: echoExecutor() });
    const snap = await waitForFinished(runId);
    expect(snap.status).toBe("done");
    expect(snap.result).toBe(
      "undefined,undefined,undefined,undefined,undefined,undefined",
    );
  });

  test("a script cannot exit the worker process (process/globalThis unreachable)", async () => {
    // The containment that makes the close-handler's uncommanded-exit case
    // rare: a script has no reachable path to process.exit / self.close.
    const script = [
      'export const meta = { name: "no-exit" };',
      'try { process.exit(0); } catch (e) { return "blocked:" + e.constructor.name; }',
      'return "escaped";',
    ].join("\n");
    const { runId } = start({ script, executor: echoExecutor() });
    const snap = await waitForFinished(runId);
    expect(snap.status).toBe("done");
    expect(String(snap.result)).toMatch(/^blocked:TypeError/);
  });
});

describe("snapshot payload bounds", () => {
  test("log lines, labels and errors are truncated in the snapshot", async () => {
    const script = [
      'export const meta = { name: "bounded" };',
      'log("x".repeat(10_000));',
      'await agent("p".repeat(5_000), { label: "L".repeat(5_000) });',
      "return 1;",
    ].join("\n");
    const executor = fakeExecutor(() => ({
      ok: false,
      error: "E".repeat(50_000),
    }));
    const { runId } = start({ script, executor });
    const snap = await waitForFinished(runId);
    expect(snap.logs[0].message.length).toBeLessThanOrEqual(501);
    expect(snap.agents[0].label.length).toBeLessThanOrEqual(201);
    expect((snap.agents[0].error || "").length).toBeLessThanOrEqual(1001);
  });
});

// ── Script syntax pre-check (2026-07-11: truncated scripts failed cryptically) ─

describe("checkScriptSyntax", () => {
  test("valid body passes", () => {
    expect(
      checkScriptSyntax('phase("x"); return await agent("hi");'),
    ).toBeNull();
  });

  test("a truncated body (cut mid-statement) is flagged as likely-truncated", () => {
    // Exactly the real-world failure: the run_workflow arg was cut off.
    const msg = checkScriptSyntax("const findings = results.filter(");
    expect(msg).toBeTruthy();
    expect(msg).toMatch(/syntax error/i);
    expect(msg).toMatch(/truncated/i);
  });

  test("unbalanced brace is flagged", () => {
    const msg = checkScriptSyntax('if (x) { log("a")');
    expect(msg).toMatch(/syntax error/i);
  });

  test("a plain (non-truncation) syntax error omits the truncation hint", () => {
    const msg = checkScriptSyntax("return 1 2 3;");
    expect(msg).toBeTruthy();
    expect(msg).not.toMatch(/truncated/i);
  });

  test("startWorkflow throws synchronously on a truncated script (no run created)", () => {
    expect(() =>
      startWorkflow({
        sessionId: "bks-x",
        cwd: "/tmp",
        executor: echoExecutor(),
        script:
          'export const meta = { name: "broken" };\nconst r = await parallel([() => agent("hi"',
      }),
    ).toThrow(/truncated/i);
  });
});

// ── mcp.* (direct tool calls from the script) ────────────────────────────────

/** Fake MCP host: records calls, no transport. */
function fakeMcpHost(
  call: (server: string, tool: string, args: unknown) => unknown,
  servers: string[] = ["grafana", "linear"],
): WorkflowMcpHost & {
  calls: Array<{ server: string; tool: string; args: unknown }>;
  isClosed: () => boolean;
} {
  const calls: Array<{ server: string; tool: string; args: unknown }> = [];
  let closed = false;
  return {
    calls,
    isClosed: () => closed,
    servers: () => servers,
    async tools(server: string) {
      return [{ name: `${server}_probe`, description: "probe" }];
    },
    async call(server: string, tool: string, args: unknown) {
      calls.push({ server, tool, args });
      return call(server, tool, args);
    },
    async close() {
      closed = true;
    },
  };
}

describe("workflow mcp.*", () => {
  test("mcp.<server>.<tool>(args) reaches the host and resolves its value", async () => {
    const mcpHost = fakeMcpHost(() => [{ id: 1 }, { id: 2 }]);
    const { runId } = start({
      executor: echoExecutor(),
      mcpHost,
      script: [
        'export const meta = { name: "mcp-basic" };',
        'const rows = await mcp.grafana.query_prometheus({ expr: "up" });',
        "return rows.length;",
      ].join("\n"),
    });
    const snap = await waitForFinished(runId);
    expect(snap.status).toBe("done");
    expect(snap.result).toBe(2);
    expect(mcpHost.calls).toEqual([
      { server: "grafana", tool: "query_prometheus", args: { expr: "up" } },
    ]);
    // No agent was spent on the lookup — that's the whole point.
    expect(snap.agents.length).toBe(0);
    expect(snap.totals.mcpCalls).toBe(1);
  });

  test("a failing tool call REJECTS in the script (and parallel degrades it to null)", async () => {
    const mcpHost = fakeMcpHost((_s, tool) => {
      if (tool === "boom") throw new Error("upstream 500");
      return "fine";
    });
    const { runId } = start({
      executor: echoExecutor(),
      mcpHost,
      script: [
        'export const meta = { name: "mcp-error" };',
        "const batch = await parallel([",
        "  () => mcp.grafana.ok({}),",
        "  () => mcp.grafana.boom({}),",
        "]);",
        'let caught = "";',
        "try { await mcp.grafana.boom({}); } catch (e) { caught = e.message; }",
        "return { batch, caught };",
      ].join("\n"),
    });
    const snap = await waitForFinished(runId);
    expect(snap.status).toBe("done");
    const result = snap.result as { batch: unknown[]; caught: string };
    expect(result.batch).toEqual(["fine", null]);
    expect(result.caught).toContain("upstream 500");
    expect(snap.totals.mcpCalls).toBe(3);
    expect(snap.totals.mcpErrors).toBe(2);
    const failed = (snap.mcpCalls || []).filter((c) => !c.ok);
    expect(failed.length).toBe(2);
    expect(failed[0].tool).toBe("boom");
  });

  test("calls are journaled as kind:mcp, with args and value", async () => {
    const mcpHost = fakeMcpHost(() => ({ status: "ok" }));
    const { runId } = start({
      executor: echoExecutor(),
      mcpHost,
      script: [
        'export const meta = { name: "mcp-journal", phases: [{ title: "Fetch" }] };',
        'phase("Fetch");',
        'return await mcp.linear.list_issues({ team: "ENG" });',
      ].join("\n"),
    });
    const snapshot = await waitForFinished(runId);
    const entries = readWorkflowJournal(runId).filter(isMcpJournalEntry);
    expect(entries.length).toBe(1);
    expect(entries[0].server).toBe("linear");
    expect(entries[0].tool).toBe("list_issues");
    expect(entries[0].args).toEqual({ team: "ENG" });
    expect(entries[0].phase).toBe("Fetch");
    expect(entries[0].ok).toBe(true);
    expect(entries[0].value).toEqual({ status: "ok" });
    expect(entries[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.phaseStats?.[0].toolCalls).toBe(1);
  });

  test("resume REPLAYS a tool call from the journal instead of re-firing it", async () => {
    const script = [
      'export const meta = { name: "mcp-resume" };',
      'return await mcp.linear.create_issue({ title: "once" });',
    ].join("\n");
    const first = fakeMcpHost(() => "ISSUE-1");
    const { runId } = start({
      executor: echoExecutor(),
      mcpHost: first,
      script,
    });
    const done = await waitForFinished(runId);
    expect(done.result).toBe("ISSUE-1");

    // A host that would answer differently — it must never be asked.
    const second = fakeMcpHost(() => "ISSUE-2");
    const { runId: resumedId } = start({
      executor: echoExecutor(),
      mcpHost: second,
      script,
      resumeFromRunId: runId,
    });
    const resumed = await waitForFinished(resumedId);
    expect(resumed.result).toBe("ISSUE-1");
    expect(second.calls.length).toBe(0);
    expect((resumed.mcpCalls || [])[0]?.cached).toBe(true);
    // The replayed record carries into the new run's journal, so resuming
    // the resumed run replays too.
    expect(
      readWorkflowJournal(resumedId).filter(isMcpJournalEntry).length,
    ).toBe(1);
  });

  test("identical parallel tool calls replay in invocation order", async () => {
    const script = [
      'export const meta = { name: "mcp-identical" };',
      "return await parallel([",
      "  () => mcp.linear.create_issue({ title: 'same' }),",
      "  () => mcp.linear.create_issue({ title: 'same' }),",
      "]);",
    ].join("\n");
    const firstResult = deferred<string>();
    let invocation = 0;
    const firstHost = fakeMcpHost(() => {
      const current = invocation++;
      return current === 0 ? firstResult.promise : "ISSUE-2";
    });
    const { runId } = start({
      executor: echoExecutor(),
      mcpHost: firstHost,
      script,
    });
    await waitUntil(() => readWorkflowJournal(runId).length === 1);
    firstResult.resolve("ISSUE-1");
    const first = await waitForFinished(runId);
    expect(first.result).toEqual(["ISSUE-1", "ISSUE-2"]);
    expect(
      readWorkflowJournal(runId)
        .filter(isMcpJournalEntry)
        .map((entry) => entry.seq),
    ).toEqual([1, 0]);

    const secondHost = fakeMcpHost(() => "must not run");
    const { runId: resumedId } = start({
      executor: echoExecutor(),
      mcpHost: secondHost,
      script,
      resumeFromRunId: runId,
    });
    const resumed = await waitForFinished(resumedId);
    expect(resumed.result).toEqual(first.result);
    expect(secondHost.calls).toHaveLength(0);
  });

  test("a failed call is NOT replayed — resume retries it", async () => {
    const script = [
      'export const meta = { name: "mcp-retry" };',
      'try { return await mcp.grafana.flaky({}); } catch (e) { return "failed: " + e.message; }',
    ].join("\n");
    const failing = fakeMcpHost(() => {
      throw new Error("timeout");
    });
    const { runId } = start({
      executor: echoExecutor(),
      mcpHost: failing,
      script,
    });
    expect((await waitForFinished(runId)).result).toBe("failed: timeout");

    const healthy = fakeMcpHost(() => "recovered");
    const { runId: resumedId } = start({
      executor: echoExecutor(),
      mcpHost: healthy,
      script,
      resumeFromRunId: runId,
    });
    expect((await waitForFinished(resumedId)).result).toBe("recovered");
    expect(healthy.calls.length).toBe(1);
  });

  test("mcp.servers() and mcp.tools(server) enumerate without journaling", async () => {
    const mcpHost = fakeMcpHost(() => null, ["grafana", "plain"]);
    const { runId } = start({
      executor: echoExecutor(),
      mcpHost,
      script: [
        'export const meta = { name: "mcp-discovery" };',
        "const servers = await mcp.servers();",
        "const tools = await mcp.tools(servers[0]);",
        "return { servers, first: tools[0].name };",
      ].join("\n"),
    });
    const snap = await waitForFinished(runId);
    expect(snap.result).toEqual({
      servers: ["grafana", "plain"],
      first: "grafana_probe",
    });
    // Discovery is config, not an observation — nothing to replay.
    expect(readWorkflowJournal(runId).filter(isMcpJournalEntry).length).toBe(0);
    expect(snap.totals.mcpCalls).toBeUndefined();
  });

  test("the proxy is thenable-safe: awaiting mcp or a server does not hang", async () => {
    const mcpHost = fakeMcpHost(() => "ok");
    const { runId } = start({
      executor: echoExecutor(),
      mcpHost,
      script: [
        'export const meta = { name: "mcp-thenable" };',
        "const server = await mcp.grafana;",
        "return {",
        "  mcpThen: mcp.then === undefined,",
        "  serverThen: mcp.grafana.then === undefined,",
        '  stillCallable: typeof server.query === "function",',
        "};",
      ].join("\n"),
    });
    const snap = await waitForFinished(runId);
    expect(snap.status).toBe("done");
    expect(snap.result).toEqual({
      mcpThen: true,
      serverThen: true,
      stillCallable: true,
    });
  });

  test("the host is closed when the run finishes (stdio servers are processes)", async () => {
    const mcpHost = fakeMcpHost(() => "ok");
    const { runId } = start({
      executor: echoExecutor(),
      mcpHost,
      script: [
        'export const meta = { name: "mcp-teardown" };',
        "return await mcp.grafana.ping({});",
      ].join("\n"),
    });
    await waitForFinished(runId);
    await waitUntil(() => mcpHost.isClosed());
    expect(mcpHost.isClosed()).toBe(true);
  });

  test("a cancelled workflow settles in-flight tool calls instead of hanging", async () => {
    const gate = deferred<void>();
    const mcpHost = fakeMcpHost(() => {
      // Never resolves until the run is cancelled out from under it.
      return gate.promise.then(() => "late");
    });
    const { runId } = start({
      executor: echoExecutor(),
      mcpHost,
      script: [
        'export const meta = { name: "mcp-cancel" };',
        'try { await mcp.grafana.slow({}); return "resolved"; }',
        'catch (e) { return "rejected"; }',
      ].join("\n"),
    });
    await waitUntil(() => mcpHost.calls.length > 0);
    expect(cancelWorkflow(runId)).toBe(true);
    const snap = await waitForFinished(runId);
    expect(snap.status).toBe("cancelled");
    gate.resolve();
  });
});

describe("workflow live control and recovery", () => {
  test("pause aborts active agents and resume restarts them in place", async () => {
    let attempts = 0;
    const executor = fakeExecutor(async (_req, ctx) => {
      attempts++;
      if (attempts > 1) return { ok: true, text: "resumed" };
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) resolve();
        else
          ctx.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
      });
      return { ok: false, error: "cancelled" };
    });
    const { runId } = start({
      executor,
      script:
        'export const meta = { name: "pause" }; return await agent("hold");',
    });
    await waitUntil(
      () => getWorkflowRun(runId)?.agents[0]?.status === "running",
    );
    expect(pauseWorkflow(runId, "test pause")).toBe(true);
    await waitUntil(() => getWorkflowRun(runId)?.status === "paused");
    expect(getWorkflowRun(runId)?.pauseReason).toBe("test pause");
    expect(resumeWorkflow(runId)).toBe(true);
    const done = await waitForFinished(runId);
    expect(done.status).toBe("done");
    expect(done.result).toBe("resumed");
    expect(done.totalPausedMs).toBeGreaterThanOrEqual(0);
    expect(attempts).toBe(2);
  });

  test("retry restarts one running agent and skip resolves it to null", async () => {
    let attempts = 0;
    const retrying = fakeExecutor(async (_req, ctx) => {
      attempts++;
      if (attempts > 1) return { ok: true, text: "retried" };
      await new Promise<void>((resolve) =>
        ctx.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { ok: false, error: "cancelled" };
    });
    const retryRun = start({
      executor: retrying,
      script:
        'export const meta = { name: "retry" }; return await agent("retry me");',
    });
    await waitUntil(
      () => getWorkflowRun(retryRun.runId)?.agents[0]?.status === "running",
    );
    expect(controlWorkflowAgent(retryRun.runId, 0, "retry")).toBe(true);
    const retried = await waitForFinished(retryRun.runId);
    expect(retried.result).toBe("retried");
    expect(retried.agents[0].retries).toBe(1);

    const skipping = fakeExecutor(async (_req, ctx) => {
      await new Promise<void>((resolve) =>
        ctx.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { ok: false, error: "cancelled" };
    });
    const skipRun = start({
      executor: skipping,
      script:
        'export const meta = { name: "skip" }; return await agent("skip me");',
    });
    await waitUntil(
      () => getWorkflowRun(skipRun.runId)?.agents[0]?.status === "running",
    );
    expect(controlWorkflowAgent(skipRun.runId, 0, "skip")).toBe(true);
    const skipped = await waitForFinished(skipRun.runId);
    expect(skipped.result).toBeNull();
    expect(skipped.agents[0].status).toBe("cancelled");
  });

  test("restart recovery creates a journal-replaying lineage", async () => {
    const original = start({
      executor: echoExecutor(),
      script:
        'export const meta = { name: "recover" }; return await agent("once");',
      args: { stable: true },
      defaultModel: "pi/anthropic/claude-opus-5",
    });
    await waitForFinished(original.runId);
    unregisterLiveWorkflow(original.runId);
    updateWorkflowRun(original.runId, (snapshot) => {
      snapshot.status = "interrupted";
      snapshot.endedAt = new Date().toISOString();
    });

    const executor = echoExecutor();
    const recoveredId = await recoverWorkflow(original.runId, {
      executor,
      inProcessMcp: () => ({}),
    });
    expect(recoveredId).toBeTruthy();
    const recovered = await waitForFinished(recoveredId!);
    expect(recovered.replayRootRunId).toBe(original.runId);
    expect(recovered.agents[0].cached).toBe(true);
    expect(executor.calls).toHaveLength(0);
    expect(getWorkflowRun(original.runId)?.recoveredAsRunId).toBe(recoveredId);
  });
});

type FakeSessionController = WorkflowSessionController & {
  spawnCalls: number;
  spawnRequestIds: string[];
  spawnAdmissions: Array<WorkflowSpawnSessionOpts["admission"]>;
  sendCalls: Array<{ id: string; message: string }>;
  cancelCalls: string[];
  cancelActiveCalls: string[];
};

function fakeSessionController(): FakeSessionController {
  const statuses = new Map<string, WorkflowSessionStatus>();
  const owned = new Set<string>();
  const api: FakeSessionController = {
    spawnCalls: 0,
    spawnRequestIds: [],
    spawnAdmissions: [],
    sendCalls: [],
    cancelCalls: [],
    cancelActiveCalls: [],
    adopt(session) {
      owned.add(session.id);
      statuses.set(session.id, {
        ...session,
        status: "done",
        worktreeDir: `/worktrees/${session.branch}`,
        branchPushed: true,
      });
    },
    async spawn(opts, requestId) {
      api.spawnCalls++;
      api.spawnRequestIds.push(requestId);
      api.spawnAdmissions.push(opts.admission);
      const session: WorkflowSpawnedSession = {
        id: `child-${api.spawnCalls}`,
        url: `https://os.example.test/session/child-${api.spawnCalls}`,
        repo: opts.repo,
        branch: opts.branch || `branch-${api.spawnCalls}`,
        parentSessionId: "bks-wf-test",
      };
      owned.add(session.id);
      statuses.set(session.id, {
        ...session,
        status: "running",
        worktreeDir: `/worktrees/${session.branch}`,
        branchPushed: false,
      });
      return session;
    },
    async status(id) {
      if (!owned.has(id)) throw new Error("not owned");
      return statuses.get(id)!;
    },
    async wait(id, opts) {
      if (!owned.has(id)) throw new Error("not owned");
      const current = statuses.get(id)!;
      const status: WorkflowSessionStatus = {
        ...current,
        status: opts.until,
        branchPushed:
          current.branchPushed ||
          opts.until === "branch_pushed" ||
          opts.until === "pr_opened",
        ...(opts.until === "pr_opened"
          ? { prUrl: "https://github.com/tellahq/repo/pull/1" }
          : {}),
      };
      statuses.set(id, status);
      return status;
    },
    async send(id, message) {
      if (!owned.has(id)) throw new Error("not owned");
      api.sendCalls.push({ id, message });
      return { status: "steered" };
    },
    async cancel(id) {
      if (!owned.has(id)) throw new Error("not owned");
      api.cancelCalls.push(id);
      const status = { ...statuses.get(id)!, status: "cancelled" as const };
      statuses.set(id, status);
      return status;
    },
    async cancelActive(requestId) {
      api.cancelActiveCalls.push(requestId);
    },
  };
  return api;
}

describe("workflow durable session API", () => {
  const script = [
    'export const meta = { name: "sessions" };',
    'const child = await spawnSession({ prompt: "Implement it", repo: "renderer", mode: "code", workspace: { type: "isolated-worktree", baseRef: "main" }, branch: "compat/layout" });',
    "const first = await sessionStatus(child.id);",
    'await sendToSession(child.id, "Please push");',
    'const pushed = await waitSession(child.id, { until: "branch_pushed", timeout: 1000 });',
    "const cancelled = await cancelSession(child.id);",
    "return { child, first: first.status, pushed: pushed.status, cancelled: cancelled.status };",
  ].join("\n");

  test("spawns, supervises, messages, waits and cancels a real-session adapter", async () => {
    const sessions = fakeSessionController();
    const { runId } = start({
      executor: echoExecutor(),
      sessionController: sessions,
      script,
    });
    const snap = await waitForFinished(runId);
    expect(snap.status).toBe("done");
    expect(snap.result).toMatchObject({
      child: { id: "child-1", branch: "compat/layout" },
      first: "running",
      pushed: "branch_pushed",
      cancelled: "cancelled",
    });
    expect(snap.sessions).toHaveLength(1);
    expect(snap.sessions?.[0]).toMatchObject({
      id: "child-1",
      parentSessionId: "bks-wf-test",
      worktreeDir: "/worktrees/compat/layout",
      status: "cancelled",
    });
    expect(sessions.sendCalls).toEqual([
      { id: "child-1", message: "Please push" },
    ]);
    expect(sessions.cancelCalls).toEqual(["child-1"]);
    expect(
      readWorkflowJournal(runId).filter((entry) => entry.kind === "session"),
    ).toHaveLength(5);
  });

  test("resume replays completed calls and adopts the original child", async () => {
    const original = fakeSessionController();
    const first = start({
      executor: echoExecutor(),
      sessionController: original,
      script,
    });
    await waitForFinished(first.runId);

    const resumed = fakeSessionController();
    const second = start({
      executor: echoExecutor(),
      sessionController: resumed,
      script,
      resumeFromRunId: first.runId,
    });
    const snap = await waitForFinished(second.runId);
    expect(snap.result).toMatchObject({ child: { id: "child-1" } });
    expect(resumed.spawnCalls).toBe(0);
    expect(snap.replayRootRunId).toBe(first.runId);
    expect(snap.sessions?.map((session) => session.id)).toEqual(["child-1"]);
  });

  test("restart recovery re-adopts an unfinished wait and preserves its deadline", async () => {
    const originalSessions = fakeSessionController();
    const source = [
      'export const meta = { name: "recover-wait" };',
      'const child = await spawnSession({ prompt: "one", repo: "renderer", admission: { tokens: 500, costUsd: 2 } });',
      'return await waitSession(child.id, { until: "pr_checks_passed", timeout: 60000 });',
    ].join("\n");
    const original = start({
      executor: echoExecutor(),
      sessionController: originalSessions,
      script: source,
    });
    await waitForFinished(original.runId);
    unregisterLiveWorkflow(original.runId);
    const journalPath = `${process.env.OPENSESSION_WORKFLOWS_DIR}/${original.runId}/journal.jsonl`;
    const entries = readFileSync(journalPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.operation !== "wait");
    writeFileSync(
      journalPath,
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    const deadline = Date.now() + 1_000;
    updateWorkflowRun(original.runId, (snapshot) => {
      snapshot.status = "interrupted";
      snapshot.endedAt = new Date().toISOString();
      snapshot.sessionWaits = [
        {
          seq: 1,
          sessionId: "child-1",
          until: "pr_checks_passed",
          startedAt: new Date(Date.now() - 1_000).toISOString(),
          deadlineAt: new Date(deadline).toISOString(),
        },
      ];
    });

    const recoveredSessions = fakeSessionController();
    let recoveredTimeout = Infinity;
    const normalWait = recoveredSessions.wait.bind(recoveredSessions);
    recoveredSessions.wait = async (id, opts, signal) => {
      recoveredTimeout = opts.timeout ?? Infinity;
      return normalWait(id, opts, signal);
    };
    const recoveredId = await recoverWorkflow(original.runId, {
      executor: echoExecutor(),
      sessionController: recoveredSessions,
      inProcessMcp: () => ({}),
    });
    expect(recoveredId).toBeTruthy();
    expect((await waitForFinished(recoveredId!)).status).toBe("done");
    expect(recoveredSessions.spawnCalls).toBe(0);
    expect(recoveredTimeout).toBeLessThanOrEqual(1_000);
    expect(getWorkflowRun(recoveredId!)?.sessions?.[0]).toMatchObject({
      reservedTokens: 10_000,
      reservedCostUsd: 2,
    });
  });

  test("reordered recovered waits keep and clear their request-key deadlines", async () => {
    const sessions = fakeSessionController();
    const source = (first: string, second: string) =>
      [
        'export const meta = { name: "wait-reorder" };',
        'const a = await spawnSession({ prompt: "a", repo: "renderer", branch: "a" });',
        'const b = await spawnSession({ prompt: "b", repo: "renderer", branch: "b" });',
        "return await Promise.all([",
        `  waitSession(${first}.id, { until: "done", timeout: 60000 }),`,
        `  waitSession(${second}.id, { until: "done", timeout: 60000 }),`,
        "]);",
      ].join("\n");
    const original = start({
      executor: echoExecutor(),
      sessionController: sessions,
      script: source("a", "b"),
    });
    await waitForFinished(original.runId);
    const waitEntries = readWorkflowJournal(original.runId)
      .filter(isSessionJournalEntry)
      .filter((entry) => entry.operation === "wait");
    const journalPath = `${process.env.OPENSESSION_WORKFLOWS_DIR}/${original.runId}/journal.jsonl`;
    const retained = readWorkflowJournal(original.runId).filter(
      (entry) => !(entry.kind === "session" && entry.operation === "wait"),
    );
    writeFileSync(
      journalPath,
      `${retained.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    const deadlines = [Date.now() + 1_000, Date.now() + 4_000];
    updateWorkflowRun(original.runId, (snapshot) => {
      snapshot.status = "interrupted";
      snapshot.endedAt = new Date().toISOString();
      snapshot.sessionWaits = waitEntries.map((entry, index) => ({
        seq: entry.seq,
        requestKey: entry.requestKey,
        sessionId: index === 0 ? "child-1" : "child-2",
        until: "done",
        startedAt: new Date().toISOString(),
        deadlineAt: new Date(deadlines[index]).toISOString(),
      }));
    });
    writeFileSync(
      `${process.env.OPENSESSION_WORKFLOWS_DIR}/${original.runId}/script.mjs`,
      source("b", "a"),
    );
    const observed = new Map<string, number>();
    sessions.wait = async (id, opts) => {
      observed.set(id, opts.timeout || 0);
      return { ...(await sessions.status(id)), status: "done" };
    };
    const recoveredId = await recoverWorkflow(original.runId, {
      executor: echoExecutor(),
      sessionController: sessions,
      inProcessMcp: () => ({}),
    });
    const recovered = await waitForFinished(recoveredId!);
    expect(recovered.status).toBe("done");
    expect(observed.get("child-1")!).toBeLessThan(observed.get("child-2")!);
    expect(recovered.sessionWaits).toEqual([]);
  });

  test("spawn request identity survives concurrent reorder across the crash window", async () => {
    const sessions = fakeSessionController();
    const physicalSpawn = sessions.spawn.bind(sessions);
    const created = new Map<string, WorkflowSpawnedSession>();
    let blockAfterCreate = true;
    sessions.spawn = async (opts, requestId) => {
      const existing = created.get(requestId);
      if (existing) return existing;
      const child = await physicalSpawn(opts, requestId);
      created.set(requestId, child);
      if (blockAfterCreate) await new Promise(() => {});
      return child;
    };
    const source = (first: string, second: string) =>
      [
        'export const meta = { name: "crash-window" };',
        "return await Promise.all([",
        `  spawnSession({ prompt: "${first}", repo: "renderer", branch: "${first}" }),`,
        `  spawnSession({ prompt: "${second}", repo: "renderer", branch: "${second}" }),`,
        "]);",
      ].join("\n");
    const original = start({
      executor: echoExecutor(),
      sessionController: sessions,
      script: source("alpha", "beta"),
    });
    await waitUntil(() => created.size === 2);
    expect(cancelWorkflow(original.runId)).toBe(true);
    await waitForFinished(original.runId);
    unregisterLiveWorkflow(original.runId);
    writeFileSync(
      `${process.env.OPENSESSION_WORKFLOWS_DIR}/${original.runId}/script.mjs`,
      source("beta", "alpha"),
    );
    updateWorkflowRun(original.runId, (snapshot) => {
      snapshot.status = "interrupted";
      snapshot.endedAt = new Date().toISOString();
    });
    blockAfterCreate = false;
    const recoveredId = await recoverWorkflow(original.runId, {
      executor: echoExecutor(),
      sessionController: sessions,
      inProcessMcp: () => ({}),
    });
    expect((await waitForFinished(recoveredId!)).status).toBe("done");
    expect(created.size).toBe(2);
    expect(sessions.spawnCalls).toBe(2);
  });

  test("recovery adopts a pre-journal spawn row without reserving twice", async () => {
    const sessions = fakeSessionController();
    const source = [
      'export const meta = { name: "row-crash" };',
      'return await spawnSession({ prompt: "one", repo: "renderer" });',
    ].join("\n");
    const original = start({
      executor: echoExecutor(),
      sessionController: sessions,
      script: source,
      sessionLimits: { maxTokens: 10_000, maxCostUsd: 1 },
    });
    await waitForFinished(original.runId);
    const journalPath = `${process.env.OPENSESSION_WORKFLOWS_DIR}/${original.runId}/journal.jsonl`;
    writeFileSync(journalPath, "");
    updateWorkflowRun(original.runId, (snapshot) => {
      snapshot.status = "interrupted";
      snapshot.endedAt = new Date().toISOString();
    });
    const recoveredId = await recoverWorkflow(original.runId, {
      executor: echoExecutor(),
      sessionController: sessions,
      inProcessMcp: () => ({}),
    });
    expect((await waitForFinished(recoveredId!)).status).toBe("done");
    expect(sessions.spawnCalls).toBe(1);
    expect(getWorkflowRun(recoveredId!)?.sessions).toHaveLength(1);
  });

  test("a failed late-child cancel remains durable and retries on recovery", async () => {
    const sessions = fakeSessionController();
    const physicalSpawn = sessions.spawn.bind(sessions);
    const release = deferred<void>();
    let spawnStarted = false;
    sessions.spawn = async (opts, requestId) => {
      spawnStarted = true;
      await release.promise;
      return physicalSpawn(opts, requestId);
    };
    let failCancel = true;
    const physicalCancel = sessions.cancel.bind(sessions);
    sessions.cancel = async (id, requestId) => {
      if (failCancel) throw new Error("temporary cancel failure");
      return physicalCancel(id, requestId);
    };
    const source = [
      'export const meta = { name: "cancel-recovery" };',
      'return await spawnSession({ prompt: "one", repo: "renderer" });',
    ].join("\n");
    const original = start({
      executor: echoExecutor(),
      sessionController: sessions,
      script: source,
    });
    await waitUntil(() => spawnStarted);
    cancelWorkflow(original.runId);
    release.resolve();
    await waitUntil(
      () => getWorkflowRun(original.runId)?.sessions?.[0]?.cancelPending,
    );
    expect(getWorkflowRun(original.runId)?.status).toBe("cancelled");
    markInterruptedWorkflows();
    expect(getWorkflowRun(original.runId)?.status).toBe("interrupted");
    failCancel = false;
    const recoveredId = await recoverWorkflow(original.runId, {
      executor: echoExecutor(),
      sessionController: sessions,
      inProcessMcp: () => ({}),
    });
    await waitForFinished(recoveredId!);
    expect(sessions.cancelCalls).toEqual(["child-1"]);
    expect(getWorkflowRun(recoveredId!)?.sessions?.[0]?.cancelPending).toBe(
      false,
    );
  });

  test("explicit workflow cancellation propagates to active children", async () => {
    const sessions = fakeSessionController();
    const gate = deferred<WorkflowAgentOutcome>();
    const { runId } = start({
      executor: fakeExecutor(() => gate.promise),
      sessionController: sessions,
      script: [
        'export const meta = { name: "cancel-children" };',
        'await spawnSession({ prompt: "one", repo: "renderer", branch: "one" });',
        'await agent("hold");',
      ].join("\n"),
    });
    await waitUntil(() => sessions.spawnCalls === 1);
    expect(cancelWorkflow(runId)).toBe(true);
    await waitForFinished(runId);
    await waitUntil(() => sessions.cancelActiveCalls.length === 1);
    expect(sessions.cancelActiveCalls[0]).toContain(`workflow:${runId}:cancel`);
    gate.resolve({ ok: false, error: "cancelled" });
  });

  test("persists external waits until their event resolves", async () => {
    const sessions = fakeSessionController();
    const wait = deferred<WorkflowSessionStatus>();
    sessions.wait = async () => wait.promise;
    const run = start({
      executor: echoExecutor(),
      sessionController: sessions,
      script: [
        'export const meta = { name: "durable-wait" };',
        'const child = await spawnSession({ prompt: "one", repo: "renderer" });',
        'return await waitSession(child.id, { until: "pr_checks_passed", timeout: 10000 });',
      ].join("\n"),
    });
    await waitUntil(() =>
      Boolean(getWorkflowRun(run.runId)?.sessionWaits?.length),
    );
    expect(getWorkflowRun(run.runId)?.sessionWaits?.[0]).toMatchObject({
      sessionId: "child-1",
      until: "pr_checks_passed",
    });
    wait.resolve({
      ...(await sessions.status("child-1")),
      status: "done",
      prChecks: { total: 2, passed: 2, failed: 0, pending: 0 },
    });
    expect((await waitForFinished(run.runId)).sessionWaits).toEqual([]);
  });

  test("scoped CAS and refill/retry use journaled calls", async () => {
    const sessions = fakeSessionController();
    const normalWait = sessions.wait.bind(sessions);
    let failedOnce = false;
    sessions.wait = async (id, opts, signal) => {
      if (!failedOnce) {
        failedOnce = true;
        throw Object.assign(new Error("transient child failure"), {
          retryable: true,
        });
      }
      return normalWait(id, opts, signal);
    };
    const run = start({
      executor: echoExecutor(),
      sessionController: sessions,
      sessionLimits: { maxConcurrent: 1, maxSessions: 3 },
      script: [
        'export const meta = { name: "reconcile" };',
        'const initial = await workflowState.get("cursor");',
        "const claims = await Promise.all([",
        '  workflowState.compareAndSet("cursor", initial.version, { owner: "a", next: 3 }),',
        '  workflowState.compareAndSet("cursor", initial.version, { owner: "b", next: 3 }),',
        "]);",
        "const rows = await reconcileSessions([",
        '  { prompt: "one", repo: "renderer", branch: "one" },',
        '  { prompt: "two", repo: "renderer", branch: "two" },',
        '  { prompt: "three", repo: "renderer", branch: "three" },',
        '], { concurrency: 1, retry: { attempts: 1, message: "Retry transient failure" } });',
        "return { winners: claims.filter((claim) => claim.swapped).length, count: rows.length };",
      ].join("\n"),
    });
    const snap = await waitForFinished(run.runId);
    expect(snap.status).toBe("done");
    expect(snap.result).toMatchObject({ winners: 1, count: 3 });
    expect(sessions.spawnCalls).toBe(3);
    expect(sessions.sendCalls).toEqual([
      { id: "child-1", message: "Retry transient failure" },
    ]);
    expect(
      readWorkflowJournal(run.runId).some(
        (entry) =>
          entry.kind === "session" &&
          entry.operation === "wait" &&
          !entry.ok &&
          entry.retryable === true,
      ),
    ).toBe(true);

    const replaySessions = fakeSessionController();
    const replay = start({
      executor: echoExecutor(),
      sessionController: replaySessions,
      script: readWorkflowScript(run.runId)!,
      resumeFromRunId: run.runId,
      sessionLimits: { maxConcurrent: 1, maxSessions: 3 },
    });
    expect((await waitForFinished(replay.runId)).status).toBe("done");
    expect(replaySessions.spawnCalls).toBe(0);
  });

  test("explicit cancellation drains and cancels a late spawn", async () => {
    const sessions = fakeSessionController();
    const physicalSpawn = sessions.spawn.bind(sessions);
    const release = deferred<void>();
    let spawnStarted = false;
    sessions.spawn = async (opts, requestId) => {
      spawnStarted = true;
      await release.promise;
      return physicalSpawn(opts, requestId);
    };
    const run = start({
      executor: echoExecutor(),
      sessionController: sessions,
      script: [
        'export const meta = { name: "late-cancel" };',
        'await spawnSession({ prompt: "one", repo: "renderer" });',
      ].join("\n"),
    });
    await waitUntil(() => spawnStarted);
    expect(cancelWorkflow(run.runId)).toBe(true);
    release.resolve();
    await waitUntil(() => sessions.cancelCalls.length === 1);
    expect(sessions.cancelCalls).toEqual(["child-1"]);
  });

  test("reconcile validates retry bounds before spawning", async () => {
    const sessions = fakeSessionController();
    const run = start({
      executor: echoExecutor(),
      sessionController: sessions,
      script: [
        'export const meta = { name: "retry-bounds" };',
        'await reconcileSessions([{ prompt: "one", repo: "renderer" }], { retry: { attempts: 4, message: "retry" } });',
      ].join("\n"),
    });
    expect((await waitForFinished(run.runId)).error).toContain(
      "integer from 0 to 3",
    );
    expect(sessions.spawnCalls).toBe(0);
  });

  test("reconcile drains delayed sibling lanes before surfacing failure", async () => {
    const sessions = fakeSessionController();
    const physicalSpawn = sessions.spawn.bind(sessions);
    const delayed = deferred<void>();
    let entered = 0;
    sessions.spawn = async (opts, requestId) => {
      entered++;
      if (opts.branch === "slow") await delayed.promise;
      return physicalSpawn(opts, requestId);
    };
    const normalWait = sessions.wait.bind(sessions);
    sessions.wait = async (id, opts, signal) => {
      const current = await sessions.status(id);
      if (current.branch === "fail") throw new Error("policy denied");
      return normalWait(id, opts, signal);
    };
    const run = start({
      executor: echoExecutor(),
      sessionController: sessions,
      sessionLimits: { maxConcurrent: 2 },
      script: [
        'export const meta = { name: "drain-reconcile" };',
        "await reconcileSessions([",
        '  { prompt: "fail", repo: "renderer", branch: "fail" },',
        '  { prompt: "slow", repo: "renderer", branch: "slow" },',
        '], { concurrency: 2, retry: { attempts: 1, message: "retry" } });',
      ].join("\n"),
    });
    await waitUntil(() => entered === 2);
    await Bun.sleep(20);
    expect(getWorkflowRun(run.runId)?.status).toBe("running");
    delayed.resolve();
    const snap = await waitForFinished(run.runId);
    expect(snap.error).toContain("policy denied");
    expect(snap.sessions).toHaveLength(2);
    expect(sessions.sendCalls).toEqual([]);
  });

  test("caps workflow state calls per run", async () => {
    const run = start({
      executor: echoExecutor(),
      sessionController: fakeSessionController(),
      script: [
        'export const meta = { name: "state-cap" };',
        "let failure = '';",
        `for (let i = 0; i <= ${WORKFLOW_LIMITS.maxStateCalls}; i++) {`,
        "  try { await workflowState.get('cursor'); } catch (error) { failure = error.message; break; }",
        "}",
        "return failure;",
      ].join("\n"),
    });
    expect((await waitForFinished(run.runId)).result).toContain(
      "state call limit reached",
    );
  });

  test("server admission supplies a conservative floor when caller omits it", async () => {
    const sessions = fakeSessionController();
    const run = start({
      executor: echoExecutor(),
      sessionController: sessions,
      sessionLimits: {
        maxConcurrent: 1,
        maxSessions: 1,
        maxTokens: 100_000,
        maxCostUsd: 10,
      },
      script: [
        'export const meta = { name: "reservation-floor" };',
        'return await spawnSession({ prompt: "one", repo: "renderer" });',
      ].join("\n"),
    });
    expect((await waitForFinished(run.runId)).status).toBe("done");
    expect(sessions.spawnAdmissions).toEqual([{ tokens: 10_000, costUsd: 1 }]);
  });

  test("active-session and lifetime limits reject excess spawns", async () => {
    const active = fakeSessionController();
    const activeRun = start({
      executor: echoExecutor(),
      sessionController: active,
      sessionLimits: { maxConcurrent: 1, maxSessions: 2 },
      script: [
        'export const meta = { name: "limit" };',
        "const results = await Promise.allSettled([",
        '  spawnSession({ prompt: "one", repo: "renderer", branch: "one" }),',
        '  spawnSession({ prompt: "two", repo: "renderer", branch: "two" }),',
        "]);",
        'const failed = results.find((result) => result.status === "rejected");',
        "if (failed) throw failed.reason;",
      ].join("\n"),
    });
    expect((await waitForFinished(activeRun.runId)).error).toContain(
      "Active nested session cap reached",
    );
    expect(active.spawnCalls).toBe(1);

    const lifetime = fakeSessionController();
    const lifetimeRun = start({
      executor: echoExecutor(),
      sessionController: lifetime,
      sessionLimits: { maxConcurrent: 3, maxSessions: 1 },
      script: [
        'export const meta = { name: "limit" };',
        'const one = await spawnSession({ prompt: "one", repo: "renderer", branch: "one" });',
        'await waitSession(one.id, { until: "done" });',
        'await spawnSession({ prompt: "two", repo: "renderer", branch: "two" });',
      ].join("\n"),
    });
    expect((await waitForFinished(lifetimeRun.runId)).error).toContain(
      "Nested session cap reached",
    );
    expect(lifetime.spawnCalls).toBe(1);

    const budgeted = fakeSessionController();
    const status = budgeted.status.bind(budgeted);
    budgeted.status = async (id) => ({
      ...(await status(id)),
      tokens: 101,
      costUsd: 1,
    });
    const budgetRun = start({
      executor: echoExecutor(),
      sessionController: budgeted,
      sessionLimits: {
        maxConcurrent: 3,
        maxSessions: 3,
        maxTokens: 100,
      },
      script: [
        'export const meta = { name: "budget" };',
        'const one = await spawnSession({ prompt: "one", repo: "renderer", branch: "one" });',
        'await waitSession(one.id, { until: "done" });',
        'await spawnSession({ prompt: "two", repo: "renderer", branch: "two" });',
      ].join("\n"),
    });
    expect((await waitForFinished(budgetRun.runId)).error).toContain(
      "token budget exceeded",
    );
    expect(budgeted.spawnCalls).toBe(1);

    const admission = fakeSessionController();
    const admissionRun = start({
      executor: echoExecutor(),
      sessionController: admission,
      sessionLimits: { maxTokens: 100, maxCostUsd: 5 },
      script: [
        'export const meta = { name: "admission" };',
        'await spawnSession({ prompt: "too large", repo: "renderer", admission: { tokens: 101, costUsd: 1 } });',
      ].join("\n"),
    });
    expect((await waitForFinished(admissionRun.runId)).error).toContain(
      "token admission exceeds",
    );
    expect(admission.spawnCalls).toBe(0);

    const racing = fakeSessionController();
    const physicalRaceSpawn = racing.spawn.bind(racing);
    const raceGate = deferred<void>();
    let raceEntered = 0;
    racing.spawn = async (opts, requestId) => {
      raceEntered++;
      await raceGate.promise;
      return physicalRaceSpawn(opts, requestId);
    };
    const raceRun = start({
      executor: echoExecutor(),
      sessionController: racing,
      sessionLimits: { maxConcurrent: 3, maxTokens: 100 },
      script: [
        'export const meta = { name: "admission-race" };',
        "const rows = await Promise.allSettled([",
        '  spawnSession({ prompt: "one", repo: "renderer", admission: { tokens: 60 } }),',
        '  spawnSession({ prompt: "two", repo: "renderer", admission: { tokens: 60 } }),',
        "]);",
        'const failed = rows.find((row) => row.status === "rejected");',
        "if (failed) throw failed.reason;",
      ].join("\n"),
    });
    await waitUntil(() => raceEntered === 1);
    raceGate.resolve();
    expect((await waitForFinished(raceRun.runId)).error).toContain(
      "token admission exceeds",
    );
    expect(raceEntered).toBe(1);

    const refill = fakeSessionController();
    const refillWait = refill.wait.bind(refill);
    refill.wait = async (id, opts, signal) => ({
      ...(await refillWait(id, opts, signal)),
      status: "done",
      tokens: 10,
      costUsd: 0.1,
    });
    const refillRun = start({
      executor: echoExecutor(),
      sessionController: refill,
      sessionLimits: { maxConcurrent: 1, maxTokens: 100, maxCostUsd: 2 },
      script: [
        'export const meta = { name: "budget-refill" };',
        'const one = await spawnSession({ prompt: "one", repo: "renderer", admission: { tokens: 80, costUsd: 1 } });',
        'await waitSession(one.id, { until: "done" });',
        'await spawnSession({ prompt: "two", repo: "renderer", admission: { tokens: 80, costUsd: 1 } });',
      ].join("\n"),
    });
    expect((await waitForFinished(refillRun.runId)).status).toBe("done");
    expect(refill.spawnCalls).toBe(2);
  });
});
