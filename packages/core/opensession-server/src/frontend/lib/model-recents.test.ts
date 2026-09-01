import { describe, expect, it } from "bun:test";
import {
  addRecentModel,
  decodeRecentModels,
  RECENT_MODEL_LIMIT,
} from "./model-recents";

describe("recent models", () => {
  it("moves a chosen model to the front without duplicates", () => {
    expect(
      addRecentModel(
        ["pi/openai/sol", "pi/anthropic/fable"],
        "pi/anthropic/fable",
      ),
    ).toEqual(["pi/anthropic/fable", "pi/openai/sol"]);
  });

  it("keeps extra history behind the three picker rows", () => {
    const ids = Array.from(
      { length: RECENT_MODEL_LIMIT + 3 },
      (_, i) => `model-${i}`,
    );
    expect(addRecentModel(ids, "new-model")).toEqual([
      "new-model",
      ...ids.slice(0, RECENT_MODEL_LIMIT - 1),
    ]);
  });

  it("rejects malformed storage and cleans valid history", () => {
    expect(decodeRecentModels("not-json")).toBeNull();
    expect(decodeRecentModels(JSON.stringify(["a", "a", 3, "", "b"]))).toEqual([
      "a",
      "b",
    ]);
  });
});
