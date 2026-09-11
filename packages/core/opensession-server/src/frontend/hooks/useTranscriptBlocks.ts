import { useEffect, type MouseEvent, type RefObject } from "react";
import {
  CHOICES_BLOCK_CLASS,
  openChoiceEntryIds,
  quietChoicesBlock,
  setOpenChoiceEntries,
} from "../lib/choices-block";
import { matchTreePath, setOpenableTreePaths } from "../lib/tree-block";
import type { RepoDiff, TranscriptEntry } from "../lib/types";
import { useSessionDiffResource } from "./useApiResources";

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
  diffRepos,
  sendQuickReply,
  openChangedFile,
}: {
  sessionId: string;
  messagesRef: RefObject<HTMLDivElement | null>;
  entries: TranscriptEntry[];
  /** The Changes pane's diff, when it is open and has loaded it. */
  diffRepos: RepoDiff[] | null;
  /** Send chip text as the next message, on the composer's own path. */
  sendQuickReply: (text: string) => void;
  /** Open one of the session's changed files in the Changes pane. */
  openChangedFile: (path: string) => void;
}) {
  // The pane only fetches its diff while it is open, and a tree row has to
  // know which files it can open before then. Same SWR key, so an open pane
  // and this share one request; a transcript with no tree asks for nothing.
  const hasTree = entries.some(
    (entry) => entry.type === "assistant" && entry.content.includes("```tree"),
  );
  const ownDiff = useSessionDiffResource(sessionId, {
    enabled: hasTree && !diffRepos,
  });
  const repos = diffRepos ?? ownDiff.data?.repos ?? [];
  const changedPaths = repos.flatMap((repo) =>
    repo.diff.files.map((file) => file.path),
  );
  const changedKey = changedPaths.join("\0");

  useEffect(() => {
    const root = messagesRef.current;
    if (root) setOpenChoiceEntries(root, openChoiceEntryIds(entries));
  }, [entries, messagesRef]);

  useEffect(() => {
    const root = messagesRef.current;
    if (root)
      setOpenableTreePaths(root, changedKey ? changedKey.split("\0") : []);
  }, [changedKey, messagesRef]);

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
      if (!openChoiceEntryIds(entries).has(eid)) {
        quietChoicesBlock(block);
        return true;
      }
      const text = chip.textContent?.trim();
      if (!text) return true;
      e.preventDefault();
      quietChoicesBlock(block);
      sendQuickReply(text);
      return true;
    }
    const row = target.closest("[data-tree-path]");
    if (row instanceof HTMLElement) {
      const path = matchTreePath(row.dataset.treePath ?? "", changedPaths);
      if (path) openChangedFile(path);
      return true;
    }
    return false;
  }

  return { handleClick };
}
