import React from "react";
import { IconChevronDown } from "../components/icons";
import { cn } from "../ui/cn";
import type { ReviewQueueItem } from "./review-queue";
import { activityBandFor, type ActivityBand } from "./sidebar-activity";
import {
  SIDEBAR_GROUP,
  SIDEBAR_GROUP_CHEVRON,
  SIDEBAR_GROUP_CHEVRON_COLLAPSED,
  SIDEBAR_GROUP_HEADER,
  SIDEBAR_GROUP_HEADER_INSET,
  SIDEBAR_GROUP_NAME,
  SIDEBAR_LANE_COUNT,
  SIDEBAR_LANE_DROP_HOVER,
  SIDEBAR_LANE_EMPTY,
  SIDEBAR_LANE_HEADER,
  SIDEBAR_LANE_NAME,
  SIDEBAR_STATUS_GROUP,
  SIDEBAR_STICKY_LANE,
  SIDEBAR_STICKY_LANE_NESTED,
  SIDEBAR_STUCK_BACKING,
} from "./sidebar-classes";
import type { GroupBy } from "./sidebar-filter";
import { sortInboxByCreation } from "./sidebar-inbox";
import { MINE_STATUS_META, type MineStatus, type WsRow } from "./sidebar-types";

interface WorkspaceGroupingOptions {
  groupBy: GroupBy;
  pinDragMeta: { sessions: unknown[]; repo: string | null } | null;
  laneDropHover: { gkey: string; lane: MineStatus } | null;
  isOpen: (key: string) => boolean;
  onToggleGroup: (key: string) => void;
  ownsSelection: (row: WsRow) => boolean;
  prRowSelected: (item: ReviewQueueItem) => boolean;
  prItemLane: (item: ReviewQueueItem) => MineStatus;
  isDraft: (row: WsRow) => boolean;
  renderWorkspaceRow: (row: WsRow) => React.ReactNode;
  renderWorkspaceRowImpl: (row: WsRow, inbox: boolean) => React.ReactNode;
  renderPrRow: (item: ReviewQueueItem) => React.ReactNode;
}

export function createWorkspaceGroupingRenderers({
  groupBy,
  pinDragMeta,
  laneDropHover,
  isOpen,
  onToggleGroup: toggleGroup,
  ownsSelection: rowOwnsSelection,
  prRowSelected,
  prItemLane,
  isDraft: isDraftWsRow,
  renderWorkspaceRow: renderWsRow,
  renderWorkspaceRowImpl: renderWsRowImpl,
  renderPrRow,
}: WorkspaceGroupingOptions) {
  function renderSnoozedGroup(rows: WsRow[], ns = "", nested = false) {
    const gkey = `${ns}status:snoozed`;
    const open = isOpen(gkey);
    return (
      <div className={SIDEBAR_STATUS_GROUP} data-status-group key={gkey}>
        <button
          className={cn(
            SIDEBAR_GROUP_HEADER,
            SIDEBAR_GROUP_HEADER_INSET,
            SIDEBAR_LANE_HEADER,
            "transition-colors",
            SIDEBAR_STICKY_LANE,
            nested && SIDEBAR_STICKY_LANE_NESTED,
            SIDEBAR_STUCK_BACKING,
          )}
          data-sticky-head
          onClick={() => toggleGroup(gkey)}
        >
          <span className={cn(SIDEBAR_GROUP_NAME, SIDEBAR_LANE_NAME)}>
            Snoozed
          </span>
          <span className={SIDEBAR_LANE_COUNT}>{rows.length}</span>
          <IconChevronDown
            className={cn(
              SIDEBAR_GROUP_CHEVRON,
              !open && SIDEBAR_GROUP_CHEVRON_COLLAPSED,
            )}
            size={12}
            style={{ transform: open ? "none" : "rotate(-90deg)" }}
          />
        </button>
        {rows.filter((r) => open || rowOwnsSelection(r)).map(renderWsRow)}
      </div>
    );
  }

  // A labeled flat lane: a caption, a count, its rows. The review lanes
  // (Needs review, Approved, Awaiting review). Under a repo
  // grouping each one rides inside its project's band, beside that project's
  // status lanes, rather than stacked above every band, so the work sits with
  // the rest of the project it belongs to. The repo-less groupings have no
  // band to nest in, so there the same lane stands on its own
  // (renderLabeledBand). `ns` keeps each repo's copy collapsible on its own.
  // Needs review draws its rows with renderReviewWsRow, whose click opens the
  // Review tab, and is the only lane that also carries session-less PR rows:
  // the GitHub review requests pointed at you.
  function renderLabeledLane({
    label,
    name,
    rows,
    prs = [],
    ns = "",
    renderRow = renderWsRow,
  }: {
    label: string;
    name: string;
    rows: WsRow[];
    prs?: ReviewQueueItem[];
    ns?: string;
    renderRow?: (row: WsRow) => React.ReactNode;
  }) {
    if (rows.length === 0 && prs.length === 0) return null;
    const gkey = `${ns}${name}`;
    const open = isOpen(gkey);
    return (
      <div className={SIDEBAR_STATUS_GROUP} data-status-group key={gkey}>
        <button
          className={cn(
            SIDEBAR_GROUP_HEADER,
            SIDEBAR_GROUP_HEADER_INSET,
            SIDEBAR_LANE_HEADER,
            "transition-colors",
            SIDEBAR_STICKY_LANE,
            ns && SIDEBAR_STICKY_LANE_NESTED,
            SIDEBAR_STUCK_BACKING,
          )}
          data-sticky-head
          onClick={() => toggleGroup(gkey)}
        >
          <span className={cn(SIDEBAR_GROUP_NAME, SIDEBAR_LANE_NAME)}>
            {label}
          </span>
          <span className={SIDEBAR_LANE_COUNT}>{rows.length + prs.length}</span>
          <IconChevronDown
            className={cn(
              SIDEBAR_GROUP_CHEVRON,
              !open && SIDEBAR_GROUP_CHEVRON_COLLAPSED,
            )}
            size={12}
            style={{ transform: open ? "none" : "rotate(-90deg)" }}
          />
        </button>
        {rows
          .filter((r) => open || rowOwnsSelection(r))
          .map((r) => renderRow(r))}
        {prs.filter((i) => open || prRowSelected(i)).map(renderPrRow)}
      </div>
    );
  }

  // The same lane standing on its own above the project bands: the shape the
  // repo-less groupings use, and what holds the rows no band can (topBandRows).
  // Renders nothing when empty, so a group's gap never opens on an absent band.
  function renderLabeledBand(params: Parameters<typeof renderLabeledLane>[0]) {
    const lane = renderLabeledLane(params);
    return lane && <div className={SIDEBAR_GROUP}>{lane}</div>;
  }

  // The Conductor-style status lanes (Needs input / In progress / …) over a set
  // of workspace rows. `ns` keeps each repo's lane collapse state independent.
  // `snoozedRows` (when given) render as a Snoozed group slotted just above
  // the final Backlog lane: the quiet zone, per the T3-style snooze design.
  function renderStatusLanes(
    rows: WsRow[],
    ns = "",
    snoozedRows?: WsRow[],
    laneRepo?: string,
    prItems: ReviewQueueItem[] = [],
  ) {
    // While an eligible Pinned row is mid-drag these lanes double as drop
    // targets: per-repo lanes only for the row's own repo, and empty lanes
    // materialize (dimmed) so every status can take the drop.
    const dropEligible =
      !!pinDragMeta &&
      pinDragMeta.sessions.length > 0 &&
      (!laneRepo || laneRepo === pinDragMeta.repo);
    const lanes = MINE_STATUS_META.map((meta) => {
      const items = rows.filter((r) => r.status === meta.key);
      // Session-less PR rows share the lanes since the PR-band dissolution.
      const prs = prItems.filter((i) => prItemLane(i) === meta.key);
      if (items.length === 0 && prs.length === 0 && !dropEligible) return null;
      const gkey = `${ns}status:${meta.key}`;
      const open = isOpen(gkey);
      const dropHover = dropEligible && laneDropHover?.gkey === gkey;
      return (
        <div
          className={cn(
            SIDEBAR_STATUS_GROUP,
            dropEligible &&
              items.length === 0 &&
              prs.length === 0 &&
              SIDEBAR_LANE_EMPTY,
            dropHover && SIDEBAR_LANE_DROP_HOVER,
          )}
          data-status-group
          key={gkey}
          data-lane-drop={dropEligible ? gkey : undefined}
          data-lane-status={dropEligible ? meta.key : undefined}
          data-lane-repo={dropEligible && laneRepo ? laneRepo : undefined}
        >
          <button
            className={cn(
              SIDEBAR_GROUP_HEADER,
              SIDEBAR_GROUP_HEADER_INSET,
              SIDEBAR_LANE_HEADER,
              "transition-colors",
              SIDEBAR_STICKY_LANE,
              !!laneRepo && SIDEBAR_STICKY_LANE_NESTED,
              SIDEBAR_STUCK_BACKING,
            )}
            data-sticky-head
            onClick={() => toggleGroup(gkey)}
          >
            <span className={cn(SIDEBAR_GROUP_NAME, SIDEBAR_LANE_NAME)}>
              {meta.label}
            </span>
            <span className={SIDEBAR_LANE_COUNT}>
              {items.length + prs.length}
            </span>
            <IconChevronDown
              className={cn(
                SIDEBAR_GROUP_CHEVRON,
                !open && SIDEBAR_GROUP_CHEVRON_COLLAPSED,
              )}
              size={12}
              style={{ transform: open ? "none" : "rotate(-90deg)" }}
            />
          </button>
          {items
            .filter((r) => open || rowOwnsSelection(r))
            .map((r) => renderWsRowImpl(r, false))}
          {prs.filter((i) => open || prRowSelected(i)).map(renderPrRow)}
        </div>
      );
    });
    if (snoozedRows && snoozedRows.length > 0) {
      // Snoozed slots directly after Backlog ("pending") — the quiet zone
      // sits with the parked work, ahead of Ready to merge / Done.
      lanes.splice(
        MINE_STATUS_META.findIndex((m) => m.key === "pending") + 1,
        0,
        renderSnoozedGroup(snoozedRows, ns, !!laneRepo),
      );
    }
    return lanes;
  }

  // Activity sections separate live work from idle work, then keep attention and
  // draft rows ahead of the date bands. Rows rank by activity inside each band.
  function renderInboxBands(
    rows: WsRow[],
    ns = "",
    snoozedRows: WsRow[] = [],
    prItems: ReviewQueueItem[] = [],
    nested = false,
  ) {
    const sorted = [...rows].sort((a, b) =>
      (b.lastActivity || "").localeCompare(a.lastActivity || ""),
    );
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const todayMs = dayStart.getTime();
    const yesterdayMs = todayMs - 24 * 60 * 60 * 1000;
    const bands: Array<{
      key: ActivityBand;
      label: string;
      rows: WsRow[];
      prs: ReviewQueueItem[];
    }> = [
      { key: "inprogress", label: "In progress", rows: [], prs: [] },
      { key: "needsaction", label: "Needs action", rows: [], prs: [] },
      { key: "drafts", label: "Drafts", rows: [], prs: [] },
      { key: "recent", label: "Recent", rows: [], prs: [] },
      { key: "yesterday", label: "Yesterday", rows: [], prs: [] },
      { key: "earlier", label: "Earlier", rows: [], prs: [] },
    ];
    const bandFor = (key: ActivityBand) =>
      bands.find((band) => band.key === key)!;
    for (const row of sorted) {
      const key = activityBandFor(row, todayMs, isDraftWsRow(row));
      bandFor(key).rows.push(row);
    }
    for (const item of [...prItems].sort((a, b) =>
      (b.pr.updatedAt || "").localeCompare(a.pr.updatedAt || ""),
    )) {
      const time = Date.parse(item.pr.updatedAt || "");
      if (time >= todayMs) bandFor("recent").prs.push(item);
      else if (time >= yesterdayMs) bandFor("yesterday").prs.push(item);
      else bandFor("earlier").prs.push(item);
    }
    const nodes = bands
      .filter((band) => band.rows.length > 0 || band.prs.length > 0)
      .map((band) => {
        const gkey = `${ns}inbox:${band.key}`;
        const open = isOpen(gkey);
        return (
          <div className={SIDEBAR_STATUS_GROUP} data-status-group key={gkey}>
            <button
              className={cn(
                SIDEBAR_GROUP_HEADER,
                SIDEBAR_GROUP_HEADER_INSET,
                SIDEBAR_LANE_HEADER,
                "transition-colors",
                SIDEBAR_STICKY_LANE,
                nested && SIDEBAR_STICKY_LANE_NESTED,
                SIDEBAR_STUCK_BACKING,
              )}
              data-sticky-head
              onClick={() => toggleGroup(gkey)}
            >
              <span className={cn(SIDEBAR_GROUP_NAME, SIDEBAR_LANE_NAME)}>
                {band.label}
              </span>
              <span className={SIDEBAR_LANE_COUNT}>
                {band.rows.length + band.prs.length}
              </span>
              <IconChevronDown
                className={cn(
                  SIDEBAR_GROUP_CHEVRON,
                  !open && SIDEBAR_GROUP_CHEVRON_COLLAPSED,
                )}
                size={12}
                style={{ transform: open ? "none" : "rotate(-90deg)" }}
              />
            </button>
            {band.rows
              .filter((row) => open || rowOwnsSelection(row))
              .map((row) => renderWsRowImpl(row, !ns))}
            {band.prs
              .filter((item) => open || prRowSelected(item))
              .map(renderPrRow)}
          </div>
        );
      });
    if (snoozedRows.length > 0)
      nodes.push(renderSnoozedGroup(snoozedRows, ns, nested));
    return nodes;
  }

  // ── Inbox Active section ───────────────────────────────────────────────
  // Snoozed uses the shared section below; Active keeps its stable creation
  // order and the same compact row density.
  function renderActiveSection(rows: WsRow[], ns = "", nested = false) {
    const label = "Active";
    if (rows.length === 0) return null;
    const gkey = `${ns}inbox:${label.toLowerCase()}`;
    const open = isOpen(gkey);
    return (
      <div className={SIDEBAR_STATUS_GROUP} data-status-group key={gkey}>
        <button
          className={cn(
            SIDEBAR_GROUP_HEADER,
            SIDEBAR_GROUP_HEADER_INSET,
            SIDEBAR_LANE_HEADER,
            "transition-colors",
            SIDEBAR_STICKY_LANE,
            nested && SIDEBAR_STICKY_LANE_NESTED,
            SIDEBAR_STUCK_BACKING,
          )}
          data-sticky-head
          onClick={() => toggleGroup(gkey)}
        >
          <span className={cn(SIDEBAR_GROUP_NAME, SIDEBAR_LANE_NAME)}>
            {label}
          </span>
          <span className={SIDEBAR_LANE_COUNT}>{rows.length}</span>
          <IconChevronDown
            className={cn(
              SIDEBAR_GROUP_CHEVRON,
              !open && SIDEBAR_GROUP_CHEVRON_COLLAPSED,
            )}
            size={12}
            style={{ transform: open ? "none" : "rotate(-90deg)" }}
          />
        </button>
        {rows
          .filter((row) => open || rowOwnsSelection(row))
          .map((row) => renderWsRowImpl(row, !ns))}
      </div>
    );
  }

  function renderWorkspaceGrouping(
    rows: WsRow[],
    ns = "",
    snoozedRows: WsRow[] = [],
    laneRepo?: string,
    prItems: ReviewQueueItem[] = [],
  ) {
    const nested = !!laneRepo;
    if (groupBy === "activity")
      return renderInboxBands(rows, ns, snoozedRows, prItems, nested);
    if (groupBy === "status")
      return renderStatusLanes(rows, ns, snoozedRows, laneRepo, prItems);
    const active = sortInboxByCreation(rows);
    return [
      renderActiveSection(active, ns, nested),
      ...prItems.map(renderPrRow),
      ...(snoozedRows.length > 0
        ? [renderSnoozedGroup(snoozedRows, ns, nested)]
        : []),
    ];
  }
  return {
    renderLabeledBand,
    renderLabeledLane,
    renderWorkspaceGrouping,
  };
}
