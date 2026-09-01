import { describe, expect, test } from "bun:test";
import { isCompleteReviewOutput, parseReviewOutput } from "./review";

const canonical = `Reviewed the diff.

\`\`\`json
{
  "verdict": "request_changes",
  "confidence": 2,
  "summary_markdown": "Unsafe until the P1 is fixed.",
  "findings": [
    { "path": "src/a.ts", "line": 12, "side": "RIGHT", "severity": "P1", "title": "Bug", "body": "It breaks." }
  ]
}
\`\`\``;

// The shape Sol emitted on PR #5286: summary/file/details aliases and a 0-1
// self-certainty confidence instead of the 1-5 merge-safety scale.
const solShaped = `I'll map the full diff first, then trace callers.

\`\`\`json
{
  "verdict": "request_changes",
  "confidence": 0.98,
  "summary": "The primitive cannot render image-backed Lottie files correctly.",
  "findings": [
    { "severity": "P1", "file": "packages/core/render_engine/src/skia_primitives.rs", "line": 5480, "title": "Load embedded assets", "details": "Animation::from_str has no resource provider." },
    { "severity": "P2", "file": "packages/core/render_engine/src/skia_primitives.rs", "line": 5510, "title": "Apply blend mode", "details": "Renders directly onto the canvas." }
  ]
}
\`\`\``;

// The native Codex code-review schema Sol emitted on PR #5891. It is fully
// structured, but uses a different top-level verdict and nested locations.
const codexReviewShaped = `\`\`\`json
{
  "findings": [
    {
      "title": "[P2] Verify the original video stream duration",
      "body": "The container duration can reflect a longer audio stream.",
      "confidence_score": 0.97,
      "priority": 2,
      "code_location": {
        "absolute_file_path": "/home/ubuntu/worktrees/pr-review/packages/core/render_engine/src/engine.rs",
        "line_range": { "start": 1816, "end": 1818 }
      }
    }
  ],
  "overall_correctness": "patch is incorrect",
  "overall_explanation": "The verification can extend a visual clip beyond video EOF.",
  "overall_confidence_score": 0.95
}
\`\`\``;

describe("parseReviewOutput", () => {
  test("parses the canonical contract", () => {
    const out = parseReviewOutput(canonical);
    expect(out?.verdict).toBe("request_changes");
    expect(out?.confidence).toBe(2);
    expect(out?.summary_markdown).toBe("Unsafe until the P1 is fixed.");
    expect(out?.findings).toHaveLength(1);
    expect(out?.findings?.[0]).toMatchObject({
      path: "src/a.ts",
      line: 12,
      body: "It breaks.",
    });
  });

  test("accepts summary/file/details aliases", () => {
    const out = parseReviewOutput(solShaped);
    expect(out?.verdict).toBe("request_changes");
    expect(out?.summary_markdown).toBe(
      "The primitive cannot render image-backed Lottie files correctly.",
    );
    expect(out?.findings).toHaveLength(2);
    expect(out?.findings?.[0]).toMatchObject({
      path: "packages/core/render_engine/src/skia_primitives.rs",
      line: 5480,
      severity: "P1",
      body: "Animation::from_str has no resource provider.",
    });
  });

  test("accepts the native Codex code-review schema", () => {
    const out = parseReviewOutput(
      codexReviewShaped,
      "/home/ubuntu/worktrees/pr-review",
    );
    expect(isCompleteReviewOutput(out)).toBe(true);
    expect(out).toMatchObject({
      verdict: "request_changes",
      summary_markdown:
        "The verification can extend a visual clip beyond video EOF.",
      findings: [
        {
          path: "packages/core/render_engine/src/engine.rs",
          line: 1816,
          severity: "P2",
          title: "Verify the original video stream duration",
          body: "The container duration can reflect a longer audio stream.",
        },
      ],
    });
    expect(out?.confidence).toBe(2);
  });

  test("accepts a clean native Codex verdict without findings", () => {
    const clean = `\`\`\`json
{
  "findings": [],
  "overall_correctness": "patch is correct",
  "overall_explanation": "The duration correction is safe.",
  "overall_confidence_score": 0.95
}
\`\`\``;
    const out = parseReviewOutput(clean, "/home/ubuntu/worktrees/pr-review");
    expect(isCompleteReviewOutput(out)).toBe(true);
    expect(out?.verdict).toBe("approve");
    expect(out?.confidence).toBe(5);
    expect(out?.findings).toEqual([]);
  });

  test("drops absolute finding paths outside the pinned checkout", () => {
    const out = parseReviewOutput(codexReviewShaped, "/different/checkout");
    expect(isCompleteReviewOutput(out)).toBe(true);
    expect(out?.findings).toEqual([]);
  });

  test("derives merge safety when confidence is missing or uses another scale", () => {
    expect(parseReviewOutput(solShaped)?.confidence).toBe(2);
    const percent = canonical.replace('"confidence": 2', '"confidence": 98');
    expect(parseReviewOutput(percent)?.confidence).toBe(2);
    expect(parseReviewOutput(percent)?.findings).toHaveLength(1);

    const advisory = canonical
      .replace('"verdict": "request_changes"', '"verdict": "approve"')
      .replace('"confidence": 2,', "")
      .replace('"severity": "P1"', '"severity": "P3"');
    expect(parseReviewOutput(advisory)?.confidence).toBe(4);
  });

  test("canonical names win over aliases when both are present", () => {
    const both = `\`\`\`json
{ "verdict": "comment", "confidence": 4, "summary_markdown": "Real summary.", "summary": "Alias.", "findings": [ { "path": "src/a.ts", "file": "wrong.ts", "line": 3, "body": "Real body.", "details": "Alias." } ] }
\`\`\``;
    const out = parseReviewOutput(both);
    expect(out?.summary_markdown).toBe("Real summary.");
    expect(out?.findings?.[0]).toMatchObject({
      path: "src/a.ts",
      body: "Real body.",
    });
  });

  test("requires a postable verdict and summary", () => {
    expect(isCompleteReviewOutput(parseReviewOutput(canonical))).toBe(true);
    expect(isCompleteReviewOutput(null)).toBe(false);
    expect(
      isCompleteReviewOutput(parseReviewOutput('{"verdict":"approve"}')),
    ).toBe(false);
    expect(
      isCompleteReviewOutput(
        parseReviewOutput(
          '{"verdict":"thinking","summary_markdown":"Still reviewing."}',
        ),
      ),
    ).toBe(false);
  });
});
