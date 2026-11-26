import { buildPiAnthropicModels } from "./pi-anthropic-models";
import type { ModelCost } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { CodexAccount } from "./codex-accounts";
import type { SeededOpenaiAuth } from "./openai-auth";
import type { SessionSpeed } from "@tellahq/opensession-protocol/session";
import {
  chatgptPlanFromJwt,
  supportsOpenaiUltrafast,
  ULTRAFAST_CHATGPT_PLAN,
} from "./openai-service-tier";
import type { ModelProviderConfig } from "./model-providers";
import type { XaiAccount, bindXaiAccount } from "./xai-accounts";
import { XAI_OAUTH_PROVIDER } from "./xai-provider-id";
import { bridgePinHeaders } from "./anthropic-bridge-pin";
import { isCompiledBinary } from "../runner-host/exe";
import { checkPhotonWasm } from "./photon-wasm";
import {
  checkCodemodeSidecars,
  useCompiledCodemodeSidecars,
} from "./codemode-runtime";

export type PiSdk = typeof import("@earendil-works/pi-coding-agent");
type PiModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;
type PiProviderConfigInput = Parameters<ModelRuntime["registerProvider"]>[1];

const g = globalThis as typeof globalThis & {
  __piSdkPromise?: Promise<PiSdk>;
  __piPhotonChecked?: boolean;
};

/** Load Pi on demand and retain one process-wide cold-import promise. */
export function loadPiSdk(): Promise<PiSdk> {
  return (g.__piSdkPromise ??= import("@earendil-works/pi-coding-agent").then(
    (sdk) => {
      // Pi drops images silently when Photon's wasm is missing; a compiled
      // install is the only layout where that can happen, so warn there once.
      if (isCompiledBinary() && !g.__piPhotonChecked) {
        g.__piPhotonChecked = true;
        void checkPhotonWasm().catch(() => {});
        // Codemode's QuickJS wasm and worker ship beside the executable too
        // (codemode-runtime.ts); Pi's own lookups cannot reach them there.
        useCompiledCodemodeSidecars(sdk);
        void checkCodemodeSidecars().catch(() => {});
      }
      return sdk;
    },
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
  pickedXai?: XaiAccount;
  sidelineableXai?: XaiAccount;
  xaiPickReason?: string;
}

export interface PiRuntimeBinding extends PiRuntimeAccountEvidence {
  sdk: PiSdk;
  runtime: ModelRuntime;
  model: PiModel;
  usesOpenaiOAuth: boolean;
  /** ChatGPT plan of the seeded login, which gates the ultrafast tier. */
  openaiPlan?: string;
  /** A SuperGrok turn: requests need the cli-chat-proxy payload shaping. */
  usesXaiProxy: boolean;
}

type ConfiguredProvider = ModelProviderConfig;

interface OpenaiPickOut {
  reason?: string;
}

type OpenaiPick = CodexAccount | { error: string };
type SeededAuthResult = { seeded: SeededOpenaiAuth } | { error: string };

export interface PiRuntimeBindingDependencies {
  loadSdk?: () => Promise<PiSdk>;
  readOpenaiAccounts: () => unknown;
  /** Designated SuperGrok ids (bridge.xaiAccounts), when configured. */
  readXaiAccounts?: () => string[] | undefined;
  pickOpenaiAccount: (
    modelID: string,
    accounts: any,
    affinityKey: string,
    out: OpenaiPickOut,
    user?: string,
    accountId?: string,
    accountStrict?: boolean,
    excluded?: ReadonlySet<string>,
    preferPlan?: string,
  ) => OpenaiPick;
  buildSeededOpenaiAuth: (
    account: CodexAccount,
  ) => SeededAuthResult | Promise<SeededAuthResult>;
  anthropicTransport: () => "inprocess" | "bridge" | "remote";
  buildAnthropicProvider: (input: {
    unifiedSessionId: string;
    user?: string;
    billingLogin?: string;
    accountId?: string;
    accountStrict?: boolean;
    usageCredits?: boolean;
    builtinModels: ReturnType<ModelRuntime["getModels"]>;
    ensureModelId: string;
    ephemeral?: boolean;
    sdkSessionFile?: string;
  }) => Parameters<ModelRuntime["registerNativeProvider"]>[0];
  ensureAnthropicBridge: () => { url: string; key: string };
  buildThirdPartyProviderPlan: (input: {
    providerID: string;
    modelID: string;
    apiKey: string;
    baseURL?: string;
    configured?: ModelProviderConfig;
    builtinModelIds: readonly string[];
  }) => { config: PiProviderConfigInput } | { error: string };
  bindXaiAccount: typeof bindXaiAccount;
  now?: () => number;
}

export interface CreatePiRuntimeBindingInput {
  providerID: string;
  modelID: string;
  configuredProvider?: ConfiguredProvider;
  affinityKey: string;
  unifiedSessionId: string;
  accountUser?: string;
  /** Verified login a personal Claude API account may bill: the session
   *  creator's, never a display name resolved at dispatch. */
  billingLogin?: string;
  accountId?: string;
  accountStrict?: boolean;
  usageCredits?: boolean;
  /** Throwaway run: release the live provider conversation once it settles. */
  ephemeral?: boolean;
  /** Where a Claude conversation's SDK-session mapping is kept between turns
   *  (claude-sdk-session-file.ts). Absent for runs with no later turn. */
  claudeSdkSessionFile?: string;
  /** Ultrafast turns prefer accounts on the plan that serves it. */
  speed?: SessionSpeed;
  /** Accounts already burned by this turn's walk (Codex and SuperGrok pools). */
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

/** Release metadata for OpenAI models newer than the bundled Pi catalog.
 * `sibling` names a catalogued model on the same backend whose request
 * compat (grammar tools, tool search) the new model shares. */
const OPENAI_RELEASE_METADATA: Record<
  string,
  {
    name: string;
    sibling: string;
    cost: ModelCost;
    /** The API rejects reasoning effort `none`, so `off` maps to nothing. */
    requiresReasoning?: boolean;
  }
> = {
  // https://developers.openai.com/api/docs/models/gpt-6.2-astra
  "gpt-6.2-astra": {
    name: "GPT-6.2 Astra",
    sibling: "gpt-6.1-sol",
    requiresReasoning: true,
    cost: {
      input: 8,
      output: 40,
      cacheRead: 0.4,
      cacheWrite: 10,
      tiers: [
        {
          inputTokensAbove: 272_000,
          input: 16,
          output: 60,
          cacheRead: 0.8,
          cacheWrite: 20,
        },
      ],
    },
  },
  // https://developers.openai.com/api/docs/models/gpt-6.2-sol
  "gpt-6.2-sol": {
    name: "GPT-6.2 Sol",
    sibling: "gpt-6.1-sol",
    requiresReasoning: true,
    cost: {
      input: 2,
      output: 10,
      cacheRead: 0.1,
      cacheWrite: 2.5,
      tiers: [
        {
          inputTokensAbove: 272_000,
          input: 4,
          output: 15,
          cacheRead: 0.2,
          cacheWrite: 5,
        },
      ],
    },
  },
  // https://developers.openai.com/api/docs/models/gpt-6.1-terra
  "gpt-6.1-terra": {
    name: "GPT-6.1 Terra",
    sibling: "gpt-6.1-sol",
    cost: {
      input: 1,
      output: 5,
      cacheRead: 0.05,
      cacheWrite: 1.25,
      tiers: [
        {
          inputTokensAbove: 272_000,
          input: 2,
          output: 7.5,
          cacheRead: 0.1,
          cacheWrite: 2.5,
        },
      ],
    },
  },
};

function openaiFallbackModel(
  modelID: string,
  catalogued: (id: string) => { compat?: unknown } | undefined,
) {
  // Metadata for an OpenAI model newer than the bundled Pi catalog.
  // Catalogued models (GPT-6 Astra, Sol, 6.1 Sol, Luna) never reach this;
  // their pricing and limits come from pi-ai. A model listed in
  // OPENAI_RELEASE_METADATA gets its published rates; anything else is an
  // unpriced placeholder.
  const release = OPENAI_RELEASE_METADATA[modelID];
  const compat = release ? catalogued(release.sibling)?.compat : undefined;
  return {
    id: modelID,
    name: release?.name ?? modelID,
    reasoning: true,
    thinkingLevelMap: {
      xhigh: "xhigh",
      max: "max",
      minimal: "low",
      ...(release?.requiresReasoning ? { off: null } : {}),
    },
    input: ["text", "image"] as Array<"text" | "image">,
    cost: release?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 272_000,
    maxTokens: 128_000,
    ...(compat ? { compat } : {}),
  };
}

/** Construct one isolated ModelRuntime and bind its selected provider/model. */
export async function createPiRuntimeBinding(
  input: CreatePiRuntimeBindingInput,
): Promise<PiRuntimeBinding> {
  const { dependencies: deps } = input;
  const evidence: PiRuntimeAccountEvidence = {};
  let seededOpenaiCredential: SeededOpenaiAuth["openai"] | undefined;
  let openaiApiKeyCredential: string | undefined;
  let xaiBinding:
    | Extract<Awaited<ReturnType<typeof bindXaiAccount>>, { access: string }>
    | undefined;

  if (input.providerID === XAI_OAUTH_PROVIDER) {
    const pickOut: OpenaiPickOut = {};
    const bound = await deps.bindXaiAccount({
      modelID: input.modelID,
      affinityKey: input.affinityKey,
      unifiedSessionId: input.unifiedSessionId,
      user: input.accountUser,
      accountId: input.accountId,
      accountStrict: input.accountStrict,
      restrictIds: deps.readXaiAccounts?.(),
      excluded: input.excludedOpenaiAccountIds,
      out: pickOut,
    });
    if ("error" in bound) {
      // A picked account whose token could not be refreshed is worth
      // rotating off, so publish it before throwing.
      if (bound.account) {
        evidence.pickedXai = bound.account;
        evidence.xaiPickReason = pickOut.reason;
        input.onAccountEvidence?.({ ...evidence });
      }
      const error = new Error(
        `pi/${XAI_OAUTH_PROVIDER}: ${bound.error}`,
      ) as Error & { usageLimitExhausted?: boolean };
      error.usageLimitExhausted = true;
      throw error;
    }
    xaiBinding = bound;
    evidence.pickedXai = bound.account;
    evidence.sidelineableXai = bound.account;
    evidence.xaiPickReason = pickOut.reason;
    input.onAccountEvidence?.({ ...evidence });
  }

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
      input.speed === "ultrafast" && supportsOpenaiUltrafast(input.modelID)
        ? ULTRAFAST_CHATGPT_PLAN
        : undefined,
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
      const built = await deps.buildSeededOpenaiAuth(picked);
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

  if (xaiBinding) {
    runtime.registerProvider(XAI_OAUTH_PROVIDER, xaiBinding.provider);
    await runtime.setRuntimeApiKey(XAI_OAUTH_PROVIDER, xaiBinding.access);
    model = runtime.getModel(XAI_OAUTH_PROVIDER, input.modelID);
    if (!model) {
      throw new Error(
        `Unknown SuperGrok model "${input.modelID}" (could not register it with pi)`,
      );
    }
  } else if (input.providerID === "openai" && openaiApiKeyCredential) {
    await runtime.setRuntimeApiKey("openai", openaiApiKeyCredential);
    model = runtime.getModel("openai", input.modelID);
    if (!model) {
      runtime.registerProvider("openai", {
        models: [
          openaiFallbackModel(input.modelID, (id) =>
            runtime.getModel("openai", id),
          ),
        ],
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
        models: [
          openaiFallbackModel(input.modelID, (id) =>
            runtime.getModel("openai-codex", id),
          ),
        ],
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
    // "remote" is the same native provider; only where its Claude Code
    // processes run differs (pi-model-runtime's createLiveSdkConversation).
    deps.anthropicTransport() !== "bridge"
  ) {
    const provider = deps.buildAnthropicProvider({
      unifiedSessionId: input.unifiedSessionId,
      user: input.accountUser,
      billingLogin: input.billingLogin,
      accountId: input.accountId,
      accountStrict: input.accountStrict,
      usageCredits: input.usageCredits,
      builtinModels: runtime.getModels("anthropic"),
      ensureModelId: input.modelID,
      ...(input.ephemeral ? { ephemeral: true } : {}),
      ...(input.claudeSdkSessionFile && !input.ephemeral
        ? { sdkSessionFile: input.claudeSdkSessionFile }
        : {}),
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
    // The session's account pin travels with each request so the bridge
    // honors it; a strict pin (fixed subscription) never falls back to
    // another account, so it can never bill a different organization.
    const headers: Record<string, string> = {
      "x-opensession-session": input.unifiedSessionId,
      ...bridgePinHeaders(input.accountId, input.accountStrict),
    };
    runtime.registerProvider("anthropic", { baseUrl: bridge.url, headers });
    await runtime.setRuntimeApiKey("anthropic", bridge.key);
    model = runtime.getModel("anthropic", input.modelID);
    if (!model) {
      runtime.registerProvider("anthropic", {
        baseUrl: bridge.url,
        headers,
        models: buildPiAnthropicModels([], input.modelID).map((model) => ({
          ...model,
          baseUrl: bridge.url,
        })),
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
      configured: provider,
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
    openaiPlan: chatgptPlanFromJwt(seededOpenaiCredential?.access),
    usesXaiProxy: xaiBinding !== undefined,
  };
}
