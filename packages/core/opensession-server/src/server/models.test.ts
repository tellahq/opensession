import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountProviderForModel,
  automaticFallbackModel,
  explicitEngineFor,
  fallbackPlan,
  interactiveFallbackModel,
  modelEfforts,
  modelEngineKey,
  modelLabel,
  nextFallbackModel,
  piModelLabel,
  resolveModel,
  routeModel,
  toPiModel,
  KNOWN_MODELS,
  refreshPickerModels,
} from "./models";

const originalPiConfig = process.env.OPENSESSION_PI_CONFIG;
const originalModelProvidersConfig =
  process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG;
const originalHaikuFallbackModel = process.env.OPENSESSION_HAIKU_FALLBACK_MODEL;
let pickerConfigDir = "";
afterEach(() => {
  if (originalPiConfig === undefined) delete process.env.OPENSESSION_PI_CONFIG;
  else process.env.OPENSESSION_PI_CONFIG = originalPiConfig;
  if (originalModelProvidersConfig === undefined)
    delete process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG;
  else
    process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG =
      originalModelProvidersConfig;
  if (originalHaikuFallbackModel === undefined)
    delete process.env.OPENSESSION_HAIKU_FALLBACK_MODEL;
  else
    process.env.OPENSESSION_HAIKU_FALLBACK_MODEL = originalHaikuFallbackModel;
  refreshPickerModels();
  if (pickerConfigDir)
    rmSync(pickerConfigDir, { recursive: true, force: true });
  pickerConfigDir = "";
});

describe("Pi-only model routing", () => {
  test("maps native model ids to Pi", () => {
    expect(toPiModel("claude-opus-5")).toBe("pi/anthropic/claude-opus-5");
    expect(toPiModel("gpt-5.6-sol")).toBe("pi/openai/gpt-5.6-sol");
  });

  test("preserves explicit Pi ids", () => {
    expect(toPiModel("pi/wafer/glm-5.2")).toBe("pi/wafer/glm-5.2");
    expect(explicitEngineFor("pi/openai/gpt-5.6-sol")).toBe("pi");
  });

  test("reroutes retired OpenAI slugs", () => {
    expect(toPiModel("gpt-5.5")).toBe("pi/openai/gpt-5.6-sol");
    expect(toPiModel("openai/gpt-5.5")).toBe("pi/openai/gpt-5.6-sol");
    expect(toPiModel("pi/openai/gpt-5.4-mini")).toBe("pi/openai/gpt-5.6-luna");
    expect(resolveModel("gpt5.5")?.id).toBe("gpt-5.6-sol");
    expect(resolveModel("pi/openai/gpt-5.5")?.id).toBe("pi/openai/gpt-5.6-sol");
  });

  test("upgrades retired Fable 5 ids to Fable 5.1", () => {
    expect(resolveModel("claude-fable-5")?.id).toBe("claude-fable-5-1");
    expect(toPiModel("anthropic/claude-fable-5")).toBe(
      "pi/anthropic/claude-fable-5-1",
    );
    expect(toPiModel("pi/anthropic/claude-fable-5")).toBe(
      "pi/anthropic/claude-fable-5-1",
    );
  });

  test("routes every accepted id to Pi", () => {
    expect(routeModel("claude-fable-5-1")).toEqual({
      engine: "pi",
      model: "pi/anthropic/claude-fable-5-1",
    });
    expect(routeModel("openai/gpt-5.6-sol")).toEqual({
      engine: "pi",
      model: "pi/openai/gpt-5.6-sol",
    });
  });

  test("resolves provider paths and Pi ids", () => {
    expect(resolveModel("pi/anthropic/claude-opus-5")?.provider).toBe("pi");
    expect(resolveModel("wafer/glm-5.2")?.id).toBe("pi/wafer/glm-5.2");
  });

  test("resolves an unambiguous provider model by its visible slug", () => {
    pickerConfigDir = mkdtempSync(join(tmpdir(), "pi-provider-alias-"));
    process.env.OPENSESSION_PI_CONFIG = join(pickerConfigDir, "pi.json");
    process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG = join(
      pickerConfigDir,
      "providers.json",
    );
    writeFileSync(
      process.env.OPENSESSION_PI_CONFIG,
      JSON.stringify({
        enabled: true,
        pickerModels: ["pi/openrouter/z-ai/glm-5.3"],
      }),
    );
    writeFileSync(
      process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG,
      JSON.stringify({
        enabled: true,
        providers: { openrouter: { apiKey: "test-key" } },
      }),
    );
    refreshPickerModels();

    expect(resolveModel("glm-5.3")?.id).toBe("pi/openrouter/z-ai/glm-5.3");
    expect(resolveModel("GLM 5.3")?.id).toBe("pi/openrouter/z-ai/glm-5.3");
  });

  test("routes GLM-5.3's pre-release id to the official model", () => {
    expect(toPiModel("pi/openrouter/stealth/ox-alpha")).toBe(
      "pi/openrouter/z-ai/glm-5.3",
    );
    expect(piModelLabel("pi/openrouter/stealth/ox-alpha")).toBe("GLM-5.3");
    expect(modelEfforts("pi/openrouter/stealth/ox-alpha")).toEqual([
      "low",
      "high",
      "max",
    ]);
  });

  test("selects the account pool from Pi's upstream provider", () => {
    expect(accountProviderForModel("pi/anthropic/claude-opus-5")).toBe(
      "claude",
    );
    expect(accountProviderForModel("pi/openai/gpt-5.6-sol")).toBe("codex");
    expect(accountProviderForModel("pi/wafer/glm-5.2")).toBeUndefined();
  });

  test("keeps engine keys provider-neutral", () => {
    expect(modelEngineKey("pi/anthropic/claude-opus-5")).toBe("claude-opus-5");
    expect(modelEngineKey("pi/dial/opus-fable")).toBe("dial/opus-fable");
  });

  test("builds a Pi-only fallback chain", () => {
    const first = nextFallbackModel(
      "pi/anthropic/claude-fable-5-1",
      new Set(),
      "pi/openai/gpt-5.6-sol",
    );
    expect(first?.id.startsWith("pi/")).toBe(true);
    expect(
      fallbackPlan("pi/anthropic/claude-fable-5-1", "pi/openai/gpt-5.6-sol"),
    ).toSatisfy((hops) => hops.every((hop) => hop.id.startsWith("pi/")));
  });

  test("crosses exhausted Haiku sessions to OpenAI", () => {
    expect(automaticFallbackModel("claude-haiku-4-5")).toBe(
      "pi/openai/gpt-5.6-luna",
    );
    expect(interactiveFallbackModel("claude-haiku-4-5")).toBe(
      "pi/openai/gpt-5.6-luna",
    );
    expect(interactiveFallbackModel("pi/anthropic/claude-haiku-4-5")).toBe(
      "pi/openai/gpt-5.6-luna",
    );

    process.env.OPENSESSION_HAIKU_FALLBACK_MODEL = "gpt-5.6-sol";
    expect(automaticFallbackModel("claude-haiku-4-5")).toBe(
      "pi/openai/gpt-5.6-sol",
    );
  });

  test("labels Pi models without an engine prefix", () => {
    expect(modelLabel("pi/openai/gpt-5.6-sol")).toBe("GPT-5.6 Sol");
  });

  test("seeds subscription models without the retired pickerModels setting", () => {
    pickerConfigDir = mkdtempSync(join(tmpdir(), "pi-picker-models-"));
    const path = join(pickerConfigDir, "pi.json");
    writeFileSync(path, JSON.stringify({ enabled: true, pickerModels: [] }));
    process.env.OPENSESSION_PI_CONFIG = path;

    refreshPickerModels();

    const pickerIds = KNOWN_MODELS.filter(
      (model) => model.provider === "pi",
    ).map((model) => model.id);
    expect(pickerIds).toContain("pi/openai/gpt-5.6-sol");
    expect(pickerIds).toContain("pi/anthropic/claude-fable-5-1");
  });

  test("deduplicates retired pickerModels after routing", () => {
    pickerConfigDir = mkdtempSync(join(tmpdir(), "pi-picker-models-"));
    const path = join(pickerConfigDir, "pi.json");
    writeFileSync(
      path,
      JSON.stringify({
        enabled: true,
        pickerModels: ["pi/openai/gpt-5.6-sol"],
      }),
    );
    process.env.OPENSESSION_PI_CONFIG = path;

    refreshPickerModels();

    expect(
      KNOWN_MODELS.filter((model) => model.id === "pi/openai/gpt-5.6-sol"),
    ).toHaveLength(1);
  });
});
