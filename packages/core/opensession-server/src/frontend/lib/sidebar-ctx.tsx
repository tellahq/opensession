import React, { useEffect, useState } from "react";
import { IconInbox } from "../components/icons";
import { isClaimed, pinnedLane } from "./sidebar-lanes";
import type { CtxEntry, LaneChoice } from "./sidebar-types";
import type { UnifiedSession } from "./types";

// Inline styles for the right-click menus. Kept inline (not in a CSS file)
// because component-imported CSS isn't linked into the served bundle — only
// legacy.css is — so a separate stylesheet silently doesn't apply.
export const CTX_MENU_STYLE: React.CSSProperties = {
  position: "fixed",
  zIndex: 3000,
  minWidth: 210,
  maxWidth: 320,
  maxHeight: "60vh",
  overflowY: "auto",
  padding: 4,
  background: "var(--popup-glass)",
  backdropFilter: "var(--popup-blur)",
  // No border: the edge is the shared popup ring, carried by the
  // `smooth-shadow-ring-md` class its hosts put on the same element. A
  // `--border-strong` hairline is a step darker than every other menu.
  borderRadius: "var(--radius-popup)",
  display: "flex",
  flexDirection: "column",
  gap: 1,
};
export const CTX_ITEM_STYLE: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  background: "none",
  border: "none",
  color: "var(--text)",
  fontSize: 13,
  padding: "6px 8px",
  borderRadius: 6,
  cursor: "pointer",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};
export const CTX_SEP_STYLE: React.CSSProperties = {
  height: 1,
  // `--border`, like ui/menu's Separator (bg-line): inside a popup this is a
  // divider between rows, not the box's own edge.
  background: "var(--border)",
  margin: "4px 3px",
};

// Right-click wiring for the feed-shaped rows (Support tickets, feed items).
// They render as Base UI popover triggers rather than as workspace rows, so
// they never inherited the workspace row's menu — but they stand for the same
// work, so they get the same one. Touch keeps the native callout: these rows
// have no long-press sheet to conflict with.
export function useRowCtxMenu(onOpen?: () => void) {
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [ctxMenu]);
  return {
    ctxMenu,
    close: () => setCtxMenu(null),
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      // The sidebar's background carries a menu of its own, so a row's menu
      // has to claim the event rather than let both open.
      e.stopPropagation();
      onOpen?.();
      setCtxMenu({ x: e.clientX, y: e.clientY });
    },
  };
}

// The claim + lane pair a feed-shaped row offers once a run exists for its
// item — the same two entries the workspace rows' menu carries. Without them
// a ticket whose only session is an automation run (Plain triage) could be
// claimed from the Automations band but not from the band it actually reads
// in. Nothing to claim yet (no session) means no entries.
export function laneCtxEntries(
  session: UnifiedSession | null,
  onSetStatus?: (status: LaneChoice | null) => void,
): CtxEntry[] {
  if (!session || !onSetStatus) return [];
  const claimed = isClaimed(session);
  return [
    {
      kind: "item",
      icon: <IconInbox size={20} />,
      label: claimed ? "Stop keeping in sidebar" : "Keep in sidebar",
      onClick: () => onSetStatus(claimed ? null : "mine"),
    },
    {
      kind: "status",
      current: pinnedLane(session) ?? null,
      onPick: onSetStatus,
    },
  ];
}
