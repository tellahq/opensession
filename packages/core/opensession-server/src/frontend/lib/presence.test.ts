import { describe, expect, test } from "bun:test";
import { dedupeViewers, facepileAvatarStyle, otherViewers } from "./presence";

describe("otherViewers", () => {
  test("your own devices come out: all of them, not just the first", () => {
    expect(otherViewers(["Kent", "Kent", "Michiel"], "Kent")).toEqual([
      "Michiel",
    ]);
  });

  test("alone on a session is an empty pile, not a face of yourself", () => {
    expect(otherViewers(["Kent"], "Kent")).toEqual([]);
  });

  test("a full display name still matches the first-name form presence sends", () => {
    expect(otherViewers(["Kent", "Michiel"], "Kent de Bruin")).toEqual([
      "Michiel",
    ]);
  });

  test("teammates are kept", () => {
    expect(otherViewers(["Michiel", "Johnny"], "Kent")).toEqual([
      "Michiel",
      "Johnny",
    ]);
  });

  test("without a known identity nobody is filtered: better a face too many than a wrong one", () => {
    expect(otherViewers(["Kent", "Michiel"], "")).toEqual(["Kent", "Michiel"]);
  });
});

describe("dedupeViewers", () => {
  test("one face per person, carrying their device count", () => {
    expect(dedupeViewers(["Michiel", "Johnny", "Michiel"])).toEqual([
      { name: "Michiel", count: 2 },
      { name: "Johnny", count: 1 },
    ]);
  });
});

describe("facepileAvatarStyle", () => {
  test("keeps the leftmost face on top and rings the full avatar", () => {
    expect(facepileAvatarStyle(0, 3, "var(--bg)")).toEqual({
      zIndex: 3,
      boxShadow: "var(--avatar-edge), 0 0 0 2px var(--bg)",
    });
    expect(facepileAvatarStyle(2, 3, "var(--bg)").zIndex).toBe(1);
  });
});
