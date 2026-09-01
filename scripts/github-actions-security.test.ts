import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const workflowsDir = join(import.meta.dir, "..", ".github", "workflows");
const workflows = readdirSync(workflowsDir)
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .map((name) => ({
    name,
    source: readFileSync(join(workflowsDir, name), "utf8"),
  }));

const PUBLIC_COMMAND_TRIGGERS = [
  "pull_request_target",
  "issue_comment",
  "pull_request_review_comment",
  "discussion_comment",
];

function namesTrigger(source: string, trigger: string): boolean {
  return (
    new RegExp(`^\\s*${trigger}\\s*:`, "m").test(source) ||
    new RegExp(`^on:\\s*${trigger}\\s*$`, "m").test(source) ||
    new RegExp(`(?:\\[|,)\\s*${trigger}\\s*(?:,|\\])`, "m").test(source)
  );
}

describe("GitHub Actions security", () => {
  test("public comments and base-context PRs cannot trigger workflows", () => {
    for (const workflow of workflows) {
      for (const trigger of PUBLIC_COMMAND_TRIGGERS) {
        expect(
          namesTrigger(workflow.source, trigger),
          `${workflow.name} must not use ${trigger}`,
        ).toBe(false);
      }
    }
  });

  test("pull request workflows are read-only and never use self-hosted runners", () => {
    for (const workflow of workflows) {
      if (!namesTrigger(workflow.source, "pull_request")) continue;
      expect(
        workflow.source,
        `${workflow.name} must grant only contents: read`,
      ).toMatch(/^permissions:\s*\n\s+contents:\s*read\s*$/m);
      expect(
        workflow.source,
        `${workflow.name} must not grant write permissions`,
      ).not.toMatch(/^\s+[a-z-]+:\s*write\s*$/m);
      expect(
        workflow.source,
        `${workflow.name} must not use repository secrets`,
      ).not.toContain("secrets.");
      expect(
        workflow.source,
        `${workflow.name} must not run public code on a self-hosted runner`,
      ).not.toContain("self-hosted");
    }
  });

  test("every external action is pinned to a full commit SHA", () => {
    for (const workflow of workflows) {
      for (const match of workflow.source.matchAll(
        /^\s*-?\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm,
      )) {
        const spec = match[1];
        if (spec.startsWith("./")) continue;
        const separator = spec.lastIndexOf("@");
        const ref = separator >= 0 ? spec.slice(separator + 1) : "";
        expect(ref, `${workflow.name}: ${spec} must be SHA-pinned`).toMatch(
          /^[0-9a-f]{40}$/,
        );
      }
    }
  });
});
