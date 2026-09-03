import type { FilterState } from "../../lib/sidebar-filter";
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
import { useIsPhone } from "../../hooks/useIsPhone";
import { Menu } from "../../ui/menu";
import {
  SETTING_GLYPH,
  SETTING_ROW,
  SETTING_ROW_PRESSABLE,
} from "../../lib/setting-row-classes";
import {
  type SettingOption,
  ValueOptions,
  ValueRow,
} from "../../ui/setting-row";
import { SwitchIndicator } from "../../ui/switch";
import { cn } from "../../ui/cn";
import { RepoTile, repoLabel } from "../RepoTile";
import { IconChevronRight, IconRepo } from "../icons";
import {
  GROUP_BY_OPTIONS,
  LAST_USED_TIME_OPTIONS,
  personFilterOptions,
  PR_FILTER_OPTIONS,
  repoFilterOptions,
} from "./filter-options";
import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";

// ── Filter popover ─────────────────────────────────────────────────────────
// A small floating panel (anchored under the filter button) holding the view
// controls for the session list: how it is grouped, which repo and person it
// is scoped to, what it hides, how it is sorted, and how tight its rows are.
// Rendered in a portal so it can overflow the narrow sidebar.

/** Full-screen transparent catcher that closes the popover on outside click.
 *  The row menus portal above it (Base UI positions them at z-10001), so a
 *  press inside an open menu never reaches this. */
const BACKDROP = "fixed inset-0 z-[300]";

/** The panel itself, portalled and fixed-positioned at the anchor: the app's
 *  popup surface, so it reads as the same object as every menu it opens.
 *
 *  Padding is 8px, keeping the rows inside close to the panel edge without
 *  crowding its `rounded-popup` corners. `gap-0.5` keeps two adjacent hover
 *  washes from fusing into one block. */
const FILTER_POPOVER =
  "fixed z-[301] flex flex-col gap-0.5 rounded-popup bg-popup-glass [backdrop-filter:var(--popup-blur)] [--smooth-ring-color:var(--popup-ring)] " +
  "p-2 smooth-shadow-ring-md animate-[hovercard-in_var(--dur-micro)_var(--ease)]";

/** The same control as a row inside the Advanced menu: label, current value,
 *  and its options one level in. Reads as a menu row rather than a panel row,
 *  because that is where it now lives. */
function FilterSubmenu<Value extends string>({
  label,
  value,
  options,
  onSelect,
}: {
  label: string;
  value: Value;
  options: Array<SettingOption & { value: Value }>;
  onSelect: (value: Value) => void;
}) {
  const current = options.find((option) => option.value === value);
  return (
    <Menu.SubmenuRoot>
      <Menu.SubmenuTrigger className="justify-between gap-3">
        <span className="truncate">{label}</span>
        <span className="flex flex-none items-center gap-2 text-dim">
          {current?.icon && (
            <span className={SETTING_GLYPH}>{current.icon}</span>
          )}
          <span className="truncate">{current?.label ?? value}</span>
          <IconChevronRight className="shrink-0 text-faint" size={17} />
        </span>
      </Menu.SubmenuTrigger>
      <Menu.Popup>
        <ValueOptions
          value={value}
          options={options}
          onSelect={(selected) => {
            const option = options.find(({ value }) => value === selected);
            if (option) onSelect(option.value);
          }}
        />
      </Menu.Popup>
    </Menu.SubmenuRoot>
  );
}

export function FilterPopover({
  anchor,
  filter,
  repos,
  people,
  currentUser,
  onChange,
  onClose,
}: {
  anchor: HTMLElement | null;
  filter: FilterState;
  repos: string[];
  people: Array<{ key: string; label: string }>;
  currentUser: string;
  onChange: (patch: Partial<FilterState>) => void;
  onClose: () => void;
  onCustomize: () => void;
}) {
  // Density and last used time belong to this list, but they are stored display
  // preferences rather than part of FilterState. Keep them live here so the
  // menu always reflects changes from another tab.
  // All hooks run before the `anchor` early return: an unmounted anchor must
  // not change how many hooks this component calls.
  const isPhone = useIsPhone();
  const [density, setDensity] = useState<SidebarDensity>(getSidebarDensity);
  useEffect(
    () => onSidebarDensityChanged(() => setDensity(getSidebarDensity())),
    [],
  );
  const [wsTime, setWsTime] = useState<WsTimePref>(getWsTimePref);
  useEffect(() => onWsTimeChanged(() => setWsTime(getWsTimePref())), []);

  if (!anchor) return null;
  const r = anchor.getBoundingClientRect();
  const width = 290;
  const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
  const top = r.bottom + 6;

  const repoOptions = repoFilterOptions(repos.map((id) => ({ id })));
  const personOptions = personFilterOptions({ people, currentUser });

  // How much of what is now out of sight is doing something. Only the three
  // that change which rows the list holds count: density and time are looks,
  // and sort is an order. Empty projects counts here even though the Repo
  // picker is its other door, because this is the number that explains a short
  // list.
  const advancedChanged =
    (filter.prs === "none" ? 0 : 1) +
    (filter.autoCreated === "hide" ? 0 : 1) +
    (filter.emptyProjects === "show" ? 0 : 1);

  return createPortal(
    <>
      <div className={BACKDROP} onClick={onClose} />
      <div className={FILTER_POPOVER} style={{ left, top, width }}>
        {/* The section mode and project nesting are independent answers. */}
        <ValueRow
          label="Group by"
          value={filter.groupBy}
          options={GROUP_BY_OPTIONS}
          onSelect={(selected) => {
            const option = GROUP_BY_OPTIONS.find(
              ({ value }) => value === selected,
            );
            if (option) onChange({ groupBy: option.value });
          }}
        />
        <button
          type="button"
          className={cn(SETTING_ROW, SETTING_ROW_PRESSABLE)}
          onClick={() => onChange({ byProject: !filter.byProject })}
        >
          <span className="shrink-0 text-dim">Group by project</span>
          <span className="ml-auto">
            <SwitchIndicator on={filter.byProject} />
          </span>
        </button>
        {/* The projects, and under them the one setting about the set of
				    them rather than about which one you are in. It is in two
				    places on purpose: here, under the list of projects it is
				    about, and in Advanced with the other things that decide what
				    the list holds. Whichever you open, it reads and writes the
				    same setting. */}
        <ValueRow
          label="Repo"
          value={filter.repo}
          options={repoOptions}
          onSelect={(v) => onChange({ repo: v })}
          footer={
            <Menu.CheckboxItem
              checked={filter.emptyProjects === "hide"}
              onCheckedChange={(hide) =>
                onChange({ emptyProjects: hide ? "hide" : "show" })
              }
            >
              <span className="grow truncate">Hide when empty</span>
              <SwitchIndicator on={filter.emptyProjects === "hide"} />
            </Menu.CheckboxItem>
          }
        />
        <ValueRow
          label="Person"
          value={filter.person}
          options={personOptions}
          onSelect={(v) => onChange({ person: v })}
        />
        {/* The settings you set once and forget, one level in: what the
				    list is made of and who it is for stays on the panel, and the
				    rest is here.

				    It says how many of them are off their default, because a
				    setting that hides rows is exactly the one you want to find
				    again when the list looks short, and a closed menu cannot
				    show you that it is the reason. Sort, density, and time change
				    how the list reads rather than what is in it, so they are not
				    part of that count. */}
        <Menu.Root>
          <Menu.Trigger
            className={cn(SETTING_ROW, SETTING_ROW_PRESSABLE, "mt-1")}
          >
            <span className="shrink-0 text-dim">Advanced</span>
            <span className="ml-auto flex min-w-0 items-center gap-2 text-fg">
              {advancedChanged > 0 && (
                <span className="truncate text-dim">
                  {advancedChanged} changed
                </span>
              )}
              <IconChevronRight
                size={16}
                className="-mr-0.5 shrink-0 text-faint"
              />
            </span>
          </Menu.Trigger>
          <Menu.Popup
            align="end"
            sideOffset={6}
            alignOffset={isPhone ? -6 : -30}
            className="[&>div]:p-2"
          >
            {/* Inbox has stable creation order and Activity owns recency.
						    Status is the one layout where choosing lane order still makes
						    sense, so only it offers this override. */}
            {filter.groupBy === "status" && (
              <FilterSubmenu
                label="Sort by"
                value={filter.sort}
                options={[
                  { value: "updated", label: "Updated" },
                  { value: "created", label: "Created" },
                ]}
                onSelect={(sort) => onChange({ sort })}
              />
            )}
            {/* Session-less PR rows in the project sections (the dissolved
						    PR band): whose PRs surface. */}
            <FilterSubmenu
              label="Pull requests"
              value={filter.prs}
              options={PR_FILTER_OPTIONS}
              onSelect={(prs) => onChange({ prs })}
            />
            {/* Workspaces an agent started for itself. They sit in the
						    ordinary sections wearing a robot, so this is how you get a
						    day's worth of them out of the way. A row you have open,
						    one you pinned, and one asking for your review stay
						    whatever this says.

						    A setting with only an on and an off is a row you flip, not
						    a question with a submenu behind it: "Shown" and "Hidden"
						    one level further in is a menu to read and two presses to
						    answer what one press answers here. It wears a switch
						    rather than a tick because it is a setting, not one option
						    picked out of a list: a switch says on and off in its
						    shape, where a tick can only say "this one" by being
						    there and "not this one" by being absent. Named for what
						    turning it on does, and it stays open on a press, the way
						    every checkable menu row in the app does. */}
            <Menu.CheckboxItem
              checked={filter.autoCreated === "show"}
              onCheckedChange={(shown) =>
                onChange({ autoCreated: shown ? "show" : "hide" })
              }
            >
              <span className="grow truncate">Show auto created</span>
              <SwitchIndicator on={filter.autoCreated === "show"} />
            </Menu.CheckboxItem>
            {/* A registered project with no work in it still draws a band,
						    so a repo you just connected has somewhere to start from,
						    and on an instance with more projects than you work in that
						    is a screen of empty headings. Scoping the list to one
						    project shows that project either way, empty or not.

						    Its other door is the Repo picker, under the projects it is
						    about. Here it sits with the rest of what decides which rows
						    the list holds, and counts towards the "N changed" above. */}
            <Menu.CheckboxItem
              checked={filter.emptyProjects === "hide"}
              onCheckedChange={(hide) =>
                onChange({ emptyProjects: hide ? "hide" : "show" })
              }
            >
              <span className="grow truncate">Hide empty projects</span>
              <SwitchIndicator on={filter.emptyProjects === "hide"} />
            </Menu.CheckboxItem>
            {/* Display preferences stay beside the filters they affect and also
						    remain available in Settings. Density is desktop only here because
						    phone rows keep their touch padding at either value. */}
            <Menu.Separator />
            {!isPhone && (
              <FilterSubmenu
                label="Density"
                value={density}
                options={DENSITY_OPTIONS.map(({ value, label, Icon }) => ({
                  value,
                  label,
                  icon: <Icon size={16} />,
                }))}
                onSelect={setSidebarDensity}
              />
            )}
            <FilterSubmenu
              label="Last used time"
              value={wsTime}
              options={LAST_USED_TIME_OPTIONS}
              onSelect={setWsTimePref}
            />
          </Menu.Popup>
        </Menu.Root>
      </div>
    </>,
    document.body,
  );
}

// The removable "active repo filter" chip. Rendered in three variants:
// "inline" (in the header, behind the title), "row" (its own line under the
// header) and "probe" (an off-layout copy used only to measure natural width —
// non-interactive and hidden from a11y).
export const RepoFilterChip = React.forwardRef<
  HTMLSpanElement,
  {
    repo: string;
    repos?: string[];
    onClear?: () => void;
    onSelect?: (repo: string) => void;
    variant: "inline" | "row" | "probe";
  }
>(function RepoFilterChip(
  { repo, repos = [], onClear, onSelect, variant },
  ref,
) {
  const probe = variant === "probe";

  // One step down from the tile's 18px default, so the pill stays the height
  // of the text beside it.
  const body = (
    <>
      <RepoTile name={repo} size={17} />
      <span className="min-w-0 truncate text-dim">{repoLabel(repo)}</span>
    </>
  );
  const bodyClass =
    "inline-flex min-w-0 items-center gap-[7px] rounded-full px-[3px] py-0.5 text-label leading-[1.15] hover:bg-hover data-[popup-open]:bg-hover";

  return (
    <span
      ref={ref}
      className={cn(
        "inline-flex min-w-0 max-w-full items-center gap-px rounded-full border border-line bg-panel px-1 py-[3px] text-label leading-[1.15]",
        variant === "inline" && "shrink-0 max-w-none",
        variant === "probe" &&
          "pointer-events-none absolute left-[-9999px] top-0 max-w-none invisible",
      )}
      aria-hidden={probe || undefined}
    >
      {/* Body opens the repo menu; the × clears the filter. The probe is
			    measured, never pressed, so it renders the same box without one. */}
      {probe ? (
        <span className={bodyClass}>{body}</span>
      ) : (
        <Menu.Root>
          <Menu.Trigger className={bodyClass} title="Switch repo">
            {body}
          </Menu.Trigger>
          <Menu.Popup align="start" sideOffset={5}>
            <Menu.RadioGroup
              value={repo}
              onValueChange={(next) => onSelect?.(String(next))}
            >
              <Menu.RadioItem
                value="all"
                closeOnClick
                className="justify-between gap-3"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className={SETTING_GLYPH}>
                    <IconRepo size={16} />
                  </span>
                  <span className="min-w-0 truncate">All repos</span>
                </span>
                <Menu.Check on={repo === "all"} />
              </Menu.RadioItem>
              {repos.map((name) => (
                <Menu.RadioItem
                  key={name}
                  value={name}
                  closeOnClick
                  className="justify-between gap-3"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className={SETTING_GLYPH}>
                      <RepoTile name={name} size={16} />
                    </span>
                    <span className="min-w-0 truncate">{repoLabel(name)}</span>
                  </span>
                  <Menu.Check on={name === repo} />
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Root>
      )}
      <button
        type="button"
        className="inline-flex size-[19px] shrink-0 items-center justify-center rounded-full text-item-title leading-none text-faint hover:bg-hover hover:text-fg"
        title="Clear repo filter"
        tabIndex={probe ? -1 : undefined}
        onClick={probe ? undefined : onClear}
      >
        ×
      </button>
    </span>
  );
});
