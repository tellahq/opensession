import React, { useMemo, useState, useRef, useCallback, useEffect } from "react";
import { parsePatchFiles } from "@pierre/diffs";
import { EditProvider, FileDiff } from "@pierre/diffs/react";
import type {
  SelectedLineRange,
  FileDiffMetadata,
  DiffLineAnnotation,
  DiffsEditor,
  FileDiffLoadedFiles,
} from "@pierre/diffs";
import type { Editor, EditorOptions } from "@pierre/diffs/edit";
import type { DiffFileGroup } from "../lib/types";
import { IconCheck, IconChevronRight, IconCopy, IconPencil, IconUndo } from "./icons";
import { copyToClipboard } from "../lib/share-link";
import { Tooltip } from "../ui/tooltip";
import { Button } from "../ui/button";
import { useResolvedTheme } from "./CodeHighlight";
import { PixelSpinner } from "./PixelSpinner";

export interface CommentTarget {
  path: string;
  startLine: number;
  endLine: number;
  side: "additions" | "deletions";
}

export interface PendingComment extends CommentTarget {
  id: string;
  text: string;
}

/** URLs for a changed image's two sides (either may be absent). */
export interface DiffImageSrcs {
  oldSrc?: string;
  newSrc?: string;
}

interface Props {
  patch: string;
  submitLabel: string;
  placeholder: string;
  disabled?: boolean;
  disabledHint?: string;
  /** Expand this many leading files on first render (review canvas uses 10). */
  defaultExpandedFiles?: number;
  onSubmit: (target: CommentTarget, text: string) => Promise<void>;
  /**
   * When provided, changed image files render the actual pictures (before/after)
   * instead of an empty binary diff. The callback maps a file to the URLs of its
   * two sides — the host knows where the bytes live (worktree endpoint, PR blob
   * endpoint). Non-image files are unaffected.
   */
  imageSrcs?: (file: FileDiffMetadata) => DiffImageSrcs | null;
  /** AI-generated logical categories. Omitted while generation is pending or
   *  unavailable, preserving the ordinary flat file list. */
  groups?: DiffFileGroup[];
  groupsLoading?: boolean;
  /** PR review canvases use GitHub's side-by-side presentation; workspace diffs stay unified. */
  diffStyle?: "unified" | "split";
  /**
   * Review-batching mode: when provided, already-added comments render inline as
   * pending cards (the parent owns the list and submits them as one review).
   * Without it the component stays single-shot (e.g. session feedback).
   */
  pendingComments?: PendingComment[];
  onRemovePending?: (id: string) => void;
  /**
   * When provided, each file row gets a hover-revealed "Discard" action that
   * resets the file to its base state (removing it from the diff). Only wired
   * where the diff maps to a live, editable worktree (the session Changes tab),
   * never in read-only PR previews. `oldPath` is set for renames.
   */
  onDiscard?: (path: string, oldPath?: string) => Promise<void>;
  /**
   * GitHub-style per-file "Viewed" checkboxes, backed by GitHub's own
   * per-viewer viewed state (markFileAsViewed). The parent owns the set —
   * `undefined` means still loading (checkboxes hidden); marking a file
   * viewed collapses it. GitHub handles staleness: a file changed after
   * being viewed comes back DIRTY, which the server treats as not viewed.
   */
  viewedFiles?: ReadonlySet<string>;
  onToggleViewed?: (path: string, viewed: boolean) => void;
  /**
   * @pierre/diffs edit mode: makes files editable in place. Only wired where
   * the diff maps to a live worktree (the session Changes tab). `load` fetches
   * one side's full contents (the editor needs whole files, not hunks); `save`
   * writes the edited text back.
   */
  editFile?: {
    load: (file: FileDiffMetadata, side: "new" | "base") => Promise<string | null>;
    save: (path: string, content: string) => Promise<void>;
  };
}

interface Draft {
  fileIndex: number;
  path: string;
  range: SelectedLineRange;
}

type Meta = { kind: "draft" } | { kind: "pending"; comment: PendingComment };

// `theme`/`themeType` are applied per-row from the app's resolved appearance
// (see FileDiffRow) so the diff isn't pinned dark in light mode.
const BASE_OPTIONS = {
  diffStyle: "unified" as const,
  // Our own collapsible row owns the file header (name + stats + caret), so
  // suppress @pierre/diffs' built-in one to avoid a double header.
  disableFileHeader: true,
  overflow: "scroll" as const,
  enableLineSelection: true,
};

/** Per-file +/- counts, summed from the parsed hunks. */
function fileStats(file: FileDiffMetadata): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const h of file.hunks) {
    add += h.additionLines;
    del += h.deletionLines;
  }
  return { add, del };
}

// Stable empty-annotations reference so files with no comments keep prop identity
// across re-renders (lets the memoized row bail out instead of re-parsing).
const NO_ANNOTATIONS: DiffLineAnnotation<Meta>[] = [];

const NO_VIEWED: ReadonlySet<string> = new Set();

// Lock files are machine-written churn nobody reads line by line — they start
// collapsed even when the surface expands everything. The header row (with its
// +/- counts) and manual expand / "Expand all" still work.
const LOCK_FILE =
  /(^|\/)(bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|Gemfile\.lock|composer\.lock|poetry\.lock|uv\.lock|go\.sum|flake\.lock|Podfile\.lock|Package\.resolved)$/;

// The viewed set spans the whole PR while a guide section renders a subset,
// so count intersections rather than trusting `viewed.size`.
function countViewed(
  viewed: ReadonlySet<string>,
  files: FileDiffMetadata[],
): number {
  return files.reduce((n, f) => n + (viewed.has(f.name) ? 1 : 0), 0);
}

/**
 * Renders a multi-file patch with @pierre/diffs, one FileDiff per file so
 * line selections carry their file context. Selecting lines opens an inline
 * comment form (the diffs annotation framework); submit is delegated to the
 * parent (session feedback or GitHub PR comment).
 *
 * Perf: the comment-draft text lives in the inline `CommentForm` (local state),
 * NOT here — so typing re-renders only the open form, not every FileDiff. Each
 * row is memoized with stable props (annotations, onSelect, renderAnnotation),
 * so a selection change re-renders at most the two files it touches.
 */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i;

export function CommentableDiff({
  patch,
  defaultExpandedFiles = 0,
  submitLabel,
  placeholder,
  disabled,
  disabledHint,
  onSubmit,
  pendingComments,
  onRemovePending,
  onDiscard,
  imageSrcs,
  groups,
  groupsLoading,
  diffStyle = "unified",
  viewedFiles,
  onToggleViewed,
  editFile,
}: Props) {
  const reviewMode = pendingComments !== undefined;
  const theme = useResolvedTheme();
  const files = useMemo<FileDiffMetadata[]>(() => {
    try {
      return parsePatchFiles(patch).flatMap((p) => p.files);
    } catch {
      return [];
    }
  }, [patch]);

  // GitHub-backed "Viewed" checkboxes: hidden until the parent's fetch lands.
  const viewedEnabled = !!onToggleViewed && viewedFiles !== undefined;
  const viewed = viewedFiles ?? NO_VIEWED;

  // Files render collapsed by default (just the header row) — mounting a
  // FileDiff parses + highlights on the main thread, so a large change would
  // otherwise block the tab. `expanded` holds the indices the user opened.
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(
    () =>
      new Set(
        files
          .slice(0, defaultExpandedFiles)
          .map((_, index) => index)
          .filter((index) => !LOCK_FILE.test(files[index].name)),
      ),
  );
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const toggle = useCallback((i: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }, []);
  const allOpen = expanded.size >= files.length && files.length > 0;
  const toggleAll = useCallback(() => {
    setExpanded((prev) => {
      if (prev.size >= files.length) return new Set();
      setCollapsedGroups(new Set());
      return new Set(files.map((_, i) => i));
    });
  }, [files]);

  const stats = useMemo(() => files.map(fileStats), [files]);
  const groupedFiles = useMemo(() => {
    if (!groups?.length) return null;
    const byPath = new Map(files.map((file, index) => [file.name, index]));
    const used = new Set<number>();
    const resolved = groups.flatMap((group) => {
      const indices = group.files.flatMap((path) => {
        const index = byPath.get(path);
        if (index === undefined || used.has(index)) return [];
        used.add(index);
        return [index];
      });
      return indices.length ? [{ ...group, indices }] : [];
    });
    const remaining = files.flatMap((_, index) => (used.has(index) ? [] : [index]));
    if (remaining.length) resolved.push({ title: "Other", files: [], indices: remaining });
    return resolved.length >= 2 ? resolved : null;
  }, [files, groups]);

  useEffect(() => {
    setCollapsedGroups(new Set());
  }, [groups]);

  // Discard is destructive + irreversible, so it's a two-click arm/confirm:
  // the first click arms a row (button flips to "Discard changes?"), the second
  // within 4s performs it. `discarding` disables the row while the request runs.
  const [armed, setArmed] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState<string | null>(null);
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const disarm = useCallback(() => {
    clearTimeout(disarmTimer.current);
    setArmed(null);
  }, []);
  const handleDiscard = useCallback(
    async (file: FileDiffMetadata) => {
      if (!onDiscard) return;
      const key = file.name;
      if (armed !== key) {
        setArmed(key);
        clearTimeout(disarmTimer.current);
        disarmTimer.current = setTimeout(() => setArmed(null), 4000);
        return;
      }
      clearTimeout(disarmTimer.current);
      setArmed(null);
      setDiscarding(key);
      try {
        await onDiscard(file.name, file.prevName);
      } finally {
        setDiscarding(null);
      }
    },
    [onDiscard, armed],
  );
  useEffect(() => () => clearTimeout(disarmTimer.current), []);

  // Copying the path is the reliable way to get it out of the diff — text
  // selection breaks wherever the surrounding surface sets user-select: none.
  const [copied, setCopied] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const copyPath = useCallback((path: string) => {
    copyToClipboard(path, () => {
      setCopied(path);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(null), 1400);
    });
  }, []);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  const viewedCollapseKey = useRef<string | null>(null);
  useEffect(() => {
    setExpanded(
      new Set(
        files
          .slice(0, defaultExpandedFiles)
          .map((_, index) => index)
          .filter((index) => !LOCK_FILE.test(files[index].name)),
      ),
    );
    viewedCollapseKey.current = null;
  }, [patch, defaultExpandedFiles, files]);

  // Collapse already-viewed files once GitHub's viewed state arrives (it
  // loads async, after the diff renders). Applied once per patch so it never
  // fights a user who re-expands a viewed file.
  useEffect(() => {
    if (viewedFiles === undefined || viewedCollapseKey.current === patch) return;
    viewedCollapseKey.current = patch;
    if (viewedFiles.size === 0) return;
    setExpanded(
      (prev) =>
        new Set(
          [...prev].filter((index) => !viewedFiles.has(files[index]?.name ?? "")),
        ),
    );
  }, [viewedFiles, patch, files]);

  const toggleViewed = useCallback(
    (file: FileDiffMetadata, index: number) => {
      if (!onToggleViewed) return;
      const wasViewed = viewed.has(file.name);
      onToggleViewed(file.name, !wasViewed);
      // Marking viewed collapses the file (done reading it); unmarking reopens.
      setExpanded((prev) => {
        const n = new Set(prev);
        if (wasViewed) n.add(index);
        else n.delete(index);
        return n;
      });
    },
    [onToggleViewed, viewed],
  );

  // ---- Edit mode (@pierre/diffs edit) ------------------------------------
  // One file edits at a time. The editor engine is lazy-loaded on first use
  // (it's a full code editor; review-only surfaces never pay for it). The
  // active Editor instance is captured by the EditProvider factory so Save can
  // read the full edited text.
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const editModuleRef = useRef<typeof import("@pierre/diffs/edit") | null>(null);
  const editorRef = useRef<Editor<Meta> | null>(null);

  const startEdit = useCallback(async (file: FileDiffMetadata, index: number) => {
    if (!editModuleRef.current) {
      editModuleRef.current = await import("@pierre/diffs/edit");
    }
    setEditError(null);
    setEditingPath(file.name);
    setExpanded((prev) => new Set(prev).add(index));
  }, []);

  const cancelEdit = useCallback(() => {
    editorRef.current = null;
    setEditingPath(null);
    setEditError(null);
  }, []);

  const saveEdit = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor || !editingPath || !editFile || savingEdit) return;
    setSavingEdit(true);
    setEditError(null);
    try {
      await editFile.save(editingPath, editor.getText());
      editorRef.current = null;
      setEditingPath(null);
    } catch (e: any) {
      setEditError(e?.message || "Failed to save");
    } finally {
      setSavingEdit(false);
    }
  }, [editingPath, editFile, savingEdit]);

  const createEditor = useCallback((options: EditorOptions<Meta>) => {
    const editor = new editModuleRef.current!.Editor<Meta>(options);
    editorRef.current = editor;
    return editor;
  }, []);

  // Full-contents loader for the file being edited: the editor needs whole
  // files, while a patch only carries hunks (saving hunk-only text would
  // truncate the file on disk).
  const loadDiffFiles = useCallback(
    async (fd: FileDiffMetadata): Promise<FileDiffLoadedFiles> => {
      if (!editFile) throw new Error("Not editable");
      const [oldText, newText] = await Promise.all([
        editFile.load(fd, "base"),
        editFile.load(fd, "new"),
      ]);
      return {
        oldFile:
          oldText == null
            ? null
            : { name: fd.prevName || fd.name, contents: oldText },
        newFile: { name: fd.name, contents: newText ?? "" },
      } as FileDiffLoadedFiles;
    },
    [editFile],
  );

  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const draftRef = useRef<Draft | null>(null);
  draftRef.current = draft;
  // Draft text is held in a ref so it survives the form remounting when the
  // selection range is adjusted, without re-rendering the diff on each keystroke.
  const draftTextRef = useRef("");

  const handleSelect = useCallback((fileIndex: number, path: string, range: SelectedLineRange | null) => {
    if (!range) return; // keep the draft on stray deselects; Cancel closes it
    setConfirmation(null);
    setDraft({ fileIndex, path, range });
  }, []);

  const closeDraft = useCallback(() => {
    draftTextRef.current = "";
    setDraft(null);
  }, []);

  const submitDraft = useCallback(
    async (body: string) => {
      const d = draftRef.current;
      if (!d) return;
      const side: "additions" | "deletions" = d.range.side === "deletions" ? "deletions" : "additions";
      await onSubmit(
        {
          path: d.path,
          startLine: Math.min(d.range.start, d.range.end),
          endLine: Math.max(d.range.start, d.range.end),
          side,
        },
        body,
      );
      draftTextRef.current = "";
      setDraft(null);
      // In review mode the pending card is the confirmation; skip the toast.
      if (!reviewMode) {
        setConfirmation(`${submitLabel} ✓`);
        setTimeout(() => setConfirmation(null), 4000);
      }
    },
    [onSubmit, reviewMode, submitLabel],
  );

  const renderPending = useCallback(
    (comment: PendingComment): React.ReactNode => {
      const lineLabel =
        comment.startLine === comment.endLine
          ? `line ${comment.startLine}`
          : `lines ${comment.startLine}–${comment.endLine}`;
      return (
        <div className="diff-pending-comment m-2 flex flex-col gap-1.5 rounded-md border border-line-strong border-l-[3px] border-l-accent bg-panel px-2.5 py-[9px] font-sans" onClick={(e) => e.stopPropagation()}>
          <div className="diff-pending-head flex items-center justify-between gap-2">
            <span className="diff-comment-target font-mono text-meta text-faint">
              {comment.path} · {lineLabel}
              {comment.side === "deletions" ? " (removed)" : ""}
            </span>
            {onRemovePending && (
              <button
                className="diff-pending-remove border-0 bg-transparent px-1 py-0.5 text-meta text-faint hover:text-red"
                onClick={() => onRemovePending(comment.id)}
                title="Remove this pending comment"
              >
                Remove
              </button>
            )}
          </div>
          <div className="diff-pending-text whitespace-pre-wrap break-words text-control-label leading-[1.45] text-fg">{comment.text}</div>
        </div>
      );
    },
    [onRemovePending],
  );

  // Stable across draft/text changes (reads the current draft from the ref), so
  // memoized rows keep their prop identity while the user selects and types.
  const renderAnnotation = useCallback(
    (annotation: DiffLineAnnotation<Meta>): React.ReactNode => {
      if (annotation.metadata?.kind === "pending") {
        return renderPending(annotation.metadata.comment);
      }
      const d = draftRef.current;
      if (!d) return null;
      const lineLabel =
        d.range.start === d.range.end
          ? `line ${d.range.start}`
          : `lines ${Math.min(d.range.start, d.range.end)}–${Math.max(d.range.start, d.range.end)}`;
      const targetLabel = `${d.path} · ${lineLabel}${d.range.side === "deletions" ? " (removed)" : ""}`;
      return (
        <CommentForm
          targetLabel={targetLabel}
          disabled={disabled}
          disabledHint={disabledHint}
          placeholder={placeholder}
          submitLabel={submitLabel}
          textRef={draftTextRef}
          onCancel={closeDraft}
          onSubmit={submitDraft}
        />
      );
    },
    [renderPending, disabled, disabledHint, placeholder, submitLabel, closeDraft, submitDraft],
  );

  // Group pending comments by file once per change, so unaffected files reuse a
  // stable annotations array reference (and their memoized row bails out).
  const pendingByFile = useMemo(() => {
    const m = new Map<string, DiffLineAnnotation<Meta>[]>();
    for (const c of pendingComments || []) {
      const arr = m.get(c.path) || [];
      arr.push({
        side: c.side === "deletions" ? "deletions" : "additions",
        lineNumber: c.endLine,
        metadata: { kind: "pending", comment: c },
      });
      m.set(c.path, arr);
    }
    return m;
  }, [pendingComments]);

  if (files.length === 0) {
    return <div className="panel-placeholder">Nothing to display</div>;
  }

  const renderFile = (file: FileDiffMetadata, i: number) => {
    const pend = pendingByFile.get(file.name) || NO_ANNOTATIONS;
    const isDraftFile = draft?.fileIndex === i;
    const isEditing = editingPath === file.name;
    // Keep a file open while it holds a draft (the comment form lives inside
    // the diff), already-added pending comments (so they stay visible), or an
    // active edit session (collapsing would unmount the editor mid-edit).
    const isOpen = expanded.has(i) || isDraftFile || pend.length > 0 || isEditing;
    const isViewed = viewed.has(file.name);
    const editable =
      !!editFile && file.type !== "deleted" && !IMAGE_EXT.test(file.name);
    const s = stats[i];
    const slash = file.name.lastIndexOf("/");
    const dir = slash >= 0 ? file.name.slice(0, slash + 1) : "";
    const base = slash >= 0 ? file.name.slice(slash + 1) : file.name;
    const annotations = isDraftFile
      ? [
          ...pend,
          {
            side: (draft!.range.side === "deletions" ? "deletions" : "additions") as "additions" | "deletions",
            lineNumber: Math.max(draft!.range.start, draft!.range.end),
            metadata: { kind: "draft" as const },
          },
        ]
      : pend;

    return (
      <div className="diff-file overflow-hidden rounded-md border border-line bg-panel" key={`${file.name}-${i}`} data-diff-file={file.name}>
        <div
          className="diff-file-header group relative flex w-full items-center gap-2 border-0 bg-transparent px-2.5 py-2 text-left text-fg hover:bg-hover"
          role="button"
          tabIndex={0}
          aria-expanded={isOpen}
          onClick={() => {
            disarm();
            toggle(i);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              disarm();
              toggle(i);
            }
          }}
        >
          <IconChevronRight
            size={16}
            className={`diff-file-caret shrink-0 text-faint transition-transform duration-100 ${isOpen ? "diff-file-caret-open rotate-90" : ""}`}
          />
          <span className="diff-file-name flex min-w-0 flex-1 cursor-text select-text overflow-hidden font-mono text-supporting" onClick={(e) => e.stopPropagation()}>
            {dir && <span className="diff-file-dir min-w-0 shrink overflow-hidden text-ellipsis whitespace-nowrap text-faint">{dir}</span>}
            <span className="diff-file-base shrink-0 whitespace-nowrap font-semibold text-fg">{base}</span>
            <Tooltip label={copied === file.name ? "Copied" : "Copy path"}>
              <button
                type="button"
                className={`diff-file-copy ${copied === file.name ? "diff-file-copy-done" : ""}`}
                aria-label={`Copy path ${file.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  copyPath(file.name);
                }}
              >
                {copied === file.name ? <IconCheck size={20} /> : <IconCopy size={20} />}
              </button>
            </Tooltip>
          </span>
          {pend.length > 0 && <span className="diff-file-comments inline-flex shrink-0 items-center gap-1 font-sans text-meta text-faint before:content-['💬']">{pend.length}</span>}
          {isEditing && (
            <span
              className="diff-file-edit-actions"
              onClick={(e) => e.stopPropagation()}
            >
              {editError && <span className="diff-edit-error">{editError}</span>}
              <Button
                variant="default"
                size="sm"
                className="min-h-0 border-line-strong bg-transparent px-2.5 py-[3px] text-xs font-normal shadow-none"
                onClick={cancelEdit}
                disabled={savingEdit}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                className="min-h-0 px-2.5 py-[3px] text-xs font-medium shadow-none"
                onClick={saveEdit}
                disabled={savingEdit}
              >
                {savingEdit ? "Saving…" : "Save"}
              </Button>
            </span>
          )}
          {editable && !isEditing && (
            <Tooltip label="Edit file in place">
              <button
                type="button"
                className="diff-file-edit rounded-sm border-0 bg-transparent p-0.5 text-faint hover:bg-hover hover:text-fg"
                aria-label="Edit this file in place"
                onClick={(e) => {
                  e.stopPropagation();
                  void startEdit(file, i);
                }}
              >
                <IconPencil size={16} />
              </button>
            </Tooltip>
          )}
          {onDiscard && (
            <Tooltip
              label={
                discarding === file.name
                  ? "Discarding…"
                  : armed === file.name
                    ? "Click again to discard"
                    : "Discard changes"
              }
            >
              <button
                type="button"
                className={`diff-file-discard peer absolute right-2 top-1/2 z-[1] inline-flex -translate-y-1/2 items-center justify-center rounded-sm border-0 bg-transparent p-0.5 text-faint opacity-0 pointer-events-none transition-[color,background,opacity] duration-100 hover:bg-hover hover:text-red focus-visible:pointer-events-auto focus-visible:opacity-100 disabled:pointer-events-auto disabled:cursor-default disabled:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 ${armed === file.name ? "diff-file-discard-armed pointer-events-auto text-red opacity-100" : ""}`}
                disabled={discarding === file.name}
                aria-label="Discard this file's changes (reset to base)"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDiscard(file);
                }}
              >
                <IconUndo size={20} />
              </button>
            </Tooltip>
          )}
          <span className={`diff-file-stats ml-auto flex shrink-0 gap-2 font-mono text-label group-hover:invisible peer-focus-visible:invisible ${armed === file.name || discarding === file.name ? "invisible" : ""}`}>
            {s.add > 0 && <span className="diff-add font-semibold text-green">+{s.add}</span>}
            {s.del > 0 && <span className="diff-del font-semibold text-red">−{s.del}</span>}
          </span>
          {viewedEnabled && (
            <label
              className={`diff-file-viewed ${isViewed ? "diff-file-viewed-on" : ""}`}
              onClick={(e) => e.stopPropagation()}
            >
              <input
                type="checkbox"
                checked={isViewed}
                onChange={() => toggleViewed(file, i)}
              />
              Viewed
            </label>
          )}
        </div>
        {isOpen &&
          (imageSrcs && IMAGE_EXT.test(file.name) ? (
            <ImageDiffRow file={file} srcs={imageSrcs(file)} />
          ) : (
            <FileDiffRow
              key={theme}
              file={file}
              fileIndex={i}
              theme={theme}
              diffStyle={diffStyle}
              annotations={annotations}
              selectedLines={isDraftFile ? draft!.range : null}
              onSelect={handleSelect}
              renderAnnotation={renderAnnotation}
              editing={isEditing}
              createEditor={isEditing ? createEditor : undefined}
              loadDiffFiles={isEditing ? loadDiffFiles : undefined}
            />
          ))}
      </div>
    );
  };

  return (
    <div className="commentable-diff flex flex-col gap-2.5">
      {confirmation && <div className="diff-comment-confirmation rounded-sm bg-green-soft px-3 py-1.5 text-supporting font-semibold text-green">{confirmation}</div>}
      <div className="diff-file-toolbar -mb-1 flex items-center justify-end">
        {groupsLoading && (
          <span className="diff-groups-loading mr-auto flex items-center gap-2 text-label text-faint" role="status">
            <PixelSpinner cycling={false} className="text-faint" />
            Organizing files…
          </span>
        )}
        {!groupsLoading && groupedFiles && (
          <span className="diff-groups-ready mr-auto flex items-center gap-2 text-label text-faint before:size-1.5 before:rounded-full before:bg-accent before:content-['']">AI organized</span>
        )}
        {viewedEnabled && (
          <span className="diff-viewed-progress">
            {countViewed(viewed, files)} of {files.length} viewed
          </span>
        )}
        <button type="button" className="diff-file-toggle-all border-0 bg-transparent px-1 py-0.5 text-label font-medium text-faint hover:text-fg" onClick={toggleAll}>
          {allOpen ? "Collapse all" : "Expand all"}
        </button>
      </div>
      {groupedFiles
        ? groupedFiles.map((group) => {
            const groupKey = `${group.title}\0${group.indices.join(",")}`;
            const collapsed = collapsedGroups.has(groupKey);
            const totals = group.indices.reduce(
              (sum, index) => ({
                add: sum.add + stats[index].add,
                del: sum.del + stats[index].del,
              }),
              { add: 0, del: 0 },
            );
            return (
              <section className="diff-file-group flex flex-col gap-2 [&+&]:mt-1" key={groupKey}>
                <button
                  type="button"
                  className="diff-file-group-header flex w-full items-center gap-2 border-0 bg-transparent px-1 py-1 text-left text-dim hover:text-fg"
                  data-diff-group-files={JSON.stringify(
                    group.indices.map((index) => files[index].name),
                  )}
                  aria-expanded={!collapsed}
                  onClick={() =>
                    setCollapsedGroups((previous) => {
                      const next = new Set(previous);
                      if (next.has(groupKey)) next.delete(groupKey);
                      else next.add(groupKey);
                      return next;
                    })
                  }
                >
                  <IconChevronRight
                    size={16}
                    className={`diff-file-caret shrink-0 text-faint transition-transform duration-100 ${collapsed ? "" : "diff-file-caret-open rotate-90"}`}
                  />
                  <span className="diff-file-group-title text-control-label font-semibold">{group.title}</span>
                  <span className="diff-file-group-count text-meta text-faint">{group.indices.length}</span>
                  <span className="diff-file-group-stats ml-auto flex gap-2 font-mono text-meta">
                    {totals.add > 0 && <span className="diff-add font-semibold text-green">+{totals.add}</span>}
                    {totals.del > 0 && <span className="diff-del font-semibold text-red">−{totals.del}</span>}
                  </span>
                </button>
                {!collapsed && (
                  <div className="diff-file-group-files flex flex-col gap-2 border-l border-line pl-3">
                    {group.indices.map((index) => renderFile(files[index], index))}
                  </div>
                )}
              </section>
            );
          })
        : files.map(renderFile)}
      <div className="diff-comment-hint pb-2 text-center text-meta text-faint">
        {reviewMode
          ? "Click a line number (drag for a range) to add a comment. They stay pending until you finish the review."
          : "Click a line number (drag for a range) to comment."}
      </div>
    </div>
  );
}

/**
 * A changed image, rendered as the actual pictures: before/after side by side
 * for a modification, a single picture for added/deleted files. Sides that
 * fail to load (e.g. an untracked file not in the base) hide themselves.
 */
function ImageDiffRow({
  file,
  srcs,
}: {
  file: FileDiffMetadata;
  srcs: DiffImageSrcs | null;
}) {
  const [oldErr, setOldErr] = useState(false);
  const [newErr, setNewErr] = useState(false);
  const showOld = !!srcs?.oldSrc && file.type !== "new" && !oldErr;
  const showNew = !!srcs?.newSrc && file.type !== "deleted" && !newErr;
  if (!showOld && !showNew)
    return <div className="diff-image-empty p-3 text-label text-dim">Image not available to preview</div>;
  return (
    <div className="diff-image-row flex flex-wrap gap-3 p-3">
      {showOld && (
        <figure className="diff-image-cell diff-image-old m-0 min-w-0 max-w-full flex-[0_1_auto]">
          <img className="block max-h-[360px] max-w-full rounded-sm border border-line bg-[repeating-conic-gradient(rgba(128,128,128,0.18)_0%_25%,transparent_0%_50%)_0_0/16px_16px] opacity-80" src={srcs!.oldSrc} alt="" loading="lazy" onError={() => setOldErr(true)} />
          <figcaption className="mt-1 text-meta text-dim before:mr-1 before:text-red before:content-['−']">{file.type === "deleted" ? "Deleted" : "Before"}</figcaption>
        </figure>
      )}
      {showNew && (
        <figure className="diff-image-cell diff-image-new m-0 min-w-0 max-w-full flex-[0_1_auto]">
          <img className="block max-h-[360px] max-w-full rounded-sm border border-line bg-[repeating-conic-gradient(rgba(128,128,128,0.18)_0%_25%,transparent_0%_50%)_0_0/16px_16px]" src={srcs!.newSrc} alt="" loading="lazy" onError={() => setNewErr(true)} />
          <figcaption className="mt-1 text-meta text-dim before:mr-1 before:text-green before:content-['+']">{file.type === "new" ? "Added" : "After"}</figcaption>
        </figure>
      )}
    </div>
  );
}

/**
 * Inline comment form with its OWN text/sending/error state, so keystrokes
 * re-render just this form — not the parent diff. Seeds from `textRef` (which
 * the parent keeps) so text survives the form remounting on range changes.
 */
const CommentForm = React.memo(function CommentForm({
  targetLabel,
  disabled,
  disabledHint,
  placeholder,
  submitLabel,
  textRef,
  onCancel,
  onSubmit,
}: {
  targetLabel: string;
  disabled?: boolean;
  disabledHint?: string;
  placeholder: string;
  submitLabel: string;
  textRef: React.MutableRefObject<string>;
  onCancel: () => void;
  onSubmit: (body: string) => Promise<void>;
}) {
  const [text, setText] = useState(textRef.current);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSubmit(body);
      // Success unmounts this form (parent clears the draft) — don't touch state.
    } catch (e: any) {
      setError(e.message || "Failed to submit");
      setSending(false);
    }
  }

  return (
    <div className="diff-comment-form m-2 flex flex-col gap-2 rounded-md border border-accent bg-panel p-2.5 font-sans" onClick={(e) => e.stopPropagation()}>
      <div className="diff-comment-target font-mono text-meta text-faint">{targetLabel}</div>
      {disabled ? (
        <div className="diff-comment-disabled text-supporting text-faint">{disabledHint || "Unavailable right now"}</div>
      ) : (
        <>
          <textarea
            className="diff-comment-input resize-y rounded-sm border border-line-strong bg-raised px-2.5 py-2 text-control-label leading-[1.45] text-fg outline-none focus:border-accent"
            autoFocus
            rows={3}
            placeholder={placeholder}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              textRef.current = e.target.value;
            }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
          />
          {error && <div className="diff-comment-error text-label text-red">{error}</div>}
          <div className="diff-comment-actions flex justify-end gap-2">
            <Button
              variant="default"
              size="sm"
              className="min-h-0 border-line-strong bg-transparent px-3 py-[5px] text-control-label font-normal shadow-none"
              onClick={onCancel}
              disabled={sending}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              className="min-h-0 px-[14px] py-[6px] text-supporting font-medium shadow-none"
              onClick={submit}
              disabled={sending || !text.trim()}
            >
              {sending ? "Sending…" : submitLabel}
            </Button>
          </div>
        </>
      )}
    </div>
  );
});

/**
 * One file's diff. Memoized so an unrelated re-render (another file's selection,
 * typing in the comment form) doesn't re-parse/re-render this file.
 */
const FileDiffRow = React.memo(function FileDiffRow({
  file,
  fileIndex,
  theme,
  diffStyle,
  annotations,
  selectedLines,
  onSelect,
  renderAnnotation,
  editing,
  createEditor,
  loadDiffFiles,
}: {
  file: FileDiffMetadata;
  fileIndex: number;
  theme: "light" | "dark";
  diffStyle: "unified" | "split";
  annotations: DiffLineAnnotation<Meta>[];
  selectedLines: SelectedLineRange | null;
  onSelect: (fileIndex: number, path: string, range: SelectedLineRange | null) => void;
  renderAnnotation: (annotation: DiffLineAnnotation<Meta>) => React.ReactNode;
  editing?: boolean;
  createEditor?: (options: EditorOptions<Meta>) => DiffsEditor<Meta>;
  loadDiffFiles?: (fd: FileDiffMetadata) => Promise<FileDiffLoadedFiles>;
}) {
  const options = useMemo(
    () => ({
      ...BASE_OPTIONS,
      diffStyle,
      theme: theme === "light" ? "pierre-light" : "pierre-dark",
      themeType: theme,
      // Line selection drives commenting; while editing, clicks place the
      // caret instead.
      enableLineSelection: !editing,
      ...(loadDiffFiles ? { loadDiffFiles } : {}),
      onLineSelected: (range: SelectedLineRange | null) => onSelect(fileIndex, file.name, range),
    }),
    [diffStyle, fileIndex, file.name, onSelect, theme, editing, loadDiffFiles],
  );

  const fileDiff = (
    <FileDiff<Meta>
      fileDiff={file}
      options={options}
      edit={editing}
      lineAnnotations={annotations}
      selectedLines={selectedLines}
      renderAnnotation={renderAnnotation}
      disableWorkerPool
    />
  );

  // The provider only matters while editing; keeping the read-only tree
  // identical to before avoids any behavior drift on non-editable surfaces.
  return editing && createEditor ? (
    <EditProvider<Meta> createEditor={createEditor}>{fileDiff}</EditProvider>
  ) : (
    fileDiff
  );
});
