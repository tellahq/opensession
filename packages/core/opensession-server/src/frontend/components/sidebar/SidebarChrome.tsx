import React from "react";
import type { NavigationActions } from "../../lib/navigation";
import {
  SIDEBAR_BAND_CHEVRON,
  SIDEBAR_BAND_CHEVRON_COLLAPSED,
  SIDEBAR_DENSITY_VARS,
  SIDEBAR_HEADER_BTN,
  SIDEBAR_HEADER_BTN_DESKTOP,
  SIDEBAR_HEADER_BTN_PHONE,
  SIDEBAR_HOVER_LAYER,
  SIDEBAR_NAV_X,
  SIDEBAR_STICKY_BAND,
  SIDEBAR_STICKY_BAND_ROW,
  SIDEBAR_STUCK_BACKING,
} from "../../lib/sidebar-classes";
import {
  personLensFilter,
  personLensValue,
  setFilter,
  useSidebarFilter,
} from "../../lib/sidebar-filter";
import { setSupportSurface } from "../../lib/support-surface";
import { cn } from "../../ui/cn";
import { Tooltip } from "../../ui/tooltip";
import { useTeamPresence } from "../TeamPresence";
import { UserAvatar } from "../UserAvatar";
import {
  IconChevronDown,
  IconFilter,
  IconPeople,
  IconPlus,
  IconX,
} from "../icons";
import { RepoFilterChip } from "./Filters";
import type { SidebarToolsNavItem } from "./SidebarToolsNav";
import { SidebarToolsNav } from "./SidebarToolsNav";

interface SidebarChromeState {
  density: string;
  connected: boolean;
  isPhone: boolean;
  borrowedLens: boolean;
  workspacesOpen: boolean;
  repoInline: boolean;
  filterOpen: boolean;
  newSessionKeys: string[] | null;
}

interface SidebarChromeTools {
  tools: SidebarToolsNavItem[];
  menuTools: React.ComponentProps<typeof SidebarToolsNav>["menuTools"];
  team: ReturnType<typeof useTeamPresence>;
  onSetToolVisible: React.ComponentProps<
    typeof SidebarToolsNav
  >["onSetToolVisible"];
}

interface SidebarChromeIdentity {
  filter: ReturnType<typeof useSidebarFilter>;
  currentUser: string;
  personLensName: string;
  repos: string[];
}

interface SidebarChromeRefs {
  headRef: React.RefObject<HTMLDivElement | null>;
  titleRef: React.RefObject<HTMLElement | null>;
  actionsRef: React.RefObject<HTMLDivElement | null>;
  probeRef: React.RefObject<HTMLSpanElement | null>;
  setFilterButton: React.Dispatch<
    React.SetStateAction<HTMLButtonElement | null>
  >;
}

interface SidebarChromeActions {
  navigation: NavigationActions;
  setFilterOpen: React.Dispatch<React.SetStateAction<boolean>>;
  onToggleWorkspaces: () => void;
}

interface SidebarChromeProps {
  state: SidebarChromeState;
  tools: SidebarChromeTools;
  identity: SidebarChromeIdentity;
  refs: SidebarChromeRefs;
  actions: SidebarChromeActions;
}

export function SidebarChrome({
  state: {
    density,
    connected,
    isPhone,
    borrowedLens,
    workspacesOpen,
    repoInline,
    filterOpen,
    newSessionKeys,
  },
  tools: {
    tools: visibleTools,
    menuTools: sidebarMenuTools,
    team,
    onSetToolVisible: setToolVisible,
  },
  identity: { filter, currentUser, personLensName, repos },
  refs: { headRef, titleRef, actionsRef, probeRef, setFilterButton },
  actions: { navigation, setFilterOpen, onToggleWorkspaces },
}: SidebarChromeProps) {
  return (
    <div
      // Desktop lifts this strip out of the scrollport, so it sets the rail's
      // own scales here rather than inheriting them from the scroll root. On
      // phones it is still the scroll's first child and reads the same values
      // twice, which costs nothing: they are one string either way.
      data-density={density}
      className={cn(
        "block max-w-full min-w-0 flex-none",
        SIDEBAR_DENSITY_VARS,
        SIDEBAR_NAV_X,
      )}
      style={{ order: 0 }}
    >
      {/* The tools carry no heading. "Tools" named a handful of self-evident
      destinations (Home, Reviews, Tasks) sitting at the very top of the
      rail, where nothing else can be confused for them, and it cost a
      caption plus the gap around it before the first thing you can
      click. Phones already listed them bare; desktop matches now.

      Its two jobs moved rather than went: the collapse is gone (it hid
      at most a few rows and a collapsed band left the top of the
      sidebar looking empty), and the ••• menu that chose which tools
      show is now in the right-click menu on any tool row, beside the
      "Remove from toolbar" that already lived there. Take the last
      tool off and the organization selector remains; the sidebar's own
      right-click menu still lists every tool. */}
      <SidebarToolsNav
        connected={connected}
        isPhone={isPhone}
        tools={visibleTools}
        menuTools={sidebarMenuTools}
        team={team}
        personLensValue={personLensValue(filter.person, currentUser)}
        personLensName={personLensName}
        onOpenSettings={navigation.openSettings}
        onSetToolVisible={setToolVisible}
        onSetSupportSurface={setSupportSurface}
        onPickPerson={(next) =>
          setFilter({ person: personLensFilter(next, currentUser) })
        }
      />

      <div
        className={cn(
          // SIDEBAR_STICKY_BAND_ROW folds this into one fixed slot, but it is
          // desktop-gated, so on phones the raw `mt-1 pt-3` stands. With the
          // caption hidden and the chevron invisible-but-in-layout, that was a
          // near-empty band between the tool cards and the first project, which
          // read as the strip being bottom-heavy. Nothing to set off there.
          "mt-1 pb-0.5 pt-3 phone:mt-0 phone:pt-0",
          // A borrowed lens hides the tools strip, so this bar becomes the
          // first thing in the phone scroll. Give it enough air to clear the
          // floating top bar's fade instead of letting its top edge wash out.
          borrowedLens && "phone:pt-4",
          // A caption starts on the rail's 16px text column; the borrowed
          // lens's strip is a filled bar, so it takes the rows' own 8px
          // inset instead and lines up with the workspace pills under it.
          borrowedLens ? "px-2" : "px-[16px] pr-[7px]",
          SIDEBAR_STICKY_BAND,
          SIDEBAR_STICKY_BAND_ROW,
          SIDEBAR_STUCK_BACKING,
        )}
        data-sticky-head
      >
        <div
          className={cn(
            "group/wshead flex min-w-0 items-center gap-1.5 desktop:w-full",
            // In someone else's sidebar this row IS the strip: one bar that
            // names whose lanes these are, takes you back out, and carries
            // the header's own actions. The name was being said twice —
            // once by a strip above the tools, once by this heading — and
            // each said it with its own ✕.
            borrowedLens &&
              "min-h-10 w-full rounded-row bg-blue-soft pl-3 pr-1 phone:min-h-12 phone:pl-3.5 desktop:h-full desktop:min-h-0",
          )}
          ref={headRef}
        >
          {borrowedLens ? (
            <>
              {/* The bar reports the active lens. Closing it is a separate
              action at the far edge, so the label stays visually stable and
              the close control gets a full touch target. */}
              <div
                className="flex min-w-0 flex-1 items-center gap-2 text-sm text-fg phone:text-base"
                ref={titleRef as React.RefObject<HTMLDivElement | null>}
              >
                {filter.person === "everyone" ? (
                  <IconPeople
                    size={20}
                    className="shrink-0 translate-y-[0.5px] text-dim phone:-translate-y-px"
                  />
                ) : (
                  filter.person !== "unassigned" && (
                    <UserAvatar
                      name={personLensName}
                      size={20}
                      className="shrink-0"
                    />
                  )
                )}
                <span className="min-w-0 truncate font-semibold">
                  {filter.person === "everyone"
                    ? "Everyone"
                    : filter.person === "unassigned"
                      ? "Unassigned"
                      : personLensName}
                </span>
              </div>
              <Tooltip label="Back to your workspaces">
                <button
                  className="relative flex size-10 shrink-0 items-center justify-center rounded-md border-0 bg-transparent text-dim transition-[color,scale] before:absolute before:inset-2 before:rounded-md before:transition-colors before:content-[''] hover:text-fg hover:before:bg-hover active:scale-[0.96] phone:size-11 motion-reduce:transform-none [&>*]:relative [&>*]:z-[1]"
                  onClick={() => setFilter({ person: "me" })}
                  aria-label="Back to your workspaces"
                >
                  <IconX size={18} aria-hidden="true" />
                </button>
              </Tooltip>
            </>
          ) : (
            <button
              className={cn(
                "group/wstoggle flex min-w-0 items-center gap-[5px] [font:inherit]",
                // On phones the caption is hidden and the chevron only paints on
                // hover, so while the band is open this button is a 22px row of
                // nothing between the tool cards and the first project. That row
                // is most of what made the strip read bottom-heavy, and an
                // invisible tap target is not an affordance worth its space.
                // Collapsed it stays: the chevron IS visible then
                // (SIDEBAR_BAND_CHEVRON_COLLAPSED), and it is the only way to
                // open the band back up.
                isPhone && workspacesOpen && "hidden",
              )}
              onClick={() => onToggleWorkspaces()}
              aria-expanded={workspacesOpen}
              title={
                workspacesOpen ? "Collapse workspaces" : "Expand workspaces"
              }
            >
              {/* The heading takes the same inset every other glyphless label
            does, so it starts on the column its repo tiles and lane
            captions do (see
            the band toggle). The sidebar header already reads as
            "Workspaces" on phones, so the in-header title is redundant
            there. */}
              <span
                className={cn(
                  // The band caption, same as SIDEBAR_BAND_LABEL wears one
                  // section down: this heading is written inline rather than
                  // composed from it only because of the strip above.
                  "shrink-0 text-label font-semibold text-dim group-hover/wshead:text-fg",
                  isPhone && "hidden",
                )}
                ref={titleRef as React.RefObject<HTMLSpanElement | null>}
              >
                Workspaces
              </span>
              <IconChevronDown
                className={cn(
                  SIDEBAR_BAND_CHEVRON,
                  "group-hover/wstoggle:visible",
                  !workspacesOpen && SIDEBAR_BAND_CHEVRON_COLLAPSED,
                )}
                size={18}
                style={{
                  transform: workspacesOpen ? "none" : "rotate(-90deg)",
                }}
              />
            </button>
          )}
          {/* Repo filter chip, inline behind the title when it fits. */}
          {filter.repo !== "all" && repoInline && (
            <RepoFilterChip
              repo={filter.repo}
              repos={repos}
              onClear={() => setFilter({ repo: "all" })}
              onSelect={(v) => setFilter({ repo: v })}
              variant="inline"
            />
          )}
          {/* The active lens label already grows to push its close control to
          this edge. Your own sidebar still needs the flexible spacer. */}
          {!borrowedLens && <div className="min-w-0 flex-1" />}
          {/* Grouped so the pair's combined width can be measured when deciding
          whether the repo chip fits inline. Gone on phones, where filter
          moves to the top bar and the red FAB covers new-session. Gone in a
          borrowed lens too: both act on YOUR sidebar, so grouping or
          starting a session from inside someone else's bar is either a
          no-op you can't see or work filed somewhere you didn't mean. The
          bar keeps the one action that belongs to it, which is leaving. */}
          <div
            className={cn(
              "shrink-0 items-center gap-1.5",
              isPhone || borrowedLens ? "hidden" : "flex",
            )}
            ref={actionsRef}
          >
            <Tooltip label="Group, filter & sort">
              <button
                ref={setFilterButton}
                className={cn(
                  SIDEBAR_HEADER_BTN,
                  isPhone
                    ? cn(SIDEBAR_HEADER_BTN_PHONE, "min-h-[38px] min-w-[38px]")
                    : SIDEBAR_HEADER_BTN_DESKTOP,
                  "inline-flex items-center justify-center",
                  // The open state paints the stronger wash and the hover now
                  // layers OVER it (SIDEBAR_HOVER_LAYER), so the button no
                  // longer has to withhold its hover to keep from washing
                  // itself back out while open.
                  SIDEBAR_HOVER_LAYER,
                  filterOpen && "border-line-strong bg-pressed",
                  // A set filter is already spelled out in the header (the repo
                  // chip) and in the popover itself, so the button stays a plain
                  // glyph: full contrast under the pointer or while open.
                  filterOpen ? "text-fg" : "text-dim hover:text-fg",
                )}
                // A Base UI tooltip is a DESCRIPTION, not a name, so an
                // icon-only trigger still needs one of its own. The phone twin
                // below always carried this; the desktop button did not.
                aria-label="Group, filter & sort"
                onClick={() => setFilterOpen((o) => !o)}
              >
                {/* 22, the scale's standalone step: these are section-header
              actions, not the primary buttons or window chrome that take
              24. At 24 the plus drew a 16px span against the 15.5 of the
              search glyph in the titlebar row right above, and the filter
              is filled bars, so the pair read a step larger than the row
              they sit under. */}
                <IconFilter size={22} />
              </button>
            </Tooltip>
            {/* ⌘S, not the ⌘⌥N this used to advertise: that chord opens a
            sibling session inside the workspace you have open, while
            this button (onNewSession → the palette) starts one in a new
            workspace. */}
            <Tooltip label="New session" shortcut={newSessionKeys ?? undefined}>
              <button
                className={cn(
                  SIDEBAR_HEADER_BTN,
                  isPhone
                    ? SIDEBAR_HEADER_BTN_PHONE
                    : SIDEBAR_HEADER_BTN_DESKTOP,
                  "inline-flex items-center justify-center text-dim hover:bg-hover hover:text-fg",
                )}
                onClick={navigation.openNewWorkspace}
              >
                <IconPlus size={22} />
              </button>
            </Tooltip>
          </div>
          {/* Off-layout probe: measures the chip's natural width so the effect
          above can decide whether it fits inline (never rendered visibly). */}
          {filter.repo !== "all" && (
            <RepoFilterChip repo={filter.repo} variant="probe" ref={probeRef} />
          )}
        </div>
      </div>
    </div>
  );
}
