import React from "react";
import type { ReviewQueueItem } from "../../lib/review-queue";
import {
  SIDEBAR_GROUP_COUNT,
  SIDEBAR_GROUP_NAME,
  SIDEBAR_RAIL,
  SIDEBAR_REPO_TILE,
  sidebarAttnCount,
  sidebarChevron,
  sidebarHeader,
} from "../../lib/sidebar-classes";
import type { SidebarProjectBands } from "../../lib/sidebar-derived";
import type { WsRow } from "../../lib/sidebar-types";
import { cn } from "../../ui/cn";
import { RepoTile, repoLabel } from "../RepoTile";
import { IconChevronDown, IconEye, IconPlus } from "../icons";

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
        <div className="mb-2" data-sidebar-scratch-workspaces>
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
                projects.canReorder && "cursor-grab active:cursor-grabbing",
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
                  sidebarHeader({ kind: "item", sticky: true }),
                  "group transition-colors",
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
                    <IconEye size={20} className="text-faint" />
                  ) : (
                    <RepoTile
                      name={project.repo}
                      className={SIDEBAR_REPO_TILE}
                    />
                  )}
                </span>
                {/* The differently sized name and count share a baseline while
                    the pair stays vertically centred against the tile. */}
                <span className="flex min-w-0 flex-[0_1_auto] items-baseline gap-1.5 desktop:gap-[9px]">
                  <span
                    className={cn(
                      SIDEBAR_GROUP_NAME,
                      "flex-[0_1_auto] font-semibold",
                    )}
                  >
                    {project.repo === askBand ? "Ask" : repoLabel(project.repo)}
                  </span>
                  <span className={cn(SIDEBAR_GROUP_COUNT, "shrink-0")}>
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
                    className={sidebarAttnCount("blue")}
                    aria-label={`${project.urgent} waiting on you`}
                  >
                    {project.urgent}
                  </span>
                )}
                <IconChevronDown
                  className={sidebarChevron(!open)}
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
                    className="relative ml-auto inline-flex size-7 shrink-0 items-center justify-center rounded-md text-faint opacity-100 transition-[opacity,color] duration-150 hover:text-fg focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100 before:absolute before:inset-0.5 before:z-0 before:rounded-sm before:[corner-shape:var(--cs)] before:transition-[background] before:content-[''] hover:before:bg-hover [&>*]:relative [&>*]:z-[1]"
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
                <div className="mt-0.5">
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
                  <div className="mt-0.5">
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
