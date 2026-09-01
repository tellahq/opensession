/**
 * The keyless snapshot harness: drive a scripted session through the REAL run
 * pipeline (run-session → agent-runner → the event loop → the transcript
 * store) with a fake engine at the seam, then freeze what it wrote and what it
 * sent. No API key, no network, no engine subprocess. See snapshot.ts for the
 * record/compare half and docs/transcript-snapshots.md for the workflow.
 *
 * Everything the pipeline would otherwise read off this machine is redirected
 * into a temp directory first: the sessions dir, the transcript store, the run
 * journal, the engine→unified map, the MCP config, and the memory store. That
 * last one matters twice over: an un-redirected memory store would both make
 * fixtures machine-specific AND commit the team's real memories into the repo,
 * since the injected memory note is persisted into the transcript.
 *
 * Two ordering rules the setup depends on:
 *
 *  - `prepareSnapshotEnv()` runs at MODULE TOP LEVEL of the test file, before
 *    any import of the server graph, because connections.ts freezes the MCP
 *    config path into a module const at import time.
 *  - `loadSnapshotHarness()` runs in `beforeAll`, and does the imports itself
 *    (the zz- convention: run-session pulls in interactive-mcp, so it must not
 *    load before NODE_ENV=test and the redirects are in effect).
 *
 * A full-suite run can still lose the race: an earlier test file may already
 * have frozen these module consts against the real store. The harness detects
 * that (`ready`) and the scenarios skip rather than snapshot this box's real
 * data. Run the file directly for full coverage.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { FakeCall, FakeTurn } from "./fake-engine";
import { Normalizer, expectSnapshot } from "./snapshot";
// NOTE: snapshot-views is imported dynamically in loadSnapshotHarness, never
// here. It reaches pi-policy → runner-shared → connections, which
// freezes the MCP config path into a module const the moment it loads. A
// static import would do that BEFORE prepareSnapshotEnv() sets the env, and
// every scenario would then project this box's real MCP servers.

export interface SnapshotDirs {
  root: string;
  state: string;
  sessions: string;
  automations: string;
  memory: string;
  mcpConfig: string;
}

/** The automation a scenario can point a session at. Its allowlist is what
 *  scopes an automation-owned run's MCP surface (automations.ts resolves it by
 *  display name off the session's `automation` field). */
export const FIXTURE_AUTOMATION = {
  id: "snapshot-automation",
  name: "Snapshot Automation",
  prompt: "Check the fixture and report.",
  schedule: "0 9 * * *",
  enabled: false,
  mode: "ask",
  mcpServers: ["snapshot-alpha", "snapshot-restricted"],
  createdBy: "SnapshotOwner",
  createdAt: "2026-01-01T00:00:00.000Z",
};

/** The MCP servers every scenario sees. Deliberately synthetic names: no real
 *  OAuth grant or credential overlay can attach to them, so the projection is
 *  the same on every machine. `snapshot-restricted` carries an `allowedUsers`
 *  list that no scenario user matches: the per-user visibility gate. */
export const FIXTURE_MCP_SERVERS = {
  "snapshot-alpha": { command: "/bin/true", args: ["--alpha"] },
  "snapshot-beta": { type: "http", url: "https://beta.invalid/mcp" },
  "snapshot-restricted": {
    command: "/bin/true",
    args: ["--restricted"],
    allowedUsers: ["Nobody In This Test"],
  },
};

let dirs: SnapshotDirs | null = null;

/** Call at module top level, before importing anything from ../. */
export function prepareSnapshotEnv(label: string): SnapshotDirs {
  const root = mkdtempSync(join(tmpdir(), `os-snapshot-${label}-`));
  // A private state root: every `statePath()` store (automations, pins, …)
  // resolves under it instead of this box's home dir. Modules that freeze
  // their dir into a const do it at import time, which is why this has to run
  // before the test file's dynamic imports.
  const state = join(root, "state");
  const sessions = join(state, ".opensession-sessions");
  const automations = join(state, ".opensession-automations");
  const memory = join(root, "memory");
  const mcpConfig = join(root, "mcp-config.json");
  for (const dir of [state, sessions, automations, memory])
    mkdirSync(dir, { recursive: true });
  writeFileSync(
    mcpConfig,
    JSON.stringify({ mcpServers: FIXTURE_MCP_SERVERS }, null, 2),
  );
  writeFileSync(
    join(automations, `${FIXTURE_AUTOMATION.id}.json`),
    JSON.stringify(FIXTURE_AUTOMATION, null, 2),
  );
  prevEnv = {
    state: process.env.OPENSESSION_STATE_DIR,
    sessions: process.env.OPENSESSION_SESSIONS_DIR,
    mcpConfig: process.env.OPENSESSION_MCP_CONFIG,
    piDetach: process.env.OPENSESSION_PI_DETACH,
    testInProcessRuns: process.env.OPENSESSION_TEST_IN_PROCESS_RUNS,
  };
  process.env.OPENSESSION_STATE_DIR = state;
  // The live service exports its production sessions path. Override it before
  // host-client loads, or a snapshot run mixes a scratch state root with the
  // production run-host directory and the fixed helper correctly rejects it.
  process.env.OPENSESSION_SESSIONS_DIR = sessions;
  process.env.OPENSESSION_MCP_CONFIG = mcpConfig;
  process.env.OPENSESSION_PI_DETACH = "0";
  process.env.OPENSESSION_TEST_IN_PROCESS_RUNS = "1";
  dirs = { root, state, sessions, automations, memory, mcpConfig };
  return dirs;
}

let prevEnv: {
  state?: string;
  sessions?: string;
  mcpConfig?: string;
  piDetach?: string;
  testInProcessRuns?: string;
} = {};

function restoreEnv(): void {
  for (const [name, value] of [
    ["OPENSESSION_STATE_DIR", prevEnv.state],
    ["OPENSESSION_SESSIONS_DIR", prevEnv.sessions],
    ["OPENSESSION_MCP_CONFIG", prevEnv.mcpConfig],
    ["OPENSESSION_PI_DETACH", prevEnv.piDetach],
    ["OPENSESSION_TEST_IN_PROCESS_RUNS", prevEnv.testInProcessRuns],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

export interface SnapshotHarness {
  /** False when module state was already frozen elsewhere; scenarios skip. */
  ready: boolean;
  dirs: SnapshotDirs;
  /** Write (or overwrite) a session file and invalidate the list cache. */
  writeSession(id: string, extra?: Record<string, unknown>): void;
  /** Merge fields into an existing session file (a mid-session model switch). */
  patchSession(id: string, extra: Record<string, unknown>): void;
  readSession(id: string): Record<string, unknown>;
  /** Give an engine session a transcript FILE, the way a session that ran
   *  before this process did. A session's `transcriptPath` is derived, never
   *  read off its file, so this is how a scenario gets a sibling with history
   *  (attached-session context reads that path). */
  writeEngineTranscript(
    engineSessionId: string,
    lines: Record<string, unknown>[],
  ): Promise<string>;
  /** Seed a memory scope for the duration of `fn` (its own store dir). */
  withMemory(
    scopes: Record<string, Array<{ id: string; text: string; by: string }>>,
    fn: () => Promise<void>,
  ): Promise<void>;
  /** One prompt through the real pipeline; engine calls land in `collect`. */
  prompt(opts: {
    sessionId: string;
    content: string;
    user?: string;
    turns: FakeTurn[];
    collect: FakeCall[];
    contextSessions?: string[];
  }): Promise<void>;
  /** Freeze the scenario: stored transcript + engine calls + adapter policy. */
  snapshot(name: string, input: { sessionId: string; calls: FakeCall[] }): void;
  restore(): void;
}

export async function loadSnapshotHarness(): Promise<SnapshotHarness> {
  if (!dirs) throw new Error("call prepareSnapshotEnv() at module top level");
  const d = dirs;
  // Module-scope tickers must never arm in a test process.
  (
    globalThis as unknown as { __opensessionBooted?: boolean }
  ).__opensessionBooted = true;

  const paths = await import("../paths");
  const prevSessionsDir = paths.__setSessionsDirForTest(d.sessions);
  const runJournal = await import("../run-journal");
  const prevJournal = runJournal.__setActiveRunsPathForTest(
    join(d.root, "active-runs.json"),
  );
  const transcriptPersistence = await import("../transcript-persistence");
  const prevMapPath = transcriptPersistence.__setEngineSessionMapPathForTest(
    join(d.root, "engine-session-map.json"),
  );
  const memory = await import("../../agents/slack/memory");
  const memoryV2 = await import("../memory-v2/runtime");
  const prevMemoryDir = memory.__setMemoryDirForTest(d.memory);

  const runSession = await import("../run-session");
  const agentRunner = await import("../agent-runner");
  const sessionCache = await import("../session-cache");
  const transcriptStore = await import("../transcript-store");
  const fakeEngine = await import("./fake-engine");
  const views = await import("./snapshot-views");

  const normalizer = new Normalizer()
    .path(d.sessions, "<sessions>")
    .path(d.automations, "<automations>")
    .path(d.memory, "<memory>")
    .path(d.state, "<state>")
    .path(d.root, "<tmp>")
    .path(process.cwd(), "<repo>")
    .path(process.env.HOME, "<home>");

  function invalidate() {
    sessionCache.invalidateSessionsCache();
  }

  function writeSession(id: string, extra: Record<string, unknown> = {}) {
    writeFileSync(
      join(d.sessions, `${id}.json`),
      JSON.stringify(
        {
          id,
          title: `Snapshot ${id}`,
          model: "claude-sonnet-5",
          source: "opensession",
          createdBy: "SnapshotOwner",
          startedBy: "SnapshotOwner",
          createdAt: "2026-01-01T00:00:00.000Z",
          lastActivity: "2026-01-01T00:00:00.000Z",
          ...extra,
        },
        null,
        2,
      ),
    );
    invalidate();
  }

  function readSession(id: string): Record<string, unknown> {
    return JSON.parse(
      require("fs").readFileSync(join(d.sessions, `${id}.json`), "utf-8"),
    );
  }

  // The redirect probe: a session written here must be visible through
  // findSession, or an earlier suite file froze the store somewhere else.
  writeSession("bks-snapshot-probe");
  const ready =
    !!sessionCache.findSession("bks-snapshot-probe") &&
    transcriptStore.transcriptStore().dbPath.startsWith(d.root);
  if (!ready) {
    console.warn(
      "[snapshot-harness] sessions dir / transcript store were already frozen " +
        "elsewhere (module cache warm from earlier test files); skipping. Run " +
        "this file directly for full coverage.",
    );
  }

  return {
    ready,
    dirs: d,
    writeSession,
    readSession,
    patchSession(id, extra) {
      writeSession(id, { ...readSession(id), ...extra });
    },
    async writeEngineTranscript(engineSessionId, lines) {
      const files = require("fs").readdirSync(d.sessions) as string[];
      const owner = files
        .filter((file) => file.endsWith(".json"))
        .map((file) =>
          JSON.parse(
            require("fs").readFileSync(join(d.sessions, file), "utf8"),
          ),
        )
        .find(
          (session) =>
            session.piSessionId === engineSessionId ||
            session.claudeSessionId === engineSessionId ||
            session.codexThreadId === engineSessionId,
        );
      if (!owner?.id)
        throw new Error(`No session owns engine id ${engineSessionId}`);
      const { parseJsonlLines } =
        require("../jsonl-parser") as typeof import("../jsonl-parser");
      await transcriptStore
        .transcriptStore()
        .importLegacyTranscript(
          owner.id,
          parseJsonlLines(lines.map((line) => JSON.stringify(line))),
          "merged",
          null,
        );
      transcriptPersistence.recordEngineSessionOwner(engineSessionId, owner.id);
      return transcriptStore.transcriptStore().dbPath;
    },
    async withMemory(scopes, fn) {
      const dir = mkdtempSync(join(d.root, "memory-"));
      for (const [scope, entries] of Object.entries(scopes))
        writeFileSync(
          join(dir, `${scope}.json`),
          JSON.stringify({
            entries: entries.map((e) => ({
              ...e,
              at: "2026-01-01T00:00:00.000Z",
            })),
          }),
        );
      const prev = memory.__setMemoryDirForTest(dir);
      const prevDb = process.env.OPENSESSION_MEMORY_DB;
      process.env.OPENSESSION_MEMORY_DB = join(dir, "memory-v2.sqlite");
      memoryV2.closeMemoryRuntime();
      normalizer.path(dir, "<memory>");
      try {
        await fn();
      } finally {
        memoryV2.closeMemoryRuntime();
        if (prevDb === undefined) delete process.env.OPENSESSION_MEMORY_DB;
        else process.env.OPENSESSION_MEMORY_DB = prevDb;
        memory.__setMemoryDirForTest(prev);
      }
    },
    async prompt({
      sessionId,
      content,
      user,
      turns,
      collect,
      contextSessions,
    }) {
      const fake = fakeEngine.makeFakeEngine(turns, {
        // A real adapter persists the turn it produced; without this the store
        // would only ever hold user lines (run-session broadcasts, it does not
        // write assistant output).
        persistTranscript: true,
      });
      agentRunner.__setEngineForTest(fake.engine);
      try {
        await runSession.runSessionPromptAndDrain(
          sessionId,
          content,
          user,
          undefined,
          undefined,
          contextSessions,
        );
      } finally {
        agentRunner.__setEngineForTest(null);
      }
      collect.push(...fake.calls);
    },
    snapshot(name, { sessionId, calls }) {
      const entries = transcriptStore
        .transcriptStore()
        .readTail(sessionId, 200).entries;
      expectSnapshot(
        name,
        normalizer.value({
          transcript: views.transcriptView(entries),
          engineCalls: calls.map(views.engineCallView),
          enginePolicy: calls.map(views.enginePolicyView),
        }),
      );
    },
    restore() {
      agentRunner.__setEngineForTest(null);
      memory.__setMemoryDirForTest(prevMemoryDir);
      transcriptPersistence.__setEngineSessionMapPathForTest(prevMapPath);
      runJournal.__setActiveRunsPathForTest(prevJournal);
      paths.__setSessionsDirForTest(prevSessionsDir);
      // Later files in a full-suite run must not inherit the fixture env.
      restoreEnv();
      invalidate();
    },
  };
}
