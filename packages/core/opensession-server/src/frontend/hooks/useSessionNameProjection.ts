/**
 * Named session references in a composer draft.
 *
 * A session id is forty characters of noise, so a field shows the referenced
 * session's TITLE while the draft that is saved and sent keeps the id. That
 * split is the whole of this hook: `text` (canonical, ids) belongs to the
 * caller, `displayText` (titles) is what the textarea renders, and every edit
 * the browser makes to the visible text is mapped back onto the canonical one.
 *
 * A named token behaves as one object: click, Backspace, Delete and cut take
 * the whole reference. A title is prose, and picking it apart a letter at a
 * time would leave half a name standing where a reference belongs.
 * The id rides the clipboard, so a copied reference still pastes as a
 * reference anywhere else.
 *
 * Undo needs its own bookkeeping: the browser's history holds the DISPLAY
 * text, so an entry that crosses a token has to be replayed against canonical
 * state instead. Ordinary edits keep the native stack; a token edit only
 * claims ⌘Z while the field still holds exactly what that edit left behind.
 *
 * Two surfaces share this, the session composer and the new-session palette,
 * so both agree on what a pasted link becomes: in the field, and in the
 * message that leaves it.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  applyComposerSessionEdit,
  composerCanonicalOffset,
  composerCanonicalSelection,
  composerDisplayOffset,
  projectComposerSessions,
  type ComposerDisplayEdit,
  type ComposerSessionProjection,
  type DisplaySessionRange,
} from "../lib/composer-session-projection";
import { onSessionTitlesChanged } from "../lib/markdown";

/** How a value reached the field, which decides what undo owes it. */
type InputKind = "native" | "programmatic" | "history";

interface SetDisplayTextOptions {
  /** The range the browser actually replaced, when the event reported one. */
  editHint?: ComposerDisplayEdit;
  inputKind?: InputKind;
  /** Selection before the edit, for the undo entry to restore. */
  beforeSelection?: { start: number; end: number };
}

class SessionProjectionCache {
  private entry: {
    text: string;
    version: number;
    projection: ComposerSessionProjection;
  } | null = null;

  get(text: string, version: number): ComposerSessionProjection {
    if (this.entry?.text === text && this.entry.version === version)
      return this.entry.projection;
    const projection = projectComposerSessions(text);
    this.entry = { text, version, projection };
    return projection;
  }
}

interface SessionEdit {
  beforeCanonical: string;
  beforeDisplay: string;
  beforeSelectionCanonical: { start: number; end: number };
  afterCanonical: string;
  afterDisplay: string;
  afterSelectionCanonical: { start: number; end: number };
  /** Native edits have happened since, so ⌘Z owes them first. */
  blockedByNativeEdits: boolean;
}

export interface SessionNameProjection {
  /** What the textarea shows: titles in place of the ids in `text`. */
  displayText: string;
  /** The named tokens in the visible text, for pill painting and hit tests. */
  sessions: DisplaySessionRange[];
  projection: ComposerSessionProjection;
  /**
   * Write visible text back to the draft, returning the caret's new display
   * offset. This is what a programmatic insertion (dictation, the mention
   * picker) writes through, so it cannot mistake a title for typed prose.
   */
  setDisplayText: (
    next: string,
    selectionStart?: number,
    selectionEnd?: number,
    options?: SetDisplayTextOptions,
  ) => number;
  /** Record the replaced range while the browser still knows it. */
  handleBeforeInput: (e: React.FormEvent<HTMLTextAreaElement>) => void;
  /** Apply one field edit. True when it was replayed as a token undo/redo, so
   *  the caller's own post-change work is skipped exactly as it would be for
   *  any other handled event. */
  handleChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => boolean;
  /** ⌘Z / ⌘⇧Z across a token edit. True when it was claimed. */
  handleUndoRedoKey: (e: React.KeyboardEvent) => boolean;
  /** A press inside a token removes the whole reference. */
  removeTokenAtCaret: (el: HTMLTextAreaElement) => boolean;
  /** Backspace at a token's end, or Delete at its start, takes all of it. */
  deleteTokenAtEdge: (key: string, el: HTMLTextAreaElement) => boolean;
  /** Copy and cut carry the id, not the title. */
  handleCopy: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  handleCut: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  /** Where a visible offset lands in the canonical draft. */
  canonicalOffset: (displayOffset: number) => number;
  /** Where a canonical offset lands in the visible text. */
  displayOffset: (canonicalOffset: number) => number;
}

export function useSessionNameProjection({
  text,
  setText,
  textareaRef,
}: {
  text: string;
  setText: (next: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}): SessionNameProjection {
  const [titleVersion, setTitleVersion] = useState(0);
  const [projectionCache] = useState(() => new SessionProjectionCache());
  const projection = projectionCache.get(text, titleVersion);
  const projectionRef = useRef(projection);
  useLayoutEffect(() => {
    projectionRef.current = projection;
  });
  const displayText = projection.displayText;
  const pendingCanonicalSelection = useRef<{
    start: number;
    end: number;
  } | null>(null);
  const editHistory = useRef<SessionEdit[]>([]);
  const redoHistory = useRef<SessionEdit[]>([]);
  const beforeInput = useRef<{
    start: number;
    end: number;
    inputType: string;
  } | null>(null);

  // A session is named while it is being worked on, so a token can gain its
  // title (or be renamed) under a draft nobody is touching. Hold the caret in
  // canonical terms across that re-render, or it drifts by the difference
  // between the id's length and the title's.
  useEffect(
    () =>
      onSessionTitlesChanged(() => {
        const el = textareaRef.current;
        if (el) {
          pendingCanonicalSelection.current = composerCanonicalSelection(
            projectionRef.current,
            el.selectionStart,
            el.selectionEnd,
          );
        }
        setTitleVersion((n) => n + 1);
      }),
    [textareaRef],
  );

  const setDisplayText = (
    next: string,
    selectionStart?: number,
    selectionEnd?: number,
    options?: SetDisplayTextOptions,
  ) => {
    const resolvedStart = selectionStart ?? next.length;
    const resolvedEnd = selectionEnd ?? resolvedStart;
    const inputKind = options?.inputKind ?? "programmatic";
    const edit = applyComposerSessionEdit(
      projection,
      next,
      resolvedStart,
      resolvedEnd,
      options?.editHint,
    );
    // Seed the render that follows this edit, avoiding a second full scan of
    // the draft and its code ranges for the same canonical text.
    const projected = projectionCache.get(edit.canonicalText, titleVersion);
    pendingCanonicalSelection.current = {
      start: edit.canonicalSelectionStart,
      end: edit.canonicalSelectionEnd,
    };
    if (edit.touchedSession && inputKind !== "history") {
      const beforeSelection = options?.beforeSelection ?? {
        start: options?.editHint?.start ?? resolvedStart,
        end: options?.editHint?.end ?? resolvedStart,
      };
      editHistory.current.push({
        beforeCanonical: text,
        beforeDisplay: displayText,
        beforeSelectionCanonical: composerCanonicalSelection(
          projection,
          beforeSelection.start,
          beforeSelection.end,
        ),
        afterCanonical: edit.canonicalText,
        afterDisplay: projected.displayText,
        afterSelectionCanonical: {
          start: edit.canonicalSelectionStart,
          end: edit.canonicalSelectionEnd,
        },
        blockedByNativeEdits: false,
      });
      if (editHistory.current.length > 50) editHistory.current.shift();
      redoHistory.current = [];
    } else if (inputKind === "native") {
      // Let native undo consume ordinary edits before crossing a token edit.
      const history = editHistory.current.at(-1);
      if (history) history.blockedByNativeEdits = true;
      redoHistory.current = [];
    } else if (inputKind === "programmatic") {
      // Programmatic edits have no browser history entry to cross later.
      editHistory.current = [];
      redoHistory.current = [];
    }
    setText(edit.canonicalText);
    return composerDisplayOffset(projected, edit.canonicalSelectionEnd);
  };

  useLayoutEffect(() => {
    const selection = pendingCanonicalSelection.current;
    const el = textareaRef.current;
    if (!selection || !el) return;
    pendingCanonicalSelection.current = null;
    el.setSelectionRange(
      composerDisplayOffset(projection, selection.start),
      composerDisplayOffset(projection, selection.end),
    );
  }, [displayText, projection, textareaRef]);

  function handleBeforeInput(e: React.FormEvent<HTMLTextAreaElement>) {
    const native = e.nativeEvent as InputEvent;
    const el = e.currentTarget;
    beforeInput.current = {
      start: el.selectionStart,
      end: el.selectionEnd,
      inputType: native.inputType || "",
    };
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>): boolean {
    const inputType = (e.nativeEvent as InputEvent).inputType;
    const historyInput =
      inputType === "historyUndo" || inputType === "historyRedo";
    if (historyInput) {
      const source =
        inputType === "historyUndo" ? editHistory.current : redoHistory.current;
      const history = source.at(-1);
      const undo =
        inputType === "historyUndo" &&
        history &&
        text === history.afterCanonical &&
        e.target.value === history.beforeDisplay;
      const redo =
        inputType === "historyRedo" &&
        history &&
        text === history.beforeCanonical &&
        e.target.value === history.afterDisplay;
      if (history && (undo || redo)) {
        source.pop();
        (undo ? redoHistory.current : editHistory.current).push(history);
        pendingCanonicalSelection.current = undo
          ? history.beforeSelectionCanonical
          : history.afterSelectionCanonical;
        setText(undo ? history.beforeCanonical : history.afterCanonical);
        beforeInput.current = null;
        return true;
      }
    }

    const before = historyInput ? null : beforeInput.current;
    beforeInput.current = null;
    let editHint: ComposerDisplayEdit | undefined;
    if (before) {
      let { start, end } = before;
      const removed = Math.max(0, displayText.length - e.target.value.length);
      const kind = inputType || before.inputType;
      if (start === end && kind.endsWith("Backward"))
        start = Math.max(0, start - removed);
      else if (start === end && kind.endsWith("Forward"))
        end = Math.min(displayText.length, end + removed);
      editHint = { start, end };
    }
    setDisplayText(
      e.target.value,
      e.target.selectionStart,
      e.target.selectionEnd,
      {
        editHint,
        inputKind: historyInput ? "history" : "native",
        ...(before
          ? { beforeSelection: { start: before.start, end: before.end } }
          : {}),
      },
    );
    if (
      inputType === "historyUndo" &&
      editHistory.current.at(-1)?.afterDisplay === e.target.value
    ) {
      editHistory.current.at(-1)!.blockedByNativeEdits = false;
    }
    return false;
  }

  function handleUndoRedoKey(e: React.KeyboardEvent): boolean {
    const undo =
      (e.metaKey || e.ctrlKey) &&
      !e.altKey &&
      !e.shiftKey &&
      e.key.toLowerCase() === "z";
    const redo =
      !e.altKey &&
      ((e.metaKey && e.shiftKey && e.key.toLowerCase() === "z") ||
        (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "y"));
    if (undo) {
      const history = editHistory.current.at(-1);
      // Ordinary edits happened after the token edit, so this ⌘Z belongs to
      // the field's own history. Claimed without preventDefault: the browser
      // still performs the undo, and no other handler should read the key.
      if (history?.blockedByNativeEdits) return true;
      if (history && text === history.afterCanonical) {
        e.preventDefault();
        editHistory.current.pop();
        redoHistory.current.push(history);
        pendingCanonicalSelection.current = history.beforeSelectionCanonical;
        setText(history.beforeCanonical);
        return true;
      }
    }
    if (redo) {
      const history = redoHistory.current.at(-1);
      if (history && text === history.beforeCanonical) {
        e.preventDefault();
        redoHistory.current.pop();
        editHistory.current.push(history);
        pendingCanonicalSelection.current = history.afterSelectionCanonical;
        setText(history.afterCanonical);
        return true;
      }
    }
    return false;
  }

  /** Erase one whole token, taking the space after it so removing a reference
   *  mid-sentence doesn't leave a double space behind. */
  function removeToken(
    token: DisplaySessionRange,
    caret: { start: number; end: number },
  ) {
    const end = displayText[token.end] === " " ? token.end + 1 : token.end;
    setDisplayText(
      displayText.slice(0, token.start) + displayText.slice(end),
      token.start,
      token.start,
      {
        editHint: { start: token.start, end },
        beforeSelection: caret,
      },
    );
  }

  function removeTokenAtCaret(el: HTMLTextAreaElement): boolean {
    if (el.selectionStart !== el.selectionEnd) return false;
    const caret = el.selectionStart;
    // A caret strictly inside a token came from pressing it; its edges still
    // place an ordinary caret, which is the margin that keeps a click beside
    // a reference from eating one.
    const hit = projection.sessions.find(
      (session) => caret > session.start && caret < session.end,
    );
    if (!hit) return false;
    removeToken(hit, { start: caret, end: caret });
    return true;
  }

  function deleteTokenAtEdge(key: string, el: HTMLTextAreaElement): boolean {
    if (el.selectionStart !== el.selectionEnd) return false;
    const caret = el.selectionStart;
    const back = key === "Backspace";
    const hit = projection.sessions.find((session) =>
      back
        ? caret === session.end ||
          (caret === session.end + 1 && displayText[session.end] === " ")
        : caret === session.start,
    );
    if (!hit) return false;
    const end = back ? Math.max(caret, hit.end) : hit.end;
    setDisplayText(
      displayText.slice(0, hit.start) + displayText.slice(end),
      hit.start,
      hit.start,
      {
        editHint: { start: hit.start, end },
        beforeSelection: { start: caret, end: caret },
      },
    );
    return true;
  }

  function clipboardSelection(el: HTMLTextAreaElement) {
    if (el.selectionStart === el.selectionEnd) return null;
    const touchesSession = projection.sessions.some(
      (session) =>
        el.selectionStart < session.end && el.selectionEnd > session.start,
    );
    if (!touchesSession) return null;
    const selection = composerCanonicalSelection(
      projection,
      el.selectionStart,
      el.selectionEnd,
    );
    return {
      text: text.slice(selection.start, selection.end),
      displayStart: el.selectionStart,
      displayEnd: el.selectionEnd,
    };
  }

  function handleCopy(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const selection = clipboardSelection(e.currentTarget);
    if (!selection) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", selection.text);
  }

  function handleCut(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const selection = clipboardSelection(e.currentTarget);
    if (!selection) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", selection.text);
    setDisplayText(
      displayText.slice(0, selection.displayStart) +
        displayText.slice(selection.displayEnd),
      selection.displayStart,
      selection.displayStart,
      {
        editHint: { start: selection.displayStart, end: selection.displayEnd },
        beforeSelection: {
          start: selection.displayStart,
          end: selection.displayEnd,
        },
      },
    );
  }

  return {
    displayText,
    sessions: projection.sessions,
    projection,
    setDisplayText,
    handleBeforeInput,
    handleChange,
    handleUndoRedoKey,
    removeTokenAtCaret,
    deleteTokenAtEdge,
    handleCopy,
    handleCut,
    canonicalOffset: (offset: number) =>
      composerCanonicalOffset(projection, offset),
    displayOffset: (offset: number) =>
      composerDisplayOffset(projection, offset),
  };
}
