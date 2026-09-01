import { describe, expect, test } from "bun:test";
import {
  parseDismissed,
  slackShareDismissKey,
  withDismissed,
} from "./slack-share-dismiss";

describe("slack share dismissals", () => {
  test("a key names the session and the PR it announces", () => {
    expect(slackShareDismissKey("os-1", 42)).toBe("os-1:42");
  });

  test("reads a stored list, and shrugs off anything else", () => {
    expect(parseDismissed(JSON.stringify(["os-1:42"]))).toEqual(["os-1:42"]);
    expect(parseDismissed("")).toEqual([]);
    expect(parseDismissed(null)).toEqual([]);
    expect(parseDismissed("not json")).toEqual([]);
    expect(parseDismissed(JSON.stringify({ "os-1:42": true }))).toEqual([]);
    expect(parseDismissed(JSON.stringify(["os-1:42", 7, null]))).toEqual([
      "os-1:42",
    ]);
  });

  test("adds newest first and keeps the list bounded", () => {
    expect(withDismissed(["os-1:1"], "os-2:2")).toEqual(["os-2:2", "os-1:1"]);
    expect(withDismissed([], "os-1:1")).toEqual(["os-1:1"]);
    const many = Array.from({ length: 200 }, (_, i) => `os-${i}:1`);
    const next = withDismissed(many, "os-new:1");
    expect(next).toHaveLength(200);
    expect(next[0]).toBe("os-new:1");
    expect(next).not.toContain("os-199:1");
  });

  test("an already dismissed card returns the same list, so no write happens", () => {
    const list = ["os-1:1"];
    expect(withDismissed(list, "os-1:1")).toBe(list);
    expect(withDismissed(list, "")).toBe(list);
  });
});
