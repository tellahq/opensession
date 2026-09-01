import { utilityClassName } from "../../ui/cn";
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
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  py12: {
    paddingBlock: "calc(4px * 12)",
  },
  textCenter: {
    textAlign: "center",
  },
  textSm: {
    fontSize: "var(--type-label)",
    lineHeight: "var(--tw-leading, var(--text-sm--line-height))",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  textRed: {
    color: "var(--red)",
  },
  ml2: {
    marginLeft: "calc(4px * 2)",
  },
  border0: {
    borderStyle: "solid",
    borderWidth: "0px",
  },
  bgTransparent: {
    backgroundColor: "transparent",
  },
  textLink: {
    color: "var(--link)",
  },
  mb4: {
    marginBottom: "calc(4px * 4)",
  },
  roundedSm: {
    borderRadius: "calc(4px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  border: {
    borderStyle: "solid",
    borderWidth: "1px",
  },
  borderLine: {
    borderColor: "var(--border)",
  },
  bgPanel: {
    backgroundColor: "var(--bg-panel)",
  },
  px3: {
    paddingInline: "calc(4px * 3)",
  },
  py2: {
    paddingBlock: "calc(4px * 2)",
  },
  textXs: {
    fontSize: "var(--type-label)",
    lineHeight: "var(--tw-leading, var(--text-xs--line-height))",
  },
  mb7: {
    marginBottom: "calc(4px * 7)",
  },
  grid: {
    display: "grid",
  },
  gridCols54pxMinmax01fr: {
    gridTemplateColumns: "54px minmax(0,1fr)",
  },
  gap4: {
    gap: "calc(4px * 4)",
  },
  px1: {
    paddingInline: "4px",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  leadingRelaxed: {
    lineHeight: "var(--leading-relaxed)",
  },
  m0: {
    margin: "0",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  tracking001em: {
    letterSpacing: "-0.01em",
  },
  textFg: {
    color: "var(--text)",
  },
  mt1: {
    marginTop: "4px",
  },
  maxW680px: {
    maxWidth: "680px",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  mb8: {
    marginBottom: "calc(4px * 8)",
  },
  scrollMt64px: {
    scrollMarginTop: "64px",
  },
  mb3: {
    marginBottom: "calc(4px * 3)",
  },
});

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
      className={utilityClassName(
        `flex min-h-0 flex-1 ${compactToolbar ? `${WS_SUMMARY_REVIEW_CANVAS_CLEARANCE} desktop:flex-none desktop:[--review-file-tree-gap:0px] desktop:[--review-file-tree-top:60px]` : ""}`,
      )}
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
        className={utilityClassName(
          `min-w-0 flex-1 bg-surface ${compactToolbar ? "overflow-y-visible" : "overflow-y-auto"} ${reviewing ? "pb-24 phone:pb-36" : "pb-4"}`,
        )}
      >
        {/* Keep the review canvas close to the viewport edge. The file
            section's own border now carries the shape instead of a wide
            gray gutter around it. */}
        <div
          className={utilityClassName(
            `mx-auto max-w-[1500px] px-2 pb-2 phone:px-1 ${compactToolbar ? "pt-0" : "pt-2"}`,
          )}
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
            <div
              {...stylex.props(sx.py12, sx.textCenter, sx.textSm, sx.textFaint)}
            >
              {diffError ? (
                <>
                  <span {...stylex.props(sx.textRed)}>{diffError}</span>
                  <button
                    {...stylex.props(
                      sx.ml2,
                      sx.border0,
                      sx.bgTransparent,
                      sx.textLink,
                    )}
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
                <div
                  {...stylex.props(
                    sx.mb4,
                    sx.roundedSm,
                    sx.border,
                    sx.borderLine,
                    sx.bgPanel,
                    sx.px3,
                    sx.py2,
                    sx.textXs,
                    sx.textFaint,
                  )}
                >
                  Writing the review guide… You can review the file diff while
                  it groups the change by intent.
                </div>
                <CommentableDiff patch={diff.patch} options={diffOptions} />
              </>
            ) : guideFailed ? (
              <div
                {...stylex.props(
                  sx.py12,
                  sx.textCenter,
                  sx.textSm,
                  sx.textFaint,
                )}
              >
                Couldn't generate a guide for this PR.
                <button
                  {...stylex.props(
                    sx.ml2,
                    sx.border0,
                    sx.bgTransparent,
                    sx.textLink,
                  )}
                  onClick={onRetryGuide}
                >
                  Retry
                </button>
              </div>
            ) : currentGuide ? (
              <>
                <div
                  {...stylex.props(
                    sx.mb7,
                    sx.grid,
                    sx.gridCols54pxMinmax01fr,
                    sx.gap4,
                    sx.px1,
                  )}
                >
                  <div
                    {...stylex.props(
                      sx.fontMedium,
                      sx.leadingRelaxed,
                      sx.textFaint,
                      typography.meta,
                    )}
                  >
                    Review guide
                  </div>
                  <div>
                    <h2
                      {...stylex.props(
                        sx.m0,
                        sx.fontSemibold,
                        sx.tracking001em,
                        sx.textFg,
                        typography.itemTitle,
                      )}
                    >
                      {currentGuide.sections.length} focused review step
                      {currentGuide.sections.length === 1 ? "" : "s"}
                    </h2>
                    <p
                      {...stylex.props(
                        sx.mt1,
                        sx.maxW680px,
                        sx.textXs,
                        sx.leadingRelaxed,
                        sx.textDim,
                      )}
                    >
                      {reviewing
                        ? "Review the change by intent rather than alphabetically. Comments stay pending until you finish the review."
                        : "Read the change by intent rather than alphabetically."}
                    </p>
                  </div>
                </div>
                {guideSections.map((section, index, all) => (
                  <section
                    id={`review-guide-${index}`}
                    {...stylex.props(sx.mb8, sx.scrollMt64px)}
                    key={`${section.title}-${index}`}
                  >
                    <div
                      {...stylex.props(
                        sx.mb3,
                        sx.grid,
                        sx.gridCols54pxMinmax01fr,
                        sx.gap4,
                        sx.px1,
                      )}
                    >
                      <div {...stylex.props(sx.textFaint, typography.meta)}>
                        {String(index + 1).padStart(2, "0")} /{" "}
                        {String(all.length).padStart(2, "0")}
                      </div>
                      <div>
                        <div
                          {...stylex.props(
                            sx.fontSemibold,
                            sx.textFg,
                            typography.itemTitle,
                          )}
                        >
                          {section.title}
                        </div>
                        <div
                          {...stylex.props(
                            sx.mt1,
                            sx.leadingRelaxed,
                            sx.textDim,
                            typography.supporting,
                          )}
                        >
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
