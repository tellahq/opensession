import { describe, expect, test } from "bun:test";
import {
  chooseConfiguredDefaultModel,
  modelUpstreamProvider,
  pickerModelId,
  presetFitsConfiguredProviders,
} from "./model-catalog";

const openaiOnly = new Set(["openai"]);
const both = new Set(["anthropic", "openai"]);

describe("model catalog provider availability", () => {
  test("resolves native and Pi model ids to their upstream provider", () => {
    expect(modelUpstreamProvider("gpt-5.6-sol")).toBe("openai");
    expect(modelUpstreamProvider("pi/anthropic/claude-fable-5")).toBe(
      "anthropic",
    );
  });

  test("keeps preset ids intact for picker defaults", () => {
    expect(pickerModelId("dial/high")).toBe("pi/dial/high");
    expect(pickerModelId("pi/orchestrator/sol")).toBe("pi/orchestrator/sol");
  });

  test("keeps the whole Dial hidden until both account providers exist", () => {
    const openaiDial = {
      group: "dial",
      lead: { model: "pi/openai/gpt-5.6-sol" },
      supporting: [{ model: "pi/openai/gpt-5.6-sol" }],
    };
    expect(presetFitsConfiguredProviders(openaiDial, openaiOnly)).toBe(false);
    expect(presetFitsConfiguredProviders(openaiDial, both)).toBe(true);
  });

  test("shows other presets only when every named provider is configured", () => {
    expect(
      presetFitsConfiguredProviders(
        {
          group: "custom",
          lead: { model: "pi/openai/gpt-5.6-sol" },
          supporting: [{ model: "pi/anthropic/claude-fable-5" }],
        },
        openaiOnly,
      ),
    ).toBe(false);
    expect(
      presetFitsConfiguredProviders(
        {
          group: "orchestrator",
          lead: { model: "pi/openai/gpt-5.6-sol" },
          supporting: [{ model: "pi/openai/gpt-5.6-terra" }],
        },
        openaiOnly,
      ),
    ).toBe(true);
  });

  test("replaces an unavailable default with the first configured model", () => {
    const fallbacks = [
      "pi/anthropic/claude-fable-5",
      "pi/openai/gpt-5.6-sol",
      "pi/openai/gpt-5.6-terra",
    ];
    expect(
      chooseConfiguredDefaultModel("claude-fable-5", openaiOnly, fallbacks),
    ).toBe("pi/openai/gpt-5.6-sol");
    expect(
      chooseConfiguredDefaultModel("dial/medium", openaiOnly, fallbacks),
    ).toBe("pi/openai/gpt-5.6-sol");
  });

  test("preserves defaults whose required providers are configured", () => {
    expect(chooseConfiguredDefaultModel("gpt-5.6-sol", openaiOnly, [])).toBe(
      "pi/openai/gpt-5.6-sol",
    );
    expect(chooseConfiguredDefaultModel("dial/high", both, [])).toBe(
      "pi/dial/high",
    );
  });
});
