import { expect, test } from "bun:test";
import { gitFailureReason } from "./worktree";

test("gitFailureReason skips progress chatter", () => {
  expect(
    gitFailureReason(
      "Preparing worktree (checking out 'feat')\nfatal: '/tmp/wt' already exists\n",
    ),
  ).toBe("'/tmp/wt' already exists");
  expect(gitFailureReason("something odd\n")).toBe("something odd");
  expect(gitFailureReason("")).toBe("git failed");
});
