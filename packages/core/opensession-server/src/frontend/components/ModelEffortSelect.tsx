import React from "react";
import type { ModelOption } from "../lib/api";
import {
  baseModelId,
  engineModelId,
  isAnthropicModel,
  modelEngine,
} from "../lib/model-engine";
import {
  accountOwnerLabel,
  providerAccountLabel,
} from "../lib/provider-account";
import { Menu } from "../ui/menu";
import { selectTriggerClasses } from "../ui/select-classes";
import { Badge } from "../ui/badge";
import { cn } from "../ui/cn";
import {
  IconBolt,
  IconRocket,
  IconChevronDown,
  IconChevronRight,
  IconPeople,
  IconSparkle,
  IconUndo,
} from "./icons";
import { modelGuidanceFor, uniqueModelGuidances } from "../lib/model-guidance";
import { isTouchPrimary } from "../lib/platform";
import { ModelGuidanceFooter } from "./ModelGuidanceFooter";
import { ModelMark } from "./ModelMark";
import { BrandMark } from "./BrandTile";
import { UserAvatar } from "./UserAvatar";
import { useCurrentUser } from "./UserPicker";
import { useNavigation } from "../hooks/useNavigation";
import { usePeople } from "../lib/people";
import type { ModelEffortSelectProps } from "../lib/model-effort-select-types";
import type { SessionSpeed } from "@tellahq/opensession-protocol/session";

/** ChatGPT plan with Ultrafast access (Pro $500). */
const ULTRAFAST_PLAN = "promax";

const SPEED_LABELS: Record<SessionSpeed, string> = {
  standard: "Standard",
  fast: "Fast",
  ultrafast: "Ultrafast",
};
import {
  weeklyRemainingReadout,
  weeklyRemainingRows,
  type WeeklyRemainingRow,
} from "../lib/account-limits";
import { UsageCost, UsageDetails } from "./UsageMeter";
import { setUsageBarPref, useUsageBarPref } from "../lib/usage-bar-pref";
import { setTopModelOrder, useTopModelOrder } from "../lib/top-model-order";
import { pushRecentModel, useRecentModels } from "../lib/model-recents";
import { Reorder } from "motion/react";

export const EFFORTS = [
  { id: "none", label: "None" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra high" },
  { id: "max", label: "Max" },
];

const PRIMARY_MODEL_IDS = [
  "claude-fable-5-2",
  "claude-mythos-5-2",
  "claude-mythos-5-1",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "gpt-6.2-astra",
  "gpt-6.2-sol",
  "gpt-6.1-terra",
  "gpt-6-luna",
] as const;
const PRIMARY_MODEL_ID_SET = new Set<string>(PRIMARY_MODEL_IDS);

/** How many models the picker lists at its top level. */
export const TOP_MODEL_COUNT = 5;

/** The best current models, by id tail, in the order the picker lists them.
 * They fill the top level until a person's recent picks take their places,
 * so update this when a model ships or retires; everything else sits under
 * "More models". */
const TOP_MODEL_TAILS = [
  "claude-fable-5-2",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "gpt-6.2-astra",
  "gpt-6.2-sol",
];

const idTail = (id: string) => id.split("/").pop() || "";

/**
 * Split the picker's first-class entries into the top-level five and the rest.
 * `recent` (id tails, newest first) decides which five: the models a person
 * picked lately come in first, and the curated best, then the catalog's own
 * order, fill the slots left over, so someone with no picks yet sees the best
 * five and the top level is never short while models remain.
 * The five are listed in a fixed order so a pick never moves the rows around:
 * `order`, the person's dragged order (id tails), first, then curated, then
 * catalog order.
 */
export function pickTopModels<T extends { id: string }>(
  options: readonly T[],
  order: readonly string[] = [],
  recent: readonly string[] = [],
) {
  const tail = (o: T) => idTail(o.id);
  const byTails = (tails: readonly string[]) =>
    tails.flatMap((t) => {
      const option = options.find((o) => tail(o) === t);
      return option ? [option] : [];
    });
  const curated = byTails(TOP_MODEL_TAILS);
  const best = [...curated, ...options.filter((o) => !curated.includes(o))];
  const chosen = new Set(
    [...new Set([...byTails(recent), ...best])].slice(0, TOP_MODEL_COUNT),
  );
  const rank = (o: T) => {
    const i = order.indexOf(tail(o));
    return i === -1 ? order.length : i;
  };
  const top = best
    .filter((o) => chosen.has(o))
    .map((o, i) => [o, i] as const)
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1])
    .map(([o]) => o);
  return { top, more: options.filter((o) => !chosen.has(o)) };
}

/** Engine display names, keyed by ModelOption.provider — only used for the
 * legacy (no-engine-configured) grouping fallback below. */
export const ENGINE_LABELS = {
  claude: "Claude",
  codex: "Codex",
  pi: "Pi",
};
const ENGINE_LABEL_BY_ID = new Map(Object.entries(ENGINE_LABELS));

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
          /^(astra|sol|terra|luna)$/i,
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
 * A name for a retired workspace ("Custom") preset id stored on an older
 * session ("workspace-preset/ws-b985…/opus-fable" → "Opus Fable"), or null
 * when the id isn't one. The slug is still a name; the storage path never is.
 */
export function workspacePresetLabel(id: string): string | null {
  const slug = id.match(/^(?:pi\/)?workspace-preset\/[^/]+\/(.+)$/)?.[1];
  return slug ? friendlyModelSlug(slug) : null;
}

/** Display name without the vendor noise: "Claude Fable 5.2" → "Fable 5.2",
 * "GPT-5.5 (Codex)" → "GPT-5.5", "engine/anthropic/claude-sonnet-5" →
 * "Sonnet 5". The engine is an implementation detail — it never shows in a
 * model's name. */
export function shortModelLabel(id: string, models: ModelOption[]): string {
  // A retired preset id reads as the model it ran on.
  const routedBase = baseModelId(id);
  if (routedBase !== id) return shortModelLabel(routedBase, models);
  const preset = workspacePresetLabel(id);
  if (preset) return preset;
  const oc = routedModelParts(id);
  if (oc) return friendlyModelSlug(oc.model);
  // Last resort is the id itself, minus its routing prefix — an id with no
  // catalog entry is still a name, and the engine is not part of it.
  const raw = models.find((m) => m.id === id)?.label || routedBase || "Default";
  return raw.replace(/^Claude\s+/i, "").replace(/\s*\(Codex\)$/i, "");
}

/** Friendly names for the upstream providers in the grouped main list. */
const PROVIDER_LABELS = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  pi: "Pi",
  "xai-oauth": "xAI SuperGrok",
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
const PROVIDER_LABEL_BY_ID = new Map(Object.entries(PROVIDER_LABELS));

/** Section order in the grouped main list; unlisted providers follow in
 * config order. */
const PROVIDER_ORDER = [
  "anthropic",
  "openai",
  "xai-oauth",
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
  "claude-fable-5-2",
  "claude-mythos-5-2",
  "claude-mythos-5-1",
  "claude-opus-5-5",
  "claude-opus-4-8",
  "claude-sonnet-5-5",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-5-5",
  "claude-haiku-4-5",
  "gpt-6.2-astra",
  "gpt-6.2-sol",
  "gpt-6.1-terra",
  "gpt-6-luna",
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
type SplitModelOptions = {
  primary: ModelOption[];
  legacy: ModelOption[];
};

export function splitModelOptions(models: ModelOption[]): SplitModelOptions {
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
  label: string;
  id: string;
  /** Engine key (ModelOption.provider) for the legacy-fallback group headers. */
  engine: string;
};

const PICKER_ROW_GAP = "mb-0.5 last:mb-0";

/** Ink for a weekly-remaining figure: colour only once it is running out. */
const REMAINING_TONE: Record<WeeklyRemainingRow["tone"], string> = {
  low: "text-red",
  warn: "text-yellow",
  ok: "text-green",
};

/** Brand mark for an account pool, keyed by ProviderAccountOption.provider. */
const ACCOUNT_BRAND: Record<WeeklyRemainingRow["provider"], string> = {
  claude: "claude",
  codex: "codex",
  xai: "xai",
};

/**
 * Combined model + reasoning-effort menu: one trigger opens the five best
 * models as rows, a "More models" submenu for the rest of the catalog, Effort
 * and Speed rows that show their current value and open a submenu, and one
 * Options submenu for the rarer settings (account, auto-fallback, usage,
 * defaults). The same menu powers the composer pill and the full-width model
 * row in session info, so those two surfaces cannot drift apart. Capping the
 * top level at five models and two settings keeps the menu short whatever the
 * catalog does, while the usual picks take one click.
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
    preferredDefaultEffort,
    modelDisabled,
    modelTitle,
    effort,
    autoFallback = true,
    speed,
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
    changeAutoFallback: onAutoFallbackChange,
    changeSpeed: onSpeedChange,
    changeAccount: onAccountChange,
    changeOpen: onOpenChange,
    reset: onReset,
  } = actions;
  const effectiveModel = model || defaultModel;
  const usageBarOn = useUsageBarPref();
  const savedTopOrder = useTopModelOrder();
  const recentModels = useRecentModels();
  // Mid-drag, Motion's in-flight order of the top five (option ids); saved as
  // the person's order when the row is dropped.
  const [draftTopIds, setDraftTopIds] = React.useState<string[] | null>(null);
  const [draggingTopId, setDraggingTopId] = React.useState<string | null>(null);
  const [hoveredModelId, setHoveredModelId] = React.useState<string | null>(
    null,
  );
  const [hoveredMoreModelId, setHoveredMoreModelId] = React.useState<
    string | null
  >(null);
  const draftTopIdsRef = React.useRef<string[] | null>(null);
  // A drop ends in a click on the row under the pointer; it must not pick it.
  const justDragged = React.useRef(false);
  const [open, setOpen] = React.useState(false);
  const setMenuOpen = (nextOpen: boolean) => {
    setOpen(nextOpen);
    onOpenChange?.(nextOpen);
  };
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
  const effortOptions = supportedEfforts;
  const effectiveEffort = supportedEffortIds.includes(effort ?? "")
    ? effort!
    : supportedEffortIds.includes("high")
      ? "high"
      : supportedEffortIds[0];
  const effortLabel = EFFORTS.find((e) => e.id === effectiveEffort)?.label;
  const hasEffort = !!onEffortChange && effortOptions.length > 0;
  const defaultEffortToSave = hasEffort ? effectiveEffort : undefined;
  const isPreferredDefault =
    preferredDefaultModel === effectiveModel &&
    (defaultEffortToSave === undefined ||
      preferredDefaultEffort === defaultEffortToSave);
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
  // Ultrafast is Astra or Sol on a Pro $500 login: the pinned account, or
  // on auto any usable one, which the server routes ultrafast turns to.
  const ultrafastAccount = providerAccounts.find(
    (a) => a.plan === ULTRAFAST_PLAN && a.kind !== "api_key" && a.usable,
  );
  const ultrafastAvailable =
    fastModeAvailable &&
    modelInfo?.ultrafastSupported === true &&
    (currentAccount
      ? currentAccount.plan === ULTRAFAST_PLAN
      : !!ultrafastAccount);
  const hasSpeed = !!onSpeedChange;
  const effectiveSpeed: SessionSpeed =
    speed === "ultrafast" && ultrafastAvailable
      ? "ultrafast"
      : speed && speed !== "standard" && fastModeAvailable
        ? "fast"
        : "standard";
  const speedOptions: SessionSpeed[] = [
    "standard",
    ...(fastModeAvailable ? (["fast"] as const) : []),
    ...(ultrafastAvailable ? (["ultrafast"] as const) : []),
  ];
  // A speed row with only Standard in it is not a choice; it appears once
  // the model and account offer a faster tier.
  const showSpeedRow =
    hasSpeed && (speedOptions.length > 1 || effectiveSpeed !== "standard");
  const accountLabel = currentAccount
    ? providerAccountLabel(currentAccount)
    : "Auto";
  // The submenu inventories every account this person can spend. Its compact
  // readout is narrower: the current main model's cap on the account automatic
  // routing will prefer (personal first, then pool), or the explicit pin.
  const viewer = useCurrentUser();
  const navigation = useNavigation();
  // The owner avatars resolve through the people directory; subscribing here
  // fetches it if nothing else has yet and redraws the rows when it lands.
  usePeople();
  const weeklyRows = weeklyRemainingRows(accounts ?? [], viewer);
  const weeklyRowsForModel = weeklyRows.filter(
    (row) => row.provider === accountProvider,
  );
  const weeklyReadout = weeklyRemainingReadout({
    rows: weeklyRows,
    accounts: accounts ?? [],
    viewer,
    provider: accountProvider,
    model: effectiveBase,
    accountId,
  });
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
  const defaultEffort = defaultEffortIds.includes("high")
    ? "high"
    : defaultEffortIds[0];
  const atDefault =
    (modelDisabled || model === "" || model === defaultModel) &&
    (!hasEffort || !defaultEffort || effectiveEffort === defaultEffort) &&
    (!hasSpeed || effectiveSpeed === "standard") &&
    (!hasAccount || !accountId) &&
    (!onAutoFallbackChange || autoFallback);
  const resetToDefault = () => {
    if (onReset) return onReset();
    if (!modelDisabled) onModelChange("");
    if (onEffortChange && defaultEffort) onEffortChange(defaultEffort);
    onAutoFallbackChange?.(true);
    if (onSpeedChange) onSpeedChange("standard");
    if (onAccountChange) onAccountChange("");
  };

  // The whole option list depends only on the registry and the default, so it
  // is built once per catalog change rather than per keystroke: splitting the
  // registry, prettifying a label per entry and re-scanning `models` inside
  // `optionFor` add up to real work on a list this long.
  const { primaryFirst, allPrimaryOptions, allOtherOptions } = (() => {
    const optionFor = (id: string): ModelMenuOption => {
      const info = modelById.get(id);
      return {
        value: id === defaultModel ? "" : id,
        label: shortModelLabel(id, models),
        id,
        engine: info?.provider || (routedModelParts(id) ? "pi" : "claude"),
      };
    };
    // Legacy entries keep their FULL registry label ("Claude Sonnet 5",
    // "GPT-5.5 (Codex)") so they never read as duplicates of the first-class
    // short names above them.
    const legacyOptionFor = (m: ModelOption): ModelMenuOption => ({
      value: m.id === defaultModel ? "" : m.id,
      label: m.label,
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
  // route there".
  // Pi serves every configured model; it still meets
  // the odd unroutable legacy slug, which stays a disabled row below).
  const {
    topOptions,
    morePrimaryOptions,
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
        label: ENGINE_LABEL_BY_ID.get(engine) || engine,
        options: otherOptions.filter((o) => o.engine === engine),
      }))
      .filter((g) => g.options.length > 0);
    // The best five sit at the top level; the rest of the main list moves
    // under "More models".
    const { top: topOptions, more: morePrimaryOptions } = pickTopModels(
      primaryOptions,
      savedTopOrder,
      recentModels,
    );
    // "More models" sections by upstream provider (Anthropic / OpenAI / xAI /
    // …): a flat list stops scanning well once third-party providers join the
    // picker. Falls back to flat when everything is one provider.
    const providerOf = (id: string) =>
      routedModelParts(id)?.provider || "other";
    const providerGroups: Array<{
      provider: string;
      label: string;
      options: ModelMenuOption[];
    }> = [];
    for (const option of morePrimaryOptions) {
      const provider = providerOf(option.id);
      let group = providerGroups.find((g) => g.provider === provider);
      if (!group) {
        group = {
          provider,
          label:
            PROVIDER_LABEL_BY_ID.get(provider) ||
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
      topOptions,
      morePrimaryOptions,
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
  // Name the current model on the "More models" trigger when it lives in
  // there; otherwise the open menu would show no checked row at all.
  const selectedMoreOption = topOptions.some(isSelected)
    ? undefined
    : morePrimaryOptions.find(isSelected) || otherOptions.find(isSelected);
  const selectedLegacyLabel =
    primaryFirst && !morePrimaryOptions.some(isSelected)
      ? otherOptions.find(isSelected)?.label
      : undefined;
  const hasMoreModels =
    morePrimaryOptions.length > 0 || otherOptions.length > 0;
  const topById = new Map(topOptions.map((option) => [option.id, option]));
  const shownTopOptions = draftTopIds
    ? draftTopIds.flatMap((id) => {
        const option = topById.get(id);
        return option ? [option] : [];
      })
    : topOptions;
  const updateTopDraft = (ids: string[]) => {
    draftTopIdsRef.current = ids;
    setDraftTopIds(ids);
  };
  const dropTopModel = () => {
    const ids = draftTopIdsRef.current;
    draftTopIdsRef.current = null;
    setDraftTopIds(null);
    setDraggingTopId(null);
    if (ids) setTopModelOrder(ids.map(idTail));
  };

  const renderModelOption = (
    option: ModelMenuOption,
    onPreview?: (id: string) => void,
  ) => {
    const selected = isSelected(option);
    const nextModelInfo = modelById.get(option.id);
    const nextEfforts = nextModelInfo?.efforts ?? [];
    const nextEffort = nextEfforts.includes(effort ?? "")
      ? effort
      : nextEfforts.includes("high")
        ? "high"
        : nextEfforts[0];
    // Engine stays sticky across model changes: the new id is recomposed onto
    // the engine the session is already on. An entry that can't route there
    // (wrong vendor for a direct-SDK engine, a legacy native id) is offered
    // disabled rather than silently dropped back to engine.
    const routed = engineModelId(activeEngine, option.id);
    const offEngine = routed === null;
    const disabled = modelDisabled || offEngine;
    const guidance = modelGuidanceFor(option.id);
    const item = (
      <Menu.Item
        onPointerEnter={onPreview ? () => onPreview(option.id) : undefined}
        onFocus={onPreview ? () => onPreview(option.id) : undefined}
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
          // Ultrafast exists only on Astra and Sol; other models keep Fast
          // where they have it.
          if (onSpeedChange && speed && speed !== "standard") {
            if (nextModelInfo?.fastModeSupported !== true) {
              onSpeedChange("standard");
            } else if (
              speed === "ultrafast" &&
              nextModelInfo.ultrafastSupported !== true
            ) {
              onSpeedChange("fast");
            }
          }
        }}
        disabled={disabled}
        title={
          modelDisabled
            ? modelTitle
            : offEngine
              ? "Not available in this session"
              : (reuploadHint ?? undefined)
        }
        className={cn(
          PICKER_ROW_GAP,
          "justify-between gap-3",
          selected && "bg-hover",
          disabled && "opacity-55",
        )}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2.5">
          {/* The slot stays fixed so rows without a mark keep their labels aligned. */}
          <span className="flex size-4 shrink-0 items-center justify-center text-dim">
            <ModelMark id={option.id} provider={option.engine} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="min-w-0 truncate font-medium leading-[1.25]">
              {option.label}
            </span>
            {guidance && (
              <span className="min-w-0 truncate text-meta leading-[1.3] text-faint">
                {guidance.summary}
              </span>
            )}
          </span>
        </span>
        <Menu.Check on={selected} className="text-dim" />
      </Menu.Item>
    );
    return React.cloneElement(item, { key: option.value || option.id });
  };

  const topSizerGuidances = uniqueModelGuidances([
    ...topOptions.map((option) => option.id),
    effectiveBase,
  ]);
  const topPreviewOption = hoveredModelId
    ? topById.get(hoveredModelId)
    : topOptions.find(isSelected);
  const topPreview = topPreviewOption
    ? {
        id: topPreviewOption.id,
        label: topPreviewOption.label,
        engine: topPreviewOption.engine,
        guidance: modelGuidanceFor(topPreviewOption.id),
      }
    : {
        id: effectiveBase,
        label: modelLabel,
        engine: modelInfo?.provider,
        guidance: modelGuidanceFor(effectiveBase),
      };
  const topGuidanceFooter =
    topOptions.length > 0 &&
    topSizerGuidances.length > 0 &&
    (!isTouchPrimary || topPreview.guidance !== null) ? (
      <ModelGuidanceFooter
        active={topPreview}
        sizerGuidances={topSizerGuidances}
      />
    ) : undefined;

  const moreMenuOptions = primaryFirst
    ? morePrimaryOptions
    : [...morePrimaryOptions, ...otherOptions];
  const moreSizerGuidances = uniqueModelGuidances(
    moreMenuOptions.map((option) => option.id),
  );
  const morePreviewOption =
    (hoveredMoreModelId
      ? moreMenuOptions.find((option) => option.id === hoveredMoreModelId)
      : undefined) ??
    selectedMoreOption ??
    moreMenuOptions.find((option) => modelGuidanceFor(option.id) !== null) ??
    moreMenuOptions[0];
  const morePreviewGuidance = morePreviewOption
    ? modelGuidanceFor(morePreviewOption.id)
    : null;
  const moreGuidanceFooter =
    morePreviewOption &&
    moreSizerGuidances.length > 0 &&
    (!isTouchPrimary || morePreviewGuidance !== null) ? (
      <ModelGuidanceFooter
        active={{
          id: morePreviewOption.id,
          label: morePreviewOption.label,
          engine: morePreviewOption.engine,
          guidance: morePreviewGuidance,
        }}
        sizerGuidances={moreSizerGuidances}
      />
    ) : undefined;

  const menuRowTrigger = triggerVariant === "menu-row";
  const heroTrigger = triggerVariant === "hero";
  const fieldTrigger = triggerVariant === "field";

  return (
    <Menu.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setHoveredModelId(null);
          setHoveredMoreModelId(null);
        }
        setMenuOpen(next);
      }}
    >
      <Menu.Trigger
        type="button"
        onTouchEnd={(event) => {
          // iOS synthesizes mousedown after touchend. That blur collapses an
          // empty phone composer and unmounts this trigger before Base UI can
          // open its menu, so finish the touch here and keep the trigger alive.
          event.preventDefault();
          setMenuOpen(!open);
        }}
        className={cn(
          menuRowTrigger
            ? "flex w-full cursor-pointer items-center gap-[7px] whitespace-nowrap rounded-control border border-line-strong bg-transparent px-3 py-[7px] text-control-label font-medium text-faint hover:bg-hover hover:text-fg data-[popup-open]:bg-hover data-[popup-open]:text-fg"
            : fieldTrigger
              ? selectTriggerClasses("md", true)
              : heroTrigger
                ? "inline-flex min-h-11 min-w-0 max-w-full cursor-pointer items-center rounded-md border-0 bg-transparent px-1.5 text-label font-medium text-dim transition-[color,background-color,scale] hover:bg-hover hover:text-fg active:scale-[0.96] data-[popup-open]:bg-hover data-[popup-open]:text-fg"
                : "border-transparent hover:border-transparent hover:bg-hover",
          className,
        )}
        title={title}
        disabled={
          disabled ||
          (!!modelDisabled && !hasEffort && !hasSpeed && !hasAccount)
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
            <IconSparkle size={20} className="shrink-0 text-faint" />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
              <span className="text-meta font-semibold leading-none text-faint">
                Model
              </span>
              <span className="truncate text-control-label leading-[1.2] text-fg">
                {modelLabel}
              </span>
            </span>
            <IconChevronRight size={20} className="shrink-0 text-faint" />
          </>
        ) : fieldTrigger ? (
          <>
            <span className="col-start-1 row-start-1 flex size-4 shrink-0 items-center justify-center text-dim">
              <ModelMark id={effectiveModel} provider={modelInfo?.provider} />
            </span>
            <span className="col-start-2 row-start-1 truncate">
              {modelLabel}
              {hasEffort && effortLabel && (
                <span className="text-faint"> · {effortLabel}</span>
              )}
            </span>
            <IconChevronDown
              size={20}
              className="col-start-3 row-start-1 shrink-0 text-faint"
            />
          </>
        ) : heroTrigger ? (
          <span className="truncate">{modelLabel}</span>
        ) : (
          <>
            {/* `data-effort` is a styling hook for the caller, not state: the
						    new-session footer hides the suffix on ultra-narrow screens so the
						    model name keeps the room, and the composer toolbar does not. */}
            {hasSpeed && effectiveSpeed === "fast" && (
              <>
                <IconBolt className="flex-none text-faint" size={20} />
                <span className="sr-only">Fast mode</span>
              </>
            )}
            {hasSpeed && effectiveSpeed === "ultrafast" && (
              <>
                <IconRocket className="flex-none text-faint" size={20} />
                <span className="sr-only">Ultrafast mode</span>
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
        align={
          menuRowTrigger || fieldTrigger
            ? "start"
            : heroTrigger
              ? "center"
              : "end"
        }
        sideOffset={6}
        footer={topGuidanceFooter}
        className={cn(
          topGuidanceFooter
            ? "w-[min(376px,calc(100vw-1rem))]"
            : "max-w-[min(376px,calc(100vw-1rem))]",
          menuRowTrigger && "min-w-[220px]",
        )}
      >
        {/* The best five sit right here; the rest are one hop away. A row
            drags straight away to put the five in the person's order. */}
        <Reorder.Group
          as="div"
          axis="y"
          values={shownTopOptions.map((option) => option.id)}
          onReorder={updateTopDraft}
        >
          {shownTopOptions.map((option) => (
            <Reorder.Item
              as="div"
              key={option.id}
              value={option.id}
              dragListener={shownTopOptions.length > 1}
              onPointerDownCapture={() => {
                justDragged.current = false;
              }}
              onDragStart={() => {
                justDragged.current = true;
                setDraggingTopId(option.id);
                updateTopDraft(shownTopOptions.map((o) => o.id));
              }}
              onDragEnd={dropTopModel}
              onClickCapture={(event: React.MouseEvent) => {
                if (!justDragged.current) return;
                justDragged.current = false;
                event.preventDefault();
                event.stopPropagation();
              }}
              whileDrag={{ scale: 1.02, zIndex: 1 }}
              className={cn(
                "relative rounded-md",
                draggingTopId === option.id &&
                  "bg-popup [--smooth-ring-color:var(--popup-ring)] smooth-shadow-ring-sm",
              )}
            >
              {renderModelOption(option, setHoveredModelId)}
            </Reorder.Item>
          ))}
        </Reorder.Group>
        {hasMoreModels && (
          <Menu.SubmenuRoot
            onOpenChange={(next) => {
              if (!next) setHoveredMoreModelId(null);
            }}
          >
            <Menu.SubmenuTrigger className="justify-between gap-3">
              <span className="flex min-w-0 flex-1 items-center gap-2.5">
                <span className="size-4 shrink-0" />
                <span className="min-w-0 truncate">More models</span>
              </span>
              <span className="flex min-w-0 flex-none items-center gap-1 text-dim">
                {selectedMoreOption && (
                  <span className="truncate">{selectedMoreOption.label}</span>
                )}
                <IconChevronRight className="shrink-0" size={20} />
              </span>
            </Menu.SubmenuTrigger>
            <Menu.Popup
              footer={moreGuidanceFooter}
              className={
                moreGuidanceFooter
                  ? "w-[min(376px,calc(100vw-1rem))]"
                  : "max-w-[min(376px,calc(100vw-1rem))]"
              }
            >
              {reuploadHint && <MenuHint>{reuploadHint}</MenuHint>}
              {groupedPrimary
                ? providerGroups.map((g, i) => (
                    <React.Fragment key={g.provider}>
                      {i > 0 && <Menu.Separator className="my-1" />}
                      <Menu.Group>
                        <Menu.GroupLabel>{g.label}</Menu.GroupLabel>
                        {g.options.map((option) =>
                          renderModelOption(option, setHoveredMoreModelId),
                        )}
                      </Menu.Group>
                    </React.Fragment>
                  ))
                : morePrimaryOptions.map((option) =>
                    renderModelOption(option, setHoveredMoreModelId),
                  )}
              {primaryFirst && otherOptions.length > 0 && (
                <>
                  {morePrimaryOptions.length > 0 && (
                    <Menu.Separator className="my-1" />
                  )}
                  <Menu.SubmenuRoot>
                    <Menu.SubmenuTrigger className="justify-between gap-3 text-dim">
                      <span className="min-w-0 truncate">
                        {LEGACY_GROUP_LABEL}
                      </span>
                      <span className="flex flex-none items-center gap-1 text-dim">
                        {selectedLegacyLabel && (
                          <span className="text-faint">
                            {selectedLegacyLabel}
                          </span>
                        )}
                        <IconChevronRight className="shrink-0" size={20} />
                      </span>
                    </Menu.SubmenuTrigger>
                    <Menu.Popup className="max-w-[min(360px,calc(100vw-1rem))]">
                      {otherOptions.map((option) => renderModelOption(option))}
                    </Menu.Popup>
                  </Menu.SubmenuRoot>
                </>
              )}
              {/* Without engine models the registry's own entries are the
                  rest of the list, grouped by engine. */}
              {!primaryFirst &&
                otherGroups.map((g, i) => (
                  <React.Fragment key={g.engine}>
                    {(i > 0 || morePrimaryOptions.length > 0) && (
                      <Menu.Separator className="my-1" />
                    )}
                    <Menu.Group>
                      {otherGroups.length > 1 && (
                        <Menu.GroupLabel>{g.label}</Menu.GroupLabel>
                      )}
                      {g.options.map((option) =>
                        renderModelOption(option, setHoveredMoreModelId),
                      )}
                    </Menu.Group>
                  </React.Fragment>
                ))}
              {hiddenOnEngine > 0 && (
                <MenuHint>
                  {hiddenOnEngine} {hiddenOnEngine === 1 ? "model" : "models"}{" "}
                  not available here
                </MenuHint>
              )}
            </Menu.Popup>
          </Menu.SubmenuRoot>
        )}
        {(topOptions.length > 0 || hasMoreModels) && (
          <Menu.Separator className="my-1" />
        )}
        {hasEffort && (
          <Menu.SubmenuRoot>
            <Menu.SubmenuTrigger className="justify-between gap-3">
              <span className="min-w-0 truncate">Effort</span>
              <span className="flex flex-none items-center gap-1 text-dim">
                {effortLabel}
                <IconChevronRight className="shrink-0 text-dim" size={20} />
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
        {showSpeedRow && (
          <Menu.SubmenuRoot>
            <Menu.SubmenuTrigger className="justify-between gap-3">
              <span className="min-w-0 truncate">Speed</span>
              <span className="flex flex-none items-center gap-1 text-dim">
                {SPEED_LABELS[effectiveSpeed]}
                <IconChevronRight className="shrink-0 text-dim" size={20} />
              </span>
            </Menu.SubmenuTrigger>
            <Menu.Popup className="max-w-[min(360px,calc(100vw-1rem))]">
              {speedOptions.map((o) => {
                const selected = effectiveSpeed === o;
                return (
                  <Menu.Item
                    key={o}
                    onClick={() => {
                      // Faster tiers run on a subscription account, so picking
                      // one while on auto pins the account it will actually
                      // use: a Pro $500 login for Ultrafast.
                      const pin =
                        o === "ultrafast"
                          ? ultrafastAccount
                          : subscriptionAccount;
                      if (o !== "standard" && !currentAccount && pin) {
                        onAccountChange?.(pin.id);
                      }
                      onSpeedChange!(o);
                    }}
                    className={cn(
                      "justify-between gap-3",
                      selected && "bg-hover",
                    )}
                  >
                    <span className="min-w-0 truncate">{SPEED_LABELS[o]}</span>
                    <Menu.Check on={selected} className="text-dim" />
                  </Menu.Item>
                );
              })}
            </Menu.Popup>
          </Menu.SubmenuRoot>
        )}
        {(hasEffort || showSpeedRow) && <Menu.Separator className="my-1" />}
        {/* Everything set once and left alone: account, fallback, usage and
            the defaults. Kept off the top level so the menu stays short. */}
        <Menu.SubmenuRoot>
          <Menu.SubmenuTrigger className="justify-between gap-3">
            <span className="min-w-0 truncate">Options</span>
            <IconChevronRight className="shrink-0 text-dim" size={20} />
          </Menu.SubmenuTrigger>
          <Menu.Popup className="min-w-[220px] max-w-[min(360px,calc(100vw-1rem))]">
            {onAutoFallbackChange && (
              <Menu.CheckboxItem
                checked={autoFallback}
                onCheckedChange={onAutoFallbackChange}
                closeOnClick={false}
                className="justify-between gap-3 phone:min-h-11"
              >
                <span className="flex min-w-0 flex-col">
                  <span>Auto-fallback</span>
                  <span className="text-supporting text-faint">
                    Switch models when quota runs out
                  </span>
                </span>
                <Menu.Check on={autoFallback} className="text-dim" />
              </Menu.CheckboxItem>
            )}
            {hasAccount && (
              <Menu.SubmenuRoot>
                <Menu.SubmenuTrigger className="justify-between gap-3">
                  <span className="min-w-0 truncate">Account</span>
                  <span className="flex flex-none items-center gap-1 text-dim">
                    {accountLabel}
                    <IconChevronRight className="shrink-0 text-dim" size={20} />
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
                          {a.owner ? ` · ${accountOwnerLabel(a.owner)}` : ""}
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
            {showUsage && (
              <>
                <Menu.SubmenuRoot>
                  <Menu.SubmenuTrigger className="justify-between gap-3">
                    <span className="min-w-0 truncate">Conversation usage</span>
                    <span className="flex flex-none items-center gap-1 text-dim">
                      <UsageCost usage={usage} />
                      <IconChevronRight className="shrink-0" size={20} />
                    </span>
                  </Menu.SubmenuTrigger>
                  <Menu.Popup className="w-64 max-w-[min(360px,calc(100vw-1rem))]">
                    <UsageDetails usage={usage} className="p-1.5" />
                  </Menu.Popup>
                </Menu.SubmenuRoot>
                {/* The same readout, kept in view above the composer. */}
                <Menu.CheckboxItem
                  checked={usageBarOn}
                  onCheckedChange={setUsageBarPref}
                  closeOnClick
                  className="justify-between gap-3 phone:min-h-11"
                >
                  <span className="min-w-0 truncate">Show usage bar</span>
                  <Menu.Check on={usageBarOn} className="text-dim" />
                </Menu.CheckboxItem>
                <Menu.Separator className="my-1" />
              </>
            )}
            {weeklyRows.length > 0 && (
              <>
                <Menu.SubmenuRoot>
                  <Menu.SubmenuTrigger className="justify-between gap-3">
                    <span className="min-w-0 truncate">Weekly remaining</span>
                    <span className="flex flex-none items-center gap-1.5 text-dim">
                      {/* A model with its own weekly bucket (Fable) is capped by
                          that bucket, not the plan's 7-day window; name it so a
                          full general week is not read as Fable headroom. */}
                      {weeklyReadout?.scope && (
                        <Badge>{weeklyReadout.scope}</Badge>
                      )}
                      {weeklyReadout && (
                        <span
                          className={cn(
                            "tabular-nums",
                            REMAINING_TONE[weeklyReadout.tone],
                          )}
                        >
                          {weeklyReadout.remaining}%
                        </span>
                      )}
                      <IconChevronRight className="shrink-0" size={20} />
                    </span>
                  </Menu.SubmenuTrigger>
                  <Menu.Popup className="w-80 max-w-[min(360px,calc(100vw-1rem))]">
                    {weeklyRows.map((row, i) => {
                      const pinnable =
                        hasAccount && row.provider === accountProvider;
                      const selected = pinnable && row.accountId === accountId;
                      return (
                        <Menu.Item
                          key={`${row.accountId}-${i}`}
                          onClick={() => onAccountChange!(row.accountId)}
                          disabled={!pinnable}
                          title={
                            pinnable
                              ? `Use ${row.label} for this session`
                              : hasAccount
                                ? "Not for this model"
                                : undefined
                          }
                          className={cn(
                            PICKER_ROW_GAP,
                            "justify-between gap-3",
                            selected && "bg-hover",
                            !pinnable && "opacity-70",
                          )}
                        >
                          <span className="flex min-w-0 flex-1 items-center gap-2">
                            <span className="flex size-4 shrink-0 items-center justify-center text-dim">
                              <BrandMark
                                name={ACCOUNT_BRAND[row.provider]}
                                size={15}
                              />
                            </span>
                            <span className="min-w-0 truncate">{row.name}</span>
                            {row.scope && <Badge>{row.scope}</Badge>}
                          </span>
                          <span className="flex flex-none items-center gap-2 tabular-nums">
                            {row.owner ? (
                              <UserAvatar
                                name={row.owner}
                                size={14}
                                edge={false}
                                title="Yours"
                              />
                            ) : (
                              <IconPeople
                                size={20}
                                className="text-faint"
                                aria-label="Shared"
                              />
                            )}
                            <span className="text-faint" title={row.resetTitle}>
                              {row.day}
                            </span>
                            <span
                              className={cn(
                                "min-w-9 text-right",
                                REMAINING_TONE[row.tone],
                              )}
                            >
                              {row.remaining}%
                            </span>
                          </span>
                          <Menu.Check on={selected} className="text-dim" />
                        </Menu.Item>
                      );
                    })}
                    {hasAccount && weeklyRowsForModel.length > 0 && (
                      <MenuHint>Choose one to use it for this session</MenuHint>
                    )}
                    <Menu.Separator className="my-1" />
                    <Menu.Item
                      className="justify-between gap-3"
                      onClick={() => navigation.openSettings("providers")}
                    >
                      <span className="min-w-0 truncate">Manage accounts</span>
                      <IconChevronRight
                        className="shrink-0 text-dim"
                        size={20}
                      />
                    </Menu.Item>
                  </Menu.Popup>
                </Menu.SubmenuRoot>
                <Menu.Separator className="my-1" />
              </>
            )}
            {onSetAsDefault && (
              <Menu.Item
                onClick={() =>
                  onSetAsDefault(effectiveModel, defaultEffortToSave)
                }
                disabled={isPreferredDefault}
                title={`Use ${modelLabel}${defaultEffortToSave && effortLabel ? ` at ${effortLabel.toLowerCase()} effort` : ""} for new sessions`}
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
              <IconUndo className="shrink-0 text-dim" size={20} />
            </Menu.Item>
          </Menu.Popup>
        </Menu.SubmenuRoot>
      </Menu.Popup>
    </Menu.Root>
  );
}
