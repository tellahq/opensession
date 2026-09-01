import { describe, expect, test } from "bun:test";
import { otherTypingUsers, typingLabel } from "./typing";

describe("typing presence", () => {
  test("filters this person and deduplicates other devices", () => {
    expect(
      otherTypingUsers(
        ["Michiel", "Grant", "grant de Bruin", "Kent"],
        "Michiel Westerbeek",
      ),
    ).toEqual(["Grant", "Kent"]);
  });

  test("names one person and summarizes a group", () => {
    expect(typingLabel([])).toBeNull();
    expect(typingLabel(["Grant"])).toBe("Grant is typing…");
    expect(typingLabel(["Grant", "Kent"])).toBe("Several people are typing…");
  });
});
