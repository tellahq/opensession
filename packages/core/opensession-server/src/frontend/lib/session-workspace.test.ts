import { describe, expect, test } from "bun:test";
import { sessionHasWorkspace } from "./session-workspace";

describe("sessionHasWorkspace", () => {
  test("read-only PR review sessions retain their workspace", () => {
    expect(
      sessionHasWorkspace({
        branch: "remove-this--",
        worktreeDir: "/home/ubuntu/projects/tella-fusion",
      }),
    ).toBe(true);
  });

  test("ordinary ask sessions without code context have no workspace", () => {
    expect(sessionHasWorkspace({ branch: null, worktreeDir: null })).toBe(
      false,
    );
  });
});
