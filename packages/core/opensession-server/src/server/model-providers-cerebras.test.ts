import { describe, expect, test } from "bun:test";
import {
  CEREBRAS_PICKER_MODELS,
  defaultPickerModelsForProvider,
} from "./model-providers";
import {
  modelEfforts,
  piModelLabel,
  orchestratorWorkerForBridge,
} from "./models";

describe("Cerebras provider", () => {
  test("seeds the public catalog", () => {
    expect(defaultPickerModelsForProvider("cerebras")).toEqual([
      "gpt-oss-120b",
      "gemma-4-31b",
      "zai-glm-4.7",
    ]);
    expect(CEREBRAS_PICKER_MODELS).toHaveLength(3);
  });

  test("uses GPT OSS for fast workers when configured", () => {
    expect(
      orchestratorWorkerForBridge(
        "worker-fast",
        "anthropic",
        new Set(["cerebras"]),
      ),
    ).toMatchObject({ model: "cerebras/gpt-oss-120b" });
  });

  test("exposes labels and reasoning efforts", () => {
    expect(piModelLabel("pi/cerebras/gpt-oss-120b")).toBe("GPT OSS 120B");
    expect(modelEfforts("pi/cerebras/gpt-oss-120b")).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });
});
