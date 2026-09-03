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
  IconPlus,
  IconX,
} from "../icons";
import { CheckRow } from "./CheckRow";
import { GitStatusRows } from "./GitStatus";
import { CommitIcon } from "./PrViews";
import { FileRow, ReviewerRow } from "./PrRows";

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
  onStartSession,
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
  /** Open a new session tab in the PR's workspace. */
  onStartSession?: () => void;
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
          <p className="m-0 px-2 pt-1 text-supporting text-red">{mergeError}</p>
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
                  <span className="pr-check-mark-pending animate-[pulse_1.4s_infinite]">
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
              <span className="inline-flex gap-1.5 text-meta tabular-nums">
                {checkSummary.passed > 0 && (
                  <span className="text-green">{checkSummary.passed}</span>
                )}
                {checkSummary.failed > 0 && (
                  <span className="text-red">{checkSummary.failed}</span>
                )}
                {checkSummary.pending > 0 && (
                  <span className="text-yellow">{checkSummary.pending}</span>
                )}
              </span>
            }
          />
          {checksOpen && (
            <div className="mt-1">
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
              <span className="text-faint">
                <CommitIcon />
              </span>
            }
            label={`${commits.length} commit${commits.length === 1 ? "" : "s"}`}
          />
          {commitsOpen && (
            <div className="mt-1 flex flex-col gap-1.5">
              {commits.map((commit) => (
                <div className="flex items-start gap-2 px-1.5" key={commit.oid}>
                  <span className="min-w-0 flex-1">
                    <span
                      className="block truncate text-label text-fg"
                      title={commit.messageHeadline}
                    >
                      {commit.messageHeadline}
                    </span>
                    <span className="block truncate text-meta text-faint">
                      {commit.author}
                    </span>
                    {caps.commitNotes &&
                      commit.notes?.map((note) => (
                        <span
                          className="mt-1 block whitespace-pre-wrap text-supporting leading-relaxed text-dim"
                          key={note.ref}
                        >
                          {note.text}
                        </span>
                      ))}
                  </span>
                  <code className="shrink-0 text-meta text-faint">
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
            icon={<IconFile size={15} className="text-faint" />}
            label={`${files.length} file${files.length === 1 ? "" : "s"}`}
            trailing={
              <span className="inline-flex items-center gap-1.5 text-meta">
                <span className="text-green">+{pr.additions}</span>
                <span className="text-red">−{pr.deletions}</span>
              </span>
            }
          />
          {filesOpen && (
            <div className="mt-1">
              {shownFiles.map((file: PrFile) => (
                <FileRow
                  file={file}
                  key={file.path}
                  onClick={() => onOpenFile(file.path)}
                />
              ))}
              <div className="flex items-center gap-3 px-1.5 pt-1.5">
                {files.length > 8 && (
                  <button
                    className="border-0 bg-transparent p-0 text-meta font-medium text-dim hover:text-fg"
                    onClick={() => setAllFiles((o) => !o)}
                  >
                    {allFiles ? "Show fewer" : `Show all ${files.length}`}
                  </button>
                )}
                <button
                  className="border-0 bg-transparent p-0 text-meta font-medium text-dim hover:text-fg"
                  onClick={onOpenFiles}
                >
                  Open files changed
                </button>
              </div>
            </div>
          )}
        </RailSection>
      )}

      {onStartSession && (
        <RailSection title="Sessions">
          <button
            className={RAIL_ROW}
            onClick={onStartSession}
            title="Open a new session tab on this pull request"
          >
            <span className="inline-flex w-4 shrink-0 items-center justify-center [&>svg]:block">
              <IconPlus size={15} className="text-faint" />
            </span>
            <span className="min-w-0 flex-1 truncate font-medium">
              New session
            </span>
            <IconChevronRight size={14} className="shrink-0 text-faint" />
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
      className="scroll-mt-[72px] border-b border-line py-4 first:pt-0 last:border-b-0"
      ref={ref}
    >
      <div className="mb-1.5 flex items-center gap-2 px-1">
        <h3 className="m-0 text-meta font-semibold text-faint">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function RailGroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-1.5 pb-1 pt-2 text-meta font-semibold text-faint">
      {children}
    </div>
  );
}

/** Shared shape for the rail's one-line summaries, whether they expand in
 *  place or lead somewhere. */
const RAIL_ROW =
  "flex w-full items-center gap-2 rounded-row border-0 bg-transparent px-1.5 py-1.5 text-left text-label text-fg hover:bg-hover";

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
      <span className="inline-flex w-4 shrink-0 items-center justify-center [&>svg]:block">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
      {trailing}
      <IconChevronRight
        size={14}
        className={`shrink-0 text-faint ${open ? "rotate-90" : ""}`}
      />
    </button>
  );
}
