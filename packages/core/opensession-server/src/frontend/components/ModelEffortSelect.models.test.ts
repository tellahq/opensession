import { describe, expect, test } from "bun:test";
import type { ModelOption } from "../lib/api";
import { pickTopModels, splitModelOptions } from "./ModelEffortSelect";

function model(id: string, provider: ModelOption["provider"]): ModelOption {
  return { id, provider, label: id, aliases: [], efforts: [] };
}

describe("model picker groups", () => {
  test("keeps current Fable and Sol slugs out of legacy", () => {
    const { primary, legacy } = splitModelOptions([
      model("claude-fable-5-2", "claude"),
      model("gpt-6.2-sol", "codex"),
      model("gpt-5.5", "codex"),
    ]);

    expect(primary.map((entry) => entry.id)).toEqual([
      "claude-fable-5-2",
      "gpt-6.2-sol",
    ]);
    expect(legacy.map((entry) => entry.id)).toEqual(["gpt-5.5"]);
  });

  test("keeps Pi-routed models first class", () => {
    const { primary, legacy } = splitModelOptions([
      model("pi/anthropic/claude-fable-5-2", "pi"),
      model("pi/openai/gpt-6.2-sol", "pi"),
    ]);
    expect(primary).toHaveLength(2);
    expect(legacy).toHaveLength(0);
  });

  test("shows Opus 5.5 as the current Opus and orders it before Sonnet", () => {
    const { primary, legacy } = splitModelOptions([
      model("claude-opus-5", "claude"),
      model("claude-opus-5-5", "claude"),
    ]);
    expect(primary.map((entry) => entry.id)).toEqual(["claude-opus-5-5"]);
    expect(legacy.map((entry) => entry.id)).toEqual(["claude-opus-5"]);
    expect(
      splitModelOptions([
        model("pi/anthropic/claude-sonnet-5", "pi"),
        model("pi/anthropic/claude-opus-5-5", "pi"),
      ]).primary.map((entry) => entry.id),
    ).toEqual(["pi/anthropic/claude-opus-5-5", "pi/anthropic/claude-sonnet-5"]);
  });

  test("shows Fable 5.2 as the current Fable", () => {
    const { primary, legacy } = splitModelOptions([
      model("claude-fable-5-1", "claude"),
      model("claude-fable-5-2", "claude"),
    ]);
    expect(primary.map((entry) => entry.id)).toEqual(["claude-fable-5-2"]);
    expect(legacy.map((entry) => entry.id)).toEqual(["claude-fable-5-1"]);
  });

  test("lists Mythos 5.2 and 5.1 after Fable", () => {
    const { primary, legacy } = splitModelOptions([
      model("pi/anthropic/claude-opus-5-5", "pi"),
      model("pi/anthropic/claude-mythos-5-1", "pi"),
      model("pi/anthropic/claude-mythos-5-2", "pi"),
      model("pi/anthropic/claude-fable-5-2", "pi"),
    ]);
    expect(primary.map((entry) => entry.id)).toEqual([
      "pi/anthropic/claude-fable-5-2",
      "pi/anthropic/claude-mythos-5-2",
      "pi/anthropic/claude-mythos-5-1",
      "pi/anthropic/claude-opus-5-5",
    ]);
    expect(legacy).toEqual([]);
  });

  test("shows Sonnet 5.5 as the current Sonnet", () => {
    const { primary, legacy } = splitModelOptions([
      model("claude-sonnet-5", "claude"),
      model("claude-sonnet-5-5", "claude"),
    ]);
    expect(primary.map((entry) => entry.id)).toEqual(["claude-sonnet-5-5"]);
    expect(legacy.map((entry) => entry.id)).toEqual(["claude-sonnet-5"]);
  });

  test("puts Astra first among OpenAI models", () => {
    const { primary } = splitModelOptions([
      model("pi/openai/gpt-6-luna", "pi"),
      model("pi/openai/gpt-6.2-sol", "pi"),
      model("pi/openai/gpt-6.2-astra", "pi"),
      model("pi/openai/gpt-6.1-terra", "pi"),
    ]);

    expect(primary.map((entry) => entry.id)).toEqual([
      "pi/openai/gpt-6.2-astra",
      "pi/openai/gpt-6.2-sol",
      "pi/openai/gpt-6.1-terra",
      "pi/openai/gpt-6-luna",
    ]);
  });
});

describe("top-level models", () => {
  const ids = (list: { id: string }[]) => list.map((entry) => entry.id);

  test("lists the curated best five and moves the rest under More models", () => {
    const { primary } = splitModelOptions(
      [
        "claude-fable-5-2",
        "claude-mythos-5-2",
        "claude-mythos-5-1",
        "claude-opus-5-5",
        "claude-sonnet-5-5",
        "claude-haiku-5-5",
        "gpt-6.2-astra",
        "gpt-6.2-sol",
        "gpt-6.1-terra",
        "gpt-6-luna",
      ].map((id) =>
        model(
          `pi/${id.startsWith("gpt") ? "openai" : "anthropic"}/${id}`,
          "pi",
        ),
      ),
    );
    const { top, more } = pickTopModels(primary);
    expect(ids(top)).toEqual([
      "pi/anthropic/claude-fable-5-2",
      "pi/anthropic/claude-opus-5-5",
      "pi/anthropic/claude-sonnet-5-5",
      "pi/openai/gpt-6.2-astra",
      "pi/openai/gpt-6.2-sol",
    ]);
    expect(ids(more)).toEqual([
      "pi/anthropic/claude-mythos-5-2",
      "pi/anthropic/claude-mythos-5-1",
      "pi/anthropic/claude-haiku-5-5",
      "pi/openai/gpt-6.1-terra",
      "pi/openai/gpt-6-luna",
    ]);
  });

  test("fills missing picks from the catalog order", () => {
    const { top, more } = pickTopModels([
      model("pi/anthropic/claude-opus-5-5", "pi"),
      model("pi/xai/grok-5", "pi"),
      model("pi/meta/llama-5", "pi"),
    ]);
    expect(ids(top)).toEqual([
      "pi/anthropic/claude-opus-5-5",
      "pi/xai/grok-5",
      "pi/meta/llama-5",
    ]);
    expect(more).toEqual([]);
  });
});
