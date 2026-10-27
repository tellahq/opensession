/**
 * Fixed-subscription sessions on the fake engine: the run gets a hard pin with
 * no usage credits and no model fallback, a disconnected account stops the
 * turn before any engine call, and the session's account and provider cannot
 * be changed afterwards. Same isolation pattern as zz-fake-run.test.ts (run
 * this file directly for full coverage).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";

const tmp = mkdtempSync(`${tmpdir()}/zz-fixed-subscription-`);
// The Claude account store is read at import: point it at a temp file first.
const claudeStore = `${tmp}/claude-accounts.json`;
writeFileSync(
  claudeStore,
  JSON.stringify({
    accounts: ["team", "spare"].map((id) => ({
      id,
      name: id,
      token: `sk-ant-oat01-${id}`,
      createdAt: "2026-01-01T00:00:00.000Z",
    })),
  }),
);
const previousClaudeStore = process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH;
process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH = claudeStore;

// Loaded dynamically in beforeAll — see header.
let runSession: typeof import("./run-session");
let agentRunner: typeof import("./agent-runner");
let sessionCache: typeof import("./session-cache");
let slashCommands: typeof import("./slash-commands");
let runState: typeof import("./run-state");
let queueState: typeof import("./queue-state");
let fakeEngineMod: typeof import("./testing/fake-engine");
let ocTranscript: typeof import("./transcript-persistence");
let transcriptStoreMod: typeof import("./transcript-store");
let memoryV2: typeof import("./memory-v2/runtime");
let testSessionListStore:
  | import("./session-list-store").SessionListStore
  | null = null;
let restoreSessionListStore: (() => void) | null = null;
let restoreSessionsDir: (() => void) | null = null;
let restoreJournal: (() => void) | null = null;
let redirected = false;
const previousPiDetach = process.env.OPENSESSION_PI_DETACH;
const previousMemoryDb = process.env.OPENSESSION_MEMORY_DB;
const previousTestInProcessRuns = process.env.OPENSESSION_TEST_IN_PROCESS_RUNS;

function writeSessionFile(id: string, extra: Record<string, unknown> = {}) {
  writeFileSync(
    `${tmp}/${id}.json`,
    JSON.stringify({
      id,
      source: "opensession",
      title: `Fake run ${id}`,
      model: "claude-sonnet-5",
      createdBy: "Test",
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      ...extra,
    }),
  );
}

beforeAll(async () => {
  process.env.OPENSESSION_PI_DETACH = "0";
  process.env.OPENSESSION_TEST_IN_PROCESS_RUNS = "1";
  process.env.OPENSESSION_MEMORY_DB = `${tmp}/memory-v2.sqlite`;
  (globalThis as any).__opensessionBooted = true;
  const paths = await import("./paths");
  const prevDir = paths.__setSessionsDirForTest(tmp);
  restoreSessionsDir = () => paths.__setSessionsDirForTest(prevDir);
  const sessionListStoreMod = await import("./session-list-store");
  testSessionListStore = new sessionListStoreMod.SessionListStore(
    `${tmp}/session-list.sqlite`,
  );
  const previousSessionListStore =
    sessionListStoreMod.__setSessionListStoreForTest(testSessionListStore);
  restoreSessionListStore = () =>
    sessionListStoreMod.__setSessionListStoreForTest(previousSessionListStore);
  // Queue drains read the catalog for running children. Start with complete
  // empty coverage; subsequent session writes publish their individual rows.
  await sessionListStoreMod.upsertIndexedSessions([], "include");
  const runJournal = await import("./run-journal");
  const prevJournal = runJournal.__setActiveRunsPathForTest(
    `${tmp}/active-runs.json`,
  );
  restoreJournal = () => runJournal.__setActiveRunsPathForTest(prevJournal);

  runSession = await import("./run-session");
  agentRunner = await import("./agent-runner");
  sessionCache = await import("./session-cache");
  slashCommands = await import("./slash-commands");
  runState = await import("./run-state");
  queueState = await import("./queue-state");
  fakeEngineMod = await import("./testing/fake-engine");
  ocTranscript = await import("./transcript-persistence");
  transcriptStoreMod = await import("./transcript-store");
  memoryV2 = await import("./memory-v2/runtime");
  memoryV2.closeMemoryRuntime();

  // Redirect probe: a session file written to our temp dir must be visible
  // through findSession, or earlier suite files froze the store elsewhere.
  writeSessionFile("bks-zz-probe");
  sessionCache.invalidateSessionsCache();
  redirected = !!sessionCache.findSession("bks-zz-probe");
  if (!redirected) {
    console.warn(
      "[zz-fixed-subscription-run] sessions-dir redirect didn't take (module cache already " +
        "warm from earlier test files) — skipping; run this file directly.",
    );
  }
});

afterAll(() => {
  if (previousPiDetach === undefined) delete process.env.OPENSESSION_PI_DETACH;
  else process.env.OPENSESSION_PI_DETACH = previousPiDetach;
  if (previousTestInProcessRuns === undefined)
    delete process.env.OPENSESSION_TEST_IN_PROCESS_RUNS;
  else process.env.OPENSESSION_TEST_IN_PROCESS_RUNS = previousTestInProcessRuns;
  memoryV2?.closeMemoryRuntime();
  if (previousMemoryDb === undefined) delete process.env.OPENSESSION_MEMORY_DB;
  else process.env.OPENSESSION_MEMORY_DB = previousMemoryDb;
  agentRunner?.__setEngineForTest(null);
  restoreJournal?.();
  restoreSessionsDir?.();
  restoreSessionListStore?.();
  testSessionListStore?.close();
  sessionCache?.invalidateSessionsCache();
  if (previousClaudeStore === undefined)
    delete process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH;
  else process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH = previousClaudeStore;
});

const sessionJson = (id: string) =>
  JSON.parse(readFileSync(`${tmp}/${id}.json`, "utf-8"));

async function waitForLastRunError(id: string): Promise<{ message: string }> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const error = sessionJson(id).lastRunError;
    if (error?.message) return error;
    await Bun.sleep(10);
  }
  throw new Error(`lastRunError was not persisted for ${id}`);
}

const MODEL = "pi/anthropic/claude-opus-5-5";
const fixed = { model: MODEL, accountId: "team", subscriptionPolicy: "fixed" };

describe("fixed-subscription session runs", () => {
  test("a usage limit stops the turn on the pinned account", async () => {
    if (!redirected) return;
    const sid = "bks-zz-fixed-exhausted";
    writeSessionFile(sid, fixed);
    sessionCache.invalidateSessionsCache();
    const fake = fakeEngineMod.makeFakeEngine([
      { kind: "usage_exhausted" },
      { kind: "clean", text: ["must not run"] },
    ]);
    agentRunner.__setEngineForTest(fake.engine);
    await runSession.runSessionPromptAndDrain(sid, "keep going", "Robin");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].model).toBe(MODEL);
    expect(fake.calls[0].opts.accountId).toBe("team");
    expect(fake.calls[0].opts.accountStrict).toBe(true);
    expect(fake.calls[0].opts.usageCredits).toBe(false);
    expect(fake.calls[0].opts.fallbackModel).toBe("none");
    expect(sessionJson(sid).model).toBe(MODEL);
    expect(sessionJson(sid).accountId).toBe("team");
  });

  test("an unmanaged session keeps its soft pin and fallback", async () => {
    if (!redirected) return;
    const sid = "bks-zz-unmanaged-pin";
    writeSessionFile(sid, { model: MODEL, accountId: "team" });
    sessionCache.invalidateSessionsCache();
    const fake = fakeEngineMod.makeFakeEngine([
      { kind: "clean", text: ["ok"] },
    ]);
    agentRunner.__setEngineForTest(fake.engine);
    await runSession.runSessionPromptAndDrain(sid, "hello", "Robin");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].opts.accountId).toBe("team");
    expect(fake.calls[0].opts.accountStrict).toBeUndefined();
    expect(fake.calls[0].opts.fallbackModel).not.toBe("none");
  });

  test("a disconnected funding account stops the turn before the engine", async () => {
    if (!redirected) return;
    const sid = "bks-zz-fixed-disconnected";
    writeSessionFile(sid, { ...fixed, accountId: "removed-account" });
    sessionCache.invalidateSessionsCache();
    const fake = fakeEngineMod.makeFakeEngine([
      { kind: "clean", text: ["must not run"] },
    ]);
    agentRunner.__setEngineForTest(fake.engine);
    await runSession
      .runSessionPromptAndDrain(sid, "hello", "Robin")
      .catch(() => {});
    expect(fake.calls).toHaveLength(0);
    expect((await waitForLastRunError(sid)).message).toContain(
      "no longer connected",
    );
  });

  test("the account and provider cannot be changed afterwards", async () => {
    if (!redirected) return;
    const sid = "bks-zz-fixed-immutable";
    writeSessionFile(sid, fixed);
    sessionCache.invalidateSessionsCache();
    const session = sessionCache.findSession(sid)!;
    for (const command of ["/account spare", "/account auto", "/sub spare"]) {
      expect(
        await slashCommands.handleSlashCommand(session, command, "Robin"),
      ).toContain("fixed subscription");
    }
    expect(
      await slashCommands.handleSlashCommand(
        session,
        "/model pi/openai/gpt-6.1-sol",
        "Robin",
      ),
    ).toContain("fixed subscription");
    await sessionCache.updateSessionFile(sid, (data) => data);
    expect(sessionJson(sid).accountId).toBe("team");
    expect(sessionJson(sid).model).toBe(MODEL);
    expect(sessionJson(sid).subscriptionPolicy).toBe("fixed");
  });
});
