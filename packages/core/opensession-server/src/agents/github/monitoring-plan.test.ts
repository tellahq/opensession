import { describe, expect, it } from "bun:test";
import {
  buildMonitoringPlanPrompt,
  isEmptyPlan,
  monitoringPlanMarkdown,
  monitoringPlanSection,
  parseMonitoringPlanOutput,
} from "./monitoring-plan";
import { normalizeReviewOptions } from "./review-options";
import { renderDeployPrompt } from "./session-notify";

const PR = {
  number: 42,
  title: "Retry failed publishes",
  body: "Fixes the outcome write.",
  additions: 10,
  deletions: 2,
  changedFiles: 1,
  files: [{ path: "src/publish.ts", additions: 10, deletions: 2 }],
} as any;

describe("monitoring plan", () => {
  it("parses the last json fence, trims, dedupes and caps lists", () => {
    const text = [
      "thinking",
      "```json",
      JSON.stringify({
        services: ["webapp", "  webapp "],
        effects: ["a", "b", "c", "d", "e"],
        risks: ["  duplicate   uploads  ", 3],
        gaps: [],
      }),
      "```",
    ].join("\n");
    expect(parseMonitoringPlanOutput(text)).toEqual({
      services: ["webapp"],
      effects: ["a", "b", "c", "d"],
      risks: ["duplicate uploads"],
      gaps: [],
    });
  });

  it("rejects output without any plan list", () => {
    expect(parseMonitoringPlanOutput("")).toBeNull();
    expect(parseMonitoringPlanOutput("no json here")).toBeNull();
    expect(parseMonitoringPlanOutput('```json\n{"services":[]}\n```')).toBe(
      null,
    );
  });

  it("renders nothing for a plan with no production effect", () => {
    const empty = { services: ["docs"], effects: [], risks: [], gaps: [] };
    expect(isEmptyPlan(empty)).toBe(true);
    expect(monitoringPlanSection(empty)).toBe("");
    expect(monitoringPlanSection(null)).toBe("");
  });

  it("renders a collapsed section with only the non-empty lists", () => {
    const section = monitoringPlanSection({
      services: ["webapp", "<api>"],
      effects: ["Error X drops to zero"],
      risks: [],
      gaps: ["No event for retries"],
    });
    expect(section).toContain("How we'll know</b> · webapp, &lt;api&gt;");
    expect(section).toContain("1 not measured");
    expect(section).toContain("**Should happen**\n- Error X drops to zero");
    expect(section).not.toContain("Could go wrong");
    expect(section).toContain("**Not measured**\n- No event for retries");
  });

  it("includes repo guidance only when configured", () => {
    const base = buildMonitoringPlanPrompt({ pr: PR, patch: "diff" });
    expect(base).not.toContain("Repository guidance");
    const guided = buildMonitoringPlanPrompt({
      pr: PR,
      patch: "diff",
      instructions: "Logs live in Loki.",
    });
    expect(guided).toContain("Repository guidance");
    expect(guided).toContain("Logs live in Loki.");
  });

  it("is opt-in through .os-review.json", () => {
    expect(normalizeReviewOptions({}).monitoringPlan).toBe(false);
    expect(
      normalizeReviewOptions({ monitoringPlan: true }).monitoringPlan,
    ).toBe(true);
    const withGuidance = normalizeReviewOptions({
      monitoringPlan: { instructions: " Use Loki. " },
    });
    expect(withGuidance.monitoringPlan).toBe(true);
    expect(withGuidance.monitoringPlanInstructions).toBe("Use Loki.");
    expect(
      normalizeReviewOptions({ monitoringPlan: { enabled: false } })
        .monitoringPlan,
    ).toBe(false);
  });
});

describe("deploy verify prompt", () => {
  it("fills known placeholders and leaves unknown ones visible", () => {
    const plan = monitoringPlanMarkdown({
      services: [],
      effects: ["A"],
      risks: ["B"],
      gaps: [],
    });
    expect(
      renderDeployPrompt(
        "PR #{{pr}} at {{ shortSha }}.\n{{plan}}\n{{nope}} {{constructor}}",
        { pr: "7", shortSha: "abc1234", plan },
      ),
    ).toBe(
      "PR #7 at abc1234.\n**Should happen**\n- A\n**Could go wrong**\n- B\n{{nope}} {{constructor}}",
    );
  });
});
