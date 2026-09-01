import { mergeStylexProps, mergeStylexOverrideClassName } from "../../ui/cn";
import { utilityClassName } from "../../ui/cn";
import React from "react";
import type { ReviewQueueItem } from "../../lib/review-queue";
import {
  SIDEBAR_ATTN_COUNT,
  SIDEBAR_GROUP_CHEVRON,
  SIDEBAR_GROUP_CHEVRON_COLLAPSED,
  SIDEBAR_GROUP_COUNT,
  SIDEBAR_GROUP_HEADER,
  SIDEBAR_GROUP_HEADER_INSET,
  SIDEBAR_GROUP_NAME,
  SIDEBAR_HEADER_ROW,
  SIDEBAR_RAIL,
  SIDEBAR_REPO_TILE,
  SIDEBAR_STICKY_LANE,
  SIDEBAR_STUCK_BACKING,
} from "../../lib/sidebar-classes";
import type { SidebarProjectBands } from "../../lib/sidebar-derived";
import type { WsRow } from "../../lib/sidebar-types";
import { cn } from "../../ui/cn";
import { RepoTile, repoLabel } from "../RepoTile";
import { IconChevronDown, IconEye, IconPlus } from "../icons";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  mb2: {
    marginBottom: "calc(4px * 2)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  flex: {
    display: "flex",
  },
  minW0: {
    minWidth: "0",
  },
  flex01Auto: {
    flex: "0 1 auto",
  },
  itemsBaseline: {
    alignItems: "baseline",
  },
  gap15: {
    gap: "calc(4px * 1.5)",
  },
  desktopGap9px: {
    "@media (min-width: 721px)": {
      gap: "9px",
    },
  },
  relative: {
    position: "relative",
  },
  mlAuto: {
    marginLeft: "auto",
  },
  inlineFlex: {
    display: "inline-flex",
  },
  size7: {
    width: "calc(4px * 7)",
    height: "calc(4px * 7)",
  },
  shrink0: {
    flexShrink: "0",
  },
  itemsCenter: {
    alignItems: "center",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  roundedMd: {
    borderRadius: "calc(7px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  opacity100: {
    opacity: "100%",
  },
  transitionOpacityColor: {
    transitionProperty: "opacity,color",
    transitionTimingFunction: "var(--tw-ease, var(--ease))",
    transitionDuration: "var(--tw-duration, var(--dur-micro))",
  },
  duration150: {
    transitionDuration: "150ms",
  },
  hoverTextFg: {
    "@media (hover: hover)": {
      ":hover": {
        color: "var(--text)",
      },
    },
  },
  focusVisibleOpacity100: {
    ":focus-visible": {
      opacity: "100%",
    },
  },
  mdOpacity0: {
    "@media (min-width: 48rem)": {
      opacity: "0%",
    },
  },
  beforeAbsolute: {
    "::before": {
      content: '""',
      position: "absolute",
    },
  },
  beforeInset05: {
    "::before": {
      content: '""',
      inset: "calc(4px * 0.5)",
    },
  },
  beforeZ0: {
    "::before": {
      content: '""',
      zIndex: "0",
    },
  },
  beforeRoundedSm: {
    "::before": {
      content: '""',
      borderRadius: "calc(4px * var(--rf))",
      cornerShape: "var(--cs)",
    },
  },
  beforeCornerShapeVarCs: {
    "::before": {
      content: '""',
      cornerShape: "var(--cs)",
    },
  },
  beforeTransitionBackground: {
    "::before": {
      content: '""',
      transitionProperty: "background",
      transitionTimingFunction: "var(--tw-ease, var(--ease))",
      transitionDuration: "var(--tw-duration, var(--dur-micro))",
    },
  },
  beforeContent: {
    "::before": {
      content: "''",
    },
  },
  hoverBeforeBgHover: {
    "@media (hover: hover)": {
      "::before": {
        content: '""',
        backgroundColor: "var(--hover)",
      },
    },
  },
  mt05: {
    marginTop: "calc(4px * 0.5)",
  },
});

interface ProjectBandRenderers {
  workspaceGrouping: (
    rows: WsRow[],
    namespace: string,
    snoozedRows: WsRow[],
    laneRepo?: string,
    prItems?: ReviewQueueItem[],
  ) => React.ReactNode;
  labeledLane: (input: {
    label: string;
    name: string;
    rows: WsRow[];
    prs?: ReviewQueueItem[];
    ns?: string;
    renderRow?: (row: WsRow) => React.ReactNode;
  }) => React.ReactNode;
  workspaceRow: (row: WsRow) => React.ReactNode;
  reviewWorkspaceRow: (row: WsRow) => React.ReactNode;
  prRow: (item: ReviewQueueItem) => React.ReactNode;
}

interface ProjectBandSelection {
  workspaceRow: (row: WsRow) => boolean;
  prRow: (item: ReviewQueueItem) => boolean;
}

interface ProjectBandDrag {
  repoKey: string | null;
  move: (
    targetRepo: string,
    order: string[],
    fullOrder: string[],
    event: React.DragEvent<HTMLDivElement>,
  ) => void;
  start: (
    repo: string,
    fullOrder: string[],
    order: string[],
    event: React.DragEvent<HTMLButtonElement>,
  ) => void;
  finish: (commit: boolean) => void;
  swallowClick: (event: React.MouseEvent) => void;
}

export function ProjectBands({
  projects,
  askBand,
  borrowedLens,
  isOpen,
  onToggleGroup,
  onOpenNewSessionInRepo,
  renderers,
  selection,
  drag,
}: {
  projects: SidebarProjectBands;
  askBand: string;
  borrowedLens: boolean;
  isOpen: (key: string) => boolean;
  onToggleGroup: (key: string) => void;
  onOpenNewSessionInRepo: (repo: string) => void;
  renderers: ProjectBandRenderers;
  selection: ProjectBandSelection;
  drag: ProjectBandDrag;
}) {
  return (
    <>
      {(projects.scratchRows.length > 0 ||
        projects.scratchSnoozedRows.length > 0) && (
        <div {...stylex.props(sx.mb2)} data-sidebar-scratch-workspaces>
          {renderers.workspaceGrouping(
            projects.scratchRows,
            "scratch::",
            projects.scratchSnoozedRows,
          )}
        </div>
      )}
      {/* Every band after the first opens with whitespace, whatever precedes
          it: a sibling band, this drag-reorder list, or the loose workspace rows
          above it. A sibling-only selector previously missed feed projects that
          follow this list, making them read as another row in the prior band.
          The gap is wider than a band's rows and lane headers by enough to
          separate one project from the next. */}
      <div className="[&:not(:first-child)]:mt-4">
        {projects.bands.map((project) => {
          // What a collapsed band must not swallow. A row waiting for input
          // and a review being asked of you are both blocked on you. A question
          // counts whoever minted the session, including machine-started rows.
          const gkey = `repo:${project.repo}`;
          const open = isOpen(gkey);
          // A collapsed band still surfaces the selected row(s) so the open
          // session never hides, without force-opening the band. Review rows
          // keep their renderer so a click still opens Review.
          const selectedRows = open
            ? []
            : [
                ...project.rows,
                ...project.snoozedRows,
                ...project.awaitingReviewRows,
              ].filter(selection.workspaceRow);
          const selectedReviewRows = open
            ? []
            : [...project.needsReviewRows, ...project.approvedRows].filter(
                selection.workspaceRow,
              );
          const selectedPrs = open
            ? []
            : [...project.prs, ...project.requestedPrs].filter(selection.prRow);
          return (
            <div
              className={cn(
                "[&:not(:first-child)]:mt-4",
                projects.canReorder &&
                  utilityClassName("cursor-grab active:cursor-grabbing"),
                drag.repoKey === project.repo &&
                  "[&>[data-sticky-head]]:rounded-md [&>[data-sticky-head]]:bg-hover [&>[data-sticky-head]]:opacity-50 [&>[data-sticky-head]]:ring-1 [&>[data-sticky-head]]:ring-inset [&>[data-sticky-head]]:ring-line-strong",
              )}
              key={gkey}
              data-repo-id={project.repo}
              onDragOver={(event) =>
                drag.move(
                  project.repo,
                  projects.order,
                  projects.fullOrder,
                  event,
                )
              }
              onDrop={(event) => {
                event.preventDefault();
                drag.finish(true);
              }}
              onClickCapture={drag.swallowClick}
            >
              <button
                className={cn(
                  SIDEBAR_GROUP_HEADER,
                  SIDEBAR_GROUP_HEADER_INSET,
                  SIDEBAR_HEADER_ROW,
                  utilityClassName("group transition-colors"),
                  SIDEBAR_STICKY_LANE,
                  SIDEBAR_STUCK_BACKING,
                )}
                data-sticky-head
                draggable={projects.canReorder && project.repo !== askBand}
                title={
                  projects.canReorder && project.repo !== askBand
                    ? "Drag to reorder repositories"
                    : undefined
                }
                onDragStart={(event) =>
                  drag.start(
                    project.repo,
                    projects.fullOrder,
                    projects.order,
                    event,
                  )
                }
                onDragEnd={() => drag.finish(false)}
                onClick={() => onToggleGroup(gkey)}
              >
                {/* The rail holds the tile on the same column as every other
                    header's mark. Ask has no repo and so has no tile. Its eye is
                    the same mark the palette and composer use for that mode, so
                    the band reads as Ask sessions rather than a project named Ask. */}
                <span className={SIDEBAR_RAIL}>
                  {project.repo === askBand ? (
                    <IconEye
                      size={16}
                      className={mergeStylexOverrideClassName("", sx.textFaint)}
                    />
                  ) : (
                    <RepoTile
                      name={project.repo}
                      className={SIDEBAR_REPO_TILE}
                    />
                  )}
                </span>
                {/* The differently sized name and count share a baseline while
                    the pair stays vertically centred against the tile. */}
                <span
                  {...stylex.props(
                    sx.flex,
                    sx.minW0,
                    sx.flex01Auto,
                    sx.itemsBaseline,
                    sx.gap15,
                    sx.desktopGap9px,
                  )}
                >
                  <span
                    className={cn(
                      SIDEBAR_GROUP_NAME,
                      utilityClassName("flex-[0_1_auto] font-semibold"),
                    )}
                  >
                    {project.repo === askBand ? "Ask" : repoLabel(project.repo)}
                  </span>
                  <span
                    className={cn(
                      SIDEBAR_GROUP_COUNT,
                      utilityClassName("shrink-0"),
                    )}
                  >
                    {project.rows.length +
                      project.snoozedRows.length +
                      project.needsReviewRows.length +
                      project.approvedRows.length +
                      project.awaitingReviewRows.length +
                      project.prs.length +
                      project.requestedPrs.length}
                  </span>
                </span>
                {/* Work blocked on you must not vanish into a closed band. The
                    header carries the count of rows waiting for input and of
                    reviews being asked of you. */}
                {!open && project.urgent > 0 && (
                  <span
                    className={cn(
                      SIDEBAR_ATTN_COUNT,
                      utilityClassName("bg-blue"),
                    )}
                    aria-label={`${project.urgent} waiting on you`}
                  >
                    {project.urgent}
                  </span>
                )}
                <IconChevronDown
                  className={cn(
                    SIDEBAR_GROUP_CHEVRON,
                    !open && SIDEBAR_GROUP_CHEVRON_COLLAPSED,
                  )}
                  size={22}
                  style={{ transform: open ? "none" : "rotate(-90deg)" }}
                />
                {/* Hover action at the far end: start a new session with this
                    repo already selected. It is a span rather than a nested
                    button. The 28px target's wash is inset by 2px because filling
                    its whole height reads as a slab. The proportion matches the
                    shared palette icon button, and corner-shape is restated on
                    the pseudo-element because it does not inherit. */}
                {!borrowedLens && (
                  <span
                    role="button"
                    tabIndex={0}
                    {...mergeStylexProps(
                      "md:group-hover:opacity-100 [&>*]:relative [&>*]:z-[1]",
                      sx.relative,
                      sx.mlAuto,
                      sx.inlineFlex,
                      sx.size7,
                      sx.shrink0,
                      sx.itemsCenter,
                      sx.justifyCenter,
                      sx.roundedMd,
                      sx.textFaint,
                      sx.opacity100,
                      sx.transitionOpacityColor,
                      sx.duration150,
                      sx.hoverTextFg,
                      sx.focusVisibleOpacity100,
                      sx.mdOpacity0,
                      sx.beforeAbsolute,
                      sx.beforeInset05,
                      sx.beforeZ0,
                      sx.beforeRoundedSm,
                      sx.beforeCornerShapeVarCs,
                      sx.beforeTransitionBackground,
                      sx.beforeContent,
                      sx.hoverBeforeBgHover,
                    )}
                    title={
                      project.repo === askBand
                        ? "New Ask session, no repo"
                        : `New session in ${repoLabel(project.repo)}`
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpenNewSessionInRepo(project.repo);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.stopPropagation();
                        onOpenNewSessionInRepo(project.repo);
                      }
                    }}
                  >
                    <IconPlus size={20} />
                  </span>
                )}
              </button>
              {open ? (
                <div {...stylex.props(sx.mt05)}>
                  {renderers.labeledLane({
                    label: "Needs review",
                    name: "needsreview",
                    rows: project.needsReviewRows,
                    prs: project.requestedPrs,
                    ns: `repo:${project.repo}::`,
                    renderRow: renderers.reviewWorkspaceRow,
                  })}
                  {renderers.labeledLane({
                    label: "Approved",
                    name: "approvedreview",
                    rows: project.approvedRows,
                    ns: `repo:${project.repo}::`,
                    renderRow: renderers.reviewWorkspaceRow,
                  })}
                  {renderers.labeledLane({
                    label: "Awaiting review",
                    name: "awaitingreview",
                    rows: project.awaitingReviewRows,
                    ns: `repo:${project.repo}::`,
                  })}
                  {renderers.workspaceGrouping(
                    project.rows,
                    `repo:${project.repo}::`,
                    project.snoozedRows,
                    project.repo,
                    project.prs,
                  )}
                </div>
              ) : (
                (selectedReviewRows.length > 0 ||
                  selectedRows.length > 0 ||
                  selectedPrs.length > 0) && (
                  <div {...stylex.props(sx.mt05)}>
                    {selectedReviewRows.map(renderers.reviewWorkspaceRow)}
                    {selectedRows.map(renderers.workspaceRow)}
                    {selectedPrs.map(renderers.prRow)}
                  </div>
                )
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
