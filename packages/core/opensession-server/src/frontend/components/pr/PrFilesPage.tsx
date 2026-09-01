import type { ComponentProps } from "react";
import type { CommentableDiffOptions } from "../../lib/commentable-diff";
import type {
  DiffFileGroup,
  PrDetails,
  PrDiffResponse,
  ReviewGuideData,
} from "../../lib/types";
import type { sectionsWithPatches } from "../../lib/pr-review-guide";
import { WS_SUMMARY_REVIEW_CANVAS_CLEARANCE } from "../../lib/workspace-summary-classes";
import { CodeFlow } from "../CodeFlow";
import { CommentableDiff } from "../CommentableDiff";
import { DiffPanel } from "../DiffPanel";
import { PrFileTree } from "./PrFileTree";

type DiffSource = "pull-request" | "worktree";
type CodeView = "all" | "guide" | "flow";
type FileTreeMode = ComponentProps<typeof PrFileTree>["mode"];
type GuideSections = ReturnType<typeof sectionsWithPatches>;

interface Props {
  compactToolbar: boolean;
  reviewing: boolean;
  diffSource: DiffSource;
  fileListMode: FileTreeMode | "hidden";
  files: NonNullable<PrDetails["files"]>;
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
  compactToolbar,
  reviewing,
  diffSource,
  fileListMode,
  files,
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
  return (
    <div
      className={`flex min-h-0 flex-1 ${compactToolbar ? `${WS_SUMMARY_REVIEW_CANVAS_CLEARANCE} desktop:flex-none desktop:[--review-file-tree-gap:0px] desktop:[--review-file-tree-top:60px]` : ""}`}
    >
      {diffSource === "pull-request" &&
        fileListMode !== "hidden" &&
        files.length > 0 && (
          <PrFileTree
            files={reviewFiles}
            mode={fileListMode}
            showFileStats={showFileStats}
            onOpenFile={onOpenFile}
          />
        )}

      <main
        // Wide review scrolls the toolbar and canvas in one container. File
        // cards stay in that flow and pass beneath the sticky toolbar.
        className={`min-w-0 flex-1 bg-surface ${compactToolbar ? "overflow-y-visible" : "overflow-y-auto"} ${reviewing ? "pb-24 phone:pb-36" : "pb-4"}`}
      >
        {/* Keep the review canvas close to the viewport edge. The file
            section's own border now carries the shape instead of a wide
            gray gutter around it. */}
        <div
          className={`mx-auto max-w-[1500px] px-2 pb-2 phone:px-1 ${compactToolbar ? "pt-0" : "pt-2"}`}
        >
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
                      {reviewing
                        ? "Review the change by intent rather than alphabetically. Comments stay pending until you finish the review."
                        : "Read the change by intent rather than alphabetically."}
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
  );
}
