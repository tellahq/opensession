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
