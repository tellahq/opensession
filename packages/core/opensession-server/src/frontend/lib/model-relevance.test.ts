import { describe, expect, test } from "bun:test";
import { modelFamily, relevantModels } from "./model-relevance";

describe("modelFamily", () => {
  test("splits the version and speed suffix out of the id", () => {
    expect(modelFamily("pi/anthropic/claude-opus-4-8")).toEqual({
      family: "claude-opus",
      version: [4, 8],
      speedVariant: false,
    });
    expect(modelFamily("pi/openai/gpt-6.2-sol").family).toBe("gpt-sol");
    expect(modelFamily("pi/acme/kimi-k2.6").family).toBe("kimi-k");
    expect(modelFamily("pi/acme/glm5.2-fast")).toEqual({
      family: "glm",
      version: [5, 2],
      speedVariant: true,
    });
    expect(modelFamily("pi/acme/zai-glm-4.7").family).toBe("glm");
  });
});

describe("relevantModels", () => {
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
  const catalog = [
    "pi/anthropic/claude-opus-5-5",
    "pi/anthropic/claude-opus-4-8",
    "pi/anthropic/claude-haiku-5-5",
    "pi/openai/gpt-6.1-terra",
    "pi/openai/gpt-6-luna",
    "pi/xai/grok-4.5",
    "pi/xai/grok-4.3",
    "pi/moonshot/kimi-k3",
    "pi/moonshot/kimi-k2.7-code",
    "pi/moonshot/kimi-k2.7-code-highspeed",
    "pi/hostb/zai-glm-4.7",
    "pi/hosta/glm-5.2",
    "pi/hosta/glm5.2-fast",
    "pi/hosta/glm-5.1",
    "pi/hosta/kimi-k3",
    "pi/hosta/kimi-k3-fast",
    "pi/hosta/kimi-k2.6",
    "pi/hosta/deepseek-v4-flash-0731-fast",
    "pi/router/z-ai/glm-5.3",
  ].map((id) => ({ id }));

  test("keeps one current serving of each model", () => {
    expect(ids(relevantModels(catalog, catalog))).toEqual([
      "pi/anthropic/claude-opus-5-5",
      "pi/anthropic/claude-haiku-5-5",
      "pi/openai/gpt-6.1-terra",
      "pi/openai/gpt-6-luna",
      "pi/xai/grok-4.5",
      "pi/moonshot/kimi-k3",
      "pi/moonshot/kimi-k2.7-code",
      "pi/hosta/deepseek-v4-flash-0731-fast",
      "pi/router/z-ai/glm-5.3",
    ]);
  });

  test("keeps the model in use even when it would be left out", () => {
    const kept = relevantModels(
      catalog,
      catalog,
      (o) => o.id === "pi/hosta/glm-5.1",
    );
    expect(ids(kept)).toContain("pi/hosta/glm-5.1");
  });
});
