import { describe, expect, test } from "bun:test";
import {
  catalogRows,
  configuredProviderCatalog,
  mergeCatalogs,
  normalizeCatalogModel,
  normalizeModelProviderConfig,
  FALLBACK_CONTEXT_WINDOW,
  FALLBACK_MAX_TOKENS,
} from "./model-providers";
import { buildPiThirdPartyProviderPlan } from "./pi-runner";
import { discoveryUrl, fetchProviderModels } from "./model-discovery";

describe("custom provider config", () => {
  test("parses api, name, discovery flag and inline catalog rows", () => {
    const cfg = normalizeModelProviderConfig({
      providers: {
        "my-gateway": {
          apiKey: "k",
          baseURL: "https://gateway.example/v1",
          api: "openai-completions",
          name: "My gateway",
          discoverModels: true,
          catalog: {
            "big-model": {
              display_name: "Big Model",
              context_length: 200000,
              max_output_tokens: 65536,
              input_modalities: ["text", "image"],
              efforts: ["low", "HIGH", "bogus"],
              cost: { input: 1.5, output: 6, cache_read: 0.2 },
            },
          },
        },
      },
    });
    expect(cfg?.providers?.["my-gateway"]).toMatchObject({
      apiKey: "k",
      baseURL: "https://gateway.example/v1",
      api: "openai-completions",
      name: "My gateway",
      discoverModels: true,
      catalog: {
        "big-model": {
          id: "big-model",
          name: "Big Model",
          contextWindow: 200000,
          maxTokens: 65536,
          input: ["text", "image"],
          efforts: ["low", "high"],
          reasoning: true,
          cost: { input: 1.5, output: 6, cacheRead: 0.2, cacheWrite: 0 },
        },
      },
    });
  });

  test("rejects an unknown api and drops junk fields", () => {
    const cfg = normalizeModelProviderConfig({
      providers: {
        gw: { apiKey: "k", api: "anthropic-messages", name: "   " },
      },
    });
    expect(cfg?.providers?.gw).toEqual({ apiKey: "k" });
  });

  test("layers discovered, file and inline rows (inline wins)", () => {
    const cfg = normalizeModelProviderConfig(
      {
        providers: {
          gw: {
            apiKey: "k",
            baseURL: "https://gw.test/v1",
            catalogFile: "gw-catalog.json",
            discovered: {
              at: "2026-09-01T00:00:00Z",
              models: {
                data: [{ id: "a", context_length: 1000 }, { id: "b" }],
              },
            },
            catalog: { a: { maxTokens: 999 } },
          },
        },
      },
      (file) => {
        expect(file).toBe("gw-catalog.json");
        return { a: { id: "a", contextWindow: 5000 }, c: { id: "c" } };
      },
    );
    const catalog = cfg?.providers?.gw.catalog;
    expect(Object.keys(catalog || {}).sort()).toEqual(["a", "b", "c"]);
    expect(catalog?.a).toEqual({
      id: "a",
      contextWindow: 5000,
      maxTokens: 999,
    });
    expect(cfg?.providers?.gw.discovered?.at).toBe("2026-09-01T00:00:00Z");
  });

  test("catalogRows accepts maps, lists and wrapped lists", () => {
    expect(Object.keys(catalogRows({ x: {}, y: {} }))).toEqual(["x", "y"]);
    expect(Object.keys(catalogRows([{ id: "x" }, { noid: 1 }]))).toEqual(["x"]);
    expect(Object.keys(catalogRows({ models: [{ id: "m" }] }))).toEqual(["m"]);
    expect(Object.keys(catalogRows({ data: [{ id: "d" }] }))).toEqual(["d"]);
    expect(catalogRows("nope")).toEqual({});
  });

  test("normalizeCatalogModel ignores half-specified pricing", () => {
    expect(normalizeCatalogModel("m", { cost: { input: 1 } })?.cost).toBe(
      undefined,
    );
    expect(normalizeCatalogModel("m", { vision: true })?.input).toEqual([
      "text",
      "image",
    ]);
    expect(normalizeCatalogModel("", {})).toBeUndefined();
  });

  test("mergeCatalogs merges field by field", () => {
    expect(
      mergeCatalogs(
        { a: { id: "a", name: "A", contextWindow: 1 } },
        undefined,
        { a: { id: "a", contextWindow: 2 } },
      ),
    ).toEqual({ a: { id: "a", name: "A", contextWindow: 2 } });
  });
});

describe("configuredProviderCatalog", () => {
  test("is empty without api, name or rows", () => {
    expect(configuredProviderCatalog("gw", { apiKey: "k" })).toBeUndefined();
    expect(configuredProviderCatalog("gw", undefined)).toBeUndefined();
  });

  test("fills missing row fields with the fallback stub", () => {
    const catalog = configuredProviderCatalog("gw", {
      api: "openai-completions",
      baseURL: "https://gw.test/v1",
      catalog: { m: { id: "m", contextWindow: 500000 } },
    });
    expect(catalog).toMatchObject({
      name: "gw",
      api: "openai-completions",
      baseUrl: "https://gw.test/v1",
    });
    expect(catalog?.models[0]).toEqual({
      id: "m",
      name: "m",
      reasoning: true,
      thinkingLevelMap: {},
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 500000,
      maxTokens: FALLBACK_MAX_TOKENS,
    });
  });
});

describe("buildPiThirdPartyProviderPlan with configured providers", () => {
  test("a declared api makes an unknown slug runnable", () => {
    const plan = buildPiThirdPartyProviderPlan({
      providerID: "my-gateway",
      modelID: "some-model",
      apiKey: "k",
      baseURL: "https://gateway.example/v1",
      configured: {
        apiKey: "k",
        baseURL: "https://gateway.example/v1",
        api: "openai-completions",
        name: "My gateway",
      },
      builtinModelIds: [],
    });
    if ("error" in plan) throw new Error(plan.error);
    expect(plan.config).toMatchObject({
      apiKey: "k",
      api: "openai-completions",
      name: "My gateway",
      baseUrl: "https://gateway.example/v1",
    });
    expect(plan.config.models).toEqual([
      expect.objectContaining({
        id: "some-model",
        contextWindow: FALLBACK_CONTEXT_WINDOW,
        maxTokens: FALLBACK_MAX_TOKENS,
      }),
    ]);
  });

  test("keeps a case-sensitive catalog model id in the provider plan", () => {
    const modelID = "Qwen/Qwen3-Coder";
    const plan = buildPiThirdPartyProviderPlan({
      providerID: "my-gateway",
      modelID,
      apiKey: "k",
      baseURL: "https://gateway.example/v1",
      configured: {
        apiKey: "k",
        baseURL: "https://gateway.example/v1",
        api: "openai-completions",
        catalog: {
          [modelID]: { id: modelID, contextWindow: 262_144 },
        },
      },
      builtinModelIds: [],
    });
    if ("error" in plan) throw new Error(plan.error);
    expect(plan.config.models).toEqual([
      expect.objectContaining({ id: modelID, contextWindow: 262_144 }),
    ]);
  });

  test("a declared api without a base URL is refused", () => {
    const plan = buildPiThirdPartyProviderPlan({
      providerID: "my-gateway",
      modelID: "m",
      apiKey: "k",
      configured: { apiKey: "k", api: "openai-completions" },
      builtinModelIds: [],
    });
    expect("error" in plan && plan.error).toMatch(/no base URL/);
  });

  test("an unknown slug without an api still fails clearly", () => {
    const plan = buildPiThirdPartyProviderPlan({
      providerID: "my-gateway",
      modelID: "m",
      apiKey: "k",
      baseURL: "https://gateway.example/v1",
      configured: { apiKey: "k", baseURL: "https://gateway.example/v1" },
      builtinModelIds: [],
    });
    expect("error" in plan && plan.error).toMatch(/openai-completions/);
  });

  test("a catalog row replaces the fallback stub", () => {
    const plan = buildPiThirdPartyProviderPlan({
      providerID: "my-gateway",
      modelID: "big-model",
      apiKey: "k",
      baseURL: "https://gateway.example/v1",
      configured: {
        apiKey: "k",
        baseURL: "https://gateway.example/v1",
        api: "openai-completions",
        catalog: {
          "big-model": {
            id: "big-model",
            name: "Big Model",
            contextWindow: 1_000_000,
            maxTokens: 100_000,
            input: ["text", "image"],
            cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
          },
        },
      },
      builtinModelIds: [],
    });
    if ("error" in plan) throw new Error(plan.error);
    expect(plan.config.models).toEqual([
      expect.objectContaining({
        id: "big-model",
        name: "Big Model",
        contextWindow: 1_000_000,
        maxTokens: 100_000,
        input: ["text", "image"],
        cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
      }),
    ]);
  });

  test("a catalog row on a Pi-known provider overrides the builtin entry", () => {
    const plan = buildPiThirdPartyProviderPlan({
      providerID: "together",
      modelID: "org/model",
      apiKey: "k",
      baseURL: "https://other.example/v1",
      configured: {
        apiKey: "k",
        baseURL: "https://other.example/v1",
        catalog: { "org/model": { id: "org/model", contextWindow: 64_000 } },
      },
      builtinModelIds: ["org/model", "org/other"],
    });
    if ("error" in plan) throw new Error(plan.error);
    // No api/name guessed for a Pi-known slug; only the model table changes.
    expect(plan.config.api).toBeUndefined();
    expect(plan.config.name).toBeUndefined();
    expect(plan.config.models).toEqual([
      expect.objectContaining({ id: "org/model", contextWindow: 64_000 }),
    ]);
  });

  test("a catalog row overrides our own catalog for the same id", () => {
    const plan = buildPiThirdPartyProviderPlan({
      providerID: "wafer",
      modelID: "glm-5.2",
      apiKey: "k",
      configured: {
        apiKey: "k",
        catalog: { "glm-5.2": { id: "glm-5.2", maxTokens: 4096 } },
      },
      builtinModelIds: [],
    });
    if ("error" in plan) throw new Error(plan.error);
    const models = plan.config.models as Array<Record<string, unknown>>;
    expect(models.filter((m) => m.id === "glm-5.2")).toHaveLength(1);
    expect(models.find((m) => m.id === "glm-5.2")?.maxTokens).toBe(4096);
    expect(plan.config.baseUrl).toBe("https://pass.wafer.ai/v1");
  });
});

describe("model discovery", () => {
  test("builds the models URL", () => {
    expect(discoveryUrl("https://gw.test/v1/")).toBe(
      "https://gw.test/v1/models",
    );
  });

  test("reads the OpenAI list shape with extended fields", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return Response.json({
        object: "list",
        data: [
          { id: "m1", object: "model" },
          { id: "m2", context_length: 32000, max_output_tokens: 4000 },
        ],
      });
    }) as unknown as typeof fetch;
    const models = await fetchProviderModels(
      "https://gw.test/v1",
      "k",
      fetchImpl,
    );
    expect(calls[0][0]).toBe("https://gw.test/v1/models");
    expect((calls[0][1]?.headers as Record<string, string>).Authorization).toBe(
      "Bearer k",
    );
    expect(models).toEqual({
      m1: { id: "m1" },
      m2: { id: "m2", contextWindow: 32000, maxTokens: 4000 },
    });
  });

  test("fails on non-2xx and on an empty list", async () => {
    const bad = (async () =>
      new Response("nope", { status: 401 })) as unknown as typeof fetch;
    await expect(
      fetchProviderModels("https://gw.test", "k", bad),
    ).rejects.toThrow(/401/);
    const empty = (async () =>
      Response.json({ data: [] })) as unknown as typeof fetch;
    await expect(
      fetchProviderModels("https://gw.test", "k", empty),
    ).rejects.toThrow(/no model ids/);
  });
});

describe("Settings writes", () => {
  test("reject invalid custom providers before writing", async () => {
    const { mkdtempSync, readFileSync, writeFileSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const { setModelProvider } = await import("./model-providers");
    const dir = mkdtempSync(join(tmpdir(), "os-model-providers-"));
    const path = join(dir, "model-providers.json");
    const original = JSON.stringify({
      providers: { gw: { apiKey: "stored", baseURL: "https://gw.test/v1" } },
    });
    writeFileSync(path, original);
    const prev = process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG;
    process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG = path;
    try {
      expect(() =>
        setModelProvider("gw", {
          api: "openai-completions",
          baseURL: "",
        }),
      ).toThrow(/needs a base URL/);
      expect(readFileSync(path, "utf-8")).toBe(original);
    } finally {
      if (prev === undefined)
        delete process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG;
      else process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG = prev;
    }
  });

  test("preserve catalog, catalogFile and discovered rows", async () => {
    const { mkdtempSync, readFileSync, writeFileSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const { setModelProvider, setProviderDiscovered } =
      await import("./model-providers");
    const dir = mkdtempSync(join(tmpdir(), "os-model-providers-"));
    const path = join(dir, "model-providers.json");
    writeFileSync(
      path,
      JSON.stringify({
        providers: {
          gw: {
            apiKey: "old",
            baseURL: "https://gw.test/v1",
            catalogFile: "gw.json",
            catalog: { m: { contextWindow: 1 } },
            future: "keep",
          },
        },
      }),
    );
    const prev = process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG;
    process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG = path;
    try {
      setModelProvider("gw", {
        apiKey: "new",
        api: "openai-completions",
        name: "Gateway",
        discoverModels: true,
      });
      setProviderDiscovered("gw", {
        at: "2026-09-01T00:00:00Z",
        models: { d: { id: "d" } },
      });
      setModelProvider("gw", { api: "", discoverModels: false });
      expect(JSON.parse(readFileSync(path, "utf-8")).providers.gw).toEqual({
        apiKey: "new",
        baseURL: "https://gw.test/v1",
        catalogFile: "gw.json",
        catalog: { m: { contextWindow: 1 } },
        future: "keep",
        name: "Gateway",
        discovered: { at: "2026-09-01T00:00:00Z", models: { d: { id: "d" } } },
      });
    } finally {
      if (prev === undefined)
        delete process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG;
      else process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG = prev;
    }
  });
});
