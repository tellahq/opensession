import React from "react";
import {
  SIDEBAR_GROUP,
  SIDEBAR_GROUP_CHEVRON,
  SIDEBAR_GROUP_CHEVRON_COLLAPSED,
  SIDEBAR_GROUP_HEADER,
  SIDEBAR_GROUP_HEADER_INSET,
  SIDEBAR_GROUP_NAME,
  SIDEBAR_LANE_COUNT,
  SIDEBAR_LANE_HEADER,
  SIDEBAR_LANE_NAME,
  SIDEBAR_STICKY_LANE,
  SIDEBAR_STUCK_BACKING,
} from "../../lib/sidebar-classes";
import type { WsRow } from "../../lib/sidebar-types";
import { cn } from "../../ui/cn";
import { IconChevronDown, IconPlus } from "../icons";

/**
 * Spaces: shared conversations whose agent spawns and coordinates sessions
 * (server/spaces.ts). Each row is a space's workspace; its threads nest under
 * it when it is selected, like any workspace's workers.
 *
 * The heading stays when there are no spaces, because its + is where a space
 * is started. A search that matches none hides it with the other empty lanes.
 */
export function SpacesBand({
  rows,
  open,
  searching,
  ownsSelection,
  renderRow,
  onToggle,
  onNewSpace,
}: {
  rows: WsRow[];
  open: boolean;
  searching: boolean;
  ownsSelection: (row: WsRow) => boolean;
  renderRow: (row: WsRow) => React.ReactNode;
  onToggle: () => void;
  onNewSpace: () => void;
}) {
  if (searching && rows.length === 0) return null;
  const empty = rows.length === 0;
  return (
    <div className={SIDEBAR_GROUP} data-sidebar-spaces>
      <button
        className={cn(
          SIDEBAR_GROUP_HEADER,
          SIDEBAR_GROUP_HEADER_INSET,
          SIDEBAR_LANE_HEADER,
          SIDEBAR_STICKY_LANE,
          SIDEBAR_STUCK_BACKING,
        )}
        data-sticky-head
        onClick={onToggle}
      >
        <span className={cn(SIDEBAR_GROUP_NAME, SIDEBAR_LANE_NAME)}>
          Spaces
        </span>
        {!empty && <span className={SIDEBAR_LANE_COUNT}>{rows.length}</span>}
        {!empty && (
          <IconChevronDown
            className={cn(
              SIDEBAR_GROUP_CHEVRON,
              !open && SIDEBAR_GROUP_CHEVRON_COLLAPSED,
            )}
            size={12}
            style={{ transform: open ? "none" : "rotate(-90deg)" }}
          />
        )}
        {/* A span inside the header button, like a project band's +. With no
            spaces yet it is the band's only content, so it shows at rest;
            otherwise it waits for hover on pointer devices. */}
        <span
          role="button"
          tabIndex={0}
          aria-label="New space"
          title="New space"
          className={cn(
            "relative ml-auto inline-flex size-6 shrink-0 items-center justify-center rounded-md text-faint transition-[opacity,color] duration-150 hover:text-fg focus-visible:opacity-100 before:absolute before:inset-0.5 before:z-0 before:rounded-sm before:[corner-shape:var(--cs)] before:transition-[background] before:content-[''] hover:before:bg-hover [&>*]:relative [&>*]:z-[1] phone:-my-3 phone:size-11",
            !empty && "md:opacity-0 md:group-hover/gh:opacity-100",
          )}
          onClick={(event) => {
            event.stopPropagation();
            onNewSpace();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              event.stopPropagation();
              onNewSpace();
            }
          }}
        >
          <IconPlus size={18} />
        </span>
      </button>
      {rows.filter((row) => open || ownsSelection(row)).map(renderRow)}
    </div>
  );
}
