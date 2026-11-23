import { useEffect, useState } from "react";
import { fetchSessionOverview } from "../../lib/api/workspaces";
import { shortTime } from "../../lib/time";
import {
  threadState,
  threadStatusLine,
  type ThreadState,
} from "../../lib/session-threads";
import { sessionPrRefs } from "../../lib/session-prs";
import type { SessionPrRef, UnifiedSession } from "../../lib/types";
import { PrRefStagingMark, usePrRefStaging } from "../PrRefStagingMark";
import { cn } from "../../ui/cn";
import { UserAvatar } from "../UserAvatar";
import { ListRow } from "../../ui/list-row";
import { THREAD_DOT } from "./thread-classes";

/** Summaries by `id:lastActivity`, so a thread is asked again only after it
 *  moved. Module-wide: the panel and the transcript cards share it. */
const summaries = new Map<string, Promise<string | null>>();

/** The first sentence of a thread's latest reply, plain text. */
export function replyGist(markdown: string, max = 96): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentence = text.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? text;
  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}

/**
 * The gist of what a thread last said, for threads that have stopped moving.
 * A running one says "Working" until it settles; asking every few seconds
 * would cost a transcript read per stream event.
 */
export function useThreadGist(
  thread: UnifiedSession,
  state: ThreadState,
): string | null {
  const key =
    state === "working" ? null : `${thread.id}:${thread.lastActivity}`;
  const [gist, setGist] = useState<{ key: string; text: string | null }>();
  useEffect(() => {
    if (!key) return;
    let request = summaries.get(key);
    if (!request) {
      request = fetchSessionOverview(thread.id)
        .then((overview) =>
          overview.lastMessage?.content
            ? replyGist(overview.lastMessage.content)
            : null,
        )
        .catch(() => null);
      summaries.set(key, request);
    }
    let live = true;
    void request.then((text) => {
      if (live) setGist({ key, text });
    });
    return () => {
      live = false;
    };
  }, [key, thread.id]);
  return key && gist?.key === key ? gist.text : null;
}

/** One thread: state dot, title, where it stands, who started it, when. */
export function ThreadRow({
  thread,
  starter: conversationStarter,
  onOpen,
}: {
  thread: UnifiedSession;
  /** Who started the conversation the thread belongs to. Their face is left
   *  off, so a face on a row means someone else started that thread. */
  starter?: string;
  onOpen?: (id: string) => void;
}) {
  const state = threadState(thread);
  const gist = useThreadGist(thread, state);
  const status = threadStatusLine(thread);
  const starter = thread.startedBy || thread.createdBy || "";
  const showStarter = !!starter && starter !== conversationStarter;
  const pr = threadPr(thread);
  const staging = usePrRefStaging(pr ? thread.id : undefined, pr ?? NO_PR);
  const diff =
    pr && (pr.additions || pr.deletions) && pr.state !== "MERGED"
      ? { additions: pr.additions ?? 0, deletions: pr.deletions ?? 0 }
      : null;
  return (
    // The preview link sits beside the row rather than inside it: the row is
    // a button, and links and buttons do not nest.
    <div className="flex min-w-0 items-start rounded-md transition-colors hover:bg-hover">
      <ListRow
        onClick={() => onOpen?.(thread.id)}
        title={thread.title}
        className="flex-1 hover:bg-transparent"
      >
        <span
          aria-hidden="true"
          className={cn(
            "mt-[7px] size-2 shrink-0 rounded-full",
            THREAD_DOT[state],
            state === "working" && "motion-safe:animate-pulse",
          )}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-label font-medium text-fg">
            {thread.title}
          </span>
          <span className="truncate text-meta text-dim">
            {status}
            {diff && (
              <span className="tabular-nums">
                {" · "}
                <span className="text-green">+{diff.additions}</span>{" "}
                <span className="text-red">−{diff.deletions}</span>
              </span>
            )}
            {gist && <span className="text-faint"> · {gist}</span>}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 pt-0.5">
          {showStarter && <UserAvatar name={starter} size={16} edge={false} />}
          <span className="text-meta tabular-nums text-faint">
            {shortTime(thread.lastActivity)}
          </span>
        </span>
      </ListRow>
      {staging && (
        <PrRefStagingMark
          staging={staging}
          number={pr?.number}
          className="mt-1 mr-1 shrink-0"
        />
      )}
    </div>
  );
}

const NO_PR: SessionPrRef = { repo: "", branch: "", source: "primary" };

/** The PR a thread opened itself: its own branch's first, else any it owns
 *  outright. Not one it merely shares with a sibling. */
function threadPr(thread: UnifiedSession): SessionPrRef | null {
  const own = sessionPrRefs(thread).filter(
    (ref) => ref.number != null && ref.source !== "discovered",
  );
  return own.find((ref) => ref.source === "primary") ?? own[0] ?? null;
}
