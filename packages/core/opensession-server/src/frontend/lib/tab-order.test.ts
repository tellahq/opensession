import { describe, expect, test } from "bun:test";
import { appendNewTabs, neighbourTab } from "./tab-order";

describe("neighbourTab", () => {
  const ids = ["a", "b", "c", "d", "e"];
  const any = () => true;

  test("lands on the tab to the right", () => {
    expect(neighbourTab(ids, "c", any)).toBe("d");
  });

  test("falls back to the tab on the left for the last tab", () => {
    expect(neighbourTab(ids, "e", any)).toBe("d");
  });

  test("skips tabs that cannot take over", () => {
    expect(neighbourTab(ids, "c", (id) => id !== "d")).toBe("e");
    expect(neighbourTab(ids, "e", (id) => id === "a")).toBe("a");
  });

  test("finds nothing for a lone or unknown tab", () => {
    expect(neighbourTab(["a"], "a", any)).toBeNull();
    expect(neighbourTab(ids, "z", any)).toBeNull();
  });
});

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
