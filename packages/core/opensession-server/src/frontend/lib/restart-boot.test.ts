import { describe, expect, test } from "bun:test";
import { bootTransition } from "./restart-boot";

describe("restart boot detection", () => {
  test("treats the first observed boot id as a baseline", () => {
    expect(bootTransition(null, "old-process")).toBe("initial");
  });

  test("only reports a restart after the process identity changes", () => {
    expect(bootTransition("old-process", "old-process")).toBe("same");
    expect(bootTransition("old-process", "new-process")).toBe("changed");
  });

  test("ignores missing and malformed identities", () => {
    expect(bootTransition("old-process", null)).toBe("invalid");
    expect(bootTransition("old-process", "")).toBe("invalid");
  });
});
