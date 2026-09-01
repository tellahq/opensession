import { describe, expect, test } from "bun:test";
import { GLM_5_3_MODEL_ID, piProviderCatalog } from "./model-providers";
import { modelEfforts, piModelLabel } from "./models";

describe("OpenRouter model supplements", () => {
  test("catalogues GLM-5.3 at its advertised limits", () => {
    const catalog = piProviderCatalog("openrouter");
    const model = catalog?.models.find(
      (candidate) => candidate.id === GLM_5_3_MODEL_ID,
    );

    expect(catalog?.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(model).toMatchObject({
      name: "GLM-5.3",
      reasoning: true,
      input: ["text"],
      contextWindow: 1_048_576,
      maxTokens: 131_072,
      cost: { input: 1.4, output: 4.4, cacheRead: 0.26 },
    });
  });

  test("exposes the provider's supported reasoning efforts", () => {
    expect(piModelLabel(`pi/openrouter/${GLM_5_3_MODEL_ID}`)).toBe("GLM-5.3");
    expect(modelEfforts(`pi/openrouter/${GLM_5_3_MODEL_ID}`)).toEqual([
      "low",
      "high",
      "max",
    ]);
  });
});
