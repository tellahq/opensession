import { useLayoutEffect, useRef } from "react";
import { SIDEBAR_WS_ACTION } from "../../lib/sidebar-classes";
import { cn } from "../../ui/cn";
import { Tooltip } from "../../ui/tooltip";
import { IconArchive, IconMoon, IconPin, IconTrash } from "../icons";
import { KeepInSidebarMark } from "./KeepInSidebarMark";

interface WorkspaceRowHoverActionHandlers {
  onTogglePin: () => void;
  onToggleSnooze: () => void;
  onArchive: (current?: HTMLButtonElement | null) => void;
  onDeleteDraft: () => void;
  onConfirmDeleteDraft: (onConfirm: () => void) => void;
  onKeepInSidebar: () => void;
}

/**
 * A workspace row's hover cluster: Pin, Snooze, Archive or Delete draft, Keep.
 *
 * The sidebar hands every row new action closures each time the session list
 * changes. The buttons call them through a ref at click time, so the cluster's
 * tooltips keep their elements and skip those renders. With a few hundred
 * rows, the tooltips were most of a background list update's commit.
 */
export function WorkspaceRowHoverActions({
  pinned,
  active,
  snoozed,
  hasSessions,
  draft,
  canKeepInSidebar,
  pinShortcutKeys,
  archiveShortcutKeys,
  actions,
}: {
  pinned: boolean;
  active: boolean;
  snoozed: boolean;
  hasSessions: boolean;
  draft: boolean;
  canKeepInSidebar: boolean;
  pinShortcutKeys?: string[];
  archiveShortcutKeys?: string[];
  actions: WorkspaceRowHoverActionHandlers;
}) {
  const actionsRef = useRef(actions);
  useLayoutEffect(() => {
    actionsRef.current = actions;
  });

  return (
    <>
      {/* Pin is not one of the row's standing actions: an unpinned row
          offers snooze and archive, the two moves you make constantly,
          and pinning stays in the context menu, the ⌘P chord and the
          swipe. Once a row IS pinned the chip comes back, because
          unpinning has to be reachable from the thing it marks. */}
      {pinned && (
        <Tooltip
          label="Unpin workspace"
          // Only on the row the chord would actually hit: ⌘P pins the
          // workspace holding the OPEN session, so advertising it on
          // every row would promise a key that lands elsewhere.
          shortcut={active ? (pinShortcutKeys ?? undefined) : undefined}
        >
          <span
            role="button"
            tabIndex={0}
            // One colour, picked here rather than stacking two `text-*`
            // utilities, whose winner would be Tailwind's ordering: a
            // pinned action keeps its accent under the pointer.
            className={cn(SIDEBAR_WS_ACTION, "text-accent")}
            aria-label="Unpin workspace"
            onClick={(e) => {
              e.stopPropagation();
              actionsRef.current.onTogglePin();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.stopPropagation();
                actionsRef.current.onTogglePin();
              }
            }}
          >
            <IconPin size={19} fill="currentColor" />
          </span>
        </Tooltip>
      )}
      {hasSessions ? (
        <>
          <Tooltip
            label={
              snoozed ? "Unsnooze workspace" : "Snooze workspace until Someday"
            }
          >
            <span
              role="button"
              tabIndex={0}
              className={cn(SIDEBAR_WS_ACTION, "text-faint hover:text-fg")}
              aria-label={snoozed ? "Unsnooze workspace" : "Snooze workspace"}
              onClick={(e) => {
                e.stopPropagation();
                actionsRef.current.onToggleSnooze();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.stopPropagation();
                  actionsRef.current.onToggleSnooze();
                }
              }}
            >
              <IconMoon size={19} />
            </span>
          </Tooltip>
          <Tooltip
            label="Archive workspace"
            shortcut={active ? (archiveShortcutKeys ?? undefined) : undefined}
          >
            <span
              role="button"
              tabIndex={0}
              className={cn(SIDEBAR_WS_ACTION, "text-faint hover:text-fg")}
              aria-label="Archive workspace"
              onClick={(e) => {
                e.stopPropagation();
                actionsRef.current.onArchive(
                  e.currentTarget.closest<HTMLButtonElement>(
                    "button[data-sidebar-row]",
                  ),
                );
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.stopPropagation();
                  actionsRef.current.onArchive(
                    e.currentTarget.closest<HTMLButtonElement>(
                      "button[data-sidebar-row]",
                    ),
                  );
                }
              }}
            >
              <IconArchive size={19} />
            </span>
          </Tooltip>
        </>
      ) : draft ? (
        <Tooltip label="Delete draft">
          <span
            role="button"
            tabIndex={0}
            className={cn(SIDEBAR_WS_ACTION, "text-faint hover:text-red")}
            aria-label="Delete draft"
            onClick={(e) => {
              e.stopPropagation();
              const { onConfirmDeleteDraft, onDeleteDraft } =
                actionsRef.current;
              onConfirmDeleteDraft(onDeleteDraft);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.stopPropagation();
                const { onConfirmDeleteDraft, onDeleteDraft } =
                  actionsRef.current;
                onConfirmDeleteDraft(onDeleteDraft);
              }
            }}
          >
            <IconTrash size={19} />
          </span>
        </Tooltip>
      ) : null}
      {canKeepInSidebar && (
        <KeepInSidebarMark
          className={SIDEBAR_WS_ACTION}
          onKeep={() => actionsRef.current.onKeepInSidebar()}
        />
      )}
    </>
  );
}
