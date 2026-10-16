import { describe, expect, test } from "bun:test";
import type { Repo } from "../../server/config";
import type { ArchiveReason } from "../../server/archive";
import type { UnifiedSession } from "../../server/types";
import {
  archiveClosedPrSessions,
  parsePrSessionId,
  prSessionIds,
  restoreReopenedPrSessions,
  sweepClosedPrSessions,
  unarchiveGithubRunSession,
  SWEEP_MAX_LOOKUPS,
  type ClosedPrSweepDeps,
} from "./pr-session-archive";

const repos = {
  app: {
    id: "app",
    ghRepo: "acme/app",
    default: true,
  } as unknown as Repo,
  api: { id: "api", ghRepo: "acme/api" } as unknown as Repo,
};

function row(id: string, patch: Partial<UnifiedSession> = {}): UnifiedSession {
  return { id, archived: false, isRunning: false, ...patch } as UnifiedSession;
}

/** In-memory archive registry + session index standing in for the catalog. */
function fakeDeps(
  sessions: UnifiedSession[],
  opts: {
    states?: Record<string, "open" | "closed" | null>;
    locked?: string[];
    rateLimited?: boolean;
  } = {},
) {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const registry = new Map<string, ArchiveReason>();
  const reads: string[] = [];
  const lookups: string[] = [];
  const deps: ClosedPrSweepDeps = {
    async readSession(id) {
      reads.push(id);
      return byId.get(id) ?? null;
    },
    isArchivedId: (id) => registry.has(id),
    archiveReason: (id) => registry.get(id) ?? null,
    hasInFlightRun: (s) => !!s.isRunning,
    prLocked: (n, repo) => (opts.locked ?? []).includes(`${repo}#${n}`),
    async archive(s) {
      registry.set(s.id, "auto");
    },
    async unarchive(s) {
      if (!registry.has(s.id)) return false;
      registry.delete(s.id);
      return true;
    },
    repos: () => repos,
    async listLive(afterId, limit) {
      return [...byId.values()]
        .filter((s) => s.id.startsWith("bks-ghpr-") && s.id > afterId)
        .filter((s) => !registry.has(s.id) && !s.archived)
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, limit);
    },
    async prState(n, repo) {
      lookups.push(`${repo}#${n}`);
      const key = `${repo}#${n}`;
      return opts.states && key in opts.states ? opts.states[key] : "open";
    },
    rateLimited: async () => !!opts.rateLimited,
  };
  return { deps, registry, reads, lookups };
}

describe("PR session ids", () => {
  test("cover every PR-keyed kind and never the issue session", () => {
    expect(prSessionIds(7, "acme/app", repos)).toEqual([
      "bks-ghpr-7-review",
      "bks-ghpr-7-autofix",
      "bks-ghpr-7-simplify",
      "bks-ghpr-7-mention",
      "bks-ghpr-7-adversarial",
      "bks-ghpr-7-followup",
    ]);
    expect(prSessionIds(7, "acme/api", repos)[0]).toBe("bks-ghpr-api-7-review");
  });

  test("parse back to the PR they belong to", () => {
    expect(parsePrSessionId("bks-ghpr-7-review", repos)).toEqual({
      prNumber: 7,
      ghRepo: "acme/app",
    });
    expect(parsePrSessionId("bks-ghpr-api-12-mention", repos)).toEqual({
      prNumber: 12,
      ghRepo: "acme/api",
    });
    expect(parsePrSessionId("bks-ghpr-7-issue", repos)).toBeNull();
    expect(parsePrSessionId("bks-ghpr-gone-7-review", repos)).toBeNull();
    expect(parsePrSessionId("bks-ghpr-review", repos)).toBeNull();
    expect(parsePrSessionId("os-7-review", repos)).toBeNull();
  });
});

describe("archiveClosedPrSessions", () => {
  test("archives the closed PR's idle sessions as auto, by id only", async () => {
    const { deps, registry, reads } = fakeDeps([
      row("bks-ghpr-7-review"),
      row("bks-ghpr-7-mention"),
      row("bks-ghpr-7-autofix", { isRunning: true }),
      row("bks-ghpr-8-review"),
      row("bks-ghpr-7-issue"),
    ]);
    const archived = await archiveClosedPrSessions(7, "acme/app", deps);
    expect(archived).toEqual(["bks-ghpr-7-review", "bks-ghpr-7-mention"]);
    expect([...registry]).toEqual([
      ["bks-ghpr-7-review", "auto"],
      ["bks-ghpr-7-mention", "auto"],
    ]);
    // Only the PR's deterministic ids were read: no listing, no other PR.
    expect(reads).toEqual(prSessionIds(7, "acme/app", repos));
  });

  test("leaves sessions already archived alone, keeping a manual reason", async () => {
    const { deps, registry } = fakeDeps([row("bks-ghpr-7-review")]);
    registry.set("bks-ghpr-7-review", "manual");
    expect(await archiveClosedPrSessions(7, "acme/app", deps)).toEqual([]);
    expect(registry.get("bks-ghpr-7-review")).toBe("manual");
  });

  test("skips a PR whose review or code loop holds its lock", async () => {
    const { deps, registry } = fakeDeps([row("bks-ghpr-7-review")], {
      locked: ["acme/app#7"],
    });
    expect(await archiveClosedPrSessions(7, "acme/app", deps)).toEqual([]);
    expect(registry.size).toBe(0);
  });
});

describe("unarchiving", () => {
  test("a reopen restores only what close archived", async () => {
    const { deps, registry } = fakeDeps([
      row("bks-ghpr-7-review"),
      row("bks-ghpr-7-mention"),
    ]);
    registry.set("bks-ghpr-7-review", "auto");
    registry.set("bks-ghpr-7-mention", "manual");
    expect(await restoreReopenedPrSessions(7, "acme/app", deps)).toEqual([
      "bks-ghpr-7-review",
    ]);
    expect([...registry.keys()]).toEqual(["bks-ghpr-7-mention"]);
  });

  test("a new run unarchives its session whatever archived it", async () => {
    const { deps, registry } = fakeDeps([row("bks-ghpr-7-mention")]);
    expect(await unarchiveGithubRunSession("bks-ghpr-7-mention", deps)).toBe(
      false,
    );
    registry.set("bks-ghpr-7-mention", "manual");
    expect(await unarchiveGithubRunSession("bks-ghpr-7-mention", deps)).toBe(
      true,
    );
    expect(registry.size).toBe(0);
  });
});

describe("sweepClosedPrSessions", () => {
  test("archives sessions of closed PRs, one lookup per PR, skipping known-open ones", async () => {
    const { deps, registry, lookups } = fakeDeps(
      [
        row("bks-ghpr-1-review"),
        row("bks-ghpr-1-autofix"),
        row("bks-ghpr-2-review"),
        row("bks-ghpr-3-review"),
        row("bks-ghpr-api-4-mention"),
        row("bks-ghpr-9-issue"),
      ],
      { states: { "acme/app#1": "closed", "acme/api#4": "closed" } },
    );
    const result = await sweepClosedPrSessions("", deps, new Set(["3"]));
    expect(lookups).toEqual(["acme/app#1", "acme/app#2", "acme/api#4"]);
    expect(result.archived.sort()).toEqual([
      "bks-ghpr-1-autofix",
      "bks-ghpr-1-review",
      "bks-ghpr-api-4-mention",
    ]);
    expect(registry.has("bks-ghpr-2-review")).toBe(false);
    expect(result.cursor).toBe("");
  });

  test("caps GitHub lookups per pass and resumes from its cursor", async () => {
    const sessions = Array.from({ length: SWEEP_MAX_LOOKUPS + 3 }, (_, i) =>
      row(`bks-ghpr-${100 + i}-review`),
    );
    const { deps, lookups } = fakeDeps(sessions);
    const first = await sweepClosedPrSessions("", deps);
    expect(first.lookups).toBe(SWEEP_MAX_LOOKUPS);
    expect(first.cursor).toBe(`bks-ghpr-${100 + SWEEP_MAX_LOOKUPS - 1}-review`);
    const second = await sweepClosedPrSessions(first.cursor, deps);
    expect(second.lookups).toBe(3);
    expect(second.cursor).toBe("");
    expect(new Set(lookups).size).toBe(SWEEP_MAX_LOOKUPS + 3);
  });

  test("stops without advancing on a rate limit or an unreadable PR", async () => {
    const limited = fakeDeps([row("bks-ghpr-1-review")], { rateLimited: true });
    expect(await sweepClosedPrSessions("", limited.deps)).toEqual({
      cursor: "",
      lookups: 0,
      archived: [],
    });
    const unreadable = fakeDeps(
      [row("bks-ghpr-1-review"), row("bks-ghpr-2-review")],
      { states: { "acme/app#2": null } },
    );
    const result = await sweepClosedPrSessions("", unreadable.deps);
    expect(result.cursor).toBe("bks-ghpr-1-review");
    expect(result.lookups).toBe(2);
  });

  test("does nothing while the index has no coverage", async () => {
    const { deps, lookups } = fakeDeps([row("bks-ghpr-1-review")]);
    deps.listLive = async () => null;
    expect((await sweepClosedPrSessions("x", deps)).cursor).toBe("x");
    expect(lookups).toEqual([]);
  });
});
