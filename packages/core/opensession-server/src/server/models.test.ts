import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountProviderForModel,
  contextWindowFor,
  fallbackTier,
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
    expect(toPiModel("claude-opus-5-5")).toBe("pi/anthropic/claude-opus-5-5");
    expect(toPiModel("gpt-6-astra")).toBe("pi/openai/gpt-6-astra");
    expect(toPiModel("gpt-6.1-sol")).toBe("pi/openai/gpt-6.1-sol");
  });

  test("upgrades old Opus selections without changing historical labels", () => {
    for (const old of ["claude-opus-5", "claude-opus-4-8"]) {
      for (const prefix of [
        "",
        "anthropic/",
        "pi/anthropic/",
        "claude/anthropic/",
      ]) {
        expect(toPiModel(prefix + old)).toBe("pi/anthropic/claude-opus-5-5");
      }
    }
    for (const alias of ["opus", "opus5", "opus5.5"]) {
      expect(resolveModel(alias)?.id).toBe("claude-opus-5-5");
    }
    expect(modelLabel("claude-opus-5")).toBe("Claude Opus 5");
    expect(modelLabel("claude-opus-5-5")).toBe("Claude Opus 5.5");
    expect(modelEfforts("pi/anthropic/claude-opus-5-5")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(contextWindowFor("pi/anthropic/claude-opus-5-5")).toBe(1_000_000);
    expect(fallbackTier("pi/anthropic/claude-opus-5-5")).toBe(3);
  });

  test("upgrades old Sonnet selections without changing historical labels", () => {
    for (const old of ["claude-sonnet-5", "claude-sonnet-4-6"]) {
      for (const prefix of [
        "",
        "anthropic/",
        "pi/anthropic/",
        "claude/anthropic/",
      ]) {
        expect(toPiModel(prefix + old)).toBe("pi/anthropic/claude-sonnet-5-5");
      }
    }
    for (const alias of ["sonnet", "sonnet5", "sonnet5.5"]) {
      expect(resolveModel(alias)?.id).toBe("claude-sonnet-5-5");
    }
    expect(modelLabel("claude-sonnet-5")).toBe("Claude Sonnet 5");
    expect(modelLabel("claude-sonnet-5-5")).toBe("Claude Sonnet 5.5");
    expect(modelEfforts("pi/anthropic/claude-sonnet-5-5")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(contextWindowFor("pi/anthropic/claude-sonnet-5-5")).toBe(1_000_000);
    expect(fallbackTier("pi/anthropic/claude-sonnet-5-5")).toBe(1);
  });

  test("upgrades old Haiku selections without changing historical labels", () => {
    for (const prefix of [
      "",
      "anthropic/",
      "pi/anthropic/",
      "claude/anthropic/",
    ]) {
      expect(toPiModel(prefix + "claude-haiku-4-5")).toBe(
        "pi/anthropic/claude-haiku-5-5",
      );
    }
    for (const alias of ["haiku", "haiku4.5", "haiku5.5"]) {
      expect(resolveModel(alias)?.id).toBe("claude-haiku-5-5");
    }
    expect(modelLabel("claude-haiku-4-5")).toBe("Claude Haiku 4.5");
    expect(modelLabel("claude-haiku-5-5")).toBe("Claude Haiku 5.5");
    expect(modelEfforts("pi/anthropic/claude-haiku-5-5")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(contextWindowFor("pi/anthropic/claude-haiku-5-5")).toBe(1_000_000);
    expect(fallbackTier("pi/anthropic/claude-haiku-5-5")).toBe(0);
  });

  test("preserves explicit Pi ids and case-sensitive model suffixes", () => {
    expect(toPiModel("pi/wafer/glm-5.2")).toBe("pi/wafer/glm-5.2");
    expect(toPiModel(" pi/My-Gateway/Qwen/Qwen3-Coder ")).toBe(
      "pi/my-gateway/Qwen/Qwen3-Coder",
    );
    expect(resolveModel("pi/My-Gateway/Qwen/Qwen3-Coder")?.id).toBe(
      "pi/my-gateway/Qwen/Qwen3-Coder",
    );
    expect(explicitEngineFor("pi/openai/gpt-6.1-sol")).toBe("pi");
  });

  test("reroutes retired OpenAI slugs", () => {
    expect(toPiModel("gpt-5.5")).toBe("pi/openai/gpt-6.1-sol");
    expect(toPiModel("openai/gpt-5.5")).toBe("pi/openai/gpt-6.1-sol");
    expect(toPiModel("pi/openai/gpt-5.4-mini")).toBe("pi/openai/gpt-6-luna");
    expect(resolveModel("gpt5.5")?.id).toBe("gpt-6.1-sol");
    expect(resolveModel("pi/openai/gpt-5.5")?.id).toBe("pi/openai/gpt-6.1-sol");
  });

  test("upgrades GPT-6 Sol to GPT-6.1 Sol", () => {
    expect(toPiModel("gpt-6-sol")).toBe("pi/openai/gpt-6.1-sol");
    expect(toPiModel("pi/openai/gpt-6-sol")).toBe("pi/openai/gpt-6.1-sol");
    expect(resolveModel("sol")?.id).toBe("gpt-6.1-sol");
    expect(modelLabel("gpt-6-sol")).toBe("GPT-6 Sol");
    expect(modelLabel("pi/openai/gpt-6-sol")).toBe("GPT-6 Sol");
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
    expect(routeModel("openai/gpt-6.1-sol")).toEqual({
      engine: "pi",
      model: "pi/openai/gpt-6.1-sol",
    });
  });

  test("resolves provider paths and Pi ids", () => {
    expect(resolveModel("pi/anthropic/claude-opus-5-5")?.provider).toBe("pi");
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
    expect(accountProviderForModel("pi/anthropic/claude-opus-5-5")).toBe(
      "claude",
    );
    expect(accountProviderForModel("pi/openai/gpt-6.1-sol")).toBe("codex");
    expect(accountProviderForModel("pi/wafer/glm-5.2")).toBeUndefined();
  });

  test("keeps engine keys provider-neutral", () => {
    expect(modelEngineKey("pi/anthropic/claude-opus-5-5")).toBe(
      "claude-opus-5-5",
    );
  });

  test("builds a Pi-only fallback chain", () => {
    const first = nextFallbackModel(
      "pi/anthropic/claude-fable-5-1",
      new Set(),
      "pi/openai/gpt-6.1-sol",
    );
    expect(first?.id.startsWith("pi/")).toBe(true);
    expect(
      fallbackPlan("pi/anthropic/claude-fable-5-1", "pi/openai/gpt-6.1-sol"),
    ).toSatisfy((hops) => hops.every((hop) => hop.id.startsWith("pi/")));
  });

  test("falls back from Fable to Astra before configured Sol or Opus", () => {
    for (const primary of [
      "claude-fable-5-1",
      "pi/anthropic/claude-fable-5-1",
    ]) {
      for (const preferred of ["pi/openai/gpt-6.1-sol", "claude-opus-5-5"]) {
        expect(nextFallbackModel(primary, new Set(), preferred)).toEqual({
          id: "pi/openai/gpt-6-astra",
          mode: "auto",
        });
        expect(fallbackPlan(primary, preferred).slice(0, 2)).toEqual([
          { id: "pi/openai/gpt-6-astra", mode: "auto" },
          { id: "pi/openai/gpt-6.1-sol", mode: "auto" },
        ]);
      }
    }
  });

  test("keeps Sol available when Astra is exhausted", () => {
    expect(
      nextFallbackModel(
        "pi/anthropic/claude-fable-5-1",
        new Set(["pi/openai/gpt-6-astra"]),
        "claude-opus-5-5",
      ),
    ).toEqual({ id: "pi/openai/gpt-6.1-sol", mode: "auto" });
  });

  test("keeps automatic fallback disabled when requested", () => {
    expect(fallbackPlan("pi/anthropic/claude-fable-5-1", "none")).toEqual([]);
    expect(fallbackPlan("pi/anthropic/claude-fable-5-1", undefined)).toEqual(
      [],
    );
  });

  test("crosses exhausted Haiku sessions to OpenAI", () => {
    expect(automaticFallbackModel("claude-haiku-4-5")).toBe(
      "pi/openai/gpt-6-luna",
    );
    expect(interactiveFallbackModel("claude-haiku-4-5")).toBe(
      "pi/openai/gpt-6-luna",
    );
    expect(interactiveFallbackModel("pi/anthropic/claude-haiku-4-5")).toBe(
      "pi/openai/gpt-6-luna",
    );

    process.env.OPENSESSION_HAIKU_FALLBACK_MODEL = "gpt-6.1-sol";
    expect(automaticFallbackModel("claude-haiku-4-5")).toBe(
      "pi/openai/gpt-6.1-sol",
    );
  });

  test("labels Pi models without an engine prefix", () => {
    expect(modelLabel("pi/openai/gpt-6-astra")).toBe("GPT-6 Astra");
    expect(modelLabel("pi/openai/gpt-6.1-sol")).toBe("GPT-6.1 Sol");
  });

  test("exposes Astra's reasoning efforts and aliases", () => {
    expect(resolveModel("astra")?.id).toBe("gpt-6-astra");
    expect(resolveModel("gpt6")?.id).toBe("gpt-6-astra");
    expect(modelEfforts("pi/openai/gpt-6-astra")).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  test("upgrades Sol, Terra and Luna without changing historical labels", () => {
    for (const name of ["sol", "terra", "luna"]) {
      const current = name === "luna" ? "gpt-6-luna" : `gpt-6.1-${name}`;
      const previous = `gpt-5.6-${name}`;
      expect(resolveModel(name)?.id).toBe(current);
      for (const prefix of ["", "openai/", "pi/openai/", "codex/openai/"]) {
        expect(toPiModel(`${prefix}${previous}`)).toBe(`pi/openai/${current}`);
        expect(toPiModel(`${prefix}${current}`)).toBe(`pi/openai/${current}`);
        expect(resolveModel(`${prefix}${previous}`)?.id).toBe(
          prefix ? `pi/openai/${current}` : current,
        );
        expect(modelEfforts(`${prefix}${current}`)).toEqual([
          "none",
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
        ]);
        expect(contextWindowFor(`${prefix}${current}`)).toBe(272_000);
      }
      const label = name.charAt(0).toUpperCase() + name.slice(1);
      expect(modelLabel(previous)).toBe(`GPT-5.6 ${label}`);
      expect(modelLabel(`pi/openai/${previous}`)).toBe(`GPT-5.6 ${label}`);
      expect(modelLabel(current)).toBe(
        name === "luna" ? "GPT-6 Luna" : `GPT-6.1 ${label}`,
      );
      expect(accountProviderForModel(current)).toBe("codex");
      expect(fallbackTier(current)).toBe(3);
    }
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
    expect(pickerIds).toContain("pi/openai/gpt-6-astra");
    expect(pickerIds).toContain("pi/openai/gpt-6.1-sol");
    expect(pickerIds).toContain("pi/openai/gpt-6-luna");
    expect(pickerIds).not.toContain("pi/openai/gpt-5.6-sol");
    expect(pickerIds).not.toContain("pi/openai/gpt-6-sol");
    expect(pickerIds).not.toContain("pi/openai/gpt-5.6-luna");
    expect(pickerIds).toContain("pi/anthropic/claude-fable-5-1");
  });

  test("deduplicates retired pickerModels after routing", () => {
    pickerConfigDir = mkdtempSync(join(tmpdir(), "pi-picker-models-"));
    const path = join(pickerConfigDir, "pi.json");
    writeFileSync(
      path,
      JSON.stringify({
        enabled: true,
        pickerModels: [
          "pi/openai/gpt-5.6-sol",
          "pi/openai/gpt-5.6-luna",
          "pi/openai/gpt-6.1-sol",
          "pi/anthropic/claude-opus-5",
          "pi/anthropic/claude-opus-4-8",
        ],
      }),
    );
    process.env.OPENSESSION_PI_CONFIG = path;

    refreshPickerModels();

    expect(
      KNOWN_MODELS.filter((model) => model.id === "pi/openai/gpt-6.1-sol"),
    ).toHaveLength(1);
    expect(
      KNOWN_MODELS.filter(
        (model) => model.id === "pi/anthropic/claude-opus-5-5",
      ),
    ).toHaveLength(1);
    expect(
      KNOWN_MODELS.some((model) => model.id === "pi/anthropic/claude-opus-5"),
    ).toBe(false);
    expect(
      KNOWN_MODELS.some((model) => model.id === "pi/anthropic/claude-opus-4-8"),
    ).toBe(false);
  });
});

test("interactive fallback is on by default and a session can opt out", () => {
  const model = "pi/anthropic/claude-fable-5-1";
  expect(interactiveFallbackModel(model)).toBe(automaticFallbackModel(model));
  expect(interactiveFallbackModel(model, true)).toBe(
    automaticFallbackModel(model),
  );
  for (const primary of [model, "codex-best-available", undefined]) {
    expect(interactiveFallbackModel(primary, false)).toBe("none");
    expect(
      fallbackPlan(primary, interactiveFallbackModel(primary, false)),
    ).toEqual([]);
  }
});

test("retired preset ids resolve to the model they led", () => {
  expect(resolveModel("pi/dial/high")?.id).toBe("gpt-6.1-sol");
  expect(resolveModel("dial/opus-fable")?.id).toBe("claude-opus-5-5");
  expect(toPiModel("pi/orchestrator/fable")).toBe(
    "pi/anthropic/claude-fable-5-1",
  );
  expect(toPiModel("pi/dial/ultra")).toBe("pi/anthropic/claude-fable-5-1");
  expect(resolveModel("pi/orchestrator/missing")).toBeNull();
  expect(resolveModel("pi/workspace-preset/ws-acme/opus")).toBeNull();
  expect(toPiModel("pi/workspace-preset/ws-acme/opus")).toBeUndefined();
});
