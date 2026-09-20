import { describe, expect, test } from "bun:test";
import {
  otherTyping,
  otherTypingUsers,
  typingLabel,
  typingPreviews,
} from "./typing";

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

  test("keeps only the drafts of the people it shows", () => {
    const presence = otherTyping(
      {
        users: ["Michiel", "Grant", "Kent"],
        drafts: { Michiel: "my own draft", Grant: "on it", Kent: "  " },
      },
      "Michiel",
    );
    expect(presence).toEqual({
      users: ["Grant", "Kent"],
      drafts: { Grant: "on it" },
    });
    expect(typingPreviews(presence)).toEqual([
      { user: "Grant", text: "on it" },
    ]);
  });

  test("a frame without drafts previews nothing", () => {
    const presence = otherTyping({ users: ["Grant"] }, "Michiel");
    expect(presence.drafts).toEqual({});
    expect(typingPreviews(presence)).toEqual([]);
  });
});
