import { repoLabel } from "../lib/repo-label";
import React, { useEffect, useState, useCallback, startTransition } from "react";
import type { DiffFileGroup, RepoDiff } from "../lib/types";
import {
  API_BASE,
  fetchDiff,
  fetchDiffGroups,
  discardDiffFile,
  fetchWorktreeFile,
  saveWorktreeFile,
} from "../lib/api";
import { CommentableDiff, type CommentTarget } from "./CommentableDiff";
import { getCurrentUser } from "./UserPicker";
import { Tooltip } from "../ui/tooltip";
import { Button } from "../ui/button";
import { PixelSpinner } from "./PixelSpinner";
import { AGENT_NAME } from "../lib/brand";

interface Props {
  sessionId: string;
  isRunning: boolean;
  canSend: boolean;
  send: (msg: any) => void;
  /** Shared diff state (lifted so the Changes tab badge and this panel poll
   *  once, not twice). When omitted, the panel fetches on its own. */
  diff?: SessionDiffState;
}

export interface SessionDiffState {
  repos: RepoDiff[] | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/**
 * Fetch + poll a session's live worktree diff. Used both by the DiffPanel and
 * by SessionViewer (to show the changed-file count on the Changes tab) — sharing
 * one hook means one poll instead of two racing fetches of the same big patch.
 * `enabled: false` parks it (no fetch) so callers can gate on panel visibility.
 */
export function useSessionDiff(
  sessionId: string,
  opts: { enabled?: boolean; isRunning: boolean },
): SessionDiffState {
  const { enabled = true, isRunning } = opts;
  const [repos, setRepos] = useState<RepoDiff[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await fetchDiff(sessionId);
      if (data.error) throw new Error(data.error);
      // @pierre/diffs renders on the main thread (disableWorkerPool) and
      // parsePatchFiles runs during render, so committing a large diff is a long,
      // uninterruptible task. Commit it as a transition so an urgent interaction —
      // e.g. clicking the panel toggle to close — preempts it instead of waiting
      // for the whole diff to parse and paint. If the user closes the panel before
      // this render commits, React discards it and the panel closes instantly.
      startTransition(() => {
        setRepos(data.repos || []);
        setError(null);
        setLoading(false);
      });
    } catch (e: any) {
      setError(e.message);
      setLoading(false);
    }
  }, [sessionId]);

  // Switching sessions: drop the previous session's diff so a stale count/patch
  // doesn't flash before the new fetch lands.
  useEffect(() => {
    setRepos(null);
    setError(null);
    setLoading(true);
  }, [sessionId]);

  useEffect(() => {
    if (!enabled) return;
    load();
    // Keep the diff fresh while the agent is working
    const interval = setInterval(load, isRunning ? 8000 : 30000);
    return () => clearInterval(interval);
  }, [load, isRunning, enabled]);

  return { repos, loading, error, reload: load };
}

export function DiffPanel({ sessionId, isRunning, canSend, send, diff }: Props) {
  const [active, setActive] = useState(0);
  const [groups, setGroups] = useState<{
    repo: string;
    patch: string;
    groups: DiffFileGroup[] | null;
  } | null>(null);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [groupsRetry, setGroupsRetry] = useState(0);
  // Use the caller's shared diff state when given; otherwise self-poll.
  const self = useSessionDiff(sessionId, { enabled: !diff, isRunning });
  const { repos, loading, error, reload } = diff ?? self;

  const changed = (repos || []).filter(
    (repo) => repo.diff.rawPatch?.trim() || repo.diff.files.length > 0,
  );
  const cur = changed[Math.min(active, changed.length - 1)] || changed[0] || null;
  const groupPatch = cur?.diff.rawPatch || "";
  const groupFileCount = cur?.diff.files.length || 0;

  useEffect(() => {
    if (!cur || !groupPatch || groupFileCount < 3) {
      setGroups(null);
      setGroupsLoading(false);
      return;
    }
    let live = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    setGroups(null);
    setGroupsLoading(true);
    const retryLater = () => {
      retryTimer = setTimeout(() => setGroupsRetry((attempt) => attempt + 1), 125_000);
    };
    fetchDiffGroups(sessionId, cur.repo, cur.diff.files, groupPatch)
      .then((result) => {
        if (!live) return;
        setGroups({ repo: cur.repo, patch: groupPatch, groups: result.groups });
        if (!result.groups) retryLater();
      })
      .catch(() => {
        if (!live) return;
        setGroups({ repo: cur.repo, patch: groupPatch, groups: null });
        retryLater();
      })
      .finally(() => {
        if (live) setGroupsLoading(false);
      });
    return () => {
      live = false;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [sessionId, cur?.repo, groupPatch, groupFileCount, groupsRetry]);

  async function handleDiscard(repo: string, path: string, oldPath?: string) {
    await discardDiffFile(sessionId, path, repo, oldPath);
    // Reflect the reverted file immediately (don't wait for the poll).
    await reload();
  }

  // Files the human edited in place (Changes-tab edit mode). Saves only touch
  // the worktree — nothing is committed — so we offer a one-click note that
  // tells the agent about the hand-edits (it reviews them and folds them into
  // its next commit). Cleared per session and once sent.
  const [handEdited, setHandEdited] = useState<{ repo: string; path: string }[]>([]);
  useEffect(() => setHandEdited([]), [sessionId]);
  const recordHandEdit = (repo: string, path: string) =>
    setHandEdited((prev) =>
      prev.some((e) => e.repo === repo && e.path === path)
        ? prev
        : [...prev, { repo, path }],
    );
  function tellAgentAboutEdits() {
    if (!canSend || !handEdited.length) return;
    const list = handEdited
      .map((e) => `- \`${e.path}\` (${e.repo} repo)`)
      .join("\n");
    send({
      type: "prompt",
      sessionId,
      user: getCurrentUser(),
      content:
        `${getCurrentUser()} hand-edited these files directly in the worktree via the Changes tab editor:\n\n${list}\n\n` +
        `Review the edits, keep them (don't revert them unless they're clearly broken), and include them in your next commit on this branch.`,
    });
    setHandEdited([]);
  }

  async function handleComment(repo: string, target: CommentTarget, text: string) {
    if (!canSend) throw new Error(`${AGENT_NAME} is busy. Wait for the current run to finish.`);
    const lines =
      target.startLine === target.endLine
        ? `line ${target.startLine}`
        : `lines ${target.startLine}–${target.endLine}`;
    send({
      type: "prompt",
      sessionId,
      user: getCurrentUser(),
      content:
        `Diff feedback from ${getCurrentUser()} on \`${target.path}\` (${lines}` +
        `${target.side === "deletions" ? ", removed lines" : ""}) in the **${repo}** repo's current diff:\n\n` +
        `${text}\n\n` +
        `Please address this in the ${repo} worktree on the current branch.`,
    });
  }

  if (loading) return <div className="panel-placeholder">Loading diff…</div>;
  if (error) return <div className="panel-placeholder panel-error">{error}</div>;
  if (!repos || !repos.length) return <DiffEmptyState isRunning={isRunning} />;

  // Repos that actually have changes; if none, show the empty state.
  if (!changed.length) return <DiffEmptyState isRunning={isRunning} />;

  const multi = changed.length > 1;
  if (!cur) return <DiffEmptyState isRunning={isRunning} />;
  const d = cur.diff;

  return (
    <div className="diff-panel flex min-h-0 flex-col">
      {multi && (
        <div className="diff-repo-tabs sticky top-0 z-[2] flex gap-1 overflow-x-auto border-b border-line bg-raised px-2.5 py-1.5">
          {changed.map((r, i) => {
            const n = r.diff.totalAdditions + r.diff.totalDeletions;
            return (
              <button
                key={r.repo}
                className={`diff-repo-tab inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm border border-transparent bg-transparent px-2.5 py-[3px] text-label text-dim hover:text-fg ${i === active ? "diff-repo-tab-active border-line bg-panel text-fg" : ""}`}
                onClick={() => setActive(i)}
                title={r.primary ? "Primary repo" : "Attached repo"}
              >
                {repoLabel(r.repo)}
                <span className="diff-repo-tab-count rounded-full bg-[color-mix(in_srgb,var(--text-faint)_20%,transparent)] px-1.5 text-meta text-faint">{r.diff.files.length}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="diff-summary sticky top-0 z-[1] flex items-center gap-2.5 border-b border-line bg-raised px-3.5 py-2.5 text-supporting">
        <span className="diff-summary-files text-dim">
          {d.files.length} file{d.files.length === 1 ? "" : "s"} changed
        </span>
        <span className="diff-add font-semibold text-green">+{d.totalAdditions}</span>
        <span className="diff-del font-semibold text-red">−{d.totalDeletions}</span>
        {d.truncated && <span className="diff-truncated rounded-sm bg-yellow/15 px-1.5 py-px text-meta font-bold text-yellow">truncated</span>}
        {handEdited.length > 0 && canSend && (
          <Button
            variant="default"
            size="xs"
            className="ml-2 min-h-0 px-2 py-0.5 text-meta"
            onClick={tellAgentAboutEdits}
            title="Sends a note listing your hand-edits so they get reviewed and committed"
          >
            Tell {AGENT_NAME} about {handEdited.length} edit
            {handEdited.length === 1 ? "" : "s"}
          </Button>
        )}
        <Tooltip label="Refresh diff">
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto min-h-0 px-1.5 py-0.5 text-control-label text-faint hover:text-fg"
            onClick={reload}
            aria-label="Refresh diff"
          >
            ↻
          </Button>
        </Tooltip>
      </div>

      <div className="diff-render p-2.5 pb-7 [&_[class*='pierre']]:max-w-full">
        <CommentableDiff
          key={cur.repo}
          patch={d.rawPatch || ""}
          defaultExpandedFiles={10}
          groups={
            groups?.repo === cur.repo && groups.patch === d.rawPatch
              ? groups.groups || undefined
              : undefined
          }
          groupsLoading={groupsLoading}
          submitLabel={`Send to ${AGENT_NAME}`}
          placeholder={`Leave feedback on these lines. ${AGENT_NAME} picks it up in this session…`}
          disabled={!canSend}
          disabledHint={`${AGENT_NAME} is working. You can send feedback once the current run finishes.`}
          onSubmit={(target, text) => handleComment(cur.repo, target, text)}
          // Discarding edits the worktree — withhold it while the agent is running
          // to avoid racing its writes.
          onDiscard={canSend ? (path, oldPath) => handleDiscard(cur.repo, path, oldPath) : undefined}
          // In-place edit mode (@pierre/diffs edit): same live-worktree gate as
          // discard. Load pulls full file contents (the editor can't work from
          // hunks alone); save writes back and refreshes the diff.
          editFile={
            canSend
              ? {
                  load: (file, side) =>
                    fetchWorktreeFile(
                      sessionId,
                      side === "base" ? file.prevName || file.name : file.name,
                      cur.repo,
                      side,
                    ),
                  save: async (path, content) => {
                    await saveWorktreeFile(sessionId, path, content, cur.repo);
                    recordHandEdit(cur.repo, path);
                    await reload();
                  },
                }
              : undefined
          }
          // Changed images render as pictures: new side straight from the
          // worktree, old side from the diff's merge base.
          imageSrcs={(file) => {
            const src = (side: "new" | "base", p: string) =>
              `${API_BASE}/sessions/${encodeURIComponent(sessionId)}/worktree-image?repo=${encodeURIComponent(cur.repo)}&side=${side}&path=${encodeURIComponent(p)}`;
            return {
              oldSrc: src("base", file.prevName || file.name),
              newSrc: src("new", file.name),
            };
          }}
        />
      </div>
    </div>
  );
}

/**
 * Empty state for the Changes tab. Shown both before the first fetch resolves
 * with any changes and when the worktree is genuinely clean. While the agent is
 * actively running we surface a subtle "pulling latest" line — the diff hook
 * polls faster then (8s vs 30s idle) and changes are imminent, so it signals
 * we're watching; once the run finishes the worktree is settled and we drop it.
 */
function DiffEmptyState({ isRunning }: { isRunning: boolean }) {
  return (
    <div className="flex h-full min-h-[280px] flex-col items-center justify-center gap-3 px-4 pt-12 pb-24 text-center">
      <svg
        viewBox="0 0 40 40"
        className="h-14 w-14 text-faint"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <circle cx="13" cy="13" r="5" />
        <circle cx="27" cy="27" r="5" />
        <path d="M13 18v5a4 4 0 0 0 4 4h5" />
      </svg>
      <div className="flex flex-col gap-1">
        <div className="text-item-title font-medium text-dim">No file changes yet</div>
        <div className="text-control-label text-faint">Changes appear here.</div>
      </div>
      {isRunning && (
        <div className="mt-1 flex items-center gap-2 text-label text-faint">
          <PixelSpinner className="pixel-spinner-slow text-faint" interval={4000} />
          <span>Pulling latest…</span>
        </div>
      )}
    </div>
  );
}
