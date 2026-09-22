import { useState, type ComponentProps } from "react";
import type { CommentableDiffOptions } from "../../lib/commentable-diff";
import type {
  DiffFileGroup,
  PrDetails,
  PrDiffResponse,
  ReviewGuideData,
} from "../../lib/types";
import type { sectionsWithPatches } from "../../lib/pr-review-guide";
import { useIsPhone } from "../../hooks/useIsPhone";
import { useActiveReviewFile } from "../../hooks/useActiveReviewFile";
import {
  adjacentReviewFile,
  nextUnreviewedFile,
} from "../../lib/review-navigation";
import { Button } from "../../ui/button";
import { Tooltip } from "../../ui/tooltip";
import { ResponsiveDialog } from "../../ui/sheet";
import {
  IconChevronLeft,
  IconChevronRight,
  IconFile,
  IconX,
  IconArrowDown,
} from "../icons";
import { CodeFlow } from "../CodeFlow";
import { CommentableDiff } from "../DeferredDiff";
import { DiffPanel } from "../DiffPanel";
import { PrFileTree } from "./PrFileTree";

type DiffSource = "pull-request" | "worktree";
type CodeView = "all" | "guide" | "flow";
type FileTreeMode = ComponentProps<typeof PrFileTree>["mode"];
type GuideSections = ReturnType<typeof sectionsWithPatches>;

interface Props {
  diffSource: DiffSource;
  fileListMode: FileTreeMode | "hidden";
  files: NonNullable<PrDetails["files"]>;
  reviewedFiles?: ReadonlySet<string>;
  pendingCount: number;
  reviewProvider?: string;
  onFinishReview: () => void;
  reviewFiles: NonNullable<PrDetails["files"]>;
  showFileStats: boolean;
  onOpenFile: (path: string) => void;
  sessionId: string;
  sessionRunning: boolean;
  canSend: boolean;
  send: ComponentProps<typeof DiffPanel>["send"];
  activeRepoId?: string;
  worktreeToolbarTarget: HTMLDivElement | null;
  onDiffSourceChange: (source: DiffSource) => void;
  codeView: CodeView;
  codeFlowData: ComponentProps<typeof CodeFlow>["data"];
  codeFlowLoading: boolean;
  codeFlowError: string | null;
  onRetryCodeFlow: () => void;
  diff: PrDiffResponse | null;
  diffOptions: CommentableDiffOptions | null;
  diffError: string | null;
  diffLoading: boolean;
  diffOutOfDate: boolean;
  onRetryDiff: () => void;
  guideLoading: boolean;
  currentGuide: ReviewGuideData | null;
  guideFailed: boolean;
  onRetryGuide: () => void;
  guideSections: GuideSections;
  grouping: "none" | "ai";
  diffGroups: { oid: string; groups: DiffFileGroup[] | null } | null;
  diffGroupsLoading: boolean;
}

/** The changed-files page, including worktree, guide, and code-flow lenses. */
export function PrFilesPage({
  diffSource,
  fileListMode,
  files,
  reviewedFiles,
  pendingCount,
  reviewProvider,
  onFinishReview,
  reviewFiles,
  showFileStats,
  onOpenFile,
  sessionId,
  sessionRunning,
  canSend,
  send,
  activeRepoId,
  worktreeToolbarTarget,
  onDiffSourceChange,
  codeView,
  codeFlowData,
  codeFlowLoading,
  codeFlowError,
  onRetryCodeFlow,
  diff,
  diffOptions,
  diffError,
  diffLoading,
  diffOutOfDate,
  onRetryDiff,
  guideLoading,
  currentGuide,
  guideFailed,
  onRetryGuide,
  guideSections,
  grouping,
  diffGroups,
  diffGroupsLoading,
}: Props) {
  const isPhone = useIsPhone();
  const [filesOpen, setFilesOpen] = useState(false);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const { activeFile, selectFile } = useActiveReviewFile(scroller);
  const paths = reviewFiles.map((file) => file.path);
  const previous = adjacentReviewFile(paths, activeFile, -1);
  const next = adjacentReviewFile(paths, activeFile, 1);
  const unreviewed = reviewedFiles
    ? nextUnreviewedFile(paths, activeFile, reviewedFiles)
    : null;
  const reviewedCount = files.filter((file) =>
    reviewedFiles?.has(file.path),
  ).length;
  const navigate = (path: string | null) => {
    if (!path) return;
    onOpenFile(path);
    selectFile(path);
    setFilesOpen(false);
  };
  const navigator = (
    <PrFileTree
      files={reviewFiles}
      mode={fileListMode === "hidden" ? "tree" : fileListMode}
      showFileStats={showFileStats}
      layout={filesOpen ? "sheet" : "sidebar"}
      activeFile={activeFile}
      reviewedFiles={reviewedFiles}
      onOpenFile={navigate}
    />
  );

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(event) => {
        if (
          diffSource !== "pull-request" ||
          codeView === "flow" ||
          event.defaultPrevented ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey
        )
          return;
        if (
          event.nativeEvent
            .composedPath()
            .some(
              (target) =>
                target instanceof HTMLElement &&
                (target.matches(
                  "input, textarea, select, [role=tree], [role=treeitem], [role=dialog]",
                ) ||
                  target.isContentEditable),
            )
        )
          return;
        const path =
          event.key === "j"
            ? next
            : event.key === "k"
              ? previous
              : event.key === "n"
                ? unreviewed
                : null;
        if (!path) return;
        event.preventDefault();
        navigate(path);
      }}
    >
      {diffSource === "pull-request" && !isPhone && (
        <div
          className="flex shrink-0 flex-wrap items-center gap-2 px-3 pb-2 phone:gap-1"
          aria-label="Review navigation"
        >
          {(isPhone || fileListMode === "hidden") && (
            <Button
              variant="soft"
              size="sm"
              className="phone:min-h-11"
              icon={<IconFile size={18} />}
              onClick={() => setFilesOpen(true)}
            >
              Files
            </Button>
          )}
          <span
            className="mr-auto text-supporting tabular-nums text-dim"
            role="status"
          >
            {reviewedFiles
              ? `${reviewedCount}/${files.length} reviewed`
              : `${files.length} files`}
          </span>
          {codeView !== "flow" && (
            <>
              <Tooltip label="Previous file (K)">
                <Button
                  variant="ghost"
                  size="sm"
                  className="phone:size-11"
                  aria-label="Previous file"
                  aria-keyshortcuts="k"
                  disabled={!previous}
                  onClick={() => navigate(previous)}
                  icon={<IconChevronLeft size={18} />}
                />
              </Tooltip>
              <Tooltip label="Next file (J)">
                <Button
                  variant="ghost"
                  size="sm"
                  className="phone:size-11"
                  aria-label="Next file"
                  aria-keyshortcuts="j"
                  disabled={!next}
                  onClick={() => navigate(next)}
                  icon={<IconChevronRight size={18} />}
                />
              </Tooltip>
              {reviewedFiles && (
                <Tooltip label="Next unreviewed file (N)">
                  <Button
                    variant="soft"
                    size="sm"
                    className="phone:order-2 phone:min-h-11"
                    aria-keyshortcuts="n"
                    disabled={!unreviewed}
                    onClick={() => navigate(unreviewed)}
                  >
                    Next unreviewed
                  </Button>
                </Tooltip>
              )}
            </>
          )}
          {reviewProvider && (
            <span className="text-supporting text-faint phone:order-1 phone:min-w-[50%] phone:flex-1">
              {pendingCount > 0
                ? `${pendingCount} pending comment${pendingCount === 1 ? "" : "s"} · `
                : ""}
              Sent to {reviewProvider} on finish
            </span>
          )}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {diffSource === "pull-request" &&
          !isPhone &&
          !filesOpen &&
          fileListMode !== "hidden" &&
          files.length > 0 &&
          navigator}
        {filesOpen && (
          <ResponsiveDialog
            open={filesOpen}
            phone={isPhone}
            onClose={() => setFilesOpen(false)}
            label="Changed files"
            sheetClassName="h-[75dvh]"
            modalClassName="h-[70dvh] w-[420px]"
          >
            <div className="flex items-center justify-between px-3 pt-2">
              <h2 className="text-item-title font-medium">Changed files</h2>
              <Button
                variant="ghost"
                className="size-11"
                aria-label="Close files"
                icon={<IconX size={20} />}
                onClick={() => setFilesOpen(false)}
              />
            </div>
            <div className="flex shrink-0 items-center gap-2 px-3 pb-2">
              <span className="mr-auto text-supporting text-dim" role="status">
                {reviewedFiles
                  ? `${reviewedCount}/${files.length} reviewed`
                  : `${files.length} files`}
              </span>
              {codeView !== "flow" && (
                <>
                  <Button
                    variant="ghost"
                    className="size-11"
                    aria-label="Previous file"
                    disabled={!previous}
                    onClick={() => navigate(previous)}
                    icon={<IconChevronLeft size={18} />}
                  />
                  <Button
                    variant="ghost"
                    className="size-11"
                    aria-label="Next file"
                    disabled={!next}
                    onClick={() => navigate(next)}
                    icon={<IconChevronRight size={18} />}
                  />
                </>
              )}
            </div>
            {navigator}
          </ResponsiveDialog>
        )}
        <main
          ref={setScroller}
          className="min-w-0 min-h-0 flex-1 overflow-y-auto bg-surface pb-4"
          aria-label="File changes"
        >
          <div className="px-2 pb-2 phone:px-0">
            {diffSource === "worktree" ? (
              <DiffPanel
                sessionId={sessionId}
                isRunning={sessionRunning}
                canSend={canSend}
                send={send}
                repo={activeRepoId}
                toolbarTarget={worktreeToolbarTarget}
                source="worktree"
                onSourceChange={onDiffSourceChange}
              />
            ) : codeView === "flow" ? (
              <CodeFlow
                data={codeFlowData}
                loading={codeFlowLoading}
                error={codeFlowError}
                onRetry={onRetryCodeFlow}
                onOpenLocation={onOpenFile}
              />
            ) : !diff?.patch || !diffOptions ? (
              <div className="py-12 text-center text-sm text-faint">
                {diffError ? (
                  <>
                    <span className="text-red">{diffError}</span>
                    <button
                      className="ml-2 border-0 bg-transparent text-link"
                      onClick={onRetryDiff}
                    >
                      Retry
                    </button>
                  </>
                ) : diffLoading ? (
                  "Loading pull request changes…"
                ) : diffOutOfDate ? (
                  "The pull request changed while loading. It will refresh automatically."
                ) : (
                  "No text diff is available for this pull request."
                )}
              </div>
            ) : codeView === "guide" ? (
              guideLoading || (!currentGuide && !guideFailed) ? (
                <>
                  <div className="mb-4 rounded-sm border border-line bg-panel px-3 py-2 text-xs text-faint">
                    Writing the review guide… You can review the file diff while
                    it groups the change by intent.
                  </div>
                  <CommentableDiff patch={diff.patch} options={diffOptions} />
                </>
              ) : guideFailed ? (
                <div className="py-12 text-center text-sm text-faint">
                  Couldn't generate a guide for this PR.
                  <button
                    className="ml-2 border-0 bg-transparent text-link"
                    onClick={onRetryGuide}
                  >
                    Retry
                  </button>
                </div>
              ) : currentGuide ? (
                <>
                  <div className="mb-7 grid grid-cols-[54px_minmax(0,1fr)] gap-4 px-1">
                    <div className="text-meta font-medium leading-relaxed text-faint">
                      Review guide
                    </div>
                    <div>
                      <h2 className="m-0 text-item-title font-semibold tracking-[-0.01em] text-fg">
                        {currentGuide.sections.length} focused review step
                        {currentGuide.sections.length === 1 ? "" : "s"}
                      </h2>
                      <p className="mt-1 max-w-[680px] text-xs leading-relaxed text-dim">
                        Read the change by intent rather than alphabetically.
                      </p>
                    </div>
                  </div>
                  {guideSections.map((section, index, all) => (
                    <section
                      id={`review-guide-${index}`}
                      className="mb-8 scroll-mt-[64px]"
                      key={`${section.title}-${index}`}
                    >
                      <div className="mb-3 grid grid-cols-[54px_minmax(0,1fr)] gap-4 px-1">
                        <div className="text-meta text-faint">
                          {String(index + 1).padStart(2, "0")} /{" "}
                          {String(all.length).padStart(2, "0")}
                        </div>
                        <div>
                          <div className="text-item-title font-semibold text-fg">
                            {section.title}
                          </div>
                          <div className="mt-1 text-supporting leading-relaxed text-dim">
                            {section.explanation}
                          </div>
                        </div>
                      </div>
                      {section.patch && (
                        <CommentableDiff
                          patch={section.patch}
                          options={diffOptions}
                        />
                      )}
                    </section>
                  ))}
                </>
              ) : null
            ) : (
              <CommentableDiff
                patch={diff.patch}
                options={{
                  ...diffOptions,
                  groups:
                    grouping === "ai" && diffGroups?.oid === diff.headRefOid
                      ? diffGroups.groups || undefined
                      : undefined,
                  groupsLoading: grouping === "ai" && diffGroupsLoading,
                }}
              />
            )}
          </div>
        </main>
      </div>
      {isPhone && diffSource === "pull-request" && (
        <div
          aria-label="Review actions"
          className="flex shrink-0 items-center gap-2 bg-surface px-3 pt-2 pb-[max(8px,env(safe-area-inset-bottom))]"
        >
          <Button
            variant="soft"
            className="min-h-11"
            aria-label="Files"
            icon={<IconFile size={20} />}
            onClick={() => setFilesOpen(true)}
          >
            <span className="tabular-nums">
              {reviewedFiles
                ? `${reviewedCount}/${files.length}`
                : files.length}
            </span>
          </Button>
          {reviewProvider && (
            <Button
              variant="primary"
              className="min-h-11 flex-1"
              onClick={onFinishReview}
            >
              Finish review{pendingCount > 0 ? ` (${pendingCount})` : ""}
            </Button>
          )}
          {codeView !== "flow" && reviewedFiles && (
            <Tooltip label="Next unreviewed file">
              <Button
                variant="soft"
                className="size-11"
                aria-label="Next unreviewed"
                disabled={!unreviewed}
                onClick={() => navigate(unreviewed)}
                icon={<IconArrowDown size={20} />}
              />
            </Tooltip>
          )}
        </div>
      )}
    </div>
  );
}
