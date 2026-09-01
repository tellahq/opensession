import type { FileDiffMetadata } from "@pierre/diffs";
import type { PrReviewThread } from "./api/prs";
import type { DiffFileGroup } from "./types";

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

export interface CommentableDiffOptions {
  submitLabel: string;
  placeholder: string;
  disabled?: boolean;
  disabledHint?: string;
  /** Expand this many leading files on first render. */
  defaultExpandedFiles?: number;
  /** Omit the global expander when mounting every file would exhaust the tab. */
  allowExpandAll?: boolean;
  /** Move the global file controls into a parent toolbar. Omit to keep them inline. */
  controlsTarget?: Element | null;
  /** Show the aggregate viewed-file count beside the global controls. */
  showViewedProgress?: boolean;
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
  /** Hide grouping status when the host presents it elsewhere. */
  showGroupsStatus?: boolean;
  /** PR review canvases use GitHub's side-by-side presentation; workspace diffs stay unified. */
  diffStyle?: "unified" | "split";
  /** Soft-wrap long lines instead of scrolling each file horizontally. */
  wrapLines?: boolean;
  /** Highlight the changed words within added and removed lines. */
  structuralHighlighting?: boolean;
  /** Show per-file addition and deletion totals in file and group headers. */
  showFileStats?: boolean;
  /** Follow the app theme, or pin the code surface light or dark. */
  codeTheme?: "system" | "light" | "dark";
  /** Optional review-canvas ordering, with paths absent from the list hidden. */
  visibleFileOrder?: readonly string[];
  /** Review-only file actions supplied by the PR host. */
  fileActions?: {
    providerName: string;
    url: (file: FileDiffMetadata) => string | null;
    loadContents?: (file: FileDiffMetadata) => Promise<string | null>;
  };
  /** Keep each filename visible while its expanded file scrolls through a review canvas. */
  stickyFileHeaders?: boolean;
  /**
   * Review-batching mode: when provided, already-added comments render inline as
   * pending cards (the parent owns the list and submits them as one review).
   * Without it the component stays single-shot (e.g. session feedback).
   */
  pendingComments?: PendingComment[];
  onRemovePending?: (id: string) => void;
  /** Provider-native resolved conversations, grouped beneath their file and
   * collapsed until the reader opens one. */
  reviewThreads?: PrReviewThread[];
  /** Repository context for qualified links inside review comments. */
  commentRepo?: string;
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
    load: (
      file: FileDiffMetadata,
      side: "new" | "base",
    ) => Promise<string | null>;
    save: (path: string, content: string) => Promise<void>;
  };
}
