import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  SessionKernelStore,
  __setSessionKernelStoreForTest,
  sessionMetadata,
  sessionCatalogDocument,
} from "./session-kernel";
import { catalogNativeSessions } from "./session-catalog-read";
import {
  seedAgentSessionCatalog,
  markAgentSessionCatalogImportComplete,
  completeAgentSessionCatalogSources,
} from "./agent-session-catalog";
import { activePlainSessions } from "./plain-archive";
import { sweepCandidates } from "./generated-titles";
import { sweepOrphanTranscripts } from "./transcript-orphan-sweep";
import { missingCreatorLogin } from "./session-github-user-migration";
import type { NativeSessionFile } from "./types";

let store: SessionKernelStore;
let original: SessionKernelStore | undefined;
const spies: Array<{ mockRestore(): void }> = [];
beforeEach(() => {
  store = new SessionKernelStore(":memory:");
  const previous = __setSessionKernelStoreForTest(store);
  original ??= previous;
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  store.close();
});
afterAll(() => {
  __setSessionKernelStoreForTest(original);
});

async function seed(docs: Array<Record<string, unknown>>) {
  for (let i = 0; i < docs.length; i += 200)
    await sessionMetadata({
      op: "seed_catalog",
      rows: docs.slice(i, i + 200).map((data) => ({
        sessionId: String(data.id),
        doc: JSON.stringify(data),
        rev: 1,
        archived: !!data.archived,
        lastActivityMs: Date.now(),
      })),
    });
  await sessionMetadata({ op: "mark_catalog_complete" });
}

function forbidSourceDiscovery() {
  spies.push(
    spyOn(fs, "readdirSync").mockImplementation(() => {
      throw new Error("No directory scans");
    }),
  );
  const read = fs.readFileSync;
  spies.push(
    spyOn(fs, "readFileSync").mockImplementation(((
      path: unknown,
      ...args: unknown[]
    ) => {
      if (/\/(?:os-|bks-|C1-|linear-feature)/.test(String(path)))
        throw new Error("No per-session source reads");
      return (read as any)(path, ...args);
    }) as typeof fs.readFileSync),
  );
}

test("missing coverage refuses maintenance instead of treating it as an empty store", async () => {
  forbidSourceDiscovery();
  for (const read of [
    catalogNativeSessions,
    activePlainSessions,
    sweepCandidates,
    () => completeAgentSessionCatalogSources("slack"),
  ]) {
    const result = await read().then(
      () => null,
      (error) => error,
    );
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toContain("not seeded");
  }
});

test("a malformed imported agent projection fails closed", async () => {
  await sessionCatalogDocument({
    op: "seed",
    namespace: "slack-sessions",
    rows: [
      {
        key: "bad",
        value: JSON.stringify({ file: "bad.json", data: "not-a-session" }),
      },
    ],
  });
  await markAgentSessionCatalogImportComplete("slack");
  const result = await completeAgentSessionCatalogSources("slack").then(
    () => null,
    (error) => error,
  );
  expect(result?.message).toContain("Invalid slack session projection");
});

test("10,000 catalog rows feed attribution, bounded title candidates and Plain candidates without source probes", async () => {
  const docs = Array.from({ length: 10_000 }, (_, i) => ({
    id: `os-00000000-${String(i).padStart(6, "0")}`,
    title: `Investigate item ${i}`,
    createdAt: new Date(Date.now() - i * 1000).toISOString(),
    createdBy: "Ada",
    repo: "opensession",
    ...(i < 2 ? { plainThreadId: "ticket", archived: i === 1 } : {}),
  }));
  docs[2] = { ...docs[2]!, title: "Deliberate · name" };
  await seed(docs);
  const analytics = await import(
    `./analytics.ts?catalog-test=${crypto.randomUUID()}`
  );
  forbidSourceDiscovery();
  expect((await catalogNativeSessions()).length).toBe(10_000);
  expect((await activePlainSessions()).map((row) => row.data.id)).toEqual([
    docs[0]!.id,
  ]);
  const titles = await sweepCandidates();
  expect(titles.length).toBe(10);
  expect(titles[0]!.id).toBe(docs[0]!.id);
  expect(titles.some((row) => row.id === docs[2]!.id)).toBe(false);
  const [meta, coalesced] = await Promise.all([
    analytics.loadSessionMeta(),
    analytics.loadSessionMeta(),
  ]);
  expect(meta).toBe(coalesced);
  expect(meta.size).toBe(10_000);
  expect(meta.get(docs[0]!.id)?.createdBy).toBe("Ada");
}, 20_000);

test("Slack restoration and analytics use catalog source documents, including mtime fallback and stale cutoff", async () => {
  const { activeSessions, loadActiveSessionsOnStartup } =
    await import("../agents/slack/state");
  activeSessions.clear();
  const now = new Date().toISOString();
  await seedAgentSessionCatalog("slack", [
    {
      file: "C1-fresh.json",
      data: {
        channel: "C1",
        threadTs: "fresh",
        userId: "Ada",
        claudeSessionId: "fresh-engine",
      },
      mtime: now,
    },
    {
      file: "C1-stale.json",
      data: {
        channel: "C1",
        threadTs: "stale",
        claudeSessionId: "old-engine",
        lastActivity: "2020-01-01T00:00:00Z",
      },
      mtime: now,
    },
  ]);
  await markAgentSessionCatalogImportComplete("slack");
  const analytics = await import(
    `./analytics.ts?slack-catalog-test=${crypto.randomUUID()}`
  );
  forbidSourceDiscovery();
  await loadActiveSessionsOnStartup();
  expect(activeSessions.get("C1-fresh")?.claudeSessionId).toBe("fresh-engine");
  expect(activeSessions.has("C1-stale")).toBe(false);
  expect((await analytics.loadSlackSessionOwners()).get("slack-C1-fresh")).toBe(
    "Ada",
  );
  activeSessions.clear();
});

test("Linear catalog restoration preserves legacy phases and all persisted identity fields", async () => {
  const { activeSessions, loadActiveSessionsOnStartup } =
    await import("../agents/linear/session");
  activeSessions.clear();
  await seedAgentSessionCatalog("linear", [
    {
      file: "linear-feature.json",
      data: {
        branch: "linear-feature",
        claudeSessionId: null,
        linearSessionId: "linear-id",
        awaitingInitialDirection: true,
        issueTitle: "Task",
        issueCreator: { id: "a", name: "Ada", email: null },
        updatedAt: new Date().toISOString(),
      } as any,
      mtime: new Date().toISOString(),
    },
  ]);
  await markAgentSessionCatalogImportComplete("linear");
  forbidSourceDiscovery();
  await loadActiveSessionsOnStartup({
    org: { accessToken: "fixture-token", expiresAt: Date.now() + 86_400_000 },
  });
  expect(activeSessions.get("linear-id")).toMatchObject({
    phase: "awaiting_direction",
    issueTitle: "Task",
    issueCreator: { id: "a" },
    accessToken: "fixture-token",
  });
  activeSessions.clear();
});

test("orphan diagnostics never enumerate placements or delete live transcripts", async () => {
  for (const opts of [
    {},
    { dryRun: true },
    { candidateSessionIds: ["fixture"] },
    {
      dryRun: true,
      candidateSessionIds: Array.from(
        { length: 101 },
        (_, i) => `fixture-${i}`,
      ),
    },
  ]) {
    const result = await sweepOrphanTranscripts(opts);
    expect(result.refused).toContain("1..100 explicit");
    expect(result.removed).toBe(0);
  }
});

test("identity backfill never overwrites a login or attributes automation sessions to humans", () => {
  const doc = (patch: object) =>
    ({ id: "os-identity", createdBy: "Ada", ...patch }) as NativeSessionFile;
  const resolve = (name?: string | null) =>
    name === "Ada" ? "ada-login" : null;
  expect(missingCreatorLogin(doc({}), resolve)).toBe("ada-login");
  expect(
    missingCreatorLogin(doc({ createdByLogin: "other" }), resolve),
  ).toBeNull();
  expect(missingCreatorLogin(doc({ automationId: "job" }), resolve)).toBeNull();
  expect(
    missingCreatorLogin(doc({ createdBy: "Ada (automation)" }), resolve),
  ).toBeNull();
  expect(
    missingCreatorLogin(doc({ createdBy: "Unknown" }), resolve),
  ).toBeNull();
});
