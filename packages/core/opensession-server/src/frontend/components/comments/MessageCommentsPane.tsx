import { useEffect } from "react";
import { createThreadApi } from "../../lib/api";
import { fetchReactionsApi } from "../../lib/api/threads";
import { sendThreadToSession } from "../../lib/comment-threads";
import { errorMessage } from "../../lib/error-message";
import {
  closeMessageComments,
  openMessageComments,
  publishMessageReactions,
  publishMessageThreads,
  useMessageThreads,
  useOpenMessageComments,
  type OpenMessageComments,
} from "../../lib/message-comments";
import type { CommentThread } from "../../lib/types";
import { useSessionSocket } from "../../hooks/useSessionSocket";
import { Button } from "../../ui/button";
import { ListRow } from "../../ui/list-row";
import { ResponsiveDialog, SheetBody, SheetIconButton } from "../../ui/sheet";
import { toast } from "../../ui/toast";
import { Tooltip } from "../../ui/tooltip";
import { IconChevronDown, IconChevronLeft, IconX } from "../icons";
import { UserAvatar } from "../UserAvatar";
import { getCurrentUser } from "../UserPicker";
import { CommentComposer } from "./CommentComposer";
import { CommentThreadView } from "./CommentThreadView";

/**
 * The comments on one message, beside the conversation: the message quoted at
 * the top, the thread under it, and arrows to step through every message that
 * has comments. A side conversation among people; the agent reads it only
 * when someone mentions it.
 *
 * Mounted once per session viewer. It also keeps the session's message
 * comments and reactions in lib/message-comments.ts, which the rows read.
 */
export function MessageCommentsPane({
  sessionId,
  threads,
  containerRef,
  isPhone,
}: {
  sessionId: string;
  threads: CommentThread[];
  /** The transcript scroller, to bring a message into view. */
  containerRef: React.RefObject<HTMLElement | null>;
  isPhone: boolean;
}) {
  useEffect(() => {
    publishMessageThreads(sessionId, threads);
  }, [sessionId, threads]);
  useSessionReactions(sessionId);
  const open = useOpenMessageComments();
  const commented = useMessageThreads(sessionId);
  const target = open?.sessionId === sessionId ? open : null;

  // Leaving the session closes its pane.
  useEffect(() => () => closeMessageComments(), [sessionId]);

  if (!target) return null;
  const thread =
    commented.find((t) => t.anchor?.entryId === target.entryId) ?? null;
  const index = commented.findIndex(
    (t) => t.anchor?.entryId === target.entryId,
  );
  const step = (delta: number) => {
    const next =
      commented[
        index < 0 ? (delta > 0 ? 0 : commented.length - 1) : index + delta
      ];
    if (!next?.anchor) return;
    revealMessage(containerRef.current, next.anchor.entryId);
    openMessageComments({
      sessionId,
      entryId: next.anchor.entryId,
      excerpt: next.anchor.exact,
      author: next.anchor.by ?? "Message",
    });
  };

  const body = (
    <PaneBody
      sessionId={sessionId}
      target={target}
      thread={thread}
      onReveal={() => revealMessage(containerRef.current, target.entryId)}
    />
  );
  const nav = (
    <div className="flex items-center gap-0.5">
      <Tooltip label="Previous commented message">
        <Button
          variant="ghost"
          size="sm"
          aria-label="Previous commented message"
          icon={<IconChevronDown size={20} className="rotate-180" />}
          disabled={commented.length === 0 || index === 0}
          onClick={() => step(-1)}
          className="phone:size-11"
        />
      </Tooltip>
      <Tooltip label="Next commented message">
        <Button
          variant="ghost"
          size="sm"
          aria-label="Next commented message"
          icon={<IconChevronDown size={20} />}
          disabled={
            commented.length === 0 ||
            (index >= 0 && index === commented.length - 1)
          }
          onClick={() => step(1)}
          className="phone:size-11"
        />
      </Tooltip>
    </div>
  );

  if (isPhone)
    return (
      <ResponsiveDialog
        open
        onClose={closeMessageComments}
        phone
        label="Comments"
        sheetClassName="max-h-[88dvh]"
      >
        <div className="flex shrink-0 items-center gap-2 px-4 pb-2 pt-0.5">
          <h2 className="m-0 flex-1 text-dialog-title font-semibold text-fg">
            Comments
          </h2>
          {nav}
          <SheetIconButton aria-label="Close" onClick={closeMessageComments}>
            <IconX />
          </SheetIconButton>
        </div>
        <SheetBody className="flex flex-1 flex-col gap-3 px-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
          {body}
        </SheetBody>
      </ResponsiveDialog>
    );

  return (
    <aside
      aria-label="Comments"
      data-comment-card
      className="absolute inset-y-0 right-0 z-30 flex w-[min(400px,100%)] flex-col bg-surface shadow-[var(--shadow-popup,0_8px_32px_rgba(0,0,0,0.12))]"
    >
      <div className="flex shrink-0 items-center gap-1 px-3 pt-3 pb-2">
        <Button
          variant="ghost"
          size="sm"
          aria-label="Close comments"
          icon={<IconChevronLeft size={20} />}
          onClick={closeMessageComments}
        />
        <h2 className="m-0 flex-1 text-item-title font-semibold text-fg">
          Comments
        </h2>
        {nav}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4">
        {body}
      </div>
    </aside>
  );
}

function PaneBody({
  sessionId,
  target,
  thread,
  onReveal,
}: {
  sessionId: string;
  target: OpenMessageComments;
  thread: CommentThread | null;
  onReveal: () => void;
}) {
  return (
    <>
      <ListRow variant="card" className="flex-col gap-1" onClick={onReveal}>
        <span className="flex items-center gap-1.5 text-meta font-medium text-dim">
          <UserAvatar name={target.author} size={16} />
          {target.author}
        </span>
        <span className="line-clamp-4 text-label text-fg">
          {target.excerpt || "Message"}
        </span>
      </ListRow>
      {thread ? (
        <CommentThreadView
          key={thread.id}
          thread={thread}
          sessionId={sessionId}
          autoFocusReply
          onSendToSession={(t) => {
            sendThreadToSession(sessionId, t);
            closeMessageComments();
          }}
        />
      ) : (
        <CommentComposer
          autoFocus
          placeholder="Comment on this message"
          submitLabel="Comment"
          onCancel={closeMessageComments}
          onSubmit={async (text) => {
            try {
              await createThreadApi(sessionId, {
                text,
                user: getCurrentUser(),
                anchor: {
                  entryId: target.entryId,
                  exact: target.excerpt || "Message",
                  prefix: "",
                  suffix: "",
                  whole: true,
                  by: target.author,
                },
              });
              return true;
            } catch (error) {
              toast(errorMessage(error, "Couldn't add the comment"), {
                variant: "error",
              });
              return false;
            }
          }}
        />
      )}
      <p className="m-0 text-meta text-faint">
        Comments are between people. The agent reads them only when someone
        mentions @agent.
      </p>
    </>
  );
}

/** Scroll the conversation to a message and flash it. */
function revealMessage(container: HTMLElement | null, entryId: string) {
  const row = container?.querySelector<HTMLElement>(
    `[data-eid="${CSS.escape(entryId)}"]`,
  );
  if (!row) return;
  row.scrollIntoView({
    block: "center",
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "auto"
      : "smooth",
  });
}

/** Load the session's reactions and keep them current from the socket. */
function useSessionReactions(sessionId: string) {
  const { addHandler } = useSessionSocket();
  useEffect(() => {
    let live = true;
    publishMessageReactions(sessionId, {});
    void fetchReactionsApi(sessionId)
      .then((reactions) => {
        if (live) publishMessageReactions(sessionId, reactions);
      })
      .catch(() => {});
    const off = addHandler((msg) => {
      if (msg.type === "message_reactions" && msg.sessionId === sessionId)
        publishMessageReactions(sessionId, msg.reactions);
    });
    return () => {
      live = false;
      off();
    };
  }, [sessionId, addHandler]);
}
