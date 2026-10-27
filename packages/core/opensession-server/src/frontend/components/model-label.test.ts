import { describe, expect, it } from "bun:test";
import { shortModelLabel, workspacePresetLabel } from "./ModelEffortSelect";
import type { ModelOption } from "../lib/api";

const models = [
  {
    id: "pi/anthropic/claude-sonnet-5",
    provider: "pi",
    label: "Claude Sonnet 5",
    aliases: [],
    efforts: [],
  },
] satisfies ModelOption[];

describe("model labels", () => {
  it("names a retired workspace preset by its slug, never the storage path", () => {
    expect(shortModelLabel("workspace-preset/ws-2222/dial-ultra", models)).toBe(
      "Dial Ultra",
    );
    expect(
      shortModelLabel("pi/workspace-preset/ws-2222/dial-ultra", models),
    ).toBe("Dial Ultra");
  });

  it("names a retired preset by the model it ran on", () => {
    expect(shortModelLabel("pi/orchestrator/fable-sol", models)).toBe(
      "Fable 5.1",
    );
    expect(shortModelLabel("dial/high", models)).toBe("GPT-6.1 Sol");
  });

  it("leaves plain model ids alone", () => {
    expect(workspacePresetLabel("pi/anthropic/claude-sonnet-5")).toBeNull();
    expect(shortModelLabel("pi/anthropic/claude-sonnet-5", models)).toBe(
      "Sonnet 5",
    );
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
