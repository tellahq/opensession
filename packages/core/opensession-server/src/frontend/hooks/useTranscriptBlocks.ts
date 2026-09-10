import { useEffect, useMemo, type MouseEvent, type RefObject } from "react";
import { useSessionDiff } from "../components/DiffPanel";
import {
  CHOICES_BLOCK_CLASS,
  openChoiceEntryIds,
  quietChoicesBlock,
  refreshChoicesBlock,
  setOpenChoiceEntries,
} from "../lib/choices-block";
import {
  matchTreePath,
  setOpenableTreePaths,
  type ChangedFile,
} from "../lib/tree-block";
import type { RepoDiff, TranscriptEntry } from "../lib/types";

const NO_ENTRIES: ReadonlySet<string> = new Set();

/**
 * The session viewer's side of the blocks a markdown body builds as plain
 * DOM (lib/choices-block.ts, lib/tree-block.ts). Those blocks cannot reach
 * React, so, like `[data-asset-path]`, they carry a data attribute and the
 * viewer's delegated click handler acts on it. This hook also keeps the
 * blocks told what only the viewer knows: which entries still take a quick
 * reply, and which files the Changes pane can show.
 */
export function useTranscriptBlocks({
  sessionId,
  messagesRef,
  entries,
  isRunning,
  canReply,
  diffRepos,
  sendQuickReply,
  openChangedFile,
}: {
  sessionId: string;
  messagesRef: RefObject<HTMLDivElement | null>;
  entries: TranscriptEntry[];
  isRunning: boolean;
  /** False when nothing can take a message, e.g. a session with no engine. */
  canReply: boolean;
  /** The Changes pane's diff, when it is open and has loaded it. */
  diffRepos: RepoDiff[] | null;
  /** Send chip text as the next message, on the composer's own path;
   *  resolves false when nothing was sent. */
  sendQuickReply: (text: string) => boolean | Promise<boolean>;
  /** Open one of the session's changed files in the Changes pane. */
  openChangedFile: (file: ChangedFile) => void;
}) {
  // The pane only fetches its diff while it is open, and a tree row has to
  // know which files it can open before then. Same SWR key and the same
  // poll as the pane, so an open pane and this share one request and a
  // file edited after the tree was written becomes openable as the run goes
  // on; the run ending revalidates once more. A transcript with no tree
  // asks for nothing.
  const hasTree = entries.some(
    (entry) => entry.type === "assistant" && entry.content.includes("```tree"),
  );
  const ownDiff = useSessionDiff(sessionId, {
    enabled: hasTree && !diffRepos,
    isRunning,
    revision: isRunning ? "running" : "idle",
  });
  const repos = diffRepos ?? ownDiff.repos ?? [];
  const changedKey = repos
    .flatMap((repo) =>
      repo.diff.files.map((file) => `${repo.repo}\0${file.path}`),
    )
    .join("\n");
  const changedFiles = useMemo<ChangedFile[]>(
    () =>
      changedKey
        ? changedKey.split("\n").map((line) => {
            const [repo = "", path = ""] = line.split("\0");
            return { repo, path };
          })
        : [],
    [changedKey],
  );

  useEffect(() => {
    const root = messagesRef.current;
    if (root)
      setOpenChoiceEntries(
        root,
        canReply ? openChoiceEntryIds(entries) : NO_ENTRIES,
      );
  }, [entries, canReply, messagesRef]);

  useEffect(() => {
    const root = messagesRef.current;
    if (root) setOpenableTreePaths(root, changedFiles);
  }, [changedFiles, messagesRef]);

  /** True when the click was a block's and has been handled. */
  function handleClick(e: MouseEvent): boolean {
    const target = e.target;
    if (!(target instanceof Element)) return false;
    const chip = target.closest("[data-choice]");
    if (chip instanceof HTMLButtonElement) {
      const block = chip.closest(`.${CHOICES_BLOCK_CLASS}`);
      if (!block || block.hasAttribute("data-quiet")) return true;
      // The DOM's answer is refreshed from the transcript, but a chip can be
      // pressed between a new user message landing and that refresh; the
      // transcript itself is what decides.
      const eid = block.getAttribute("data-choices-eid") ?? "";
      if (!canReply || !openChoiceEntryIds(entries).has(eid)) {
        quietChoicesBlock(block);
        return true;
      }
      const text = chip.textContent?.trim();
      if (!text) return true;
      e.preventDefault();
      // Quiet at once so a second press cannot send twice; a send that
      // fails (a full outbox, a storage error) sends no user message to
      // refresh the block, so put it back by hand.
      quietChoicesBlock(block);
      void Promise.resolve(sendQuickReply(text)).then(
        (sent) => {
          if (!sent) refreshChoicesBlock(block);
        },
        () => refreshChoicesBlock(block),
      );
      return true;
    }
    const row = target.closest("[data-tree-path]");
    if (row instanceof HTMLElement) {
      const file = matchTreePath(row.dataset.treePath ?? "", changedFiles);
      if (file) openChangedFile(file);
      return true;
    }
    return false;
  }

  return { handleClick };
}
