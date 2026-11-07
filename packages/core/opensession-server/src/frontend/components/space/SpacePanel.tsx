import { useEffect, useState } from "react";
import { fetchSessionAssets, type SessionAssetFile } from "../../lib/api";
import { fetchThreadsApi } from "../../lib/api/threads";
import { threadPreview } from "../../lib/comment-threads";
import { repoLabel } from "../../lib/repo-label";
import { useSessionRecords } from "../../lib/session-records";
import {
  groupThreads,
  isSpaceCoordinator,
  markSpaceSeen,
  spaceRecap,
  spaceSeenAt,
  spaceThreads,
  THREAD_STATE_LABEL,
  threadState,
  type SpaceRecap,
} from "../../lib/space-threads";
import { shortTime } from "../../lib/time";
import { useWorkspaceRecord } from "../../lib/workspace-records";
import type { CommentThread, UnifiedSession, Workspace } from "../../lib/types";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { ListRow } from "../../ui/list-row";
import { Segmented, SegmentedOption } from "../../ui/segmented";
import { EmptyState } from "../../ui/state";
import { IconFile, IconMessage } from "../icons";
import { RepoTile } from "../RepoTile";
import { UserAvatar } from "../UserAvatar";
import { SPACE_CAPTION } from "./space-classes";
import { ThreadRow } from "./ThreadRow";

type SpaceTab = "threads" | "comments" | "artifacts";

/** The file the coordinator is told to keep current (server/spaces.ts). */
const SUMMARY_ASSET = "space-summary.md";

/**
 * A space at a glance: who is in it, its threads by where they stand, the
 * conversation's comment threads, and the documents it keeps. It is the
 * desktop side panel's Space tab and the top of the phone's details page.
 */
export function SpacePanel({
  workspace,
  coordinatorId,
  onOpenSession,
  onOpenAsset,
  showTitle = true,
}: {
  workspace: Workspace;
  /** The space's conversation: its comments and artifacts live there. */
  coordinatorId: string;
  onOpenSession?: (id: string) => void;
  onOpenAsset?: (path: string) => void;
  /** Off where the page around it already names the space. */
  showTitle?: boolean;
}) {
  const sessions = useSessionRecords();
  const threads = spaceThreads(sessions, workspace.id);
  const [tab, setTab] = useState<SpaceTab>("threads");
  const comments = useSpaceComments(coordinatorId);
  const artifacts = useSpaceArtifacts(coordinatorId, sessions);
  const recap = useSpaceRecap(workspace.id, threads);
  const shipped = threads.filter((t) => threadState(t) === "shipped").length;
  const members = [
    workspace.createdBy,
    ...(workspace.collaborators ?? []).map((c) => c.name),
  ].filter((name, i, all) => name && all.indexOf(name) === i);

  return (
    <div className="flex flex-col gap-3 px-3 pt-3 pb-6">
      <header className="flex flex-col gap-1.5 px-2">
        {showTitle && (
          <h2 className="m-0 truncate text-section-title font-semibold leading-tight text-fg">
            {workspace.name}
          </h2>
        )}
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-meta text-dim">
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

      {recap.value && (
        <RecapCard
          recap={recap.value}
          onOpen={onOpenSession}
          onDismiss={recap.dismiss}
        />
      )}

      <Segmented
        label="Space"
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
        <ThreadGroups threads={threads} onOpen={onOpenSession} />
      )}
      {tab === "comments" && <CommentList threads={comments.threads} />}
      {tab === "artifacts" && (
        <ArtifactList files={artifacts} onOpen={onOpenAsset} />
      )}
    </div>
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
        No threads yet. The agent starts one for each piece of work you give it.
      </EmptyState>
    );
  return (
    <div className="flex flex-col">
      {groupThreads(threads).map((group) => (
        <section key={group.state} aria-label={THREAD_STATE_LABEL[group.state]}>
          <div className={SPACE_CAPTION}>
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

/**
 * "Since you were last here": only for this browser, and only when something
 * moved. Dismissing it, or coming back later, starts the count again.
 */
function RecapCard({
  recap,
  onOpen,
  onDismiss,
}: {
  recap: SpaceRecap;
  onOpen?: (id: string) => void;
  onDismiss: () => void;
}) {
  const lines: Array<{ label: string; threads: UnifiedSession[] }> = [
    { label: "Needs you", threads: recap.blocked },
    { label: "Ready to ship", threads: recap.ready },
    { label: "Shipped", threads: recap.shipped },
    { label: "Started", threads: recap.started },
  ].filter((line) => line.threads.length > 0);
  return (
    <section
      aria-label="Since you were last here"
      className="flex flex-col gap-1 rounded-xl bg-panel p-2"
    >
      <div className="flex items-center justify-between gap-2 px-2 pt-1">
        <span className="text-label font-semibold text-fg">
          Since you were last here
        </span>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
      {lines.map((line) => (
        <div key={line.label} className="flex flex-col">
          <div className="px-2 pt-1 text-meta font-medium text-faint">
            {line.label}
          </div>
          {line.threads.slice(0, 4).map((thread) => (
            <ListRow
              key={thread.id}
              className="py-1"
              onClick={() => onOpen?.(thread.id)}
            >
              <span className="truncate text-label text-fg">
                {thread.title}
              </span>
            </ListRow>
          ))}
          {line.threads.length > 4 && (
            <div className="px-2 text-meta text-faint">
              and {line.threads.length - 4} more
            </div>
          )}
        </div>
      ))}
    </section>
  );
}

/** Open threads first, then resolved, newest activity first in each. */
function CommentList({ threads }: { threads: CommentThread[] | null }) {
  if (threads === null) return null;
  if (threads.length === 0)
    return (
      <EmptyState className="py-8">
        No comments yet. Select text in the conversation to comment on it, or
        reply to a message.
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
        No artifacts yet. The agent keeps the space's summary here.
      </EmptyState>
    );
  return (
    <div className="flex flex-col">
      {files.map((file) => (
        <ListRow key={file.path} onClick={() => onOpen?.(file.path)}>
          {file.path === SUMMARY_ASSET ? (
            <IconMessage size={18} className="mt-px shrink-0 text-dim" />
          ) : (
            <IconFile size={18} className="mt-px shrink-0 text-dim" />
          )}
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-label text-fg">
              {file.path === SUMMARY_ASSET ? "Space summary" : file.path}
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
function useSpaceComments(sessionId: string) {
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
function useSpaceArtifacts(
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
              Number(b.path === SUMMARY_ASSET) -
                Number(a.path === SUMMARY_ASSET) ||
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
 * The recap against when this browser last had the space open. The time is
 * read once per space and stamped right away, so the recap stays put while
 * the panel is up and the next visit counts from this one.
 */
function useSpaceRecap(workspaceId: string, threads: UnifiedSession[]) {
  const [seen, setSeen] = useState(() => ({
    workspaceId,
    at: spaceSeenAt(workspaceId),
  }));
  if (seen.workspaceId !== workspaceId)
    setSeen({ workspaceId, at: spaceSeenAt(workspaceId) });
  useEffect(() => {
    markSpaceSeen(workspaceId, Date.now());
    const stamp = () => markSpaceSeen(workspaceId, Date.now());
    window.addEventListener("pagehide", stamp);
    return () => {
      stamp();
      window.removeEventListener("pagehide", stamp);
    };
  }, [workspaceId]);
  return {
    value: spaceRecap(threads, seen.at),
    dismiss: () => setSeen({ workspaceId, at: Date.now() }),
  };
}

/**
 * The phone's place for the panel: the top of a space conversation's details
 * page, where the desktop puts it in the side panel. Renders nothing for any
 * other session.
 */
export function SpaceDetailsSection({
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
  if (!workspace || !isSpaceCoordinator(session, workspace)) return null;
  return (
    <SpacePanel
      workspace={workspace}
      coordinatorId={session.id}
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
