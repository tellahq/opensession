import { getConfigAsync } from "../../server/config";
import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UnifiedSession } from "../../server/types";
import type { SessionControl } from "../../server/session-control";
import type { PrRef } from "./review";

const root = mkdtempSync(join(tmpdir(), "review-inversion-catalog-"));
const priorRoot = process.env.OPENSESSION_STATE_DIR;
const priorConfig = process.env.OPENSESSION_CONFIG;
process.env.OPENSESSION_STATE_DIR = root;
process.env.OPENSESSION_CONFIG = join(root, "config.json");
await getConfigAsync();
writeFileSync(
  process.env.OPENSESSION_CONFIG,
  JSON.stringify({
    repos: {
      app: { repo: join(root, "repo"), ghRepo: "org/app", default: true },
    },
  }),
);
const { authorFamilyFor, inverseReviewModel } =
  await import("./model-inversion");
const { registerSessionControl } = await import("../../server/session-control");
const { SessionListStore, __setSessionListStoreForTest } =
  await import("../../server/session-list-store");
const { updatePrState } = await import("./state");
const { boundedSessionNotificationIds, notifyMergedPrSessions } =
  await import("./session-notify");
const store = new SessionListStore(":memory:");
const priorStore = __setSessionListStoreForTest(store);
store.markCovered("include");
registerSessionControl({
  listSessions() {
    throw new Error("Must not enumerate sessions");
  },
} as unknown as SessionControl);
const pr = {
  number: 1,
  ghRepo: "org/app",
  headRef: "feature",
  headSha: "sha",
} as PrRef;
function row(id: string, model: string): UnifiedSession {
  return {
    id,
    source: "opensession",
    repo: "app",
    branch: "feature",
    model,
    title: id,
    worktreeDir: null,
    transcriptPath: null,
    createdAt: "2026-09-17T00:00:00Z",
    lastActivity: "2026-09-17T00:00:00Z",
    isRunning: false,
  } as UnifiedSession;
}

afterAll(async () => {
  __setSessionListStoreForTest(priorStore);
  store.close();
  if (priorRoot === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = priorRoot;
  if (priorConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else {
    process.env.OPENSESSION_CONFIG = priorConfig;
    await getConfigAsync();
  }
  rmSync(root, { recursive: true, force: true });
});

test("review inversion reuses catalog-derived authorship", async () => {
  store.upsert(row("owner", "pi/openai/gpt-6-astra"));
  const author = await authorFamilyFor(pr);
  expect(author).toEqual({ family: "openai", source: "owning session owner" });
  expect(inverseReviewModel(author, "pi/openai/gpt-5.6-sol")?.family).toBe(
    "openai",
  );
  expect(
    inverseReviewModel(author, "pi/anthropic/claude-fable-5-1"),
  ).toBeNull();
  store.remove("owner");
});

test("autofix author model comes from one catalog row, not a session file", async () => {
  store.upsert(row("bks-ghpr-1-autofix", "pi/openai/gpt-6-astra"));
  updatePrState(
    1,
    "feature",
    (state) => {
      state.autoFix = {
        active: false,
        iterations: 1,
        lastPushedSha: "sha",
        startedAt: "2026-09-17T00:00:00Z",
      };
    },
    "org/app",
  );
  expect(await authorFamilyFor(pr)).toEqual({
    family: "openai",
    source: "auto-fix loop",
  });
});

test("merge notification fanout remains deduplicated and capped", () => {
  expect(boundedSessionNotificationIds(["a", "a", "b"])).toEqual(["a", "b"]);
  expect(
    boundedSessionNotificationIds(
      Array.from({ length: 26 }, (_, i) => `id-${i}`),
    ),
  ).toBeNull();
});

test("catalog failures and ambiguous ownership keep the configured reviewer", async () => {
  const unavailable = new SessionListStore(":memory:");
  __setSessionListStoreForTest(unavailable);
  try {
    expect(await authorFamilyFor(pr)).toBeNull();
    unavailable.close();
    expect(await authorFamilyFor(pr)).toBeNull();
  } finally {
    __setSessionListStoreForTest(store);
  }
  store.upsertMany(
    Array.from({ length: 26 }, (_, i) =>
      row(`overflow-${i}`, "pi/openai/gpt-6-astra"),
    ),
  );
  expect(await authorFamilyFor(pr)).toBeNull();
  expect(inverseReviewModel(null, "pi/openai/gpt-5.6-sol")).toBeNull();
  const auditModule = await import("../../server/audit");
  const audit = spyOn(auditModule, "audit").mockImplementation(() => {});
  try {
    await notifyMergedPrSessions({
      repository: { full_name: "org/app" },
      pull_request: { number: 1, head: { ref: "feature" } },
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: "github_session_notification_fuse",
        matched_sessions_at_least: 26,
      }),
    );
  } finally {
    audit.mockRestore();
  }
});
