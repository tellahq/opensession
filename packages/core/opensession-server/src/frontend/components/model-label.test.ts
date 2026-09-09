import { describe, expect, it } from "bun:test";
import { shortModelLabel, workspacePresetLabel } from "./ModelEffortSelect";
import type { ModelOption } from "../lib/api";

const models = [
  {
    id: "workspace-preset/ws-1111/opus-fable",
    provider: "pi",
    label: "Opus 5 + Fable oracle",
    aliases: [],
    efforts: [],
  },
  {
    id: "pi/anthropic/claude-sonnet-5",
    provider: "pi",
    label: "Claude Sonnet 5",
    aliases: [],
    efforts: [],
  },
] satisfies ModelOption[];

describe("workspace preset labels", () => {
  it("names the preset in its own workspace", () => {
    expect(shortModelLabel("workspace-preset/ws-1111/opus-fable", models)).toBe(
      "Opus 5 + Fable oracle",
    );
  });

  // A session can run a preset defined elsewhere (/model, a carried default)
  // while the catalog only ever holds its own workspace's presets.
  it("names a preset the catalog holds under another workspace", () => {
    expect(shortModelLabel("workspace-preset/ws-2222/opus-fable", models)).toBe(
      "Opus 5 + Fable oracle",
    );
  });

  it("falls back to the preset slug, never the storage path", () => {
    expect(shortModelLabel("workspace-preset/ws-2222/dial-ultra", models)).toBe(
      "Dial Ultra",
    );
    expect(
      shortModelLabel("pi/workspace-preset/ws-2222/dial-ultra", models),
    ).toBe("Dial Ultra");
  });

  it("leaves plain model ids alone", () => {
    expect(
      workspacePresetLabel("pi/anthropic/claude-sonnet-5", models),
    ).toBeNull();
    expect(shortModelLabel("pi/anthropic/claude-sonnet-5", models)).toBe(
      "Sonnet 5",
    );
  });

  it("uses the current preset label rather than its persisted slug", () => {
    const preset: ModelOption = {
      id: "pi/orchestrator/fable-sol",
      provider: "pi",
      label: "Orchestrator · Fable + Astra",
      aliases: [],
      efforts: [],
    };
    expect(shortModelLabel(preset.id, [preset])).toBe(preset.label);
  });

  it("capitalizes named GPT variants", () => {
    expect(shortModelLabel("pi/openai/gpt-6-astra", models)).toBe(
      "GPT-6 Astra",
    );
  });

  it("names OpenRouter's nested GLM-5.3 slug", () => {
    expect(shortModelLabel("pi/openrouter/z-ai/glm-5.3", models)).toBe(
      "GLM-5.3",
    );
  });

  it("labels sessions stored under GLM-5.3's pre-release id", () => {
    expect(shortModelLabel("pi/openrouter/stealth/ox-alpha", models)).toBe(
      "GLM-5.3",
    );
  });
});
