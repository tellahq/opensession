import React, { useState } from "react";
import {
  askAgentInThreadApi,
  deleteThreadCommentApi,
  editThreadCommentApi,
  replyToThreadApi,
  updateThreadApi,
} from "../../lib/api";
import { AGENT_NAME } from "../../lib/brand";
import { agentIsAnswering } from "../../lib/comment-threads";
import { errorMessage } from "../../lib/error-message";
import { renderMarkdown } from "../../lib/markdown";
import { openLightbox } from "../../lib/media-lightbox";
import { usePeople } from "../../lib/people";
import type { CommentThread, ThreadComment } from "../../lib/types";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { Menu } from "../../ui/menu";
import { TextShimmer } from "../../ui/text-shimmer";
import { toast } from "../../ui/toast";
import {
  IconArrowUpRight,
  IconCheck,
  IconDotsHorizontal,
  IconLink,
  IconPencil,
  IconPerson,
  IconSparkle,
  IconTrash,
  IconUndo,
} from "../icons";
import { MarkdownBody } from "../MarkdownBody";
import { MentionText } from "../MentionText";
import { UserAvatar } from "../UserAvatar";
import { useCurrentUser } from "../UserPicker";
import { CommentComposer } from "./CommentComposer";

export function commentTime(ts: number): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

function same(a?: string, b?: string): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** A quiet "…" trigger: visible on hover, keyboard focus, or while open,
 *  and always on touch, where there is no hover. */
const QUIET_TRIGGER =
  "flex size-7 shrink-0 items-center justify-center rounded-control border-0 bg-transparent text-dim transition-opacity hover:bg-hover hover:text-fg data-[popup-open]:bg-hover data-[popup-open]:text-fg phone:size-11";

function CommentBody({
  comment,
  sessionId,
}: {
  comment: ThreadComment;
  sessionId: string;
}) {
  return (
    <>
      {comment.text &&
        (comment.agent ? (
          <MarkdownBody
            html={renderMarkdown(comment.text, { sessionId })}
            className="markdown text-body leading-relaxed text-fg"
          />
        ) : (
          <div className="whitespace-pre-wrap break-words text-body leading-relaxed text-fg">
            <MentionText text={comment.text} />
          </div>
        ))}
      {!!comment.images?.length && (
        <div className="mt-2 flex flex-wrap gap-2">
          {comment.images.map((src, index) => (
            <button
              key={src}
              type="button"
              className="focus-ring block cursor-zoom-in rounded-lg leading-[0]"
              onClick={(event) =>
                openLightbox(
                  comment.images!.map((image) => ({
                    kind: "image",
                    src: image,
                  })),
                  index,
                  event.currentTarget,
                )
              }
              aria-label="Open image"
            >
              <img
                src={src}
                alt=""
                loading="lazy"
                className="max-h-60 max-w-full rounded-lg object-contain"
              />
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function CommentItem({
  thread,
  comment,
  sessionId,
  label,
  editing,
  setEditing,
  trailing,
}: {
  thread: CommentThread;
  comment: ThreadComment;
  sessionId: string;
  /** A tag beside the name, like "Note" on a timeline thread's opener. */
  label?: React.ReactNode;
  editing: boolean;
  setEditing: (editing: boolean) => void;
  /** The thread's own actions, on the opening comment's row. They include
   *  that comment's edit and delete, so it has no menu of its own. */
  trailing?: React.ReactNode;
}) {
  const me = useCurrentUser();
  const mine = !comment.agent && same(comment.user, me);
  const canDelete = mine || !!comment.agent;

  async function remove() {
    try {
      await deleteThreadCommentApi(sessionId, thread.id, comment.id, me);
    } catch (error) {
      toast(errorMessage(error, "Failed to delete comment"));
    }
  }

  return (
    <div
      className="group/comment flex flex-col gap-1"
      data-comment-id={comment.id}
    >
      <div className="flex min-h-7 items-center gap-2">
        {!comment.agent && <UserAvatar name={comment.user} size={20} />}
        <span className="min-w-0 truncate text-supporting font-semibold text-fg">
          {comment.user}
        </span>
        {label}
        <span className="shrink-0 text-meta text-faint">
          {commentTime(comment.ts)}
          {comment.editedAt ? " · edited" : ""}
        </span>
        {trailing ? (
          <span className="ml-auto flex shrink-0 items-center gap-0.5">
            {trailing}
          </span>
        ) : (mine || canDelete) && !editing ? (
          <Menu.Root>
            <Menu.Trigger
              aria-label="Comment actions"
              className={cn(
                QUIET_TRIGGER,
                "ml-auto opacity-0 focus-visible:opacity-100 group-hover/comment:opacity-100 data-[popup-open]:opacity-100 pointer-coarse:opacity-100",
              )}
            >
              <IconDotsHorizontal size={20} />
            </Menu.Trigger>
            <Menu.Popup align="end">
              {mine && (
                <Menu.Item onClick={() => setEditing(true)}>
                  <IconPencil size={20} className="text-faint" />
                  Edit
                </Menu.Item>
              )}
              {mine && <Menu.Separator />}
              <Menu.Item onClick={() => void remove()} className="text-red">
                <IconTrash size={20} />
                Delete
              </Menu.Item>
            </Menu.Popup>
          </Menu.Root>
        ) : null}
      </div>
      {editing ? (
        <EditComment
          initial={comment.text}
          onCancel={() => setEditing(false)}
          onSave={async (text) => {
            try {
              await editThreadCommentApi(
                sessionId,
                thread.id,
                comment.id,
                text,
                me,
              );
              setEditing(false);
              return true;
            } catch (error) {
              toast(errorMessage(error, "Failed to edit comment"));
              return false;
            }
          }}
        />
      ) : (
        <div className="pl-7">
          <CommentBody comment={comment} sessionId={sessionId} />
        </div>
      )}
    </div>
  );
}

function EditComment({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (text: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  async function save() {
    const text = value.trim();
    if (!text || busy) return;
    if (text === initial) return onCancel();
    setBusy(true);
    await onSave(text).finally(() => setBusy(false));
  }
  return (
    <div className="flex flex-col gap-2 pl-7">
      <textarea
        autoFocus
        value={value}
        disabled={busy}
        aria-label="Edit comment"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void save();
          }
        }}
        className="block min-h-16 w-full resize-y rounded-control border border-line bg-surface px-2.5 py-2 text-body leading-snug text-fg outline-none focus-visible:border-accent phone:text-input-phone"
      />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="primary"
          onClick={() => void save()}
          disabled={busy || !value.trim()}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

/** Quote of the passage a thread points at, for surfaces away from it. */
export function ThreadPassage({
  thread,
  className,
}: {
  thread: CommentThread;
  className?: string;
}) {
  if (!thread.anchor) return null;
  return (
    <blockquote
      className={cn(
        "m-0 line-clamp-3 border-l-2 border-[color:var(--yellow)] pl-2.5 text-supporting text-dim",
        className,
      )}
    >
      {thread.anchor.exact}
    </blockquote>
  );
}

export interface ThreadViewProps {
  thread: CommentThread;
  sessionId: string;
  /** Show the reply box. Margin cards show it only while focused. */
  showReply?: boolean;
  /** Hands the thread to the main session's composer. */
  onSendToSession?: (thread: CommentThread) => void;
  /** Tag beside the opener's name. */
  rootLabel?: React.ReactNode;
  /** Called after resolve, so a host can close its card or sheet. */
  onResolved?: () => void;
  autoFocusReply?: boolean;
  /** Shown under the comments, above the reply box (a note's read receipt). */
  footer?: React.ReactNode;
}

/**
 * One comment thread: the comments, the agent working, the reply box, and
 * the thread's actions. Shared by the margin card, the phone sheet, the
 * comments list and the team note in the timeline.
 */
export function CommentThreadView({
  thread,
  sessionId,
  showReply = true,
  onSendToSession,
  rootLabel,
  onResolved,
  autoFocusReply,
  footer,
}: ThreadViewProps) {
  const me = useCurrentUser();
  const people = usePeople();
  const [editingId, setEditingId] = useState<string | null>(null);
  const resolved = thread.status === "resolved";
  const answering = agentIsAnswering(thread);
  const root = thread.comments[0]!;
  const rootMine = !root.agent && same(root.user, me);

  async function deleteThread() {
    try {
      await deleteThreadCommentApi(sessionId, thread.id, root.id, me);
    } catch (error) {
      toast(errorMessage(error, "Failed to delete comment"));
    }
  }

  async function setStatus(status: "open" | "resolved") {
    try {
      await updateThreadApi(sessionId, thread.id, { status }, me);
      if (status === "resolved") onResolved?.();
    } catch (error) {
      toast(errorMessage(error, "Failed to update comment"));
    }
  }

  async function assign(assignee: string | null) {
    try {
      await updateThreadApi(sessionId, thread.id, { assignee }, me);
      toast(assignee ? `Assigned to ${assignee}` : "Unassigned");
    } catch (error) {
      toast(errorMessage(error, "Failed to assign"));
    }
  }

  async function askAgent() {
    try {
      await askAgentInThreadApi(sessionId, thread.id, me);
    } catch (error) {
      toast(errorMessage(error, "Failed to ask the agent"));
    }
  }

  function copyLink() {
    const url = new URL(window.location.href);
    url.searchParams.set("thread", thread.id);
    void navigator.clipboard
      .writeText(url.toString())
      .then(() => toast("Link copied"));
  }

  const actions = (
    <>
      <Button
        size="sm"
        variant="ghost"
        icon={resolved ? <IconUndo size={20} /> : <IconCheck size={20} />}
        onClick={() => void setStatus(resolved ? "open" : "resolved")}
        aria-label={resolved ? "Reopen" : "Resolve"}
      >
        {resolved ? "Reopen" : "Resolve"}
      </Button>
      <Menu.Root>
        <Menu.Trigger aria-label="Thread actions" className={QUIET_TRIGGER}>
          <IconDotsHorizontal size={20} />
        </Menu.Trigger>
        <Menu.Popup align="end" className="min-w-[220px]">
          {onSendToSession && (
            <Menu.Item onClick={() => onSendToSession(thread)}>
              <IconArrowUpRight size={20} className="text-faint" />
              Send to session
            </Menu.Item>
          )}
          <Menu.Item onClick={() => void askAgent()} disabled={answering}>
            <IconSparkle size={20} className="text-faint" />
            Ask {AGENT_NAME}
          </Menu.Item>
          <Menu.Item onClick={copyLink}>
            <IconLink size={20} className="text-faint" />
            Copy link
          </Menu.Item>
          {(people.length > 0 || thread.assignee) && (
            <>
              <Menu.Separator />
              {/* Base UI requires a GroupLabel inside a Group (error #31). */}
              <Menu.Group>
                <Menu.GroupLabel>Assign to</Menu.GroupLabel>
                {thread.assignee && (
                  <Menu.Item onClick={() => void assign(null)}>
                    <IconPerson size={20} className="text-faint" />
                    Nobody
                  </Menu.Item>
                )}
                {people
                  .filter((p) => !same(p.name, thread.assignee))
                  .map((person) => (
                    <Menu.Item
                      key={person.name}
                      onClick={() => void assign(person.name)}
                    >
                      <UserAvatar name={person.name} size={18} />
                      {same(person.name, me)
                        ? `${person.name} (you)`
                        : person.name}
                    </Menu.Item>
                  ))}
              </Menu.Group>
            </>
          )}
          {rootMine && (
            <>
              <Menu.Separator />
              <Menu.Item onClick={() => setEditingId(root.id)}>
                <IconPencil size={20} className="text-faint" />
                Edit
              </Menu.Item>
              <Menu.Item
                onClick={() => void deleteThread()}
                className="text-red"
              >
                <IconTrash size={20} />
                Delete thread
              </Menu.Item>
            </>
          )}
        </Menu.Popup>
      </Menu.Root>
    </>
  );

  return (
    <div className="flex flex-col gap-3" data-thread-id={thread.id}>
      {(thread.assignee || resolved) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {thread.assignee && (
            <span className="inline-flex min-w-0 items-center gap-1 rounded-[999px] bg-fg/8 py-0.5 pl-1 pr-2 text-meta text-dim">
              <UserAvatar name={thread.assignee} size={14} />
              <span className="truncate">
                {same(thread.assignee, me)
                  ? "Assigned to you"
                  : `Assigned to ${thread.assignee}`}
              </span>
            </span>
          )}
          {resolved && (
            <span className="inline-flex items-center gap-1 text-meta text-faint">
              <IconCheck size={20} />
              Resolved{thread.resolvedBy ? ` by ${thread.resolvedBy}` : ""}
            </span>
          )}
        </div>
      )}
      {thread.comments.map((comment, index) => (
        <CommentItem
          key={comment.id}
          thread={thread}
          comment={comment}
          sessionId={sessionId}
          label={index === 0 ? rootLabel : undefined}
          editing={editingId === comment.id}
          setEditing={(on) => setEditingId(on ? comment.id : null)}
          trailing={index === 0 ? actions : undefined}
        />
      ))}
      {footer}
      {answering && (
        <div
          className="flex items-center gap-2 text-supporting text-dim"
          role="status"
        >
          <TextShimmer>{`${AGENT_NAME} is reading the session`}</TextShimmer>
        </div>
      )}
      {thread.comments.some((c) => c.agent) && onSendToSession && !resolved && (
        <div>
          <Button
            size="sm"
            variant="soft"
            icon={<IconArrowUpRight size={20} />}
            onClick={() => onSendToSession(thread)}
          >
            Send to session
          </Button>
        </div>
      )}
      {showReply && (
        <CommentComposer
          compact
          autoFocus={autoFocusReply}
          placeholder={resolved ? "Reply to reopen" : "Reply"}
          submitLabel="Reply"
          onSubmit={async (text) => {
            try {
              await replyToThreadApi(sessionId, thread.id, { text, user: me });
              if (resolved)
                await updateThreadApi(
                  sessionId,
                  thread.id,
                  { status: "open" },
                  me,
                );
              return true;
            } catch (error) {
              toast(errorMessage(error, "Failed to reply"));
              return false;
            }
          }}
        />
      )}
    </div>
  );
}
