import { describe, expect, test } from "bun:test";
import { setupRepoDefaultBranch } from "./setup-repo";

describe("setupRepoDefaultBranch", () => {
  test("uses the setup status branch when present", () => {
    expect(
      setupRepoDefaultBranch(
        { defaultBranch: "main" },
        { defaultBranch: "fallback" },
      ),
    ).toBe("main");
  });

  test("falls back to repository data during backend version skew", () => {
    expect(setupRepoDefaultBranch({}, { defaultBranch: "master" })).toBe(
      "master",
    );
  });

  test("stays renderable while neither payload has a branch", () => {
    expect(setupRepoDefaultBranch({})).toBe("");
  });
});
