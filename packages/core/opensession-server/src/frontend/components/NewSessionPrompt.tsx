import React, {
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  fetchFileMentions,
  fetchMentionSuggestions,
  fetchSkillMentions,
} from "../lib/api";
import { saveDraft, NEW_SESSION_DRAFT_KEY as DRAFT_KEY } from "../lib/drafts";
import { appendDictation } from "../lib/dictation";
import { attachingLabel } from "../lib/attachments";
import { imageFilesFromPaste } from "../lib/images";
import {
  pastedTextFile,
  shouldAttachPastedTextAsFile,
  shouldCollapsePastedText,
} from "../lib/pasted-text";
import { fileChipRow } from "../lib/composer-classes";
import { insertPastedSessionId } from "../lib/session-url";
import { insideOpenFence, isSendCombo } from "../lib/send-key";
import {
  COMPOSER_HIGHLIGHT_MAX_CHARS,
  composerHighlightHtml,
  composerImageAttachmentRanges,
  paintPillHover,
} from "../lib/composer-highlight";
import {
  appendImageAttachmentComment,
  deleteImageAttachmentComment,
  parseImageAttachmentComments,
  rebaseImageAttachmentReferences,
  updateImageAttachmentComment,
} from "../lib/image-attachment-comment";
import type { ImageRegion } from "../lib/image-region-comment";
import { noAutofill } from "../lib/composer-autofill";
import { useSessionNameProjection } from "../hooks/useSessionNameProjection";
import { useFileMentions } from "./useFileMentions";
import { ImageThumbs } from "./ImageThumbs";
import type { ImageRegionAnnotation } from "../lib/media-lightbox";
import { FileChips } from "./FileChips";
import { PastedTextContext } from "./PastedTextContext";
import { AnimatePresence } from "motion/react";
import { cn } from "../ui/cn";
import { getCurrentUser } from "./UserPicker";
import type {
  NewSessionPromptActions,
  NewSessionPromptConfig,
  NewSessionPromptRefs,
} from "../lib/new-session-prompt-types";
import { promptScrollEdges } from "../lib/prompt-scroll";

/** One scroll surface for the prompt and its attachments. Keeping the image in
 *  this flow means it travels with the text instead of pinning over it.
 *
 *  `pt-1` rather than `pt-3`: the header already carries 11px below its row, so
 *  a 12px reserve here put 28px between the repo picker and the placeholder
 *  while the prompt sat flush against the footer. Now that the hairline only
 *  appears once the prompt scrolls, the header and the prompt read as one
 *  block, and that gap read as a hole in it. */
const BODY =
  "relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-4 pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";
const TEXTAREA =
  "block min-h-[132px] w-full resize-none overflow-hidden border-none bg-transparent font-sans text-body leading-[1.55] text-fg outline-none placeholder:text-faint disabled:opacity-60";

/** How long the draft has to hold still before the palette is handed it. This
 *  is the branch-name suggestion's debounce, moved down here: the palette is
 *  told once, when typing stops, rather than on every character. */
const SETTLE_MS = 700;

/** How long the draft has to hold still before it is written to the store.
 *  Short enough that it is never the reason a draft is lost — every way out of
 *  the palette flushes it first — and long enough that a burst of typing costs
 *  one write instead of one per character. */
const DRAFT_MS = 300;

/**
 * The new-session palette's prompt: the field, its session-reference mirror,
 * the "@" and "/" pickers, and the attachments that scroll with it.
 *
 * It owns the draft rather than taking it as a prop, and that is the whole
 * point of the split. The palette around it is a repo picker, a model picker,
 * two menus and a split button — some 20ms of render — and every one of those
 * re-rendered on every character while the text lived at the top of the card.
 * What the palette actually needs is far less than the text: whether there is
 * any (`onHasTextChange`, for the Create button), the text once typing stops
 * (`onDraftSettled`, for the branch name), and the text itself at the moment a
 * create is submitted, which it reads from `valueRef`.
 */
export function NewSessionPrompt({
  config,
  refs,
  actions,
}: {
  config: NewSessionPromptConfig;
  refs: NewSessionPromptRefs;
  actions: NewSessionPromptActions;
}) {
  const {
    initialText,
    repo,
    mcpServers,
    placeholder,
    disabled,
    images,
    files,
    pastedTexts,
    staging,
    sendKey,
    canCreate,
  } = config;
  const { textarea: textareaRef, value: valueRef, handle } = refs;
  const {
    removeImage: onRemoveImage,
    removeFile: onRemoveFile,
    removePendingImage: onRemovePendingImage,
    removePendingFile: onRemovePendingFile,
    addAttachments: onAddAttachments,
    addPastedText: onAddPastedText,
    removePastedText: onRemovePastedText,
    create: onCreate,
    changeHasText: onHasTextChange,
    settleDraft: onDraftSettled,
    changeEdges: onEdgesChange,
    changeMentionOpen: onMentionOpenChange,
  } = actions;
  const [text, setText] = useState(initialText);
  // The palette re-renders far less often than this field does now, so Effect
  // Events read the latest callbacks without making the reporting effects
  // reactive to them. A repo switch mid-sentence must not restart the settle
  // timer, and a parent callback change must not rebuild the body observer.
  const reportHasText = useEffectEvent(onHasTextChange);
  const reportSettledDraft = useEffectEvent(onDraftSettled);
  const reportEdges = useEffectEvent(onEdgesChange);
  const reportMentionOpen = useEffectEvent(onMentionOpenChange);

  // The draft store, so a dismissed palette can restore the work. Written on a
  // debounce rather than per character, and flushed by every way out of the
  // palette, so what the store misses is only ever the last few hundred
  // milliseconds of a burst that is still being typed.
  //
  // A pending write always reads from this ref, never from a captured value:
  // a flush that landed a keystroke behind would be worse than no flush.
  //
  // The text is all this writes. Attachments are staged asynchronously and
  // commit to the store themselves (lib/attachments.ts), because that upload
  // outlives the palette; a second writer here would put the pre-upload array
  // back over a completion that landed between the last render and the flush.
  const draft = useRef({ text });
  // Publish one coherent committed snapshot for every event path that reads
  // outside this field. Speculative concurrent renders never leak into refs.
  useLayoutEffect(() => {
    valueRef.current = text;
    draft.current = { text };
  });
  // Non-null exactly while the store is behind the field, which is what makes
  // "nothing pending" a safe reason for a flush to do nothing.
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (draftTimer.current != null) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      draftTimer.current = null;
      saveDraft(DRAFT_KEY, draft.current);
    }, DRAFT_MS);
  }, [text]);

  // Every exit that is not a create: the palette being dismissed or navigated
  // away from (the cleanup), the tab being closed, reloaded or backgrounded.
  //
  // `visibilitychange` is the one that carries a tab close, not `pagehide`:
  // lib/drafts mirrors its own map to sessionStorage on pagehide, and that
  // listener is registered at import time, so it runs before this one and
  // would mirror a draft this write had not reached yet. Browsers turn the
  // page hidden before they fire pagehide, so writing there puts the text in
  // the map in time. pagehide stays as the backstop for the memory copy.
  useEffect(() => {
    const writeDraftNow = () => {
      if (draftTimer.current == null) return;
      clearTimeout(draftTimer.current);
      draftTimer.current = null;
      saveDraft(DRAFT_KEY, draft.current);
    };
    const onHidden = () => {
      if (document.visibilityState === "hidden") writeDraftNow();
    };
    window.addEventListener("pagehide", writeDraftNow);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("pagehide", writeDraftNow);
      document.removeEventListener("visibilitychange", onHidden);
      writeDraftNow();
    };
  }, []);

  useImperativeHandle(
    handle,
    () => ({
      setText: (next: string) => setText(next),
      appendText: (add: string) =>
        setText((prev) => appendDictation(prev, add)),
      dropPendingDraftWrite: () => {
        if (draftTimer.current == null) return;
        clearTimeout(draftTimer.current);
        draftTimer.current = null;
      },
    }),
    [],
  );

  // A pasted session link is stored as its id and shown as that session's
  // name, exactly as in the session composer. The palette is where most links
  // are dropped, and a first prompt that reads as forty characters of uuid says
  // nothing about what it points at.
  const sessionNames = useSessionNameProjection({
    text,
    setText,
    textareaRef,
  });
  // Session and image references paint here. The palette has no `inline code`
  // tint and no mention pills; these references are the only parts of the field
  // that carry meaning beyond their literal text, so they are the parts that
  // need to read as tokens.
  const hlRef = useRef<HTMLDivElement>(null);
  const hoveredPill = useRef<HTMLElement | null>(null);
  // Same cap the session composer's mirror takes: this one is rebuilt and
  // re-parsed on every keystroke too, so past that length the pill costs more
  // than it is worth and the plain field takes over.
  const promptHighlight =
    (sessionNames.sessions.length > 0 ||
      composerImageAttachmentRanges(sessionNames.displayText).length > 0) &&
    sessionNames.displayText.length <= COMPOSER_HIGHLIGHT_MAX_CHARS;
  const promptHighlightHtml = promptHighlight
    ? composerHighlightHtml(sessionNames.displayText, [], sessionNames.sessions)
    : "";
  // Every keystroke rewrites the mirror's innerHTML, so the hovered span is a
  // dangling node from the render before it.
  useEffect(() => {
    hoveredPill.current = null;
    if (textareaRef.current) textareaRef.current.style.cursor = "";
  }, [promptHighlightHtml, textareaRef]);
  const mentions = useFileMentions({
    value: sessionNames.displayText,
    onChange: sessionNames.setDisplayText,
    textareaRef,
    mentionFetch: (q) => fetchFileMentions(q, undefined, repo),
    paletteFetch: (q) =>
      fetchMentionSuggestions(q, undefined, getCurrentUser(), mcpServers),
    skillsFetch: (q) => fetchSkillMentions(q, undefined, repo),
  });

  // Emptiness rather than the text: the Create button is the only part of the
  // palette that has to answer on the keystroke that changes it, and it only
  // ever asks whether there is anything to create.
  const hasText = /\S/.test(text);
  useLayoutEffect(() => {
    reportHasText(hasText);
  }, [hasText]);

  useEffect(() => {
    const timer = setTimeout(() => reportSettledDraft(text), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  useEffect(() => {
    reportMentionOpen(mentions.open);
  }, [mentions.open]);

  const imageComments = parseImageAttachmentComments(text);
  const commitText = (next: string) => {
    draft.current = { text: next };
    setText(next);
  };
  const commentOnImage = (
    imageIndex: number,
    region: ImageRegion,
    comment: string,
    _keepOpen: boolean,
    existing?: ImageRegionAnnotation,
  ) => {
    const current = draft.current.text;
    commitText(
      existing
        ? updateImageAttachmentComment(
            current,
            { ...existing, imageIndex },
            region,
            comment,
          )
        : appendImageAttachmentComment(current, imageIndex, region, comment),
    );
  };
  const deleteCommentOnImage = (
    imageIndex: number,
    annotation: ImageRegionAnnotation,
  ) =>
    commitText(
      deleteImageAttachmentComment(draft.current.text, {
        ...annotation,
        imageIndex,
      }),
    );
  const removeImage = (imageIndex: number) => {
    commitText(rebaseImageAttachmentReferences(draft.current.text, imageIndex));
    onRemoveImage(imageIndex);
  };

  // The prompt grows naturally; once the palette reaches its viewport cap the
  // BODY becomes the single scroller, carrying attachments with the text. Each
  // edge's hairline marks content continuing beyond the visible area.

  // Both effects below key on the scroller NODE rather than on a render pass.
  // Base UI mounts the popup's children in a later commit than the one that
  // opens the dialog, so an effect keyed on the text (or on `open`) has already
  // run and bailed on a null ref by the time the textarea exists. That left a
  // prefilled or restored prompt clipped at its 132px minimum and unscrollable.
  const [promptBody, setPromptBody] = useState<HTMLDivElement | null>(null);
  const attachPromptBody = (node: HTMLDivElement | null) => {
    mentions.setInputWrap(node);
    setPromptBody(node);
  };

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || !promptBody) return;
    textarea.style.height = "0px";
    textarea.style.height = `${textarea.scrollHeight}px`;
    reportEdges(promptScrollEdges(promptBody));
  }, [
    promptBody,
    sessionNames.displayText,
    images.length,
    files.length,
    pastedTexts.length,
    textareaRef,
  ]);

  useEffect(() => {
    if (!promptBody) return;
    const observer = new ResizeObserver(() =>
      reportEdges(promptScrollEdges(promptBody)),
    );
    observer.observe(promptBody);
    return () => observer.disconnect();
  }, [promptBody]);

  function handlePaste(e: React.ClipboardEvent) {
    // A session link goes in as the id it carries, which is the same reference
    // in a third of the room and chips the same way (lib/session-url.ts).
    if (insertPastedSessionId(e)) return;
    // A long paste becomes a chip, the same as in a session's composer, and
    // travels beside the prompt rather than inside it.
    const pastedText = e.clipboardData?.getData("text/plain") ?? "";
    // Past the file threshold the paste is staged like a dropped file, so the
    // agent reads it with its tools instead of the prompt carrying it whole.
    if (shouldAttachPastedTextAsFile(pastedText)) {
      e.preventDefault();
      onAddAttachments([pastedTextFile(pastedText)]);
      return;
    }
    if (shouldCollapsePastedText(pastedText)) {
      e.preventDefault();
      onAddPastedText(pastedText);
      return;
    }
    const imgs = imageFilesFromPaste(e);
    if (imgs.length) {
      e.preventDefault();
      onAddAttachments(imgs);
    }
  }

  return (
    <div
      className={BODY}
      onDrop={(e) => {
        if (e.dataTransfer?.files?.length) {
          e.preventDefault();
          onAddAttachments(e.dataTransfer.files);
        }
      }}
      onDragOver={(e) => e.preventDefault()}
      onScroll={(e) => onEdgesChange(promptScrollEdges(e.currentTarget))}
      ref={attachPromptBody}
    >
      {mentions.popup}
      <div className="relative">
        {promptHighlight && (
          // `composer-hl` stays as a hook: the pill spans inside this
          // mirror are written as innerHTML by lib/composer-highlight.ts,
          // so their rules can only be reached through it. Same trick as
          // the session composer: a metrics-identical layer paints the
          // pill behind a transparent-text field, which keeps the native
          // caret, selection and undo.
          <div
            ref={hlRef}
            className={cn(
              "composer-hl",
              TEXTAREA,
              "pointer-events-none absolute inset-0 z-0 h-full select-none overflow-hidden break-words whitespace-pre-wrap",
              // Padding here is two things added together, and both are
              // load-bearing. 4px of it is clearance: a pill's wash reaches
              // past its own box (base.css), so one at either end of a line
              // would be clipped by this box, and the negative margin plus
              // the width give that room back outside the content. The
              // other 2px is the browser's own textarea padding, which this
              // field keeps, unlike the session composer, which zeroes it.
              // Without it every glyph here sits two pixels left of the one
              // it paints over, which puts the wash off the word.
              "-mx-[4px] w-[calc(100%+8px)] px-[6px] py-[2px]",
            )}
            aria-hidden="true"
            dangerouslySetInnerHTML={{ __html: promptHighlightHtml }}
          />
        )}
        <textarea
          ref={textareaRef}
          {...mentions.inputProps}
          className={cn(
            TEXTAREA,
            promptHighlight &&
              "relative z-[1] break-words text-transparent caret-[var(--text)]",
          )}
          value={sessionNames.displayText}
          onBeforeInput={sessionNames.handleBeforeInput}
          onChange={(e) => {
            // A token undo/redo is replayed against canonical state and the
            // caret is already placed, so nothing else is owed here.
            // The picker re-syncs from the committed value in its own effect,
            // which is both later and more reliable than a microtask queued
            // from here (see useFileMentions).
            sessionNames.handleChange(e);
          }}
          onCopy={sessionNames.handleCopy}
          onCut={sessionNames.handleCut}
          onMouseMove={(e) =>
            paintPillHover(
              hlRef.current,
              textareaRef.current,
              e.clientX,
              e.clientY,
              hoveredPill,
            )
          }
          onMouseLeave={() =>
            paintPillHover(
              hlRef.current,
              textareaRef.current,
              -1,
              -1,
              hoveredPill,
            )
          }
          onKeyDown={(e) => {
            // An undo that has to cross a session token replays canonical
            // state; every other ⌘Z is left to the field's own history.
            if (sessionNames.handleUndoRedoKey(e)) return;
            // ⌘/Ctrl+Enter creates whatever the send-key preference is.
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              onCreate();
              return;
            }
            // The @/slash popup claims plain Enter to accept a suggestion.
            if (mentions.handleKeyDown(e)) return;
            // A reference reads as one object, so it erases like one.
            if (
              (e.key === "Backspace" || e.key === "Delete") &&
              !e.metaKey &&
              !e.ctrlKey &&
              !e.altKey &&
              textareaRef.current &&
              sessionNames.deleteTokenAtEdge(e.key, textareaRef.current)
            ) {
              e.preventDefault();
              return;
            }
            // Otherwise the send key creates, exactly as it sends in the session
            // composer — including the unclosed-``` fence exception, so a
            // multi-line code block can still be typed into the first prompt.
            // Nothing to create yet? Let the newline land rather than eating
            // the keystroke.
            if (!isSendCombo(e, sendKey) || !canCreate) return;
            // The caret is an offset into the DISPLAYED text, and a fence is
            // a fact about the draft, so the two have to be read in the same
            // terms.
            const caret = sessionNames.canonicalOffset(
              textareaRef.current?.selectionStart ??
                sessionNames.displayText.length,
            );
            if (insideOpenFence(text, caret)) return;
            e.preventDefault();
            onCreate();
          }}
          onKeyUp={mentions.sync}
          onClick={(e) => {
            // Pressing a session reference removes it, the way the pill says it will.
            if (sessionNames.removeTokenAtCaret(e.currentTarget)) return;
            mentions.sync();
          }}
          onBlur={() => setTimeout(mentions.close, 120)}
          onPaste={handlePaste}
          placeholder={placeholder}
          disabled={disabled}
          {...noAutofill}
        />
      </div>
      <ImageThumbs
        images={images}
        pending={staging.images}
        onRemove={removeImage}
        comments={imageComments}
        onComment={commentOnImage}
        onDeleteComment={deleteCommentOnImage}
        onRemovePending={onRemovePendingImage}
        disabled={disabled}
      />
      <FileChips
        files={files}
        pending={staging.files}
        onRemove={onRemoveFile}
        onRemovePending={onRemovePendingFile}
        disabled={disabled}
      />
      {pastedTexts.length > 0 && (
        <div className={fileChipRow}>
          <AnimatePresence initial={false}>
            {pastedTexts.map((attachment) => (
              <PastedTextContext
                key={attachment.id}
                attachment={attachment}
                onRemove={() => {
                  onRemovePastedText(attachment.id);
                  textareaRef.current?.focus({ preventScroll: true });
                }}
                disabled={disabled}
              />
            ))}
          </AnimatePresence>
        </div>
      )}
      {/* The ghost tiles are the whole message on screen, and they say
			    nothing out loud. This is the same news for a reader who cannot
			    see them. */}
      {attachingLabel(staging) && (
        <span className="sr-only" role="status">
          {attachingLabel(staging)}
        </span>
      )}
    </div>
  );
}
