import { describe, expect, test } from "bun:test";

import { utf8Bytes } from "./budget";
import {
  AMBIENT_MEMORY_BUDGET_BYTES,
  RETRIEVED_MEMORY_BUDGET_BYTES,
  extractMemoryQueryTerms,
  rankMemoryRecords,
  renderAmbientMemory,
  retrieveMemory,
  type MemoryV2Kind,
  type MemoryV2SourceType,
  type RetrievalRecord,
} from "./retrieval";

const NOW = "2026-08-22T12:00:00.000Z";
const SCOPES = ["repo-opensession", "user-kent", "workspace"];

function record(
  id: string,
  summary: string,
  opts: Partial<RetrievalRecord> & {
    scopeKey?: string;
    kind?: MemoryV2Kind;
    sourceType?: MemoryV2SourceType;
  } = {},
): RetrievalRecord {
  const { sourceType, ...overrides } = opts;
  return {
    id,
    scopeKey: opts.scopeKey ?? "repo-opensession",
    kind: opts.kind ?? "reference",
    summary,
    tags: [],
    tier: "retrievable",
    source: { type: sourceType ?? "agent-verified" },
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    state: "active",
    ...overrides,
  };
}

describe("query extraction and ranking", () => {
  test("Actor queries retrieve the relevant facts and exclude implementation history", () => {
    const records = [
      record(
        "actor-1",
        "Actor workers receive one mailbox message at a time.",
        { kind: "constraint" },
      ),
      record(
        "actor-2",
        "SessionActor owns the actor lifecycle and restart boundary.",
        { kind: "decision", tags: ["Actor"] },
      ),
      record(
        "actor-3",
        "The Actor test harness lives in session-kernel/actor-worker.test.ts.",
        { kind: "reference" },
      ),
      ...Array.from({ length: 25 }, (_, index) =>
        record(
          `noise-${index}`,
          `PR ${1000 + index} implemented UI cleanup and was deployed on August ${index + 1}.`,
          {
            kind: "status",
            updatedAt: "2026-08-22T11:59:00.000Z",
          },
        ),
      ),
    ];
    const result = retrieveMemory(
      records,
      "Please look at the Actor implementation",
      {
        scopeKeys: SCOPES,
        primaryRepoKey: "repo-opensession",
        now: NOW,
      },
    );

    expect(new Set(result.records.map(({ record }) => record.id))).toEqual(
      new Set(["actor-1", "actor-2", "actor-3"]),
    );
    expect(result.text).not.toContain("PR 1000");
    expect(result.queryTerms).toEqual(["actor"]);
  });

  test("uses OR retrieval for meaningful terms instead of requiring every substring", () => {
    const records = [
      record("postgres", "Postgres uses a local socket."),
      record("kube", "Kubernetes deploys use a canary."),
      record("unrelated", "The app uses sentence case."),
    ];
    const result = retrieveMemory(
      records,
      "What do we know about postgres kubernetes?",
      {
        scopeKeys: SCOPES,
        now: NOW,
      },
    );
    expect(new Set(result.records.map(({ record }) => record.id))).toEqual(
      new Set(["postgres", "kube"]),
    );
    expect(
      extractMemoryQueryTerms("What do we know about postgres kubernetes?"),
    ).toEqual(["postgres", "kubernetes"]);
  });

  test("exact paths and symbols outrank broad lexical matches", () => {
    const records = [
      record(
        "broad",
        "The actor worker mailbox has tests and restart handling.",
        {
          kind: "constraint",
          lastConfirmedAt: "2026-08-22T11:59:00.000Z",
        },
      ),
      record(
        "exact",
        "Mailbox ownership is documented in src/session-kernel/ActorWorker.ts.",
        {
          kind: "reference",
          updatedAt: "2025-01-01T00:00:00.000Z",
        },
      ),
    ];
    const ranked = rankMemoryRecords(
      records,
      "check src/session-kernel/ActorWorker.ts mailbox",
      {
        scopeKeys: SCOPES,
        now: NOW,
      },
    );
    expect(ranked[0].record.id).toBe("exact");
    expect(ranked[0].reasons).toContain("exact-identifier");
  });

  test("scope specificity breaks otherwise equal matches repo before user before team", () => {
    const records = [
      record("team", "The deployment socket is /tmp/app.sock.", {
        scopeKey: "workspace",
      }),
      record("user", "The deployment socket is /tmp/app.sock.", {
        scopeKey: "user-kent",
      }),
      record("repo", "The deployment socket is /tmp/app.sock.", {
        scopeKey: "repo-opensession",
      }),
    ];
    const ranked = rankMemoryRecords(records, "deployment socket", {
      scopeKeys: SCOPES,
      primaryRepoKey: "repo-opensession",
      now: NOW,
    });
    expect(ranked.map(({ record }) => record.id)).toEqual([
      "repo",
      "user",
      "team",
    ]);
  });
});

describe("eligibility and isolation", () => {
  test("excludes expired, superseded, archived, and explicitly expired records", () => {
    const records = [
      record("active", "Actor is active."),
      record("ttl", "Actor TTL elapsed.", {
        expiresAt: "2026-08-22T11:59:59.000Z",
      }),
      record("superseded", "Actor old fact.", { state: "superseded" }),
      record("expired", "Actor expired fact.", { state: "expired" }),
      record("archived", "Actor archived fact.", { state: "archived" }),
    ];
    const result = retrieveMemory(records, "Actor", {
      scopeKeys: SCOPES,
      now: NOW,
    });
    expect(result.records.map(({ record }) => record.id)).toEqual(["active"]);
  });

  test("never returns a relevant record outside the caller's scopes", () => {
    const records = [
      record("visible", "Actor uses the visible repo policy."),
      record("secret", "Actor secret exact policy and credentials.", {
        scopeKey: "repo-other",
      }),
    ];
    const result = retrieveMemory(records, "Actor secret policy", {
      scopeKeys: ["repo-opensession"],
      now: NOW,
    });
    expect(result.records.map(({ record }) => record.id)).toEqual(["visible"]);
    expect(result.text).not.toContain("credentials");
  });
});

describe("retrieved budget", () => {
  test("includes the header in an exact UTF-8 byte ceiling", () => {
    const one = record("unicode", "Actor prefers café ☕.");
    const full = retrieveMemory([one], "Actor", {
      scopeKeys: SCOPES,
      now: NOW,
      budgetBytes: 10_000,
    });
    const exactBytes = utf8Bytes(full.text);
    expect(full.bytes).toBe(exactBytes);

    const exact = retrieveMemory([one], "Actor", {
      scopeKeys: SCOPES,
      now: NOW,
      budgetBytes: exactBytes,
    });
    expect(exact.records).toHaveLength(1);
    expect(exact.bytes).toBe(exactBytes);

    const oneByteShort = retrieveMemory([one], "Actor", {
      scopeKeys: SCOPES,
      now: NOW,
      budgetBytes: exactBytes - 1,
    });
    expect(oneByteShort.records).toHaveLength(0);
    expect(oneByteShort.text).toBe("");
    expect(oneByteShort.bytes).toBe(0);
  });

  test("returns no more than six records and never exceeds 4 KB", () => {
    const records = Array.from({ length: 20 }, (_, index) =>
      record(`actor-${index}`, `Actor fact ${index}: ${"x".repeat(600)}`),
    );
    const result = retrieveMemory(records, "Actor", {
      scopeKeys: SCOPES,
      now: NOW,
    });
    expect(result.records.length).toBeLessThanOrEqual(6);
    expect(result.bytes).toBeLessThanOrEqual(RETRIEVED_MEMORY_BUDGET_BYTES);
    expect(utf8Bytes(result.text)).toBe(result.bytes);
    expect(result.omitted).toBe(20 - result.records.length);
  });
});

describe("ambient budget and trust", () => {
  test("renders only pinned user-explicit or settings records by default", () => {
    const records = [
      record("explicit", "Use concise responses.", {
        tier: "pinned",
        sourceType: "user-explicit",
      }),
      record("settings", "Never use an em dash.", {
        tier: "pinned",
        sourceType: "settings",
      }),
      record("agent", "An agent inferred this preference.", {
        tier: "pinned",
        sourceType: "agent-verified",
      }),
      record("slack", "A Slack message stated this once.", {
        tier: "pinned",
        sourceType: "slack",
      }),
      record("retrievable", "This trusted fact is not pinned.", {
        sourceType: "user-explicit",
      }),
    ];
    const result = renderAmbientMemory(records, {
      scopeKeys: SCOPES,
      now: NOW,
    });
    expect(new Set(result.records.map((item) => item.id))).toEqual(
      new Set(["explicit", "settings"]),
    );
    expect(result.text).not.toContain("inferred");
  });

  test("supports an explicit caller trust policy without changing persisted records", () => {
    const slack = record("slack", "Always post deploy notes in Slack.", {
      tier: "pinned",
      sourceType: "slack",
    });
    expect(
      renderAmbientMemory([slack], { scopeKeys: SCOPES, now: NOW }).records,
    ).toHaveLength(0);
    expect(
      renderAmbientMemory([slack], {
        scopeKeys: SCOPES,
        now: NOW,
        trustedSourceTypes: ["slack"],
      }).records,
    ).toHaveLength(1);
  });

  test("enforces the exact 2.5 KB total including the header, with no scope floor", () => {
    const records = Array.from({ length: 12 }, (_, index) =>
      record(
        `repo-${index}`,
        `Pinned repository constraint ${index}: ${"é".repeat(180)}`,
        {
          tier: "pinned",
          sourceType: "settings",
          kind: "constraint",
        },
      ),
    ).concat([
      record("team-small", "Pinned team preference.", {
        scopeKey: "workspace",
        tier: "pinned",
        sourceType: "settings",
        kind: "preference",
      }),
    ]);
    const result = renderAmbientMemory(records, {
      scopeKeys: SCOPES,
      primaryRepoKey: "repo-opensession",
      now: NOW,
    });
    expect(result.bytes).toBeLessThanOrEqual(AMBIENT_MEMORY_BUDGET_BYTES);
    expect(utf8Bytes(result.text)).toBe(result.bytes);
    expect(result.records[0].scopeKey).toBe("repo-opensession");
    // No per-scope reservation: the budgeter simply consumes eligible pins in priority order.
    expect(result.omitted).toBe(records.length - result.records.length);

    const one = records[0];
    const full = renderAmbientMemory([one], {
      scopeKeys: SCOPES,
      now: NOW,
      budgetBytes: 10_000,
    });
    const exactBytes = utf8Bytes(full.text);
    expect(
      renderAmbientMemory([one], {
        scopeKeys: SCOPES,
        now: NOW,
        budgetBytes: exactBytes,
      }).bytes,
    ).toBe(exactBytes);
    expect(
      renderAmbientMemory([one], {
        scopeKeys: SCOPES,
        now: NOW,
        budgetBytes: exactBytes - 1,
      }).bytes,
    ).toBe(0);
  });

  test("ambient rendering also enforces scope and expiry", () => {
    const records = [
      record("visible", "Visible pin.", {
        tier: "pinned",
        sourceType: "settings",
      }),
      record("other", "Other repo pin.", {
        scopeKey: "repo-other",
        tier: "pinned",
        sourceType: "settings",
      }),
      record("expired", "Expired pin.", {
        tier: "pinned",
        sourceType: "settings",
        expiresAt: NOW,
      }),
    ];
    const result = renderAmbientMemory(records, {
      scopeKeys: ["repo-opensession"],
      now: NOW,
    });
    expect(result.records.map((item) => item.id)).toEqual(["visible"]);
  });
});
