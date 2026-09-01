import { useLayoutEffect, useRef, useState } from "react";
import type { DiffLineAnnotation, SelectedLineRange } from "@pierre/diffs";
import type { CommentTarget, PendingComment } from "../lib/commentable-diff";

export interface PendingCommentMetadata {
  kind: "pending";
  comment: PendingComment;
}

export interface DiffCommentDraft {
  fileIndex: number;
  path: string;
  range: SelectedLineRange;
}

export interface CommentDraftTextStore {
  read: () => string;
  write: (value: string) => void;
  clear: () => void;
}

class CommentDraftText implements CommentDraftTextStore {
  private value = "";
  read() {
    return this.value;
  }
  write(value: string) {
    this.value = value;
  }
  clear() {
    this.value = "";
  }
}

interface Options {
  comments: PendingComment[] | undefined;
  submitLabel: string;
  onSubmit: (target: CommentTarget, text: string) => Promise<void>;
}

export function usePendingComments({
  comments,
  submitLabel,
  onSubmit,
}: Options) {
  const reviewMode = comments !== undefined;
  const [draft, setDraft] = useState<DiffCommentDraft | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const draftRef = useRef<DiffCommentDraft | null>(null);
  useLayoutEffect(() => {
    draftRef.current = draft;
  });
  // Keep text outside render state so it survives a range-change remount
  // without making the full diff tree rerender on every textarea keystroke.
  const [draftText] = useState(() => new CommentDraftText());

  const handleSelect = (
    fileIndex: number,
    path: string,
    range: SelectedLineRange | null,
  ) => {
    if (!range) return; // keep the draft on stray deselects; Cancel closes it
    setConfirmation(null);
    setDraft({ fileIndex, path, range });
  };

  const closeDraft = () => {
    draftText.clear();
    setDraft(null);
  };

  const submitDraft = async (body: string) => {
    const currentDraft = draftRef.current;
    if (!currentDraft) return;
    const side: "additions" | "deletions" =
      currentDraft.range.side === "deletions" ? "deletions" : "additions";
    await onSubmit(
      {
        path: currentDraft.path,
        startLine: Math.min(currentDraft.range.start, currentDraft.range.end),
        endLine: Math.max(currentDraft.range.start, currentDraft.range.end),
        side,
      },
      body,
    );
    draftText.clear();
    setDraft(null);
    // In review mode the pending card is the confirmation; skip the toast.
    if (!reviewMode) {
      setConfirmation(`${submitLabel} ✓`);
      setTimeout(() => setConfirmation(null), 4000);
    }
  };

  // Group pending comments by file once per change, so unaffected files reuse a
  // stable annotations array reference (and their memoized row bails out).
  const annotationsByFile = new Map<
    string,
    DiffLineAnnotation<PendingCommentMetadata>[]
  >();
  for (const comment of comments ?? []) {
    const annotations = annotationsByFile.get(comment.path) ?? [];
    annotations.push({
      side: comment.side,
      lineNumber: comment.endLine,
      metadata: { kind: "pending", comment },
    });
    annotationsByFile.set(comment.path, annotations);
  }

  return {
    annotationsByFile,
    closeDraft,
    confirmation,
    draft,
    draftRef,
    draftText,
    handleSelect,
    reviewMode,
    submitDraft,
  };
}
