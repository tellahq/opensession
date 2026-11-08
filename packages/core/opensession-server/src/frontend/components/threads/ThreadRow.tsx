import { useEffect, useState } from "react";
import { fetchSessionOverview } from "../../lib/api/workspaces";
import { shortTime } from "../../lib/time";
import {
  threadState,
  threadStatusLine,
  type ThreadState,
} from "../../lib/session-threads";
import type { UnifiedSession } from "../../lib/types";
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
  onOpen,
}: {
  thread: UnifiedSession;
  onOpen?: (id: string) => void;
}) {
  const state = threadState(thread);
  const gist = useThreadGist(thread, state);
  const status = threadStatusLine(thread);
  const starter = thread.startedBy || thread.createdBy || "";
  return (
    <ListRow onClick={() => onOpen?.(thread.id)} title={thread.title}>
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
        <span className="line-clamp-2 text-meta text-dim">
          {status}
          {gist && <span className="text-faint"> · {gist}</span>}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5 pt-0.5">
        {starter && <UserAvatar name={starter} size={16} edge={false} />}
        <span className="text-meta tabular-nums text-faint">
          {shortTime(thread.lastActivity)}
        </span>
      </span>
    </ListRow>
  );
}
