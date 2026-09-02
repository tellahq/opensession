import { repoLabel } from "../lib/repo-label";
import React, { useEffect, useEffectEvent, useState, useRef } from "react";
import { createPortal } from "react-dom";
import type {
  CodeFlowResult,
  DiffFileGroup,
  RepoDiff,
  WSClientMessage,
} from "../lib/types";
import { useSessionDiffResource } from "../hooks/useApiResources";
import {
  API_BASE,
  fetchDiffGroups,
  fetchCodeFlow,
  discardDiffFile,
  fetchWorktreeFile,
  saveWorktreeFile,
} from "../lib/api";
import { CommentableDiff } from "./CommentableDiff";
import type { CommentTarget } from "../lib/commentable-diff";
import { getCurrentUser } from "./UserPicker";
import { Segmented, SegmentedOption } from "../ui/segmented";
import { SettingRow } from "../ui/setting-row";
import { Tooltip } from "../ui/tooltip";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { AGENT_NAME } from "../lib/brand";
import { InlineAlert, LoadingState } from "../ui/state";
import { CodeFlow } from "./CodeFlow";
import { revealDiffFile } from "../lib/diff-navigation";
import { IconRestore, IconSliders } from "./icons";
import { Popover } from "../ui/popover";
import {
  CodeDisplaySettings,
  CodeOrganizationSettings,
  DiffSourceSetting,
} from "./CodeDisplaySettings";
import {
  useCodeDisplaySettings,
  useCodeOrganizationSettings,
} from "../hooks/useCodeDisplaySettings";
import { PrFileTree } from "./pr/PrFileTree";
import { errorMessage } from "../lib/error-message";

/* The +/− counts. Kept as constants because CommentableDiff carries the same
   pair on its file rows and group headers, and the two must read alike. */
const DIFF_ADD = "font-semibold text-green";
const DIFF_DEL = "font-semibold text-red";

interface Props {
  sessionId: string;
  isRunning: boolean;
  canSend: boolean;
  send: (msg: WSClientMessage) => void;
  /** Shared diff state (lifted so the Changes tab badge and this panel poll
   *  once, not twice). When omitted, the panel fetches on its own. */
  diff?: SessionDiffState;
  /** Start on this repository when Review switches from its PR diff. */
  repo?: string;
  /** Move the diff summary and view controls into a parent review toolbar. */
  toolbarTarget?: HTMLDivElement | null;
  /** The full review canvas has room for file navigation; side panels do not. */
  showFileList?: boolean;
  /** Shown when Review can switch between its PR and live worktree diffs. */
  source?: "pull-request" | "worktree";
  onSourceChange?: (source: "pull-request" | "worktree") => void;
}

export interface SessionDiffState {
  repos: RepoDiff[] | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/**
 * Whether two poll results would render the same file list. The server stamps
 * each repo's patch with a content hash, so the version pair settles it; the
 * empty-diff placeholder carries no hash, which is what the size guards cover.
 */
function sameRepoDiffs(a: RepoDiff[] | null, b: RepoDiff[]): boolean {
  if (a === null || a.length !== b.length) return false;
  return a.every((repo, i) => {
    const next = b[i];
    return (
      repo.repo === next.repo &&
      repo.diff.diffVersion === next.diff.diffVersion &&
      repo.diff.rawPatch.length === next.diff.rawPatch.length &&
      repo.diff.files.length === next.diff.files.length
    );
  });
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
  const {
    data,
    error: requestError,
    isLoading,
    mutate,
  } = useSessionDiffResource(sessionId, {
    enabled,
    refreshInterval: enabled ? (isRunning ? 8000 : 30000) : 0,
    // The same patch comes back on most polls. Suppress that update before it
    // reaches React, because rendering a large diff parses every file again.
    compare: (previous, next) => {
      if (previous === next) return true;
      if (!previous || !next) return false;
      return sameRepoDiffs(previous.repos || [], next.repos || []);
    },
  });
  const repos = data?.repos ?? null;
  const loading = isLoading && !data;
  // A failed background revalidation must not replace a usable stale patch.
  const error = data
    ? null
    : requestError instanceof Error
      ? requestError.message
      : requestError
        ? "Failed to load diff."
        : null;
  const reload = async () => {
    await mutate();
  };

  return { repos, loading, error, reload };
}

export function DiffPanel({
  sessionId,
  isRunning,
  canSend,
  send,
  diff,
  repo,
  toolbarTarget,
  showFileList = true,
  source,
  onSourceChange,
}: Props) {
  const [active, setActive] = useState(0);
  const [view, setView] = useState<"files" | "flow">("files");
  // Sidebar Changes is another code viewer, not a reduced diff. It reads and
  // writes the same rendering preferences as Review, with a narrow-safe
  // unified fallback until the person picks a layout.
  const codeDisplaySettings = useCodeDisplaySettings("unified");
  const organizationSettings = useCodeOrganizationSettings();
  const { grouping, fileListMode, fileOrder, sortDirection } =
    organizationSettings;
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
  // Content key: re-run only when the repo list's ordering changes, while the
  // sync reads the live `changed` through an effect event.
  const changedReposKey = (changed || [])
    .map((candidate) => candidate.repo)
    .join("\0");
  const syncActiveRepo = useEffectEvent(() => {
    if (!repo) return;
    const index = changed.findIndex((candidate) => candidate.repo === repo);
    if (index >= 0)
      setActive((current) => (current === index ? current : index));
  });
  useEffect(() => {
    syncActiveRepo();
  }, [repo, changedReposKey]);
  const cur =
    changed[Math.min(active, changed.length - 1)] || changed[0] || null;
  const groupPatch = cur?.diff.rawPatch || "";
  const groupFileCount = cur?.diff.files.length || 0;
  const patchVersion = cur?.diff.diffVersion || "";
  const flowRepo = cur?.repo;
  const flowKey = cur ? `${sessionId}\0${flowRepo}\0${patchVersion}` : "";
  const [flow, setFlow] = useState<{
    key: string;
    data: CodeFlowResult;
  } | null>(null);
  const [flowLoading, setFlowLoading] = useState(false);
  const [flowError, setFlowError] = useState<string | null>(null);
  const flowGeneration = useRef(0);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [diffControlsTarget, setDiffControlsTarget] =
    useState<HTMLDivElement | null>(null);

  // Keyed on the semantic inputs (session/repo/diff version), not the
  // per-poll `cur` object, so the flow effect doesn't re-arm every poll.
  const loadFlow = useEffectEvent(async () => {
    if (!flowRepo || !flowKey) return;
    const generation = ++flowGeneration.current;
    setFlowLoading(true);
    setFlowError(null);
    await (async () => {
      const data = await fetchCodeFlow(sessionId, flowRepo);
      if (!data)
        throw new Error("Code flow isn't available for these changes.");
      if (data.diffVersion !== patchVersion) {
        if (generation === flowGeneration.current) {
          setFlowError(
            "Changes updated while code flow was loading. Try again.",
          );
        }
        return;
      }
      if (generation === flowGeneration.current)
        setFlow({ key: flowKey, data });
    })()
      .catch(async (error) => {
        if (generation === flowGeneration.current)
          setFlowError(errorMessage(error, "Couldn't load code flow."));
      })
      .finally(async () => {
        if (generation === flowGeneration.current) setFlowLoading(false);
      });
  });

  const refreshFlow = async () => {
    flowGeneration.current += 1;
    setFlow(null);
    setFlowError(null);
    setFlowLoading(true);
    await reload();
    setFlowLoading(false);
  };

  useEffect(() => {
    if (view !== "flow" || flowLoading || flowError) return;
    if (flow && flow.key !== flowKey) {
      setFlowError(
        "Changes updated. Refresh code flow to analyze the latest diff.",
      );
      return;
    }
    if (!flow) void loadFlow();
  }, [view, flowKey, flow, flowLoading, flowError]);

  useEffect(() => {
    setFlow(null);
    setFlowLoading(false);
    setFlowError(null);
    flowGeneration.current += 1;
  }, [sessionId, cur?.repo]);

  useEffect(() => setView("files"), [sessionId]);

  function openFlowLocation(path: string) {
    setView("files");
    requestAnimationFrame(() =>
      requestAnimationFrame(() => revealDiffFile(panelRef.current, path)),
    );
  }

  const loadGroups = useEffectEvent(() => {
    if (grouping !== "ai" || !cur || !groupPatch || groupFileCount < 3) {
      setGroups(null);
      setGroupsLoading(false);
      return;
    }
    let live = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    setGroups(null);
    setGroupsLoading(true);
    const retryLater = () => {
      retryTimer = setTimeout(
        () => setGroupsRetry((attempt) => attempt + 1),
        125_000,
      );
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
  });
  useEffect(() => {
    loadGroups();
  }, [sessionId, cur?.repo, groupPatch, groupFileCount, groupsRetry, grouping]);

  async function handleDiscard(repo: string, path: string, oldPath?: string) {
    await discardDiffFile(sessionId, path, repo, oldPath);
    // Reflect the reverted file immediately (don't wait for the poll).
    await reload();
  }

  // Files the human edited in place (Changes-tab edit mode). Saves only touch
  // the worktree — nothing is committed — so we offer a one-click note that
  // tells the agent about the hand-edits (it reviews them and folds them into
  // its next commit). Cleared per session and once sent.
  const [handEdited, setHandEdited] = useState<
    { repo: string; path: string }[]
  >([]);
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

  async function handleComment(
    repo: string,
    target: CommentTarget,
    text: string,
  ) {
    if (!canSend)
      throw new Error(
        `${AGENT_NAME} is busy. Wait for the current run to finish.`,
      );
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

  const codeSettings = (
    <Popover.Root>
      <Tooltip label="Code view settings">
        <Popover.Trigger
          render={
            <Button
              variant="ghost"
              size="sm"
              aria-label="Code view settings"
              icon={<IconSliders size={18} />}
            />
          }
        />
      </Tooltip>
      <Popover.Popup
        side="bottom"
        align="end"
        initialFocus
        className="flex w-[340px] max-w-[calc(100vw-24px)] flex-col gap-0.5 p-3"
      >
        {source && onSourceChange && (
          <>
            <DiffSourceSetting value={source} onValueChange={onSourceChange} />
            <div aria-hidden className="mx-2 my-1.5 h-px bg-line" />
          </>
        )}
        <SettingRow label="Code view">
          <Segmented
            size="sm"
            label="Code view"
            value={view}
            onValueChange={(next) => {
              if (next === "flow") {
                if (view !== "flow" && flowError) {
                  setFlow(null);
                  setFlowError(null);
                }
                setView("flow");
                return;
              }
              setView("files");
            }}
          >
            <SegmentedOption value="files">Changes</SegmentedOption>
            <SegmentedOption value="guide" disabled>
              Guide
            </SegmentedOption>
            <SegmentedOption value="flow" disabled={!patchVersion}>
              Flow
            </SegmentedOption>
          </Segmented>
        </SettingRow>

        <div aria-hidden className="mx-2 my-1.5 h-px bg-line" />

        <CodeOrganizationSettings
          settings={organizationSettings}
          reviewedFilesAvailable={false}
          defaultOrderLabel="Worktree"
          showFileListSetting={showFileList}
        />

        <div aria-hidden className="mx-2 my-1.5 h-px bg-line" />

        <CodeDisplaySettings {...codeDisplaySettings} />
      </Popover.Popup>
    </Popover.Root>
  );
  const emptyState = <DiffEmptyState isRunning={isRunning} />;

  if (loading) return <LoadingState>Loading diff…</LoadingState>;
  if (error) return <InlineAlert className="m-4">{error}</InlineAlert>;
  if (!repos || !repos.length) return emptyState;

  // Repos that actually have changes; if none, show the empty state.
  if (!changed.length) return emptyState;

  const multi = changed.length > 1;
  if (!cur) return emptyState;
  const d = cur.diff;
  const orderedFiles = [...d.files];
  if (fileOrder === "pull-request") {
    if (sortDirection === "desc") orderedFiles.reverse();
  } else {
    const direction = sortDirection === "asc" ? 1 : -1;
    orderedFiles.sort((left, right) => {
      const result =
        fileOrder === "changes"
          ? left.additions + left.deletions - right.additions - right.deletions
          : left.path.localeCompare(right.path);
      return (result || left.path.localeCompare(right.path)) * direction;
    });
  }
  const visibleFileOrder = orderedFiles.map((file) => file.path);

  const toolbarContents = (
    <>
      <span className="text-dim">
        {d.files.length} file{d.files.length === 1 ? "" : "s"}
        {groupsLoading && (
          <span role="status" aria-label="Organizing files">
            {" "}
            (organizing…)
          </span>
        )}
      </span>
      <span className={DIFF_ADD}>+{d.totalAdditions}</span>
      <span className={DIFF_DEL}>−{d.totalDeletions}</span>
      {d.truncated && (
        <span className="rounded-sm bg-yellow/15 px-[7px] py-px text-meta font-bold text-yellow">
          truncated
        </span>
      )}
      {handEdited.length > 0 && canSend && (
        <Button
          variant="default"
          size="sm"
          className="ml-2 min-h-0 px-2 py-0.5 text-meta"
          onClick={tellAgentAboutEdits}
          title="Sends a note listing your hand-edits so they get reviewed and committed"
        >
          Tell {AGENT_NAME} about {handEdited.length} edit
          {handEdited.length === 1 ? "" : "s"}
        </Button>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <div
          ref={setDiffControlsTarget}
          className="flex shrink-0 items-center gap-2"
        />
        {codeSettings}
        <Tooltip label="Refresh diff">
          <Button
            variant="ghost"
            size="sm"
            icon={<IconRestore size={18} />}
            onClick={() => {
              if (view === "flow") {
                void refreshFlow();
                return;
              }
              void reload();
            }}
            aria-label="Refresh diff"
          />
        </Tooltip>
      </div>
    </>
  );
  const toolbar =
    toolbarTarget === undefined ? (
      // Paint through the section's 10px top gutter. The gutter still belongs
      // to the diff below, but code cannot scroll through its empty space.
      <div
        className={`sticky ${multi ? "top-[calc(var(--diff-panel-top,0px)+37px)] phone:top-[calc(var(--diff-panel-top,0px)+47px)]" : "top-[var(--diff-panel-top,0px)]"} z-1 bg-panel-surface after:absolute after:inset-x-0 after:top-full after:h-2.5 after:bg-panel-surface after:content-['']`}
      >
        <div className="flex h-10 items-center gap-2.5 overflow-x-auto border-b border-divider px-3.5 text-label whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {toolbarContents}
        </div>
      </div>
    ) : toolbarTarget ? (
      createPortal(toolbarContents, toolbarTarget)
    ) : null;

  return (
    <div
      className={`@container flex min-h-0 flex-col ${multi ? "[--review-file-header-top:calc(var(--diff-panel-top,0px)+87px)] phone:[--review-file-header-top:calc(var(--diff-panel-top,0px)+97px)]" : "[--review-file-header-top:calc(var(--diff-panel-top,0px)+50px)]"}`}
      ref={panelRef}
    >
      {multi && (
        <div className="sticky top-[var(--diff-panel-top,0px)] z-2 flex gap-1 overflow-x-auto border-b border-divider bg-panel-surface px-2.5 py-1.5">
          {changed.map((r, i) => {
            return (
              <button
                key={r.repo}
                // The active pill supplies its own surface and border colour —
                // the base has the geometry only, so nothing carries two
                // competing colour utilities.
                className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-[9px] py-[3px] text-label whitespace-nowrap phone:px-3 phone:py-2 ${
                  i === active
                    ? "border-line bg-panel text-fg"
                    : "border-transparent bg-transparent text-dim hover:text-fg"
                }`}
                onClick={() => setActive(i)}
                title={r.primary ? "Primary repo" : "Attached repo"}
              >
                {repoLabel(r.repo)}
                <span className="rounded-full bg-faint/20 px-[5px] text-meta text-faint">
                  {r.diff.files.length}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {toolbar}

      <div className="flex min-h-0 min-w-0 flex-1">
        {showFileList &&
          fileListMode !== "hidden" &&
          orderedFiles.length > 0 && (
            <PrFileTree
              files={orderedFiles}
              mode={fileListMode}
              showFileStats={codeDisplaySettings.showFileStats}
              onOpenFile={openFlowLocation}
            />
          )}
        <div className="min-w-0 flex-1">
          {view === "flow" ? (
            <CodeFlow
              data={flow?.key === flowKey ? flow.data : null}
              loading={flowLoading || (flow?.key !== flowKey && !flowError)}
              error={flowError}
              onRetry={() => void refreshFlow()}
              onOpenLocation={openFlowLocation}
            />
          ) : (
            /* @pierre/diffs sizes its own generated markup, which no utility on our
         side can reach — hold it inside the panel from here. A parent toolbar
         supplies the review canvas's shared 8px inset; standalone Changes
         keeps this panel's own inset. */
            <div
              className={`${toolbarTarget === undefined ? "px-2.5 pt-2.5" : "px-0 pt-0"} min-w-0 max-w-full overflow-clip pb-7 [&_[class*=pierre]]:max-w-full`}
            >
              <CommentableDiff
                key={cur.repo}
                patch={d.rawPatch || ""}
                options={{
                  defaultExpandedFiles: 10,
                  controlsTarget: diffControlsTarget,
                  diffStyle: codeDisplaySettings.diffStyle,
                  wrapLines: codeDisplaySettings.wrapLines,
                  structuralHighlighting:
                    codeDisplaySettings.structuralHighlighting,
                  showFileStats: codeDisplaySettings.showFileStats,
                  codeTheme: codeDisplaySettings.codeTheme,
                  visibleFileOrder,
                  // The sidebar owns this scrollport. Keep each file's title below its
                  // standing toolbar until the following file pushes it away.
                  stickyFileHeaders: toolbarTarget === undefined,
                  groups:
                    grouping === "ai" &&
                    groups?.repo === cur.repo &&
                    groups.patch === d.rawPatch
                      ? groups.groups || undefined
                      : undefined,
                  groupsLoading: grouping === "ai" && groupsLoading,
                  showGroupsStatus: false,
                  submitLabel: `Send to ${AGENT_NAME}`,
                  placeholder: `Leave feedback on these lines. ${AGENT_NAME} picks it up in this session…`,
                  disabled: !canSend,
                  disabledHint: `${AGENT_NAME} is working. You can send feedback once the current run finishes.`,
                  onSubmit: (target, text) =>
                    handleComment(cur.repo, target, text),
                  // Discarding edits the worktree — withhold it while the agent is running
                  // to avoid racing its writes.
                  onDiscard: canSend
                    ? (path, oldPath) => handleDiscard(cur.repo, path, oldPath)
                    : undefined,
                  // In-place edit mode (@pierre/diffs edit): same live-worktree gate as
                  // discard. Load pulls full file contents (the editor can't work from
                  // hunks alone); save writes back and refreshes the diff.
                  editFile: canSend
                    ? {
                        load: (file, side) =>
                          fetchWorktreeFile(
                            sessionId,
                            side === "base"
                              ? file.prevName || file.name
                              : file.name,
                            cur.repo,
                            side,
                          ),
                        save: async (path, content) => {
                          await saveWorktreeFile(
                            sessionId,
                            path,
                            content,
                            cur.repo,
                          );
                          recordHandEdit(cur.repo, path);
                          await reload();
                        },
                      }
                    : undefined,
                  // Changed images render as pictures: new side straight from the
                  // worktree, old side from the diff's merge base.
                  imageSrcs: (file) => {
                    const src = (side: "new" | "base", path: string) =>
                      `${API_BASE}/sessions/${encodeURIComponent(sessionId)}/worktree-image?repo=${encodeURIComponent(cur.repo)}&side=${side}&path=${encodeURIComponent(path)}`;
                    return {
                      oldSrc: src("base", file.prevName || file.name),
                      newSrc: src("new", file.name),
                    };
                  },
                }}
              />
            </div>
          )}
        </div>
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
        <div className="text-item-title font-medium text-dim">
          No file changes yet
        </div>
        <div className="text-sm text-faint">Changes appear here.</div>
      </div>
      {isRunning && (
        <div className="mt-1 flex items-center gap-2 text-xs text-faint">
          <Spinner className="text-faint" />
          <span>Pulling latest…</span>
        </div>
      )}
    </div>
  );
}
