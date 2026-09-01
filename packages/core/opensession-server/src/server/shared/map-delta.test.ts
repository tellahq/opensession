import { describe, expect, test } from "bun:test";
import {
  hasMapDeltaFields,
  isMapDelta,
  mergeMapDelta,
  requestedMapDelta,
} from "./map-delta";

describe("map deltas", () => {
  test("merges disjoint writes without dropping the existing map", () => {
    const current = { first: "someday", second: "tomorrow" };
    const delta = { set: { third: "next-week" }, remove: ["second"] };
    expect(isMapDelta(delta)).toBe(true);
    expect(mergeMapDelta(current, delta)).toEqual({
      first: "someday",
      third: "next-week",
    });
  });

  test("a removal wins when a key appears in both operations", () => {
    expect(
      mergeMapDelta(
        {},
        { set: { workspace: "someday" }, remove: ["workspace"] },
      ),
    ).toEqual({});
  });

  test("distinguishes a malformed delta from a legacy whole-map body", () => {
    expect(hasMapDeltaFields({ set: "not-a-map" })).toBe(true);
    expect(isMapDelta({ set: "not-a-map" })).toBe(false);
    expect(hasMapDeltaFields({ snoozes: { workspace: "someday" } })).toBe(
      false,
    );
  });

  test("treats a legacy whole map as sets only", () => {
    const delta = requestedMapDelta(
      { user: "ann", snoozes: { known: "someday" } },
      "snoozes",
    );
    expect(delta).toEqual({ set: { known: "someday" } });
    expect(mergeMapDelta({ unseen: "someday" }, delta!)).toEqual({
      known: "someday",
      unseen: "someday",
    });
  });

  test("rejects prototype keys before merge", () => {
    const poisoned = JSON.parse('{"set":{"__proto__":{"polluted":true}}}');
    expect(isMapDelta(poisoned)).toBe(false);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});
