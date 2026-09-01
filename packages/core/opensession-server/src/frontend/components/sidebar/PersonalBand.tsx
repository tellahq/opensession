import { mergeStylexOverrideClassName } from "../../ui/cn";
import { utilityClassName } from "../../ui/cn";
import React from "react";
import { Reorder } from "motion/react";
import {
  SIDEBAR_GROUP,
  SIDEBAR_GROUP_CHEVRON,
  SIDEBAR_GROUP_CHEVRON_COLLAPSED,
  SIDEBAR_GROUP_HEADER,
  SIDEBAR_GROUP_HEADER_INSET,
  SIDEBAR_GROUP_NAME,
  SIDEBAR_HOVER_LAYER,
  SIDEBAR_LANE_COUNT,
  SIDEBAR_LANE_HEADER,
  SIDEBAR_LANE_NAME,
  SIDEBAR_PIN_DRAG_ACTIVE,
  SIDEBAR_PIN_ENTRY,
  SIDEBAR_PIN_ENTRY_DRAGGING,
  SIDEBAR_STICKY_LANE,
  SIDEBAR_STUCK_BACKING,
} from "../../lib/sidebar-classes";
import type { PersonalBandPinnedEntry } from "../../lib/sidebar-types";
import { cn } from "../../ui/cn";
import { IconChevronDown, IconRobot } from "../icons";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  shrink0: {
    flexShrink: "0",
  },
  minW0: {
    minWidth: "0",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});

interface PersonalBandPinned {
  entries: PersonalBandPinnedEntry[];
  open: boolean;
  canDrag: boolean;
  dragKey: string | null;
  onToggle: () => void;
  onReorder: (keys: string[]) => void;
  onEntryDragStart: (entry: PersonalBandPinnedEntry) => void;
  onEntryDrag: (event: MouseEvent | TouchEvent | PointerEvent) => void;
  onEntryDragEnd: () => void;
  onEntryClickCapture: (event: React.MouseEvent) => void;
}

export function PersonalBand({
  needsReview,
  approved,
  awaitingReview,
  pinned,
  projects,
  autoCreatedRows,
  autoCreatedHidden,
  onToggleAutoCreated,
}: {
  needsReview: React.ReactNode;
  approved: React.ReactNode;
  awaitingReview: React.ReactNode;
  pinned: PersonalBandPinned | null;
  projects: React.ReactNode;
  autoCreatedRows: number;
  autoCreatedHidden: boolean;
  onToggleAutoCreated: () => void;
}) {
  return (
    <>
      {/* Needs review: everything waiting on your review, both the sessions a
          teammate asked you to look at and the GitHub PRs that requested you.
          Both are the same ask, so they share one band above everything like a
          blocked question. Under project grouping, each project's reviews ride
          that project's own band; what stays here is the rows no band can hold.
          PRs covered by a workspace row in view are already filtered out. */}
      {needsReview}

      {/* Approved: reviews you asked for that came back with a yes and are
          still open. An approval belongs with the rest of that project's work
          rather than stacked above every band, so under project grouping it
          rides its project's band as a lane. */}
      {approved}

      {/* Awaiting review: sessions you asked a teammate to review, the mirror
          of Needs review. They move out of the status lanes into one place. */}
      {awaitingReview}

      {/* Pinned is one flat drag-to-reorder list across workspaces, loose
          sessions, tickets, pull requests, and feed items. It remains mounted
          only while open, preserving Motion's existing drag contract. */}
      {pinned && (
        <div className={SIDEBAR_GROUP}>
          <button
            className={cn(
              SIDEBAR_GROUP_HEADER,
              SIDEBAR_GROUP_HEADER_INSET,
              SIDEBAR_LANE_HEADER,
              SIDEBAR_STICKY_LANE,
              SIDEBAR_STUCK_BACKING,
            )}
            data-sticky-head
            onClick={pinned.onToggle}
          >
            <span className={cn(SIDEBAR_GROUP_NAME, SIDEBAR_LANE_NAME)}>
              Pinned
            </span>
            <span className={SIDEBAR_LANE_COUNT}>{pinned.entries.length}</span>
            <IconChevronDown
              className={cn(
                SIDEBAR_GROUP_CHEVRON,
                !pinned.open && SIDEBAR_GROUP_CHEVRON_COLLAPSED,
              )}
              size={12}
              style={{
                transform: pinned.open ? "none" : "rotate(-90deg)",
              }}
            />
          </button>
          {pinned.open && (
            <Reorder.Group
              as="div"
              axis="y"
              values={pinned.entries.map((entry) => entry.key)}
              onReorder={pinned.onReorder}
            >
              {pinned.entries.map((entry) => (
                <Reorder.Item
                  as="div"
                  key={entry.key}
                  value={entry.key}
                  dragListener={pinned.canDrag}
                  transition={{ duration: 0 }}
                  onDragStart={() => pinned.onEntryDragStart(entry)}
                  onDrag={(event: MouseEvent | TouchEvent | PointerEvent) =>
                    pinned.onEntryDrag(event)
                  }
                  onDragEnd={pinned.onEntryDragEnd}
                  whileDrag={{ scale: 1.01 }}
                  className={cn(
                    SIDEBAR_PIN_ENTRY,
                    pinned.dragKey && SIDEBAR_PIN_DRAG_ACTIVE,
                    pinned.dragKey === entry.key && SIDEBAR_PIN_ENTRY_DRAGGING,
                  )}
                  onClickCapture={pinned.onEntryClickCapture}
                >
                  {entry.node}
                </Reorder.Item>
              ))}
            </Reorder.Group>
          )}
        </div>
      )}

      {/* Workspaces: status lanes live directly under the Workspaces header,
          which carries the filter and new-session actions, with no second
          in-list heading. Inbox, Activity, and Status choose row sections;
          Project independently decides whether those sections repeat per repo.

          Snoozed rows sit out of the active rows, so each layout places them:
          under a project band, as one global group after ungrouped inbox rows,
          or above Backlog in the status lanes. Plain renders as another project
          with priority lanes, while session-less PR and feed rows keep their
          project-shaped sections. */}
      <div className={SIDEBAR_GROUP}>{projects}</div>

      {/* The agent's own workspaces, switched from the foot of the list it is
          adding to or taking from. It follows the rows it counts, where the list
          runs out and you would wonder what is missing. It says which way it
          goes, so it is always its own undo. Faint: it is a note about the list,
          not a row in it.

          It does not say "auto created". The Automations band sits directly
          under this switch, and one word for two different things would read as
          though this controls that. An automation is a configured job, while
          these are one-off workspaces an agent opened for itself. */}
      {autoCreatedRows > 0 && (
        <button
          className={cn(
            utilityClassName(
              "mb-1 flex w-full items-center gap-1.5 rounded-row px-4 py-1.5 text-left text-label text-faint",
            ),
            SIDEBAR_HOVER_LAYER,
            utilityClassName("hover:text-dim"),
          )}
          onClick={onToggleAutoCreated}
        >
          <IconRobot
            size={20}
            className={mergeStylexOverrideClassName("", sx.shrink0)}
          />
          <span {...stylex.props(sx.minW0, sx.truncate)}>
            {autoCreatedHidden ? "Show" : "Hide"} {autoCreatedRows} started by
            an agent
          </span>
        </button>
      )}
    </>
  );
}
