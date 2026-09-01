/**
 * Pi-only model catalog, presets, labels, account-pool selection and fallback routing.
 * Native and provider/model ids are normalized to pi/<provider>/<model> at dispatch.
 */

import { existsSync, readFileSync } from "fs";
import { writeJsonAtomic } from "./shared/atomic-write";
import {
  canonicalProviderPickerModelId,
  configuredCatalogModel,
  configuredPickerModels,
  modelProviders,
  waferModelEfforts,
  waferModelName,
  BRIDGE_PROVIDER_IDS,
  GLM_5_3_MODEL_ID,
  type ModelProviderConfig,
} from "./model-providers";
import { stateDir } from "./paths";
import { piEngineEnabled, piPickerModels } from "./pi-config";
// Workspace ("Custom") presets live in the workspace store, so the one thing
// this module needs from them — a preset's lead model — has to be read there.
// The import cycle back into this module is inert: workspace-model-presets
// touches these bindings only inside function bodies, never at load time.
import { resolveWorkspaceModelPreset } from "./workspace-model-presets";

// "claude" and "codex" are LEGACY provider tags: the CLI-era engines and the
// removed direct-SDK engines stored them on sessions (and readers still key
// engine-id slots on them), but routing never produces them anymore.
export type Provider = "claude" | "codex" | "pi";

/** Every engine id that can lead a model id, as a routing prefix — including
 *  the removed direct engines' claude/ and codex/, which legacy stored ids
 *  still carry. Keep this in step with the Provider union above: it is the
 *  single place the id grammar's engine axis is spelled out, so an engine
 *  prefix can't silently lose efforts, preset lookup, tiering or account-pool
 *  detection. */
const ENGINE_PREFIX_RE = /^(?:pi|claude|codex)\//;

/** `<engine>/<upstream vendor>/…` — captures the vendor segment of a routed
 *  id, whichever engine carries it. */
const ENGINE_UPSTREAM_RE = /^(?:pi|claude|codex)\/([^/]+)\//;

export interface ModelInfo {
  id: string;
  provider: Provider;
  label: string;
  aliases: string[];
  /** Picker section override ("dial" = The Dial, "orchestrator" = The
   *  Orchestrator presets); unset = grouped by the id's upstream provider
   *  segment. */
  group?: string;
  /** One-line picker subtitle (dial/orchestrator presets only today). */
  description?: string;
}

export const SESSION_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type SessionEffort = (typeof SESSION_EFFORTS)[number];

const OPENAI_EFFORTS: SessionEffort[] = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
];
const CLAUDE_EFFORTS: SessionEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Pi variants exposed by the configured model. Keep this aligned with
 * `Pi models <provider> --verbose`; the selected value is sent verbatim
 * as the prompt's `variant`. */
export function modelEfforts(
  model: string,
  providers: Record<string, ModelProviderConfig> = modelProviders(),
): SessionEffort[] {
  // Every engine exposes the same variants as its Pi sibling: our
  // effort levels map 1:1 onto pi's ThinkingLevel (pi-runner.ts) and onto the
  // direct SDKs' reasoning levels.
  const rawId = model.replace(ENGINE_PREFIX_RE, "");
  const id = canonicalProviderPickerModelId(`pi/${rawId}`).slice("pi/".length);
  const slash = id.indexOf("/");
  const provider =
    slash === -1
      ? id.startsWith("claude-")
        ? "anthropic"
        : id.startsWith("gpt-")
          ? "openai"
          : ""
      : id.slice(0, slash);
  const slug = slash === -1 ? id : id.slice(slash + 1);

  if (provider === "openai" && /^gpt-5\./.test(slug)) return OPENAI_EFFORTS;
  if (provider === "anthropic") {
    if (slug.startsWith("claude-haiku-4-5")) return ["high", "max"];
    if (/^claude-(?:fable|opus|sonnet)-/.test(slug)) return CLAUDE_EFFORTS;
  }
  if (provider === "cerebras" && slug === "gpt-oss-120b")
    return ["low", "medium", "high"];
  if (provider === "openrouter" && slug === GLM_5_3_MODEL_ID)
    return ["low", "high", "max"];
  // Wafer's ladder is per model (its catalog owns the table) and doubles as
  // the thinking switch: Wafer serves every model with reasoning off until a
  // request carries an effort.
  if (provider === "wafer") {
    const efforts = waferModelEfforts(slug);
    if (efforts.length) return [...efforts];
  }
  if (provider === "meta" && slug === "muse-spark-1.1") return OPENAI_EFFORTS;
  // An operator's catalog row names the levels its gateway accepts.
  const configured = provider
    ? configuredCatalogModel(provider, slug, providers)
    : null;
  if (configured?.efforts?.length) return [...configured.efforts];
  return [];
}

/** Preserve a supported selection, otherwise prefer High (the UI default). */
export function normalizeModelEffort(
  model: string,
  effort?: string | null,
): SessionEffort | undefined {
  const supported = modelEfforts(model);
  if (!supported.length) return undefined;
  const normalized = effort?.trim().toLowerCase() as SessionEffort | undefined;
  if (normalized && supported.includes(normalized)) return normalized;
  return supported.includes("high") ? "high" : supported[0];
}

/** Retired Claude slugs upgrade persisted sessions to the current release. */
const RETIRED_CLAUDE_REROUTE: Record<string, string> = {
  "claude-fable-5": "claude-fable-5-1",
};

function rerouteRetiredClaudeModel(model: string): string {
  const segments = model.split("/");
  const tail = segments.at(-1) || "";
  const replacement = RETIRED_CLAUDE_REROUTE[tail];
  if (!replacement) return model;
  segments[segments.length - 1] = replacement;
  return segments.join("/");
}

export const DEFAULT_BRIDGE_PICKER_MODELS = [
  "claude-fable-5-1",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-4-5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
] as const;

export const KNOWN_MODELS: ModelInfo[] = [
  {
    id: "claude-fable-5-1",
    provider: "claude",
    label: "Claude Fable 5.1",
    aliases: ["fable", "fable5.1"],
  },
  // Keep the old id resolvable for persisted sessions. Dispatch upgrades it
  // to Fable 5.1 through RETIRED_CLAUDE_REROUTE.
  {
    id: "claude-fable-5",
    provider: "claude",
    label: "Claude Fable 5",
    aliases: ["fable5"],
  },
  {
    id: "claude-opus-5",
    provider: "claude",
    label: "Claude Opus 5",
    aliases: ["opus", "opus5"],
  },
  // Kept resolvable for old sessions' labels/pricing, but the Meridian bridge
  // collapses every *opus* id to ONE canonical version (the
  // ANTHROPIC_DEFAULT_OPUS_MODEL pin in meridianAccountEnv, now Opus 5), so a
  // 4.8 selection is served as Opus 5 — it's out of the picker config for that
  // reason.
  {
    id: "claude-opus-4-8",
    provider: "claude",
    label: "Claude Opus 4.8",
    aliases: ["opus4.8"],
  },
  {
    id: "claude-sonnet-5",
    provider: "claude",
    label: "Claude Sonnet 5",
    aliases: ["sonnet", "sonnet5"],
  },
  {
    id: "claude-sonnet-4-6",
    provider: "claude",
    label: "Claude Sonnet 4.6",
    aliases: ["sonnet4.6"],
  },
  {
    id: "claude-haiku-4-5",
    provider: "claude",
    label: "Claude Haiku 4.5",
    aliases: ["haiku"],
  },
  {
    id: "codex-best-available",
    provider: "codex",
    label: "Best available (Codex)",
    aliases: ["best", "best-available", "best-codex"],
  },
  {
    id: "gpt-5.6-sol",
    provider: "codex",
    label: "GPT-5.6 Sol",
    aliases: ["sol", "gpt5.6", "codex", "gpt"],
  },
  {
    id: "gpt-5.6-terra",
    provider: "codex",
    label: "GPT-5.6 Terra",
    aliases: ["terra"],
  },
  {
    id: "gpt-5.6-luna",
    provider: "codex",
    label: "GPT-5.6 Luna",
    aliases: ["luna"],
  },
  // Retired (operator decision: drop 5.5/5.4 and spark) but
  // kept resolvable for old sessions' labels/pricing — toPiModel
  // reroutes any dispatch of them to a 5.6 model (see RETIRED_CODEX_REROUTE
  // for why: 272k backend window − 128k output reservation leaves a 144k
  // input cap, which our ~125k fixed session payload turns into a
  // compact-every-turn loop).
  {
    id: "gpt-5.5",
    provider: "codex",
    label: "GPT-5.5 (Codex)",
    aliases: ["gpt5.5"],
  },
  {
    id: "gpt-5.4",
    provider: "codex",
    label: "GPT-5.4 (Codex)",
    aliases: ["gpt5.4"],
  },
  {
    id: "gpt-5.4-mini",
    provider: "codex",
    label: "GPT-5.4 mini (Codex)",
    aliases: ["mini"],
  },
  {
    id: "gpt-5.3-codex-spark",
    provider: "codex",
    label: "GPT-5.3 Codex Spark",
    aliases: ["spark"],
  },
];

// ── The Dial ──────────────────────────────────────────────────────────────
//
// Amp-style task-difficulty presets (https://ampcode.com/news/the-dial): one
// picker choice bundles the MAIN model + reasoning effort with an ORACLE — a
// different frontier model wired in as a read-only Pi subagent the main
// agent consults for plan review, architecture calls and deep debugging. The
// session stores the preset id (`dial/<tier>`) as its `model`, so tier wiring
// can change over time without touching stored sessions; everything resolves
// to concrete models at dispatch (toPiModel + the runner's dial hook).

export interface DialPreset {
  /** Stored as the session's model id, e.g. "dial/high". */
  id: string;
  label: string;
  /** One-line picker subtitle, Amp-style. */
  description: string;
  /** Native id of the MAIN agent model (resolved via toPiModel). */
  model: string;
  /** Reasoning effort for the main model (overrides the session's effort). */
  effort: SessionEffort;
  /** Which DIAL_ORACLE_AGENTS entry backs this tier's oracle. */
  oracleAgent: string;
  /** Picker section this preset renders under (defaults to "dial"). Lets
   * one-off personal combos (group "custom") reuse the
   *  whole dial mechanism without joining the tier ladder. */
  group?: string;
}

/**
 * The oracle subagents, keyed by Pi agent name. Defined STATICALLY in
 * every engine server config (shared servers serve many sessions with
 * different presets, so the set can't vary per run — and a stable config keeps
 * the server hash stable). Only dial runs are told about them; other sessions
 * never get oracle instructions. `variant` rides the agent config through the
 * open index signature — honored where the engine supports per-agent variants,
 * harmlessly ignored otherwise.
 */
export const DIAL_ORACLE_AGENTS: Record<
  string,
  { model: string; variant: SessionEffort; label: string; description: string }
> = {
  "oracle-fable": {
    model: "anthropic/claude-fable-5-1",
    variant: "high",
    label: "Claude Fable 5.1",
    description:
      "Oracle: senior-engineer second opinion on Claude Fable 5.1 — plan review, " +
      "architecture decisions, deep debugging, reviewing significant work. Read-only advisor.",
  },
  "oracle-sol": {
    model: "openai/gpt-5.6-sol",
    variant: "xhigh",
    label: "GPT-5.6 Sol",
    description:
      "Oracle: senior-engineer second opinion on GPT-5.6 Sol at extra-high reasoning — " +
      "plan review, architecture decisions, deep debugging, reviewing significant work. " +
      "Read-only advisor.",
  },
  // Same-bridge substitutes: an engine server carries ONE bridge's auth, so a
  // cross-provider oracle (dial/ultra's sol-on-anthropic, dial/high's
  // fable-on-openai) has no model in that server's catalog — the task call
  // errored loudly or no-oped silently (Dreaming 2026-07-17). Each bridge gets
  // a distinct-model alternate so premium presets keep a REAL second opinion.
  "oracle-terra": {
    model: "openai/gpt-5.6-terra",
    variant: "high",
    label: "GPT-5.6 Terra",
    description:
      "Oracle: senior-engineer second opinion on GPT-5.6 Terra at high reasoning — " +
      "plan review, architecture decisions, deep debugging, reviewing significant work. " +
      "Read-only advisor.",
  },
  "oracle-opus": {
    model: "anthropic/claude-opus-5",
    variant: "high",
    label: "Claude Opus 5",
    description:
      "Oracle: senior-engineer second opinion on Claude Opus 5 — plan review, " +
      "architecture decisions, deep debugging, reviewing significant work. Read-only advisor.",
  },
};

/**
 * Where an oracle consultation goes when its own model cannot serve, the same
 * courtesy interactiveFallbackModel does for a full session: degrade to a
 * different senior model rather than fail the call.
 *
 * Every hop crosses PROVIDERS, which is the whole point. A dry pool is a
 * provider-wide condition (the Claude weekly cap takes fable and opus out
 * together, and it did on 2026-08-19), so a substitute on the same bridge
 * answers with the same outage and only costs a second attempt to learn it.
 * Ordering favours the strongest cross-provider peer, not the cheapest.
 */
export const DIAL_ORACLE_FALLBACKS: Record<string, string[]> = {
  "oracle-fable": ["oracle-sol"],
  "oracle-opus": ["oracle-sol"],
  "oracle-sol": ["oracle-fable"],
  "oracle-terra": ["oracle-opus"],
};

/**
 * The oracle agent a dial run can ACTUALLY consult on its server: the preset's
 * oracle when its provider matches the server's bridge, else the same-bridge
 * substitute (openai → Terra, anthropic → Opus). Unknown/native providers keep
 * the preset's choice (status quo).
 */
export function sameBridgeDialOracle(
  oracleAgent: string,
  mainProviderID: string,
): string {
  const oracle = DIAL_ORACLE_AGENTS[oracleAgent];
  if (!oracle) return oracleAgent;
  const oracleProvider = oracle.model.split("/")[0];
  if (oracleProvider === mainProviderID) return oracleAgent;
  if (mainProviderID === "openai") return "oracle-terra";
  if (mainProviderID === "anthropic") return "oracle-opus";
  return oracleAgent;
}

export const DIAL_PRESETS: DialPreset[] = [
  {
    id: "dial/ultra",
    label: "Dial · Ultra",
    description:
      "The most capable combo for hard, open-ended tasks — Fable 5.1 high with a Sol-xhigh oracle",
    model: "claude-fable-5-1",
    effort: "high",
    oracleAgent: "oracle-sol",
  },
  {
    id: "dial/high",
    label: "Dial · High",
    description:
      "Deep reasoning for hard tasks — Sol at extra-high effort with a Fable 5.1-high oracle",
    model: "gpt-5.6-sol",
    effort: "xhigh",
    oracleAgent: "oracle-fable",
  },
  {
    id: "dial/medium",
    label: "Dial · Medium",
    description:
      "Balanced depth and speed for everyday work — Sol-high with a Sol-xhigh oracle",
    model: "gpt-5.6-sol",
    effort: "high",
    oracleAgent: "oracle-sol",
  },
  {
    id: "dial/low",
    label: "Dial · Low",
    description:
      "Fast edits and small tasks — Luna-high with a Sol-xhigh oracle",
    model: "gpt-5.6-luna",
    effort: "high",
    oracleAgent: "oracle-sol",
  },
  {
    id: "dial/opus-fable",
    label: "Opus 5 + Fable oracle",
    description:
      "Custom combo — Opus 5 at extra-high effort with a Fable 5.1-high oracle",
    model: "claude-opus-5",
    effort: "xhigh",
    oracleAgent: "oracle-fable",
    group: "custom",
  },
];

/** The dial preset behind a model id, or undefined for non-dial ids.
 *  Engine-agnostic: "pi/dial/<tier>" is the same preset routed to the pi
 *  engine, so any leading engine prefix strips before the lookup. */
export function dialPreset(model?: string | null): DialPreset | undefined {
  const id = (model || "").trim().toLowerCase().replace(ENGINE_PREFIX_RE, "");
  if (!id.startsWith("dial/")) return undefined;
  return DIAL_PRESETS.find((p) => p.id === id);
}

// ── The Orchestrator ──────────────────────────────────────────────────────
//
// The Dial reversed (Cursor's agent-swarm economics: "few moments in a large
// task genuinely require frontier intelligence" — workers burn most tokens,
// so the cheap seats go to execution): a frontier MAIN model leads — plans,
// decides, reviews, integrates — and delegates well-scoped execution subtasks
// to cheaper WORKER models wired in as Pi subagents. Same mechanics as
// the dial throughout: the session stores `orchestrator/<name>` as its model,
// everything resolves at dispatch, and only orchestrator runs are told the
// workers exist. Opt-in via orchestratorEnabled() — the presets stay
// out of the picker by default.

export interface OrchestratorPreset {
  /** Stored as the session's model id, e.g. "orchestrator/fable". */
  id: string;
  label: string;
  /** One-line picker subtitle. */
  description: string;
  /** Native id of the MAIN (orchestrator) model (resolved via toPiModel). */
  model: string;
  /** Reasoning effort for the main model (overrides the session's effort). */
  effort: SessionEffort;
  /** ORCHESTRATOR_WORKER_AGENTS names this preset delegates to. */
  workerAgents: string[];
}

/**
 * The worker subagents, keyed by Pi agent name. Like the oracles they're
 * defined STATICALLY in every engine server config (stable agent set ⇒ stable
 * config hash ⇒ server reuse) and invisible in practice to non-orchestrator
 * runs — only orchestrator runs get the instructions block naming them.
 *
 * Worker NAMES are role-based, not model-based. Each name has a same-bridge
 * fallback, while configured third-party providers can supply a universal
 * backing: `worker-fast` prefers Cerebras GPT OSS when its key is available.
 * The orchestrator's prompts and task tool list stay identical either way.
 */
export const ORCHESTRATOR_WORKER_AGENTS: Record<
  string,
  {
    label: string;
    /** Task-tool description the main model sees — when to pick this worker. */
    description: string;
    /** Per-bridge backing model + effort variant. */
    bridges: Record<
      string,
      { model: string; variant: SessionEffort; label: string }
    >;
  }
> = {
  worker: {
    label: "Worker",
    description:
      "Worker: executes one well-scoped implementation subtask end to end — a function, " +
      "a module, a migration step, a test file. Give it a self-contained brief (exact " +
      "files, constraints, acceptance criteria); it sees the checkout but none of your " +
      "conversation. Not for design decisions or final review.",
    bridges: {
      anthropic: {
        model: "anthropic/claude-sonnet-5",
        variant: "medium",
        label: "Sonnet 5",
      },
      // Terra medium, not 5.5/5.4: the 272k-window codex models are retired
      // (see RETIRED_CODEX_REROUTE) — the cheap codex tiers are the 5.6
      // siblings Terra/Luna, never a smaller-window model.
      openai: {
        model: "openai/gpt-5.6-terra",
        variant: "medium",
        label: "Terra",
      },
    },
  },
  "worker-fast": {
    label: "Fast worker",
    description:
      "Fast worker: quick mechanical subtasks — renames, boilerplate, repetitive sweeps, " +
      "straightforward lookups. Cheapest and fastest; escalate anything needing judgment " +
      "to the standard worker or do it yourself.",
    bridges: {
      anthropic: {
        model: "anthropic/claude-haiku-4-5",
        variant: "high",
        label: "Haiku 4.5",
      },
      openai: {
        model: "openai/gpt-5.6-luna",
        variant: "low",
        label: "Luna low",
      },
      cerebras: {
        model: "cerebras/gpt-oss-120b",
        variant: "medium",
        label: "GPT OSS 120B",
      },
    },
  },
};

/** The backing (model/variant/label) a worker NAME resolves to. A configured
 *  Cerebras provider wins for worker-fast; otherwise workers stay on the main
 *  bridge, with unknown providers falling back to Anthropic. */
export function orchestratorWorkerForBridge(
  name: string,
  mainProviderID: string,
  availableProviderIDs = new Set(
    Object.entries(modelProviders())
      .filter(([, config]) => !!config.apiKey)
      .map(([id]) => id),
  ),
): { model: string; variant: SessionEffort; label: string } | undefined {
  const w = ORCHESTRATOR_WORKER_AGENTS[name];
  if (!w) return undefined;
  if (name === "worker-fast" && availableProviderIDs.has("cerebras"))
    return w.bridges.cerebras;
  return w.bridges[mainProviderID] ?? w.bridges.anthropic;
}

export const ORCHESTRATOR_PRESETS: OrchestratorPreset[] = [
  {
    id: "orchestrator/fable",
    label: "Orchestrator · Fable 5.1",
    description: "Fable 5.1 high leads planning, review, and integration",
    model: "claude-fable-5-1",
    effort: "high",
    workerAgents: ["worker", "worker-fast"],
  },
  {
    id: "orchestrator/sol",
    label: "Orchestrator · Sol",
    description: "Sol xhigh leads planning, review, and integration",
    model: "gpt-5.6-sol",
    effort: "xhigh",
    workerAgents: ["worker", "worker-fast"],
  },
];

function orchestratorPickerDescription(preset: OrchestratorPreset): string {
  const mainProviderID = preset.model.startsWith("claude-")
    ? "anthropic"
    : "openai";
  const workers = preset.workerAgents.flatMap((name) => {
    const backing = orchestratorWorkerForBridge(name, mainProviderID);
    if (!backing) return [];
    const role = name === "worker-fast" ? "fast worker" : "worker";
    return [`${role}: ${backing.label} ${backing.variant}`];
  });
  return `${preset.description}; delegates to ${workers.join(" and ")}`;
}

/** The orchestrator preset behind a model id, or undefined. Strips a leading
 *  engine prefix like dialPreset so the same preset routes through any engine. */
export function orchestratorPreset(
  model?: string | null,
): OrchestratorPreset | undefined {
  const id = (model || "").trim().toLowerCase().replace(ENGINE_PREFIX_RE, "");
  if (!id.startsWith("orchestrator/")) return undefined;
  return ORCHESTRATOR_PRESETS.find((p) => p.id === id);
}

/** The preset (dial or orchestrator) behind a model id. Sessions store the
 *  preset id itself, so callers that persist runner-reported models must not
 *  overwrite it — gate on this, not dialPreset, so both preset families keep
 *  their wiring across turns. */
export function modelPreset(
  model?: string | null,
): DialPreset | OrchestratorPreset | undefined {
  return dialPreset(model) ?? orchestratorPreset(model);
}

/** "claude-opus-4-8" → "Opus 4.8", "gpt-5.4-mini" → "GPT-5.4 mini". Fallback
 * prettifier for model slugs with no native registry entry to borrow from. */
function prettifyModelSlug(slug: string): string {
  if (slug === "gpt-oss-120b") return "GPT OSS 120B";
  if (slug === "gemma-4-31b") return "Gemma 4 31B";
  const glm = slug.match(/^(zai-)?glm-?(\d+(?:\.\d+)*)(?:-(.+))?$/i);
  if (glm) {
    const prefix = glm[1] ? "Z.ai " : "";
    const suffix = glm[3]
      ? ` ${glm[3]
          .split("-")
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join(" ")}`
      : "";
    return `${prefix}GLM-${glm[2]}${suffix}`;
  }
  // Wafer's ids carry version and tier segments ("DeepSeek-V4-Flash-0731-Fast")
  // that the word/number split below mangles; its catalog names them.
  const wafer = waferModelName(slug);
  if (wafer) return wafer;
  if (slug.startsWith("gpt-")) {
    const m = slug.slice(4).match(/^(\d+(?:[.-]\d+)*)(?:-(.+))?$/);
    if (m) {
      const suffix = m[2]
        ?.replace(/-/g, " ")
        .replace(
          /^(sol|terra|luna)$/i,
          (name) => name.charAt(0).toUpperCase() + name.slice(1).toLowerCase(),
        );
      return `GPT-${m[1].replace(/-/g, ".")}${suffix ? ` ${suffix}` : ""}`;
    }
    return `GPT-${slug.slice(4)}`;
  }
  const words: string[] = [];
  const nums: string[] = [];
  for (const part of slug.replace(/^claude-/, "").split("-")) {
    if (/^\d/.test(part)) nums.push(part);
    else if (part) words.push(part.charAt(0).toUpperCase() + part.slice(1));
  }
  return [words.join(" "), nums.join(".")].filter(Boolean).join(" ") || slug;
}

/** Friendly model label for a Pi model id. The engine is now an
 * implementation detail, so names stay model-first in every picker. */
export function piModelLabel(
  id: string,
  providers: Record<string, ModelProviderConfig> = modelProviders(),
): string {
  const preset = modelPreset(id);
  if (preset) return preset.label;
  const canonical = canonicalProviderPickerModelId(
    id.startsWith("pi/") ? id : `pi/${id}`,
  );
  const tail = canonical.split("/").pop() || id;
  // A configured catalog row's name beats the generic prettifier.
  const [, provider, ...rest] = canonical.split("/");
  const configured =
    provider && rest.length
      ? configuredCatalogModel(provider, rest.join("/"), providers)
      : undefined;
  if (configured?.name) return configured.name;
  const native = KNOWN_MODELS.find((m) => m.provider !== "pi" && m.id === tail);
  return (native?.label || prettifyModelSlug(tail))
    .replace(/^Claude\s+/i, "")
    .replace(/\s*\(Codex\)$/i, "");
}

/** Friendly label for a legacy direct-SDK id retained in model history. */
export function directModelLabel(id: string): string {
  const engine = id.startsWith("codex/") ? "Codex" : "Claude";
  const preset = modelPreset(id);
  if (preset) return `${engine} · ${preset.label}`;
  return `${engine} · ${piModelLabel(id)}`;
}

/** Models selectable for new turns. Every advertised id routes to Pi. */
export function selectableModels(): { id: string; label: string }[] {
  const list = KNOWN_MODELS.filter((m) => m.provider === "pi");
  return list.map((m) => ({ id: m.id, label: m.label }));
}

/** Refresh the configured Pi model catalog after Settings writes. */
export function refreshPickerModels(): void {
  for (let i = KNOWN_MODELS.length - 1; i >= 0; i--) {
    if (KNOWN_MODELS[i].provider === "pi") KNOWN_MODELS.splice(i, 1);
  }
  try {
    // One config read per refresh: the per-model label lookup below would
    // otherwise reparse the file (and every catalog file) once per entry.
    const providers = modelProviders();
    const keyed = new Set(
      Object.entries(providers)
        .filter(([, provider]) => !!provider.apiKey)
        .map(([id]) => id),
    );
    const usable = (id: string) => {
      const provider = id.split("/")[1] || "";
      return BRIDGE_PROVIDER_IDS.has(provider) || keyed.has(provider);
    };
    // Subscription-backed models are the normal catalog, not legacy direct-SDK
    // entries. Surface their Pi ids whenever Pi is enabled; the models route
    // filters them to the account providers actually configured on this server.
    const bridgeModels = piEngineEnabled() ? DEFAULT_BRIDGE_PICKER_MODELS : [];
    const configuredModels = [
      ...bridgeModels,
      ...piPickerModels(),
      ...configuredPickerModels(),
    ];
    // Deduplicate after routing: the seeded native id `gpt-5.6-sol` and a
    // retained compatibility id `pi/openai/gpt-5.6-sol` are different input
    // strings, but both become the same picker row.
    const ids = new Set<string>();
    for (const configured of configuredModels) {
      const id = toPiModel(configured);
      if (!id || !usable(id) || ids.has(id)) continue;
      ids.add(id);
      KNOWN_MODELS.push({
        id,
        provider: "pi",
        label: piModelLabel(id, providers),
        aliases: [],
      });
    }
  } catch {}
}
refreshPickerModels();

/** Per-provider defaults: claude-fable-5-1 for Anthropic, gpt-5.6-sol for OpenAI. */
export const DEFAULT_CLAUDE_MODEL = "claude-fable-5-1";
export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";
export const BEST_AVAILABLE_CODEX_MODEL = "codex-best-available";

const CODEX_MODEL_ORDER = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];

/**
 * Fallback ROUTING tiers (higher = smarter). NOT an absolute capability
 * ranking — it encodes the configured rotation policy: keep a run going on
 * an equal-or-smarter model automatically, but ASK a human before dropping to a
 * dumber one. "smart→smart / medium→smart = fine (auto); smart→dumb /
 * medium→dumb = ask." Concrete edges that policy yields: Fable→Sol auto,
 * Fable→Opus auto, Opus→Sol auto, and Opus→Sonnet ask.
 *
 * Unlisted models default to tier 1 (treated as a downgrade from any premium
 * primary, so the human is asked — the safe default).
 */
const FALLBACK_TIER: Record<string, number> = {
  "claude-fable-5-1": 3,
  "gpt-5.6-sol": 3,
  "claude-opus-5": 3,
  "gpt-5.6-terra": 3,
  "gpt-5.6-luna": 3,
  "claude-opus-4-8": 2,
  "gpt-5.5": 2,
  "claude-sonnet-5": 1,
  "gpt-5.4": 1,
  "claude-sonnet-4-6": 1,
  "claude-haiku-4-5": 0,
  "gpt-5.4-mini": 0,
  "gpt-5.3-codex-spark": 0,
};

/**
 * Ordered fallback DESTINATIONS, most-desirable first. A run that exhausts its
 * model walks this list for the next usable one; the per-hop auto/ask mode then
 * comes from the tier comparison (nextFallbackModel).
 *
 * Fable is deliberately ABSENT — it's a fallback *source*, never a destination:
 * its weekly-scoped credit pool is the scarce thing we're usually falling *off*
 * of, so routing another exhausted model back into it would just re-hit the cap.
 */
const FALLBACK_DESTINATIONS = [
  "gpt-5.6-sol",
  // Prefer Opus before the cheaper 5.6 siblings once Sol is unavailable.
  "claude-opus-5",
  // Terra/Luna remain automatic top-tier fallbacks after Opus.
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  // gpt-5.5 / gpt-5.4 / gpt-5.4-mini / spark removed 2026-07-25: retired
  // 272k-window models (RETIRED_CODEX_REROUTE) — falling back onto them would
  // land every session in the compact-every-turn loop.
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
];

/**
 * Persisted override for the global default model, set from the Connections UI
 * (PUT /api/models/default). Lets us switch what new sessions run on without a
 * code change or restart. Resolution order: this override → OPENSESSION_MODEL env
 * → DEFAULT_CLAUDE_MODEL. Stored as { model: "<id>" | null } in this file.
 */
/** Stored as { model, interactiveModel? }: `model` is the GLOBAL default every
 *  consumer of getDefaultModel() sees (Slack/Linear/Plain loops, workflows);
 *  `interactiveModel` overrides what NEW interactive sessions (the composer's
 *  preselected row) start on, without touching those loops. Dial preset ids
 *  are valid here — interactiveDefaultModel returns them unresolved so the
 *  session stores `dial/<tier>` and keeps its oracle+effort. */
const defaultModelStore = () => stateDir("default-model.json");
const FALLBACK_AUTO_STORE = stateDir("model-fallback.json");

// undefined = not yet loaded from disk; null = no override set.
let overrideCache: string | null | undefined;
let interactiveOverrideCache: string | null | undefined;

/** Test seam (bun tests only) — mirrors codex-accounts's __setXForTest naming.
 *  Drops the memoized default-model override reads so a test's scratch
 *  OPENSESSION_STATE_DIR takes effect: `bun test` shares one process across
 *  files, so an earlier file's read would otherwise bake this host's real
 *  default-model store into the caches. */
export function __resetModelCachesForTest(): void {
  overrideCache = undefined;
  interactiveOverrideCache = undefined;
}

function loadStoredDefault(field: "model" | "interactiveModel"): string | null {
  try {
    if (existsSync(defaultModelStore())) {
      const raw = JSON.parse(readFileSync(defaultModelStore(), "utf8"));
      const id = typeof raw?.[field] === "string" ? raw[field].trim() : "";
      return id && resolveModel(id) ? resolveModel(id)!.id : null;
    }
  } catch {}
  return null;
}

function loadOverride(): string | null {
  if (overrideCache === undefined) overrideCache = loadStoredDefault("model");
  return overrideCache;
}

function loadInteractiveOverride(): string | null {
  if (interactiveOverrideCache === undefined) {
    interactiveOverrideCache = loadStoredDefault("interactiveModel");
  }
  return interactiveOverrideCache;
}

/** Read-modify-write so the two default fields never clobber each other. */
function patchDefaultModelStore(patch: Record<string, string | null>): void {
  let raw: Record<string, unknown> = {};
  try {
    if (existsSync(defaultModelStore())) {
      const parsed = JSON.parse(readFileSync(defaultModelStore(), "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        raw = parsed;
    }
  } catch {}
  writeJsonAtomic(defaultModelStore(), { ...raw, ...patch });
}

/**
 * Global default when a session has no model set: UI override → OPENSESSION_MODEL
 * env → DEFAULT_CLAUDE_MODEL. Read fresh per call so UI changes take effect on
 * the next run without a restart.
 */
export function getDefaultModel(): string {
  return (
    loadOverride() || process.env.OPENSESSION_MODEL || DEFAULT_CLAUDE_MODEL
  );
}

/**
 * Persist the UI-selected default model (or clear it with null to fall back to
 * env/constant). Returns the resolved default after the change; throws on an
 * unknown model id.
 */
export function setDefaultModel(input: string | null): string {
  if (input === null || input.trim() === "") {
    overrideCache = null;
    try {
      patchDefaultModelStore({ model: null });
    } catch {}
    return getDefaultModel();
  }
  const m = resolveModel(input);
  if (!m) throw new Error(`Unknown model: ${input}`);
  overrideCache = m.id;
  patchDefaultModelStore({ model: m.id });
  return m.id;
}

/**
 * Persist the default for NEW interactive sessions only (the composer's
 * preselected model) — the global default above, and everything that reads it
 * (Slack/Linear/Plain loops, workflows), stays untouched. Accepts dial preset
 * ids ("dial/medium"); null clears back to the Pi-mapped global default.
 */
export function setInteractiveDefaultModel(input: string | null): string {
  if (input === null || input.trim() === "") {
    interactiveOverrideCache = null;
    try {
      patchDefaultModelStore({ interactiveModel: null });
    } catch {}
    return interactiveDefaultModel();
  }
  const m = resolveModel(input);
  if (!m) throw new Error(`Unknown model: ${input}`);
  interactiveOverrideCache = m.id;
  patchDefaultModelStore({ interactiveModel: m.id });
  return m.id;
}

/**
 * Global fallback model when a run dies on usage limits with every account in
 * its pool exhausted (e.g. the weekly-scoped Fable cap). Defaults to Opus —
 * strong and abundant, so an interactive session keeps working instead of
 * stalling on the limit notice. Override with OPENSESSION_FALLBACK_MODEL, or
 * set it to "none" to disable the automatic fallback entirely.
 */
export const DEFAULT_FALLBACK_MODEL: string | undefined = (() => {
  const v = (process.env.OPENSESSION_FALLBACK_MODEL || "").trim().toLowerCase();
  if (v === "none") return undefined;
  return v || "claude-opus-5";
})();

/** Haiku is primarily used for fast/cheap work. When its Claude pool is dry,
 * keep that work automatic and cross providers to the matching OpenAI tier. */
export const DEFAULT_HAIKU_FALLBACK_MODEL = "gpt-5.6-luna";

export function configuredHaikuFallbackModel(): string | undefined {
  const configured = (
    process.env.OPENSESSION_HAIKU_FALLBACK_MODEL || DEFAULT_HAIKU_FALLBACK_MODEL
  ).trim();
  if (!configured || configured.toLowerCase() === "none") return undefined;
  const routed = toPiModel(configured);
  return routed?.startsWith("pi/openai/") ? routed : undefined;
}

/** Default provider failover for any run kind. Explicit per-run fallbacks may
 * still override this, but an otherwise-default Haiku run always crosses to
 * OpenAI instead of spending another attempt in the exhausted Claude pool. */
export function automaticFallbackModel(
  primaryModel?: string,
): string | undefined {
  if (toPiModel(primaryModel)?.startsWith("pi/anthropic/claude-haiku-")) {
    return configuredHaikuFallbackModel();
  }
  return DEFAULT_FALLBACK_MODEL;
}

/**
 * Whether interactive sessions auto-switch when they have an explicit fallback
 * model. On (the default) = use that configured fallback; off ("manual") = stop
 * on the limit notice and let the human pick the next model. Persisted so the
 * choice survives a restart; read fresh per run so a UI toggle takes effect
 * without one.
 *
 * Stored as { auto: boolean } in FALLBACK_AUTO_STORE. This toggle only governs
 * interactive sessions; it does not create a fallback model by itself.
 */
let fallbackAutoCache: boolean | undefined;

export function getModelFallbackAuto(): boolean {
  if (fallbackAutoCache !== undefined) return fallbackAutoCache;
  try {
    if (existsSync(FALLBACK_AUTO_STORE)) {
      const raw = JSON.parse(readFileSync(FALLBACK_AUTO_STORE, "utf8"));
      fallbackAutoCache = raw?.auto !== false; // default on for anything but explicit false
    } else {
      fallbackAutoCache = true;
    }
  } catch {
    fallbackAutoCache = true;
  }
  return fallbackAutoCache;
}

export function setModelFallbackAuto(auto: boolean): boolean {
  fallbackAutoCache = auto;
  try {
    writeJsonAtomic(FALLBACK_AUTO_STORE, { auto });
  } catch {}
  return auto;
}

export function resolveConcreteModel(
  model?: string | null,
  exclude?: Set<string>,
): string {
  const resolved = model
    ? resolveModel(model)
    : resolveModel(getDefaultModel());
  if (resolved?.id !== BEST_AVAILABLE_CODEX_MODEL) {
    return resolved?.id || getDefaultModel();
  }

  for (const id of CODEX_MODEL_ORDER) {
    if (!exclude?.has(id)) return id;
  }
  return DEFAULT_CODEX_MODEL;
}

/** Fallback model for an interactive session. Haiku crosses to its explicit
 * OpenAI peer; other models retain the configured global preference. */
export function interactiveFallbackModel(
  primaryModel?: string,
): string | undefined {
  if (!getModelFallbackAuto()) return undefined;
  return automaticFallbackModel(primaryModel);
}

/** Retired OpenAI slugs map onto their 5.6 equivalents. */
const RETIRED_CODEX_REROUTE: Record<string, string> = {
  "gpt-5.5": "gpt-5.6-sol",
  "gpt-5.4": "gpt-5.6-sol",
  "gpt-5.4-mini": "gpt-5.6-luna",
  "gpt-5.3-codex-spark": "gpt-5.6-luna",
};

function isAppRoutedPiProvider(provider: string): boolean {
  return (
    provider === "dial" ||
    provider === "orchestrator" ||
    provider === "workspace-preset"
  );
}

/** Route a model or preset to Pi. Explicit Pi ids keep the model suffix's
 * casing because OpenAI-compatible gateways may treat model ids as
 * case-sensitive; only the provider and app-owned routing ids are normalized. */
export function toPiModel(model?: string | null): string | undefined {
  const raw = (model || "").trim();
  let requested = raw.toLowerCase();
  if (!requested) return model ?? undefined;
  const inputLower = requested;
  if (requested.startsWith("claude/") || requested.startsWith("codex/")) {
    requested = requested.slice(requested.indexOf("/") + 1);
  }
  requested = rerouteRetiredClaudeModel(requested);
  const pickerId = requested.startsWith("pi/")
    ? requested.slice("pi/".length)
    : requested;
  const preset = modelPreset(pickerId);
  if (preset) return toPiModel(preset.model);
  if (requested.includes("/")) {
    const piId = requested.startsWith("pi/") ? requested : `pi/${requested}`;
    const canonical = canonicalProviderPickerModelId(piId);
    if (canonical !== piId) return canonical;
  }
  if (requested.startsWith("pi/")) {
    const match = requested.match(/^pi\/openai\/(.+)$/);
    const replacement = match && RETIRED_CODEX_REROUTE[match[1]];
    if (replacement) return `pi/openai/${replacement}`;

    const explicitSource = requested !== inputLower ? requested : raw;
    const explicit = explicitSource.match(/^pi\/([^/]+)\/(.+)$/i);
    if (explicit) {
      const provider = explicit[1]!.toLowerCase();
      const suffix = explicit[2]!;
      // App-owned preset ids are case-insensitive routing keys. Provider model
      // ids are not, so prefer the picker/catalog's exact casing when known
      // and otherwise preserve what the caller supplied.
      if (isAppRoutedPiProvider(provider)) return requested;
      const lowerId = `pi/${provider}/${suffix.toLowerCase()}`;
      const known = KNOWN_MODELS.find(
        (candidate) => candidate.id.toLowerCase() === lowerId,
      );
      return known?.id ?? `pi/${provider}/${suffix}`;
    }
    return requested;
  }
  if (requested.startsWith("openai/")) {
    const native = requested.slice("openai/".length);
    return `pi/openai/${RETIRED_CODEX_REROUTE[native] || native}`;
  }
  if (
    requested === BEST_AVAILABLE_CODEX_MODEL ||
    requested.startsWith("codex-")
  ) {
    return `pi/openai/${DEFAULT_CODEX_MODEL}`;
  }
  if (requested.startsWith("gpt-")) {
    return `pi/openai/${RETIRED_CODEX_REROUTE[requested] || requested}`;
  }
  if (requested.startsWith("claude-")) return `pi/anthropic/${requested}`;
  if (requested.includes("/")) return `pi/${requested}`;
  return undefined;
}

/** Pi is the only execution engine. */
export function toEngineModel(
  model: string | null | undefined,
  _engine: Provider,
): string | undefined {
  return toPiModel(model);
}

export function explicitEngineFor(model?: string | null): Provider | null {
  return (model || "").trim().toLowerCase().startsWith("pi/") ? "pi" : null;
}

const PRESET_HEADS = ["dial/", "orchestrator/", "workspace-preset/"];

function pickerBaseId(id: string): string {
  const value = id.trim();
  if (!value.startsWith("pi/")) return value;
  const rest = value.slice("pi/".length);
  return PRESET_HEADS.some((head) => rest.startsWith(head))
    ? rest
    : rest.split("/").slice(1).join("/");
}

export function modelEngineKey(model?: string | null): string {
  return pickerBaseId((model || "").trim());
}

export function modelSupportsSteer(_model?: string | null): boolean {
  return true;
}

export function routeModel(
  model: string | null | undefined,
  _opts?: { interactive?: boolean },
): { engine: "pi"; model: string } {
  const requested = (model || "").trim();
  return {
    engine: "pi",
    model: toPiModel(requested) || toPiModel(getDefaultModel())!,
  };
}

export type AccountProvider = "claude" | "codex";

/** Account pool used by a model after resolving presets and legacy ids. */
export function accountProviderForModel(
  model?: string | null,
): AccountProvider | undefined {
  const requested = model || interactiveDefaultModel();
  const resolved = toPiModel(requested) || requested;
  // Presets resolve to their main model before selecting an account pool.
  const piPreset = modelPreset(resolved);
  if (piPreset) return accountProviderForModel(piPreset.model);
  const upstream = resolved.match(ENGINE_UPSTREAM_RE)?.[1];
  if (upstream === "anthropic" || resolved.startsWith("claude-"))
    return "claude";
  if (
    upstream === "openai" ||
    resolved.startsWith("gpt-") ||
    resolved.startsWith("codex-")
  ) {
    return "codex";
  }
  return undefined;
}

/** Default model for new interactive sessions, always routed to Pi. */
export function interactiveDefaultModel(): string {
  const configured = loadInteractiveOverride() || getDefaultModel();
  if (modelPreset(configured)) {
    return configured.startsWith("pi/") ? configured : `pi/${configured}`;
  }
  return toPiModel(configured) || toPiModel(getDefaultModel())!;
}

/** Strip the engine prefix so a mapped id ("Pi/openai/gpt-5.6-sol",
 *  "pi/anthropic/claude-opus-5", "claude/anthropic/claude-opus-5") resolves to
 *  its native key for tier lookup. Native ids pass through unchanged. */
function nativeModelId(id: string | undefined | null): string {
  return (id || "").replace(ENGINE_UPSTREAM_RE, "");
}

/** Routing tier for a model id (native or Pi-mapped). Unlisted → 1. */
export function fallbackTier(id: string | undefined | null): number {
  const t = FALLBACK_TIER[nativeModelId(id)];
  return t === undefined ? 1 : t;
}

export type FallbackMode = "auto" | "ask";
export interface FallbackHop {
  /** Pi-mapped id to run next */
  id: string;
  /** "auto" = keep going silently (equal-or-smarter); "ask" = confirm with a
   *  human first (downgrade to a dumber model). */
  mode: FallbackMode;
}

/**
 * The next model to try after `currentModel` has run out (usage-exhausted on
 * every account, or hit an unrecoverable transient failure). Walks
 * FALLBACK_DESTINATIONS (plus an explicitly-configured `preferred` first),
 * skipping the current engine model and anything already exhausted this run,
 * and orders auto-eligible (equal-or-smarter) candidates ahead of downgrades so
 * we keep the strongest usable model. Returns null when nothing is left.
 *
 * `mode` is the tier comparison against the model we're LEAVING: equal-or-higher
 * tier ⇒ "auto" (Fable→Sol, Opus→Sol), lower ⇒ "ask" (Fable→Opus, Opus→Sonnet,
 * Sol→Opus). Fallbacks preserve an explicit Pi engine choice; legacy and
 * unrouted primaries keep mapping onto Pi.
 */
export function nextFallbackModel(
  currentModel: string,
  exhausted: Set<string>,
  preferredFallbackModel?: string,
): FallbackHop | null {
  const currentRouted = toPiModel(currentModel) || currentModel;
  const currentTier = fallbackTier(currentRouted);

  const candidates: string[] = [];
  const add = (id: string | undefined | null) => {
    if (!id) return;
    if (id === BEST_AVAILABLE_CODEX_MODEL) {
      for (const c of CODEX_MODEL_ORDER) add(c);
      return;
    }
    const routed = toPiModel(id);
    if (
      !routed ||
      routed === currentRouted ||
      exhausted.has(routed) ||
      candidates.includes(routed)
    )
      return;
    if (!resolveModel(routed)) return;
    candidates.push(routed);
  };
  if (preferredFallbackModel && preferredFallbackModel !== "none")
    add(preferredFallbackModel);
  for (const id of FALLBACK_DESTINATIONS) add(id);
  if (!candidates.length) return null;

  // Auto-eligible models stay ahead of downgrades. Within a tier, use the
  // explicit destination order rather than candidate insertion order: the
  // configured Opus fallback is added first above, but Sol must remain the
  // first hop off Fable.
  candidates.sort((a, b) => {
    const aDown = fallbackTier(a) >= currentTier ? 0 : 1;
    const bDown = fallbackTier(b) >= currentTier ? 0 : 1;
    if (aDown !== bDown) return aDown - bDown;
    const tierDelta = fallbackTier(b) - fallbackTier(a);
    if (tierDelta) return tierDelta;
    const destinationRank = (id: string) => {
      const native = nativeModelId(id);
      const rank = FALLBACK_DESTINATIONS.indexOf(native);
      return rank < 0 ? Number.MAX_SAFE_INTEGER : rank;
    };
    return destinationRank(a) - destinationRank(b);
  });

  const to = candidates[0];
  return { id: to, mode: fallbackTier(to) >= currentTier ? "auto" : "ask" };
}

/**
 * The full ordered fallback plan from a primary model — repeated
 * nextFallbackModel hops until the graph is dry. Exported for tests and any
 * caller that wants to preview the chain; the live runner uses nextFallbackModel
 * directly so a hop's mode is evaluated against the model actually being left.
 */
export function fallbackPlan(
  primaryModel: string | undefined,
  preferredFallbackModel: string | undefined,
): FallbackHop[] {
  if (!preferredFallbackModel || preferredFallbackModel === "none") return [];
  const exhausted = new Set<string>();
  const out: FallbackHop[] = [];
  let current =
    toPiModel(primaryModel || getDefaultModel()) || getDefaultModel();
  for (let i = 0; i < 32; i++) {
    const hop = nextFallbackModel(current, exhausted, preferredFallbackModel);
    if (!hop) break;
    out.push(hop);
    exhausted.add(hop.id);
    current = hop.id;
  }
  return out;
}

/**
 * Resolve user input (alias or id, any case) to a model. Unknown ids that
 * carry a clear provider prefix pass through so new models work without a
 * registry bump; anything else is rejected.
 */
export function resolveModel(input: string): ModelInfo | null {
  const raw = input.trim();
  const value = raw.toLowerCase();
  if (!value) return null;
  for (const model of KNOWN_MODELS) {
    if (model.id.toLowerCase() === value || model.aliases.includes(value)) {
      const replacement =
        RETIRED_CLAUDE_REROUTE[model.id] || RETIRED_CODEX_REROUTE[model.id];
      return replacement
        ? KNOWN_MODELS.find((candidate) => candidate.id === replacement)!
        : model;
    }
  }
  // Provider-backed picker ids can carry extra routing segments that are not
  // part of the model's human name (`pi/openrouter/z-ai/glm-5.3`). Agents
  // naturally pass the visible final slug (`glm-5.3`) to create_session. Let
  // that shorthand resolve when it names exactly one selectable Pi model;
  // collisions stay rejected rather than silently choosing a provider.
  const pickerAlias = value.replace(/\s+/g, "-");
  const pickerMatches = KNOWN_MODELS.filter(
    (model) =>
      model.provider === "pi" &&
      model.id.split("/").at(-1)?.toLowerCase() === pickerAlias,
  );
  if (pickerMatches.length === 1) return pickerMatches[0];
  if (value.startsWith("dial/") || value.startsWith("orchestrator/")) {
    const preset = modelPreset(value);
    return preset
      ? {
          id: preset.id,
          provider: "pi",
          label: preset.label,
          aliases: [],
          group: value.split("/")[0],
          description: preset.description,
        }
      : null;
  }
  if (value.startsWith("pi/")) {
    const routed = toPiModel(raw) || raw;
    return routed.slice("pi/".length).includes("/")
      ? { id: routed, provider: "pi", label: piModelLabel(routed), aliases: [] }
      : null;
  }
  if (value.startsWith("claude-"))
    return { id: value, provider: "claude", label: value, aliases: [] };
  if (value.startsWith("gpt-") || value.startsWith("codex-")) {
    return { id: value, provider: "codex", label: value, aliases: [] };
  }
  if (value.startsWith("claude/") || value.startsWith("codex/")) {
    return resolveModel(value.slice(value.indexOf("/") + 1));
  }
  if (value.includes("/")) {
    const id = toPiModel(raw);
    return id
      ? { id, provider: "pi", label: piModelLabel(id), aliases: [] }
      : null;
  }
  return null;
}

/** Execution provider for a session model. */
export function providerFor(_model?: string | null): Provider {
  return "pi";
}

export function modelLabel(model?: string | null): string {
  const id = model || getDefaultModel();
  return (
    KNOWN_MODELS.find((entry) => entry.id === id)?.label ||
    (id.startsWith("pi/") ? piModelLabel(id) : directModelLabel(id))
  );
}

// ── Context windows (for live context reporting) ────────────────────────────
//
// USD cost is returned by the engine on each completed provider message. Keep
// only context ceilings here for the live context-fill gauge.

const CONTEXT_WINDOWS: Record<string, number> = {
  "claude-fable-5-1": 1_000_000,
  "claude-opus-5": 1_000_000,
  "claude-opus-4-8": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-sonnet-5": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-haiku-4-5": 200_000,
  // Codex/GPT — approximate.
  "gpt-5.5": 400_000,
  "gpt-5.4": 400_000,
  "gpt-5.4-mini": 400_000,
  "gpt-5.3-codex-spark": 400_000,
};

/** Preset ids (dial/orchestrator) price/gauge as their main model; everything
 *  else passes through. */
function pricingKey(model?: string | null): string {
  const id = resolveModel(model || "")?.id || model || "";
  return modelPreset(id)?.model || id;
}

/** Context-window token ceiling for a model (0 if unknown → gauge hidden). */
export function contextWindowFor(model?: string | null): number {
  const id = pricingKey(model || getDefaultModel());
  return CONTEXT_WINDOWS[id] ?? 0;
}

/** Human list for /model help output. */
export function formatModelList(current?: string | null): string {
  const cur = current || getDefaultModel();
  return KNOWN_MODELS.map((m) => {
    const marker = m.id === cur ? "→ " : "   ";
    const aliases = m.aliases.length ? ` (${m.aliases.join(", ")})` : "";
    return `${marker}${m.id}${aliases} — ${m.label}`;
  }).join("\n");
}
