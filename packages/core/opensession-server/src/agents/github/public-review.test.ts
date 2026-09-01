import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  automaticReviewEventAllowed,
  evaluatePublicReviewAdmission,
  isExternalPullRequest,
  publicReviewSizeError,
  type PublicReviewBudgetState,
  type PublicReviewLimits,
} from "./public-review";

const limits: PublicReviewLimits = {
  maxFiles: 10,
  maxChangedLines: 100,
  maxPatchBytes: 1_000,
  dailyReviews: 3,
  perAuthorReviews: 2,
  attemptsPerSha: 2,
};

const admit = (
  state: PublicReviewBudgetState | null,
  over: Partial<{
    day: string;
    repo: string;
    prNumber: number;
    headSha: string;
    author: string;
  }> = {},
) =>
  evaluatePublicReviewAdmission(
    state,
    {
      day: "2026-08-28",
      repo: "tellahq/opensession",
      prNumber: 1,
      headSha: "a".repeat(40),
      author: "contributor",
      ...over,
    },
    limits,
  );

describe("public PR review policy", () => {
  test("classifies fork identity by repository, not branch or sender", () => {
    expect(
      isExternalPullRequest(
        { headRepo: "someone/opensession" },
        "tellahq/opensession",
      ),
    ).toBe(true);
    expect(
      isExternalPullRequest(
        { headRepo: "TELLAHQ/OpenSession" },
        "tellahq/opensession",
      ),
    ).toBe(false);
    expect(isExternalPullRequest({}, "tellahq/opensession")).toBe(false);
  });

  test("admits untrusted senders only for external fork review", () => {
    expect(
      automaticReviewEventAllowed({
        senderIsBot: false,
        senderIsTrusted: false,
        externalFork: true,
      }),
    ).toBe(true);
    expect(
      automaticReviewEventAllowed({
        senderIsBot: false,
        senderIsTrusted: false,
        externalFork: false,
      }),
    ).toBe(false);
  });

  test("rejects oversized public changes before provisioning", () => {
    expect(
      publicReviewSizeError(
        { changedFiles: 11, additions: 1, deletions: 1 },
        limits,
      ),
    ).toContain("11 files");
    expect(
      publicReviewSizeError(
        { changedFiles: 2, additions: 60, deletions: 41 },
        limits,
      ),
    ).toContain("101 lines");
    expect(
      publicReviewSizeError(
        { changedFiles: 2, additions: 60, deletions: 40 },
        limits,
      ),
    ).toBeNull();
  });

  test("bounds attempts for one immutable head", () => {
    const first = admit(null);
    const second = admit(first.state);
    const third = admit(second.state);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(third).toMatchObject({ ok: false, reason: "sha_limit" });
  });

  test("bounds one author and the repository per UTC day", () => {
    const first = admit(null, { prNumber: 1, headSha: "a".repeat(40) });
    const second = admit(first.state, { prNumber: 2, headSha: "b".repeat(40) });
    const authorLimited = admit(second.state, {
      prNumber: 3,
      headSha: "c".repeat(40),
    });
    expect(authorLimited).toMatchObject({ ok: false, reason: "author_limit" });

    const third = admit(second.state, {
      prNumber: 3,
      headSha: "c".repeat(40),
      author: "another",
    });
    const dailyLimited = admit(third.state, {
      prNumber: 4,
      headSha: "d".repeat(40),
      author: "third",
    });
    expect(dailyLimited).toMatchObject({ ok: false, reason: "daily_limit" });
  });

  test("resets counters on a new UTC day", () => {
    const exhausted: PublicReviewBudgetState = {
      day: "2026-08-27",
      total: 99,
      authors: { contributor: 99 },
      attempts: { old: 99 },
    };
    expect(admit(exhausted)).toMatchObject({ ok: true, state: { total: 1 } });
  });

  test("strictly disposes the Executor before tool-less model inference", () => {
    const source = readFileSync(
      new URL("./public-review.ts", import.meta.url),
      "utf8",
    );
    const verify = source.indexOf(
      "export async function verifyPublicPrInDisposableExecutor",
    );
    const destroy = source.indexOf("await provider.destroy", verify);
    const toolLess = source.indexOf(
      "export async function runToollessPublicReview",
    );
    const inference = source.indexOf("await oneShotDetailed", toolLess);
    const review = readFileSync(
      new URL("./review.ts", import.meta.url),
      "utf8",
    );
    const daytona = readFileSync(
      new URL("../../server/sandbox/adapters/daytona.ts", import.meta.url),
      "utf8",
    );
    const publicBranch = review.indexOf("if (publicReview) {");
    const verifyCall = review.indexOf(
      "await verifyPublicPrInDisposableExecutor",
      publicBranch,
    );
    const toolLessCall = review.indexOf(
      "await runToollessPublicReview",
      publicBranch,
    );
    expect(source.slice(verify, toolLess)).toContain(
      "refs/pull/${input.prNumber}/head",
    );
    expect(source.slice(verify, toolLess)).toContain(
      "+${input.baseSha}:${baseRef}",
    );
    expect(source.slice(verify, toolLess)).not.toContain(
      "+refs/heads/${input.baseRef}:${baseRef}",
    );
    expect(source).toContain('sandboxProviderConfigured("daytona")');
    expect(source.slice(verify, toolLess)).toContain('cloneCredential: "none"');
    expect(source.slice(verify, toolLess)).toContain(
      "sourceVerification: true",
    );
    expect(source.slice(verify, toolLess)).not.toContain(
      'getSandboxProvider("microvm")',
    );
    expect(daytona).toContain("if (!sbx && !sourceVerification)");
    expect(daytona).toContain("const template = sourceVerification");
    expect(daytona).toContain("sourceVerification\n            ? undefined");
    expect(daytona).toContain("runLifecycleHooks: !sourceVerification");
    expect(daytona).toContain("await client.delete(sbx, 120)");
    expect(source).toContain("provider.destroy(sandbox.id, { strict: true })");
    expect(source.slice(verify)).not.toContain("launchRun(");
    expect(destroy).toBeGreaterThan(verify);
    expect(inference).toBeGreaterThan(toolLess);
    expect(verifyCall).toBeGreaterThan(publicBranch);
    expect(toolLessCall).toBeGreaterThan(verifyCall);
  });
});
