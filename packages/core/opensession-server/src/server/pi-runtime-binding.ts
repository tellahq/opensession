import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { CodexAccount } from "./codex-accounts";
import type { SeededOpenaiAuth } from "./openai-auth";

export type PiSdk = typeof import("@earendil-works/pi-coding-agent");
type PiModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;
type PiProviderConfigInput = Parameters<ModelRuntime["registerProvider"]>[1];

const g = globalThis as typeof globalThis & { __piSdkPromise?: Promise<PiSdk> };

/** Load Pi on demand and retain one process-wide cold-import promise. */
export function loadPiSdk(): Promise<PiSdk> {
  return (g.__piSdkPromise ??= import("@earendil-works/pi-coding-agent").catch(
    (error: unknown) => {
      g.__piSdkPromise = undefined;
      throw error;
    },
  ));
}

/**
 * Idempotent boot warm-up. Boot wiring is intentionally deferred until the
 * runtime-binding foundation is reviewed; ordinary turns still load on demand.
 */
export function prewarmPiSdk(): Promise<PiSdk> {
  return loadPiSdk();
}

/** Test-only cache seam. It does not clear Bun's evaluated module cache. */
export function __resetPiSdkCacheForTest(): void {
  g.__piSdkPromise = undefined;
}

export interface PiRuntimeAccountEvidence {
  pickedOpenai?: CodexAccount;
  sidelineableOpenai?: CodexAccount;
  openaiPickReason?: string;
}

export interface PiRuntimeBinding extends PiRuntimeAccountEvidence {
  sdk: PiSdk;
  runtime: ModelRuntime;
  model: PiModel;
  usesOpenaiOAuth: boolean;
}

interface ConfiguredProvider {
  apiKey?: string;
  baseURL?: string;
}

interface OpenaiPickOut {
  reason?: string;
}

type OpenaiPick = CodexAccount | { error: string };
type SeededAuthResult = { seeded: SeededOpenaiAuth } | { error: string };

export interface PiRuntimeBindingDependencies {
  loadSdk?: () => Promise<PiSdk>;
  readOpenaiAccounts: () => unknown;
  pickOpenaiAccount: (
    modelID: string,
    accounts: any,
    affinityKey: string,
    out: OpenaiPickOut,
    user?: string,
    accountId?: string,
    accountStrict?: boolean,
    excluded?: ReadonlySet<string>,
  ) => OpenaiPick;
  buildSeededOpenaiAuth: (account: CodexAccount) => SeededAuthResult;
  anthropicTransport: () => "inprocess" | "bridge";
  buildAnthropicProvider: (input: {
    unifiedSessionId: string;
    user?: string;
    accountId?: string;
    accountStrict?: boolean;
    usageCredits?: boolean;
    builtinModels: ReturnType<ModelRuntime["getModels"]>;
    ensureModelId: string;
  }) => Parameters<ModelRuntime["registerNativeProvider"]>[0];
  ensureAnthropicBridge: () => { url: string; key: string };
  buildThirdPartyProviderPlan: (input: {
    providerID: string;
    modelID: string;
    apiKey: string;
    baseURL?: string;
    builtinModelIds: readonly string[];
  }) => { config: PiProviderConfigInput } | { error: string };
  now?: () => number;
}

export interface CreatePiRuntimeBindingInput {
  providerID: string;
  modelID: string;
  configuredProvider?: ConfiguredProvider;
  affinityKey: string;
  unifiedSessionId: string;
  accountUser?: string;
  accountId?: string;
  accountStrict?: boolean;
  usageCredits?: boolean;
  excludedOpenaiAccountIds: ReadonlySet<string>;
  /** Publishes evidence immediately so a later throw can still rotate safely. */
  onAccountEvidence?: (evidence: PiRuntimeAccountEvidence) => void;
  /** Preserves the runner's audit-before-SDK-load ordering. */
  beforeRuntimeLoad?: (
    evidence: PiRuntimeAccountEvidence,
  ) => void | Promise<void>;
  dependencies: PiRuntimeBindingDependencies;
}

class MemoryCredentialStore {
  private data = new Map<string, any>();

  async read(id: string) {
    return this.data.get(id);
  }
  async list() {
    return [...this.data.entries()].map(([providerId, credential]) => ({
      providerId,
      type: credential?.type,
    }));
  }
  async modify(id: string, fn: (credential: any) => Promise<any>) {
    const next = await fn(this.data.get(id));
    if (next !== undefined) this.data.set(id, next);
    return this.data.get(id);
  }
  async delete(id: string) {
    this.data.delete(id);
  }
}

const OPENAI_FALLBACK_MODEL = (modelID: string) => ({
  id: modelID,
  name: modelID,
  reasoning: true,
  thinkingLevelMap: { xhigh: "xhigh", max: "max", minimal: "low" },
  input: ["text", "image"] as Array<"text" | "image">,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 272_000,
  maxTokens: 128_000,
});

/** Construct one isolated ModelRuntime and bind its selected provider/model. */
export async function createPiRuntimeBinding(
  input: CreatePiRuntimeBindingInput,
): Promise<PiRuntimeBinding> {
  const { dependencies: deps } = input;
  const evidence: PiRuntimeAccountEvidence = {};
  let seededOpenaiCredential: SeededOpenaiAuth["openai"] | undefined;
  let openaiApiKeyCredential: string | undefined;

  if (input.providerID === "openai") {
    const pickOut: OpenaiPickOut = {};
    const picked = deps.pickOpenaiAccount(
      input.modelID,
      deps.readOpenaiAccounts(),
      input.affinityKey,
      pickOut,
      input.accountUser,
      input.accountId,
      input.accountStrict,
      input.excludedOpenaiAccountIds,
    );
    if ("error" in picked) {
      const error = new Error(`pi/openai: ${picked.error}`) as Error & {
        usageLimitExhausted?: boolean;
      };
      error.usageLimitExhausted = true;
      throw error;
    }
    evidence.pickedOpenai = picked;
    evidence.openaiPickReason = pickOut.reason;
    input.onAccountEvidence?.({ ...evidence });

    if (picked.kind === "api_key") {
      openaiApiKeyCredential = picked.value;
      evidence.sidelineableOpenai = picked;
    } else {
      const built = deps.buildSeededOpenaiAuth(picked);
      if ("error" in built) {
        const error = new Error(`pi/openai: ${built.error}`) as Error & {
          usageLimitExhausted?: boolean;
        };
        error.usageLimitExhausted = true;
        throw error;
      }
      const msLeft = built.seeded.openai.expires - (deps.now?.() ?? Date.now());
      if (msLeft <= 6 * 60_000) {
        const error = new Error(
          `pi/openai: codex account "${picked.name}" access token expires in ` +
            `${Math.max(1, Math.ceil(msLeft / 60_000))} min, inside pi's refresh window. ` +
            "The placeholder refresh deliberately fails, so this account is dry " +
            "until the codex CLI refreshes the token.",
        ) as Error & { usageLimitExhausted?: boolean };
        error.usageLimitExhausted = true;
        throw error;
      }
      seededOpenaiCredential = built.seeded.openai;
      evidence.sidelineableOpenai = picked;
    }
    input.onAccountEvidence?.({ ...evidence });
  }

  await input.beforeRuntimeLoad?.({ ...evidence });
  const sdk = await (deps.loadSdk ?? loadPiSdk)();
  const credentials = new MemoryCredentialStore();
  if (seededOpenaiCredential) {
    const credential = seededOpenaiCredential;
    await credentials.modify("openai-codex", async () => credential);
  }
  const runtime = await sdk.ModelRuntime.create({
    credentials,
    modelsPath: null,
  });
  let model: ReturnType<typeof runtime.getModel>;

  if (input.providerID === "openai" && openaiApiKeyCredential) {
    await runtime.setRuntimeApiKey("openai", openaiApiKeyCredential);
    model = runtime.getModel("openai", input.modelID);
    if (!model) {
      runtime.registerProvider("openai", {
        models: [OPENAI_FALLBACK_MODEL(input.modelID)],
      });
      model = runtime.getModel("openai", input.modelID);
    }
    if (!model) {
      throw new Error(
        `Unknown OpenAI API model "${input.modelID}" (could not register it with pi)`,
      );
    }
  } else if (input.providerID === "openai") {
    model = runtime.getModel("openai-codex", input.modelID);
    if (!model) {
      runtime.registerProvider("openai-codex", {
        models: [OPENAI_FALLBACK_MODEL(input.modelID)],
      });
      model = runtime.getModel("openai-codex", input.modelID);
    }
    if (!model) {
      throw new Error(
        `Unknown OpenAI model "${input.modelID}" (could not register it with pi)`,
      );
    }
  } else if (
    input.providerID === "anthropic" &&
    deps.anthropicTransport() === "inprocess"
  ) {
    const provider = deps.buildAnthropicProvider({
      unifiedSessionId: input.unifiedSessionId,
      user: input.accountUser,
      accountId: input.accountId,
      accountStrict: input.accountStrict,
      usageCredits: input.usageCredits,
      builtinModels: runtime.getModels("anthropic"),
      ensureModelId: input.modelID,
    });
    runtime.registerNativeProvider(provider);
    model = runtime.getModel("anthropic", input.modelID);
    if (!model) {
      throw new Error(
        `Unknown Anthropic model "${input.modelID}" (could not register it with pi)`,
      );
    }
  } else if (input.providerID === "anthropic") {
    const bridge = deps.ensureAnthropicBridge();
    const headers = { "x-opensession-session": input.unifiedSessionId };
    runtime.registerProvider("anthropic", { baseUrl: bridge.url, headers });
    await runtime.setRuntimeApiKey("anthropic", bridge.key);
    model = runtime.getModel("anthropic", input.modelID);
    if (!model) {
      runtime.registerProvider("anthropic", {
        baseUrl: bridge.url,
        headers,
        models: [
          {
            id: input.modelID,
            name: input.modelID,
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200_000,
            maxTokens: 32_000,
          },
        ],
      });
      model = runtime.getModel("anthropic", input.modelID);
    }
    if (!model) {
      throw new Error(
        `Unknown Anthropic model "${input.modelID}" (could not register it with pi)`,
      );
    }
  } else {
    const provider = input.configuredProvider!;
    const plan = deps.buildThirdPartyProviderPlan({
      providerID: input.providerID,
      modelID: input.modelID,
      apiKey: provider.apiKey!,
      baseURL: provider.baseURL,
      builtinModelIds: runtime
        .getModels(input.providerID)
        .map((candidate) => candidate.id),
    });
    if ("error" in plan) throw new Error(plan.error);
    runtime.registerProvider(input.providerID, plan.config);
    await runtime.setRuntimeApiKey(input.providerID, provider.apiKey!);
    model = runtime.getModel(input.providerID, input.modelID);
    if (!model) {
      throw new Error(
        `Model "${input.providerID}/${input.modelID}" could not be registered with pi. ` +
          "Use a model supported by that provider's Pi integration.",
      );
    }
  }

  return {
    sdk,
    runtime,
    model,
    ...evidence,
    usesOpenaiOAuth: seededOpenaiCredential !== undefined,
  };
}
