import React, { useState } from "react";
import type { TranscriptEntry } from "../lib/types";
import { renderMarkdown } from "../lib/markdown";
import { MarkdownBody, useMarkdownRepo } from "./MarkdownBody";
import { classifyEntry } from "@tellahq/opensession-protocol/notices";
import type { NoticeIcon as NoticeIconName } from "@tellahq/opensession-protocol/notices";
import { useCurrentUser } from "./UserPicker";
import { Tooltip } from "../ui/tooltip";
import { Button } from "../ui/button";
import { BASE_PATH } from "../lib/base";
import { resolveEntryImageSrc } from "../lib/osBlob";
import { extBadge } from "../lib/images";
import { useOpenAsset, useOpenAssetPaths } from "../lib/open-asset";
import { assetPathForMediaSrc } from "../lib/asset-preview";
import { fullTime, shortTime } from "../lib/time";
import { UserAvatar } from "./UserAvatar";
import { openGalleryFrom } from "../lib/media-lightbox-gallery";
import { IconExpand, IconPencil } from "./icons";
import { personKey } from "../lib/review-queue";
import { AnsweredAskCard } from "./AnsweredAskCard";

import {
  fileChipCard,
  fileChipCardPadding,
  fileChipMeta,
  fileChipName,
  fileChipSub,
  fileChipThumb,
} from "../lib/composer-classes";
import {
  msgBody,
  msgBubbleHuman,
  msgBubbleUser,
  msgLabel,
  msgLabelHuman,
  msgMedia,
  msgOwnTurn,
  msgReasoningBody,
  msgReasoningTitle,
  msgRow,
  msgSystemInline,
  msgSystemRow,
  msgSystemText,
  msgSystemTone,
  msgSystemToned,
  msgTime,
} from "../lib/msg-classes";
import { cn } from "../ui/cn";
import { reasoningBody, reasoningDisplay } from "../lib/reasoning-display";
import { transcriptEnterClass } from "../lib/transcript-motion";

// Only this much of a message is markdown-parsed eagerly. marked is
// superlinear on input size (~25ms at 10KB, ~400ms at 80KB, seconds past
// 200KB), and a transcript can hold dozens of giant machine-written entries
// (automation prompts embedding a full PR diff) — parsing them all on open is
// what made "Loading transcript…" hang for minutes on such sessions. Longer
// contents render their head plus a "Show full message" expander.
const EAGER_MD_CHARS = 6000;
// Expanded content still renders as markdown up to this size; past it the
// content is machine payload, not prose — a plain <pre> shows it instantly.
const FULL_MD_CHARS = 32 * 1024;

function sizeLabel(chars: number): string {
  return chars >= 1024 ? `${Math.round(chars / 1024)} KB` : `${chars} chars`;
}

/**
 * Message body that clamps how much markdown is parsed eagerly. Contents the
 * server clamped for the wire (entry.contentClamped) fetch the full entry on
 * expand; locally-long contents just reveal in place.
 */
export function ClampedBody({
  content,
  className,
  entry,
  sessionId,
  transformContent,
}: {
  content: string;
  className: string;
  entry?: TranscriptEntry;
  sessionId?: string;
  /** Display-only repair applied again after a clamped entry hydrates. */
  transformContent?: (content: string) => string;
}) {
  const wireClamped = !!entry?.contentClamped;
  const fullLength = entry?.contentLength ?? content.length;
  const isLong = wireClamped || content.length > EAGER_MD_CHARS;
  const [showAll, setShowAll] = useState(false);
  const [fetched, setFetched] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);

  // Cut the eager head at a line boundary so we don't render half a line of
  // a diff/log as its own paragraph.
  const head = (() => {
    if (!isLong || showAll) return content;
    const slice = content.slice(0, EAGER_MD_CHARS);
    const nl = slice.lastIndexOf("\n");
    return nl > EAGER_MD_CHARS / 2 ? slice.slice(0, nl) : slice;
  })();

  const rawShown = showAll ? (fetched ?? content) : head;
  const shown = transformContent ? transformContent(rawShown) : rawShown;
  // Giant expanded payloads skip markdown entirely — see FULL_MD_CHARS.
  const asMarkdown = shown.length <= FULL_MD_CHARS;
  const repo = useMarkdownRepo();
  const assetPaths = useOpenAssetPaths();
  const html = asMarkdown
    ? renderMarkdown(shown, { repo, sessionId, assetPaths })
    : "";

  const expand = async () => {
    if (wireClamped && !fetched && entry && sessionId) {
      setFetching(true);
      await (async () => {
        const res = await fetch(
          `${BASE_PATH}/api/sessions/${encodeURIComponent(sessionId)}/entry/${encodeURIComponent(entry.id)}`,
        );
        if (res.ok) {
          const data = await res.json();
          if (typeof data?.content === "string") setFetched(data.content);
        }
      })()
        .catch(async () => {
          // keep the wire-clamped text — the tail just stays truncated
        })
        .finally(async () => {
          setFetching(false);
        });
    }
    setShowAll(true);
  };

  return (
    <>
      {asMarkdown ? (
        <MarkdownBody className={className} html={html || ""} />
      ) : (
        // A <pre> only for the preserved whitespace: this branch renders a
        // message too long for the markdown pass, which is prose, not code.
        // `font-sans` is load-bearing — the app ships no Tailwind Preflight,
        // so the UA's `pre { font-family: monospace }` applies otherwise.
        <pre
          className={
            "my-1 max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface p-3 font-sans text-label leading-relaxed text-fg"
          }
        >
          {shown}
        </pre>
      )}
      {isLong && (
        <Button
          variant="ghost"
          size="sm"
          onClick={showAll ? () => setShowAll(false) : expand}
          className="mt-1 min-h-0 justify-start whitespace-normal rounded-md border-0 px-2 py-1 text-left font-sans text-label font-medium leading-normal hover:bg-hover/40"
        >
          {fetching
            ? "Loading…"
            : showAll
              ? "Collapse"
              : `Show full message · ${sizeLabel(fullLength)}`}
        </Button>
      )}
    </>
  );
}

/**
 * The one way a transcript renders something that isn't a message.
 *
 * Every operational line goes through here — a runner notice, a recap, a
 * context compaction, a worker's report, review findings, a heads-up from
 * another session, a restart resume. The server decides which of those an
 * entry is (classifyEntry in the protocol's notices.ts) and hands back a
 * title, a tone, and at most one body and one action; this component is the
 * only place that decides what any of them LOOK like. Adding a tenth kind of
 * notice must not add a tenth rendering.
 */
function NoticeRow({
  entry,
  sessionId,
  onContinue,
}: {
  entry: TranscriptEntry;
  sessionId?: string;
  onContinue?: () => void;
}) {
  const notice = entry.notice!;
  const [open, setOpen] = useState(false);
  const [continued, setContinued] = useState(false);
  const collapsible = notice.body === "collapsed";
  const toned = notice.tone !== "info";
  const isError = notice.tone === "error";

  // An inline body is a catch-up line, not a card: title, colon, prose, all
  // on one left-aligned run so a returning reader takes it in without a tap.
  if (notice.body === "inline") {
    return (
      <div className={msgSystemRow} data-eid={entry.id}>
        <span className={cn(msgSystemInline, "text-left italic")}>
          <span className="font-semibold not-italic">{notice.title}: </span>
          {entry.content}
        </span>
      </div>
    );
  }

  return (
    <div className={msgSystemRow} data-eid={entry.id}>
      <span
        className={cn(
          msgSystemText,
          toned && msgSystemToned,
          isError && msgSystemTone(notice.tone),
          !isError &&
            "data-[tone]:rounded-none data-[tone]:bg-transparent data-[tone]:px-1 data-[tone]:py-0",
          notice.tone === "warn" && "data-[tone=warn]:text-yellow",
        )}
        data-tone={notice.tone}
        role={isError ? "alert" : undefined}
      >
        {toned ? <NoticeGlyph /> : <NoticeIcon icon={notice.icon} />}
        {collapsible ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="cursor-pointer [font-family:inherit] text-inherit"
          >
            {notice.title} ·{" "}
            <span className="font-medium text-dim">
              {open ? "hide" : "show"}
            </span>
          </button>
        ) : (
          <span>{notice.title}</span>
        )}
      </span>
      {collapsible && open && (
        <div className="mx-auto mt-2 w-full max-w-[560px] rounded-lg bg-panel px-4 py-3 text-left">
          <ClampedBody
            className={cn(msgBody, "markdown")}
            content={entry.content}
            entry={entry}
            sessionId={sessionId}
          />
          {notice.link && (
            // The delegated click handler on the transcript navigates on
            // data-session-id, so this opens in place; the href is there
            // for cmd-click and copy-link.
            <a
              className="mt-2.5 block text-xs text-dim no-underline hover:text-fg"
              data-session-id={notice.link.sessionId}
              href={`${BASE_PATH}/session/${notice.link.sessionId}`}
            >
              {notice.link.label}
            </a>
          )}
        </div>
      )}
      {/* A failed run's only next step used to be retyping the prompt. The
			    pill stays the message; this is the one thing to do about it. */}
      {onContinue && (
        <Button
          size="sm"
          disabled={continued}
          onClick={() => {
            setContinued(true);
            onContinue();
          }}
          className="mt-2 self-center"
        >
          {continued ? "Continuing…" : "Continue"}
        </Button>
      )}
    </div>
  );
}

/**
 * What a neutral status line wears in place of the emoji it used to open with:
 * a merged PR, a finished deploy, a completed workflow. The server names the
 * state (`notice.icon`) and this draws it, so the sentence stays plain text.
 *
 * Hand-drawn at the pill's scale rather than taken from `icons.tsx`: that set
 * floors at 20px on purpose, which is nearly twice this 11px line. Same 12px
 * box, 2.2 stroke and inherited colour as NoticeGlyph beside it, so the mark
 * reads as part of the sentence rather than louder than it. Inline rather
 * than a flex child, so a one-line notice stays centered.
 */
function NoticeIcon({ icon }: { icon?: NoticeIconName }) {
  const path = NOTICE_ICON_PATHS[icon ?? ""];
  if (!path) return null;
  return (
    <svg
      className="mr-1.5 inline-block align-[-0.13em]"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {path}
    </svg>
  );
}

const NOTICE_ICON_PATHS: Record<string, React.ReactNode> = {
  merge: (
    <>
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M6 21V9a9 9 0 0 0 9 9" />
    </>
  ),
  deploy: (
    <>
      <circle cx="12" cy="12" r="9.5" />
      <path d="M12 16.5V8" />
      <path d="m8.2 11.8 3.8-3.8 3.8 3.8" />
    </>
  ),
  done: <path d="M20 6 9 17l-5-5" />,
};

/** Triangle-alert glyph for a toned notice; inherits the pill's colour. */
function NoticeGlyph() {
  return (
    // Optical: line-height 1.45 on 11px text leaves the cap ~2px below the
    // box top, so mt-0.5 sets the glyph down on the first line.
    <svg
      className="mt-0.5 flex-none"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

/** Relative time in a message's label row ("5m"), hover for the real one. */
function MsgTime({ ts }: { ts?: string }) {
  if (!ts) return null;
  const label = shortTime(ts);
  if (!label) return null;
  return (
    <Tooltip label={fullTime(ts)}>
      <span className={msgTime}>{label}</span>
    </Tooltip>
  );
}

/** A label already says the teammate's name, so the picture is decorative. */
function TeammateAvatar({ name }: { name: string }) {
  return (
    <span className="inline-flex" aria-hidden="true">
      <UserAvatar name={name} size={16} />
    </span>
  );
}

/** Put a message you already sent back into the composer, so a typo is a fix
 * and a re-send rather than a re-type.
 *
 * It goes out as a NEW message rather than rewriting the old one. The engine
 * keeps the turn it already read, and a session is shared — quietly rewriting
 * a line a teammate read, or that a PR body quotes, is a different promise
 * than editing your own note.
 *
 * Always on the page for touch pointers, where there is no hover to reveal it;
 * on a mouse it comes up with the rest of the row. */
function EditAgainButton({ onClick }: { onClick: () => void }) {
  return (
    <Tooltip label="Edit and send again">
      <button
        type="button"
        onClick={onClick}
        aria-label="Edit and send again"
        className="flex size-7 flex-none cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 text-faint select-none hover:bg-hover hover:text-dim [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:transition-opacity [@media(hover:hover)]:group-hover/bubble:opacity-100 [@media(hover:hover)]:group-focus-within/bubble:opacity-100"
      >
        <IconPencil size={16} />
      </button>
    </Tooltip>
  );
}

/** The quiet row under your own bubble: the edit action, and the real time.
 *
 * Those turns carry no label row to hang a MsgTime off, and a timestamp on
 * every one of them would just be noise while reading — so the time stays
 * hover-capable pointers only, where the assistant's equivalent lives in the ⋯
 * menu instead. The reveal is opacity-only over an absolutely positioned row —
 * nothing here may change a block's height, or the virtual transcript's
 * measured rows would resize and jump the scroll. The ::selection
 * mask is the same WebKit fix as the label's: a drag-select sweeping past
 * unselectable text paints a phantom highlight without it, and a fully
 * transparent background is ignored. */
function BubbleMeta({ ts, onEdit }: { ts?: string; onEdit?: () => void }) {
  const label = ts ? fullTime(ts) : "";
  if (!onEdit && !label) return null;
  return (
    <div className="absolute top-[calc(100%+2px)] right-0 flex items-center gap-1">
      {onEdit && <EditAgainButton onClick={onEdit} />}
      {label && (
        <span className="hidden text-meta leading-none font-medium whitespace-nowrap text-faint select-none selection:bg-[rgba(0,0,0,0.01)] [@media(hover:hover)]:block [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:transition-opacity [@media(hover:hover)]:group-hover/bubble:opacity-100 [@media(hover:hover)]:group-focus-within/bubble:opacity-100">
          {label}
        </span>
      )}
    </div>
  );
}

interface Props {
  entry: TranscriptEntry;
  /** This message was inserted at the live edge in the current build. */
  enter?: boolean;
  /** Provider reasoning summary, including legacy rows inferred by the turn
   * grouper before the durable `isReasoning` field existed. */
  reasoning?: boolean;
  /** Sent to the conversation, but the running engine has not read it yet. */
  pendingDelivery?: boolean;
  /**
   * Who owns/drives this session (session.startedBy). An un-attributed user
   * turn is this person's own words, so it's credited to them — "You" only
   * when the current viewer IS the owner. Omitted (e.g. sub-agent panel) means
   * fall back to "You".
   */
  owner?: string;
  /** Lets a wire-clamped entry's "Show full message" fetch the full content. */
  sessionId?: string;
  /** Offered on your own user turns: puts this message back in the composer.
   *  Omitted where there is no composer to put it in (no engine session). */
  onEdit?: (entry: TranscriptEntry) => void;
  /** Offered on a failed run's notice: starts a turn that picks the work back
   *  up. Passed only for the notice a person can still act on — the last one,
   *  on an idle session (see TranscriptBlocks). */
  onContinue?: () => void;
}

/** Inline images carried on an entry (Read-of-image results, pasted images).
 *  os-blob: markers (transcript-v2 bounded entries) resolve to the
 *  transcript-image route; real srcs pass through untouched.
 *
 *  Exported for the turn fold, which shows a turn's intermediate notes and its
 *  featured media with the same markup a bubble uses. */
export function EntryImages({
  images,
  sessionId,
  right,
}: {
  images?: string[];
  sessionId?: string;
  /** Attachments under a right-aligned bubble hug its edge. */
  right?: boolean;
}) {
  if (!images || images.length === 0) return null;
  return (
    <div className={cn(msgMedia, right && "justify-end")}>
      {images.map((raw, i) => {
        const src = resolveEntryImageSrc(raw, sessionId);
        return (
          <a
            key={i}
            href={src}
            target="_blank"
            rel="noopener noreferrer"
            className="md-image-link"
          >
            <img className="md-image" src={src} alt="" loading="lazy" />
          </a>
        );
      })}
    </div>
  );
}

/** Inline video players for attached/staged videos (streamed via <base>/media).
 *
 * A player fills its own frame with playback controls, so the way out of it has
 * to be drawn: without this button an OPENSESSION_VIDEO marker gives you a
 * video you can watch and nothing you can do with the file. A recording the
 * agent saved to the session's scratch folder opens as that asset — the same
 * surface a chip opens, with the file's name, Download and Copy link — and
 * anything else opens in the media lightbox, which downloads too. */
export function EntryVideos({
  videos,
  right,
}: {
  videos?: string[];
  right?: boolean;
}) {
  const assetPaths = useOpenAssetPaths();
  const asset = useOpenAsset();
  if (!videos || videos.length === 0) return null;
  return (
    <div className={cn(msgMedia, right && "justify-end")}>
      {videos.map((src, i) => {
        const assetPath = assetPathForMediaSrc(src, assetPaths);
        const opensAsset = Boolean(assetPath) && asset.available;
        return (
          <div key={i} className="md-video-wrap">
            <video
              className="md-video"
              src={src}
              controls
              playsInline
              preload="metadata"
            />
            <button
              type="button"
              className="md-video-expand"
              aria-label={opensAsset ? "Open asset" : "Expand"}
              title={opensAsset ? "Open asset" : "Expand"}
              onClick={(e) => {
                if (opensAsset) {
                  asset.open(assetPath!);
                  return;
                }
                const video =
                  e.currentTarget.parentElement?.querySelector("video");
                if (video) openGalleryFrom(video);
              }}
            >
              <IconExpand size={20} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** Non-media attachments on a user turn — download chips (served via <base>/media). */
function EntryFiles({
  files,
  right,
}: {
  files?: TranscriptEntry["files"];
  right?: boolean;
}) {
  if (!files || files.length === 0) return null;
  return (
    <div className={cn(msgMedia, right && "justify-end")}>
      {files.map((f, i) => (
        <a
          key={i}
          className={cn(
            fileChipCard,
            fileChipCardPadding,
            "no-underline hover:border-accent",
          )}
          href={`/media?path=${encodeURIComponent(f.path)}`}
          download={f.name}
          title={f.name}
        >
          <span className={fileChipThumb}>{extBadge(f.name)}</span>
          <span className={fileChipMeta}>
            <span className={fileChipName}>{f.name}</span>
            <span className={fileChipSub}>Attachment</span>
          </span>
        </a>
      ))}
    </div>
  );
}

// Memoized: entries keep stable references across stream events (mergeEntries
// reuses objects) and owner is stable upstream, so a tool event appended to
// the transcript re-renders only the affected blocks — not every bubble's
// markdown/highlighting.
export const MessageBubble = function MessageBubble({
  entry,
  enter = false,
  reasoning = false,
  pendingDelivery = false,
  owner,
  sessionId,
  onEdit,
  onContinue,
}: Props) {
  const me = useCurrentUser();
  // How this entry reads — an operational notice, someone else's words, or an
  // ordinary message — was decided server-side and shipped on the entry
  // (classifyEntry, protocol/notices.ts). Re-running it here is free on an
  // already-classified entry and keeps the UI correct against a server that
  // predates the field, which is what a rolling deploy looks like.
  const e = classifyEntry(entry);
  const displayContent = e.content;
  // Capture the mount decision. A final assistant frame can clear `live` one
  // commit after the message appears; removing the class then would cut its
  // one-shot entrance off mid-fade. Keeping the finished class does not replay
  // the keyframe on ordinary re-renders.
  const [animateArrival] = useState(enter);
  const enterClass = transcriptEnterClass(animateArrival);

  // An answered question is a durable sent receipt. It keeps the question and
  // exact answer visible without making the old choices look actionable.
  if (e.notice?.kind === "ask" && e.notice.ask)
    return <AnsweredAskCard record={e.notice.ask} entryId={e.id} />;

  // Anything else that isn't a message is a notice, whatever produced it.
  if (e.notice)
    return (
      <NoticeRow
        entry={e}
        sessionId={sessionId}
        // Only a failure is something to continue from. Every other
        // notice reports a state, not a stall.
        onContinue={e.notice.tone === "error" ? onContinue : undefined}
      />
    );

  // A teammate's answer routed back into the session (human-in-the-loop):
  // their words, so their own bubble — the "who" lives in the label.
  if (e.type === "user" && e.sender && e.senderVia) {
    return (
      <div
        className={cn(
          msgRow,
          msgOwnTurn,
          enterClass,
          pendingDelivery && "opacity-70",
        )}
        data-delivery-pending={pendingDelivery || undefined}
        data-eid={e.id}
      >
        <div className={cn(msgLabel, msgLabelHuman)}>
          <TeammateAvatar name={e.sender} />
          {e.sender} · via Slack
          <MsgTime ts={e.timestamp} />
        </div>
        <ClampedBody
          className={cn(msgBubbleHuman, "markdown")}
          content={displayContent}
          entry={e}
          sessionId={sessionId}
        />
        <EntryImages images={e.images} sessionId={sessionId} right />
        <EntryVideos videos={e.videos} right />
        <EntryFiles files={e.files} right />
      </div>
    );
  }

  if (e.type === "user") {
    // Who sent this turn: a teammate who steered or sent into the session
    // (e.sender) wins; otherwise it's the session owner's own words. Either
    // way, credit the sender — "You" only when the sender is the current
    // viewer. Falls back to "You" when the owner is unknown.
    const sender = e.sender ?? owner;
    const fromOther =
      sender && personKey(sender) !== personKey(me) ? sender : null;
    // Nothing to show: an entry that strips down to just its "[Name] "
    // delivery attribution is plumbing whose body was fenced context (the
    // auto-continue nudge). Render nothing rather than a label + identity dot
    // hovering above the next message. New turns no longer take an
    // attribution at all (see isContextOnly); this also hides the ones
    // already persisted.
    if (
      !displayContent &&
      !e.images?.length &&
      !e.videos?.length &&
      !e.files?.length
    ) {
      return null;
    }
    // Your own settled messages skip the label entirely — the right-aligned
    // bubble already says "you". Turns sent by someone else keep the
    // attribution label.
    return (
      <div
        className={cn(
          msgRow,
          "msg-user",
          msgOwnTurn,
          enterClass,
          // Your own turns hang their quiet actions below the bubble. Reserve
          // that clearance from the optimistic mount: when Edit appears on the
          // durable row, the phone timeline must not grow underneath it.
          !fromOther && "mb-8.75",
          pendingDelivery && "opacity-70",
        )}
        data-delivery-pending={pendingDelivery || undefined}
        data-eid={e.id}
      >
        {fromOther && (
          <div className={msgLabel}>
            <TeammateAvatar name={fromOther} />
            {fromOther}
            <MsgTime ts={e.timestamp} />
          </div>
        )}
        {/* One stack anchors the quiet actions below both the bubble and attachments. */}
        <div className="group/bubble relative flex min-w-0 flex-col">
          {!fromOther && (
            <BubbleMeta
              ts={e.timestamp}
              onEdit={onEdit ? () => onEdit(e) : undefined}
            />
          )}
          {displayContent && (
            <ClampedBody
              className={cn(msgBubbleUser, "markdown")}
              content={displayContent}
              entry={e}
              sessionId={sessionId}
            />
          )}
          <EntryImages images={e.images} sessionId={sessionId} right />
          <EntryVideos videos={e.videos} right />
          <EntryFiles files={e.files} right />
        </div>
      </div>
    );
  }

  if (reasoning || e.isReasoning) {
    const { title, body } = reasoningDisplay(displayContent);
    return (
      <div
        className={cn(msgRow, "mb-2", enterClass)}
        data-eid={e.id}
        data-reasoning=""
      >
        {title && <div className={msgReasoningTitle}>{title}</div>}
        {body && (
          <ClampedBody
            className={cn(msgReasoningBody, "markdown")}
            content={body}
            entry={e}
            sessionId={sessionId}
            transformContent={reasoningBody}
          />
        )}
      </div>
    );
  }

  // assistant — no speaker label: every left-aligned bubble is the agent, so
  // the name row was pure noise above each answer.
  return (
    <div className={cn(msgRow, enterClass)} data-eid={e.id}>
      <ClampedBody
        className={cn(msgBody, "markdown text-fg")}
        content={displayContent}
        entry={e}
        sessionId={sessionId}
      />
      <EntryImages images={e.images} sessionId={sessionId} />
      <EntryVideos videos={e.videos} />
    </div>
  );
};
