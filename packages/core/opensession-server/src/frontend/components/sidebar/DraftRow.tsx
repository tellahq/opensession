import React, { useEffect, useState } from "react";
import { hasDraft, onDraftsChanged } from "../../lib/drafts";
import {
  SIDEBAR_RAIL,
  SIDEBAR_ROW_TITLE,
  SIDEBAR_WS_DRAFT,
  sidebarRow,
} from "../../lib/sidebar-classes";
import { cn } from "../../ui/cn";
import { IconPencil, IconPlus } from "../icons";

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
      className={sidebarRow({ layout: "rail", selected: active, chips: 3 })}
      data-sidebar-row=""
      data-selected={active || undefined}
      onClick={onClick}
      aria-label="New session, not started yet"
    >
      <span className={SIDEBAR_RAIL}>
        <IconPlus className="shrink-0 text-faint" size={20} />
      </span>
      <span className={SIDEBAR_ROW_TITLE}>New session</span>
      {draft && (
        <span
          className={cn(SIDEBAR_WS_DRAFT, "ml-1.5")}
          data-ws-draft=""
          aria-label="Unsent draft"
        >
          <IconPencil size={20} />
        </span>
      )}
    </button>
  );
}
