import { getConfigAsync } from "../../server/config";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  matchReviewOwners,
  matchSessions,
  workspaceIdForRepo,
} from "./session-matching";
import { __setSessionListStoreForTest } from "../../server/session-list-store";
import { SessionListStore } from "../../server/session-list-sqlite";
import type { UnifiedSession } from "../../server/types";

const root = fs.mkdtempSync(join(tmpdir(), "github-session-matching-"));
const priorConfig = process.env.OPENSESSION_CONFIG;
const config = join(root, "config.json");
fs.writeFileSync(
  config,
  JSON.stringify({
    repos: {
      alpha: { repo: join(root, "alpha"), ghRepo: "org/alpha", default: true },
      beta: { repo: join(root, "beta"), ghRepo: "org/beta" },
    },
  }),
);
let store: SessionListStore;
let priorStore: SessionListStore | undefined;

beforeEach(async () => {
  process.env.OPENSESSION_CONFIG = config;
  await getConfigAsync();
  store = new SessionListStore(":memory:");
  store.markCovered("include");
  priorStore = __setSessionListStoreForTest(store);
});
afterEach(() => {
  __setSessionListStoreForTest(priorStore);
  store.close();
});
afterAll(async () => {
  if (priorConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else {
    process.env.OPENSESSION_CONFIG = priorConfig;
    await getConfigAsync();
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function row(id: string, patch: Partial<UnifiedSession> = {}): UnifiedSession {
  return {
    id,
    source: "opensession",
    repo: "alpha",
    branch: "feature",
    title: id,
    worktreeDir: join(root, "checkout"),
    createdAt: "2026-09-17T00:00:00Z",
    lastActivity: "2026-09-17T00:00:00Z",
    isRunning: false,
    transcriptPath: null,
    ...patch,
  } as UnifiedSession;
}

describe("catalog-only GitHub session matching", () => {
  test("matches only live primary and attached repo ownership", async () => {
    store.upsertMany([
      row("primary", {
        attachedRepos: [{ repo: "alpha", branch: "feature", dir: "/unused" }],
      }),
      row("archived", { archived: true }),
      row("foreign", { repo: "beta" }),
      row("legacy", { repo: undefined }),
      row("no-repo", { repo: undefined, repoLess: true }),
      row("attached", {
        repo: "beta",
        branch: "other",
        attachedRepos: [{ repo: "alpha", branch: "feature", dir: "/unused" }],
      }),
    ]);
    expect(
      (await matchSessions("alpha", "feature")).map((s) => s.id).sort(),
    ).toEqual(["attached", "legacy", "primary"]);
    expect((await matchSessions("beta", "feature")).map((s) => s.id)).toEqual([
      "foreign",
    ]);
    expect(await workspaceIdForRepo("org/alpha")).toBe("alpha");
  });

  test("does no synchronous I/O or checkout discovery at fleet scale", async () => {
    store.upsertMany(
      Array.from({ length: 10_000 }, (_, i) =>
        row(`unrelated-${i}`, { branch: `other-${i}` }),
      ),
    );
    store.upsertMany([
      row("wanted", { workspaceId: "shared", prNumber: 1 }),
      row("legacy-wanted", {
        workspaceId: "shared",
        prNumber: 1,
        repo: undefined,
      }),
    ]);
    const probes = [
      spyOn(fs, "readdirSync"),
      spyOn(fs, "readFileSync"),
      spyOn(fs, "statSync"),
      spyOn(fs, "realpathSync"),
      spyOn(Bun, "which"),
    ];
    const deny = () => {
      throw new Error("Synchronous gateway I/O");
    };
    for (const probe of probes)
      probe.mockImplementation(Object.assign(deny, { native: deny }));
    try {
      expect(
        (await matchSessions("alpha", "feature")).map((s) => s.id).sort(),
      ).toEqual(["legacy-wanted", "wanted"]);
      for (const probe of probes) expect(probe).not.toHaveBeenCalled();
    } finally {
      for (const probe of probes) probe.mockRestore();
    }
  });

  test("never guesses session ownership from shared or isolated checkout HEAD", async () => {
    const dir = join(root, "checkout");
    fs.mkdirSync(join(dir, ".git"), { recursive: true });
    fs.writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/unrecorded\n");
    store.upsert(row("owned"));
    expect(await matchSessions("alpha", "unrecorded")).toEqual([]);
    // The targeted turn-boundary writer updates ownership, not a webhook scan.
    store.upsert(row("owned", { branch: "renamed" }));
    expect(await matchSessions("alpha", "feature")).toEqual([]);
    expect((await matchSessions("alpha", "renamed")).map((s) => s.id)).toEqual([
      "owned",
    ]);
  });

  test("missing coverage and worker failures fail closed, never scan", async () => {
    const empty = new SessionListStore(":memory:");
    __setSessionListStoreForTest(empty);
    try {
      await expect(matchSessions("alpha", "feature")).rejects.toThrow(
        "not ready",
      );
      empty.close();
      await expect(matchSessions("alpha", "feature")).rejects.toThrow();
    } finally {
      __setSessionListStoreForTest(store);
    }
  });

  test("refuses overflow rather than silently truncating or notifying a fleet", async () => {
    store.upsertMany(Array.from({ length: 26 }, (_, i) => row(`owner-${i}`)));
    await expect(matchSessions("alpha", "feature")).rejects.toThrow(
      "more than 25",
    );
    store.remove("owner-25");
    expect(await matchSessions("alpha", "feature")).toHaveLength(25);
  });

  test("review handoff falls back to a session that linked the PR", async () => {
    const linker = row("linker", {
      branch: "temp-checkout",
      worktreeDir: join(root, "temp"),
      lastActivity: "2026-09-18T00:00:00Z",
      linkedPrs: [{ repo: "alpha", branch: "feature", number: 7 }],
    });
    store.upsertMany([
      linker,
      row("bks-ghpr-alpha-7-review"),
      row("older-linker", {
        branch: null,
        linkedPrs: [{ repo: "alpha", branch: "feature" }],
      }),
      row("beta-linker", {
        branch: null,
        linkedPrs: [{ repo: "beta", branch: "feature" }],
      }),
    ]);
    // Merge and conflict notices keep plain checkout ownership.
    expect((await matchSessions("alpha", "feature")).map((s) => s.id)).toEqual([
      "bks-ghpr-alpha-7-review",
    ]);
    expect(
      (await matchReviewOwners("alpha", "feature")).map((s) => s.id),
    ).toEqual(["linker", "older-linker"]);
    expect(
      (await matchReviewOwners("beta", "feature")).map((s) => s.id),
    ).toEqual(["beta-linker"]);

    // A real branch owner beats any linker.
    store.upsert(row("owner", { lastActivity: "2026-09-10T00:00:00Z" }));
    expect(
      (await matchReviewOwners("alpha", "feature")).map((s) => s.id),
    ).toEqual(["owner"]);
    store.remove("owner");

    // Unlinking, archiving, and removal drop the linked relation.
    store.upsert({ ...linker, linkedPrs: [] });
    expect(
      (await matchReviewOwners("alpha", "feature")).map((s) => s.id),
    ).toEqual(["older-linker"]);
    store.setArchived("older-linker", true);
    expect(await matchReviewOwners("alpha", "feature")).toEqual([]);
  });

  test("linked review owners keep the ambiguity limit", async () => {
    store.upsertMany(
      Array.from({ length: 26 }, (_, i) =>
        row(`linker-${i}`, {
          branch: null,
          linkedPrs: [{ repo: "alpha", branch: "feature" }],
        }),
      ),
    );
    await expect(matchReviewOwners("alpha", "feature")).rejects.toThrow(
      "more than 25",
    );
  });
});
