import React, { useEffect, useState } from "react";
import { useIsPhone } from "../hooks/useIsPhone";
import { useScrollEdge } from "../hooks/useScrollEdge";
import { cn } from "../ui/cn";
import { useAuthStatus } from "./UserPicker";
import {
	SETTINGS_BACK,
	SETTINGS_CONTENT,
	SETTINGS_CONTENT_SHEET,
	SETTINGS_CONTENT_TOOL,
	SETTINGS_PAGE,
	SETTINGS_PANEL_FRAME,
	SETTINGS_PANEL_FRAME_GALLERY,
	SETTINGS_PANEL_FRAME_SHEET,
	SETTINGS_SHEET_LIST,
	SETTINGS_SHEET_SEARCH_BAR,
	SETTINGS_NAV,
	SETTINGS_NAV_CAPTION,
	SETTINGS_NAV_GROUP,
	SETTINGS_NAV_ICON,
	SETTINGS_NAV_LIST,
	SETTINGS_NAV_ROW,
	SETTINGS_NAV_SEARCH,
} from "../lib/settings-classes";
import { matchSections, type SectionHit } from "../lib/settings-search";
import {
	SECTIONS,
	TOOL_SECTIONS,
	type SettingsSectionKey,
	type ToolSectionKey,
} from "../lib/settings-sections";
import { Input } from "../ui/input";
import { BottomSheet, SheetIconButton } from "../ui/sheet";
import { Connections } from "./Connections";
import {
	IconChevronLeft,
	IconChevronRight,
	IconSearch,
	IconX,
} from "./icons";
import { MyAccountsPanel } from "./MyAccounts";
import { AuditPanel } from "./settings/AuditPanel";
import { DeploysPanel } from "./settings/DeploysPanel";
import { GeneralPanel } from "./settings/GeneralPanel";
import { IntegrationsPanel } from "./settings/IntegrationsPanel";
import { LibraryPanel } from "./settings/LibraryPanel";
import { MembersPanel } from "./settings/MembersPanel";
import { MemoryPanel } from "./settings/MemoryPanel";
import { ProvidersPanel } from "./settings/ProvidersPanel";
import { NotificationsPanel } from "./settings/NotificationsPanel";
import { PapercutsPanel } from "./settings/PapercutsPanel";
import { PreferencesPanel } from "./settings/PreferencesPanel";
import { ShortcutsPanel } from "./settings/ShortcutsPanel";
import { PrewarmingPanel } from "./settings/PrewarmingPanel";
import { ReposPanel } from "./settings/ReposPanel";
import { SandboxesPanel } from "./settings/SandboxesPanel";
import { StoragePanel } from "./settings/StoragePanel";
import { WaitlistPanel } from "./settings/WaitlistPanel";
import { RunnersPanel } from "./settings/RunnersPanel";
import { ReliabilityPanel } from "./settings/ReliabilityPanel";
import { SettingsAccountCard, SettingsAccountFooter } from "./SettingsAccount";
import { SetupPanel } from "./Setup";
import type { Workspace } from "../lib/types";

// The full-window Settings surface: a left sub-nav + a scrolling body, reached
// from the "Settings" item in the account menu. Designed to grow — each area is
// just another entry in SECTIONS and a matching panel below. The "Tools" group
// holds the app's tool surfaces (Automations, Goals, …) — those render at their
// own routes (<base>/automations, …) with this surface as chrome, so the
// section is controlled by the router, not local state.
//
// Groups run from what one person owns to what the whole instance does:
// "Personal" is yours alone: who sessions act as, how the app looks and
// behaves for you, and what it notifies you about. "Workspace" is shared
// config every session runs under. "Automation" is the standing work the
// instance does on its own:
// those are the tool surfaces, grouped by what they are rather than sold as
// the headline; "Infrastructure" is the machinery prepared ahead of a run; and
// "Activity" is the read-only record agents leave behind.

// The nav table itself lives in lib/settings-sections, because the command
// palette needs the same list and importing this whole component tree to read
// it would be absurd. Re-exported here so existing callers keep their import.
export type { SettingsSectionKey, ToolSectionKey };

/** Sections that are browsed rather than read down, and take the wider
 *  column for it (see SETTINGS_PANEL_FRAME_GALLERY). */
const GALLERY_SECTIONS = new Set<SettingsSectionKey>(["library", "setup"]);

// Settings is a dense mix of headings, row titles, labels, descriptions,
// fields, and tool panels. Body roles share 150% leading; heading and title
// roles stay compact at 110%. The descendant rules deliberately beat local
// one-off leading utilities so every section follows the page-level rhythm.
const SETTINGS_LEADING =
	"leading-normal [&_*]:!leading-normal " +
	"[&_h1]:!leading-[1.1] [&_h2]:!leading-[1.1] [&_h3]:!leading-[1.1] " +
	"[&_h4]:!leading-[1.1] [&_h5]:!leading-[1.1] [&_h6]:!leading-[1.1] " +
	"[&_.font-title]:!leading-[1.1] [&_.text-item-title]:!leading-[1.1] " +
	"[&_.text-dialog-title]:!leading-[1.1] [&_.text-section-title]:!leading-[1.1] " +
	"[&_.text-page-title]:!leading-[1.1] [&_.text-stat]:!leading-[1.1]";

type Section = (typeof SECTIONS)[number];
type SectionGroup = { group: string; items: Section[] };
type FilteredGroup = { group: string; hits: SectionHit<Section>[] };

/** Groups with their non-matching rows dropped, and empty groups gone with
 *  them. An empty query filters nothing, so both surfaces render one list. */
function filterGroups(groups: SectionGroup[], query: string): FilteredGroup[] {
	const out: FilteredGroup[] = [];
	for (const g of groups) {
		const hits = matchSections(g.items, query);
		if (hits.length) out.push({ group: g.group, hits });
	}
	return out;
}

/**
 * The nav's filter field. Settings spans many sections across five groups,
 * and the group a setting sits in is a judgement call the person hasn't made
 * — so the query also matches per-section keywords ("vim", "cron", "dark
 * mode"), and a row that matched on one says which under its label.
 *
 * Enter opens the first result and Escape clears, so a search can be run and
 * undone without leaving the keyboard.
 */
function NavSearch({
	value,
	onChange,
	onSubmit,
	className,
	sheet,
	ref,
}: {
	value: string;
	onChange: (v: string) => void;
	onSubmit: () => void;
	className?: string;
	/** The desktop nav marks this box when the list scrolls under it. */
	ref?: React.Ref<HTMLDivElement>;
	/** Phone sheet: the field sits in a page of grouped cards rather than in
	 *  the desktop sidebar's chrome, so it takes the cards' own fill instead of
	 *  an outlined well, and a touch-sized box with a 16px value — anything
	 *  smaller and iOS zooms the page when the field takes focus (the command
	 *  palette hardcodes 16px for the same reason). */
	sheet?: boolean;
}) {
	// The positioned box wraps the field only, so a caller's className can pad
	// or stick the strip around it without moving the icons off the field.
	return (
		<div className={className} ref={ref}>
			<div className="relative">
				<IconSearch
					size={sheet ? 20 : 18}
					className={cn(
						"pointer-events-none absolute top-1/2 -translate-y-1/2 text-faint",
						sheet ? "left-3.5" : "left-2",
					)}
				/>
				<Input
					value={value}
					// type=search for the phone keyboard's Search key; the native
					// cancel button goes, since the field renders its own (bigger,
					// and present at both widths).
					type="search"
					enterKeyHint="search"
					placeholder="Search settings"
					aria-label="Search settings"
					spellCheck={false}
					autoCapitalize="off"
					autoCorrect="off"
					size={sheet ? "lg" : "md"}
					className={cn(
						"[&::-webkit-search-cancel-button]:hidden",
						// `rounded-full`, not the app's squircle corner: a capsule is what
						// iOS puts a search field in, and base.css grants the squircle to
						// every `rounded-*` EXCEPT this one, so it is also the spelling
						// that gets true round ends rather than a superellipse.
						sheet
							? cn("h-10 rounded-full border-transparent bg-raised pl-11 text-input-phone", value && "pr-11")
							: cn("pl-8", value && "pr-8"),
					)}
					onChange={(e) => onChange(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") onSubmit();
						else if (e.key === "Escape" && value) {
							// Escape belongs to the field while it has something to clear —
							// unhandled, it would dismiss the whole phone sheet instead.
							e.stopPropagation();
							e.preventDefault();
							onChange("");
						}
					}}
				/>
				{value && (
					<button
						type="button"
						aria-label="Clear search"
						className={cn(
							"absolute top-1/2 flex -translate-y-1/2 cursor-pointer items-center justify-center border-none bg-transparent text-faint hover:bg-hover hover:text-fg",
							// Round inside a capsule; the desktop field keeps the app's corner.
							sheet ? "right-1.5 size-8 rounded-full" : "right-1 size-6 rounded-md",
						)}
						onClick={() => onChange("")}
					>
						<IconX size={sheet ? 18 : 16} />
					</button>
				)}
			</div>
		</div>
	);
}

/** The active section's panel — shared by the desktop split and the phone
 * sheet's detail page. Tool panels come in via children (App owns them). */
function SectionPanel({
	section,
	onBack,
	workspace,
	onOpenOnboarding,
	children,
}: {
	section: SettingsSectionKey;
	/** Leaving settings — the Setup wizard's last step offers it as "Done". */
	onBack?: () => void;
	workspace?: Workspace;
	onOpenOnboarding: () => void;
	children?: React.ReactNode;
}) {
	return (
		<>
			{TOOL_SECTIONS.has(section) && children}
			{section === "notifications" && <NotificationsPanel />}
			{section === "preferences" && <PreferencesPanel />}
			{section === "shortcuts" && <ShortcutsPanel />}
			{section === "general" && <GeneralPanel />}
			{section === "setup" && (
				<SetupPanel onDone={onBack} onOpenOnboarding={onOpenOnboarding} />
			)}
			{section === "repos" && <ReposPanel />}
			{section === "members" && <MembersPanel />}
			{section === "library" && <LibraryPanel />}
			{section === "integrations" && <IntegrationsPanel />}
			{section === "audit" && <AuditPanel />}
			{section === "providers" && <ProvidersPanel workspace={workspace} />}
			{section === "sandboxes" && <SandboxesPanel />}
			{section === "runners" && <RunnersPanel />}
			{section === "reliability" && <ReliabilityPanel />}
			{section === "connections" && <Connections />}
			{section === "myAccounts" && <MyAccountsPanel />}
			{section === "memory" && <MemoryPanel />}
			{section === "storage" && <StoragePanel />}
			{section === "prewarming" && <PrewarmingPanel />}
			{section === "papercuts" && <PapercutsPanel />}
			{section === "waitlist" && <WaitlistPanel />}
			{section === "deploys" && <DeploysPanel />}
		</>
	);
}

export function Settings({
	onBack,
	section,
	onSelect,
	onShowRoot,
	workspace,
	onOpenOnboarding,
	children,
}: {
	onBack: () => void;
	/** Active section, derived from the route (tools have their own URLs).
	 * Undefined = no explicit section: desktop defaults to Notifications, the
	 * phone sheet shows its root list of sections. */
	section?: SettingsSectionKey;
	/** Navigate to a section — App maps tool keys to their own routes. */
	onSelect: (key: SettingsSectionKey) => void;
	/** Phone sheet's back-to-root (navigate to sectionless /settings). */
	onShowRoot?: () => void;
	workspace?: Workspace;
	onOpenOnboarding: () => void;
	/** The active tool's panel (App owns the tool components and their props). */
	children?: React.ReactNode;
}) {
	const isPhone = useIsPhone();
	const auth = useAuthStatus();
	const visibleSection = auth?.admin === false && SECTIONS.some(
		(item) => item.key === section && item.adminOnly,
	) ? undefined : section;

	// No page-level Esc handler: Esc belongs to whatever is focused (cancelling
	// an inline edit, closing a menu), not to the settings page itself — losing
	// the whole page to a stray Esc is worse than having no keyboard exit.

	const [query, setQuery] = useState("");
	// The search field is a sibling above the section list, not its parent, so
	// it cannot know on its own when rows have started travelling under it. The
	// app's own chrome rows ask the same question the same way.
	const [searchBar, setSearchBar] = useState<HTMLDivElement | null>(null);
	useScrollEdge(searchBar, "[data-settings-nav-scroll]");

	// Group the nav entries under their group label (order preserved).
	const groups: SectionGroup[] = [];
	for (const s of SECTIONS) {
		if (s.adminOnly && auth?.admin === false) continue;
		let g = groups.find((x) => x.group === s.group);
		if (!g) groups.push((g = { group: s.group, items: [] }));
		g.items.push(s);
	}

	if (isPhone)
		return (
			<MobileSettings
				groups={groups}
				section={visibleSection}
				onSelect={onSelect}
				onShowRoot={onShowRoot}
				onBack={onBack}
				workspace={workspace}
				onOpenOnboarding={onOpenOnboarding}
			>
				{children}
			</MobileSettings>
		);

	// Default landing = the first non-tool row in the nav. Tool sections can't be
	// the default: their panel arrives as `children`, which App only passes on a
	// tool route, so a bare /settings would render an empty pane.
	const active = visibleSection ?? "myAccounts";
	const shown = filterGroups(groups, query);
	const firstHit = shown[0]?.hits[0]?.item;

	return (
		<div className={cn(SETTINGS_PAGE, SETTINGS_LEADING)}>
			{/* Back and search stay put; only the section list scrolls, so neither
			    they nor the account footer are lost once the list outgrows the nav. */}
			<aside className={SETTINGS_NAV}>
				<button className={SETTINGS_BACK} onClick={onBack}>
					<span className={SETTINGS_NAV_ICON}>
						<IconChevronLeft />
					</span>
					Back to app
				</button>
				<NavSearch
					ref={setSearchBar}
					value={query}
					onChange={setQuery}
					onSubmit={() => firstHit && onSelect(firstHit.key)}
					className={SETTINGS_NAV_SEARCH}
				/>
				{/* The attribute is what useScrollEdge finds the scrollport by. */}
				<div data-settings-nav-scroll className={SETTINGS_NAV_LIST}>
					{shown.map((g) => (
						<div className={SETTINGS_NAV_GROUP} key={g.group}>
							<div className={SETTINGS_NAV_CAPTION}>{g.group}</div>
							{g.hits.map(({ item: s, hint }) => (
								<button
									key={s.key}
									className={SETTINGS_NAV_ROW}
									data-active={active === s.key || undefined}
									onClick={() => onSelect(s.key)}
								>
									<span className={SETTINGS_NAV_ICON}>{s.icon}</span>
									<span className="min-w-0 flex-1">
										{s.label}
										{hint && (
											<span className="block truncate text-meta font-normal text-faint">
												{hint}
											</span>
										)}
									</span>
								</button>
							))}
						</div>
					))}
					{shown.length === 0 && (
						<div className="px-2.5 py-3 text-meta text-faint">
							Nothing matches “{query}”.
						</div>
					)}
				</div>
				<SettingsAccountFooter />
			</aside>

			{/* Tool sections fill the whole content area edge-to-edge (they carry
			    their own layout/scrolling); settings panels keep the centered,
			    padded reading column. */}
			<div
				data-settings-scroll
				className={cn(
					SETTINGS_CONTENT,
					TOOL_SECTIONS.has(active) && SETTINGS_CONTENT_TOOL,
				)}
			>
				{TOOL_SECTIONS.has(active) ? (
					<SectionPanel
						section={active}
						workspace={workspace}
						onOpenOnboarding={onOpenOnboarding}
					>
						{children}
					</SectionPanel>
				) : (
					<div
						className={
							GALLERY_SECTIONS.has(active)
								? SETTINGS_PANEL_FRAME_GALLERY
								: SETTINGS_PANEL_FRAME
						}
					>
						<SectionPanel
							section={active}
							onBack={onBack}
							workspace={workspace}
							onOpenOnboarding={onOpenOnboarding}
						>
							{children}
						</SectionPanel>
					</div>
				)}
			</div>
		</div>
	);
}

/**
 * Phone Settings: a bottom sheet sliding up over the root page, with iOS-style
 * paging inside — the root page lists the sections as grouped tappable rows,
 * and picking one slides its panel in from the right (Back slides it out).
 * Which page shows is route-driven: a section in the URL = detail page.
 */
function MobileSettings({
	groups,
	section,
	onSelect,
	onShowRoot,
	onBack,
	workspace,
	onOpenOnboarding,
	children,
}: {
	groups: SectionGroup[];
	section?: SettingsSectionKey;
	onSelect: (key: SettingsSectionKey) => void;
	onShowRoot?: () => void;
	onBack: () => void;
	workspace?: Workspace;
	onOpenOnboarding: () => void;
	children?: React.ReactNode;
}) {
	const [query, setQuery] = useState("");
	const shown = filterGroups(groups, query);
	const firstHit = shown[0]?.hits[0]?.item;
	// Keep the last opened section mounted while popping back to the root, so
	// the detail page has content during its slide-out.
	const [lastSection, setLastSection] = useState<SettingsSectionKey | null>(
		section ?? null,
	);
	useEffect(() => {
		if (section) setLastSection(section);
	}, [section]);

	const detail = section ?? null;
	const shownSection = detail ?? lastSection;
	const shownLabel = SECTIONS.find((s) => s.key === shownSection)?.label;
	const pageEase = "transition-transform duration-[var(--dur-lg)] ease-[var(--ease)]";

	return (
		<BottomSheet
			onClose={onBack}
			label="Settings"
			className={cn("settings-sheet h-[93dvh]", SETTINGS_LEADING)}
		>
			{(dismiss) => (
				<>
					<div className="relative flex h-11 shrink-0 items-center justify-center px-3">
						{detail && (
							<SheetIconButton
								className="absolute left-3"
								onClick={() => onShowRoot?.()}
								aria-label="Back to settings"
							>
								<IconChevronLeft size={24} />
							</SheetIconButton>
						)}
						{/* The sheet's own title, and the only one on phones: the panel
						    h1 hides in here (`[.settings-sheet_&]:hidden` in ui/settings).
						    This compact navigation chrome uses the 17px body step instead of
						    the larger desktop page-heading scale. */}
						<span className="text-body font-title text-fg">
							{detail ? shownLabel : "Settings"}
						</span>
						<SheetIconButton
							className="absolute right-3"
							onClick={dismiss}
							aria-label="Close settings"
						>
							<IconX size={24} />
						</SheetIconButton>
					</div>

					<div className="relative min-h-0 flex-1 overflow-hidden">
						{/* Root page: grouped section list over a bottom search bar.
						    Parked slightly left while a detail page covers it, iOS-style. */}
						<div
							className={cn("absolute inset-0", pageEase, detail && "-translate-x-1/3")}
							aria-hidden={!!detail}
						>
							<div className={SETTINGS_SHEET_LIST}>
								{shown.map((g) => (
									<div key={g.group}>
										<div className="mb-2 mt-5 px-1 text-control-label font-semibold text-faint">
											{g.group}
										</div>
										<div className="overflow-hidden rounded-2xl border border-divider-soft bg-settings-plate">
											{g.hits.map(({ item: s, hint }) => (
												<button
													key={s.key}
													className="relative flex w-full items-center gap-3 border-0 bg-transparent px-3.5 py-3 text-left after:absolute after:bottom-0 after:left-[54px] after:right-0 after:h-px after:bg-divider-soft last:after:hidden active:bg-hover"
													onClick={() => onSelect(s.key)}
												>
													<span className="flex h-7 w-7 shrink-0 items-center justify-center text-dim">
														{s.icon}
													</span>
												<span className="min-w-0 flex-1 text-item-title font-medium text-fg">
														{s.label}
														{hint && (
															<span className="block truncate text-meta font-normal text-faint">
																{hint}
															</span>
														)}
													</span>
													<IconChevronRight size={20} className="shrink-0 text-faint" />
												</button>
											))}
										</div>
									</div>
								))}
								{shown.length === 0 && (
									<div className="mt-6 px-1 text-supporting text-faint">
										Nothing matches “{query}”.
									</div>
								)}
								{!query && <SettingsAccountCard />}
							</div>

							{/* Search sits at the bottom edge, where the thumb is and where
							    iOS 26 puts it (the native app's sessions list does the same),
							    on glass — so the list stays legible passing behind it and the
							    way out of a long section list is always in reach. */}
							<NavSearch
								sheet
								value={query}
								onChange={setQuery}
								onSubmit={() => firstHit && onSelect(firstHit.key)}
								className={SETTINGS_SHEET_SEARCH_BAR}
							/>
						</div>

						{/* Detail page: the picked section's panel, slid in from the right. */}
						<div
							className={cn(
								"absolute inset-0 flex flex-col bg-surface",
								pageEase,
								detail ? "translate-x-0" : "translate-x-full",
							)}
							aria-hidden={!detail}
						>
							{shownSection && (
								<div data-settings-scroll className={SETTINGS_CONTENT_SHEET}>
									{TOOL_SECTIONS.has(shownSection) ? (
										<SectionPanel
										section={shownSection}
										workspace={workspace}
										onOpenOnboarding={onOpenOnboarding}
									>
										{children}
									</SectionPanel>
									) : (
										<div className={SETTINGS_PANEL_FRAME_SHEET}>
											<SectionPanel
											section={shownSection}
											onBack={onBack}
											workspace={workspace}
											onOpenOnboarding={onOpenOnboarding}
										>
												{children}
											</SectionPanel>
										</div>
									)}
								</div>
							)}
						</div>
					</div>
				</>
			)}
		</BottomSheet>
	);
}
