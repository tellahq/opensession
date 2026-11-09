import { useEffect, useState } from "react";
import { fetchSessionAssets, type SessionAssetFile } from "../../lib/api";
import { fetchThreadsApi } from "../../lib/api/threads";
import { threadPreview } from "../../lib/comment-threads";
import { repoLabel } from "../../lib/repo-label";
import { useSessionRecords } from "../../lib/session-records";
import {
  groupThreads,
  sessionThreads,
  THREAD_STATE_LABEL,
  threadState,
} from "../../lib/session-threads";
import { shortTime } from "../../lib/time";
import { useWorkspaceRecord } from "../../lib/workspace-records";
import type { CommentThread, UnifiedSession, Workspace } from "../../lib/types";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { ListRow } from "../../ui/list-row";
import { Segmented, SegmentedOption } from "../../ui/segmented";
import { EmptyState } from "../../ui/state";
import { IconFile, IconMessage, IconGear } from "../icons";
import { RepoTile } from "../RepoTile";
import { UserAvatar } from "../UserAvatar";
import { THREAD_CAPTION } from "./thread-classes";
import { WorkspaceSettingsDialog } from "../WorkspaceSettingsDialog";
import { HuddleButton } from "../huddle/HuddleButton";
import { openThreadPane } from "../../lib/thread-view";
import { useIsCoordinating } from "../../lib/coordinator-mode";
import { ThreadRow } from "./ThreadRow";

type PanelTab = "threads" | "comments" | "artifacts";

/** The file a coordinator is told to keep current (server/coordinator.ts),
 *  and its name from before coordinator mode was a session setting. */
const SUMMARY_ASSETS = new Set(["coordinator-summary.md", "space-summary.md"]);
const isSummary = (path: string) => SUMMARY_ASSETS.has(path);

/**
 * The threads a conversation handed work to, at a glance: its workspace's
 * goal and people, the threads by where they stand, the conversation's
 * comment threads, and the documents it keeps. The desktop side panel's
 * Threads tab and the top of the phone's details page.
 */
export function ThreadsPanel({
  workspace,
  rootId,
  onOpenSession,
  onOpenAsset,
  showTitle = true,
}: {
  workspace: Workspace | null;
  /** The conversation that started the threads. */
  rootId: string;
  onOpenSession?: (id: string) => void;
  onOpenAsset?: (path: string) => void;
  /** Off where the page around it already names the workspace. */
  showTitle?: boolean;
}) {
  return (
    <ThreadsOverview
      workspace={workspace}
      rootId={rootId}
      onOpenSession={onOpenSession}
      onOpenAsset={onOpenAsset}
      showTitle={showTitle}
    />
  );
}

function ThreadsOverview({
  workspace,
  rootId,
  onOpenSession,
  onOpenAsset,
  showTitle,
}: {
  workspace: Workspace | null;
  rootId: string;
  onOpenSession?: (id: string) => void;
  onOpenAsset?: (path: string) => void;
  showTitle: boolean;
}) {
  const sessions = useSessionRecords();
  const threads = sessionThreads(sessions, rootId);
  const [tab, setTab] = useState<PanelTab>("threads");
  const comments = usePanelComments(rootId);
  const artifacts = usePanelArtifacts(rootId, sessions);
  const shipped = threads.filter((t) => threadState(t) === "shipped").length;

  return (
    <div className="flex flex-col gap-3 px-3 pt-3 pb-6">
      <header className="flex flex-col gap-1.5 px-2">
        {workspace && (
          <WorkspaceHeading
            workspace={workspace}
            rootId={rootId}
            showTitle={showTitle}
          />
        )}
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-meta text-dim">
          {workspace && <WorkspaceFacts workspace={workspace} />}
          {threads.length > 0 && (
            <span className="tabular-nums">
              {shipped} shipped · {threads.length - shipped} open
            </span>
          )}
        </div>
        {threads.length > 0 && (
          <ShippedBar shipped={shipped} total={threads.length} />
        )}
      </header>

      <Segmented
        label="Threads panel"
        value={tab}
        onValueChange={(value) => {
          if (
            value === "threads" ||
            value === "comments" ||
            value === "artifacts"
          )
            setTab(value);
        }}
        size="sm"
        className="mx-2"
      >
        <SegmentedOption value="threads">
          Threads {threads.length > 0 && <Count n={threads.length} />}
        </SegmentedOption>
        <SegmentedOption value="comments">
          Comments {comments.open > 0 && <Count n={comments.open} />}
        </SegmentedOption>
        <SegmentedOption value="artifacts">
          Artifacts {artifacts.length > 0 && <Count n={artifacts.length} />}
        </SegmentedOption>
      </Segmented>

      {tab === "threads" && (
        <ThreadGroups
          threads={threads}
          onOpen={(id) => {
            // In a split beside the conversation where there is room.
            if (!openThreadPane(rootId, id)) onOpenSession?.(id);
          }}
        />
      )}
      {tab === "comments" && <CommentList threads={comments.threads} />}
      {tab === "artifacts" && (
        <ArtifactList files={artifacts} onOpen={onOpenAsset} />
      )}
    </div>
  );
}

/** The workspace's name, huddle and settings, then its goal. */
function WorkspaceHeading({
  workspace,
  rootId,
  showTitle,
}: {
  workspace: Workspace;
  rootId: string;
  showTitle: boolean;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        {showTitle && (
          <h2 className="m-0 min-w-0 flex-1 truncate text-section-title font-semibold leading-tight text-fg">
            {workspace.name}
          </h2>
        )}
        <HuddleButton
          target={{
            roomId: `workspace:${workspace.id}`,
            label: workspace.name,
            sessionId: rootId,
          }}
        />
        <Button
          size="sm"
          variant="ghost"
          icon={<IconGear size={20} />}
          aria-label="Workspace settings"
          className={cn("phone:min-h-11", !showTitle && "ml-auto")}
          onClick={() => setEditing(true)}
        >
          Settings
        </Button>
      </div>
      {workspace.goal && (
        <p className="m-0 whitespace-pre-line text-supporting text-fg">
          {workspace.goal}
        </p>
      )}
      <WorkspaceSettingsDialog
        workspace={workspace}
        open={editing}
        onOpenChange={setEditing}
      />
    </>
  );
}

/** Project and people, on the panel's meta line. */
function WorkspaceFacts({ workspace }: { workspace: Workspace }) {
  const members = [
    workspace.createdBy,
    ...(workspace.collaborators ?? []).map((c) => c.name),
  ].filter((name, i, all) => name && all.indexOf(name) === i);
  return (
    <>
      <span className="flex min-w-0 items-center gap-1.5">
        {workspace.repo && <RepoTile name={workspace.repo} size={14} />}
        <span className="truncate">
          {workspace.repo ? repoLabel(workspace.repo) : "No project"}
        </span>
      </span>
      <span className="flex items-center" aria-label="Members">
        {members.map((name, i) => (
          <UserAvatar
            key={name}
            name={name}
            size={18}
            title={name}
            className={cn(i > 0 && "-ml-1")}
          />
        ))}
      </span>
    </>
  );
}

function Count({ n }: { n: number }) {
  return <span className="tabular-nums text-faint">{n}</span>;
}

/** Shipped against everything started, as one thin bar. */
function ShippedBar({ shipped, total }: { shipped: number; total: number }) {
  return (
    <div
      className="mt-0.5 h-1 overflow-hidden rounded-[999px] bg-hover"
      role="img"
      aria-label={`${shipped} of ${total} threads shipped`}
    >
      <div
        className="h-full rounded-[999px] bg-purple transition-[width] duration-300"
        style={{ width: `${(shipped / total) * 100}%` }}
      />
    </div>
  );
}

function ThreadGroups({
  threads,
  onOpen,
}: {
  threads: UnifiedSession[];
  onOpen?: (id: string) => void;
}) {
  if (threads.length === 0)
    return (
      <EmptyState className="py-8">
        No threads yet. In coordinator mode the agent starts one for each piece
        of work you give it.
      </EmptyState>
    );
  return (
    <div className="flex flex-col">
      {groupThreads(threads).map((group) => (
        <section key={group.state} aria-label={THREAD_STATE_LABEL[group.state]}>
          <div className={THREAD_CAPTION}>
            {THREAD_STATE_LABEL[group.state]}
            <Count n={group.threads.length} />
          </div>
          {group.threads.map((thread) => (
            <ThreadRow key={thread.id} thread={thread} onOpen={onOpen} />
          ))}
        </section>
      ))}
    </div>
  );
}

/** Open threads first, then resolved, newest activity first in each. */
function CommentList({ threads }: { threads: CommentThread[] | null }) {
  if (threads === null) return null;
  if (threads.length === 0)
    return (
      <EmptyState className="py-8">
        No comments yet. Hover a message and choose Comment, or select text to
        comment on part of it.
      </EmptyState>
    );
  const ordered = [...threads].sort(
    (a, b) =>
      Number(a.status === "resolved") - Number(b.status === "resolved") ||
      b.updatedAt - a.updatedAt,
  );
  return (
    <div className="flex flex-col">
      {ordered.map((thread) => {
        const replies = thread.comments.length - 1;
        return (
          <ListRow
            key={thread.id}
            className={cn(thread.status === "resolved" && "opacity-60")}
            onClick={() => revealCommentThread(thread.id)}
          >
            <UserAvatar name={thread.createdBy} size={18} edge={false} />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="line-clamp-2 text-label text-fg">
                {threadPreview(thread, 140)}
              </span>
              <span className="text-meta text-faint">
                {thread.createdBy}
                {replies > 0 &&
                  ` · ${replies} ${replies === 1 ? "reply" : "replies"}`}
                {thread.status === "resolved" && " · Resolved"}
              </span>
            </span>
            <span className="shrink-0 pt-0.5 text-meta tabular-nums text-faint">
              {shortTime(new Date(thread.updatedAt).toISOString())}
            </span>
          </ListRow>
        );
      })}
    </div>
  );
}

/** Scroll the conversation to a comment thread, when it is mounted. */
function revealCommentThread(threadId: string) {
  const el = document.querySelector(
    `[data-thread-id="${CSS.escape(threadId)}"]`,
  );
  el?.scrollIntoView({ block: "center", behavior: "smooth" });
}

function ArtifactList({
  files,
  onOpen,
}: {
  files: SessionAssetFile[];
  onOpen?: (path: string) => void;
}) {
  if (files.length === 0)
    return (
      <EmptyState className="py-8">
        No artifacts yet. A coordinator keeps its summary here.
      </EmptyState>
    );
  return (
    <div className="flex flex-col">
      {files.map((file) => (
        <ListRow key={file.path} onClick={() => onOpen?.(file.path)}>
          {isSummary(file.path) ? (
            <IconMessage size={18} className="mt-px shrink-0 text-dim" />
          ) : (
            <IconFile size={18} className="mt-px shrink-0 text-dim" />
          )}
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-label text-fg">
              {isSummary(file.path) ? "Summary" : file.path}
            </span>
            {file.description && (
              <span className="line-clamp-2 text-meta text-dim">
                {file.description}
              </span>
            )}
          </span>
          <span className="shrink-0 pt-0.5 text-meta tabular-nums text-faint">
            {shortTime(file.mtime)}
          </span>
        </ListRow>
      ))}
    </div>
  );
}

/** The conversation's comment threads, refreshed when the window regains
 *  focus. The transcript's live copy is the session viewer's own. */
function usePanelComments(sessionId: string) {
  const [threads, setThreads] = useState<CommentThread[] | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      void fetchThreadsApi(sessionId)
        .then((next) => {
          if (live) setThreads(next);
        })
        .catch(() => {
          if (live) setThreads((prev) => prev ?? []);
        });
    load();
    const timer = window.setInterval(load, 30_000);
    window.addEventListener("focus", load);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, [sessionId]);
  return {
    threads,
    open: threads?.filter((thread) => thread.status === "open").length ?? 0,
  };
}

/**
 * The conversation's assets, summary first. Refetched when its session list
 * row moves, which is when the agent may have written one.
 */
function usePanelArtifacts(
  sessionId: string,
  sessions: readonly UnifiedSession[],
) {
  const activity = sessions.find((s) => s.id === sessionId)?.lastActivity;
  const [files, setFiles] = useState<SessionAssetFile[]>([]);
  useEffect(() => {
    let live = true;
    void fetchSessionAssets(sessionId)
      .then(({ files: next }) => {
        if (!live) return;
        setFiles(
          [...next].sort(
            (a, b) =>
              Number(isSummary(b.path)) - Number(isSummary(a.path)) ||
              Date.parse(b.mtime) - Date.parse(a.mtime),
          ),
        );
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [sessionId, activity]);
  return files;
}

/**
 * The phone's place for the panel: the top of a conversation's details page,
 * where the desktop puts it in the side panel. Shown for a coordinating
 * session or one that has started threads; nothing for any other.
 */
export function ThreadsDetailsSection({
  session,
  onOpenSession,
  onOpenAsset,
  onLeave,
}: {
  session: UnifiedSession;
  onOpenSession?: (id: string) => void;
  onOpenAsset?: (path: string) => void;
  /** Close the details page before going somewhere else. */
  onLeave: () => void;
}) {
  const workspace = useWorkspaceRecord(session.workspaceId ?? null);
  const sessions = useSessionRecords();
  const hasThreads = sessions.some((s) => s.parentSessionId === session.id);
  const coordinating = useIsCoordinating(session, workspace);
  if (!hasThreads && !coordinating) return null;
  return (
    <ThreadsPanel
      workspace={workspace}
      rootId={session.id}
      showTitle={false}
      onOpenSession={
        onOpenSession &&
        ((id) => {
          onLeave();
          onOpenSession(id);
        })
      }
      onOpenAsset={
        onOpenAsset &&
        ((path) => {
          onLeave();
          onOpenAsset(path);
        })
      }
    />
  );
}
