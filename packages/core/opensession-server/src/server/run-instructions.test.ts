import { describe, expect, test } from "bun:test";
import { buildRunInstructions } from "./run-instructions";

describe("buildRunInstructions", () => {
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
    expect(prompt).toContain("`tella-stage` `lease_editor_fixture`");
    expect(prompt).toContain("this Open Session id as `leaseKey`");
    expect(prompt).toContain(
      "Never construct a video id or report fixture evidence yourself",
    );
    expect(prompt.length).toBeLessThan(1_200);
  });
});
