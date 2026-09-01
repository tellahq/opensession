import { mergeStylexProps, mergeStylexOverrideClassName } from "../../ui/cn";
import { utilityClassName } from "../../ui/cn";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import type { Provider } from "../../lib/provider";
import type { checkClass } from "../../lib/pr-status-derive";
import { CHECK_TEXT } from "../../lib/pr-tone-classes";
import type {
  GitStatusInfo,
  PrCheck,
  PrDetails,
  PrFile,
  PrReviewer,
  WSClientMessage,
} from "../../lib/types";
import {
  IconCheck,
  IconChevronRight,
  IconFile,
  IconMessages,
  IconX,
} from "../icons";
import { CheckRow } from "./CheckRow";
import { GitStatusRows } from "./GitStatus";
import { CommitIcon } from "./PrViews";
import { FileRow, ReviewerRow } from "./PrRows";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  m0: {
    margin: "0",
  },
  px2: {
    paddingInline: "calc(4px * 2)",
  },
  pt1: {
    paddingTop: "4px",
  },
  textRed: {
    color: "var(--red)",
  },
  animatePulse14sInfinite: {
    animation: "pulse 1.4s infinite",
  },
  inlineFlex: {
    display: "inline-flex",
  },
  gap15: {
    gap: "calc(4px * 1.5)",
  },
  textGreen: {
    color: "var(--green)",
  },
  textYellow: {
    color: "var(--yellow)",
  },
  mt1: {
    marginTop: "4px",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  flex: {
    display: "flex",
  },
  flexCol: {
    flexDirection: "column",
  },
  itemsStart: {
    alignItems: "flex-start",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  px15: {
    paddingInline: "calc(4px * 1.5)",
  },
  minW0: {
    minWidth: "0",
  },
  flex1: {
    flex: "1",
  },
  block: {
    display: "block",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  textFg: {
    color: "var(--text)",
  },
  whitespacePreWrap: {
    whiteSpace: "pre-wrap",
  },
  leadingRelaxed: {
    lineHeight: "var(--leading-relaxed)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  shrink0: {
    flexShrink: "0",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap3: {
    gap: "calc(4px * 3)",
  },
  pt15: {
    paddingTop: "calc(4px * 1.5)",
  },
  border0: {
    borderStyle: "solid",
    borderWidth: "0px",
  },
  bgTransparent: {
    backgroundColor: "transparent",
  },
  p0: {
    padding: "0",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  hoverTextFg: {
    "@media (hover: hover)": {
      ":hover": {
        color: "var(--text)",
      },
    },
  },
  w4: {
    width: "calc(4px * 4)",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  scrollMt72px: {
    scrollMarginTop: "72px",
  },
  borderB: {
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
  },
  borderLine: {
    borderColor: "var(--border)",
  },
  py4: {
    paddingBlock: "calc(4px * 4)",
  },
  mb15: {
    marginBottom: "calc(4px * 1.5)",
  },
  px1: {
    paddingInline: "4px",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  pb1: {
    paddingBottom: "4px",
  },
  pt2: {
    paddingTop: "calc(4px * 2)",
  },
});

/**
 * The Overview page's metadata column: status, reviewers, checks, commits, the
 * changed files and the sessions on the branch, in the order a reviewer asks
 * about them. Everything countable about a pull request belongs here rather
 * than in the header, which stays one line of identity.
 *
 * Checks and commits used to be top-level tabs of the review canvas. They are
 * rollup rows here that expand in place, because they answer a question
 * ("is it green?", "what landed?") rather than being a place you go.
 *
 * The same component renders stacked above the conversation when the panel is
 * too narrow for a column, so every section has to read as a standalone block
 * at both widths.
 */
export function ReviewRail({
  pr,
  git,
  sessionId,
  repo,
  provider,
  caps,
  checkSummary,
  send,
  onRefresh,
  onMerge,
  merging,
  mergeScheduled,
  mergeError,
  onOpenFile,
  onOpenFiles,
  onOpenSessions,
  sessionCount = 0,
  focusChecksSeq,
  compact,
  className,
}: {
  pr: PrDetails;
  git: GitStatusInfo | null;
  sessionId: string;
  repo?: string;
  provider: Provider;
  caps: { checks: boolean; reviewers: boolean; commitNotes: boolean };
  checkSummary: {
    passed: number;
    failed: number;
    pending: number;
    total: number;
    checks: PrCheck[];
    deployments: PrCheck[];
  };
  send?: (msg: WSClientMessage) => void;
  onRefresh: () => Promise<void> | void;
  onMerge?: () => void;
  merging?: boolean;
  mergeScheduled?: boolean;
  mergeError?: string | null;
  /** Reveal one file in the Files changed page. */
  onOpenFile: (path: string) => void;
  /** Go to the Files changed page. */
  onOpenFiles: () => void;
  /** Open the list of sessions working on this pull request. */
  onOpenSessions?: () => void;
  sessionCount?: number;
  /**
   * A check chip elsewhere in the app asked for the checks. Bumped per click,
   * so asking twice re-reveals the section after the reader scrolled away.
   */
  focusChecksSeq?: number;
  /** Stacked above the conversation rather than beside it: keep it short. */
  compact?: boolean;
  className?: string;
}) {
  const [checksOpen, setChecksOpen] = useState(false);
  const [commitsOpen, setCommitsOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(!compact);
  const [allFiles, setAllFiles] = useState(false);
  const checksRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!focusChecksSeq) return;
    setChecksOpen(true);
    checksRef.current?.scrollIntoView({ block: "center" });
  }, [focusChecksSeq]);

  const reviewers = pr.reviewers || [];
  const commits = pr.commits || [];
  const files = pr.files || [];
  const shownFiles = allFiles ? files : files.slice(0, 8);

  return (
    <aside className={className}>
      <RailSection title="Status">
        <GitStatusRows
          git={git}
          pr={pr}
          sessionId={sessionId}
          repo={repo}
          send={send}
          onRefresh={onRefresh}
          onMerge={onMerge}
          merging={merging}
          mergeScheduled={mergeScheduled}
        />
        {mergeError && (
          <p
            {...stylex.props(
              sx.m0,
              sx.px2,
              sx.pt1,
              sx.textRed,
              typography.supporting,
            )}
          >
            {mergeError}
          </p>
        )}
      </RailSection>

      {caps.reviewers && reviewers.length > 0 && (
        <RailSection title="Reviewers">
          {reviewers.map((reviewer: PrReviewer) => (
            <ReviewerRow
              key={reviewer.login}
              reviewer={reviewer}
              provider={provider}
            />
          ))}
        </RailSection>
      )}

      {caps.checks && checkSummary.total > 0 && (
        <RailSection title="Checks" ref={checksRef}>
          <RollupRow
            open={checksOpen}
            onToggle={() => setChecksOpen((o) => !o)}
            icon={
              <span className={CHECK_TEXT[checksRank(checkSummary)]}>
                {checkSummary.failed > 0 ? (
                  <IconX size={15} />
                ) : checkSummary.pending > 0 ? (
                  <span
                    {...mergeStylexProps(
                      "pr-check-mark-pending",
                      sx.animatePulse14sInfinite,
                    )}
                  >
                    ●
                  </span>
                ) : (
                  <IconCheck size={15} />
                )}
              </span>
            }
            label={
              checkSummary.failed > 0
                ? "Some checks failed"
                : checkSummary.pending > 0
                  ? "Checks running"
                  : "All passed"
            }
            trailing={
              <span
                {...mergeStylexProps(
                  "tabular-nums",
                  sx.inlineFlex,
                  sx.gap15,
                  typography.meta,
                )}
              >
                {checkSummary.passed > 0 && (
                  <span {...stylex.props(sx.textGreen)}>
                    {checkSummary.passed}
                  </span>
                )}
                {checkSummary.failed > 0 && (
                  <span {...stylex.props(sx.textRed)}>
                    {checkSummary.failed}
                  </span>
                )}
                {checkSummary.pending > 0 && (
                  <span {...stylex.props(sx.textYellow)}>
                    {checkSummary.pending}
                  </span>
                )}
              </span>
            }
          />
          {checksOpen && (
            <div {...stylex.props(sx.mt1)}>
              {checkSummary.deployments.length > 0 && (
                <RailGroupLabel>Deployments</RailGroupLabel>
              )}
              {checkSummary.deployments.map((check, index) => (
                <CheckRow check={check} key={`d${index}`} />
              ))}
              {checkSummary.deployments.length > 0 &&
                checkSummary.checks.length > 0 && (
                  <RailGroupLabel>Checks</RailGroupLabel>
                )}
              {checkSummary.checks.map((check, index) => (
                <CheckRow check={check} key={`c${index}`} />
              ))}
            </div>
          )}
        </RailSection>
      )}

      {commits.length > 0 && (
        <RailSection title="Commits">
          <RollupRow
            open={commitsOpen}
            onToggle={() => setCommitsOpen((o) => !o)}
            icon={
              <span {...stylex.props(sx.textFaint)}>
                <CommitIcon />
              </span>
            }
            label={`${commits.length} commit${commits.length === 1 ? "" : "s"}`}
          />
          {commitsOpen && (
            <div {...stylex.props(sx.mt1, sx.flex, sx.flexCol, sx.gap15)}>
              {commits.map((commit) => (
                <div
                  {...stylex.props(sx.flex, sx.itemsStart, sx.gap2, sx.px15)}
                  key={commit.oid}
                >
                  <span {...stylex.props(sx.minW0, sx.flex1)}>
                    <span
                      {...stylex.props(
                        sx.block,
                        sx.truncate,
                        sx.textFg,
                        typography.label,
                      )}
                      title={commit.messageHeadline}
                    >
                      {commit.messageHeadline}
                    </span>
                    <span
                      {...stylex.props(
                        sx.block,
                        sx.truncate,
                        sx.textFaint,
                        typography.meta,
                      )}
                    >
                      {commit.author}
                    </span>
                    {caps.commitNotes &&
                      commit.notes?.map((note) => (
                        <span
                          {...stylex.props(
                            sx.mt1,
                            sx.block,
                            sx.whitespacePreWrap,
                            sx.leadingRelaxed,
                            sx.textDim,
                            typography.supporting,
                          )}
                          key={note.ref}
                        >
                          {note.text}
                        </span>
                      ))}
                  </span>
                  <code
                    {...stylex.props(sx.shrink0, sx.textFaint, typography.meta)}
                  >
                    {commit.oid.slice(0, 7)}
                  </code>
                </div>
              ))}
            </div>
          )}
        </RailSection>
      )}

      {files.length > 0 && (
        <RailSection title="Files">
          <RollupRow
            open={filesOpen}
            onToggle={() => setFilesOpen((o) => !o)}
            icon={
              <IconFile
                size={15}
                className={mergeStylexOverrideClassName("", sx.textFaint)}
              />
            }
            label={`${files.length} file${files.length === 1 ? "" : "s"}`}
            trailing={
              <span
                {...stylex.props(
                  sx.inlineFlex,
                  sx.itemsCenter,
                  sx.gap15,
                  typography.meta,
                )}
              >
                <span {...stylex.props(sx.textGreen)}>+{pr.additions}</span>
                <span {...stylex.props(sx.textRed)}>−{pr.deletions}</span>
              </span>
            }
          />
          {filesOpen && (
            <div {...stylex.props(sx.mt1)}>
              {shownFiles.map((file: PrFile) => (
                <FileRow
                  file={file}
                  key={file.path}
                  onClick={() => onOpenFile(file.path)}
                />
              ))}
              <div
                {...stylex.props(
                  sx.flex,
                  sx.itemsCenter,
                  sx.gap3,
                  sx.px15,
                  sx.pt15,
                )}
              >
                {files.length > 8 && (
                  <button
                    {...stylex.props(
                      sx.border0,
                      sx.bgTransparent,
                      sx.p0,
                      sx.fontMedium,
                      sx.textDim,
                      sx.hoverTextFg,
                      typography.meta,
                    )}
                    onClick={() => setAllFiles((o) => !o)}
                  >
                    {allFiles ? "Show fewer" : `Show all ${files.length}`}
                  </button>
                )}
                <button
                  {...stylex.props(
                    sx.border0,
                    sx.bgTransparent,
                    sx.p0,
                    sx.fontMedium,
                    sx.textDim,
                    sx.hoverTextFg,
                    typography.meta,
                  )}
                  onClick={onOpenFiles}
                >
                  Open files changed
                </button>
              </div>
            </div>
          )}
        </RailSection>
      )}

      {onOpenSessions && (
        <RailSection title="Sessions">
          <button
            className={RAIL_ROW}
            onClick={onOpenSessions}
            title="Sessions working on this pull request"
          >
            <span
              {...mergeStylexProps(
                "[&>svg]:block",
                sx.inlineFlex,
                sx.w4,
                sx.shrink0,
                sx.itemsCenter,
                sx.justifyCenter,
              )}
            >
              <IconMessages
                size={15}
                className={mergeStylexOverrideClassName("", sx.textFaint)}
              />
            </span>
            <span
              {...stylex.props(sx.minW0, sx.flex1, sx.truncate, sx.fontMedium)}
            >
              {sessionCount > 0
                ? `${sessionCount} session${sessionCount === 1 ? "" : "s"}`
                : "No sessions"}
            </span>
            <IconChevronRight
              size={14}
              className={mergeStylexOverrideClassName(
                "",
                sx.shrink0,
                sx.textFaint,
              )}
            />
          </button>
        </RailSection>
      )}
    </aside>
  );
}

function checksRank(summary: {
  failed: number;
  pending: number;
}): ReturnType<typeof checkClass> {
  if (summary.failed > 0) return "check-failure";
  if (summary.pending > 0) return "check-pending";
  return "check-success";
}

function RailSection({
  title,
  action,
  children,
  ref,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  ref?: React.Ref<HTMLElement>;
}) {
  return (
    <section
      {...mergeStylexProps(
        "first:pt-0 last:border-b-0",
        sx.scrollMt72px,
        sx.borderB,
        sx.borderLine,
        sx.py4,
      )}
      ref={ref}
    >
      <div {...stylex.props(sx.mb15, sx.flex, sx.itemsCenter, sx.gap2, sx.px1)}>
        <h3
          {...stylex.props(
            sx.m0,
            sx.fontSemibold,
            sx.textFaint,
            typography.meta,
          )}
        >
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function RailGroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      {...stylex.props(
        sx.px15,
        sx.pb1,
        sx.pt2,
        sx.fontSemibold,
        sx.textFaint,
        typography.meta,
      )}
    >
      {children}
    </div>
  );
}

/** Shared shape for the rail's one-line summaries, whether they expand in
 *  place or lead somewhere. */
const RAIL_ROW = utilityClassName(
  "flex w-full items-center gap-2 rounded-row border-0 bg-transparent px-1.5 py-1.5 text-left text-label text-fg hover:bg-hover",
);

/** A one-line summary that opens its own detail in place. */
function RollupRow({
  open,
  onToggle,
  icon,
  label,
  trailing,
}: {
  open: boolean;
  onToggle: () => void;
  icon: React.ReactNode;
  label: string;
  trailing?: React.ReactNode;
}) {
  return (
    <button className={RAIL_ROW} onClick={onToggle} aria-expanded={open}>
      <span
        {...mergeStylexProps(
          "[&>svg]:block",
          sx.inlineFlex,
          sx.w4,
          sx.shrink0,
          sx.itemsCenter,
          sx.justifyCenter,
        )}
      >
        {icon}
      </span>
      <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate, sx.fontMedium)}>
        {label}
      </span>
      {trailing}
      <IconChevronRight
        size={14}
        className={utilityClassName(
          `shrink-0 text-faint ${open ? "rotate-90" : ""}`,
        )}
      />
    </button>
  );
}
