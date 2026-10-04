import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionKernelStoreHost } from "../packages/core/opensession-server/src/server/session-kernel/store-host";
import { sessionKernelSessionDbPath } from "../packages/core/opensession-server/src/server/session-kernel/store";
import {
  seedSessionMetadataCatalog,
  sessionMetadataCatalogComplete,
  sessionMetadataCatalogPage,
} from "../packages/core/opensession-server/src/server/session-kernel/metadata-store";
import { catalogDocumentImportComplete } from "../packages/core/opensession-server/src/server/session-kernel/catalog-document-store";
import { TranscriptStore } from "../packages/core/opensession-server/src/server/transcript-store";
import {
  DEV_SERVER_PID_FILE,
  REAL_SEED_MARKER,
  assertDevServerStopped,
  assertSeedTargetSafe,
  redactSecrets,
  sanitizeSessionDoc,
  seedDevState,
  type DevServerProbe,
} from "./seed-dev-state";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    chmodTree(root, true);
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "seed-dev-state-"));
  roots.push(root);
  return root;
}

const idleProbe: DevServerProbe = {
  pidAlive: () => false,
  leaseHeld: () => false,
  openBy: () => [],
};

// Synthetic placeholder credentials, shaped like the real thing.
const FAKE_GH_TOKEN = `ghp_${"A1b2C3d4E5".repeat(4)}`;
const FAKE_SLACK_TOKEN = `xoxb-${"1234567890"}-${"abcdefghij"}`;

type Spec = {
  id: string;
  minutesAgo: number;
  archived?: "doc" | "registry";
  noTranscript?: boolean;
};

function iso(minutesAgo: number): string {
  return new Date(
    Date.UTC(2026, 0, 1, 12, 0) - minutesAgo * 60_000,
  ).toISOString();
}

function liveDoc(spec: Spec) {
  return {
    id: spec.id,
    claudeSessionId: "claude-resume-handle",
    piSessionId: "pi-resume-handle",
    branch: `branch-${spec.id}`,
    worktreeDir: `/live/worktrees/${spec.id}`,
    repo: "acme",
    workspaceId: "ws-acme",
    createdBy: "Ada",
    createdAt: iso(spec.minutesAgo + 5),
    lastActivity: iso(spec.minutesAgo),
    title: `Session ${spec.id} token=${FAKE_GH_TOKEN}`,
    mode: "code",
    model: "pi/example/model",
    rev: 3,
    reportBack: true,
    parentSessionId: "os-parent",
    mcpServers: ["acme-admin"],
    goal: "keep going",
    loop: { intervalMs: 60_000 },
    automationId: "auto-1",
    sandbox: { sandboxId: "sbx-1" },
    accountId: "acct-1",
    usage: { costUsd: 1.5, turns: 2 },
    ...(spec.archived === "doc" ? { archived: true } : {}),
  };
}

/** A home-style source state with actor transcripts and actionable state. */
async function buildSource(root: string, specs: Spec[]) {
  const home = join(root, "home");
  const sessionsDir = join(home, ".opensession-sessions");
  const actorRoot = join(sessionsDir, "session-kernel-sessions");
  const centralPath = join(sessionsDir, "session-kernel.sqlite");
  mkdirSync(sessionsDir, { recursive: true });
  const host = new SessionKernelStoreHost(centralPath, actorRoot);
  for (const spec of specs) {
    if (spec.noTranscript) continue;
    // Running turn, a due timer and a pending outbox effect: every one of
    // these would make a dev kernel act on the session if it were copied.
    host.call("setRunState", [
      {
        sessionId: spec.id,
        state: "running",
        event: "prompt",
        currentRunId: "live-run",
      },
    ]);
    host.call("scheduleTimer", [
      {
        sessionId: spec.id,
        timerId: "agent-wait",
        kind: "agent_wait",
        dueAt: 1,
        payload: null,
      },
    ]);
    host.call("enqueueOutbox", [
      spec.id,
      "turn_outcome_project",
      { projectionId: "pending" },
      "pending",
    ]);
  }
  host.close();

  for (const spec of specs) {
    if (spec.noTranscript) continue;
    const actorPath = sessionKernelSessionDbPath(spec.id, actorRoot);
    const transcripts = new TranscriptStore(actorPath, { actorOwned: false });
    await transcripts.appendTranscriptEvents(spec.id, [
      {
        id: `${spec.id}-u1`,
        type: "user",
        timestamp: iso(spec.minutesAgo + 1),
        content: `please deploy with ${FAKE_GH_TOKEN}`,
      },
      {
        id: `${spec.id}-a1`,
        type: "assistant",
        timestamp: iso(spec.minutesAgo),
        content: `done, Authorization: Bearer ${"z".repeat(24)} and ${FAKE_SLACK_TOKEN}`,
      },
    ]);
    transcripts.close();
    const actor = new Database(actorPath);
    actor.run(
      `INSERT INTO session_kernel_metadata
         (session_id, doc, rev, request_id, archived, last_activity_ms, updated_at)
       VALUES (?, ?, 3, 'live', ?, ?, 0)`,
      [
        spec.id,
        JSON.stringify(liveDoc(spec)),
        spec.archived === "doc" ? 1 : 0,
        Date.parse(iso(spec.minutesAgo)),
      ],
    );
    actor.close();
  }

  const central = new Database(centralPath);
  seedSessionMetadataCatalog(
    central,
    specs.map((spec) => ({
      sessionId: spec.id,
      doc: JSON.stringify(liveDoc(spec)),
      rev: 3,
      archived: spec.archived === "doc",
      lastActivityMs: Date.parse(iso(spec.minutesAgo)),
    })),
  );
  central.close();
  writeFileSync(
    join(sessionsDir, "archive-registry.json"),
    JSON.stringify(
      Object.fromEntries(
        specs
          .filter((spec) => spec.archived === "registry")
          .map((spec) => [spec.id, { at: iso(0), reason: "manual" }]),
      ),
    ),
  );
  return { home, sessionsDir };
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    out.push(path);
    if (entry.isDirectory()) walk(path, out);
  }
  return out;
}

/** Path → size, mtime and content hash for every entry under `dir`. */
function fingerprint(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const path of walk(dir)) {
    const stat = statSync(path);
    out[path] = stat.isDirectory()
      ? `dir:${stat.mtimeMs}`
      : `${stat.size}:${stat.mtimeMs}:${new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex")}`;
  }
  return out;
}

function chmodTree(dir: string, writable: boolean): void {
  if (!existsSync(dir)) return;
  for (const path of [dir, ...walk(dir)]) {
    const isDir = statSync(path).isDirectory();
    chmodSync(
      path,
      isDir ? (writable ? 0o755 : 0o555) : writable ? 0o644 : 0o444,
    );
  }
}

const specs: Spec[] = [
  { id: "os-newest", minutesAgo: 1 },
  { id: "os-archived-doc", minutesAgo: 2, archived: "doc" },
  { id: "os-archived-registry", minutesAgo: 3, archived: "registry" },
  { id: "os-second", minutesAgo: 4 },
  { id: "os-no-transcript", minutesAgo: 5, noTranscript: true },
  { id: "os-third", minutesAgo: 6 },
  { id: "os-oldest", minutesAgo: 60 },
];

describe("seed-dev-state", () => {
  test("seeds the newest non-archived sessions from a read-only source and strips actionable state", async () => {
    const root = tempRoot();
    const { home, sessionsDir } = await buildSource(root, specs);
    const target = join(root, "dev", ".dev-state");
    const before = fingerprint(home);
    // Any write attempt against the source now fails outright.
    chmodTree(home, false);
    let summary;
    try {
      summary = await seedDevState({
        from: home,
        to: target,
        sessions: 3,
        force: false,
        liveHome: join(root, "operator-home"),
        env: {},
        probe: idleProbe,
      });
    } finally {
      chmodTree(home, true);
    }
    expect(fingerprint(home)).toEqual(before);

    expect(summary.sourceSessionsDir.endsWith(".opensession-sessions")).toBe(
      true,
    );
    expect(summary.sessionIds).toEqual(["os-newest", "os-second", "os-third"]);
    expect(summary.skipped).toMatchObject({
      archived: 2,
      noTranscript: 1,
      failed: [],
    });
    expect(summary.redacted).toBeGreaterThan(0);
    expect(sessionsDir).toBeTruthy();

    const marker = JSON.parse(
      readFileSync(join(target, REAL_SEED_MARKER), "utf8"),
    );
    expect(marker).toMatchObject({
      version: 1,
      sessions: 3,
      transcriptEvents: 6,
    });
    // No staging or snapshot residue next to or inside the target.
    expect(readdirSync(join(root, "dev"))).toEqual([".dev-state"]);
    expect(existsSync(join(target, ".snapshots"))).toBe(false);

    const targetSessions = join(target, ".opensession-sessions");
    const centralPath = join(targetSessions, "session-kernel.sqlite");
    const central = new Database(centralPath, { readonly: true });
    expect(sessionMetadataCatalogComplete(central)).toBe(true);
    expect(catalogDocumentImportComplete(central, "slack-sessions")).toBe(true);
    expect(catalogDocumentImportComplete(central, "linear-sessions")).toBe(
      true,
    );
    const page = sessionMetadataCatalogPage(central, "", 100);
    expect(page.map((row) => row.sessionId).sort()).toEqual([
      "os-newest",
      "os-second",
      "os-third",
    ]);
    for (const row of page) {
      expect(row.archived).toBe(false);
      expect(row.exportedRev).toBe(row.rev);
      const doc = JSON.parse(row.doc);
      expect(doc).toMatchObject({
        id: row.sessionId,
        claudeSessionId: "",
        worktreeDir: "",
        title: `Session ${row.sessionId} token=[REDACTED]`,
        repo: "acme",
        parentSessionId: "os-parent",
        usage: { costUsd: 1.5, turns: 2 },
      });
      for (const field of [
        "piSessionId",
        "reportBack",
        "mcpServers",
        "goal",
        "loop",
        "automationId",
        "sandbox",
        "accountId",
        "workspaceId",
      ])
        expect(doc).not.toHaveProperty(field);
      expect(
        JSON.parse(
          readFileSync(join(targetSessions, `${row.sessionId}.json`), "utf8"),
        ),
      ).toEqual(doc);
    }
    // Nothing but the catalog, placements and completion marks reached the
    // central store: no outbox routes, quarantine, or run state.
    for (const table of [
      "session_kernel_outbox_routes",
      "session_kernel_outbox",
      "session_kernel_timers",
      "session_kernel_state",
      "session_kernel_quarantine",
      "session_kernel_owner",
    ])
      expect(
        (
          central.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
            n: number;
          }
        ).n,
      ).toBe(0);
    central.close();

    // Actor databases hold the sanitized document and transcript only.
    for (const sessionId of summary.sessionIds) {
      const actor = new Database(
        sessionKernelSessionDbPath(
          sessionId,
          join(targetSessions, "session-kernel-sessions"),
        ),
        { readonly: true },
      );
      const tables = (
        actor
          .query(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
          )
          .all() as Array<{ name: string }>
      ).map((row) => row.name);
      const kept = new Set([
        "session_kernel_metadata",
        "session_kernel_migrations",
        "transcript_sessions",
        "transcript_events",
        "transcript_outline",
        "transcript_blobs",
      ]);
      for (const table of tables) {
        const n = (
          actor.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
            n: number;
          }
        ).n;
        if (!kept.has(table)) expect({ table, n }).toEqual({ table, n: 0 });
      }
      const metadata = actor
        .query("SELECT doc, request_id FROM session_kernel_metadata")
        .all() as Array<{ doc: string; request_id: string }>;
      expect(metadata).toHaveLength(1);
      expect(JSON.parse(metadata[0]!.doc)).not.toHaveProperty("piSessionId");
      const raw = (
        actor.query("SELECT data FROM transcript_events").all() as Array<{
          data: string;
        }>
      )
        .map((row) => row.data)
        .join("\n");
      expect(raw).not.toContain(FAKE_GH_TOKEN);
      expect(raw).not.toContain(FAKE_SLACK_TOKEN);
      expect(raw).not.toContain("z".repeat(24));
      actor.close();
    }

    // The gateway's kernel host routes the seeded sessions to their actor
    // transcripts and finds no work to resume.
    const host = new SessionKernelStoreHost(
      centralPath,
      join(targetSessions, "session-kernel-sessions"),
    );
    try {
      for (const sessionId of summary.sessionIds) {
        expect(host.central.sessionPlacement(sessionId)).toMatchObject({
          placement: "isolated",
          transcriptAuthority: "actor",
          needsScan: false,
        });
        const tail = host.transcript({ op: "tail", sessionId, limit: 10 }) as {
          entries: Array<{ id: string; type: string; content: string }>;
        };
        expect(tail.entries.map((entry) => entry.id)).toEqual([
          `${sessionId}-u1`,
          `${sessionId}-a1`,
        ]);
        expect(tail.entries[0]!.content).toBe("please deploy with [REDACTED]");
        expect(host.storeForSession(sessionId).runState(sessionId).state).toBe(
          "idle",
        );
      }
      const work = host.runtimeCatalogWork(
        Date.now() + 86_400_000,
        ["agent_wait"],
        ["turn_outcome_project"],
        100,
      );
      expect(work.sessionIds).toEqual([]);
      expect(work.timers).toEqual([]);
      expect(work.outbox).toEqual([]);
    } finally {
      host.close();
    }
  });

  test("refuses a non-empty target without --force and a foreign directory even with it", async () => {
    const root = tempRoot();
    const { home } = await buildSource(root, specs.slice(0, 1));
    const base = {
      from: home,
      sessions: 1,
      liveHome: join(root, "operator-home"),
      env: {},
      probe: idleProbe,
    };

    const foreign = join(root, "projects");
    mkdirSync(foreign);
    writeFileSync(join(foreign, "notes.txt"), "keep me");
    await expect(
      seedDevState({ ...base, to: foreign, force: false }),
    ).rejects.toThrow("Pass --force");
    await expect(
      seedDevState({ ...base, to: foreign, force: true }),
    ).rejects.toThrow("does not look like a dev state directory");
    expect(readFileSync(join(foreign, "notes.txt"), "utf8")).toBe("keep me");

    const target = join(root, ".dev-state");
    await seedDevState({ ...base, to: target, force: false });
    await expect(
      seedDevState({ ...base, to: target, force: false }),
    ).rejects.toThrow("Pass --force");
    const reseeded = await seedDevState({ ...base, to: target, force: true });
    expect(reseeded.sessionIds).toEqual(["os-newest"]);
  });

  test("refuses targets that are, contain, or sit inside source or live state", () => {
    const root = tempRoot();
    const home = join(root, "home");
    const source = join(home, ".opensession-sessions");
    const live = join(root, "operator");
    mkdirSync(source, { recursive: true });
    mkdirSync(join(live, ".opensession", "sessions"), { recursive: true });
    const guard =
      (target: string, env: Record<string, string> = {}) =>
      () =>
        assertSeedTargetSafe({
          sourceSessionsDir: source,
          target,
          liveHome: live,
          env,
        });

    expect(guard(source)).toThrow("live or source state");
    expect(guard(home)).toThrow("live or source state");
    expect(guard(root)).toThrow("live or source state");
    expect(guard("/")).toThrow("live or source state");
    expect(guard(join(source, "nested"))).toThrow("inside the session store");
    expect(guard(live)).toThrow("live or source state");
    expect(guard(join(live, ".opensession"))).toThrow("live or source state");
    expect(guard(join(live, ".opensession", "sessions", "x"))).toThrow(
      "inside the session store",
    );
    expect(guard(join(live, ".opensession", "deploy"))).toThrow(
      "live or source state",
    );
    expect(guard(join(live, ".opensession", "deploy", "releases"))).toThrow(
      "inside live state",
    );
    expect(guard(join(live, ".opensession", "automations"))).toThrow(
      "inside live state",
    );
    const custom = join(root, "custom-sessions");
    expect(guard(custom, { OPENSESSION_SESSIONS_DIR: custom })).toThrow(
      "live or source state",
    );
    // A source passed as the sessions directory of the target itself.
    expect(() =>
      assertSeedTargetSafe({
        sourceSessionsDir: join(root, "dev", ".opensession-sessions"),
        target: join(root, "dev"),
        liveHome: live,
        env: {},
      }),
    ).toThrow("live or source state");
    // A worktree's dev state under the live ~/.opensession is fine.
    expect(
      guard(join(live, ".opensession", "worktrees", "wt", ".dev-state")),
    ).not.toThrow();
  });

  test("refuses while a dev server uses the target", () => {
    const root = tempRoot();
    const target = join(root, ".dev-state");
    mkdirSync(join(target, ".opensession-sessions"), { recursive: true });
    expect(() => assertDevServerStopped(target, idleProbe)).not.toThrow();

    writeFileSync(join(target, DEV_SERVER_PID_FILE), `${process.pid}\n`);
    expect(() => assertDevServerStopped(target)).toThrow("A dev server (pid");
    expect(() => assertDevServerStopped(target, idleProbe)).not.toThrow();
    rmSync(join(target, DEV_SERVER_PID_FILE));

    writeFileSync(join(target, "gateway-active.lock"), "");
    expect(() =>
      assertDevServerStopped(target, { ...idleProbe, leaseHeld: () => true }),
    ).toThrow("gateway lease");
    rmSync(join(target, "gateway-active.lock"));

    writeFileSync(
      join(target, ".opensession-sessions", "session-kernel.sqlite"),
      "",
    );
    expect(() =>
      assertDevServerStopped(target, { ...idleProbe, openBy: () => [4242] }),
    ).toThrow("open by pid 4242");
    expect(() =>
      assertDevServerStopped(target, { ...idleProbe, openBy: () => null }),
    ).toThrow("Cannot determine whether");
  });

  test("keeps only display fields and redacts credential shapes", () => {
    const doc = sanitizeSessionDoc({
      id: "os-1",
      claudeSessionId: "resume",
      worktreeDir: "/live/wt",
      branch: "main",
      createdBy: "Ada",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActivity: "2026-01-01T01:00:00.000Z",
      title: `use ${FAKE_GH_TOKEN}`,
      runner: { id: "r1" },
      slackThreads: [{ channel: "C1", threadTs: "1" }],
    });
    expect(doc).toEqual({
      id: "os-1",
      claudeSessionId: "",
      branch: "main",
      worktreeDir: "",
      createdBy: "Ada",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActivity: "2026-01-01T01:00:00.000Z",
      title: "use [REDACTED]",
    });
    const json = JSON.stringify({
      text: `key -----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY----- api_key="${"k".repeat(20)}"`,
    });
    const redacted = redactSecrets(json);
    expect(JSON.parse(redacted).text).toBe(
      'key [REDACTED] api_key="[REDACTED]"',
    );
  });
});
