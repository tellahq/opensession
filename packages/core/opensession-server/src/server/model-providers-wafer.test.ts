import { describe, expect, test } from "bun:test";
import {
  WAFER_PICKER_MODELS,
  defaultPickerModelsForProvider,
  piProviderCatalog,
  waferModelEfforts,
} from "./model-providers";
import { modelEfforts, piModelLabel } from "./models";

describe("Wafer provider", () => {
  test("keeps a lowercase public catalog", () => {
    expect(defaultPickerModelsForProvider("wafer")).toEqual(
      WAFER_PICKER_MODELS,
    );
    for (const id of WAFER_PICKER_MODELS) expect(id).toBe(id.toLowerCase());
  });

  test("builds Pi's provider catalog", () => {
    const catalog = piProviderCatalog("wafer");
    expect(catalog?.baseUrl).toBe("https://pass.wafer.ai/v1");
    expect(catalog?.models.map((model) => model.id)).toEqual([
      ...WAFER_PICKER_MODELS,
    ]);
  });

  test("exposes labels and efforts", () => {
    expect(piModelLabel("pi/wafer/deepseek-v4-flash-0731-fast")).toBe(
      "DeepSeek V4 Flash",
    );
    expect(modelEfforts("pi/wafer/glm-5.2")).toEqual([
      ...waferModelEfforts("glm-5.2"),
    ]);
  });
});
