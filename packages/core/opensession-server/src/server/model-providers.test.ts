import { describe, expect, test } from "bun:test";
import { normalizeModelProviderConfig } from "./model-providers";

describe("model provider config", () => {
  test("normalizes keys, picker models, and account restrictions", () => {
    expect(
      normalizeModelProviderConfig({
        enabled: true,
        pickerModels: [
          "pi/wafer/glm-5.2",
          "pi/openrouter/stealth/ox-alpha",
          42,
        ],
        bridge: { accounts: ["claude-1"], openaiAccounts: ["chatgpt-1"] },
        providers: {
          wafer: { apiKey: "secret", baseURL: "https://pass.wafer.ai/v1" },
        },
      }),
    ).toMatchObject({
      enabled: true,
      pickerModels: ["pi/wafer/glm-5.2", "pi/openrouter/z-ai/glm-5.3"],
      bridgeAccountIds: ["claude-1"],
      openaiAccounts: ["chatgpt-1"],
      providers: {
        wafer: { apiKey: "secret", baseURL: "https://pass.wafer.ai/v1" },
      },
    });
  });
});
