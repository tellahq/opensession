import { describe, expect, test } from "bun:test";
import {
  codeownersGlobs,
  evaluateApprovalGate,
  latestDecisiveReviews,
  normalizeApprovalGateConfig,
  ownersFor,
  parseCodeowners,
  type GateInput,
  type GateReview,
} from "./approval-gate-policy";
import type { LastReviewState } from "./state";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const matchGlob = (glob: string, path: string) =>
  new Bun.Glob(glob).match(path);

const CODEOWNERS = parseCodeowners(`
# Reserved areas
/.github/ @acme/platform
/infra/ @acme/infra
**/migrations/** @dana
docs/*  @acme/docs
/infra/README.md
`);

function review(over: Partial<LastReviewState> = {}): LastReviewState {
  return {
    verdict: "approve",
    confidence: 5,
    risk: "low",
    findings: 0,
    blocking: 0,
    sha: HEAD,
    at: "2026-10-08T00:00:00.000Z",
    ...over,
  };
}

function input(over: Partial<GateInput> = {}): GateInput {
  return {
    headSha: HEAD,
    author: "alice",
    fromFork: false,
    files: ["src/app.ts"],
    filesComplete: true,
    lastReview: review(),
    reviews: [],
    approvers: new Set(["bob", "carol", "dana"]),
    codeowners: CODEOWNERS,
    ownerTokens: new Map([
      ["bob", new Set(["@bob"])],
      ["carol", new Set(["@carol", "@acme/infra"])],
      ["dana", new Set(["@dana"])],
    ]),
    matchGlob,
    ...over,
  };
}

const approve = (login: string, commitId = HEAD): GateReview => ({
  login,
  userType: "User",
  state: "APPROVED",
  commitId,
});

function outcome(i: GateInput) {
  const r = evaluateApprovalGate(i);
  return r.status === "completed" ? r.conclusion : r.status;
}

describe("CODEOWNERS", () => {
  test("patterns translate like GitHub's", () => {
    expect(codeownersGlobs("*")).toEqual(["**"]);
    expect(codeownersGlobs("/infra/")).toEqual(["infra/**"]);
    expect(codeownersGlobs("apps/")).toEqual(["**/apps/**"]);
    expect(codeownersGlobs("package.json")).toEqual([
      "**/package.json",
      "**/package.json/**",
    ]);
    expect(codeownersGlobs("*.tf")).toEqual(["**/*.tf"]);
    expect(codeownersGlobs("docs/*")).toEqual(["docs/*"]);
  });

  test("the last matching rule wins, and an ownerless rule unowns", () => {
    const owners = (p: string) => ownersFor(CODEOWNERS, p, matchGlob);
    expect(owners(".github/workflows/ci.yml")).toEqual(["@acme/platform"]);
    expect(owners("infra/main.tf")).toEqual(["@acme/infra"]);
    expect(owners("infra/README.md")).toEqual([]);
    expect(owners("api/db/migrations/0001.sql")).toEqual(["@dana"]);
    expect(owners("docs/a.md")).toEqual(["@acme/docs"]);
    expect(owners("docs/deep/a.md")).toEqual([]);
    expect(owners("src/app.ts")).toEqual([]);
    // A catch-all owns everything until a later rule says otherwise.
    const all = parseCodeowners("* @acme/devs\n/infra/ @acme/infra");
    expect(ownersFor(all, "src/app.ts", matchGlob)).toEqual(["@acme/devs"]);
    expect(ownersFor(all, "infra/x", matchGlob)).toEqual(["@acme/infra"]);
  });

  test("owners are lowercased and comments end the owner list", () => {
    expect(
      parseCodeowners("/x/ @Acme/Infra dev@example.test # @ignored")[0]!.owners,
    ).toEqual(["@acme/infra", "dev@example.test"]);
  });
});

describe("approval gate policy", () => {
  test("a 5/5 approving review of an unowned change passes", () => {
    const r = evaluateApprovalGate(input());
    expect(r).toMatchObject({ status: "completed", conclusion: "success" });
    expect(r.title).toBe("OS review: approve · 5/5 · risk low");
  });

  test("merge risk does not decide: an approving 5/5 review passes at any risk", () => {
    for (const risk of ["medium", "high", undefined] as const) {
      const r = evaluateApprovalGate(input({ lastReview: review({ risk }) }));
      expect(r).toMatchObject({ conclusion: "success" });
    }
  });

  test("a repository risk cap applies to the automatic path only", () => {
    const capped = (risk: LastReviewState["risk"], maxRisk: "low" | "medium") =>
      evaluateApprovalGate(input({ maxRisk, lastReview: review({ risk }) }));
    expect(capped("low", "low")).toMatchObject({ conclusion: "success" });
    expect(capped("medium", "medium")).toMatchObject({ conclusion: "success" });
    const over = capped("medium", "low");
    expect(over).toMatchObject({ conclusion: "action_required" });
    expect(over.summary).toContain("risk low or lower");
    expect(capped("high", "medium")).toMatchObject({
      conclusion: "action_required",
    });
    // No risk score never clears a cap.
    expect(capped(undefined, "medium")).toMatchObject({
      conclusion: "action_required",
    });
    // A human approval still passes over the cap.
    expect(
      outcome(
        input({
          maxRisk: "low",
          lastReview: review({ risk: "high" }),
          reviews: [approve("bob")],
        }),
      ),
    ).toBe("success");
  });

  test("a repository quality floor lets lower-scored approvals pass, and only them", () => {
    const at = (confidence: number | undefined, minQuality?: number) =>
      evaluateApprovalGate(
        input({ minQuality, lastReview: review({ confidence }) }),
      );
    expect(at(4, 4)).toMatchObject({ conclusion: "success" });
    expect(at(5, 4)).toMatchObject({ conclusion: "success" });
    const under = at(3, 4);
    expect(under).toMatchObject({ conclusion: "action_required" });
    expect(under.summary).toContain("approve, 4/5 or higher");
    expect(at(undefined, 4)).toMatchObject({ conclusion: "action_required" });
    expect(at(4)).toMatchObject({ conclusion: "action_required" });
    // The floor never waives the verdict or blocking findings.
    for (const over of [{ verdict: "comment" }, { blocking: 1 }]) {
      expect(
        evaluateApprovalGate(
          input({
            minQuality: 4,
            lastReview: review({ confidence: 4, ...over }),
          }),
        ),
      ).toMatchObject({ conclusion: "action_required" });
    }
  });

  test("anything short of approve, 5/5 and no blockers needs a human", () => {
    for (const over of [
      { confidence: 4 },
      { verdict: "comment" },
      { blocking: 1 },
    ]) {
      const r = evaluateApprovalGate(input({ lastReview: review(over) }));
      expect(r).toMatchObject({ conclusion: "action_required" });
      expect(r.title).toStartWith("Needs a human approval: OS review");
    }
  });

  test("a review of an older head, or none, waits", () => {
    expect(outcome(input({ lastReview: review({ sha: OLD }) }))).toBe(
      "in_progress",
    );
    expect(outcome(input({ lastReview: null }))).toBe("in_progress");
  });

  test("an approval of an unowned change passes whatever the review says", () => {
    const r = evaluateApprovalGate(
      input({
        lastReview: review({ confidence: 2, risk: "high" }),
        reviews: [approve("bob")],
      }),
    );
    expect(r).toMatchObject({ conclusion: "success" });
    expect(r.title).toBe("Approved by @bob");
    expect(
      outcome(input({ lastReview: null, reviews: [approve("bob")] })),
    ).toBe("success");
  });

  test("an owned file needs one of its owners, whatever the review says", () => {
    const files = ["src/app.ts", "infra/main.tf"];
    const r = evaluateApprovalGate(input({ files }));
    expect(r).toMatchObject({ conclusion: "action_required" });
    expect(r.title).toBe("Needs a code owner approval from @acme/infra");
    expect(r.summary).toContain("`infra/main.tf`");
    // Bob has write access but does not own infra.
    expect(outcome(input({ files, reviews: [approve("bob")] }))).toBe(
      "action_required",
    );
    // Carol is in @acme/infra.
    const ok = evaluateApprovalGate(
      input({ files, lastReview: null, reviews: [approve("carol")] }),
    );
    expect(ok).toMatchObject({ conclusion: "success" });
    expect(ok.title).toBe("Approved by code owner @carol");
  });

  test("every owned file needs an owner; one owner's approval covers only their files", () => {
    const files = ["infra/main.tf", "db/migrations/2.sql"];
    const one = evaluateApprovalGate(
      input({ files, reviews: [approve("carol")] }),
    );
    expect(one.title).toBe("Needs a code owner approval from @dana");
    expect(
      outcome(input({ files, reviews: [approve("carol"), approve("dana")] })),
    ).toBe("success");
  });

  test("an explicitly unowned path under an owned directory is not owned", () => {
    expect(outcome(input({ files: ["infra/README.md"] }))).toBe("success");
  });

  test("a catch-all CODEOWNERS sends every PR to its owners", () => {
    const codeowners = parseCodeowners("* @acme/devs");
    expect(evaluateApprovalGate(input({ codeowners })).title).toBe(
      "Needs a code owner approval from @acme/devs",
    );
  });

  test("approvals of an older commit count unless the repo requires the head", () => {
    const low = review({ confidence: 3 });
    const files = ["infra/main.tf"];
    // Default: an approval survives later pushes, for owners too.
    expect(
      outcome(input({ lastReview: low, reviews: [approve("bob", OLD)] })),
    ).toBe("success");
    expect(outcome(input({ files, reviews: [approve("carol", OLD)] }))).toBe(
      "success",
    );
    // requireApprovalOnHead: only approvals of the current head count.
    const stale = evaluateApprovalGate(
      input({
        requireApprovalOnHead: true,
        lastReview: low,
        reviews: [approve("bob", OLD)],
      }),
    );
    expect(stale).toMatchObject({ conclusion: "action_required" });
    expect(stale.summary).toContain("older commit");
    expect(
      outcome(
        input({
          requireApprovalOnHead: true,
          files,
          reviews: [approve("carol", OLD)],
        }),
      ),
    ).toBe("action_required");
    // The OS review path still needs a review of the head.
    expect(outcome(input({ lastReview: review({ sha: OLD }) }))).toBe(
      "in_progress",
    );
  });

  test("approvals count only from approvers other than the author", () => {
    const low = review({ confidence: 3 });
    // Not in the approver set (no write access, or a bot).
    expect(
      outcome(input({ lastReview: low, reviews: [approve("mallory")] })),
    ).toBe("action_required");
    // The author never counts, even if the caller listed them.
    expect(
      outcome(
        input({
          author: "carol",
          lastReview: low,
          files: ["infra/main.tf"],
          reviews: [approve("carol")],
        }),
      ),
    ).toBe("action_required");
  });

  test("an outstanding change request blocks both paths", () => {
    const changes: GateReview = {
      login: "carol",
      userType: "User",
      state: "CHANGES_REQUESTED",
      commitId: OLD,
    };
    const r = evaluateApprovalGate(
      input({ reviews: [changes, approve("bob")] }),
    );
    expect(r).toMatchObject({ conclusion: "action_required" });
    expect(r.title).toBe("Changes requested by @carol");
    // A later comment does not clear it; a later approval or dismissal does.
    const comment = { ...changes, state: "COMMENTED", commitId: HEAD };
    expect(outcome(input({ reviews: [changes, comment] }))).toBe(
      "action_required",
    );
    expect(outcome(input({ reviews: [changes, approve("carol")] }))).toBe(
      "success",
    );
    expect(
      outcome(
        input({ reviews: [changes, { ...changes, state: "DISMISSED" }] }),
      ),
    ).toBe("success");
  });

  test("the review policy and any CODEOWNERS file need a human, wherever it is", () => {
    for (const files of [
      [".os-review.json"],
      ["CODEOWNERS"],
      [".github/CODEOWNERS"],
      ["packages/web/CODEOWNERS"],
    ]) {
      const r = evaluateApprovalGate(input({ files, codeowners: [] }));
      expect(r).toMatchObject({ conclusion: "action_required" });
      expect(r.title).toBe("Needs a human approval: changes the review policy");
      expect(
        outcome(input({ files, codeowners: [], reviews: [approve("bob")] })),
      ).toBe("success");
    }
  });

  test("forks and truncated file lists need a human", () => {
    expect(evaluateApprovalGate(input({ fromFork: true })).title).toBe(
      "Needs a human approval: opened from a fork",
    );
    expect(outcome(input({ fromFork: true, reviews: [approve("bob")] }))).toBe(
      "success",
    );
    expect(evaluateApprovalGate(input({ filesComplete: false })).title).toBe(
      "Needs a human approval: too many files to check",
    );
  });

  test("latest decisive review per login ignores comments and pending reviews", () => {
    const latest = latestDecisiveReviews([
      approve("Bob"),
      { login: "bob", userType: "User", state: "COMMENTED", commitId: HEAD },
      { login: "bob", userType: "User", state: "PENDING", commitId: HEAD },
    ]);
    expect(latest.get("bob")?.state).toBe("APPROVED");
  });
});

describe("approval gate config", () => {
  test("off unless configured", () => {
    expect(normalizeApprovalGateConfig(undefined)).toBeNull();
    expect(normalizeApprovalGateConfig(false)).toBeNull();
    expect(normalizeApprovalGateConfig({ enabled: false })).toBeNull();
    expect(normalizeApprovalGateConfig([])).toBeNull();
  });

  test("true or an object enables it", () => {
    expect(normalizeApprovalGateConfig(true)).toEqual({
      checkName: "OS approval gate",
    });
    expect(normalizeApprovalGateConfig({ checkName: "  Gate " })).toEqual({
      checkName: "Gate",
    });
    expect(normalizeApprovalGateConfig({ maxRisk: "low" })).toEqual({
      checkName: "OS approval gate",
      maxRisk: "low",
    });
    expect(
      normalizeApprovalGateConfig({ requireApprovalOnHead: true }),
    ).toEqual({
      checkName: "OS approval gate",
      requireApprovalOnHead: true,
    });
    expect(normalizeApprovalGateConfig({ minQuality: 4 })).toEqual({
      checkName: "OS approval gate",
      minQuality: 4,
    });
    for (const minQuality of [0, 5, 3.5, "4"])
      expect(normalizeApprovalGateConfig({ minQuality })).toEqual({
        checkName: "OS approval gate",
      });
    expect(normalizeApprovalGateConfig({ maxRisk: "extreme" })).toEqual({
      checkName: "OS approval gate",
    });
  });
});
