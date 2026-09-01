import React, { useEffect, useState } from "react";
import { IconCheck } from "../icons";
import { fetchFeeds, type RepoInfo } from "../../lib/api";
import { errorMessage } from "../../lib/error-message";
import {
  ACCENT_THEME_OPTIONS,
  getAccentTheme,
  getAccentThemeOption,
  getOnAccentInk,
  onAccentThemeChanged,
  setAccentTheme,
  type AccentTheme,
} from "../../lib/accent-theme";
import {
  onSidebarFeedsChanged,
  readHiddenSidebarFeeds,
  setSidebarFeedVisible,
} from "../../lib/sidebar-feeds";
import {
  onSidebarToolsChanged,
  readHiddenSidebarTools,
  setSidebarToolVisible,
  toolFitsViewport,
  SIDEBAR_TOOL_IDS,
  SIDEBAR_TOOL_LABELS,
} from "../../lib/sidebar-tools";
import { useIsPhone } from "../../hooks/useIsPhone";
import {
  getThemePref,
  effectiveTheme,
  onThemeChanged,
  setThemePref,
  type ThemePref,
} from "../../lib/theme";
import type { FeedDescriptor } from "../../lib/types";
import {
  setFilter,
  useSidebarFilter,
  type SortBy,
} from "../../lib/sidebar-filter";
import {
  DENSITY_OPTIONS,
  getSidebarDensity,
  onSidebarDensityChanged,
  setSidebarDensity,
  type SidebarDensity,
} from "../../lib/sidebar-density";
import {
  getWsTimePref,
  onWsTimeChanged,
  setWsTimePref,
  type WsTimePref,
} from "../../lib/workspace-time";
import {
  getSidebarSubagentsPref,
  onSidebarSubagentsChanged,
  setSidebarSubagentsPref,
} from "../../lib/sidebar-subagents-pref";
import {
  PLAIN_ID,
  SUPPORT_SURFACE_OPTIONS,
  setSupportSurface,
  supportSurfaceOf,
  type SupportSurface,
} from "../../lib/support-surface";
import {
  SettingCard,
  SettingGroup,
  SettingsGroupLabel,
  SettingsSection,
} from "../../ui/settings";
import { Segmented, SegmentedOption } from "../../ui/segmented";
import { InlineAlert } from "../../ui/state";
import { Switch } from "../../ui/switch";
import { usePeople } from "../../lib/people";
import { useCurrentUser } from "../UserPicker";
import { useAutomationOverview } from "../../lib/automation-overview";
import { AGENT_NAME } from "../../lib/brand";
import { AGENT_PERSON_KEY } from "../../lib/automation-audience";
import {
  GROUP_BY_OPTIONS,
  LAST_USED_TIME_OPTIONS,
  personFilterOptions,
  PR_FILTER_OPTIONS,
  repoFilterOptions,
} from "../sidebar/filter-options";
import { Tooltip } from "../../ui/tooltip";
import { Select, SettingRow } from "./shared";

// The look of the app, as it appears inside Settings → Preferences. These used
// to be their own Appearance section; they are per-device choices about the
// same surfaces Preferences already covers, so they sit here rather than one
// nav row away.

const THEME_OPTIONS: { value: ThemePref; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/**
 * Fixed palettes for the miniature mockup below, deliberately raw values
 * rather than theme tokens, because each swatch has to keep showing its own
 * tone no matter which theme is active. Applied as custom properties so the
 * mock's parts can stay plain utilities.
 */
const MOCK_PALETTE: Record<"light" | "dark", React.CSSProperties> = {
  light: {
    "--mk-bg": "#e9e9e9",
    "--mk-panel": "#ffffff",
    "--mk-line": "#d5d5d5",
    "--mk-pill": "#cbcbcb",
  } as React.CSSProperties,
  dark: {
    "--mk-bg": "#565656",
    "--mk-panel": "#3e3e3e",
    "--mk-line": "#c4c4c4",
    "--mk-pill": "#8a8a8a",
  } as React.CSSProperties,
};

// A miniature app mockup used inside the theme swatches. Its proportions are
// percentages of the swatch rather than scale steps: it is an illustration
// that has to rescale with the card, not a piece of chrome on the grid.
function ThemeMock({ tone }: { tone: "light" | "dark" }) {
  return (
    <div
      className="absolute inset-0 bg-(--mk-bg) pt-[15%]"
      style={MOCK_PALETTE[tone]}
    >
      <div className="mb-[9px] flex flex-col items-center gap-[5px]">
        <div className="h-1.5 w-[56%] rounded-sm bg-(--mk-pill)" />
        <div className="h-1.5 w-[42%] rounded-sm bg-(--mk-pill) opacity-65" />
      </div>
      <div className="mr-[9%] ml-[14%] flex h-[56%] flex-col gap-2 rounded-t-md bg-(--mk-panel) px-3 py-[11px]">
        <div className="h-1.5 w-[68%] rounded-xs bg-(--mk-line)" />
        <div className="h-1.5 w-[84%] rounded-xs bg-(--mk-line)" />
        <div className="h-1.5 w-[56%] rounded-xs bg-(--mk-line)" />
      </div>
    </div>
  );
}

function ThemeCard({
  option,
  active,
  onClick,
}: {
  option: ThemePref;
  active: boolean;
  onClick: () => void;
}) {
  const label = THEME_OPTIONS.find((o) => o.value === option)?.label ?? option;
  return (
    // Selection reads off `data-active` rather than an `.active` class so the
    // swatch and label can style themselves with group-data-* variants. The
    // old rules were compound selectors (`.theme-card.active .theme-swatch`),
    // which outrank a single utility: leaving the class here would have let
    // it keep winning against everything below.
    <button
      className="group flex w-20 cursor-pointer flex-col items-center gap-2.5 border-none bg-transparent p-0 desktop:w-28"
      role="radio"
      aria-checked={active}
      data-active={active || undefined}
      onClick={onClick}
    >
      <div className="relative aspect-16/10 w-full overflow-hidden rounded-row border-2 border-line transition-[border-color,box-shadow] group-hover:border-faint group-data-active:border-accent group-data-active:shadow-[0_0_0_1px_var(--accent)]">
        {/* System = light base with the dark mock clipped over the right half. */}
        <ThemeMock tone={option === "dark" ? "dark" : "light"} />
        {option === "system" && (
          <div className="absolute inset-0 [clip-path:inset(0_0_0_50%)]">
            <ThemeMock tone="dark" />
          </div>
        )}
      </div>
      <span className="text-label text-dim group-data-active:font-semibold group-data-active:text-fg">
        {label}
      </span>
    </button>
  );
}

function AccentSwatch({
  theme,
  active,
  tone,
  onClick,
}: {
  theme: AccentTheme;
  active: boolean;
  tone: "light" | "dark";
  onClick: () => void;
}) {
  const option = getAccentThemeOption(theme);
  const swatch = option[tone];
  const ink = getOnAccentInk(theme, tone);
  const style = {
    "--swatch": swatch,
    "--swatch-ink": ink,
  } as React.CSSProperties;

  return (
    <Tooltip label={option.label}>
      <label
        className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-md p-1"
        style={style}
      >
        <input
          type="radio"
          name="accent-theme"
          value={theme}
          checked={active}
          onChange={onClick}
          aria-label={option.label}
          className="peer sr-only"
        />
        <span className="flex size-8 items-center justify-center rounded-full border border-line bg-[linear-gradient(135deg,color-mix(in_srgb,var(--swatch)_97%,white),color-mix(in_srgb,var(--swatch)_94%,black))] text-(--swatch-ink) outline-offset-4 transition-[scale,box-shadow] duration-150 active:scale-[0.96] peer-checked:shadow-[0_0_0_2px_var(--bg-raised),0_0_0_4px_var(--swatch)] peer-focus-visible:outline-2 peer-focus-visible:outline-accent-ink">
          {active && <IconCheck size={16} strokeWidth={2.4} />}
        </span>
      </label>
    </Tooltip>
  );
}

/**
 * Theme and accent, in one card. They are the same decision taken twice, how
 * the app looks, so they share a heading instead of standing as two sections
 * a scroll apart.
 */
export function AppearanceSection() {
  const [pref, setPref] = useState<ThemePref>(getThemePref);
  const [tone, setTone] = useState(effectiveTheme);
  useEffect(
    () =>
      onThemeChanged(() => {
        setPref(getThemePref());
        setTone(effectiveTheme());
      }),
    [],
  );
  const [accent, setAccent] = useState<AccentTheme>(getAccentTheme);
  useEffect(() => onAccentThemeChanged(() => setAccent(getAccentTheme())), []);

  return (
    <>
      <SettingsGroupLabel>Appearance</SettingsGroupLabel>
      <SettingsSection>
        <div
          className="flex justify-start gap-3 desktop:gap-4"
          role="radiogroup"
          aria-label="Theme"
        >
          {THEME_OPTIONS.map((o) => (
            <ThemeCard
              key={o.value}
              option={o.value}
              active={pref === o.value}
              onClick={() => {
                setThemePref(o.value);
                setPref(o.value);
              }}
            />
          ))}
        </div>
        <div className="mt-5">
          <div className="mb-2 text-control-label font-medium text-faint">
            Accent
          </div>
          <div
            // Keep the seven 44px targets together instead of stretching them
            // across the plate. They wrap only when the viewport cannot hold
            // the full group without shrinking its touch targets.
            className="flex w-fit max-w-full flex-wrap gap-y-1"
            role="radiogroup"
            aria-label="Accent colour"
          >
            {ACCENT_THEME_OPTIONS.map((option) => (
              <AccentSwatch
                key={option.value}
                theme={option.value}
                active={accent === option.value}
                tone={tone}
                onClick={() => {
                  setAccentTheme(option.value);
                  setAccent(option.value);
                }}
              />
            ))}
          </div>
        </div>
      </SettingsSection>
    </>
  );
}

/** The same sidebar filter controls, shown as Settings rows. */
export function SidebarDisplayRows({ repos }: { repos: RepoInfo[] }) {
  const filter = useSidebarFilter();
  const currentUser = useCurrentUser();
  const roster = usePeople();
  const automationOverview = useAutomationOverview("settings");
  const hasUnownedAutomation = Array.from(automationOverview.values()).some(
    (automation) => !automation.owner,
  );
  const people = roster.map((person) => ({
    key:
      person.name.trim().split(/\s+/)[0]?.toLowerCase() ||
      person.name.toLowerCase(),
    label: person.name,
  }));
  if (
    (hasUnownedAutomation || filter.person === AGENT_PERSON_KEY) &&
    !people.some(({ key }) => key === AGENT_PERSON_KEY)
  )
    people.push({ key: AGENT_PERSON_KEY, label: AGENT_NAME });
  if (
    !["me", "everyone", "unassigned"].includes(filter.person) &&
    !people.some(({ key }) => key === filter.person)
  )
    people.push({ key: filter.person, label: filter.person });

  const availableRepos = repos.map(({ id }) => ({ id }));
  if (
    filter.repo !== "all" &&
    !availableRepos.some(({ id }) => id === filter.repo)
  )
    availableRepos.push({ id: filter.repo });
  const repoOptions = repoFilterOptions(availableRepos);
  const personOptions = personFilterOptions({ people, currentUser });

  const [density, setDensity] = useState<SidebarDensity>(getSidebarDensity);
  useEffect(
    () => onSidebarDensityChanged(() => setDensity(getSidebarDensity())),
    [],
  );
  const [wsTime, setWsTime] = useState<WsTimePref>(getWsTimePref);
  useEffect(() => onWsTimeChanged(() => setWsTime(getWsTimePref())), []);
  const [showSubagents, setShowSubagents] = useState(getSidebarSubagentsPref);
  useEffect(
    () =>
      onSidebarSubagentsChanged(() =>
        setShowSubagents(getSidebarSubagentsPref()),
      ),
    [],
  );

  return (
    <>
      {/* These rows describe one default view of the sidebar. */}
      <SettingGroup>
        <SettingRow
          title="Group by"
          control={
            <Select
              label="Group by"
              value={filter.groupBy}
              options={GROUP_BY_OPTIONS}
              onChange={(groupBy) => setFilter({ groupBy })}
            />
          }
        />
        <SettingRow
          title="Group by project"
          control={
            <Switch
              aria-label="Group by project"
              checked={filter.byProject}
              onCheckedChange={(byProject) => setFilter({ byProject })}
            />
          }
        />
        <SettingRow
          title="Repo"
          control={
            <Select
              label="Repo"
              value={filter.repo}
              options={repoOptions}
              onChange={(repo) => setFilter({ repo })}
            />
          }
        />
        <SettingRow
          title="Person"
          control={
            <Select
              label="Person"
              value={filter.person}
              options={personOptions}
              onChange={(person) => setFilter({ person })}
            />
          }
        />
        {filter.groupBy === "status" && (
          <SettingRow
            title="Sort by"
            control={
              <Select
                label="Sort by"
                value={filter.sort}
                options={[
                  { value: "updated", label: "Updated" },
                  { value: "created", label: "Created" },
                ]}
                onChange={(sort) => setFilter({ sort: sort as SortBy })}
              />
            }
          />
        )}
        <SettingRow
          title="Pull requests"
          control={
            <Select
              label="Pull requests"
              value={filter.prs}
              options={PR_FILTER_OPTIONS}
              onChange={(prs) => setFilter({ prs })}
            />
          }
        />
        <SettingRow
          title="Show auto created"
          control={
            <Switch
              aria-label="Show auto created"
              checked={filter.autoCreated === "show"}
              onCheckedChange={(shown) =>
                setFilter({ autoCreated: shown ? "show" : "hide" })
              }
            />
          }
        />
        <SettingRow
          title="Show sub-agents"
          desc="Nest worker sessions under the selected workspace."
          control={
            <Switch
              aria-label="Show sub-agents"
              checked={showSubagents}
              onCheckedChange={setSidebarSubagentsPref}
            />
          }
        />
        <SettingRow
          title="Hide empty projects"
          control={
            <Switch
              aria-label="Hide empty projects"
              checked={filter.emptyProjects === "hide"}
              onCheckedChange={(hide) =>
                setFilter({ emptyProjects: hide ? "hide" : "show" })
              }
            />
          }
        />
      </SettingGroup>
      <SettingGroup>
        <SettingRow
          title="Row density"
          control={
            <Segmented
              label="Sidebar row density"
              value={density}
              onValueChange={(value) =>
                setSidebarDensity(value as SidebarDensity)
              }
            >
              {DENSITY_OPTIONS.map(({ value, label, Icon }) => (
                <SegmentedOption key={value} value={value}>
                  <Icon size={20} />
                  {label}
                </SegmentedOption>
              ))}
            </Segmented>
          }
        />
        <SettingRow
          title="Show last used time"
          control={
            <Select
              label="Show last used time"
              value={wsTime}
              options={LAST_USED_TIME_OPTIONS}
              onChange={setWsTimePref}
            />
          }
        />
      </SettingGroup>
    </>
  );
}

/** Which tools and sources the sidebar carries, as its own card. */
export function SidebarItemsSection() {
  const isPhone = useIsPhone();
  const [hiddenSidebarTools, setHiddenSidebarTools] = useState(
    readHiddenSidebarTools,
  );
  const [sidebarFeeds, setSidebarFeeds] = useState<FeedDescriptor[]>([]);
  const [sidebarFeedsError, setSidebarFeedsError] = useState<string | null>(
    null,
  );
  const [hiddenSidebarFeeds, setHiddenSidebarFeeds] = useState(
    readHiddenSidebarFeeds,
  );
  useEffect(() => {
    let alive = true;
    fetchFeeds()
      .then((feeds) => {
        if (alive) setSidebarFeeds(feeds);
      })
      .catch((error: unknown) => {
        if (alive)
          setSidebarFeedsError(
            errorMessage(error, "Failed to load sidebar sources"),
          );
      });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(
    () =>
      onSidebarToolsChanged(() =>
        setHiddenSidebarTools(readHiddenSidebarTools()),
      ),
    [],
  );
  useEffect(
    () =>
      onSidebarFeedsChanged(() =>
        setHiddenSidebarFeeds(readHiddenSidebarFeeds()),
      ),
    [],
  );

  return (
    <>
      <SettingsGroupLabel>Show in sidebar</SettingsGroupLabel>
      {sidebarFeedsError && <InlineAlert>{sidebarFeedsError}</InlineAlert>}
      <SettingCard>
        {/* Support is one decision, not two switches. Its tool and its
				    sidebar band are the same queue reached two ways, so they are
				    set together here and left out of the lists below. Only
				    offered when Plain is actually connected: with no queue behind
				    it there is nowhere for either surface to lead. */}
        {sidebarFeeds.some((feed) => feed.id === PLAIN_ID) && (
          <SettingRow
            title="Support tickets"
            desc="Choose where Plain tickets live: in a full workspace from the sidebar, or beside the queue without chat."
            control={
              <Select
                label="Where support tickets live"
                value={supportSurfaceOf(
                  !hiddenSidebarTools.has(PLAIN_ID),
                  !hiddenSidebarFeeds.has(PLAIN_ID),
                )}
                options={SUPPORT_SURFACE_OPTIONS}
                onChange={(value) => setSupportSurface(value as SupportSurface)}
              />
            }
          />
        )}
        {SIDEBAR_TOOL_IDS.filter(
          (toolId) => toolFitsViewport(toolId, isPhone) && toolId !== PLAIN_ID,
        ).map((toolId) => (
          <SettingRow
            key={toolId}
            title={SIDEBAR_TOOL_LABELS[toolId]}
            control={
              <Switch
                aria-label={`Show ${SIDEBAR_TOOL_LABELS[toolId]} in sidebar`}
                checked={!hiddenSidebarTools.has(toolId)}
                onCheckedChange={(visible) =>
                  setSidebarToolVisible(toolId, visible)
                }
              />
            }
          />
        ))}
        {sidebarFeeds
          .filter((feed) => feed.id !== PLAIN_ID)
          .map((feed) => (
            <SettingRow
              key={feed.id}
              title={feed.title}
              desc="Hidden sources stop refreshing until shown again."
              control={
                <Switch
                  aria-label={`Show ${feed.title} in sidebar`}
                  checked={!hiddenSidebarFeeds.has(feed.id)}
                  onCheckedChange={(visible) =>
                    setSidebarFeedVisible(feed.id, visible)
                  }
                />
              }
            />
          ))}
      </SettingCard>
    </>
  );
}
