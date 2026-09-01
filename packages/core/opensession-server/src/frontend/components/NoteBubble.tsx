import { mergeStylexProps, mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import React, { useEffect, useRef, useState } from "react";
import type { SessionNote } from "../lib/types";
import { cn } from "../ui/cn";
import { Menu } from "../ui/menu";
import { toast } from "../ui/toast";
import { deleteSessionNoteApi, editSessionNoteApi } from "../lib/api";
import { IconDotsHorizontal, IconPencil, IconTrash } from "./icons";
import { MentionText } from "./MentionText";
import { UserAvatar } from "./UserAvatar";
import { getCurrentUser } from "./UserPicker";
import { openLightbox } from "../lib/media-lightbox";
import { noAutofill } from "../lib/composer-autofill";
import { noteSurface } from "../lib/tinted-surface";
import { errorMessage } from "../lib/error-message";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  relative: {
    position: "relative",
  },
  mxAuto: {
    marginInline: "auto",
  },
  mb6: {
    marginBottom: "calc(4px * 6)",
  },
  mt2: {
    marginTop: "calc(4px * 2)",
  },
  wFull: {
    width: "100%",
  },
  maxWVarSessionCol: {
    maxWidth: "var(--session-col)",
  },
  rounded2xl: {
    borderRadius: "calc(22px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  px4: {
    paddingInline: "calc(4px * 4)",
  },
  py35: {
    paddingBlock: "calc(4px * 3.5)",
  },
  mb1: {
    marginBottom: "4px",
  },
  flex: {
    display: "flex",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  textFg: {
    color: "var(--text)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  textRed: {
    color: "var(--red)",
  },
  flexCol: {
    flexDirection: "column",
  },
  resizeNone: {
    resize: "none",
  },
  roundedLg: {
    borderRadius: "calc(14px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  border: {
    borderStyle: "solid",
    borderWidth: "1px",
  },
  borderColorColorMixInSrgbVarYellowTint45Transparent: {
    borderColor: "color-mix(in srgb,var(--yellow-tint) 45%,transparent)",
  },
  bgSurface: {
    backgroundColor: "var(--bg)",
  },
  px25: {
    paddingInline: "calc(4px * 2.5)",
  },
  py2: {
    paddingBlock: "calc(4px * 2)",
  },
  leadingRelaxed: {
    lineHeight: "var(--leading-relaxed)",
  },
  outlineNone: {
    outlineStyle: "none",
  },
  focusVisibleBorderColorVarYellow: {
    ":focus-visible": {
      borderColor: "var(--yellow)",
    },
  },
  roundedControl: {
    borderRadius: "calc(12px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  bgAccent: {
    backgroundColor: "var(--accent)",
  },
  py1: {
    paddingBlock: "4px",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  textOnAccent: {
    color: "var(--on-accent)",
  },
  disabledCursorDefault: {
    ":disabled": {
      cursor: "default",
    },
  },
  disabledOpacity50: {
    ":disabled": {
      opacity: "50%",
    },
  },
  textDim: {
    color: "var(--text-dim)",
  },
  hoverBgHover: {
    "@media (hover: hover)": {
      ":hover": {
        backgroundColor: "var(--hover)",
      },
    },
  },
  hoverTextFg: {
    "@media (hover: hover)": {
      ":hover": {
        color: "var(--text)",
      },
    },
  },
  whitespacePreWrap: {
    whiteSpace: "pre-wrap",
  },
  flexWrap: {
    flexWrap: "wrap",
  },
  block: {
    display: "block",
  },
  cursorZoomIn: {
    cursor: "zoom-in",
  },
  leading0: {
    lineHeight: "0",
  },
  maxH60: {
    maxHeight: "calc(4px * 60)",
  },
  maxWFull: {
    maxWidth: "100%",
  },
  borderLineStrong: {
    borderColor: "var(--border-strong)",
  },
  objectContain: {
    objectFit: "contain",
  },
});

/**
 * A team note interleaved into the session transcript — a human-to-human
 * message the agent never sees (Plain's "internal note" concept, for our own
 * sessions). Backed by src/server/session-notes.ts; rendered with a
 * deliberate yellow tint so it can't be mistaken for a prompt or an answer.
 *
 * A note is one person speaking, so only its author can edit or delete it —
 * the menu is hidden for everyone else, and the server enforces the same rule
 * rather than trusting that (403 for anyone who asks anyway).
 */

function noteTime(ts: number): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

export function NoteBubble({
  note,
  sessionId,
}: {
  note: SessionNote;
  /** Absent in read-only hosts (the sub-agent pane); no session, no menu. */
  sessionId?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.text);
  const [busy, setBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mine =
    note.user.trim().toLowerCase() === getCurrentUser().trim().toLowerCase();

  useEffect(() => {
    if (!editing) return;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    el.style.height = "";
    el.style.height = `${el.scrollHeight}px`;
  }, [editing]);

  async function save() {
    const text = draft.trim();
    if (!sessionId || !text || busy) return;
    if (text === note.text) {
      setEditing(false);
      return;
    }
    setBusy(true);
    await (async () => {
      // The broadcast puts the stored note back into the transcript, so
      // there's nothing to write locally.
      await editSessionNoteApi(sessionId, note.id, text, getCurrentUser());
      setEditing(false);
    })()
      .catch(async (error) => {
        toast(errorMessage(error, "Failed to edit note"));
      })
      .finally(async () => {
        setBusy(false);
      });
  }

  async function remove() {
    if (!sessionId || busy) return;
    setBusy(true);
    await (async () => {
      await deleteSessionNoteApi(sessionId, note.id, getCurrentUser());
    })()
      .catch(async (error) => {
        toast(errorMessage(error, "Failed to delete note"));
      })
      .finally(async () => {
        setBusy(false);
      });
  }

  return (
    <div
      // A note is a transcript block like any other, so it takes the same
      // centered reading column the turns, footers and walkthrough cards use
      // (mx-auto + --session-col) instead of spanning the whole pane, and the
      // same mt-2/mb-6 rhythm as the column's other card blocks (AskCard,
      // WalkthroughCard) so it doesn't crowd whatever follows it.
      //
      // `group` so the actions can stay quiet until the note is hovered.
      {...mergeStylexProps(
        "group",
        sx.relative,
        sx.mxAuto,
        sx.mb6,
        sx.mt2,
        sx.wFull,
        sx.maxWVarSessionCol,
        sx.rounded2xl,
        sx.px4,
        sx.py35,
      )}
      style={{ background: noteSurface("transparent") }}
    >
      <div {...stylex.props(sx.mb1, sx.flex, sx.itemsCenter, sx.gap2)}>
        <UserAvatar name={note.user} size={18} />
        <span
          {...stylex.props(sx.fontSemibold, sx.textFg, typography.supporting)}
        >
          {note.user}
        </span>
        <span
          {...stylex.props(sx.fontSemibold, typography.meta)}
          style={{ color: "var(--yellow)" }}
          title="Only the team sees this note"
        >
          Note
        </span>
        <span {...stylex.props(sx.textFaint, typography.meta)}>
          {noteTime(note.ts)}
          {note.editedAt ? " · edited" : ""}
        </span>
        {mine && sessionId && !editing && (
          <Menu.Root>
            <Menu.Trigger
              aria-label="Note actions"
              // Quiet until you want it: visible on hover, on keyboard
              // focus, and while its own menu is open — never hover-only,
              // which would strand touch and keyboard.
              className={cn(
                utilityClassName(
                  "ml-auto flex size-7 shrink-0 items-center justify-center rounded-control border-0 bg-transparent text-dim opacity-0 transition-opacity",
                ),
                utilityClassName(
                  "hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover:opacity-100",
                ),
                "data-[popup-open]:bg-hover data-[popup-open]:text-fg data-[popup-open]:opacity-100",
              )}
            >
              <IconDotsHorizontal size={16} />
            </Menu.Trigger>
            <Menu.Popup align="end">
              <Menu.Item
                onClick={() => {
                  setDraft(note.text);
                  setEditing(true);
                }}
              >
                <IconPencil
                  size={18}
                  className={mergeStylexOverrideClassName("", sx.textFaint)}
                />
                Edit
              </Menu.Item>
              <Menu.Separator />
              <Menu.Item
                onClick={remove}
                className={mergeStylexOverrideClassName("", sx.textRed)}
              >
                <IconTrash size={18} />
                Delete
              </Menu.Item>
            </Menu.Popup>
          </Menu.Root>
        )}
      </div>
      {editing ? (
        <div {...stylex.props(sx.flex, sx.flexCol, sx.gap2)}>
          <textarea
            ref={textareaRef}
            value={draft}
            disabled={busy}
            {...noAutofill}
            onChange={(e) => {
              setDraft(e.target.value);
              e.target.style.height = "";
              e.target.style.height = `${e.target.scrollHeight}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setEditing(false);
                setDraft(note.text);
              }
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void save();
              }
            }}
            {...stylex.props(
              sx.wFull,
              sx.resizeNone,
              sx.roundedLg,
              sx.border,
              sx.borderColorColorMixInSrgbVarYellowTint45Transparent,
              sx.bgSurface,
              sx.px25,
              sx.py2,
              sx.leadingRelaxed,
              sx.textFg,
              sx.outlineNone,
              sx.focusVisibleBorderColorVarYellow,
              typography.body,
            )}
          />
          <div {...stylex.props(sx.flex, sx.itemsCenter, sx.gap2)}>
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy || !draft.trim()}
              {...mergeStylexProps(
                "enabled:hover:bg-accent-hover",
                sx.roundedControl,
                sx.bgAccent,
                sx.px25,
                sx.py1,
                sx.fontMedium,
                sx.textOnAccent,
                sx.disabledCursorDefault,
                sx.disabledOpacity50,
                typography.label,
              )}
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setDraft(note.text);
              }}
              disabled={busy}
              {...stylex.props(
                sx.roundedControl,
                sx.px25,
                sx.py1,
                sx.fontMedium,
                sx.textDim,
                sx.hoverBgHover,
                sx.hoverTextFg,
                typography.label,
              )}
            >
              Cancel
            </button>
            <span {...stylex.props(sx.textFaint, typography.meta)}>
              ⌘↵ to save · Esc to cancel
            </span>
          </div>
        </div>
      ) : (
        <>
          {note.text && (
            <div
              {...stylex.props(
                sx.whitespacePreWrap,
                sx.leadingRelaxed,
                sx.textFg,
                typography.body,
              )}
            >
              <MentionText text={note.text} />
            </div>
          )}
          {!!note.images?.length && (
            <div {...stylex.props(sx.mt2, sx.flex, sx.flexWrap, sx.gap2)}>
              {note.images.map((src, index) => (
                <button
                  key={src}
                  type="button"
                  {...mergeStylexProps(
                    "focus-ring",
                    sx.block,
                    sx.cursorZoomIn,
                    sx.roundedLg,
                    sx.leading0,
                  )}
                  onClick={(event) =>
                    openLightbox(
                      note.images!.map((image) => ({
                        kind: "image",
                        src: image,
                      })),
                      index,
                      event.currentTarget,
                    )
                  }
                  aria-label="Open note image"
                >
                  <img
                    src={src}
                    alt=""
                    loading="lazy"
                    {...stylex.props(
                      sx.maxH60,
                      sx.maxWFull,
                      sx.roundedLg,
                      sx.border,
                      sx.borderLineStrong,
                      sx.objectContain,
                    )}
                  />
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
