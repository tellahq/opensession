import React, { useEffect, useState } from "react";
import { useIsPhone } from "../hooks/useIsPhone";
import { useScrollEdge } from "../hooks/useScrollEdge";
import { cn } from "../ui/cn";
import {
  SETTINGS_BACK,
  SETTINGS_CONTENT_SHEET,
  SETTINGS_FLAT,
  SETTINGS_MODAL,
  SETTINGS_NAV,
  SETTINGS_NAV_CAPTION,
  SETTINGS_NAV_GROUP,
  SETTINGS_NAV_ICON,
  SETTINGS_NAV_LIST,
  SETTINGS_NAV_ROW,
  SETTINGS_NAV_SEARCH,
  SETTINGS_PAGE,
  SETTINGS_PANEL,
  SETTINGS_PANEL_FRAME,
  SETTINGS_PANEL_FRAME_GALLERY,
  SETTINGS_PANEL_FRAME_SHEET,
  SETTINGS_SHEET_CAPTION,
  SETTINGS_SHEET_EMPTY,
  SETTINGS_SHEET_GLYPH,
  SETTINGS_SHEET_HINT,
  SETTINGS_SHEET_LABEL,
  SETTINGS_SHEET_LIST,
  SETTINGS_SHEET_ROW,
  SETTINGS_SHEET_SEARCH_BAR,
  SETTINGS_SCRIM,
  settingsContent,
} from "../lib/settings-classes";
import { matchSections, type SectionHit } from "../lib/settings-search";
import {
  SECTIONS,
  TOOL_SECTIONS,
  scopeLabel,
  type SettingsSectionKey,
  type ToolSectionKey,
} from "../lib/settings-sections";
import { useNewLayoutPref } from "../lib/new-layout-pref";
import { Input } from "../ui/input";
import { SETTINGS_PLATE, SettingsInSheet } from "../ui/settings";
import { PhonePage, SheetIconButton } from "../ui/sheet";
import { PhoneTopBar, PhoneTopBarTitle } from "../ui/top-bar";
import { Connections } from "./Connections";
import {
  IconChevronLeft,
  IconChevronRight,
  IconPlus,
  IconSearch,
  IconX,
} from "./icons";
import {
  fetchRepos,
  notifyReposChanged,
  REPOS_CHANGED_EVENT,
  type RepoInfo,
} from "../lib/api";
import { RepoTile } from "./RepoTile";
import { AddRepositoryDialog } from "./SetupRepos";
import { KeychainPanel } from "./settings/KeychainPanel";
import { RepoPage } from "./settings/RepoPage";
import { MyAccountsPanel } from "./MyAccounts";
import { AuditPanel } from "./settings/AuditPanel";
import { DeploysPanel } from "./settings/DeploysPanel";
import { GeneralPanel } from "./settings/GeneralPanel";
import { IngressPanel } from "./settings/IngressPanel";
import { LibraryPanel } from "./settings/LibraryPanel";
import { MembersPanel } from "./settings/MembersPanel";
import { MemoryPanel } from "./settings/MemoryPanel";
import { ProvidersPanel } from "./settings/ProvidersPanel";
import { NotificationsPanel } from "./settings/NotificationsPanel";
import { PapercutsPanel } from "./settings/PapercutsPanel";
import { AppearancePanel, PreferencesPanel } from "./settings/PreferencesPanel";
import { ShortcutsPanel } from "./settings/ShortcutsPanel";
import { ReposPanel } from "./settings/ReposPanel";
import { SandboxesPanel } from "./settings/SandboxesPanel";
import { StoragePanel } from "./settings/StoragePanel";
import { RunnersPanel } from "./settings/RunnersPanel";
import { SettingsAccountCard, SettingsAccountFooter } from "./SettingsAccount";

// Settings: on desktop a modal over the page it was opened from, with
// Personal, Organization and Server tabs across the top, the tab's sections in
// a side nav and a scrolling body; on phones a sheet. Each area is an entry in
// SECTIONS (lib/settings-sections) and a panel below. In the old layout the
// Automation group holds the tool surfaces (Automations, Goals, Security),
// which render at their own routes with this surface as chrome, so the section
// is controlled by the router, not local state.

// The nav table itself lives in lib/settings-sections, because the command
// palette needs the same list and importing this whole component tree to read
// it would be absurd. Re-exported here so existing callers keep their import.
export type { SettingsSectionKey, ToolSectionKey };

/** Sections that are browsed rather than read down, and take the wider
 *  column for it (see SETTINGS_PANEL_FRAME_GALLERY). */
const GALLERY_SECTIONS = new Set<SettingsSectionKey>(["library"]);

// Settings is a dense mix of headings, row titles, labels, descriptions,
// fields, and tool panels. Body roles share 150% leading; heading and title
// roles stay compact at 110%. The descendant rules deliberately beat local
// one-off leading utilities so every section follows the page-level rhythm.
// `data-setting-title` and `data-top-bar-title` are how StyleX row, form and
// phone bar titles are named here, since they carry no title class.
const SETTINGS_LEADING =
  "leading-body [&_*]:!leading-body " +
  "[&_[data-setting-title]]:!leading-title [&_[data-top-bar-title]]:!leading-title " +
  "[&_.settings-title]:!leading-title " +
  "[&_h1]:!leading-title [&_h2]:!leading-title [&_h3]:!leading-title " +
  "[&_h4]:!leading-title [&_h5]:!leading-title [&_h6]:!leading-title " +
  "[&_.font-title]:!leading-title [&_.text-item-title]:!leading-title " +
  "[&_.text-dialog-title]:!leading-title [&_.text-section-title]:!leading-title " +
  "[&_.text-page-title]:!leading-title [&_.text-stat]:!leading-title";

type Section = (typeof SECTIONS)[number];
type SectionGroup = { group?: string; items: Section[] };
type FilteredGroup = { group?: string; hits: SectionHit<Section>[] };

/** Runs of sections under a caption, in table order. `captionOf` names the
 *  run a section belongs to; an undefined caption is a run with none. */
function groupSections(
  sections: Section[],
  captionOf: (section: Section) => string | undefined,
): SectionGroup[] {
  const groups: SectionGroup[] = [];
  for (const section of sections) {
    const caption = captionOf(section);
    let group = groups.find((entry) => entry.group === caption);
    if (!group) groups.push((group = { group: caption, items: [] }));
    group.items.push(section);
  }
  return groups;
}

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
/** One row of the desktop nav: a section, a repository, or Back to app. */
function NavRow({
  icon,
  active,
  onClick,
  className = SETTINGS_NAV_ROW,
  children,
}: {
  icon: React.ReactNode;
  active?: boolean;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={className}
      data-active={active || undefined}
      onClick={onClick}
    >
      <span className={SETTINGS_NAV_ICON}>{icon}</span>
      {children}
    </button>
  );
}

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
          size={20}
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
              ? cn(
                  "h-10 rounded-full border-transparent bg-raised pl-11 text-input-phone",
                  value && "pr-11",
                )
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
              sheet
                ? "right-1.5 size-8 rounded-full"
                : "right-1 size-6 rounded-md",
            )}
            onClick={() => onChange("")}
          >
            <IconX size={20} />
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
  repo,
  onOpenRepo,
  children,
}: {
  section: SettingsSectionKey;
  /** On the repos section, the repository whose page is open. */
  repo?: string;
  onOpenRepo: (id?: string) => void;
  children?: React.ReactNode;
}) {
  return (
    <>
      {TOOL_SECTIONS.has(section) && children}
      {section === "notifications" && <NotificationsPanel />}
      {section === "preferences" && <PreferencesPanel />}
      {section === "appearance" && <AppearancePanel />}
      {section === "shortcuts" && <ShortcutsPanel />}
      {section === "general" && <GeneralPanel />}
      {section === "repos" &&
        (repo ? (
          <RepoPage key={repo} repoId={repo} onRemoved={() => onOpenRepo()} />
        ) : (
          <ReposPanel onOpenRepo={onOpenRepo} />
        ))}
      {section === "members" && <MembersPanel />}
      {section === "library" && <LibraryPanel />}
      {section === "audit" && <AuditPanel />}
      {section === "providers" && <ProvidersPanel />}
      {section === "sandboxes" && <SandboxesPanel />}
      {section === "runners" && <RunnersPanel />}
      {section === "connections" && <Connections />}
      {section === "myAccounts" && <MyAccountsPanel />}
      {section === "keychain" && <KeychainPanel />}
      {section === "memory" && <MemoryPanel />}
      {section === "ingress" && <IngressPanel />}
      {section === "storage" && <StoragePanel />}
      {section === "papercuts" && <PapercutsPanel />}
      {section === "deploys" && <DeploysPanel />}
    </>
  );
}

/** The registered repositories, for the nav's own group, kept fresh when one
 *  is added or removed anywhere in the app. */
function useRepoList(): RepoInfo[] {
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      void fetchRepos()
        .then((list) => alive && setRepos(list))
        .catch(() => {});
    load();
    window.addEventListener(REPOS_CHANGED_EVENT, load);
    return () => {
      alive = false;
      window.removeEventListener(REPOS_CHANGED_EVENT, load);
    };
  }, []);
  return repos;
}

export function Settings({
  onBack,
  section,
  repo,
  onSelect,
  onSelectRepo,
  onShowRoot,
  children,
}: {
  onBack: () => void;
  /** Active section, derived from the route (tools have their own URLs).
   * Undefined = no explicit section: desktop defaults to Account, while the
   * phone sheet stays on its root list of sections. */
  section?: SettingsSectionKey;
  /** On the repos section, the repository whose page is open. */
  repo?: string;
  /** Navigate to a section — App maps tool keys to their own routes. */
  onSelect: (key: SettingsSectionKey) => void;
  /** Open a repository's page, or the list of them without an id. */
  onSelectRepo: (id?: string) => void;
  /** Phone sheet's back-to-root (navigate to sectionless /settings). */
  onShowRoot?: () => void;
  /** The active tool's panel (App owns the tool components and their props). */
  children?: React.ReactNode;
}) {
  const isPhone = useIsPhone();
  // The new layout (desktop only) makes Automations, Goals and Security
  // pages of the app, so Settings stops listing them there.
  const toolPages = useNewLayoutPref() && !isPhone;
  const offered = SECTIONS.filter(
    (entry) => !(toolPages && TOOL_SECTIONS.has(entry.key)),
  );
  const repos = useRepoList();
  const [addingRepo, setAddingRepo] = useState(false);

  const [query, setQuery] = useState("");
  // The search field is a sibling above the section list, not its parent, so
  // it cannot know on its own when rows have started travelling under it. The
  // app's own chrome rows ask the same question the same way.
  const [searchBar, setSearchBar] = useState<HTMLDivElement | null>(null);
  useScrollEdge(searchBar, "[data-settings-nav-scroll]");

  // Esc closes the modal, unless it belongs to a field, a menu or a dialog
  // opened from inside Settings.
  useEffect(() => {
    if (isPhone) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("input, textarea, select, [contenteditable]")
      )
        return;
      if (
        document.querySelector(
          '[role="dialog"]:not([data-settings-modal]), [role="alertdialog"], [role="menu"], [role="listbox"]',
        )
      )
        return;
      onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isPhone, onBack]);

  const panel = (key: SettingsSectionKey) => (
    <SectionPanel section={key} repo={repo} onOpenRepo={onSelectRepo}>
      {children}
    </SectionPanel>
  );

  if (isPhone)
    return (
      <MobileSettings
        groups={groupSections(
          offered,
          (entry) => entry.group ?? scopeLabel(entry.scope),
        )}
        section={section}
        onSelect={onSelect}
        onShowRoot={onShowRoot}
        onBack={onBack}
        panel={panel}
      />
    );

  // A bare /settings lands on Account, the first personal section, on desktop.
  // Keep the section out of the URL so phones can stay at the nav root.
  const active = section ?? "myAccounts";
  // One sidebar, captioned the way Conductor's is: Personal, Organization,
  // each repository under its own caption, then Server. The repos section is
  // the Repositories group itself, not a row of its own.
  const shown = filterGroups(
    groupSections(
      offered.filter((entry) => entry.key !== "repos"),
      (entry) => entry.group ?? scopeLabel(entry.scope),
    ),
    query,
  );
  const q = query.trim().toLowerCase();
  const repoHits = repos.filter(
    (entry) =>
      !q ||
      (entry.label || entry.id).toLowerCase().includes(q) ||
      "repositories".includes(q),
  );
  const firstHit = shown[0]?.hits[0]?.item;
  const repoGroup = (repoHits.length > 0 || !q) && (
    <div className={SETTINGS_NAV_GROUP} key="Repositories">
      <div className={SETTINGS_NAV_CAPTION}>Repositories</div>
      {repoHits.map((entry) => (
        <NavRow
          key={entry.id}
          icon={<RepoTile name={entry.id} size={18} />}
          active={active === "repos" && repo === entry.id}
          onClick={() => onSelectRepo(entry.id)}
        >
          <span className="min-w-0 flex-1 truncate">
            {entry.label || entry.id}
          </span>
        </NavRow>
      ))}
      {!q && (
        <NavRow
          icon={<IconPlus size={20} />}
          onClick={() => setAddingRepo(true)}
        >
          Add repository
        </NavRow>
      )}
    </div>
  );
  // Repositories sit after Organization, the scope they belong to.
  const organizationAt = shown.findIndex((g) => g.group === "Organization");
  const renderGroup = (g: FilteredGroup, index: number) => (
    <div className={SETTINGS_NAV_GROUP} key={g.group ?? index}>
      {g.group && <div className={SETTINGS_NAV_CAPTION}>{g.group}</div>}
      {g.hits.map(({ item: s, hint }) => (
        <NavRow
          key={s.key}
          icon={s.icon}
          active={active === s.key && !repo}
          onClick={() => onSelect(s.key)}
        >
          <span className="min-w-0 flex-1">
            {s.label}
            {hint && (
              <span className="block truncate text-meta font-normal text-faint">
                {hint}
              </span>
            )}
          </span>
        </NavRow>
      ))}
    </div>
  );

  return (
    <div className={cn(SETTINGS_MODAL, SETTINGS_LEADING)}>
      <div aria-hidden="true" className={SETTINGS_SCRIM} onClick={onBack} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        data-settings-modal
        className={SETTINGS_PANEL}
      >
        <div className={SETTINGS_PAGE}>
          {/* Back and search stay put; only the section list scrolls, so
              neither they nor the account footer are lost once the list
              outgrows the nav. */}
          <aside className={SETTINGS_NAV}>
            <NavRow
              className={SETTINGS_BACK}
              icon={<IconChevronLeft />}
              onClick={onBack}
            >
              Back to app
            </NavRow>
            <NavSearch
              ref={setSearchBar}
              value={query}
              onChange={setQuery}
              onSubmit={() => firstHit && onSelect(firstHit.key)}
              className={SETTINGS_NAV_SEARCH}
            />
            {/* The attribute is what useScrollEdge finds the scrollport by. */}
            <div data-settings-nav-scroll className={SETTINGS_NAV_LIST}>
              {shown.map((g, index) =>
                index === organizationAt ? (
                  <React.Fragment key={g.group}>
                    {renderGroup(g, index)}
                    {repoGroup}
                  </React.Fragment>
                ) : (
                  renderGroup(g, index)
                ),
              )}
              {organizationAt < 0 && repoGroup}
              {shown.length === 0 && repoHits.length === 0 && (
                <div className="px-2.5 py-3 text-meta text-faint">
                  Nothing matches “{query}”.
                </div>
              )}
            </div>
            <SettingsAccountFooter />
          </aside>

          {/* Tool sections fill the whole content area edge-to-edge (they
              carry their own layout and scrolling); settings panels keep the
              centered reading column, laid flat on the page: rows and
              hairlines, no plates. */}
          <div
            data-settings-scroll
            className={cn(
              settingsContent(TOOL_SECTIONS.has(active)),
              SETTINGS_FLAT,
            )}
          >
            {TOOL_SECTIONS.has(active) ? (
              panel(active)
            ) : (
              <div
                className={
                  GALLERY_SECTIONS.has(active)
                    ? SETTINGS_PANEL_FRAME_GALLERY
                    : SETTINGS_PANEL_FRAME
                }
              >
                {panel(active)}
              </div>
            )}
          </div>
        </div>
      </div>
      <AddRepositoryDialog
        open={addingRepo}
        onOpenChange={setAddingRepo}
        onAdded={() => notifyReposChanged()}
      />
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
  panel,
}: {
  groups: SectionGroup[];
  section?: SettingsSectionKey;
  onSelect: (key: SettingsSectionKey) => void;
  onShowRoot?: () => void;
  onBack: () => void;
  panel: (key: SettingsSectionKey) => React.ReactNode;
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
  const pageEase = "transition-transform duration-long ease-standard";

  return (
    <PhonePage
      onClose={onBack}
      label="Settings"
      className={cn("settings-sheet", SETTINGS_LEADING)}
    >
      {(dismiss) => (
        <SettingsInSheet.Provider value>
          <PhoneTopBar>
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
						    h1 stays out in here (`SettingsInSheet` in ui/settings).
						    This compact navigation chrome uses the 17px body step instead of
						    the larger desktop page-heading scale. */}
            <PhoneTopBarTitle>
              {detail ? shownLabel : "Settings"}
            </PhoneTopBarTitle>
            <SheetIconButton
              className="absolute right-3"
              onClick={dismiss}
              aria-label="Close settings"
            >
              <IconX size={24} />
            </SheetIconButton>
          </PhoneTopBar>

          <div className="relative min-h-0 flex-1 overflow-hidden">
            {/* Root page: grouped section list over a bottom search bar.
						    Parked slightly left while a detail page covers it, iOS-style. */}
            <div
              className={cn(
                "absolute inset-0",
                pageEase,
                detail && "-translate-x-1/3",
              )}
              aria-hidden={!!detail}
            >
              <div className={SETTINGS_SHEET_LIST}>
                {shown.map((g) => (
                  <div key={g.group}>
                    <div className={SETTINGS_SHEET_CAPTION}>{g.group}</div>
                    <div className={SETTINGS_PLATE}>
                      {g.hits.map(({ item: s, hint }) => (
                        <button
                          key={s.key}
                          className={SETTINGS_SHEET_ROW}
                          onClick={() => onSelect(s.key)}
                        >
                          <span className={SETTINGS_SHEET_GLYPH}>{s.icon}</span>
                          <span className={SETTINGS_SHEET_LABEL}>
                            {s.label}
                            {hint && (
                              <span className={SETTINGS_SHEET_HINT}>
                                {hint}
                              </span>
                            )}
                          </span>
                          <IconChevronRight
                            size={20}
                            className="shrink-0 text-faint"
                          />
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
                {shown.length === 0 && (
                  <div className={SETTINGS_SHEET_EMPTY}>
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
                    panel(shownSection)
                  ) : (
                    <div className={SETTINGS_PANEL_FRAME_SHEET}>
                      {panel(shownSection)}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </SettingsInSheet.Provider>
      )}
    </PhonePage>
  );
}
