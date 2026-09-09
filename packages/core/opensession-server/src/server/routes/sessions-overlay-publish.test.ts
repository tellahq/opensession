/**
 * List readers serve the registry overlays (rename, manual lane, review
 * request) stored on the index row instead of re-reading the registries per
 * request (sessions-indexed-overlays.test.ts). That contract holds only if
 * every registry writer republishes the rows it touched, so this drives each
 * mutation route and reads the index back. A setter that forgets to publish
 * would leave the sidebar stale until the next full rebuild.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UnifiedSession } from "../types";

const home = join(tmpdir(), `sessions-overlay-publish-${crypto.randomUUID()}`);
const sessionsDir = join(home, ".opensession-sessions");
const prior = {
  home: process.env.HOME,
  stateDir: process.env.OPENSESSION_STATE_DIR,
  config: process.env.OPENSESSION_CONFIG,
};
let priorSessionsDir: string | undefined;
let priorStore: unknown;
let priorGhBackoff: number | undefined;

function writeSession(id: string, title: string): void {
  writeFileSync(
    join(sessionsDir, `${id}.json`),
    JSON.stringify({
      id,
      title,
      claudeSessionId: "",
      branch: "",
      createdBy: "Ada",
      createdAt: "2026-09-01T00:00:00.000Z",
      lastActivity: "2026-09-01T00:00:00.000Z",
      mode: "ask",
      source: "opensession",
    }),
  );
}

function row(id: string, patch: Partial<UnifiedSession> = {}): UnifiedSession {
  return {
    id,
    source: "opensession",
    branch: null,
    worktreeDir: null,
    createdBy: "Ada",
    startedBy: "Ada",
    title: id,
    lastActivity: "2026-09-01T00:00:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
    isRunning: false,
    transcriptPath: null,
    ...patch,
  } as UnifiedSession;
}

async function put(path: string, body: unknown): Promise<Response> {
  const { handleSessionsRoutes } = await import("./sessions");
  const url = new URL(`http://localhost${path}`);
  const response = await handleSessionsRoutes({
    req: new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    url,
    path,
    publicPrefix: "/opensession",
  });
  if (!response) throw new Error(`No route answered PUT ${path}`);
  return response;
}

beforeAll(async () => {
  mkdirSync(sessionsDir, { recursive: true });
  // The route graph needs one registered repo at load; the PR cache must
  // never reach `gh` from here, so the GitHub gate is closed for the file.
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      repos: {
        opensession: {
          repo: "/home/ubuntu/projects/opensession",
          ghRepo: "tellahq/opensession",
          label: "Open Session",
        },
      },
    }),
  );
  process.env.HOME = home;
  process.env.OPENSESSION_STATE_DIR = home;
  process.env.OPENSESSION_CONFIG = join(home, "config.json");
  priorGhBackoff = (await import("../github-limit")).__setGhBackoffForTest(
    Date.now() + 60 * 60 * 1000,
  );
  priorSessionsDir = (await import("../paths")).__setSessionsDirForTest(
    sessionsDir,
  );
  const { SessionListStore, __setSessionListStoreForTest } =
    await import("../session-list-store");
  priorStore = __setSessionListStoreForTest(new SessionListStore(":memory:"));

  writeSession("os-a", "Plain session");
  writeSession("os-b", "Merged session");
  const { upsertIndexedSessions } = await import("../session-list-store");
  // `os-b` is what the list scan made of a native session and a Slack thread
  // about the same engine session: one row, the Slack id kept as an alias.
  await upsertIndexedSessions(
    [
      row("os-a", { title: "Plain session" }),
      row("os-b", { title: "Merged session", aliasIds: ["slack-b"] }),
    ],
    "include",
  );
  // Targeted publishes learn a session's aliases from the memory snapshot.
  await (await import("../session-cache")).getCachedSessionsAsync("include");
});

afterAll(async () => {
  const { __setSessionListStoreForTest } =
    await import("../session-list-store");
  __setSessionListStoreForTest(
    priorStore as Parameters<typeof __setSessionListStoreForTest>[0],
  );
  if (priorSessionsDir !== undefined)
    (await import("../paths")).__setSessionsDirForTest(priorSessionsDir);
  if (priorGhBackoff !== undefined)
    (await import("../github-limit")).__setGhBackoffForTest(priorGhBackoff);
  for (const [key, value] of [
    ["HOME", prior.home],
    ["OPENSESSION_STATE_DIR", prior.stateDir],
    ["OPENSESSION_CONFIG", prior.config],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

async function indexed(id: string): Promise<UnifiedSession | null> {
  return (await import("../session-list-store")).indexedSession(id);
}

describe("registry writers republish the index row", () => {
  test("a rename lands on the stored row", async () => {
    const response = await put("/api/sessions/os-a/title", {
      title: "Renamed",
    });
    expect(response.status).toBe(200);
    expect(await indexed("os-a")).toMatchObject({
      title: "Renamed",
      titleOverridden: true,
    });

    await put("/api/sessions/os-a/title", { title: "" });
    const cleared = await indexed("os-a");
    expect(cleared?.title).toBe("Plain session");
    expect(cleared?.titleOverridden).toBeFalsy();
  });

  test("a manual lane lands on the stored row", async () => {
    await put("/api/sessions/os-a/status", { status: "review" });
    expect((await indexed("os-a"))?.manualStatus).toBe("review");

    await put("/api/sessions/os-a/status", { status: null });
    expect((await indexed("os-a"))?.manualStatus).toBeUndefined();
  });

  test("a review request, its acceptance and its clear land on the stored row", async () => {
    const requested = await put("/api/sessions/os-a/review", {
      reviewer: "Bob",
      by: "Ada",
    });
    expect(requested.status).toBe(200);
    expect((await indexed("os-a"))?.reviewRequest).toMatchObject({
      to: "Bob",
      by: "Ada",
    });

    const accepted = await put("/api/sessions/os-a/review", {
      accept: true,
      by: "Bob",
    });
    expect(accepted.status).toBe(200);
    expect((await indexed("os-a"))?.reviewRequest?.accepted).toMatchObject({
      by: "Bob",
    });

    await put("/api/sessions/os-a/review", { reviewer: "", by: "Ada" });
    expect((await indexed("os-a"))?.reviewRequest).toBeUndefined();
  });

  test("a rename addressed to a historical alias lands on the merged row and keeps its aliases", async () => {
    const response = await put("/api/sessions/slack-b/title", {
      title: "Renamed via alias",
    });
    expect(response.status).toBe(200);
    expect(await indexed("os-b")).toMatchObject({
      title: "Renamed via alias",
      titleOverridden: true,
      aliasIds: ["slack-b"],
    });
    expect(await indexed("slack-b")).toBeNull();
  });
});
