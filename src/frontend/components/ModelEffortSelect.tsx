import React from "react";
import type { ModelOption, ProviderAccountOption } from "../lib/api";
import { Menu } from "../ui/menu";
import { cn } from "../ui/cn";
import { Tooltip } from "../ui/tooltip";
import { IconBolt, IconCheck, IconChevronRight } from "./icons";

export const EFFORTS = [
	{ id: "none", label: "None" },
	{ id: "low", label: "Low" },
	{ id: "medium", label: "Medium" },
	{ id: "high", label: "High" },
	{ id: "xhigh", label: "Extra high" },
	{ id: "max", label: "Max" },
];

type Props = {
	models: ModelOption[];
	defaultModel: string;
	/** Current model id; "" = default. */
	model: string;
	onModelChange: (model: string) => void;
	/** Model is set elsewhere (e.g. Slack-owned sessions) — effort stays switchable. */
	modelDisabled?: boolean;
	modelTitle?: string;
	/** When effort isn't wired, the menu is just the model list. */
	effort?: string;
	onEffortChange?: (effort: string) => void;
	fastMode?: boolean;
	onFastModeChange?: (fastMode: boolean) => void;
	/**
	 * Pinnable provider accounts. The menu filters these to the active model's
	 * Claude or Codex pool; "" = auto (personal-first, pool fallback).
	 */
	accounts?: ProviderAccountOption[];
	/** Pinned account id; "" / undefined = auto. */
	accountId?: string;
	onAccountChange?: (accountId: string) => void;
	disabled?: boolean;
	title?: string;
	className?: string;
	/** Fires as the menu opens/closes. The phone composer needs it: the popup
	 * takes focus (blurring the textarea), and the composer must stay expanded
	 * while open or this trigger unmounts and the menu closes with it. */
	onOpenChange?: (open: boolean) => void;
};

const PRIMARY_MODEL_IDS = [
	"claude-fable-5",
	"claude-opus-5",
	"claude-sonnet-5",
	"gpt-5.5",
] as const;
const PRIMARY_MODEL_ID_SET = new Set<string>(PRIMARY_MODEL_IDS);

/** Engine display names, keyed by ModelOption.provider — only used for the
 * legacy (no-opencode-configured) grouping fallback below. */
export const ENGINE_LABELS: Record<string, string> = {
	claude: "Claude",
	codex: "Codex",
	opencode: "OpenCode",
};

/** De-emphasized group name for the native Claude-SDK/Codex entries that stick
 * around as automation/fallback plumbing during the opencode migration. */
export const LEGACY_GROUP_LABEL = "Legacy (direct SDK)";

/**
 * OpenCode model ids are config-driven slugs shaped
 * `opencode/<provider>/<model>` (e.g. "opencode/anthropic/claude-sonnet-5").
 * Split one into its upstream provider + model so the UI never shows the raw
 * slashed id. Null for anything that isn't an opencode id.
 */
export function opencodeModelParts(
	id: string,
): { provider: string; model: string } | null {
	if (!id.startsWith("opencode/")) return null;
	const rest = id.slice("opencode/".length);
	const slash = rest.indexOf("/");
	if (slash <= 0) return null;
	return { provider: rest.slice(0, slash), model: rest.slice(slash + 1) };
}

/** Pure slug prettifier: "claude-sonnet-5" → "Sonnet 5", "claude-haiku-4-5" →
 * "Haiku 4.5", "gpt-5.4-mini" → "GPT-5.4 mini". Mirrors the server's
 * opencodeModelLabel (models.ts) but needs no models list, so it works in the
 * transcript weave before /api/models has loaded — and keeps friendly names
 * correct even while the server still serves pre-rename labels. */
export function friendlyModelSlug(slug: string): string {
	if (slug === "gpt-oss-120b") return "GPT OSS 120B";
	if (slug === "gemma-4-31b") return "Gemma 4 31B";
	if (slug === "zai-glm-4.7") return "Z.ai GLM 4.7";
	if (slug.startsWith("gpt-")) {
		const m = slug.slice(4).match(/^(\d+(?:[.-]\d+)*)(?:-(.+))?$/);
		if (m) return `GPT-${m[1].replace(/-/g, ".")}${m[2] ? ` ${m[2].replace(/-/g, " ")}` : ""}`;
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

/** Display name without the vendor noise: "Claude Fable 5" → "Fable 5",
 * "GPT-5.5 (Codex)" → "GPT-5.5", "opencode/anthropic/claude-sonnet-5" →
 * "Sonnet 5". The engine is an implementation detail — it never shows in a
 * model's name. */
export function shortModelLabel(id: string, models: ModelOption[]): string {
	const oc = opencodeModelParts(id);
	if (oc) return friendlyModelSlug(oc.model);
	const raw = models.find((m) => m.id === id)?.label || id || "Default";
	return raw.replace(/^Claude\s+/i, "").replace(/\s*\(Codex\)$/i, "");
}

/** Friendly names for the upstream providers in the grouped main list. */
const PROVIDER_LABELS: Record<string, string> = {
	dial: "The Dial",
	custom: "Custom",
	orchestrator: "The Orchestrator",
	anthropic: "Anthropic",
	openai: "OpenAI",
	xai: "xAI",
	meta: "Meta",
	google: "Google",
	openrouter: "OpenRouter",
	groq: "Groq",
	mistral: "Mistral",
	deepseek: "DeepSeek",
	moonshotai: "Moonshot AI",
	cerebras: "Cerebras",
};

/** Section order in the grouped main list; unlisted providers follow in
 * config order. */
const PROVIDER_ORDER = ["dial", "custom", "orchestrator", "anthropic", "openai", "cerebras", "xai", "meta", "moonshotai"];

/** Preferred display order for the opencode main list (by id tail); anything
 * unlisted keeps its registry/config order after these. */
const OPENCODE_TAIL_ORDER = [
	// The Dial presets ("dial/<tier>" ids) lead the list, hardest tier first,
	// then The Orchestrator presets ("orchestrator/<name>" ids).
	"ultra",
	"high",
	"medium",
	"low",
	"fable",
	"sol",
	"claude-fable-5",
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
];

/**
 * Split the registry into the first-class opencode entries (sorted for
 * display) and the legacy native claude/codex ones. When opencode models are
 * configured they ARE the model list; natives tuck under LEGACY_GROUP_LABEL.
 */
export function splitModelOptions(models: ModelOption[]): {
	opencode: ModelOption[];
	legacy: ModelOption[];
} {
	const rank = (m: ModelOption) => {
		const i = OPENCODE_TAIL_ORDER.indexOf(m.id.split("/").pop() || "");
		return i === -1 ? OPENCODE_TAIL_ORDER.length : i;
	};
	const opencode = models
		.filter((m) => m.provider === "opencode")
		.map((m, i) => [m, i] as const)
		.sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1])
		.map(([m]) => m);
	return { opencode, legacy: models.filter((m) => m.provider !== "opencode") };
}

type ModelMenuOption = {
	value: string;
	label: string;
	id: string;
	/** Engine key (ModelOption.provider) for the legacy-fallback group headers. */
	engine: string;
	/** Picker section override from the registry ("dial" = The Dial). */
	group?: string;
	/** One-line subtitle rendered under the label (dial presets). */
	description?: string;
};

/**
 * Combined model + reasoning-effort pill (Claude-app-style): one trigger on the
 * composer's right edge opening the model list, with the effort level behind an
 * "Effort ›" submenu at the bottom. Unlike PaletteSelect there is no
 * native-select phone fallback: the nested effort submenu doesn't map to a
 * <select>, and Base UI menus handle touch fine.
 */
export function ModelEffortSelect({
	models,
	defaultModel,
	model,
	onModelChange,
	modelDisabled,
	modelTitle,
	effort,
	onEffortChange,
	fastMode,
	onFastModeChange,
	accounts,
	accountId,
	onAccountChange,
	disabled,
	title,
	className,
	onOpenChange,
}: Props) {
	const effectiveModel = model || defaultModel;
	const modelLabel = shortModelLabel(effectiveModel, models);
	const supportedEffortIds = models.find((m) => m.id === effectiveModel)?.efforts ?? [];
	const supportedEfforts = EFFORTS.filter((e) => supportedEffortIds.includes(e.id));
	const effectiveEffort = supportedEffortIds.includes(effort ?? "")
		? effort!
		: supportedEffortIds.includes("high")
			? "high"
			: supportedEffortIds[0];
	const effortLabel = EFFORTS.find((e) => e.id === effectiveEffort)?.label;
	const hasEffort = !!onEffortChange && supportedEfforts.length > 0;
	const modelInfo = models.find((m) => m.id === effectiveModel);
	const accountProvider = modelInfo?.accountProvider;
	const providerAccounts = (accounts || []).filter((a) => a.provider === accountProvider);
	const hasAccount = !!onAccountChange && providerAccounts.length > 0;
	const currentAccount = accountId
		? providerAccounts.find((a) => a.id === accountId)
		: undefined;
	const subscriptionAccount = providerAccounts.find(
		(a) => a.kind !== "api_key" && a.usable,
	);
	const hasFastMode =
		modelInfo?.fastModeSupported === true &&
		currentAccount?.kind !== "api_key" &&
		!!(currentAccount || subscriptionAccount) &&
		!!onFastModeChange;
	const accountLabel = currentAccount ? currentAccount.name : "Auto";

	const optionFor = (id: string): ModelMenuOption => {
		const info = models.find((m) => m.id === id);
		return {
			value: id === defaultModel ? "" : id,
			// Preset rows drop their "Dial · " / "Orchestrator · " prefix — they
			// render under "The Dial" / "The Orchestrator" group headers, where
			// the full label would read twice.
			label:
				info?.group === "dial" || info?.group === "orchestrator"
					? shortModelLabel(id, models).replace(/^(?:Dial|Orchestrator)\s*·\s*/, "")
					: shortModelLabel(id, models),
			id,
			engine: info?.provider || (opencodeModelParts(id) ? "opencode" : "claude"),
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
		id: m.id,
		engine: m.provider,
	});
	const { opencode: opencodeModels, legacy: legacyModels } = splitModelOptions(models);
	// With opencode configured it IS the model list: its entries are the main
	// list (friendly names, no engine anywhere) and the native claude/codex
	// entries — automation/fallback plumbing during the migration — tuck under
	// a de-emphasized "Legacy (direct SDK)" submenu at the bottom.
	const opencodeFirst = opencodeModels.length > 0;
	const availableModelIds = new Set(models.map((m) => m.id));
	const primaryOptions = opencodeFirst
		? [
				...(availableModelIds.has(defaultModel) ? [] : [optionFor(defaultModel)]),
				...opencodeModels.map((m) => optionFor(m.id)),
			]
		: PRIMARY_MODEL_IDS.filter((id) => availableModelIds.has(id)).map((id) => optionFor(id));
	const otherOptions = opencodeFirst
		? legacyModels.map(legacyOptionFor)
		: [
				...(PRIMARY_MODEL_ID_SET.has(defaultModel) ? [] : [optionFor(defaultModel)]),
				...models
					.filter((m) => m.id !== defaultModel && !PRIMARY_MODEL_ID_SET.has(m.id))
					.map((m) => optionFor(m.id)),
			];
	// No-opencode fallback only: "Other models" grouped by engine. With
	// opencode present the submenu is the flat legacy list instead.
	const engineOrder = ["claude", "codex", "opencode"];
	const engines = [
		...engineOrder,
		...otherOptions.map((o) => o.engine).filter((e) => !engineOrder.includes(e)),
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
	const providerOf = (id: string) => opencodeModelParts(id)?.provider || "other";
	const providerGroups: Array<{ provider: string; label: string; options: ModelMenuOption[] }> = [];
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
		return (ai === -1 ? PROVIDER_ORDER.length : ai) - (bi === -1 ? PROVIDER_ORDER.length : bi);
	});
	const groupedPrimary = opencodeFirst && providerGroups.length > 1;

	const isSelected = (option: ModelMenuOption) =>
		option.value === model || (option.value === "" && (model === "" || model === defaultModel));
	// Dim hint on the legacy submenu trigger when the CURRENT model lives in
	// there — otherwise the open menu would show no checked row at all.
	const selectedLegacyLabel =
		opencodeFirst && !primaryOptions.some(isSelected)
			? otherOptions.find(isSelected)?.label
			: undefined;

	const renderModelOption = (option: ModelMenuOption) => {
		const selected = isSelected(option);
		const nextEfforts = models.find((m) => m.id === option.id)?.efforts ?? [];
		const item = (
			<Menu.Item
				onClick={() => {
					onModelChange(option.value);
					if (onEffortChange && !nextEfforts.includes(effort ?? "")) {
						const nextEffort = nextEfforts.includes("high") ? "high" : nextEfforts[0];
						if (nextEffort) onEffortChange(nextEffort);
					}
				}}
				disabled={modelDisabled}
				title={modelDisabled ? modelTitle : undefined}
				className={cn("justify-between gap-3", selected && "bg-hover", modelDisabled && "opacity-55")}
			>
				{option.description ? (
					<span className="flex min-w-0 flex-1 flex-col">
						<span className="truncate">{option.label}</span>
						<span className="truncate text-label text-faint">{option.description}</span>
					</span>
				) : (
					<span className="min-w-0 truncate">{option.label}</span>
				)}
				{selected && <IconCheck className="shrink-0 text-dim" size={17} />}
			</Menu.Item>
		);
		return option.description ? (
			<Tooltip key={option.value || option.id} label={option.description} side="right" multiline>
				{item}
			</Tooltip>
		) : (
			React.cloneElement(item, { key: option.value || option.id })
		);
	};

	return (
		<Menu.Root onOpenChange={onOpenChange}>
			<Menu.Trigger
				type="button"
				// Quiet pill: no outline at rest, hover state only, no chevron.
				className={cn(
					"relative inline-flex min-w-0 items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-supporting font-medium text-dim transition-[border-color,color] hover:border-faint hover:text-fg disabled:cursor-default disabled:opacity-55",
					className,
				)}
				title={title}
				disabled={disabled || (!hasEffort && !hasFastMode && modelDisabled)}
				aria-label={
					hasAccount
						? "Model, reasoning effort, and provider account"
						: hasEffort
							? "Model and reasoning effort"
							: "Model"
				}
			>
				<span className="palette-pill-label truncate">{modelLabel}</span>
				{hasEffort && <span className="palette-pill-effort flex-none text-faint max-[374px]:hidden">{effortLabel}</span>}
				{hasFastMode && fastMode && (
					<span className="palette-pill-effort flex-none text-faint">Fast</span>
				)}
			</Menu.Trigger>
			<Menu.Popup align="end" sideOffset={6} className="max-w-[min(360px,calc(100vw-1rem))]">
				{groupedPrimary
					? providerGroups.map((g, i) => (
							<React.Fragment key={g.provider}>
								{i > 0 && <Menu.Separator className="my-1" />}
								<Menu.Group>
									<Menu.GroupLabel>{g.label}</Menu.GroupLabel>
									{g.options.map(renderModelOption)}
								</Menu.Group>
							</React.Fragment>
						))
					: primaryOptions.map(renderModelOption)}
				{otherOptions.length > 0 && (
					<Menu.SubmenuRoot>
						<Menu.SubmenuTrigger
							className={cn("justify-between gap-3", opencodeFirst && "text-dim")}
						>
							<span className="min-w-0 truncate">
								{opencodeFirst ? LEGACY_GROUP_LABEL : "Other models"}
							</span>
							<span className="flex flex-none items-center gap-1 text-dim">
								{selectedLegacyLabel && (
									<span className="text-faint">{selectedLegacyLabel}</span>
								)}
								<IconChevronRight className="shrink-0" size={17} />
							</span>
						</Menu.SubmenuTrigger>
						<Menu.Popup className="max-w-[min(360px,calc(100vw-1rem))]">
							{!opencodeFirst && otherGroups.length > 1
								? otherGroups.map((g, i) => (
										<React.Fragment key={g.engine}>
											{i > 0 && <Menu.Separator className="my-1" />}
											<Menu.Group>
												<Menu.GroupLabel>{g.label}</Menu.GroupLabel>
												{g.options.map(renderModelOption)}
											</Menu.Group>
										</React.Fragment>
									))
								: otherOptions.map(renderModelOption)}
						</Menu.Popup>
					</Menu.SubmenuRoot>
				)}
				{(hasEffort || hasAccount || hasFastMode) && <Menu.Separator className="my-1" />}
				{hasFastMode && (
					<Menu.Item
						onClick={() => {
							const next = !fastMode;
							if (next && !currentAccount && subscriptionAccount) {
								onAccountChange?.(subscriptionAccount.id);
							}
							onFastModeChange!(next);
						}}
						className={cn("justify-between gap-3", fastMode && "bg-hover")}
					>
						<span className="flex min-w-0 items-center gap-2">
							<IconBolt className="shrink-0 text-dim" size={20} />
							<span className="truncate">Fast mode</span>
						</span>
						{fastMode && <IconCheck className="shrink-0 text-dim" size={17} />}
					</Menu.Item>
				)}
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
							{supportedEfforts.map((e) => {
								const selected = effectiveEffort === e.id;
								return (
									<Menu.Item
										key={e.id}
										onClick={() => onEffortChange!(e.id)}
										className={cn("justify-between gap-3", selected && "bg-hover")}
									>
										<span className="min-w-0 truncate">{e.label}</span>
										{selected && (
											<IconCheck className="shrink-0 text-dim" size={17} />
										)}
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
								className={cn("justify-between gap-3", !accountId && "bg-hover")}
							>
								<span className="min-w-0 truncate">Auto</span>
								{!accountId && (
									<IconCheck className="shrink-0 text-dim" size={17} />
								)}
							</Menu.Item>
							{providerAccounts.map((a) => {
								const selected = a.id === accountId;
								return (
									<Menu.Item
										key={a.id}
										onClick={() => onAccountChange!(a.id)}
										className={cn("justify-between gap-3", selected && "bg-hover")}
									>
										<span className="min-w-0 truncate">
											{a.name}
											{a.owner ? ` · ${a.owner}` : ""}
											{a.usable ? "" : " · exhausted"}
										</span>
										{selected && (
											<IconCheck className="shrink-0 text-dim" size={17} />
										)}
									</Menu.Item>
								);
							})}
						</Menu.Popup>
					</Menu.SubmenuRoot>
				)}
			</Menu.Popup>
		</Menu.Root>
	);
}
