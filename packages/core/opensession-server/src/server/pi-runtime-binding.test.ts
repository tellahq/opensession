import { afterEach, describe, expect, test } from "bun:test";
import {
  __resetPiSdkCacheForTest,
  createPiRuntimeBinding,
  prewarmPiSdk,
  type CreatePiRuntimeBindingInput,
} from "./pi-runtime-binding";
import type { CodexAccount } from "./codex-accounts";

const oauth: CodexAccount = {
  id: "oauth-1",
  name: "OAuth one",
  kind: "home",
  value: "/unused",
  createdAt: "2026-01-01T00:00:00.000Z",
};
const apiKey: CodexAccount = {
  ...oauth,
  id: "key-1",
  name: "Key one",
  kind: "api_key",
  value: "sk-test",
};

function harness(
  options: {
    account?: CodexAccount;
    transport?: "inprocess" | "bridge";
    refuseModels?: boolean;
  } = {},
) {
  const calls: Array<[string, ...any[]]> = [];
  const models = new Map<string, any>();
  const builtin = (provider: string, id: string) =>
    models.set(`${provider}/${id}`, { provider, id });
  if (options.account?.kind === "home") builtin("openai-codex", "gpt-test");
  if (options.account?.kind === "api_key") builtin("openai", "gpt-test");
  builtin("anthropic", "claude-test");
  builtin("wafer", "wafer-test");
  builtin("google-vertex", "gemini-test");
  const runtime = {
    getModel(provider: string, id: string) {
      return models.get(`${provider}/${id}`);
    },
    getModels(provider: string) {
      return [...models.values()].filter(
        (model) => model.provider === provider,
      );
    },
    registerProvider(provider: string, config: any) {
      calls.push(["registerProvider", provider, config]);
      if (!options.refuseModels)
        for (const model of config.models || []) builtin(provider, model.id);
    },
    registerNativeProvider(provider: any) {
      calls.push(["registerNativeProvider", provider]);
      if (!options.refuseModels)
        for (const model of provider.models || [])
          builtin("anthropic", model.id);
    },
    async setRuntimeApiKey(provider: string, key: string) {
      calls.push(["setRuntimeApiKey", provider, key]);
    },
  };
  const sdk = {
    ModelRuntime: {
      async create(config: any) {
        calls.push(["create", config]);
        return runtime;
      },
    },
  } as any;
  const deps = {
    loadSdk: async () => {
      calls.push(["loadSdk"]);
      return sdk;
    },
    readOpenaiAccounts: () => {
      calls.push(["readOpenaiAccounts"]);
      return [];
    },
    pickOpenaiAccount: (
      _model: string,
      _accounts: any,
      _affinity: string,
      out: { reason?: string },
    ) => {
      calls.push(["pickOpenaiAccount"]);
      out.reason = "strict pin";
      return options.account!;
    },
    buildSeededOpenaiAuth: () => ({
      seeded: {
        openai: {
          type: "oauth" as const,
          access: "access",
          refresh: "no-refresh",
          expires: 2_000_000,
        },
      },
    }),
    anthropicTransport: () => options.transport || ("inprocess" as const),
    buildAnthropicProvider: (input: any) => {
      calls.push(["buildAnthropicProvider", input]);
      return { id: "anthropic", models: input.builtinModels as any };
    },
    ensureAnthropicBridge: () => {
      calls.push(["ensureAnthropicBridge"]);
      return { url: "http://bridge", key: "bridge-key" };
    },
    buildThirdPartyProviderPlan: (input: any) => {
      calls.push(["buildThirdPartyProviderPlan", input]);
      return { config: { api: "openai-completions" } };
    },
    now: () => 1_000_000,
  };
  return { calls, runtime, deps };
}

function input(
  providerID: string,
  modelID: string,
  h: ReturnType<typeof harness>,
  extra: Partial<CreatePiRuntimeBindingInput> = {},
): CreatePiRuntimeBindingInput {
  return {
    providerID,
    modelID,
    affinityKey: "session",
    unifiedSessionId: "os-session",
    excludedOpenaiAccountIds: new Set(),
    dependencies: h.deps as any,
    ...extra,
  };
}

afterEach(() => __resetPiSdkCacheForTest());

describe("createPiRuntimeBinding", () => {
  test("is import-inert and invokes no injected SDK, config, or account effects before factory call", () => {
    const h = harness({ account: oauth });
    expect(h.calls).toEqual([]);
    expect((globalThis as any).__piSdkPromise).toBeUndefined();
  });

  test("seeds ChatGPT OAuth before runtime creation and returns rotation evidence", async () => {
    const h = harness({ account: oauth });
    const evidence: any[] = [];
    const binding = await createPiRuntimeBinding(
      input("openai", "gpt-test", h, {
        accountId: oauth.id,
        accountStrict: true,
        onAccountEvidence: (value) => evidence.push(value),
      }),
    );
    expect(binding.model.provider).toBe("openai-codex");
    expect(binding.model.id).toBe("gpt-test");
    expect(binding.usesOpenaiOAuth).toBe(true);
    expect(binding.pickedOpenai).toBe(oauth);
    const create = h.calls.find(([name]) => name === "create")!;
    expect(await create[1].credentials.read("openai-codex")).toMatchObject({
      type: "oauth",
      access: "access",
    });
    expect(evidence.at(-1)).toMatchObject({
      pickedOpenai: oauth,
      sidelineableOpenai: oauth,
      openaiPickReason: "strict pin",
    });
  });

  test("asks for a Pro $500 account on ultrafast Astra turns and reports the login's plan", async () => {
    const plans: Array<string | undefined> = [];
    const access = `h.${Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_plan_type: "promax" },
      }),
    ).toString("base64url")}.s`;
    const bind = async (modelID: string, speed: "fast" | "ultrafast") => {
      const h = harness({ account: oauth });
      h.deps.pickOpenaiAccount = ((...args: any[]) => {
        plans.push(args[8]);
        return oauth;
      }) as any;
      h.deps.buildSeededOpenaiAuth = () => ({
        seeded: {
          openai: {
            type: "oauth" as const,
            access,
            refresh: "no-refresh",
            expires: 2_000_000,
          },
        },
      });
      return createPiRuntimeBinding(input("openai", modelID, h, { speed }));
    };
    expect((await bind("gpt-6.2-astra", "ultrafast")).openaiPlan).toBe(
      "promax",
    );
    expect((await bind("gpt-6.2-sol", "ultrafast")).openaiPlan).toBe("promax");
    await bind("gpt-6.1-terra", "ultrafast");
    await bind("gpt-6.2-astra", "fast");
    expect(plans).toEqual(["promax", "promax", undefined, undefined]);
  });

  test("binds an OpenAI API key to the standard provider without credential seeding", async () => {
    const h = harness({ account: apiKey });
    const binding = await createPiRuntimeBinding(
      input("openai", "gpt-test", h),
    );
    expect(binding.usesOpenaiOAuth).toBe(false);
    expect(h.calls).toContainEqual(["setRuntimeApiKey", "openai", "sk-test"]);
    const create = h.calls.find(([name]) => name === "create")!;
    expect(await create[1].credentials.read("openai-codex")).toBeUndefined();
  });

  for (const account of [oauth, apiKey]) {
    test(`registers fallback metadata for an uncatalogued model on ${account.kind} accounts`, async () => {
      const h = harness({ account });
      const binding = await createPiRuntimeBinding(
        input("openai", "gpt-future", h),
      );
      const provider = account.kind === "home" ? "openai-codex" : "openai";
      expect(binding.model.provider).toBe(provider);
      expect(binding.usesOpenaiOAuth).toBe(account.kind === "home");
      const registration = h.calls.find(
        ([name]) => name === "registerProvider",
      );
      expect(registration?.[1]).toBe(provider);
      expect(registration?.[2].models).toEqual([
        expect.objectContaining({
          id: "gpt-future",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 272_000,
          maxTokens: 128_000,
          thinkingLevelMap: { xhigh: "xhigh", max: "max", minimal: "low" },
        }),
      ]);
    });
  }

  test("prices GPT-6.1 Terra from its release metadata until Pi catalogs it", async () => {
    for (const account of [oauth, apiKey]) {
      const bind = (modelID: string) => {
        const h = harness({ account });
        h.deps.loadSdk = prewarmPiSdk;
        return createPiRuntimeBinding(input("openai", modelID, h));
      };
      const terra = (await bind("gpt-6.1-terra")).model;
      const sol = (await bind("gpt-6.1-sol")).model;
      expect(terra.id).toBe("gpt-6.1-terra");
      expect(terra.name).toBe("GPT-6.1 Terra");
      expect(terra.api).toBe(sol.api);
      expect(terra.compat).toEqual(sol.compat);
      expect(terra.contextWindow).toBe(272_000);
      expect(terra.thinkingLevelMap?.max).toBe("max");
      expect(terra.cost).toMatchObject({
        input: 1,
        output: 5,
        cacheRead: 0.05,
        cacheWrite: 1.25,
      });
      expect(terra.cost.tiers?.[0]).toMatchObject({
        inputTokensAbove: 272_000,
        input: 2,
        output: 7.5,
      });
    }
  });

  test("prices GPT-6.2 Astra and Sol from their release metadata until Pi catalogs them", async () => {
    for (const account of [oauth, apiKey]) {
      const bind = (modelID: string) => {
        const h = harness({ account });
        h.deps.loadSdk = prewarmPiSdk;
        return createPiRuntimeBinding(input("openai", modelID, h));
      };
      const sibling = (await bind("gpt-6.1-sol")).model;
      for (const [modelID, name, input, output, cacheRead] of [
        ["gpt-6.2-astra", "GPT-6.2 Astra", 8, 40, 0.4],
        ["gpt-6.2-sol", "GPT-6.2 Sol", 2, 10, 0.1],
      ] as const) {
        const model = (await bind(modelID)).model;
        expect(model.id).toBe(modelID);
        expect(model.name).toBe(name);
        expect(model.api).toBe(sibling.api);
        expect(model.compat).toEqual(sibling.compat);
        expect(model.contextWindow).toBe(272_000);
        expect(model.thinkingLevelMap?.max).toBe("max");
        // The API rejects reasoning effort `none`.
        expect(model.thinkingLevelMap?.off).toBeNull();
        expect(model.cost).toMatchObject({ input, output, cacheRead });
        expect(model.cost.tiers?.[0]).toMatchObject({
          inputTokensAbove: 272_000,
          input: input * 2,
          output: output * 1.5,
        });
      }
    }
  });

  test("the bundled Pi catalog prices GPT-6.1 Sol and Luna for both account types", async () => {
    for (const account of [oauth, apiKey]) {
      for (const modelID of ["gpt-6.1-sol", "gpt-6-luna"]) {
        const h = harness({ account });
        h.deps.loadSdk = prewarmPiSdk;
        const binding = await createPiRuntimeBinding(
          input("openai", modelID, h),
        );
        expect(binding.model.id).toBe(modelID);
        expect(binding.model.api).toBe(
          account.kind === "home"
            ? "openai-codex-responses"
            : "openai-responses",
        );
        expect(binding.model.contextWindow).toBe(272_000);
        expect(binding.model.maxTokens).toBe(128_000);
        expect(binding.model.thinkingLevelMap?.max).toBe("max");
        expect(binding.model.cost.input).toBe(
          modelID === "gpt-6.1-sol" ? 2 : 0.1,
        );
        expect(binding.model.cost.tiers?.[0].inputTokensAbove).toBe(272_000);
      }
    }
  });

  test("registers Anthropic in-process before looking up the model", async () => {
    const h = harness({ transport: "inprocess" });
    await createPiRuntimeBinding(input("anthropic", "claude-test", h));
    expect(h.calls.map(([name]) => name)).toEqual([
      "loadSdk",
      "create",
      "buildAnthropicProvider",
      "registerNativeProvider",
    ]);
  });

  test("passes the ephemeral flag to the in-process Anthropic provider", async () => {
    const h = harness({ transport: "inprocess" });
    await createPiRuntimeBinding({
      ...input("anthropic", "claude-test", h),
      ephemeral: true,
    });
    const build = h.calls.find(([name]) => name === "buildAnthropicProvider");
    expect(build?.[1].ephemeral).toBe(true);
  });

  test("registers Anthropic bridge routing and key in current order", async () => {
    const h = harness({ transport: "bridge" });
    await createPiRuntimeBinding(input("anthropic", "claude-test", h));
    expect(h.calls.map(([name]) => name)).toEqual([
      "loadSdk",
      "create",
      "ensureAnthropicBridge",
      "registerProvider",
      "setRuntimeApiKey",
    ]);
    expect(h.calls.at(-1)).toEqual([
      "setRuntimeApiKey",
      "anthropic",
      "bridge-key",
    ]);
  });

  test("registers Opus 5.5 metadata on the HTTP bridge without bypassing it", async () => {
    const h = harness({ transport: "bridge" });
    await createPiRuntimeBinding(input("anthropic", "claude-opus-5-5", h));
    const registration = h.calls.find(
      ([name, , config]) => name === "registerProvider" && config.models,
    );
    expect(registration?.[2].models).toEqual([
      expect.objectContaining({
        id: "claude-opus-5-5",
        baseUrl: "http://bridge",
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
      }),
    ]);
  });

  test("binds a configured third-party provider plan then its key", async () => {
    const h = harness();
    await createPiRuntimeBinding(
      input("wafer", "wafer-test", h, {
        configuredProvider: {
          apiKey: "wafer-key",
          baseURL: "https://wafer.test",
        },
      }),
    );
    expect(h.calls.map(([name]) => name)).toEqual([
      "loadSdk",
      "create",
      "buildThirdPartyProviderPlan",
      "registerProvider",
      "setRuntimeApiKey",
    ]);
    expect(h.calls.at(-1)).toEqual(["setRuntimeApiKey", "wafer", "wafer-key"]);
  });

  test("binds a service-account Vertex provider through a stored credential, never as an API key", async () => {
    const h = harness();
    const serviceAccount = JSON.stringify({
      type: "service_account",
      project_id: "acme-project",
      client_email: "agent@acme-project.iam.gserviceaccount.com",
      private_key:
        "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
    });
    const credential = {
      type: "api_key" as const,
      env: {
        GOOGLE_APPLICATION_CREDENTIALS: "/state/vertex.json",
        GOOGLE_CLOUD_PROJECT: "acme-project",
        GOOGLE_CLOUD_LOCATION: "global",
      },
    };
    const seeded: unknown[] = [];
    const deps = {
      ...h.deps,
      vertexCredential: async (provider: unknown) => {
        seeded.push(provider);
        return credential;
      },
      buildThirdPartyProviderPlan: (planInput: any) => {
        h.calls.push(["buildThirdPartyProviderPlan", planInput]);
        return { config: { apiKey: planInput.apiKey, models: [] } };
      },
    };
    await createPiRuntimeBinding(
      input("google-vertex", "gemini-test", h, {
        configuredProvider: { apiKey: serviceAccount },
        dependencies: deps as any,
      }),
    );
    expect(seeded).toEqual([{ apiKey: serviceAccount }]);
    const create = h.calls.find(([name]) => name === "create")!;
    expect(await create[1].credentials.read("google-vertex")).toEqual(
      credential,
    );
    expect(h.calls.map(([name]) => name)).toEqual([
      "loadSdk",
      "create",
      "buildThirdPartyProviderPlan",
      "registerProvider",
    ]);
    expect(h.calls.at(-1)).toEqual([
      "registerProvider",
      "google-vertex",
      { models: [] },
    ]);
  });

  test("binds a Vertex API key like any other key", async () => {
    const h = harness();
    await createPiRuntimeBinding(
      input("google-vertex", "gemini-test", h, {
        configuredProvider: { apiKey: "vertex-key" },
      }),
    );
    const create = h.calls.find(([name]) => name === "create")!;
    expect(await create[1].credentials.read("google-vertex")).toBeUndefined();
    expect(h.calls.at(-1)).toEqual([
      "setRuntimeApiKey",
      "google-vertex",
      "vertex-key",
    ]);
  });

  test("preserves the unknown-model error after fallback registration fails", async () => {
    const h = harness({ account: apiKey, refuseModels: true });
    await expect(
      createPiRuntimeBinding(input("openai", "future-model", h)),
    ).rejects.toThrow(
      'Unknown OpenAI API model "future-model" (could not register it with pi)',
    );
  });
});

describe("prewarmPiSdk", () => {
  test("reuses the process cache and reset permits replacement", async () => {
    const first = Promise.resolve({ marker: "first" });
    (globalThis as any).__piSdkPromise = first;
    expect(prewarmPiSdk()).toBe(first as any);
    expect(prewarmPiSdk()).toBe(first as any);
    __resetPiSdkCacheForTest();
    const second = Promise.resolve({ marker: "second" });
    (globalThis as any).__piSdkPromise = second;
    expect(prewarmPiSdk()).toBe(second as any);
  });
});
