import React, { useCallback, useEffect, useRef, useState } from "react";
import type {
  PlainEntryAttachment,
  PlainThread,
  PlainTimelineEntry,
} from "../lib/types";
import {
  API_BASE,
  changePlainThreadLabelsApi,
  fetchPlainThreadApi,
  PLAIN_ATTACHMENTS_MAX_COUNT,
  PLAIN_ATTACHMENT_MAX_BYTES,
  PLAIN_NOTE_ATTACHMENTS_MAX_BYTES,
  PLAIN_REPLY_ATTACHMENT_MAX_BYTES,
  sendPlainReplyApi,
  setPlainThreadAssigneeApi,
  setPlainThreadPriorityApi,
  setPlainThreadSpamApi,
  setPlainThreadStatusApi,
  setPlainThreadTitleApi,
  uploadPlainAttachmentApi,
} from "../lib/api";
import { BASE_PATH } from "../lib/base";
import { MENU_ICON, Menu } from "../ui/menu";
import { renderMarkdown } from "../lib/markdown";
import { MarkdownBody } from "./MarkdownBody";
import { loadDraft, saveDraft, clearDraft } from "../lib/drafts";
import { useCurrentUser } from "./UserPicker";
import { cn } from "../ui/cn";
import { PLAIN_WORKSPACE_ID, PRODUCT_NAME } from "../lib/brand";
import { PlainStatusBadge } from "./PlainStatusBadge";
import {
  composerBox,
  composerBoxExpanded,
  composerSend,
  composerSendDefault,
  composerTextarea,
  composerTextareaPadding,
  composerToolbar,
} from "../lib/composer-classes";
import { noAutofill } from "../lib/composer-autofill";
import { noteSurface } from "../lib/tinted-surface";
import { paletteIconBtn, palettePill } from "../lib/palette-classes";
import {
  plainEntryBody,
  plainEntryHead,
  plainEntryIn,
  plainEntryMeta,
  plainEntryName,
  plainEntryNote,
  plainEntryOut,
  plainEntryRow,
} from "../lib/plain-classes";
import { Button } from "../ui/button";
import { Tooltip } from "../ui/tooltip";
import {
  IconArrowUp,
  IconArrowUpRight,
  IconCheck,
  IconDotsHorizontal,
  IconClock,
  IconFlag,
  IconForbid,
  IconPaperclip,
  IconPencil,
  IconPerson,
  IconPlus,
  IconRestore,
  IconTag,
} from "./icons";
import { FileChips } from "./FileChips";
import { UserAvatar } from "./UserAvatar";
import { usePlainDirectory } from "../hooks/usePlainDirectory";
import {
  STATUS_LABEL,
  plainStatusIcon,
  plainStatusInk,
} from "../lib/plain-status";
import {
  priorityLabel,
  priorityTone,
  type PlainStatusChoice,
  type TicketLabel,
} from "../lib/plain-ticket";
import {
  PlainAssigneeItems,
  PlainLabelItems,
  PlainPriorityItems,
  PlainStatusItems,
} from "./PlainTicketMenuItems";
import { errorMessage } from "../lib/error-message";

interface Props {
  sessionId: string;
  /** The linked Plain thread id — panel re-fetches when it changes. */
  threadId: string;
  /** Deep link into the thread in the Plain app (the "jump into Plain" action). */
  plainUrl: string;
}

/** Deep link into the Plain app, or "" when the instance has no configured
 *  Plain workspace id (integrations.plain.workspaceId) — links hide. */
export function plainThreadUrl(threadId: string): string {
  return PLAIN_WORKSPACE_ID
    ? `https://app.plain.com/workspace/${PLAIN_WORKSPACE_ID}/thread/${threadId}/`
    : "";
}

function timeOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Read-only conversation timeline for a session's linked Plain thread: customer
 * emails/chats on the left, support/bot replies on the right, internal notes
 * inline. Polls lightly so new replies show up, and offers a one-click jump into
 * the thread in Plain. Shown as the session viewer's "Plain" workspace tab.
 */
export function PlainThreadPanel({ sessionId, threadId, plainUrl }: Props) {
  const [thread, setThread] = useState<PlainThread | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Load on mount / thread change, then poll — a customer can reply at any time
  // and there's no live push for Plain, so a gentle refresh keeps it current.
  // `load` is callable on its own so the reply box can refresh the timeline
  // right after a send instead of waiting out the poll.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  const load = useCallback(
    () =>
      fetchPlainThreadApi(sessionId)
        .then((t) => {
          if (!aliveRef.current) return;
          setThread(t);
          setError(null);
        })
        .catch((error) => {
          if (aliveRef.current) {
            // Record every failure so a later successful poll can clear it.
            // The error renders only when no valid thread is available.
            setError(errorMessage(error, "Failed to load Plain thread"));
          }
        })
        .finally(() => {
          if (aliveRef.current) setLoading(false);
        }),
    [sessionId],
  );
  useEffect(() => {
    setLoading(true);
    setError(null);
    load();
    const poll = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      load();
    }, 20000);
    return () => clearInterval(poll);
  }, [threadId, load]);

  // Keep the newest message in view, but only when the reader is already near the
  // bottom — a poll refresh shouldn't yank them out of scrollback.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [thread?.entries.length]);

  const status = thread?.status;

  return (
    <div className="flex h-full min-h-0 flex-col bg-raised">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-divider px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="truncate text-label font-semibold text-fg"
            title={thread?.customer?.email || ""}
          >
            {thread?.customer?.name ||
              thread?.customer?.email ||
              "Plain thread"}
          </span>
          {status && <PlainStatusBadge status={status} />}
        </div>
      </div>

      {thread?.waitingSince && (
        <PlainWaitingBanner
          thread={thread}
          className="shrink-0 mx-3 mt-2 rounded-md"
        />
      )}

      {thread && (
        <PlainThreadActions
          threadId={threadId}
          thread={thread}
          onChanged={load}
          className="shrink-0 px-3 py-2 border-b border-divider"
        />
      )}

      {thread?.title && (
        <div className="shrink-0 border-b border-divider px-3 py-2 text-label font-semibold text-fg">
          {thread.title}
        </div>
      )}

      <div
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3"
        ref={bodyRef}
      >
        {loading && !thread ? (
          <div className="mt-5 text-center text-label text-faint">
            Loading conversation…
          </div>
        ) : error && !thread ? (
          <div className="mt-5 text-center text-label text-faint">
            Couldn't load Plain thread: {error}
          </div>
        ) : thread && thread.entries.length === 0 ? (
          <div className="mt-5 text-center text-label text-faint">
            No messages in this thread yet.
          </div>
        ) : (
          thread?.entries.map((e) => (
            <PlainEntryRow
              key={e.id}
              entry={e}
              threadId={threadId}
              threadTitle={thread?.title}
            />
          ))
        )}
      </div>

      {thread && (
        <PlainReplyBox
          key={threadId}
          threadId={threadId}
          customerName={thread.customer?.name || thread.customer?.email || null}
          onSent={load}
          className="mx-3 mb-3"
        />
      )}
    </div>
  );
}

/**
 * Quick thread actions mirroring Plain's own inbox: status (Todo / Snoozed /
 * Done), priority, assignee, labels, and mark-as-spam. Spam lives on the
 * customer in Plain, so marking spam also closes the thread. Shared by the
 * session viewer's Plain tab and the Support ticket preview — like the reply
 * box, these are the human gate: agent runs never get Plain writes as tools.
 *
 * The row leads with the ticket's status as a picker that names it: the
 * state's glyph in its colour, the word, and a caret. It used to be a bare
 * badge beside a glyph-only check and clock, which left you to work out that
 * the badge was the state and the two glyphs were the ways to change it. Now
 * the state is the control, and the one change made most often, closing the
 * ticket, is a labelled button beside it.
 *
 * Two layouts. `stack` is the row above a thread: it wraps onto a second line
 * when it runs out of width, and reports a failure underneath. `bar` is the
 * Support inbox's top bar, where there is one line and no room to grow, so the
 * row cannot wrap, a failure reads beside the controls instead of below them,
 * and the two rarely-used actions (rename, spam) fold into an overflow menu.
 */
export function PlainThreadActions({
  threadId,
  thread,
  onChanged,
  layout = "stack",
  className,
}: {
  threadId: string;
  thread: PlainThread;
  /** Called after any successful action so the owner can refresh. */
  onChanged: () => void;
  layout?: "stack" | "bar";
  className?: string;
}) {
  const inBar = layout === "bar";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentUser = useCurrentUser();
  const { users, usersError, labelTypes, labelTypesError } =
    usePlainDirectory();

  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    await (async () => {
      await fn();
      onChanged();
    })()
      .catch(async (error) => {
        setError(errorMessage(error, "Plain update failed"));
      })
      .finally(async () => {
        setBusy(false);
      });
  }

  const status = thread.status;
  const setStatus = (s: PlainStatusChoice, durationSeconds?: number) =>
    run(() =>
      setPlainThreadStatusApi(threadId, s, {
        durationSeconds,
        user: currentUser,
      }),
    );

  const customerLabel =
    thread.customer?.name || thread.customer?.email || "this customer";
  const isSpam = !!thread.customer?.isSpam;

  // Shared by the visible buttons and their overflow-menu twins.
  const renameThread = () => {
    const next = window.prompt(
      "Rename this thread in Plain:",
      thread.title || "",
    );
    const t = next?.trim();
    if (t && t !== thread.title)
      run(() => setPlainThreadTitleApi(threadId, t, currentUser));
  };
  const toggleSpam = () => {
    if (
      isSpam ||
      window.confirm(
        `Mark ${customerLabel} as spam?\n\nPlain filters all their threads and this one is closed right away. Reversible via “Not spam”.`,
      )
    )
      run(() => setPlainThreadSpamApi(threadId, !isSpam, currentUser));
  };
  const spamTitle = isSpam
    ? "This customer is marked as spam in Plain. Click to undo."
    : "Mark this customer as spam in Plain (also closes the thread)";

  const labels: TicketLabel[] = (thread.labels || []).map((l) => ({
    id: l.id,
    typeId: l.labelTypeId,
    name: l.name,
  }));
  const flagTone = priorityTone(thread.priority);
  const StatusIcon = plainStatusIcon(status || "");
  const statusLabel = status ? STATUS_LABEL[status] || status : "Status";

  // The way out to Plain, for the few things this pane cannot do. It belongs
  // with the ticket's other actions rather than beside them as a link: it
  // used to be a blue anchor at the end of the bar, which made the quietest
  // action in the row the loudest thing in it, and put a second vocabulary
  // next to five bordered controls. An action that NAVIGATES still has to be
  // an anchor, so it is the Button primitive rendered as one — that is what
  // `render` and the `trailing` outbound arrow are for.
  const plainUrl = plainThreadUrl(threadId);

  return (
    <div
      className={cn(
        "flex gap-1",
        inBar ? "min-w-0 items-center" : "flex-col",
        className,
      )}
    >
      {/* Each action draws its own edge (`default`, the raised control),
			    rather than the set sharing one box. A ghost has no shape until
			    you hover it, so beside a subject these read as loose words
			    trailing off it; giving each one a hairline says where a control
			    starts and ends, and keeps them separable: they are six unrelated
			    fields, not one segmented choice. */}
      <div
        className={cn(
          "flex items-center gap-1",
          inBar ? "flex-nowrap" : "flex-wrap",
        )}
      >
        <Menu.Root>
          <Menu.Trigger
            render={
              <Button
                size="sm"
                variant="default"
                icon={
                  <StatusIcon
                    size={20}
                    className={plainStatusInk(status || "")}
                  />
                }
                iconTone="full"
                caret
                disabled={busy}
                aria-label={`Status: ${statusLabel}. Change status`}
                title="Change status in Plain"
              >
                {statusLabel}
              </Button>
            }
          />
          <Menu.Popup align="start" className="min-w-[200px]">
            <PlainStatusItems status={status} onPick={setStatus} />
          </Menu.Popup>
        </Menu.Root>
        {status === "DONE" ? (
          <Button
            size="sm"
            variant="default"
            icon={<IconRestore size={20} />}
            disabled={busy}
            onClick={() => setStatus("todo")}
            title="Reopen this thread (back to Todo)"
          >
            Reopen
          </Button>
        ) : (
          <Button
            size="sm"
            variant="default"
            icon={<IconCheck size={20} />}
            className="hover:text-green"
            disabled={busy}
            onClick={() => setStatus("done")}
            title="Mark this thread Done in Plain"
          >
            Mark done
          </Button>
        )}
        <Menu.Root>
          <Menu.Trigger
            render={
              <Button
                size="sm"
                variant="default"
                // The flag takes the priority's queue colour, so the pill
                // and the ticket's dot in the list say the same thing.
                icon={<IconFlag size={20} className={flagTone} />}
                iconTone={flagTone ? "full" : "muted"}
                caret
                disabled={busy}
                title="Change priority in Plain"
              >
                {priorityLabel(thread.priority)}
              </Button>
            }
          />
          <Menu.Popup align="start">
            <PlainPriorityItems
              priority={thread.priority}
              onPick={(p) =>
                run(() => setPlainThreadPriorityApi(threadId, p, currentUser))
              }
            />
          </Menu.Popup>
        </Menu.Root>
        <Menu.Root>
          <Menu.Trigger
            render={
              <Button
                size="sm"
                variant="default"
                // An assigned ticket leads with the person's picture, the
                // way the Assign menu lists them. It sits in the pill's
                // round end, so it is round too and tucks in closer than a
                // glyph, which carries its own side bearing.
                icon={
                  thread.assignee && !usersError ? (
                    <UserAvatar
                      name={thread.assignee.name}
                      size={18}
                      className="rounded-full"
                    />
                  ) : (
                    <IconPerson size={20} />
                  )
                }
                iconTone={thread.assignee ? "full" : "muted"}
                className={cn(thread.assignee && !usersError && "pl-1")}
                caret
                disabled={busy}
                title={
                  usersError ??
                  (thread.assignee
                    ? `Assigned to ${thread.assignee.name} in Plain`
                    : "Assign this thread to a teammate in Plain")
                }
              >
                {usersError
                  ? "Assign unavailable"
                  : thread.assignee
                    ? thread.assignee.name
                    : "Assign"}
              </Button>
            }
          />
          <Menu.Popup align="start">
            <PlainAssigneeItems
              assigneeId={thread.assignee?.id}
              users={users}
              error={usersError}
              onPick={(userId) =>
                run(() =>
                  setPlainThreadAssigneeApi(threadId, userId, currentUser),
                )
              }
            />
          </Menu.Popup>
        </Menu.Root>
        {(labelTypesError || (labelTypes?.length || 0) > 0) && (
          <Menu.Root>
            <Menu.Trigger
              render={
                <Button
                  size="sm"
                  variant="default"
                  icon={<IconTag size={20} />}
                  caret
                  disabled={busy}
                  title={
                    labelTypesError ??
                    (labels.length > 0
                      ? labels.map((l) => l.name).join(", ")
                      : "Labels on this thread in Plain")
                  }
                >
                  {labelTypesError ? (
                    "Labels unavailable"
                  ) : labels.length > 1 ? (
                    // The first label is the value and the rest a count on a
                    // chip of its own, so "question +1" reads as one label
                    // and one more rather than as a two-word name. The
                    // tooltip names them all. Both are flex items of the
                    // button, so each trims to its cap band like a plain
                    // string label does.
                    <>
                      <span className="[text-box:trim-both_cap_alphabetic]">
                        {labels[0].name}
                      </span>
                      <span className="inline-flex h-4 items-center rounded-full bg-active px-1.5 text-meta tabular-nums text-dim">
                        <span className="[text-box:trim-both_cap_alphabetic]">
                          +{labels.length - 1}
                        </span>
                      </span>
                    </>
                  ) : (
                    (labels[0]?.name ?? "Labels")
                  )}
                </Button>
              }
            />
            <Menu.Popup align="start">
              <PlainLabelItems
                labels={labels}
                labelTypes={labelTypes}
                error={labelTypesError}
                onToggle={(lt, existing) =>
                  run(() =>
                    changePlainThreadLabelsApi(
                      threadId,
                      existing
                        ? { removeLabelIds: [existing.id] }
                        : { addLabelTypeIds: [lt.id] },
                      currentUser,
                    ),
                  )
                }
              />
            </Menu.Popup>
          </Menu.Root>
        )}
        {plainUrl && !inBar && (
          <Button
            size="sm"
            variant="default"
            trailing={<IconArrowUpRight size={14} />}
            render={<a href={plainUrl} target="_blank" rel="noreferrer" />}
            title="Open this thread in Plain"
          >
            Open in Plain
          </Button>
        )}
        {inBar ? (
          <Menu.Root>
            <Menu.Trigger
              render={
                <Button
                  size="sm"
                  variant="default"
                  icon={<IconDotsHorizontal size={20} />}
                  disabled={busy}
                  aria-label="More ticket actions"
                  title="More actions"
                />
              }
            />
            <Menu.Popup align="end">
              {/* In the bar the way out to Plain folds in here with the
                  two rare actions: the labelled status picker and Mark
                  done took the width it had, and a ticket's subject
                  needs it more than a link does. */}
              {plainUrl && (
                <Menu.Item
                  render={
                    <a href={plainUrl} target="_blank" rel="noreferrer" />
                  }
                >
                  <IconArrowUpRight size={20} className={MENU_ICON} />
                  <span className="grow">Open in Plain</span>
                </Menu.Item>
              )}
              <Menu.Item onClick={renameThread}>
                <IconPencil size={20} className={MENU_ICON} />
                <span className="grow">Rename</span>
              </Menu.Item>
              <Menu.Item onClick={toggleSpam}>
                <IconForbid size={20} className={MENU_ICON} />
                <span className="grow">
                  {isSpam ? "Not spam" : "Mark as spam"}
                </span>
              </Menu.Item>
            </Menu.Popup>
          </Menu.Root>
        ) : (
          <>
            <Button
              size="sm"
              variant="default"
              icon={<IconPencil size={20} />}
              disabled={busy}
              onClick={renameThread}
              title="Rename this thread in Plain"
            >
              Rename
            </Button>
            <Button
              size="sm"
              variant="default"
              icon={<IconForbid size={20} />}
              className={cn(!isSpam && "hover:text-red")}
              disabled={busy}
              onClick={toggleSpam}
              title={spamTitle}
            >
              {isSpam ? "Not spam" : "Spam"}
            </Button>
          </>
        )}
      </div>
      {error && (
        <span
          className={cn(
            "text-red text-label truncate",
            inBar && "max-w-[160px] shrink-0",
          )}
          title={error}
        >
          {error}
        </span>
      )}
    </div>
  );
}

/**
 * Human reply box for a Plain thread — a customer-facing reply (sent via
 * Plain as the bot machine user) or an internal note for the team.
 * Shared by the session viewer's Plain tab and the Support ticket preview.
 * ⌘/Ctrl+Enter sends; the draft persists per thread.
 */
export function PlainReplyBox({
  threadId,
  customerName,
  onSent,
  className,
}: {
  threadId: string;
  customerName: string | null;
  /** Called after a successful send, so the owner can refresh the timeline. */
  onSent?: () => void;
  className?: string;
}) {
  const draftKey = `plain-reply:${threadId}`;
  const [text, setText] = useState(() => loadDraft(draftKey).text);
  useEffect(() => {
    saveDraft(draftKey, { text });
  }, [draftKey, text]);
  const [kind, setKind] = useState<"reply" | "note">("reply");
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sentTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => () => clearTimeout(sentTimer.current), []);
  const currentUser = useCurrentUser();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "";
    if (text) el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  async function handleSend() {
    const t = text.trim();
    if ((!t && attachments.length === 0) || sending) return;
    const attachmentBytes = attachments.reduce(
      (total, file) => total + file.size,
      0,
    );
    const attachmentLimit =
      kind === "note"
        ? PLAIN_NOTE_ATTACHMENTS_MAX_BYTES
        : PLAIN_REPLY_ATTACHMENT_MAX_BYTES;
    if (attachmentBytes > attachmentLimit) {
      setError(
        kind === "note"
          ? "Internal note attachments are limited to 50 MB total"
          : "Reply attachments are limited to 6 MB total",
      );
      return;
    }
    setSending(true);
    setError(null);
    await (async () => {
      const attachmentIds: string[] = [];
      for (const file of attachments) {
        attachmentIds.push(
          await uploadPlainAttachmentApi(threadId, file, kind),
        );
      }
      await sendPlainReplyApi(threadId, t, kind, currentUser, attachmentIds);
      setText("");
      setAttachments([]);
      clearDraft(draftKey);
      setSent(true);
      clearTimeout(sentTimer.current);
      sentTimer.current = setTimeout(() => setSent(false), 3000);
      onSent?.();
    })()
      .catch(async (error) => {
        setError(errorMessage(error, "Failed to send"));
      })
      .finally(async () => {
        setSending(false);
      });
  }

  // The same wash a team note takes in a session transcript (lib/tinted-surface).
  const noteStyle: React.CSSProperties | undefined =
    kind === "note"
      ? { backgroundColor: noteSurface("var(--composer-surface)") }
      : undefined;

  return (
    <div
      className={cn(
        "composer shrink-0",
        composerBox,
        composerBoxExpanded,
        className,
      )}
      style={noteStyle}
    >
      <FileChips
        files={attachments.map((file) => ({
          name: file.name,
          type: file.type,
        }))}
        onRemove={(index) =>
          setAttachments((current) => current.filter((_, i) => i !== index))
        }
        disabled={sending}
      />
      <textarea
        ref={textareaRef}
        rows={1}
        {...noAutofill}
        className={cn(
          "composer-textarea min-h-12 text-fg placeholder:text-faint",
          composerTextarea,
          composerTextareaPadding,
        )}
        placeholder={
          kind === "note"
            ? "Internal note for the team (English)…"
            : `Reply to ${customerName || "the customer"}, sent via Plain…`
        }
        value={text}
        disabled={sending}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            handleSend();
          }
        }}
      />
      {error && (
        <div className="mt-1 truncate text-label text-red" title={error}>
          {error}
        </div>
      )}
      <div className={composerToolbar}>
        <Tooltip label="Add attachments">
          <button
            type="button"
            className={cn(paletteIconBtn, "-ml-1.5")}
            onClick={() => fileInputRef.current?.click()}
            disabled={sending}
            aria-label="Add attachments"
          >
            <IconPlus size={20} />
          </button>
        </Tooltip>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const picked = Array.from(event.target.files || []);
            const accepted = picked.filter(
              (file) => file.size <= PLAIN_ATTACHMENT_MAX_BYTES,
            );
            const rejected = picked.find(
              (file) => file.size > PLAIN_ATTACHMENT_MAX_BYTES,
            );
            if (accepted.length) {
              setAttachments((current) => {
                const available = PLAIN_ATTACHMENTS_MAX_COUNT - current.length;
                if (accepted.length > available) {
                  setError(
                    `You can attach up to ${PLAIN_ATTACHMENTS_MAX_COUNT} files`,
                  );
                }
                return [
                  ...current,
                  ...accepted.slice(0, Math.max(0, available)),
                ];
              });
            }
            if (rejected) setError(`${rejected.name} is too large (25 MB max)`);
            event.target.value = "";
          }}
        />
        {/* A labelled toggle rather than a bare glyph: which of the two
				    things this box sends — a customer-facing reply or an internal
				    note — is the one thing you must never have to guess. Same
				    "Note" marker the session composer puts beside its own "+". */}
        <Tooltip
          label={
            kind === "note"
              ? "Switch to a customer reply"
              : "Write a note only the team sees"
          }
        >
          <button
            type="button"
            aria-pressed={kind === "note"}
            className={cn(
              palettePill,
              "shrink-0",
              kind === "note" &&
                "bg-[color-mix(in_srgb,var(--yellow-tint)_22%,transparent)] text-yellow hover:bg-[color-mix(in_srgb,var(--yellow-tint)_32%,transparent)] hover:text-yellow",
            )}
            onClick={() =>
              setKind((current) => (current === "note" ? "reply" : "note"))
            }
            disabled={sending}
          >
            <IconPencil size={14} />
            Internal note
          </button>
        </Tooltip>
        <span className="min-w-0 truncate text-meta text-faint phone:hidden">
          {kind === "note"
            ? `Posted as ${currentUser} (via ${PRODUCT_NAME})`
            : `Via Plain, signed “${currentUser.split(/\s+/)[0]}”`}
        </span>
        {sent && (
          <span className="shrink-0 text-meta font-semibold text-green">
            Sent ✓
          </span>
        )}
        <button
          type="button"
          className={cn("ml-auto", composerSend, composerSendDefault)}
          onClick={handleSend}
          disabled={sending || (!text.trim() && attachments.length === 0)}
          title="Send (⌘↵)"
          aria-label={kind === "note" ? "Add internal note" : "Send reply"}
        >
          <IconArrowUp size={24} />
        </button>
      </div>
    </div>
  );
}

/** "3d 4h" / "2h 15m" / "8m" — coarse enough to read at a glance. */
function waitDuration(since: string): string {
  const ms = Date.now() - new Date(since).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * "Customer waiting 2d 4h" — the signal Plain gives a whole banner to and we
 * previously dropped. Uses Plain's own inbound/outbound tracking, so the
 * autoresponder never counts as an answer.
 */
export function PlainWaitingBanner({
  thread,
  className,
}: {
  thread: PlainThread;
  className?: string;
}) {
  if (!thread.waitingSince || thread.status === "DONE") return null;
  const waited = waitDuration(thread.waitingSince);
  if (!waited) return null;
  const who = thread.customer?.name || thread.customer?.email || "Customer";
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg bg-yellow-soft px-3 py-1.5 text-supporting text-fg",
        className,
      )}
    >
      <IconClock size={16} className="shrink-0 text-yellow" />
      <span className="min-w-0 truncate">
        {thread.awaitingFirstResponse ? (
          <>
            <strong className="font-semibold">{who}</strong> is waiting for a
            first response
          </>
        ) : (
          <>
            <strong className="font-semibold">{who}</strong> is waiting for a
            reply
          </>
        )}
        <span className="text-dim"> · {waited}</span>
      </span>
    </div>
  );
}

/** Human-readable file size for an attachment chip. */
function fileSize(bytes: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A message's attachments. Images render inline — on a visual bug report the
 * screenshot usually *is* the report — and click through to the full-size file.
 * Everything else gets a download chip.
 */
function PlainAttachments({
  attachments,
}: {
  attachments: PlainEntryAttachment[];
}) {
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  return (
    <div className="flex flex-wrap gap-2 mt-2">
      {attachments.map((a) => {
        const href = `${API_BASE}/plain/attachments/${encodeURIComponent(a.id)}`;
        const isImage = a.mimeType.startsWith("image/") && !failed[a.id];
        return (
          <a
            key={a.id}
            href={href}
            target="_blank"
            rel="noreferrer"
            title={`${a.fileName}${a.sizeBytes ? ` · ${fileSize(a.sizeBytes)}` : ""}`}
            className={cn(
              "block overflow-hidden rounded-lg no-underline",
              isImage
                ? "md-image-link bg-surface"
                : "inline-flex items-center gap-1.5 bg-active px-2.5 py-1.5 text-label text-dim hover:bg-hover hover:text-fg",
            )}
          >
            {isImage ? (
              <img
                src={href}
                alt={a.fileName}
                loading="lazy"
                onError={() => setFailed((f) => ({ ...f, [a.id]: true }))}
                /* md-image is what opens the lightbox. Its own block
								   treatment is for a full-width transcript image, so the
								   thumbnail keeps its cap and drops the border and margin
								   the wrapper already provides. */
                className="md-image m-0 block max-h-[220px] max-w-full border-0 bg-surface object-contain"
              />
            ) : (
              <>
                <IconPaperclip size={16} className="shrink-0 opacity-60" />
                <span className="truncate">{a.fileName}</span>
                {a.sizeBytes ? (
                  <span className="shrink-0 text-faint">
                    {fileSize(a.sizeBytes)}
                  </span>
                ) : null}
              </>
            )}
          </a>
        );
      })}
    </div>
  );
}

/**
 * A message body, rendered as markdown. Customer mail and our own replies get
 * the same treatment a session message does: `**test**` is bold, a pasted
 * stack trace in a fence is highlighted, and an inline image opens the shared
 * lightbox (markdown.ts emits the `md-image` class the delegated handler in
 * MediaLightbox.tsx watches for).
 *
 * Deliberately rendered with no context: a bare `#123` in a customer's mail is
 * their order number rather than a PR in our repo, and raw HTML they paste
 * stays literal text, which is the renderer's default.
 */
function PlainEntryText({ text }: { text: string }) {
  const html = renderMarkdown(text);
  return <MarkdownBody className={plainEntryBody} html={html} />;
}

/**
 * Notes posted from here carry an author prefix (see the reply route) because
 * Plain's API can't attribute a write to a workspace user — everything lands
 * as our machine user. Unpick that so a teammate's note shows *their* name,
 * and so anything else from the machine user is honestly labelled as the
 * agent rather than passing for a human.
 */
const NOTE_VIA_PREFIX = /^\*\*(.+?) \(via [^)]+\):\*\*\s*/;

function noteAuthor(entry: PlainTimelineEntry) {
  const viaUs = entry.text.match(NOTE_VIA_PREFIX);
  if (viaUs)
    return {
      name: viaUs[1],
      isAgent: false,
      text: entry.text.slice(viaUs[0].length),
    };
  if (entry.actorType === "bot") {
    // Agents open their notes with their own name; the badge says it now.
    const selfSigned = new RegExp(
      `^${entry.actorName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*`,
    );
    return {
      name: entry.actorName,
      isAgent: true,
      text: entry.text.replace(selfSigned, ""),
    };
  }
  return { name: entry.actorName, isAgent: false, text: entry.text };
}

/**
 * A message repeats the thread's own subject on almost every line ("Re: …"),
 * which is the loudest thing in the timeline and the one fact the reader
 * already has. Show it only where it says something new.
 */
function subjectWorthShowing(
  subject: string | null | undefined,
  threadTitle?: string | null,
): string | null {
  const s = subject?.trim();
  if (!s) return null;
  if (!threadTitle) return s;
  const bare = (t: string) =>
    t
      .replace(/^((re|fwd|fw)\s*:\s*)+/i, "")
      .trim()
      .toLowerCase();
  return bare(s) === bare(threadTitle) ? null : s;
}

export function PlainEntryRow({
  entry,
  threadId,
  threadTitle,
}: {
  entry: PlainTimelineEntry;
  /** Enables the "open the triage session" link on agent notes. */
  threadId?: string;
  /** The thread's own subject, so a message that only echoes it stays quiet. */
  threadTitle?: string | null;
}) {
  if (entry.kind === "note") {
    const author = noteAuthor(entry);
    return (
      <div
        className={plainEntryNote}
        style={{ background: noteSurface("transparent") }}
      >
        <div className={plainEntryHead}>
          <span className={plainEntryName}>{author.name}</span>
          <span
            className="text-meta font-semibold text-yellow"
            title="Only the team sees this note"
          >
            Note
          </span>
          {author.isAgent && (
            <span
              className={plainEntryMeta}
              title="Written by an agent run, not a teammate"
            >
              agent
            </span>
          )}
          <span className={plainEntryMeta}>{timeOf(entry.timestamp)}</span>
          {author.isAgent && threadId && (
            <a
              className="ml-auto inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap text-meta font-semibold text-link no-underline hover:underline"
              href={`${BASE_PATH}/plain-triage/${encodeURIComponent(threadId)}`}
              target="_blank"
              rel="noreferrer"
              title="Open the triage session for this ticket"
            >
              Session
              <IconArrowUpRight size={13} />
            </a>
          )}
        </div>
        <PlainEntryText text={author.text} />
        {entry.attachments?.length ? (
          <PlainAttachments attachments={entry.attachments} />
        ) : null}
      </div>
    );
  }

  const ours = entry.actorType !== "customer";
  const subject = subjectWorthShowing(entry.subject, threadTitle);
  return (
    <div className={plainEntryRow}>
      {/* The head sits above the message rather than inside it, so our own
			    bubble holds nothing but the words — the transcript's grammar for a
			    speaker label, and the only way the customer's side can lose its
			    plate without losing who wrote it. */}
      <div className={cn(plainEntryHead, ours && "flex-row-reverse")}>
        <span className={plainEntryName}>{entry.actorName}</span>
        <span className={plainEntryMeta}>
          {entry.kind} · {timeOf(entry.timestamp)}
        </span>
      </div>
      <div className={ours ? plainEntryOut : plainEntryIn}>
        {subject && (
          <div className="text-body font-semibold text-fg">{subject}</div>
        )}
        {entry.text && <PlainEntryText text={entry.text} />}
        {entry.attachments?.length ? (
          <PlainAttachments attachments={entry.attachments} />
        ) : null}
      </div>
    </div>
  );
}

export default PlainThreadPanel;
