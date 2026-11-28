import { useEffect, useState } from "react";
import { fetchSessionAssets, type SessionAssetFile } from "../../lib/api";
import { fetchThreadsApi } from "../../lib/api/threads";
import { threadPreview } from "../../lib/comment-threads";
import { repoLabel } from "../../lib/repo-label";
import { useSessionRecords } from "../../lib/session-records";
import { refState, refTone } from "../../lib/pr-refs";
import { PR_SIB_DOT_BG, PR_STATE_TEXT } from "../../lib/pr-tone-classes";
import {
  coordinatedPrs,
  groupThreads,
  sessionThreads,
  type CoordinatedPr,
  THREAD_STATE_LABEL,
  threadState,
  type ThreadState,
} from "../../lib/session-threads";
import { shortTime } from "../../lib/time";
import { useWorkspaceRecord } from "../../lib/workspace-records";
import type {
  CommentThread,
  UnifiedSession,
  Workspace,
  WSClientMessage,
} from "../../lib/types";
import { cn } from "../../ui/cn";
import { ListRow, listRowClass } from "../../ui/list-row";
import { PlateTabs } from "../../ui/tabs";
import { EmptyState } from "../../ui/state";
import {
  IconArrowUpRight,
  IconChevronRight,
  IconFile,
  IconFileText2,
  IconListCircles,
  IconMessage,
  IconMessages,
} from "../icons";
import { UserAvatar } from "../UserAvatar";
import { THREAD_CAPTION } from "./thread-classes";
import { openThreadTab } from "../../lib/thread-tabs";
import { useIsPhone } from "../../hooks/useIsPhone";
import { useIsCoordinating } from "../../lib/coordinator-mode";
import { ThreadPanelView } from "./ThreadPanelView";
import { ThreadRow } from "./ThreadRow";

import { WorkspaceCard } from "./WorkspaceCard";

type PanelTab = "threads" | "comments" | "artifacts";

/** The file a coordinator is told to keep current (server/coordinator.ts),
 *  and its name from before coordinator mode was a session setting. */
const SUMMARY_ASSETS = new Set(["coordinator-summary.md", "space-summary.md"]);
const isSummary = (path: string) => SUMMARY_ASSETS.has(path);

/**
 * The threads a conversation handed work to, at a glance: its workspace's
 * goal and people, the threads by where they stand (each with its PR and
 * preview link, opening in the panel), the conversation's comment threads,
 * and the documents it keeps. The desktop side panel's
 * Threads tab and the top of the phone's details page.
 */
export function ThreadsPanel({
  workspace,
  rootId,
  onOpenSession,
  onOpenAsset,
  showTitle = true,
  send,
}: {
  workspace: Workspace | null;
  /** The conversation that started the threads. */
  rootId: string;
  onOpenSession?: (id: string) => void;
  onOpenAsset?: (path: string) => void;
  /** Off where the page around it already names the workspace. */
  showTitle?: boolean;
  /** The conversation's socket, which a thread opened in the panel sends its
   *  replies and actions through. Absent while disconnected. */
  send?: (msg: WSClientMessage) => void;
}) {
  const phone = useIsPhone();
  const [openThread, setOpenThread] = useState<string | null>(null);
  // A thread opens in the panel on desktop, with a way out to a tab of its
  // own; a phone opens it as its own page.
  if (openThread && !phone)
    return (
      <ThreadPanelView
        threadId={openThread}
        send={send}
        onBack={() => setOpenThread(null)}
        onOpenTab={() => {
          openThreadTab(openThread);
          onOpenSession?.(openThread);
        }}
        onOpenThread={setOpenThread}
      />
    );
  return (
    <ThreadsOverview
      workspace={workspace}
      rootId={rootId}
      onOpenThread={(id) => (phone ? onOpenSession?.(id) : setOpenThread(id))}
      onOpenAsset={onOpenAsset}
      showTitle={showTitle}
    />
  );
}

function ThreadsOverview({
  workspace,
  rootId,
  onOpenThread,
  onOpenAsset,
  showTitle,
}: {
  workspace: Workspace | null;
  rootId: string;
  onOpenThread: (id: string) => void;
  onOpenAsset?: (path: string) => void;
  showTitle: boolean;
}) {
  const sessions = useSessionRecords();
  const threads = sessionThreads(sessions, rootId);
  const root = sessions.find((s) => s.id === rootId);
  // The conversation's own PRs; each thread's PR shows on its row.
  const ownPrs = coordinatedPrs(sessions, rootId).filter(
    ({ session }) => session.id === rootId,
  );
  const [tab, setTab] = useState<PanelTab>("threads");
  const comments = usePanelComments(rootId);
  const artifacts = usePanelArtifacts(rootId, sessions);
  const shipped = threads.filter((t) => threadState(t) === "shipped").length;

  return (
    <div className="flex flex-col gap-3 px-3 pt-3 pb-6">
      {workspace && (
        <WorkspaceCard
          workspace={workspace}
          rootId={rootId}
          showTitle={showTitle}
          shipped={shipped}
          total={threads.length}
        />
      )}

      <PlateTabs.Root
        label="Threads panel"
        value={tab}
        onValueChange={setTab}
        className="-mx-1"
      >
        <PlateTabs.Tab
          value="threads"
          icon={<IconListCircles size={20} />}
          // Blue, like a blocked thread's dot: one is waiting on someone.
          attention={threads.some((t) => threadState(t) === "blocked")}
        >
          Threads
        </PlateTabs.Tab>
        <PlateTabs.Tab
          value="comments"
          icon={<IconMessages size={20} />}
          attention={comments.open > 0}
        >
          Comments
        </PlateTabs.Tab>
        <PlateTabs.Tab value="artifacts" icon={<IconFileText2 size={20} />}>
          Artifacts
        </PlateTabs.Tab>
      </PlateTabs.Root>

      {tab === "threads" && (
        <>
          {ownPrs.length > 0 && (
            <PrList prs={ownPrs} primaryRepo={workspace?.repo} />
          )}
          <ThreadGroups
            threads={threads}
            starter={root?.startedBy || root?.createdBy || undefined}
            onOpen={onOpenThread}
          />
        </>
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

/** Groups that start folded: work that needs nothing more from anyone. */
const FOLDED_AT_FIRST = new Set<ThreadState>(["shipped"]);

function ThreadGroups({
  threads,
  starter,
  onOpen,
}: {
  threads: UnifiedSession[];
  /** Who started the conversation. Rows name a thread's starter only when
   *  it is someone else. */
  starter?: string;
  onOpen?: (id: string) => void;
}) {
  const [folded, setFolded] = useState(FOLDED_AT_FIRST);
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
          <button
            type="button"
            className={THREAD_CAPTION}
            aria-expanded={!folded.has(group.state)}
            onClick={() =>
              setFolded((prev) => {
                const next = new Set(prev);
                if (!next.delete(group.state)) next.add(group.state);
                return next;
              })
            }
          >
            {THREAD_STATE_LABEL[group.state]}
            <Count n={group.threads.length} />
            <IconChevronRight
              size={20}
              className={cn(
                "text-faint transition-transform duration-micro",
                !folded.has(group.state) && "rotate-90",
              )}
            />
          </button>
          {!folded.has(group.state) &&
            group.threads.map((thread) => (
              <ThreadRow
                key={thread.id}
                thread={thread}
                starter={starter}
                onOpen={onOpen}
              />
            ))}
        </section>
      ))}
    </div>
  );
}

/** The coordinator's and its threads' PRs, each a link to the PR. */
function PrList({
  prs,
  primaryRepo,
}: {
  prs: CoordinatedPr[];
  primaryRepo?: string;
}) {
  return (
    <section className="flex flex-col" aria-label="This conversation's PRs">
      <div className={cn(THREAD_CAPTION, "cursor-default hover:text-faint")}>
        This conversation
        <Count n={prs.length} />
      </div>
      {prs.map(({ pr }) => {
        const tone = refTone(pr);
        const otherRepo = pr.repo !== primaryRepo;
        return (
          <a
            key={`${pr.repo}#${pr.number}`}
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className={cn(listRowClass(), "group no-underline")}
            title={pr.title}
          >
            <span
              aria-hidden="true"
              className={cn(
                "mt-[7px] size-2 shrink-0 rounded-full",
                PR_SIB_DOT_BG[tone],
              )}
            />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-label font-medium text-fg">
                <span className="tabular-nums text-dim">#{pr.number}</span>{" "}
                {pr.title || pr.branch}
              </span>
              <span className="truncate text-meta text-dim">
                <span className={PR_STATE_TEXT[tone]}>{refState(pr)}</span>
                {otherRepo && ` · ${repoLabel(pr.repo)}`}
              </span>
            </span>
            {pr.url && (
              <IconArrowUpRight
                size={20}
                className="mt-0.5 shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
              />
            )}
          </a>
        );
      })}
    </section>
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
            <IconMessage size={20} className="mt-px shrink-0 text-dim" />
          ) : (
            <IconFile size={20} className="mt-px shrink-0 text-dim" />
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
