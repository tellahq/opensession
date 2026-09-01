import React from "react";
import type { ModelOption } from "../lib/api";
import {
  baseModelId,
  engineModelId,
  isAnthropicModel,
  modelEngine,
} from "../lib/model-engine";
import { providerAccountLabel } from "../lib/provider-account";
import {
  getRecentModels,
  onRecentModelsChanged,
  pushRecentModel,
} from "../lib/model-recents";
import { Menu } from "../ui/menu";
import { cn } from "../ui/cn";
import { Tooltip } from "../ui/tooltip";
import { IconBolt, IconChevronRight, IconSparkle, IconUndo } from "./icons";
import { ModelMark } from "./ModelMark";
import type { ModelEffortSelectProps } from "../lib/model-effort-select-types";
import { UsageCost, UsageDetails } from "./UsageMeter";

export const EFFORTS = [
  { id: "none", label: "None" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra high" },
  { id: "max", label: "Max" },
];

const PRIMARY_MODEL_IDS = [
  "claude-fable-5-1",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-4-5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
] as const;
const PRIMARY_MODEL_ID_SET = new Set<string>(PRIMARY_MODEL_IDS);

/** Engine display names, keyed by ModelOption.provider — only used for the
 * legacy (no-engine-configured) grouping fallback below. */
export const ENGINE_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  pi: "Pi",
};

/** De-emphasized group name for the native Claude-SDK/Codex entries that stick
 * around as automation/fallback plumbing during the engine migration. */
export const LEGACY_GROUP_LABEL = "Legacy (direct SDK)";

/** Split a Pi model id into its upstream provider and model slug. */
export function routedModelParts(
  id: string,
): { provider: string; model: string } | null {
  if (!id.startsWith("pi/")) return null;
  const rest = id.slice("pi/".length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  return { provider: rest.slice(0, slash), model: rest.slice(slash + 1) };
}

/** Engine routing (id prefixes, composition, the base id every lookup
 * resolves through) lives in lib/model-engine. Re-exported here because the
 * picker's callers have always imported it from this module. */
export {
  baseModelId,
  engineModelId,
  modelEngine,
  piModelId,
} from "../lib/model-engine";

/** Pure slug prettifier: "claude-sonnet-5" → "Sonnet 5", "claude-haiku-4-5" →
 * "Haiku 4.5", "gpt-5.4-mini" → "GPT-5.4 mini". Mirrors the server's
 * piModelLabel (models.ts) but needs no models list, so it works in the
 * transcript weave before /api/models has loaded — and keeps friendly names
 * correct even while the server still serves pre-rename labels. */
export function friendlyModelSlug(slug: string): string {
  if (slug === "gpt-oss-120b") return "GPT OSS 120B";
  if (slug === "gemma-4-31b") return "Gemma 4 31B";
  if (slug === "z-ai/glm-5.3" || slug === "stealth/ox-alpha") return "GLM-5.3";
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

/**
 * A workspace preset's own name for an id that carries the workspace it was
 * defined in ("workspace-preset/ws-b985…/opus-fable" → "Opus 5 + Fable
 * oracle"), or null when the id isn't one.
 *
 * A session can run a preset from a DIFFERENT workspace — /model and a carried
 * default both allow it, and the runner resolves either — while the catalog is
 * always fetched for the session's own workspace. So the exact id can be
 * absent; every workspace seeds the same preset ids, so the trailing segment
 * still names it. Without a catalog at all, the slug is still a name, and the
 * storage path never is.
 */
export function workspacePresetLabel(
  id: string,
  models: ModelOption[],
): string | null {
  const slug = id.match(/^(?:pi\/)?workspace-preset\/[^/]+\/(.+)$/)?.[1];
  if (!slug) return null;
  return (
    models.find((m) => m.id === id)?.label ||
    models.find(
      (m) => m.id.includes("workspace-preset/") && m.id.endsWith(`/${slug}`),
    )?.label ||
    friendlyModelSlug(slug)
  );
}

/** Display name without the vendor noise: "Claude Fable 5.1" → "Fable 5.1",
 * "GPT-5.5 (Codex)" → "GPT-5.5", "engine/anthropic/claude-sonnet-5" →
 * "Sonnet 5". The engine is an implementation detail — it never shows in a
 * model's name. */
export function shortModelLabel(id: string, models: ModelOption[]): string {
  // An engine-routed id reads as its base entry ("pi/dial/opus-fable",
  // "claude/dial/opus-fable" both keep the preset's label, not a slug) —
  // the engine is routing, and it never shows in a model's name.
  const routedBase = baseModelId(id);
  if (routedBase !== id && models.some((m) => m.id === routedBase))
    return shortModelLabel(routedBase, models);
  const preset = workspacePresetLabel(baseModelId(id), models);
  if (preset) return preset;
  const oc = routedModelParts(id);
  if (oc) return friendlyModelSlug(oc.model);
  // Last resort is the id itself, minus its routing prefix — an id with no
  // catalog entry is still a name, and the engine is not part of it.
  const raw = models.find((m) => m.id === id)?.label || routedBase || "Default";
  return raw.replace(/^Claude\s+/i, "").replace(/\s*\(Codex\)$/i, "");
}

/** Friendly names for the upstream providers in the grouped main list. */
const PROVIDER_LABELS: Record<string, string> = {
  dial: "The Dial",
  custom: "Custom",
  orchestrator: "The Orchestrator",
  anthropic: "Anthropic",
  openai: "OpenAI",
  pi: "Pi",
  xai: "xAI",
  meta: "Meta",
  google: "Google",
  openrouter: "OpenRouter",
  groq: "Groq",
  mistral: "Mistral",
  deepseek: "DeepSeek",
  moonshotai: "Moonshot AI",
  cerebras: "Cerebras",
  wafer: "Wafer",
};

/** Section order in the grouped main list; unlisted providers follow in
 * config order. */
const PROVIDER_ORDER = [
  "dial",
  "custom",
  "orchestrator",
  "anthropic",
  "openai",
  "pi",
  "cerebras",
  "wafer",
  "xai",
  "meta",
  "moonshotai",
];

/** Preferred display order for the engine main list (by id tail); anything
 * unlisted keeps its registry/config order after these. */
const MODEL_TAIL_ORDER = [
  // The Dial presets ("dial/<tier>" ids) lead the list, hardest tier first,
  // then The Orchestrator presets ("orchestrator/<name>" ids).
  "ultra",
  "high",
  "medium",
  "low",
  "fable",
  "sol",
  "claude-fable-5-1",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "kimi-k3",
  "gpt-oss-120b",
  "gemma-4-31b",
  "zai-glm-4.7",
  "deepseek-v4-flash-0731-fast",
  "glm-5.2",
  "glm5.2-fast",
  "glm-5.1",
  "kimi-k3",
  "kimi-k3-fast",
  "kimi-k2.6",
];

/** The engine providers whose entries form the first-class model list. */
const ENGINE_PROVIDERS = new Set(["pi"]);

/**
 * Split the registry into the first-class Pi entries and current canonical
 * model slugs, sorted for display. Only retired direct-SDK entries belong in
 * the legacy group; Fable, Sol, and their current siblings remain ordinary
 * choices even against an older server that still returns native ids.
 */
export function splitModelOptions(models: ModelOption[]): {
  primary: ModelOption[];
  legacy: ModelOption[];
} {
  const rank = (m: ModelOption) => {
    const i = MODEL_TAIL_ORDER.indexOf(m.id.split("/").pop() || "");
    return i === -1 ? MODEL_TAIL_ORDER.length : i;
  };
  const isPrimary = (model: ModelOption) =>
    ENGINE_PROVIDERS.has(model.provider) || PRIMARY_MODEL_ID_SET.has(model.id);
  const primary = models
    .filter(isPrimary)
    .map((m, i) => [m, i] as const)
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1])
    .map(([m]) => m);
  return { primary, legacy: models.filter((m) => !isPrimary(m)) };
}

/**
 * A quiet line inside a submenu popup, in the shape of a group label: it names
 * a consequence of the rows under it, and is never a row itself.
 */
function MenuHint({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-2 pt-0.5 pb-1.5 text-supporting text-faint">{children}</p>
  );
}

type ModelMenuOption = {
  value: string;
  /** Label used inside its provider section. */
  label: string;
  /** Label used when the option stands alone in the recent list. */
  standaloneLabel: string;
  id: string;
  /** Engine key (ModelOption.provider) for the legacy-fallback group headers. */
  engine: string;
  /** Picker section override from the registry ("dial" = The Dial). */
  group?: string;
  /** One-line description rendered with the preset label. */
  description?: string;
};

const PICKER_ROW_GAP = "mb-0.5 last:mb-0";

/**
 * Combined model + reasoning-effort menu: one trigger opens a short list of
 * settings rows (Model, Effort, Speed, Account), each showing its current value
 * and opening a submenu, over a "Reset to default" row. The same menu powers
 * the composer pill and the full-width model row in session info, so those two
 * surfaces cannot drift apart. The model list used to sit at the top level,
 * which made the menu as tall as the registry and buried the settings under it;
 * a row per setting keeps the menu one screenful whatever the catalog does, at
 * the cost of one extra hop to change model.
 *
 * Unlike PaletteSelect there is no native-select phone fallback: the nested
 * submenus don't map to a <select>, and Base UI menus handle touch fine.
 */
export function ModelEffortSelect({
  selection,
  appearance = {},
  actions,
}: ModelEffortSelectProps) {
  const {
    models,
    defaultModel,
    model,
    preferredDefaultModel,
    modelDisabled,
    modelTitle,
    effort,
    fastMode,
    accounts,
    accountId,
    usage,
  } = selection;
  const {
    showUsage = false,
    disabled,
    title,
    className,
    triggerVariant = "pill",
    fallbackModelLabel,
  } = appearance;
  const {
    changeModel: onModelChange,
    setAsDefault: onSetAsDefault,
    changeEffort: onEffortChange,
    changeFastMode: onFastModeChange,
    changeAccount: onAccountChange,
    changeOpen: onOpenChange,
  } = actions;
  const effectiveModel = model || defaultModel;
  const isPreferredDefault = preferredDefaultModel === effectiveModel;
  const [recentModelIds, setRecentModelIds] = React.useState(getRecentModels);
  React.useEffect(
    () => onRecentModelsChanged(() => setRecentModelIds(getRecentModels())),
    [],
  );
  // Pi-routed ids resolve to their base list entry for label/effort/account
  // lookups — the engine prefix is routing, not a different model.
  const effectiveBase = baseModelId(effectiveModel);
  // One id→entry index for the whole render. The registry is looked up per
  // menu row as well as several times up here, and this component re-renders
  // on every composer keystroke, so a linear scan per lookup was the picker's
  // share of the typing budget. First entry wins, matching the `.find()` these
  // lookups replaced.
  const modelById = (() => {
    const byId = new Map<string, ModelOption>();
    for (const m of models) if (!byId.has(m.id)) byId.set(m.id, m);
    return byId;
  })();
  const modelLabel =
    modelById.has(effectiveBase) || routedModelParts(effectiveModel)
      ? shortModelLabel(effectiveModel, models)
      : fallbackModelLabel?.(effectiveModel) ||
        shortModelLabel(effectiveModel, models);
  const modelInfo = modelById.get(effectiveBase);
  const supportedEffortIds = modelInfo?.efforts ?? [];
  const supportedEfforts = EFFORTS.filter((e) =>
    supportedEffortIds.includes(e.id),
  );
  const fixedEffort = EFFORTS.find((e) => e.id === modelInfo?.fixedEffort);
  // Presets expose their one fixed effort as a one-choice submenu. That keeps
  // every model settings menu structurally consistent without pretending the
  // preset's lead-model effort can be changed.
  const effortOptions =
    supportedEfforts.length > 0
      ? supportedEfforts
      : fixedEffort
        ? [fixedEffort]
        : [];
  const effectiveEffort =
    fixedEffort?.id ??
    (supportedEffortIds.includes(effort ?? "")
      ? effort!
      : supportedEffortIds.includes("high")
        ? "high"
        : supportedEffortIds[0]);
  const effortLabel = EFFORTS.find((e) => e.id === effectiveEffort)?.label;
  const hasEffort = !!onEffortChange && effortOptions.length > 0;
  const accountProvider = modelInfo?.accountProvider;
  const providerAccounts = (accounts || []).filter(
    (a) => a.provider === accountProvider,
  );
  // Auto is a real account choice even when this person has no pinnable
  // accounts, so keep the row present wherever account selection is wired.
  const hasAccount = !!onAccountChange;
  const currentAccount = accountId
    ? providerAccounts.find((a) => a.id === accountId)
    : undefined;
  const subscriptionAccount = providerAccounts.find(
    (a) => a.kind !== "api_key" && a.usable,
  );
  const fastModeAvailable =
    modelInfo?.fastModeSupported === true &&
    currentAccount?.kind !== "api_key" &&
    !!(currentAccount || subscriptionAccount);
  const hasFastMode = !!onFastModeChange;
  const effectiveFastMode = fastModeAvailable && !!fastMode;
  const speedOptions = fastModeAvailable
    ? [
        { fast: false, label: "Standard" },
        { fast: true, label: "Fast" },
      ]
    : [{ fast: false, label: "Standard" }];
  const accountLabel = currentAccount
    ? providerAccountLabel(currentAccount)
    : "Auto";
  // Routing stays sticky across model changes even though engine selection is
  // no longer exposed. Existing sessions keep their stored routing prefix.
  const activeEngine = modelEngine(effectiveModel);

  // Changing model mid-conversation invalidates the prompt cache,
  // so the next turn re-sends every token of the conversation: roughly
  // twenty times a cached turn's input. Worth saying once the conversation is
  // big enough for that to cost something, and only where it is true: an
  // Anthropic prompt cache is keyed on the whole prefix, so the reasoning
  // effort is inside it, while OpenAI's reasoning effort rides outside.
  // A hint, not a gate: no confirmation, nothing disabled.
  const contextTokens = usage?.contextTokens ?? 0;
  const reuploadHint =
    contextTokens >= 20_000
      ? `Switching re-uploads ~${Math.round(contextTokens / 1000)}k tokens`
      : null;
  const effortReuploadHint =
    reuploadHint && isAnthropicModel(effectiveModel, accountProvider)
      ? reuploadHint
      : null;

  // "Reset to default" puts every row in this menu back where a fresh session
  // starts: following the default model (not pinning it), that model's own
  // default effort, fast mode off, account on auto. Effort resolves against
  // the DEFAULT model rather than the current one — reset changes both, and
  // the effort the current model happens to support may not exist there.
  const defaultModelInfo = modelById.get(baseModelId(defaultModel));
  const defaultEffortIds = defaultModelInfo?.efforts ?? [];
  const defaultEffort =
    defaultModelInfo?.fixedEffort ||
    (defaultEffortIds.includes("high") ? "high" : defaultEffortIds[0]);
  const atDefault =
    (modelDisabled || model === "" || model === defaultModel) &&
    (!hasEffort || !defaultEffort || effectiveEffort === defaultEffort) &&
    (!hasFastMode || !effectiveFastMode) &&
    (!hasAccount || !accountId);
  const resetToDefault = () => {
    if (!modelDisabled) onModelChange("");
    if (onEffortChange && defaultEffort) onEffortChange(defaultEffort);
    if (onFastModeChange) onFastModeChange(false);
    if (onAccountChange) onAccountChange("");
  };

  // The whole option list depends only on the registry and the default, so it
  // is built once per catalog change rather than per keystroke: splitting the
  // registry, prettifying a label per entry and re-scanning `models` inside
  // `optionFor` add up to real work on a list this long.
  const { primaryFirst, allPrimaryOptions, allOtherOptions } = (() => {
    const optionFor = (id: string): ModelMenuOption => {
      const info = modelById.get(id);
      const shortLabel = shortModelLabel(id, models);
      const standaloneLabel =
        info?.group === "dial" || info?.group === "orchestrator"
          ? info.label
          : shortLabel;
      return {
        value: id === defaultModel ? "" : id,
        // Preset rows drop their "Dial · " / "Orchestrator · " prefix because
        // their section already names it. Recent rows use the standalone label.
        label:
          info?.group === "dial" || info?.group === "orchestrator"
            ? shortLabel.replace(/^(?:Dial|Orchestrator)\s*·\s*/, "")
            : shortLabel,
        standaloneLabel,
        id,
        engine: info?.provider || (routedModelParts(id) ? "pi" : "claude"),
        group: info?.group,
        description: info?.description,
      };
    };
    // Legacy entries keep their FULL registry label ("Claude Sonnet 5",
    // "GPT-5.5 (Codex)") so they never read as duplicates of the first-class
    // short names above them.
    const legacyOptionFor = (m: ModelOption): ModelMenuOption => ({
      value: m.id === defaultModel ? "" : m.id,
      label: m.label,
      standaloneLabel: m.label,
      id: m.id,
      engine: m.provider,
    });
    const { primary: primaryModels, legacy: legacyModels } =
      splitModelOptions(models);
    // With engine configured it IS the model list: its entries are the main
    // list (friendly names, no engine anywhere) and the native claude/codex
    // entries — automation/fallback plumbing during the migration — tuck under
    // a de-emphasized "Legacy (direct SDK)" submenu at the bottom.
    const primaryFirst = primaryModels.length > 0;
    const availableModelIds = new Set(models.map((m) => m.id));
    const allPrimaryOptions = primaryFirst
      ? primaryModels.map((m) => optionFor(m.id))
      : PRIMARY_MODEL_IDS.filter((id) => availableModelIds.has(id)).map((id) =>
          optionFor(id),
        );
    const allOtherOptions = primaryFirst
      ? legacyModels.map(legacyOptionFor)
      : models
          .filter((m) => !PRIMARY_MODEL_ID_SET.has(m.id))
          .map((m) => optionFor(m.id));
    return { primaryFirst, allPrimaryOptions, allOtherOptions };
  })();
  // The stored routing prefix narrows the list rather than greying half of it
  // out: the direct-SDK engines each speak to one vendor, so on those a model
  // they can't run is noise, not a choice. A null recomposition means "can't
  // route there", and presets stay visible since a preset names its own models.
  // Pi serves every configured model; it still meets
  // the odd unroutable legacy slug, which stays a disabled row below).
  const {
    primaryOptions,
    otherOptions,
    hiddenOnEngine,
    otherGroups,
    groupedPrimary,
    providerGroups,
  } = (() => {
    const filterToEngine = false;
    const servableHere = (o: ModelMenuOption) =>
      !filterToEngine || engineModelId(activeEngine, o.id) !== null;
    const primaryOptions = allPrimaryOptions.filter(servableHere);
    const otherOptions = allOtherOptions.filter(servableHere);
    const hiddenOnEngine =
      allPrimaryOptions.length +
      allOtherOptions.length -
      primaryOptions.length -
      otherOptions.length;
    // No-engine fallback only: "Other models" grouped by engine. With
    // engine present the submenu is the flat legacy list instead.
    const engineOrder = ["pi", "claude", "codex"];
    const engines = [
      ...engineOrder,
      ...otherOptions
        .map((o) => o.engine)
        .filter((e) => !engineOrder.includes(e)),
    ];
    const otherGroups = [...new Set(engines)]
      .map((engine) => ({
        engine,
        label: ENGINE_LABELS[engine] || engine,
        options: otherOptions.filter((o) => o.engine === engine),
      }))
      .filter((g) => g.options.length > 0);
    // Main-list sections by upstream provider (Anthropic / OpenAI / xAI / …) —
    // a flat list stops scanning well once third-party providers join the
    // picker. Falls back to flat when everything is one provider.
    const providerOf = (id: string) =>
      routedModelParts(id)?.provider || "other";
    const providerGroups: Array<{
      provider: string;
      label: string;
      options: ModelMenuOption[];
    }> = [];
    for (const option of primaryOptions) {
      // A registry group ("dial") overrides provider-segment grouping.
      const provider = option.group || providerOf(option.id);
      let group = providerGroups.find((g) => g.provider === provider);
      if (!group) {
        group = {
          provider,
          label:
            PROVIDER_LABELS[provider] ||
            provider.charAt(0).toUpperCase() + provider.slice(1),
          options: [],
        };
        providerGroups.push(group);
      }
      group.options.push(option);
    }
    providerGroups.sort((a, b) => {
      const ai = PROVIDER_ORDER.indexOf(a.provider);
      const bi = PROVIDER_ORDER.indexOf(b.provider);
      return (
        (ai === -1 ? PROVIDER_ORDER.length : ai) -
        (bi === -1 ? PROVIDER_ORDER.length : bi)
      );
    });
    const groupedPrimary = primaryFirst && providerGroups.length > 1;
    return {
      primaryOptions,
      otherOptions,
      hiddenOnEngine,
      otherGroups,
      groupedPrimary,
      providerGroups,
    };
  })();

  const isSelected = (option: ModelMenuOption) =>
    option.value === model ||
    option.id === effectiveBase ||
    (option.value === "" && (model === "" || model === defaultModel));
  // Dim hint on the legacy submenu trigger when the CURRENT model lives in
  // there — otherwise the open menu would show no checked row at all.
  const selectedLegacyLabel =
    primaryFirst && !primaryOptions.some(isSelected)
      ? otherOptions.find(isSelected)?.label
      : undefined;
  const recentOptions = (() => {
    const available = new Map(
      [...primaryOptions, ...otherOptions].map((option) => [option.id, option]),
    );
    return recentModelIds
      .map((id) => available.get(id))
      .filter((option): option is ModelMenuOption => !!option)
      .slice(0, 3);
  })();

  const renderModelOption = (option: ModelMenuOption, standalone = false) => {
    const selected = isSelected(option);
    const optionLabel = standalone ? option.standaloneLabel : option.label;
    const optionDescription = standalone ? undefined : option.description;
    const nextModelInfo = modelById.get(option.id);
    const nextEfforts = nextModelInfo?.efforts ?? [];
    const nextEffort =
      nextModelInfo?.fixedEffort ||
      (nextEfforts.includes(effort ?? "")
        ? effort
        : nextEfforts.includes("high")
          ? "high"
          : nextEfforts[0]);
    const recentSettings = standalone
      ? [
          onFastModeChange &&
          effectiveFastMode &&
          nextModelInfo?.fastModeSupported === true
            ? "Fast"
            : undefined,
          onEffortChange
            ? EFFORTS.find((e) => e.id === nextEffort)?.label
            : undefined,
        ].filter((label): label is string => !!label)
      : [];
    // Engine stays sticky across model changes: the new id is recomposed onto
    // the engine the session is already on. An entry that can't route there
    // (wrong vendor for a direct-SDK engine, a legacy native id) is offered
    // disabled rather than silently dropped back to engine.
    const routed = engineModelId(activeEngine, option.id);
    const offEngine = routed === null;
    const disabled = modelDisabled || offEngine;
    const item = (
      <Menu.Item
        onClick={() => {
          onModelChange(routed ?? option.value);
          pushRecentModel(option.id);
          if (
            onEffortChange &&
            !nextEfforts.includes(effort ?? "") &&
            nextEffort
          ) {
            onEffortChange(nextEffort);
          }
          if (onFastModeChange && nextModelInfo?.fastModeSupported !== true) {
            onFastModeChange(false);
          }
        }}
        disabled={disabled}
        title={
          modelDisabled
            ? modelTitle
            : offEngine
              ? "Not available in this session"
              : undefined
        }
        className={cn(
          PICKER_ROW_GAP,
          "justify-between gap-3",
          selected && "bg-hover",
          disabled && "opacity-55",
        )}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          {/* The slot stays fixed so paired marks can overhang into the gap
					    without shifting any row labels. */}
          <span className="flex size-4 shrink-0 items-center justify-center text-dim">
            <ModelMark
              id={option.id}
              provider={option.engine}
              composition={nextModelInfo?.composition}
            />
          </span>
          {optionDescription ? (
            <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
              <span className="shrink-0">{optionLabel}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-faint">
                {optionDescription}
              </span>
            </span>
          ) : (
            <span className="min-w-0 truncate">{optionLabel}</span>
          )}
        </span>
        {recentSettings.length > 0 && (
          <span className="ml-auto shrink-0 text-supporting text-faint">
            {recentSettings.join(" · ")}
          </span>
        )}
        <Menu.Check on={selected} className="text-dim" />
      </Menu.Item>
    );
    return optionDescription ? (
      <Tooltip
        key={option.value || option.id}
        label={optionDescription}
        side="right"
        multiline
      >
        {item}
      </Tooltip>
    ) : (
      React.cloneElement(item, { key: option.value || option.id })
    );
  };

  const menuRowTrigger = triggerVariant === "menu-row";
  const heroTrigger = triggerVariant === "hero";

  return (
    <Menu.Root onOpenChange={onOpenChange}>
      <Menu.Trigger
        type="button"
        className={cn(
          menuRowTrigger
            ? "flex w-full cursor-pointer items-center gap-[7px] whitespace-nowrap rounded-control border border-line-strong bg-transparent px-3 py-[7px] text-control-label font-medium text-faint hover:bg-hover hover:text-fg data-[popup-open]:bg-hover data-[popup-open]:text-fg"
            : heroTrigger
              ? "inline-flex min-h-11 min-w-0 max-w-full cursor-pointer items-center rounded-md border-0 bg-transparent px-1.5 text-label font-medium text-dim transition-[color,background-color,scale] hover:bg-hover hover:text-fg active:scale-[0.96] data-[popup-open]:bg-hover data-[popup-open]:text-fg"
              : "border-transparent hover:border-transparent hover:bg-hover",
          className,
        )}
        title={title}
        disabled={
          disabled ||
          (!!modelDisabled && !hasEffort && !hasFastMode && !hasAccount)
        }
        aria-label={
          hasAccount
            ? "Model, reasoning effort, and provider account"
            : hasEffort
              ? "Model and reasoning effort"
              : "Model"
        }
      >
        {menuRowTrigger ? (
          <>
            <IconSparkle size={18} className="shrink-0 text-faint" />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
              <span className="text-meta font-semibold leading-none text-faint">
                Model
              </span>
              <span className="truncate text-control-label leading-[1.2] text-fg">
                {modelLabel}
              </span>
            </span>
            <IconChevronRight size={16} className="shrink-0 text-faint" />
          </>
        ) : heroTrigger ? (
          <span className="truncate">{modelLabel}</span>
        ) : (
          <>
            {/* `data-effort` is a styling hook for the caller, not state: the
						    new-session footer hides the suffix on ultra-narrow screens so the
						    model name keeps the room, and the composer toolbar does not. */}
            {hasFastMode && effectiveFastMode && (
              <>
                <IconBolt className="flex-none text-faint" size={20} />
                <span className="sr-only">Fast mode</span>
              </>
            )}
            <span className="truncate">{modelLabel}</span>
            {hasEffort && (
              <span data-effort className="flex-none text-faint">
                {effortLabel}
              </span>
            )}
          </>
        )}
      </Menu.Trigger>
      <Menu.Popup
        align={menuRowTrigger ? "start" : heroTrigger ? "center" : "end"}
        sideOffset={6}
        className={cn(
          "max-w-[min(360px,calc(100vw-1rem))]",
          menuRowTrigger && "min-w-[220px]",
        )}
      >
        {showUsage && (
          <>
            <Menu.SubmenuRoot>
              <Menu.SubmenuTrigger className="justify-between gap-3">
                <span className="min-w-0 truncate">Conversation usage</span>
                <span className="flex flex-none items-center gap-1 text-dim">
                  <UsageCost usage={usage} />
                  <IconChevronRight className="shrink-0" size={17} />
                </span>
              </Menu.SubmenuTrigger>
              <Menu.Popup className="w-64 max-w-[min(360px,calc(100vw-1rem))]">
                <UsageDetails usage={usage} className="p-1.5" />
              </Menu.Popup>
            </Menu.SubmenuRoot>
            <Menu.Separator className="my-1" />
          </>
        )}
        {recentOptions.length > 0 && (
          <>
            <Menu.Group>
              <Menu.GroupLabel>Recent models</Menu.GroupLabel>
              {recentOptions.map((option) => renderModelOption(option, true))}
            </Menu.Group>
            <Menu.Separator className="my-1" />
          </>
        )}
        <Menu.SubmenuRoot>
          <Menu.SubmenuTrigger className="justify-between gap-3">
            <span className="min-w-0 truncate">Model</span>
            <span className="flex min-w-0 flex-none items-center gap-1 text-dim">
              <span className="truncate">{modelLabel}</span>
              <IconChevronRight className="shrink-0" size={17} />
            </span>
          </Menu.SubmenuTrigger>
          <Menu.Popup className="max-w-[min(360px,calc(100vw-1rem))]">
            {reuploadHint && <MenuHint>{reuploadHint}</MenuHint>}
            {groupedPrimary
              ? providerGroups.map((g, i) => (
                  <React.Fragment key={g.provider}>
                    {i > 0 && <Menu.Separator className="my-1" />}
                    <Menu.Group>
                      <Menu.GroupLabel>{g.label}</Menu.GroupLabel>
                      {g.options.map((option) => renderModelOption(option))}
                    </Menu.Group>
                  </React.Fragment>
                ))
              : primaryOptions.map((option) => renderModelOption(option))}
            {otherOptions.length > 0 && (
              <Menu.SubmenuRoot>
                <Menu.SubmenuTrigger
                  className={cn(
                    "justify-between gap-3",
                    primaryFirst && "text-dim",
                  )}
                >
                  <span className="min-w-0 truncate">
                    {primaryFirst ? LEGACY_GROUP_LABEL : "Other models"}
                  </span>
                  <span className="flex flex-none items-center gap-1 text-dim">
                    {selectedLegacyLabel && (
                      <span className="text-faint">{selectedLegacyLabel}</span>
                    )}
                    <IconChevronRight className="shrink-0" size={17} />
                  </span>
                </Menu.SubmenuTrigger>
                <Menu.Popup className="max-w-[min(360px,calc(100vw-1rem))]">
                  {!primaryFirst && otherGroups.length > 1
                    ? otherGroups.map((g, i) => (
                        <React.Fragment key={g.engine}>
                          {i > 0 && <Menu.Separator className="my-1" />}
                          <Menu.Group>
                            <Menu.GroupLabel>{g.label}</Menu.GroupLabel>
                            {g.options.map((option) =>
                              renderModelOption(option),
                            )}
                          </Menu.Group>
                        </React.Fragment>
                      ))
                    : otherOptions.map((option) => renderModelOption(option))}
                </Menu.Popup>
              </Menu.SubmenuRoot>
            )}
            {hiddenOnEngine > 0 && (
              <MenuHint>
                {hiddenOnEngine} {hiddenOnEngine === 1 ? "model" : "models"} not
                available here
              </MenuHint>
            )}
          </Menu.Popup>
        </Menu.SubmenuRoot>
        {hasEffort && (
          <Menu.SubmenuRoot>
            <Menu.SubmenuTrigger className="justify-between gap-3">
              <span className="min-w-0 truncate">Effort</span>
              <span className="flex flex-none items-center gap-1 text-dim">
                {effortLabel}
                <IconChevronRight className="shrink-0 text-dim" size={17} />
              </span>
            </Menu.SubmenuTrigger>
            <Menu.Popup className="max-w-[min(360px,calc(100vw-1rem))]">
              {effortReuploadHint && <MenuHint>{effortReuploadHint}</MenuHint>}
              {effortOptions.map((e) => {
                const selected = effectiveEffort === e.id;
                return (
                  <Menu.Item
                    key={e.id}
                    onClick={() => onEffortChange!(e.id)}
                    className={cn(
                      PICKER_ROW_GAP,
                      "justify-between gap-3",
                      selected && "bg-hover",
                    )}
                  >
                    <span className="min-w-0 truncate">{e.label}</span>
                    <Menu.Check on={selected} className="text-dim" />
                  </Menu.Item>
                );
              })}
            </Menu.Popup>
          </Menu.SubmenuRoot>
        )}
        {hasFastMode && (
          <Menu.SubmenuRoot>
            <Menu.SubmenuTrigger className="justify-between gap-3">
              <span className="min-w-0 truncate">Speed</span>
              <span className="flex flex-none items-center gap-1 text-dim">
                {effectiveFastMode ? "Fast" : "Standard"}
                <IconChevronRight className="shrink-0 text-dim" size={17} />
              </span>
            </Menu.SubmenuTrigger>
            <Menu.Popup className="max-w-[min(360px,calc(100vw-1rem))]">
              {speedOptions.map((o) => {
                const selected = effectiveFastMode === o.fast;
                return (
                  <Menu.Item
                    key={o.label}
                    onClick={() => {
                      // Fast mode runs on a subscription account, so picking it
                      // while on auto pins the one it will actually use.
                      if (o.fast && !currentAccount && subscriptionAccount) {
                        onAccountChange?.(subscriptionAccount.id);
                      }
                      onFastModeChange!(o.fast);
                    }}
                    className={cn(
                      "justify-between gap-3",
                      selected && "bg-hover",
                    )}
                  >
                    <span className="min-w-0 truncate">{o.label}</span>
                    <Menu.Check on={selected} className="text-dim" />
                  </Menu.Item>
                );
              })}
            </Menu.Popup>
          </Menu.SubmenuRoot>
        )}
        {hasAccount && (
          <Menu.SubmenuRoot>
            <Menu.SubmenuTrigger className="justify-between gap-3">
              <span className="min-w-0 truncate">Account</span>
              <span className="flex flex-none items-center gap-1 text-dim">
                {accountLabel}
                <IconChevronRight className="shrink-0 text-dim" size={17} />
              </span>
            </Menu.SubmenuTrigger>
            <Menu.Popup className="max-w-[min(360px,calc(100vw-1rem))]">
              <Menu.Item
                onClick={() => onAccountChange!("")}
                className={cn(
                  PICKER_ROW_GAP,
                  "justify-between gap-3",
                  !accountId && "bg-hover",
                )}
              >
                <span className="min-w-0 truncate">Auto</span>
                <Menu.Check on={!accountId} className="text-dim" />
              </Menu.Item>
              {providerAccounts.map((a) => {
                const selected = a.id === accountId;
                return (
                  <Menu.Item
                    key={a.id}
                    onClick={() => onAccountChange!(a.id)}
                    className={cn(
                      PICKER_ROW_GAP,
                      "justify-between gap-3",
                      selected && "bg-hover",
                    )}
                  >
                    <span className="min-w-0 truncate">
                      {providerAccountLabel(a)}
                      {a.owner ? ` · ${a.owner}` : ""}
                      {a.usable ? "" : " · exhausted"}
                    </span>
                    <Menu.Check on={selected} className="text-dim" />
                  </Menu.Item>
                );
              })}
            </Menu.Popup>
          </Menu.SubmenuRoot>
        )}
        <Menu.Separator className="my-1" />
        {onSetAsDefault && (
          <Menu.Item
            onClick={() => onSetAsDefault(effectiveModel)}
            disabled={isPreferredDefault}
            title={`Use ${modelLabel} for new sessions`}
            className={cn(
              "justify-between gap-3",
              isPreferredDefault && "opacity-55",
            )}
          >
            <span className="min-w-0 truncate">Set as default</span>
            <Menu.Check on={isPreferredDefault} className="text-dim" />
          </Menu.Item>
        )}
        <Menu.Item
          onClick={resetToDefault}
          disabled={atDefault}
          className={cn("justify-between gap-3", atDefault && "opacity-55")}
        >
          <span className="min-w-0 truncate">Reset to default</span>
          <IconUndo className="shrink-0 text-dim" size={17} />
        </Menu.Item>
      </Menu.Popup>
    </Menu.Root>
  );
}
