import { describe, expect, test } from "bun:test";
import { appendNewTabs } from "./tab-order";

describe("appendNewTabs", () => {
  test("puts a new session to the right of an existing Review tab", () => {
    expect(
      appendNewTabs(["review:ws-1"], ["session-1", "review:ws-1"]),
    ).toEqual(["review:ws-1", "session-1"]);
  });

  test("treats session and pane tabs equally", () => {
    expect(
      appendNewTabs(
        ["session-1", "assets:ws-1"],
        ["session-1", "review:ws-1", "assets:ws-1"],
      ),
    ).toEqual(["session-1", "assets:ws-1", "review:ws-1"]);
  });

  test("does not rewrite a reorder when no tab was added", () => {
    expect(appendNewTabs(["one", "two"], ["two", "one"])).toEqual([
      "two",
      "one",
    ]);
  });
});
