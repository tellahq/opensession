import { mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import React from "react";
import type { ReviewQueueItem } from "../lib/review-queue";
import { prStatusMark } from "../lib/pr-status";
import {
  SIDEBAR_HOVER_LAYER,
  SIDEBAR_RAIL,
  SIDEBAR_STATUS_DOT,
  SIDEBAR_WS_ACTION,
  SIDEBAR_WS_ACTIONS,
  SIDEBAR_WS_ACTIONS_HOVER,
  SIDEBAR_WS_ROW,
  SIDEBAR_WS_TIME,
  SIDEBAR_WS_TIME_HOVER,
} from "../lib/sidebar-classes";
import { providerFromUrl } from "../lib/provider";
import { shortTime } from "../lib/time";
import { IconArrowUpRight, IconPin, IconPullRequest, IconX } from "./icons";
import { cn } from "../ui/cn";
import { ContextMenu } from "../ui/menu";
import { Popover } from "../ui/popover";
import { Tooltip } from "../ui/tooltip";
import { SIDEBAR_ROW, SIDEBAR_ROW_TITLE } from "./sidebar/SidebarItem";
import { ReviewAskerFace } from "./ReviewAskerFace";
import { PrRowCard, RowCardPopup, useRowHoverCard } from "./SidebarRowCards";
import { useIsPhone } from "../hooks/useIsPhone";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  minW220px: {
    minWidth: "220px",
  },
  grow: {
    flexGrow: "1",
  },
  textRed: {
    color: "var(--red)",
  },
});

/**
 * A session-less open PR, rendered inside a project's status lanes (ported
 * from the retired standalone Pull-requests band — the sidebar's PR queue
 * dissolved into the per-repo project groups). PRs that have a live session
 * ride their workspace row instead; this row covers the rest: automation
 * output, teammates' PRs surfaced by the PR filter, review requests whose
 * session is archived.
 *
 * Single-line, in the workspace rows' exact shape: the rail glyph carries the
 * PR state (the same color language as WsPrStatusMark), the title fills the
 * row, the right edge shows last-update time. Author, number, checks and the
 * spelled-out status live in the hover card and the context menu.
 */

// The ws rows' PR color language (prStatusMark), computed off the queue item's
// OpenPr: red = blocked (conflict / failing checks / changes requested),
// yellow = checks running, faint = draft, green = open and healthy.
function PrStateMark({ item, size }: { item: ReviewQueueItem; size: number }) {
  const status = prStatusMark(item.pr);
  return (
    <span title={item.status || status.label}>
      <IconPullRequest size={size} className={status.className} />
    </span>
  );
}

export function PrRow({
  item,
  selected,
  pinned,
  onTogglePin,
  onOpen,
  onClose,
  closing,
}: {
  item: ReviewQueueItem;
  selected: boolean;
  /** Pinned into the sidebar's Pinned band (per-user, like workspace pins). */
  pinned: boolean;
  onTogglePin: () => void;
  /** Open the PR's workspace (resolve-or-create, Review tab). */
  onOpen: () => void;
  /** Close the PR on the provider without merging (confirmed upstream). */
  onClose: () => void;
  closing: boolean;
}) {
  const isPhone = useIsPhone();
  const card = useRowHoverCard();
  // `requested` means GitHub has you down as a reviewer on this PR and you
  // have not submitted a review yet (buildReviewQueue).
  const needsMyReview = item.source === "requested";
  return (
    <Popover.Root {...card.rootProps}>
      <ContextMenu.Root>
        <ContextMenu.Trigger
          render={
            // Both triggers ride the same row button: the popover raises the
            // hover card, the context menu keeps right-click. The card steps
            // aside when the menu opens so the two never overlap.
            <Popover.Trigger
              {...card.triggerProps}
              render={
                <button
                  type="button"
                  className={cn(
                    SIDEBAR_ROW,
                    SIDEBAR_WS_ROW,
                    // An unpinned row reveals one chip fewer (the pin only
                    // appears once there is something to unpin), so it gives
                    // that much of its right end back to the title.
                    !pinned && utilityClassName("hover:pr-[68px]"),
                    SIDEBAR_HOVER_LAYER,
                    selected && utilityClassName("bg-selected"),
                  )}
                  data-sidebar-row=""
                  data-ws-row=""
                  data-selected={selected || undefined}
                  onClick={onOpen}
                  onContextMenu={card.close}
                  aria-label={
                    needsMyReview
                      ? `${item.pr.title}, needs your review`
                      : item.pr.title
                  }
                />
              }
            />
          }
        >
          {/* Being asked to review outranks the PR's own health, and takes the
			    blue "blocked on you" dot the workspace rows use for the same thing.
			    The state glyph it replaces is a step away, in the hover card. */}
          <span className={SIDEBAR_RAIL}>
            {needsMyReview ? (
              <span
                className={utilityClassName(
                  `size-2 shrink-0 rounded-full ${SIDEBAR_STATUS_DOT.waiting}`,
                )}
                title="Needs your review"
              />
            ) : (
              <PrStateMark item={item} size={18} />
            )}
          </span>
          <span className={SIDEBAR_ROW_TITLE}>{item.pr.title}</span>
          {needsMyReview && (
            <ReviewAskerFace
              asker={{
                name: item.pr.person || item.pr.author,
                login: item.pr.author,
                viaPr: true,
              }}
            />
          )}
          {!isPhone && (
            <span
              className={cn(SIDEBAR_WS_TIME, SIDEBAR_WS_TIME_HOVER)}
              aria-label={new Date(item.pr.updatedAt).toLocaleString()}
            >
              {shortTime(item.pr.updatedAt)}
            </span>
          )}
          {/* Hover actions in the workspace rows' shape: pin keeps the PR in
			    the Pinned band; the trailing action closes the PR upstream
			    (confirmed). It deliberately does NOT wear the archive icon —
			    this row sits beside workspace rows whose trailing icon archives
			    locally, and a mis-click here closes someone's PR on GitHub. */}
          <span className={cn(SIDEBAR_WS_ACTIONS, SIDEBAR_WS_ACTIONS_HOVER)}>
            {/* Pin only shows on a row that IS pinned, where it is the way
				    back out. Pinning itself lives in the context menu. */}
            {pinned && (
              <Tooltip label="Unpin pull request">
                <span
                  role="button"
                  tabIndex={0}
                  // One colour, picked here rather than stacking two `text-*`
                  // utilities, whose winner would be Tailwind's ordering.
                  className={cn(SIDEBAR_WS_ACTION, "text-accent")}
                  aria-label="Unpin pull request"
                  onMouseEnter={card.close}
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
                  <IconPin size={19} fill="currentColor" />
                </span>
              </Tooltip>
            )}
            <Tooltip label="Close pull request">
              <span
                role="button"
                tabIndex={0}
                className={cn(
                  SIDEBAR_WS_ACTION,
                  utilityClassName("text-faint hover:text-fg"),
                )}
                aria-label="Close pull request"
                onMouseEnter={card.close}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.stopPropagation();
                    onClose();
                  }
                }}
              >
                <IconX size={19} />
              </span>
            </Tooltip>
          </span>
        </ContextMenu.Trigger>
        <ContextMenu.Popup
          className={mergeStylexOverrideClassName("", sx.minW220px)}
        >
          <ContextMenu.Item onClick={onOpen}>
            <span {...stylex.props(sx.grow)}>Open review</span>
          </ContextMenu.Item>
          <ContextMenu.Item
            render={<a href={item.pr.url} target="_blank" rel="noopener" />}
          >
            <IconArrowUpRight size={18} />
            <span {...stylex.props(sx.grow)}>
              Open on {providerFromUrl(item.pr.url).name}
            </span>
          </ContextMenu.Item>
          <ContextMenu.Separator />
          <ContextMenu.Item
            className={mergeStylexOverrideClassName(
              "data-[highlighted]:bg-red-soft",
              sx.textRed,
            )}
            disabled={closing}
            onClick={onClose}
          >
            <IconX size={18} />
            <span {...stylex.props(sx.grow)}>
              {closing ? "Closing…" : "Close pull request…"}
            </span>
          </ContextMenu.Item>
        </ContextMenu.Popup>
      </ContextMenu.Root>
      <RowCardPopup>
        <PrRowCard item={item} />
      </RowCardPopup>
    </Popover.Root>
  );
}
