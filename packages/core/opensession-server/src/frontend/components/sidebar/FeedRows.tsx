import { mergeStylexProps, mergeStylexOverrideClassName } from "../../ui/cn";
import { utilityClassName } from "../../ui/cn";
import { useIsPhone } from "../../hooks/useIsPhone";
import { fetchFeedFilterOptions, relativeTime } from "../../lib/api";
import {
  SIDEBAR_BAND_ACTION,
  SIDEBAR_FILTER_DOT,
  SIDEBAR_HOVER_LAYER,
  SIDEBAR_RAIL,
  SIDEBAR_WS_ACTION,
  SIDEBAR_WS_ACTIONS,
  SIDEBAR_WS_ACTIONS_HOVER,
  SIDEBAR_WS_ROW,
  SIDEBAR_WS_TIME,
  SIDEBAR_WS_TIME_HOVER,
} from "../../lib/sidebar-classes";
import { laneCtxEntries, useRowCtxMenu } from "../../lib/sidebar-ctx";
import {
  SUPPORT_PRIORITY_DOT,
  dget,
  type FeedFilterValues,
} from "../../lib/sidebar-filter";
import { mineStatus } from "../../lib/sidebar-lanes";
import {
  MINE_STATUS_META,
  type Group,
  type LaneChoice,
} from "../../lib/sidebar-types";
import { shortTime } from "../../lib/time";
import type {
  FeedDescriptor,
  FeedFilterSpec,
  FeedItem,
  SupportThread,
  UnifiedSession,
} from "../../lib/types";
import { cn } from "../../ui/cn";
import { Menu } from "../../ui/menu";
import { Popover } from "../../ui/popover";
import { Tooltip } from "../../ui/tooltip";
import {
  CardFooter,
  RowCardPopup,
  SupportRowCard,
  useRowHoverCard,
} from "../SidebarRowCards";
import { IconCheck, IconFilter, IconPin } from "../icons";
import { SidebarCtxMenu } from "../sidebar/SidebarCtxMenu";
import { SIDEBAR_ROW, SIDEBAR_ROW_TITLE } from "../sidebar/SidebarItem";
import React, { useEffect, useEffectEvent, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  size7px: {
    width: "7px",
    height: "7px",
  },
  roundedFull: {
    borderRadius: "calc(infinity * 1px)",
    cornerShape: "round",
  },
  mt5px: {
    marginTop: "5px",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  leading13: {
    lineHeight: "1.3",
  },
  mt1: {
    marginTop: "4px",
  },
  lineClamp4: {
    overflow: "hidden",
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: "4",
  },
  textXs: {
    fontSize: "var(--type-label)",
    lineHeight: "var(--tw-leading, var(--text-xs--line-height))",
  },
  leadingSnug: {
    lineHeight: "var(--leading-snug)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  shrink0: {
    flexShrink: "0",
  },
  flex: {
    display: "flex",
  },
  size4: {
    width: "calc(4px * 4)",
    height: "calc(4px * 4)",
  },
  itemsCenter: {
    alignItems: "center",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  minW230px: {
    minWidth: "230px",
  },
  px3: {
    paddingInline: "calc(4px * 3)",
  },
  py1: {
    paddingBlock: "4px",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
});

// A Support row: one TODO Plain ticket, single-line in the workspace rows'
// exact shape. The rail dot wears the linked session's status (the ticket's
// priority when no session exists yet), the right edge shows the last status
// change; customer/assignee/preview live in the hover card. Hovering floats a
// "mark done" action over the right edge. Its own component rather than a
// render helper because the card needs a hook per row.
export function SupportRow({
  thread: t,
  session,
  active,
  pinned,
  onTogglePin,
  onOpen,
  onMarkDone,
  onSetStatus,
}: {
  thread: SupportThread;
  session: UnifiedSession | null;
  active: boolean;
  /** Pinned into the sidebar's Pinned band (per-user, like workspace pins). */
  pinned: boolean;
  onTogglePin: () => void;
  onOpen: () => void;
  onMarkDone: () => void;
  /** Claim the ticket's session into your lanes (null = back to derived) —
	    only present once a session exists for the thread. */
  onSetStatus?: (status: LaneChoice | null) => void;
}) {
  const isPhone = useIsPhone();
  const card = useRowHoverCard();
  const menu = useRowCtxMenu(card.close);
  const customer = t.customer.name || t.customer.email || "Unknown";
  const label = t.title || customer;
  const dot =
    (session
      ? MINE_STATUS_META.find((m) => m.key === mineStatus(session))?.dotColor
      : SUPPORT_PRIORITY_DOT[t.priority ?? 2]) || "var(--text-faint)";
  return (
    <Popover.Root {...card.rootProps}>
      <Popover.Trigger
        {...card.triggerProps}
        render={
          <button
            type="button"
            className={cn(
              SIDEBAR_ROW,
              SIDEBAR_WS_ROW,
              SIDEBAR_HOVER_LAYER,
              active && utilityClassName("bg-selected"),
            )}
            data-sidebar-row=""
            data-ws-row=""
            data-selected={active || undefined}
            onClick={onOpen}
            onContextMenu={menu.onContextMenu}
            aria-label={label}
          />
        }
      >
        <span className={SIDEBAR_RAIL}>
          <span
            {...stylex.props(sx.size7px, sx.roundedFull)}
            style={{ backgroundColor: dot }}
          />
        </span>
        <span className={SIDEBAR_ROW_TITLE}>{label}</span>
        {!isPhone && t.statusChangedAt && (
          <span
            className={cn(SIDEBAR_WS_TIME, SIDEBAR_WS_TIME_HOVER)}
            aria-label={new Date(t.statusChangedAt).toLocaleString()}
          >
            {shortTime(t.statusChangedAt)}
          </span>
        )}
        {/* Hover actions: the same pin + finish pair the workspace rows
				    wear — pin keeps the ticket in the Pinned band, the check
				    marks it done in Plain. */}
        <span className={cn(SIDEBAR_WS_ACTIONS, SIDEBAR_WS_ACTIONS_HOVER)}>
          <span
            role="button"
            tabIndex={0}
            className={cn(
              SIDEBAR_WS_ACTION,
              // One colour, picked here: a pinned action keeps its accent
              // under the pointer, where two `text-*` utilities would leave
              // the winner to Tailwind's ordering.
              pinned
                ? "text-accent"
                : utilityClassName("text-faint hover:text-fg"),
            )}
            aria-label={pinned ? "Unpin ticket" : "Pin ticket"}
            onClick={(e) => {
              e.stopPropagation();
              onTogglePin();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.stopPropagation();
                onTogglePin();
              }
            }}
          >
            <IconPin size={19} fill={pinned ? "currentColor" : "none"} />
          </span>
          <Tooltip label="Mark done in Plain">
            <span
              role="button"
              tabIndex={0}
              className={cn(
                SIDEBAR_WS_ACTION,
                utilityClassName("text-faint hover:text-green"),
              )}
              aria-label="Mark done in Plain"
              onClick={(e) => {
                e.stopPropagation();
                onMarkDone();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.stopPropagation();
                  onMarkDone();
                }
              }}
            >
              <IconCheck size={19} />
            </span>
          </Tooltip>
        </span>
      </Popover.Trigger>
      <RowCardPopup>
        <SupportRowCard thread={t} session={session} />
      </RowCardPopup>
      {menu.ctxMenu && (
        <SidebarCtxMenu
          x={menu.ctxMenu.x}
          y={menu.ctxMenu.y}
          onClose={menu.close}
          entries={[
            {
              kind: "item",
              icon: (
                <IconPin size={20} fill={pinned ? "currentColor" : "none"} />
              ),
              label: pinned ? "Unpin" : "Pin",
              onClick: onTogglePin,
            },
            ...laneCtxEntries(session, onSetStatus),
            { kind: "sep" },
            {
              kind: "item",
              icon: <IconCheck size={20} />,
              label: "Mark done in Plain",
              onClick: onMarkDone,
            },
          ]}
        />
      )}
    </Popover.Root>
  );
}

// A feed row: one external object (e.g. a linked video) in the workspace rows'
// exact shape — the generic sibling of SupportRow (the feeds design). The
// rail dot wears the linked session's status (the feed lane's color, else
// faint, when no session exists yet); the hover card carries the preview.
export function FeedRow({
  feed,
  item,
  session,
  active,
  pinned,
  onTogglePin,
  onOpen,
  onSetStatus,
}: {
  feed: FeedDescriptor;
  item: FeedItem;
  session: UnifiedSession | null;
  active: boolean;
  /** Pinned into the sidebar's Pinned band (per-user, like ticket pins). */
  pinned: boolean;
  onTogglePin: () => void;
  onOpen: () => void;
  /** Claim the item's session into your lanes (null = back to derived) —
	    only present once a session exists for the item. */
  onSetStatus?: (status: LaneChoice | null) => void;
}) {
  const isPhone = useIsPhone();
  const card = useRowHoverCard();
  const menu = useRowCtxMenu(card.close);
  const lane = feed.lanes?.find((l) => l.key === item.lane);
  // Per-viewer unread (e.g. Slack read cursors) renders Slack-style: bold
  // title + accent dot.
  const unread = item.meta?.unread === true;
  const dot =
    (session
      ? MINE_STATUS_META.find((m) => m.key === mineStatus(session))?.dotColor
      : lane?.dot) || (unread ? "var(--accent)" : "var(--text-faint)");
  const ts = item.ts ? new Date(item.ts).toISOString() : null;
  return (
    <Popover.Root {...card.rootProps}>
      <Popover.Trigger
        {...card.triggerProps}
        render={
          <button
            type="button"
            className={cn(
              SIDEBAR_ROW,
              SIDEBAR_WS_ROW,
              SIDEBAR_HOVER_LAYER,
              active && utilityClassName("bg-selected"),
            )}
            data-sidebar-row=""
            data-ws-row=""
            data-selected={active || undefined}
            onClick={onOpen}
            onContextMenu={menu.onContextMenu}
            aria-label={item.title}
          />
        }
      >
        <span className={SIDEBAR_RAIL}>
          <span
            {...stylex.props(sx.size7px, sx.roundedFull)}
            style={{ backgroundColor: dot }}
          />
        </span>
        <span
          className={cn(
            SIDEBAR_ROW_TITLE,
            unread && utilityClassName("font-semibold text-fg"),
          )}
        >
          {item.title}
        </span>
        {!isPhone && ts && (
          <span
            className={cn(SIDEBAR_WS_TIME, SIDEBAR_WS_TIME_HOVER)}
            aria-label={new Date(ts).toLocaleString()}
          >
            {shortTime(ts)}
          </span>
        )}
        <span className={cn(SIDEBAR_WS_ACTIONS, SIDEBAR_WS_ACTIONS_HOVER)}>
          <span
            role="button"
            tabIndex={0}
            className={cn(
              SIDEBAR_WS_ACTION,
              // One colour, picked here: a pinned action keeps its accent
              // under the pointer, where two `text-*` utilities would leave
              // the winner to Tailwind's ordering.
              pinned
                ? "text-accent"
                : utilityClassName("text-faint hover:text-fg"),
            )}
            aria-label={pinned ? "Unpin" : "Pin"}
            onClick={(e) => {
              e.stopPropagation();
              onTogglePin();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.stopPropagation();
                onTogglePin();
              }
            }}
          >
            <IconPin size={19} fill={pinned ? "currentColor" : "none"} />
          </span>
        </span>
      </Popover.Trigger>
      <RowCardPopup>
        <div
          {...stylex.props(
            sx.mt5px,
            sx.fontSemibold,
            sx.leading13,
            typography.label,
          )}
        >
          {item.title}
        </div>
        {item.preview && (
          <div
            {...mergeStylexProps(
              "selectable",
              sx.mt1,
              sx.lineClamp4,
              sx.textXs,
              sx.leadingSnug,
              sx.textDim,
            )}
          >
            {item.preview}
          </div>
        )}
        <CardFooter
          time={ts ? `Updated ${relativeTime(ts)}` : ""}
          timeTitle={ts ? new Date(ts).toLocaleString() : undefined}
        >
          {session && (
            <span {...stylex.props(sx.shrink0, sx.textXs, sx.textDim)}>
              Linked session
            </span>
          )}
        </CardFooter>
      </RowCardPopup>
      {menu.ctxMenu && (
        <SidebarCtxMenu
          x={menu.ctxMenu.x}
          y={menu.ctxMenu.y}
          onClose={menu.close}
          entries={[
            {
              kind: "item",
              icon: (
                <IconPin size={20} fill={pinned ? "currentColor" : "none"} />
              ),
              label: pinned ? "Unpin" : "Pin",
              onClick: onTogglePin,
            },
            ...laneCtxEntries(session, onSetStatus),
          ]}
        />
      )}
    </Popover.Root>
  );
}

export function FeedFilterMenu({
  feed,
  values,
  rawItems,
  currentUser,
  onSet,
  onHide,
}: {
  feed: FeedDescriptor;
  values: FeedFilterValues;
  rawItems: FeedItem[];
  currentUser: string;
  onSet: (key: string, value: string) => void;
  onHide: () => void;
}) {
  const [argOptions, setArgOptions] = useState<
    Record<string, { value: string; label: string }[]>
  >({});
  const [opened, setOpened] = useState(false);
  const argSpecs = (feed.filters || []).filter((f) => f.mode !== "meta");
  const metaSpecs = (feed.filters || []).filter((f) => f.mode === "meta");
  const loadArgOptions = useEffectEvent(() => {
    for (const spec of argSpecs) {
      if (argOptions[spec.key]) continue;
      fetchFeedFilterOptions(feed.id, spec.key)
        .then((options) =>
          setArgOptions((prev) => ({ ...prev, [spec.key]: options })),
        )
        .catch(() => {});
    }
  });
  useEffect(() => {
    if (!opened) return;
    loadArgOptions();
  }, [opened, feed.id]);

  const active = Object.entries(values).some(
    ([k, v]) => v && !(k === "__sort" && v === "recent"),
  );
  const item = (
    key: string,
    label: string,
    value: string,
    selected: boolean,
  ) => (
    <Menu.Item
      key={`${key}:${value}`}
      onClick={() => onSet(key, selected ? "" : value)}
    >
      <span
        {...stylex.props(
          sx.flex,
          sx.size4,
          sx.shrink0,
          sx.itemsCenter,
          sx.justifyCenter,
        )}
      >
        {selected && <IconCheck size={13} />}
      </span>
      <span {...stylex.props(sx.truncate)}>{label}</span>
    </Menu.Item>
  );
  // meta options derived from the current items (plus static prepends);
  // a "Me" shortcut appears when the viewer's first name is among them.
  const metaOptions = (spec: FeedFilterSpec) => {
    const out = new Map<string, string>();
    for (const o of spec.options || []) out.set(o.value, o.label);
    for (const it of rawItems) {
      const v = dget(it.meta, spec.field);
      const els = Array.isArray(v) ? v : v != null ? [v] : [];
      for (const el of els) {
        const value = String(dget(el, spec.optionsFromItems?.value) ?? "");
        const label = String(dget(el, spec.optionsFromItems?.label) ?? value);
        if (value) out.set(value, label);
      }
    }
    return [...out.entries()].map(([value, label]) => ({ value, label }));
  };
  const meFirst = currentUser.trim().toLowerCase().split(/\s+/)[0];
  return (
    <Menu.Root onOpenChange={setOpened}>
      <Menu.Trigger
        render={
          <span
            role="button"
            tabIndex={0}
            aria-label={`Filter ${feed.title}`}
            title={`Filter ${feed.title}`}
            className={cn(
              SIDEBAR_BAND_ACTION,
              // Unlike the workspace header's filter, this one's hover beat
              // its filtered tint in the old sheet's source order — so the
              // accent is a resting colour here, not a sticky one.
              active ? "text-accent" : utilityClassName("text-dim"),
              active && SIDEBAR_FILTER_DOT,
            )}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          />
        }
      >
        <IconFilter size={19} />
      </Menu.Trigger>
      <Menu.Popup
        align="end"
        sideOffset={5}
        className={mergeStylexOverrideClassName("", sx.minW230px)}
      >
        {metaSpecs.map((spec) => {
          const options = metaOptions(spec);
          const me = options.find(
            (o) => o.label.toLowerCase().split(/\s+/)[0] === meFirst,
          );
          const sel = values[spec.key] || "";
          return (
            <Menu.Group key={spec.key}>
              <Menu.GroupLabel>{spec.label}</Menu.GroupLabel>
              {item(spec.key, "Any", "", sel === "")}
              {me && item(spec.key, "Me", me.value, sel === me.value)}
              {options
                .filter((o) => o.value !== me?.value)
                .map((o) => item(spec.key, o.label, o.value, sel === o.value))}
            </Menu.Group>
          );
        })}
        {argSpecs.map((spec) => {
          const options = argOptions[spec.key];
          const sel = values[spec.key] || "";
          return (
            <Menu.Group key={spec.key}>
              <Menu.GroupLabel>{spec.label}</Menu.GroupLabel>
              {item(spec.key, "Any", "", sel === "")}
              {options === undefined ? (
                <div {...stylex.props(sx.px3, sx.py1, sx.textXs, sx.textFaint)}>
                  Loading…
                </div>
              ) : (
                options.map((o) =>
                  item(spec.key, o.label, o.value, sel === o.value),
                )
              )}
            </Menu.Group>
          );
        })}
        <Menu.Group>
          <Menu.GroupLabel>Linked session</Menu.GroupLabel>
          {item("__session", "Any", "", !values.__session)}
          {item(
            "__session",
            "With session",
            "with",
            values.__session === "with",
          )}
          {item(
            "__session",
            "Without session",
            "without",
            values.__session === "without",
          )}
        </Menu.Group>
        {!feed.lanes?.length && (
          <Menu.Group>
            <Menu.GroupLabel>Sort</Menu.GroupLabel>
            {(
              feed.sortOptions || [
                { value: "recent", label: "Most recent" },
                { value: "oldest", label: "Oldest first" },
                { value: "title", label: "Title" },
              ]
            ).map((o, i) =>
              item(
                "__sort",
                o.label,
                o.value,
                (values.__sort || feed.sortOptions?.[0]?.value || "recent") ===
                  o.value,
              ),
            )}
          </Menu.Group>
        )}
        <Menu.Separator />
        <Menu.Item onClick={onHide}>Hide from sidebar</Menu.Item>
      </Menu.Popup>
    </Menu.Root>
  );
}
