import { mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import React from "react";
import type { UnifiedSession } from "../lib/types";
import { PRODUCT_NAME } from "../lib/brand";
import { usePeople, type Person } from "../lib/people";
import { cn } from "../ui/cn";
import { Menu } from "../ui/menu";
import { IconChevronDown } from "./icons";
import { UserAvatar } from "./UserAvatar";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  absolute: {
    position: "absolute",
  },
  bottom0: {
    bottom: "0",
  },
  right0: {
    right: "0",
  },
  roundedFull: {
    borderRadius: "calc(infinity * 1px)",
    cornerShape: "round",
  },
  relative: {
    position: "relative",
  },
  flex: {
    display: "flex",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  max860pxHidden: {
    "@media (max-width: 859px)": {
      display: "none",
    },
  },
  shrink0: {
    flexShrink: "0",
  },
  opacity55: {
    opacity: "55%",
  },
  minW210px: {
    minWidth: "210px",
  },
  gap9px: {
    gap: "9px",
  },
  roundedSm: {
    borderRadius: "calc(4px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  px2: {
    paddingInline: "calc(4px * 2)",
  },
  py15: {
    paddingBlock: "calc(4px * 1.5)",
  },
  minW0: {
    minWidth: "0",
  },
  flex1: {
    flex: "1",
  },
  size22px: {
    width: "22px",
    height: "22px",
  },
});

/**
 * The team, as a face row. One derivation (`useTeamPresence`) feeds every
 * place the pile appears: the sidebar's People entry, the People page, and the
 * pull request list's header. In all of them it opens the same thing, the
 * app's person lens (`TeamLensMenu`), so you can pick up someone else's
 * sidebar from wherever you noticed them.
 *
 * Your own face isn't in it — the pile answers "who else is around", and the
 * menu behind it is where you appear, as the lens you switch back to.
 *
 * The pile shows every face normally. Live presence still helps order the team
 * and describe people inside the menu, but the always-visible chrome does not
 * dim people or badge them with status dots.
 *
 * The pile itself is never a set of buttons. Faces are a glance; switching
 * whose work you're looking at is a menu behind them, which is one deliberate
 * step rather than a hair-trigger — you shouldn't be able to flick between
 * teammates without meaning to.
 */

export interface TeamMember {
  /** Lowercased first name — the key every person filter in the app uses. */
  key: string;
  person: Person;
  /** Has Open Session open right now (global presence). */
  online: boolean;
  /** One of their sessions has a turn in flight. */
  working: boolean;
  /** True for the signed-in person. */
  isYou: boolean;
  /**
   * What answers "what are they on": the running session, else the one they're
   * looking at, else their most recent.
   */
  session?: UnifiedSession;
  /** Their wall clock, when the directory knows their timezone. */
  localTime?: string;
}

export type PresenceState = "working" | "online" | "away";

export function presenceState(m: TeamMember): PresenceState {
  return m.working ? "working" : m.online ? "online" : "away";
}

/** First token, lowercased — the shape of picker names, `startedBy` and
 *  presence viewers alike (chat integrations send full names). */
function firstName(name?: string | null): string {
  return (name || "").trim().split(/\s+/)[0]?.toLowerCase() || "";
}

/** What a row says the person is doing. */
export function presenceLabel(m: TeamMember): string {
  const title = m.session?.title?.trim();
  if (m.working) return title ? `Working on ${title}` : "Working";
  if (m.online) return title ? `Viewing ${title}` : `In ${PRODUCT_NAME}`;
  if (title) return `Last: ${title}`;
  return m.localTime ? `${m.localTime} their time` : "Away";
}

export function useTeamPresence({
  sessions,
  teamViewing,
  currentUser,
}: {
  sessions: UnifiedSession[];
  teamViewing?: Array<{ user: string; sessionId: string }>;
  currentUser?: string;
}): TeamMember[] {
  const roster = usePeople();

  // Who's looking at what right now (global presence), by first name.
  const viewingBy = new Map<string, string>();
  for (const v of teamViewing || [])
    viewingBy.set(firstName(v.user), v.sessionId);

  // Per person: the newest session, and any session of theirs with a run in flight.
  // Automations and sub-agent sessions are machine work, not "what Kent is on".
  const latest = new Map<string, UnifiedSession>();
  const runningBy = new Map<string, UnifiedSession>();
  const byId = new Map<string, UnifiedSession>();
  for (const s of sessions) {
    byId.set(s.id, s);
    if (s.archived || s.automation) continue;
    const key = firstName(s.startedBy);
    if (!key) continue;
    const prev = latest.get(key);
    if (!prev || (s.lastActivity || "") > (prev.lastActivity || ""))
      latest.set(key, s);
    if (s.isRunning) {
      const run = runningBy.get(key);
      if (!run || (s.lastActivity || "") > (run.lastActivity || ""))
        runningBy.set(key, s);
    }
  }

  const me = firstName(currentUser);
  const members = roster.map((person): TeamMember => {
    const key = person.name.toLowerCase();
    const liveId = viewingBy.get(key);
    const running = runningBy.get(key);
    const live = liveId ? byId.get(liveId) : undefined;
    return {
      key,
      person,
      online: !!liveId,
      working: !!running,
      isYou: key === me,
      session: running || live || latest.get(key),
      localTime: person.timezone
        ? new Intl.DateTimeFormat([], {
            hour: "2-digit",
            minute: "2-digit",
            timeZone: person.timezone,
          }).format(new Date())
        : undefined,
    };
  });

  // Working first, then online, then whoever moved most recently. You sort
  // last within your own bucket, so any pile that does render your face (a
  // team of one) keeps it out of the team's way.
  const rank = (m: TeamMember) => (m.working ? 0 : m.online ? 1 : 2);
  return members.sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (a.isYou !== b.isYou) return a.isYou ? 1 : -1;
    return (b.session?.lastActivity || "").localeCompare(
      a.session?.lastActivity || "",
    );
  });
}

/**
 * The dot sits inside the face's own box (bottom-right corner), ringed in the
 * surface under it so it separates from the picture. It doesn't pulse: this
 * sits in a page header all day, and a blinking light is a summons.
 */
export function StatusDot({
  state,
  ring,
  size = 7,
}: {
  state: PresenceState;
  ring: string;
  /** Scale the dot to the face it sits on. */
  size?: number;
}) {
  if (state === "away") return null;
  return (
    <span
      {...stylex.props(sx.absolute, sx.bottom0, sx.right0, sx.roundedFull)}
      style={{ width: size, height: size, boxShadow: `0 0 0 1.5px ${ring}` }}
      aria-hidden="true"
    >
      <span
        className={cn(
          utilityClassName("block size-full rounded-full"),
          state === "working"
            ? utilityClassName("bg-green")
            : utilityClassName("border border-green"),
        )}
        style={state === "working" ? undefined : { background: ring }}
      />
    </span>
  );
}

/** The "+N" tail of a capped pile, in both its readings (plain count, menu). */
const OVERFLOW_COUNT = utilityClassName(
  "ml-1.5 flex items-center text-meta font-semibold tabular-nums",
);

/** A face. `status` adds the dim/dot presence reading; the accessible name
 *  says the same thing in words, so the colour isn't carrying it alone. */
function Face({
  member,
  size,
  status,
  selected,
  ring,
}: {
  member: TeamMember;
  size: number;
  status?: boolean;
  selected?: boolean;
  /** Colour of the gap a piled face cuts into the one behind it. */
  ring?: string;
}) {
  const dotRing = ring || "var(--bg-panel)";
  const state = presenceState(member);
  return (
    // `flex`, not `inline-flex`: an inline box sits on its parent's baseline
    // and carries the descender space below it, which makes the face ride
    // high against anything centred beside it (the pile's "+N").
    <span {...stylex.props(sx.relative, sx.flex)}>
      <UserAvatar
        name={member.person.name}
        size={size}
        className={cn(
          status &&
            state === "away" &&
            utilityClassName("opacity-45 grayscale"),
        )}
        style={{
          // The ring paints the row's own colour just outside the picture,
          // so the face in front cuts a clean gap into the one behind it
          // instead of the two running together. It layers on top of the
          // avatar's own hairline (--avatar-edge) rather than replacing it:
          // without that edge a light photo dissolves into a light gap.
          ...(ring
            ? { boxShadow: `var(--avatar-edge), 0 0 0 2px ${ring}` }
            : null),
          // An outline follows the squircle radius and paints outside the
          // box, so the picked face reads as ringed rather than boxed.
          ...(selected
            ? { outline: "2px solid var(--accent)", outlineOffset: "1px" }
            : null),
        }}
      />
      {status && <StatusDot state={state} ring={dotRing} />}
    </span>
  );
}

/**
 * Overlapping face row. Always decoration — no face is a control, so the pile
 * is safe to nest inside a trigger (which is how the lens menu uses it).
 */
export function TeamFacepile({
  members,
  size = 22,
  max = 6,
  ring = "var(--bg)",
  status,
  selectedKey,
  className,
}: {
  members: TeamMember[];
  size?: number;
  max?: number;
  /** What the pile is painted on: each face rings itself in it to separate. */
  ring?: string;
  /** Dim the away faces and dot the present ones. */
  status?: boolean;
  /** Ring the face whose work the app is currently showing. */
  selectedKey?: string | null;
  className?: string;
}) {
  // A selected face must stay in the pile even when it would fall off the end.
  const shown = members.slice(0, max);
  if (selectedKey && !shown.some((m) => m.key === selectedKey)) {
    const picked = members.find((m) => m.key === selectedKey);
    if (picked) shown.splice(max - 1, 1, picked);
  }
  // Whoever didn't make the cut — computed by identity, not by index, because
  // a selected face may have been swapped into the last visible slot.
  const rest = members.filter((m) => !shown.some((s) => s.key === m.key));
  // A shoulder's worth of overlap: enough to read as one group, shallow
  // enough that every face stays a face rather than a sliver. Two of those
  // pixels go to the ring, so the tuck reads as a gap, not a collision.
  const overlap = Math.round(size * 0.26);
  const selectedIndex = selectedKey
    ? shown.findIndex((m) => m.key === selectedKey)
    : -1;
  const selectedTuck = Math.max(2, Math.round(size * 0.08));
  return (
    <div className={cn(utilityClassName("flex items-center"), className)}>
      {shown.map((m, i) => {
        const selected = !!selectedKey && m.key === selectedKey;
        const label = status
          ? `${m.person.fullName} · ${presenceLabel(m)}`
          : m.person.fullName;
        const besideSelected = i === selectedIndex || i === selectedIndex + 1;
        const style: React.CSSProperties = {
          // Tighten both gaps around the picked face. Its higher z-index keeps
          // the larger face and accent ring above the neighbours tucked behind it.
          marginLeft:
            i === 0 ? 0 : -(overlap + (besideSelected ? selectedTuck : 0)),
          // The pile runs front-to-back, left to right: each face tucks
          // behind the one before it, so nothing later covers what's read
          // first. The picked face clears them all.
          zIndex: selected ? shown.length + 1 : shown.length - i,
        };
        return (
          <span
            key={m.key}
            {...stylex.props(sx.relative)}
            style={style}
            title={label}
          >
            <Face
              member={m}
              size={size}
              ring={ring}
              status={status}
              selected={selected}
            />
          </span>
        );
      })}
      {rest.length > 0 && (
        // The rest of the team is a count, not another face: no tile, no
        // border, just the number sitting on the row's centre line. It
        // doesn't need to be reachable — the menu this pile opens lists
        // everyone, capped or not.
        <span
          className={OVERFLOW_COUNT}
          style={{ height: size }}
          title={rest.map((m) => m.person.fullName).join(", ")}
        >
          +{rest.length}
        </span>
      )}
    </div>
  );
}

/**
 * The person lens: the pile, as one control that opens the whole team.
 *
 * A face is a glance, not a button — you switch whose work the app is showing
 * by opening this and picking a name, which is a step you have to mean. The
 * menu also has room for everyone regardless of how many faces the pile fits,
 * so nobody is stranded behind the cap on a narrow window.
 */
export function TeamLensMenu({
  members,
  value,
  label,
  onPick,
  size,
  max,
  ring,
  compact,
  side,
  align = "end",
  className,
}: {
  members: TeamMember[];
  /** The lens: a person key, or "everyone" / "unassigned". */
  value: string;
  /** That lens in words — the trigger says it, so the ring isn't alone. */
  label: string;
  onPick: (value: string) => void;
  size?: number;
  max?: number;
  ring?: string;
  /** Faces only: for the sidebar's People row, where the words don't fit. The
   *  accessible name still carries the lens. */
  compact?: boolean;
  side?: React.ComponentProps<typeof Menu.Popup>["side"];
  align?: React.ComponentProps<typeof Menu.Popup>["align"];
  className?: string;
}) {
  // You first — it's the lens you return to — then the team in presence
  // order. The pile behind the trigger keeps its own order, where whoever is
  // working leads.
  const rows = [...members].sort((a, b) => Number(b.isYou) - Number(a.isYou));
  // The pile is everyone else. Your own presence is the one thing you never
  // need reporting back to you, and the slot it takes is a teammate the cap
  // would otherwise have shown. You stay in the menu, named "(you)" — except
  // on a team of one, where dropping the only face would leave the compact
  // trigger with nothing to be.
  const faces = members.some((m) => !m.isYou)
    ? members.filter((m) => !m.isYou)
    : members;
  return (
    <Menu.Root>
      <Menu.Trigger
        className={cn(
          utilityClassName(
            "flex min-w-0 items-center border-0 bg-transparent text-control-label text-dim",
          ),
          compact
            ? utilityClassName(
                "gap-0 rounded-[999px] py-0.5 pr-1 pl-0.5 hover:[--team-face-ring:var(--row-chip-hover)] hover:bg-[var(--team-face-ring)] hover:text-fg data-[popup-open]:[--team-face-ring:var(--row-chip-hover)] data-[popup-open]:bg-[var(--team-face-ring)] data-[popup-open]:text-fg",
              )
            : utilityClassName(
                "gap-2.5 rounded-control p-1 hover:bg-hover hover:text-fg data-[popup-open]:bg-hover data-[popup-open]:text-fg",
              ),
          className,
        )}
        aria-label={`Whose work this shows: ${label}`}
      >
        <TeamFacepile
          members={faces}
          size={size}
          max={max}
          ring={ring}
          // Compact sits in a 20px sidebar row, where an accent ring on one
          // face reads as a black box rather than a selection — and the
          // header right below it already names the lens in words.
          selectedKey={
            !compact && faces.some((m) => m.key === value) ? value : null
          }
        />
        {!compact && (
          <>
            <span {...stylex.props(sx.truncate, sx.max860pxHidden)}>
              {label}
            </span>
            {/* The Button primitive's `caret` step (ui/button.tsx): this
						    trigger is a facepile, so it can't be a Button, but the
						    affordance has to read the same as every other menu. */}
            <IconChevronDown
              className={mergeStylexOverrideClassName(
                "",
                sx.shrink0,
                sx.opacity55,
              )}
              size={16}
            />
          </>
        )}
      </Menu.Trigger>
      <Menu.Popup
        side={side}
        align={align}
        className={mergeStylexOverrideClassName("", sx.minW210px)}
      >
        {/* Says what the menu changes: these are lanes and rows to read, not
				    people to open. The label has to sit inside a Group — Base UI
				    wires it to the group it names. */}
        <Menu.Group>
          <Menu.GroupLabel>Whose workspaces</Menu.GroupLabel>
          <Menu.RadioGroup
            value={value}
            onValueChange={(next) => onPick(String(next))}
          >
            {rows.map((m) => (
              <Menu.RadioItem
                key={m.key}
                value={m.key}
                closeOnClick
                className={mergeStylexOverrideClassName(
                  "",
                  sx.gap9px,
                  sx.roundedSm,
                  sx.px2,
                  sx.py15,
                )}
              >
                <Face member={m} size={22} status ring="var(--bg-panel)" />
                <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>
                  {m.isYou ? `${m.person.fullName} (you)` : m.person.fullName}
                </span>
                <Menu.Check on={m.key === value} />
              </Menu.RadioItem>
            ))}
            <Menu.Separator />
            <Menu.RadioItem
              value="everyone"
              closeOnClick
              className={mergeStylexOverrideClassName(
                "",
                sx.gap9px,
                sx.roundedSm,
                sx.px2,
                sx.py15,
              )}
            >
              {/* Sized to the faces above so every label shares one edge. */}
              <span {...stylex.props(sx.size22px, sx.shrink0)} />
              {/* Not a person: it drops the filter entirely. Named for what
						    you get, in the same words the sidebar header uses for it. */}
              <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>
                All workspaces
              </span>
              <Menu.Check on={value === "everyone"} />
            </Menu.RadioItem>
          </Menu.RadioGroup>
        </Menu.Group>
      </Menu.Popup>
    </Menu.Root>
  );
}
