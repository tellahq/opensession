import { describe, expect, test } from "bun:test";
import { jumpKey, needsOlder, requestJump, takeJump } from "./channel-jump";

describe("opening a conversation at a message", () => {
  test("a request is taken once, by its own list", () => {
    requestJump(jumpKey("C1", "1.0"), "2.0");
    expect(takeJump("C1")).toBeUndefined();
    expect(takeJump("C1:1.0")).toBe("2.0");
    expect(takeJump("C1:1.0")).toBeUndefined();
  });

  test("loads older pages only while the message is further back", () => {
    const loaded = [{ ts: "10.0" }, { ts: "11.0" }];
    expect(needsOlder(loaded, "5.0", true, 3)).toBe(true);
    expect(needsOlder(loaded, "10.0", true, 3)).toBe(false);
    expect(needsOlder(loaded, "12.0", true, 3)).toBe(false);
    expect(needsOlder(loaded, "5.0", false, 3)).toBe(false);
    expect(needsOlder(loaded, "5.0", true, 0)).toBe(false);
    expect(needsOlder([], "5.0", true, 3)).toBe(false);
  });
});
