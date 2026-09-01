import { mergeStylexOverrideClassName } from "../../ui/cn";
import { utilityClassName } from "../../ui/cn";
import React, { useEffect, useState } from "react";
import { hasDraft, onDraftsChanged } from "../../lib/drafts";
import {
  SIDEBAR_HOVER_LAYER,
  SIDEBAR_RAIL,
  SIDEBAR_WS_DRAFT,
  SIDEBAR_WS_ROW,
} from "../../lib/sidebar-classes";
import { cn } from "../../ui/cn";
import { IconPencil, IconPlus } from "../icons";
import { SIDEBAR_ROW, SIDEBAR_ROW_TITLE } from "./SidebarItem";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  shrink0: {
    flexShrink: "0",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
});

/**
 * The session that hasn't started yet.
 *
 * With no sessions at all, the sidebar used to say "No workspaces yet" and the
 * panel offered a button to a palette somewhere else. This is the same list
 * with one row in it instead: the row is the session you are about to start,
 * and pressing it points you at the input that starts it. So the list is never
 * empty, and the first thing anyone does here is the thing the app is for.
 *
 * It is a plain row rather than a `SidebarItem`: there is no session to pin,
 * archive, rename, swipe or hover a card for, and half of those would create
 * one just to act on it. What it does share is the shape, the type and the
 * selected wash, so it sits in the list as a row and not as an advert.
 *
 * The mark is a "+" where a live row carries its status: nothing has run, so
 * there is no state to report. The pencil is the same one a session row shows
 * for text you left unsent, and it appears here for the same reason. Only its
 * presence is tracked, not the text itself, because local keystrokes emit on
 * the presence edge alone (lib/drafts) and a title fed from that would show
 * the first word you typed and then quietly go stale.
 */
export function DraftRow({
  active,
  onClick,
}: {
  active: boolean;
  onClick: () => void;
}) {
  const [draft, setDraft] = useState(() => hasDraft("new-session"));
  useEffect(() => onDraftsChanged(() => setDraft(hasDraft("new-session"))), []);
  return (
    <button
      className={cn(
        SIDEBAR_ROW,
        SIDEBAR_WS_ROW,
        SIDEBAR_HOVER_LAYER,
        active && utilityClassName("bg-selected"),
      )}
      data-sidebar-row=""
      data-selected={active || undefined}
      onClick={onClick}
      aria-label="New session, not started yet"
    >
      <span className={SIDEBAR_RAIL}>
        <IconPlus
          className={mergeStylexOverrideClassName("", sx.shrink0, sx.textFaint)}
          size={16}
        />
      </span>
      <span className={SIDEBAR_ROW_TITLE}>New session</span>
      {draft && (
        <span
          className={cn(SIDEBAR_WS_DRAFT, utilityClassName("ml-1.5"))}
          data-ws-draft=""
          aria-label="Unsent draft"
        >
          <IconPencil size={20} />
        </span>
      )}
    </button>
  );
}
