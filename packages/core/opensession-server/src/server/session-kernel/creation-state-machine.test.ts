import { describe, expect, test } from "bun:test";
import {
  CREATION_STATE_TRANSITIONS,
  nextCreationState,
  type CreationEvent,
  type CreationState,
} from "./creation-state-machine";

const path: Array<[CreationState | undefined, CreationEvent, CreationState]> = [
  [undefined, "plan", "planned"],
  ["planned", "preparation_started", "preparing"],
  ["preparing", "opening_dispatched", "opening_dispatched"],
  ["opening_dispatched", "succeeded", "ready"],
];

describe("creation state reducer", () => {
  test("follows the planned to ready lifecycle", () => {
    for (const [from, event, to] of path)
      expect(nextCreationState(from, event)).toBe(to);
  });

  test("rejects physical results before their effect was dispatched", () => {
    expect(nextCreationState(undefined, "succeeded")).toBeUndefined();
    expect(nextCreationState("planned", "succeeded")).toBeUndefined();
    expect(nextCreationState("preparing", "succeeded")).toBeUndefined();
    expect(nextCreationState("ready", "preparation_started")).toBeUndefined();
  });

  test("an opening Stop is terminal and cannot later succeed", () => {
    expect(nextCreationState("opening_dispatched", "cancelled")).toBe(
      "cancelled",
    );
    expect(nextCreationState("cancelled", "succeeded")).toBeUndefined();
    expect(nextCreationState("cancelled", "cancelled")).toBe("cancelled");
  });

  test("every nonterminal phase can fail without inventing recovery", () => {
    for (const state of ["planned", "preparing", "opening_dispatched"] as const)
      expect(CREATION_STATE_TRANSITIONS[state].failed).toBe("failed");
    expect(nextCreationState("failed", "preparation_started")).toBeUndefined();
  });
});
