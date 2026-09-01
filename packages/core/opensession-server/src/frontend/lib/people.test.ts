import { describe, expect, test } from "bun:test";
import { peopleMentionMatches, type Person } from "./people";

const roster: Person[] = [
  { name: "Michiel", fullName: "Michiel Westerbeek" },
  { name: "Kent", fullName: "Kent de Bruin" },
  { name: "Jaap", fullName: "Jaap Frolich" },
];

describe("peopleMentionMatches", () => {
  test("a bare trigger returns the complete roster with the current person first", () => {
    expect(
      peopleMentionMatches("", roster, "Kent").map((row) => row.insert),
    ).toEqual(["Kent", "Michiel", "Jaap"]);
  });

  test("filters by any part of a full name", () => {
    expect(peopleMentionMatches("bruin", roster, "Kent")).toEqual([
      {
        display: "Kent",
        insert: "Kent",
        kind: "person",
        sub: "Kent de Bruin",
      },
    ]);
  });
});
