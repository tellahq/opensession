import { describe, expect, test } from "bun:test";
import { buildRunInstructions } from "./run-instructions";

describe("buildRunInstructions", () => {
  test("limits automatic reviewers to unattended automation pull requests", async () => {
    const prompt = buildRunInstructions({
      isAsk: false,
      osSessionId: "os-test",
      prReviewer: "tellahq/super-developers",
    });

    expect(prompt).toContain(
      "For a PR this unattended automation creates, request `tellahq/super-developers` as reviewer.",
    );
    expect(prompt).toContain(
      "Never add this automatic reviewer to an existing PR or a human-steered PR.",
    );

    const automationSource = await Bun.file(
      new URL("./automations.ts", import.meta.url),
    ).text();
    const interactiveSource = await Bun.file(
      new URL("./run-session.ts", import.meta.url),
    ).text();
    expect(automationSource).toContain("prReviewer: automation.prReviewer");
    expect(interactiveSource).not.toContain("prReviewer:");
  });

  test("keeps a standard interactive prompt minimal", () => {
    const prompt = buildRunInstructions({
      isAsk: false,
      osSessionId: "os-test",
      inProcessMcp: {
        "opensession-sessions": {},
        "opensession-portals": {},
      },
    });

    expect(prompt.match(/^## .+$/gm)).toEqual([
      "## Data handling",
      "## Finish your turns",
      "## References",
      "## PR attribution",
      "## New sessions",
      "## Preview links",
      "## Media",
    ]);
    expect(prompt).toContain(
      "For PRs outside the current primary repository, write `<repo>#<number>`, never bare `#<number>`.",
    );
    expect(prompt).toContain(
      "For editors, call `opensession-portals` `set_editor_preview_path`",
    );
    expect(prompt).toContain(
      "at least 60 seconds, 2+ clips, and a ready non-empty transcript",
    );
    expect(prompt).toContain("to prevent reuse by another active session");
    expect(prompt.length).toBeLessThan(1_200);
  });
});
