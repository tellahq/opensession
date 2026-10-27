import { useState, type ComponentProps, type ReactNode } from "react";
import type { CommentableDiffOptions } from "../../lib/commentable-diff";
import type {
  DiffFileGroup,
  PrDetails,
  PrDiffResponse,
  ReviewGuideData,
} from "../../lib/types";
import { Segmented, SegmentedOption } from "../../ui/segmented";
import { cn } from "../../ui/cn";
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
import { IconChevronLeft, IconChevronRight, IconFile, IconX } from "../icons";
import { CodeFlow } from "../CodeFlow";
import { CommentableDiff } from "../DeferredDiff";
import { DiffPanel } from "../DiffPanel";
import { DiffStat } from "../DiffStat";
import { PrFileTree } from "./PrFileTree";
import {
  PHONE_REVIEW_PILL,
  PHONE_REVIEW_PILL_DOCK,
} from "../../lib/phone-review-classes";

type DiffSource = "pull-request" | "worktree";
type CodeView = "all" | "guide" | "flow";
type FileTreeMode = ComponentProps<typeof PrFileTree>["mode"];
type GuideSections = ReturnType<typeof sectionsWithPatches>;

interface Props {
  diffSource: DiffSource;
  fileListMode: FileTreeMode | "hidden";
  files: NonNullable<PrDetails["files"]>;
  reviewedFiles?: ReadonlySet<string>;
  changedFiles?: ReadonlySet<string>;
  onSetReviewed?: (paths: string[], reviewed: boolean) => void;
  /** The page's one grouping: guide sections, or file roles until written. */
  reviewGroups?: DiffFileGroup[];
  groupsFromGuide: boolean;
  removedFiles?: readonly string[];
  resolvedThreadCount: number;
  showReviewThreads: boolean;
  onShowReviewThreadsChange: (show: boolean) => void;
  pendingCount: number;
  reviewProvider?: string;
  onFinishReview: () => void;
  mergeAction: ReactNode;
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
  /** Group the Changes view by reviewGroups. */
  groupDiff: boolean;
}

/** The changed-files page, including worktree, guide, and code-flow lenses. */
export function PrFilesPage({
  diffSource,
  fileListMode,
  files,
  reviewedFiles,
  changedFiles,
  onSetReviewed,
  reviewGroups,
  groupsFromGuide,
  removedFiles,
  resolvedThreadCount,
  showReviewThreads,
  onShowReviewThreadsChange,
  pendingCount,
  reviewProvider,
  onFinishReview,
  mergeAction,
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
  groupDiff,
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
  // The guide reads one step at a time by default, so a large PR is a few
  // focused passes rather than one long scroll. "All steps" keeps the old view.
  const [guideStep, setGuideStep] = useState(0);
  const [guideAllSteps, setGuideAllSteps] = useState(false);
  const guideKey = currentGuide
    ? `${currentGuide.number}\0${guideSections.length}`
    : "";
  const [stepGuideKey, setStepGuideKey] = useState(guideKey);
  if (stepGuideKey !== guideKey) {
    setStepGuideKey(guideKey);
    setGuideStep(0);
  }
  const steppingGuide =
    codeView === "guide" &&
    !guideAllSteps &&
    !!currentGuide &&
    guideSections.length > 1;
  const currentStep = Math.min(
    guideStep,
    Math.max(0, guideSections.length - 1),
  );
  const stepOf = (path: string) =>
    guideSections.findIndex((section) => section.files.includes(path));
  const navigate = (path: string | null) => {
    if (!path) return;
    const step = steppingGuide ? stepOf(path) : -1;
    if (step >= 0 && step !== currentStep) {
      // The file's step has to mount before the diff can scroll to it.
      setGuideStep(step);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => onOpenFile(path)),
      );
    } else onOpenFile(path);
    selectFile(path);
    setFilesOpen(false);
  };
  const showStep = (step: number) => {
    setGuideStep(step);
    scroller?.scrollTo({ top: 0 });
  };
  const navigator = (
    <PrFileTree
      files={reviewFiles}
      mode={fileListMode === "hidden" ? "tree" : fileListMode}
      showFileStats={showFileStats}
      layout={filesOpen ? "sheet" : "sidebar"}
      activeFile={activeFile}
      reviewedFiles={reviewedFiles}
      changedFiles={changedFiles}
      onSetReviewed={onSetReviewed}
      groups={reviewGroups}
      leftoverTitle={
        groupsFromGuide && currentGuide?.stale
          ? "New since the guide"
          : "Everything else"
      }
      removedFiles={removedFiles}
      onOpenFile={navigate}
    />
  );

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
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
          <div className="mr-auto flex items-center gap-2.5 text-supporting">
            <span className="tabular-nums text-dim" role="status">
              {reviewedFiles
                ? `${reviewedCount}/${files.length} reviewed`
                : `${files.length} files`}
            </span>
            {/* Phone carries the same stat in its header subtitle. */}
            {diffSource === "pull-request" && !isPhone && (
              <DiffStat files={files} />
            )}
          </div>
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
          {pendingCount > 0 && (
            <span className="text-supporting text-faint">
              {pendingCount} pending comment{pendingCount === 1 ? "" : "s"}
            </span>
          )}
          {resolvedThreadCount > 0 && codeView !== "flow" && (
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={showReviewThreads}
              onClick={() => onShowReviewThreadsChange(!showReviewThreads)}
            >
              {showReviewThreads
                ? "Hide resolved comments"
                : `Show ${resolvedThreadCount} resolved`}
            </Button>
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
          className={cn(
            "min-w-0 min-h-0 flex-1 overflow-y-auto bg-surface pb-4",
            // Room for the floating review pill to clear the last line.
            isPhone &&
              diffSource === "pull-request" &&
              "pb-[calc(88px+env(safe-area-inset-bottom))]",
          )}
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
                    Writing the review guide… Files are grouped by type until it
                    groups the change by intent.
                  </div>
                  <CommentableDiff
                    patch={diff.patch}
                    options={{
                      ...diffOptions,
                      groups: reviewGroups,
                      groupsSource: "rules",
                    }}
                  />
                </>
              ) : guideFailed ? (
                <>
                  <div className="mb-4 rounded-sm border border-line bg-panel px-3 py-2 text-xs text-faint">
                    Couldn't write a guide for this PR. Files are grouped by
                    type instead.
                    <button
                      className="ml-2 border-0 bg-transparent text-link"
                      onClick={onRetryGuide}
                    >
                      Retry
                    </button>
                  </div>
                  <CommentableDiff
                    patch={diff.patch}
                    options={{
                      ...diffOptions,
                      groups: reviewGroups,
                      groupsSource: "rules",
                    }}
                  />
                </>
              ) : currentGuide ? (
                <>
                  <div className="mb-5 grid grid-cols-[54px_minmax(0,1fr)] gap-4 px-1">
                    <div className="text-meta font-medium leading-relaxed text-faint">
                      Review guide
                    </div>
                    <div className="flex flex-col gap-3">
                      <div className="flex flex-wrap items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <h2 className="m-0 text-item-title font-semibold tracking-[-0.01em] text-fg">
                            {currentGuide.sections.length} focused review step
                            {currentGuide.sections.length === 1 ? "" : "s"}
                          </h2>
                          <p className="mt-1 max-w-[680px] text-xs leading-relaxed text-dim">
                            {currentGuide.stale
                              ? "Written before the latest commits. Updating to cover them…"
                              : "Read the change by intent rather than alphabetically."}
                          </p>
                        </div>
                        {guideSections.length > 1 && (
                          <Segmented
                            label="Guide layout"
                            size="sm"
                            value={guideAllSteps ? "all" : "step"}
                            onValueChange={(next) =>
                              setGuideAllSteps(next === "all")
                            }
                          >
                            <SegmentedOption value="step">
                              One step
                            </SegmentedOption>
                            <SegmentedOption value="all">
                              All steps
                            </SegmentedOption>
                          </Segmented>
                        )}
                      </div>
                      {steppingGuide && (
                        <nav
                          aria-label="Guide steps"
                          className="flex flex-wrap gap-1.5"
                        >
                          {guideSections.map((section, index) => {
                            const reviewed = reviewedFiles
                              ? section.files.filter((path) =>
                                  reviewedFiles.has(path),
                                ).length
                              : 0;
                            const done =
                              !!reviewedFiles &&
                              section.files.length > 0 &&
                              reviewed === section.files.length;
                            return (
                              <Button
                                key={`${section.title}-${index}`}
                                variant={
                                  index === currentStep ? "soft" : "ghost"
                                }
                                size="sm"
                                aria-current={
                                  index === currentStep ? "step" : undefined
                                }
                                className="max-w-[260px] phone:min-h-11"
                                onClick={() => showStep(index)}
                              >
                                <span className="tabular-nums text-faint">
                                  {index + 1}
                                </span>
                                <span className="min-w-0 truncate">
                                  {section.title}
                                </span>
                                {reviewedFiles && (
                                  <span
                                    className={cn(
                                      "text-meta tabular-nums",
                                      done ? "text-green" : "text-faint",
                                    )}
                                  >
                                    {reviewed}/{section.files.length}
                                  </span>
                                )}
                              </Button>
                            );
                          })}
                        </nav>
                      )}
                    </div>
                  </div>
                  {guideSections.map((section, index, all) =>
                    steppingGuide && index !== currentStep ? null : (
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
                    ),
                  )}
                  <div className="mb-6 grid grid-cols-[54px_minmax(0,1fr)] gap-4 px-1">
                    <div />
                    {steppingGuide && currentStep < guideSections.length - 1 ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          variant="soft"
                          className="phone:min-h-11"
                          icon={<IconChevronRight size={18} />}
                          onClick={() => showStep(currentStep + 1)}
                        >
                          Next: {guideSections[currentStep + 1].title}
                        </Button>
                        {reviewedFiles && onSetReviewed && (
                          <Button
                            variant="ghost"
                            className="phone:min-h-11"
                            onClick={() => {
                              onSetReviewed(
                                guideSections[currentStep].files.filter(
                                  (path) => !reviewedFiles.has(path),
                                ),
                                true,
                              );
                              showStep(currentStep + 1);
                            }}
                          >
                            Mark step reviewed and continue
                          </Button>
                        )}
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="text-supporting text-dim">
                          You've reached the end of the guide.
                        </span>
                        {reviewProvider && !isPhone && (
                          <Button
                            variant="primary"
                            size="sm"
                            onClick={onFinishReview}
                          >
                            Finish review
                            {pendingCount > 0 ? ` (${pendingCount})` : ""}
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                </>
              ) : null
            ) : (
              <CommentableDiff
                patch={diff.patch}
                options={{
                  ...diffOptions,
                  groups: groupDiff ? reviewGroups : undefined,
                  groupsSource: groupsFromGuide ? "ai" : "rules",
                  groupsLoading: groupDiff && guideLoading,
                }}
              />
            )}
          </div>
        </main>
      </div>
      {isPhone &&
        diffSource === "pull-request" && (
          // One floating pill over the diff, the way GitHub's app does it: the
          // code keeps the full height and the review actions stay in reach.
          // The green merge action rides at the end, beside Finish review.
          <div aria-label="Review actions" className={PHONE_REVIEW_PILL_DOCK}>
            <div className={PHONE_REVIEW_PILL}>
              <Button
                variant="ghost"
                className="min-h-11 rounded-[999px] px-3"
                aria-label={
                  reviewedFiles
                    ? `Files, ${reviewedCount} of ${files.length} reviewed`
                    : `Files, ${files.length}`
                }
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
                  className="min-h-11 rounded-[999px] px-4"
                  onClick={onFinishReview}
                >
                  Finish review{pendingCount > 0 ? ` (${pendingCount})` : ""}
                </Button>
              )}
              {mergeAction}
            </div>
          </div>
        )}
    </div>
  );
}
