import { describe, expect, test } from "bun:test";
import type { ModelOption } from "../lib/api";
import { splitModelOptions } from "./ModelEffortSelect";

function model(id: string, provider: ModelOption["provider"]): ModelOption {
  return { id, provider, label: id, aliases: [], efforts: [] };
}

describe("model picker groups", () => {
  test("keeps current Fable and Sol slugs out of legacy", () => {
    const { primary, legacy } = splitModelOptions([
      model("claude-fable-5-1", "claude"),
      model("gpt-5.6-sol", "codex"),
      model("gpt-5.5", "codex"),
    ]);

    expect(primary.map((entry) => entry.id)).toEqual([
      "claude-fable-5-1",
      "gpt-5.6-sol",
    ]);
    expect(legacy.map((entry) => entry.id)).toEqual(["gpt-5.5"]);
  });

  test("keeps Pi-routed models first class", () => {
    const { primary, legacy } = splitModelOptions([
      model("pi/anthropic/claude-fable-5-1", "pi"),
      model("pi/openai/gpt-5.6-sol", "pi"),
    ]);
    expect(primary).toHaveLength(2);
    expect(legacy).toHaveLength(0);
  });
});
