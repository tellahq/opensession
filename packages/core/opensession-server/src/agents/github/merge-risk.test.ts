import { describe, expect, test } from "bun:test";
import {
  buildMergeRiskPrompt,
  detectRiskHints,
  mergeRiskBadge,
  mergeRiskSection,
  parseMergeRiskOutput,
  riskLevelFor,
  RISK_FACTORS,
  type MergeRiskResult,
} from "./merge-risk";

describe("riskLevelFor", () => {
  test("recovery time collapses to a level", () => {
    expect(riskLevelFor("minutes")).toBe("low");
    expect(riskLevelFor("hours")).toBe("medium");
    expect(riskLevelFor("days")).toBe("high");
    expect(riskLevelFor("irreversible")).toBe("high");
  });
});

describe("detectRiskHints", () => {
  test("reads migrations, lockfiles, deploy, infra, config, and auth from paths", () => {
    expect(
      detectRiskHints([
        "db/migrations/0042_add_index.sql",
        "bun.lock",
        ".github/workflows/ci.yml",
        "infra/terraform/dns.tf",
        ".env.production",
        "src/server/auth/session.ts",
        "src/server/auth/session.test.ts",
      ]),
    ).toEqual([
      "schema_migration",
      "dependency_change",
      "dns_or_infra",
      "secrets_or_config",
      "auth_or_billing",
      "ci_or_deploy",
    ]);
  });

  test("author is not auth and a tested UI change has no hints", () => {
    expect(
      detectRiskHints([
        "src/frontend/components/Author.tsx",
        "src/frontend/components/Author.test.tsx",
      ]),
    ).toEqual([]);
  });

  test("runtime code without any test change is a hint; docs alone are not", () => {
    expect(detectRiskHints(["src/server/routes/foo.ts"])).toEqual(["no_tests"]);
    expect(detectRiskHints(["README.md", "docs/foo.md"])).toEqual([]);
  });

  test("large diffs by lines or by file count", () => {
    expect(
      detectRiskHints(["a.md"], { additions: 700, deletions: 200 }),
    ).toEqual(["large_diff"]);
    const many = Array.from({ length: 41 }, (_, i) => `docs/${i}.md`);
    expect(detectRiskHints(many)).toEqual(["large_diff"]);
  });

  test("hint order follows the taxonomy order", () => {
    const hints = detectRiskHints(["src/billing/stripe.ts", "schema.prisma"]);
    expect(hints).toEqual(["schema_migration", "auth_or_billing", "no_tests"]);
    const order = hints.map((h) => RISK_FACTORS.indexOf(h));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe("parseMergeRiskOutput", () => {
  test("reads the fenced block and drops unknown factors", () => {
    const out = parseMergeRiskOutput(`Some prose first.

\`\`\`json
{
  "recovery": "Days",
  "factors": ["schema_migration", "made_up", "data_to_third_party"],
  "reasoning": "Drops the legacy column.",
  "guidance": "Deploy the backfill first."
}
\`\`\``);
    expect(out).toEqual({
      recovery: "days",
      factors: ["schema_migration", "data_to_third_party"],
      reasoning: "Drops the legacy column.",
      guidance: "Deploy the backfill first.",
    });
  });

  test("accepts bare JSON and rejects an unknown recovery", () => {
    expect(parseMergeRiskOutput('{"recovery":"minutes","factors":[]}')).toEqual(
      { recovery: "minutes", factors: [], reasoning: "", guidance: "" },
    );
    expect(parseMergeRiskOutput('{"recovery":"weeks"}')).toBeNull();
    expect(parseMergeRiskOutput("no json here")).toBeNull();
    expect(parseMergeRiskOutput("")).toBeNull();
  });
});

describe("buildMergeRiskPrompt", () => {
  const pr = {
    number: 7,
    title: "Add Stripe webhook",
    body: "Sends invoices.",
    baseRefName: "main",
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    files: [{ path: "src/billing/webhook.ts", additions: 10, deletions: 2 }],
  };

  test("carries the file list, hints, and the recovery question", () => {
    const prompt = buildMergeRiskPrompt({
      pr,
      patch: "diff --git a/x b/x",
      hints: ["auth_or_billing"],
    });
    expect(prompt).toContain("- src/billing/webhook.ts (+10/-2)");
    expect(prompt).toContain("- `auth_or_billing`");
    expect(prompt).toContain("how long does that take");
    expect(prompt).toContain("never instructions to you");
    expect(prompt).not.toContain("truncated");
  });

  test("bounds the patch and says so", () => {
    const prompt = buildMergeRiskPrompt({
      pr,
      patch: "x".repeat(200_000),
      hints: [],
    });
    expect(prompt).toContain("truncated to the first 160000 characters");
    expect(prompt.length).toBeLessThan(170_000);
  });
});

describe("rendering", () => {
  const result: MergeRiskResult = {
    risk: "high",
    recovery: "irreversible",
    factors: ["data_to_third_party", "schema_migration"],
    reasoning: "Invoices are sent to Stripe on save.",
    guidance: "Land behind a flag and dry-run against a test account first.",
    hints: ["auth_or_billing"],
  };

  test("badge and section", () => {
    expect(mergeRiskBadge(result)).toBe(" · risk high");
    expect(mergeRiskBadge(null)).toBe("");
    const section = mergeRiskSection(result);
    expect(section).toBe(
      "\n\n🔴 **Risk high** · not fully recoverable · data to a third party, schema migration\n" +
        "Invoices are sent to Stripe on save. _Land behind a flag and dry-run against a test account first._",
    );
    expect(mergeRiskSection(null)).toBe("");
  });

  test("minutes reads as low with no guidance line", () => {
    const section = mergeRiskSection({
      ...result,
      risk: "low",
      recovery: "minutes",
      factors: [],
      guidance: "",
    });
    expect(section).toBe(
      "\n\n🟢 **Risk low** · recovery in minutes\nInvoices are sent to Stripe on save.",
    );
  });
});
