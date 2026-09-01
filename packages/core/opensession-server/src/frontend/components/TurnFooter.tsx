import React, { useEffect, useRef, useState } from "react";
import type { TranscriptEntry } from "../lib/types";
import { Menu } from "../ui/menu";
import { Popover } from "../ui/popover";
import { Tooltip } from "../ui/tooltip";
import { cn } from "../ui/cn";
import { CodeHighlight } from "./LazyCode";
import { TOOL_CODE_WELL } from "../lib/tool-classes";
import {
  IconArrowUpRight,
  IconCheck,
  IconClock,
  IconCopy,
  IconDotsHorizontal,
  IconSparkle,
} from "./icons";
import { useOpenAsset } from "../lib/open-asset";
import { formatDuration, fullTime } from "../lib/time";
import { friendlyModelSlug, routedModelParts } from "./ModelEffortSelect";
import { canonicalToolName, useToolPathRoots } from "./ToolCallBlock";
import { tidyPath, type PathRoot } from "../lib/tidy-path";
import { useIsPhone } from "../hooks/useIsPhone";
import { pointerCanHover } from "../lib/pointer";
import { ExtBadge } from "./lang-marks";

export interface TouchedFile {
  path: string;
  additions: number;
  deletions: number;
  /**
   * What the turn wrote there, as diff text: one entry per edit call, in call
   * order. Empty when the tool reported a path without its content (Bash,
   * codex FileChange), and the chip stays a plain label.
   */
  hunks: string[];
}

/**
 * The row sits 10px into the answer above it, closing the turn's own 18px
 * bottom margin to 8px: these actions belong to that answer, and a full row
 * gap read as the next block starting.
 *
 * It is a class the CALLER places rather than one the row wears. Transcript
 * blocks sit inside measured virtual rows, and a negative margin inside that
 * measurement does not move the row's own start. On the measured wrapper the
 * same class shifts the whole row and remains part of its virtual position.
 */
export const TURN_FOOTER_LIFT = "-mt-2.5";

interface Props {
  /** The turn's final answer entry — copy copies its markdown, fork forks from it. */
  entry: TranscriptEntry;
  durationMs: number;
  /** Where the caller puts the row. TURN_FOOTER_LIFT when nothing contains it. */
  className?: string;
  /** Files the turn's tool calls wrote, merged per path in first-touch order. */
  files: TouchedFile[];
  /** Scratch files the turn wrote (`opensession-assets`), in first-write order. */
  assets: string[];
  onFork?: (entryId: string) => void;
}

/**
 * Quiet answer actions plus produced assets, and which files the turn wrote.
 * Work duration and model stay one click away.
 *
 * Nothing here is hover-revealed. Which files a turn touched, and how long it
 * took, are the answer's result — read as often as the answer itself — and an
 * affordance you have to hover to find is one you have to already suspect is
 * there. The row is muted instead: faint ink under the answer, at a size that
 * reads past. The full file list, with paths rather than bare names, is in the
 * ⋯ menu, which is also where a narrow row's "+N more" resolves.
 */
export const TurnFooter = function TurnFooter({
  entry,
  durationMs,
  files,
  assets,
  onFork,
  className,
}: Props) {
  const pathRoots = useToolPathRoots();
  const isPhone = useIsPhone();
  const [copied, setCopied] = useState(false);
  const doCopy = () => {
    copyText(entry.content, () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const duration = formatDuration(durationMs);

  return (
    <div
      className={cn(
        "mx-auto mb-[18px] flex w-full max-w-[var(--session-col)] flex-wrap items-center gap-x-0.5 gap-y-1.5",
        className,
      )}
    >
      {duration && (
        <Tooltip label={fullTime(entry.timestamp)}>
          <span className="mr-1.5 pl-1 text-meta font-medium leading-4 text-faint">
            {duration}
          </span>
        </Tooltip>
      )}
      {assets.map((path) => (
        <AssetChip key={path} path={path} />
      ))}
      <div className={ACTIONS}>
        <Tooltip label={copied ? "Copied" : "Copy message"}>
          <button
            type="button"
            onClick={doCopy}
            className={BTN}
            aria-label={copied ? "Copied" : "Copy message"}
          >
            {copied ? (
              <IconCheck size={20} className="text-green" />
            ) : (
              <IconCopy size={20} />
            )}
          </button>
        </Tooltip>
        <Menu.Root>
          <Menu.Trigger
            className={
              BTN + " data-[popup-open]:bg-hover data-[popup-open]:text-dim"
            }
            aria-label="More message actions"
          >
            <IconDotsHorizontal size={20} />
          </Menu.Trigger>
          <Menu.Popup
            side="bottom"
            align="start"
            sideOffset={4}
            className="max-w-[380px]"
          >
            {onFork && (
              <Menu.Item onClick={() => onFork(entry.id)}>
                <IconCopy size={20} className="text-faint" />
                Duplicate from here
              </Menu.Item>
            )}
            {onFork && <Menu.Separator className="my-1" />}
            <div className="flex items-center gap-2 px-2.5 py-1.5 text-xs font-medium text-faint">
              <IconClock size={20} />
              {fullTime(entry.timestamp)}
            </div>
            {entry.model && (
              <div className="flex items-center gap-2 px-2.5 py-1.5 text-xs font-medium text-faint">
                <IconSparkle size={20} />
                Written by {messageModelLabel(entry.model)}
              </div>
            )}
            {/* The chips' non-hover home. Paths are tidied rather than cut to
                the filename: with room for the whole line, which of two
                same-named files a turn touched is worth more than the space. */}
            {files.length > 0 && (
              <>
                <Menu.Separator className="my-1" />
                {/* GroupLabel MUST live inside a Group — bare it throws Base UI
                    error #31 and white-screens the app on open. */}
                <Menu.Group>
                  <Menu.GroupLabel className="px-2.5 pt-0.5">
                    Changed files
                  </Menu.GroupLabel>
                  {files.slice(0, MAX_MENU_FILES).map((f) => (
                    <div
                      key={f.path}
                      className="flex items-center gap-2 px-2.5 py-1 text-xs font-medium text-faint"
                    >
                      <ExtBadge name={fileName(f.path)} />
                      <span className="min-w-0 flex-1 truncate text-dim">
                        {tidyPath(f.path, pathRoots)}
                      </span>
                      <LineStats
                        additions={f.additions}
                        deletions={f.deletions}
                      />
                    </div>
                  ))}
                  {files.length > MAX_MENU_FILES && (
                    <div className="px-2.5 py-1 text-xs font-medium text-faint">
                      +{files.length - MAX_MENU_FILES} more
                    </div>
                  )}
                </Menu.Group>
              </>
            )}
          </Menu.Popup>
        </Menu.Root>
      </div>
      <TouchedFileChips files={files} max={isPhone ? 1 : MAX_CHIPS} />
    </div>
  );
};

/**
 * The files a turn wrote, named with the ±lines each moved, and one count for
 * whatever is past `max`. Shared by this footer and the work fold's summary, so
 * a turn reports its files in the same shape wherever you read it.
 *
 * Chips keep their natural width and wrap with the row rather than sharing a
 * shrinking box: a chip spends ~60px on its ± counts before it spends any on
 * the name, so a row that seats them by shrinking crushes exactly the part
 * worth reading — at 390px both names went to nothing and left two bare
 * "TS +160" chips.
 */
export function TouchedFileChips({
  files,
  max,
}: {
  files: TouchedFile[];
  max: number;
}) {
  const pathRoots = useToolPathRoots();
  const shown = files.slice(0, max);
  const rest = files.slice(shown.length);
  return (
    <>
      {shown.map((f) => (
        <FileChip key={f.path} file={f} roots={pathRoots} />
      ))}
      {rest.length > 0 && <MoreChip files={rest} />}
    </>
  );
}

function turnFooterPropsEqual(prev: Props, next: Props): boolean {
  if (
    prev.entry !== next.entry ||
    prev.durationMs !== next.durationMs ||
    prev.onFork !== next.onFork ||
    prev.className !== next.className ||
    prev.assets.length !== next.assets.length ||
    prev.files.length !== next.files.length
  )
    return false;
  for (let i = 0; i < next.assets.length; i++)
    if (prev.assets[i] !== next.assets[i]) return false;
  for (let i = 0; i < next.files.length; i++) {
    const a = prev.files[i];
    const b = next.files[i];
    if (
      a.path !== b.path ||
      a.additions !== b.additions ||
      a.deletions !== b.deletions ||
      a.hunks.length !== b.hunks.length
    )
      return false;
  }
  return true;
}

const BTN =
  "flex size-6 flex-shrink-0 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 text-faint hover:bg-hover hover:text-dim";

/** The whole row is always on the page, and muted rather than hidden: an
 * action you can see is one you know exists, and `text-faint` on a transparent
 * button is quiet enough to read past. The colour is the only thing separating
 * it from the answer — hover and focus still bring both up. */
const ACTIONS = "flex items-center gap-0.5";

/** Named files in the row; the rest collapse into MoreChip. A phone seats one;
 * the ⋯ menu is the complete list either way. */
const MAX_CHIPS = 2;

/** The menu has room to name more of them, being a list rather than a row. */
const MAX_MENU_FILES = 10;

function fileName(path: string): string {
  return path.split("/").pop() || path;
}

/** Friendly name for a per-message model id: pi ids take their model
 * part, raw API ids drop the date suffix — "pi/anthropic/claude-sonnet-5"
 * and "claude-sonnet-5-20250929" both read "Sonnet 5". */
function messageModelLabel(id: string): string {
  const slug = routedModelParts(id)?.model || id;
  return friendlyModelSlug(slug.replace(/-\d{8}$/, ""));
}

/** Shared line box for asset names and the expanded work summary's stats. */
const FOOTER_TEXT = "text-label font-medium leading-4";

/**
 * One scratch file the turn wrote. Clicking lifts it over the conversation;
 * the overlay can promote it into the Assets tab when it needs to stay open.
 * The write_asset row's own Open chip takes the same route, so the two ways
 * into one file don't disagree.
 *
 * Unlike a touched file there is no diff to preview: an asset lives outside
 * every worktree, and the file itself is the thing worth looking at. Where
 * nothing can open it (the Desk overlay, a sub-agent pane) the chip stays, but
 * as a plain label — a name is still worth reading; a dead button isn't.
 */
function AssetChip({ path }: { path: string }) {
  const name = path.split("/").pop() || path;
  const asset = useOpenAsset();
  const body = (
    <>
      <ExtBadge name={name} />
      <span className={cn("max-w-[180px] truncate text-dim", FOOTER_TEXT)}>
        {name}
      </span>
      <IconArrowUpRight size={20} className="size-4 flex-shrink-0 text-faint" />
    </>
  );
  if (!asset.available) return <span className={cn(CHIP, "pr-1")}>{body}</span>;
  return (
    <Tooltip label="Open this file">
      <button
        type="button"
        onClick={() => asset.open(path)}
        className={cn(CHIP, "cursor-pointer pr-1 hover:bg-hover")}
      >
        {body}
      </button>
    </Tooltip>
  );
}

/** The shared chip shell: the footer's file and asset chips are the same
 * object with different tails (± counts, or a way in). */
const CHIP =
  "ml-1 flex h-6 min-w-0 items-center gap-1.5 overflow-hidden rounded-control border-0 bg-fg/[0.03] py-0 pl-1 text-left";

/**
 * One file the turn wrote, with the ±lines it moved there, and on click the
 * lines themselves.
 *
 * The chip opens what THIS TURN wrote, read back out of the tool inputs the ±
 * counts already come from, so the popup is those counts spelled out rather
 * than a second answer that could disagree with them. Hover opens it after a
 * beat, since reading a diff is the whole reason to notice the chip; the
 * trigger stays a real button, so a tap opens it on touch. The Changes tab stays
 * the place for the file's current diff: it reads the real worktree, which by
 * now holds every later turn's edits too. The path the name was cut from
 * heads the popup, so the chip needs no tooltip fighting it.
 *
 * A file whose tool only reported a path carries no hunks; that chip stays the
 * label it was, with the path on a tooltip.
 */
function FileChip({
  file,
  roots,
}: {
  file: TouchedFile;
  roots: readonly PathRoot[];
}) {
  const name = fileName(file.path);
  const path = tidyPath(file.path, roots);
  const diff = turnDiff(file);
  const body = (
    <>
      <ExtBadge name={name} />
      <span className={cn("max-w-[180px] truncate text-dim", FOOTER_TEXT)}>
        {name}
      </span>
      <LineStats additions={file.additions} deletions={file.deletions} />
    </>
  );
  if (!diff)
    return (
      <Tooltip label={path}>
        <span className={cn(CHIP, "pr-1.5")}>{body}</span>
      </Tooltip>
    );
  return (
    <Popover.Root>
      <Popover.Trigger
        openOnHover
        delay={300}
        closeDelay={120}
        className={cn(
          CHIP,
          "cursor-pointer pr-1.5 hover:bg-hover data-[popup-open]:bg-hover",
        )}
        aria-label={`Show what this turn wrote to ${name}`}
      >
        {body}
      </Popover.Trigger>
      <Popover.Popup
        side="top"
        align="start"
        elevation="lg"
        className={DIFF_CARD}
      >
        <FileDiffCard file={file} roots={roots} />
      </Popover.Popup>
    </Popover.Root>
  );
}

/** The lines one turn wrote to one file. A blank line between calls: four
 * passes over one file are four hunks, and run together they read as one edit
 * that contradicts itself. */
function turnDiff(file: TouchedFile): string {
  return file.hunks.filter(Boolean).join("\n\n");
}

/** Wide enough for real code, still a card. Shared, so the file chip and the
 * fold header's counts open the same object rather than two sizes of it. */
const DIFF_CARD = "w-[min(620px,calc(100vw-24px))] p-2";

/** One file inside a diff card: its path over what the turn wrote there. A
 * file whose tool only reported a path keeps the heading and drops the well. */
function FileDiffCard({
  file,
  roots,
}: {
  file: TouchedFile;
  roots: readonly PathRoot[];
}) {
  const name = fileName(file.path);
  const path = tidyPath(file.path, roots);
  const diff = turnDiff(file);
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 px-1">
        <ExtBadge name={name} />
        <span
          className={cn("min-w-0 flex-1 truncate text-dim", FOOTER_TEXT)}
          title={path}
        >
          {path}
        </span>
        <LineStats additions={file.additions} deletions={file.deletions} />
      </div>
      {diff && (
        <div className={TOOL_CODE_WELL}>
          <CodeHighlight code={diff} lang="diff" />
        </div>
      )}
    </div>
  );
}

/** Dwell before the fold header's counts raise their card, and the grace to
 * cross into it. The same beat as a file chip's. */
const CARD_OPEN_MS = 300;
const CARD_CLOSE_MS = 120;

/** Files the card spells out before the rest become one line. */
const MAX_CARD_FILES = 4;

/**
 * A turn's ±lines, and on hover the lines themselves — every file the turn
 * wrote, each under its own path, in the card a single file chip opens.
 *
 * Folded, these counts are all a turn says about what it changed, so this is
 * where reading them without unfolding belongs. The header is a button (it
 * toggles the fold), so the card can't hang off a Popover.Trigger nested in
 * it; it drives a controlled popup off the counts' own box instead, the way
 * the transcript's chip cards do. Hover only, for the same reason those are:
 * a tap belongs to the fold, and the fold names the same files as chips.
 */
export function TurnLineStatsCard({
  files,
  additions: additionsProp,
  deletions: deletionsProp,
}: {
  files: TouchedFile[];
  additions?: number;
  deletions?: number;
}) {
  const additions =
    additionsProp ?? files.reduce((n, file) => n + file.additions, 0);
  const deletions =
    deletionsProp ?? files.reduce((n, file) => n + file.deletions, 0);
  const roots = useToolPathRoots();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const shown = files
    .filter((f) => f.hunks.some(Boolean))
    .slice(0, MAX_CARD_FILES);
  const rest = files.length - shown.length;

  const hold = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const schedule = (next: boolean, ms: number) => {
    hold();
    timer.current = setTimeout(() => setOpen(next), ms);
  };
  const close = () => {
    hold();
    setOpen(false);
  };
  useEffect(() => hold, []);

  const stats = <LineStats additions={additions} deletions={deletions} />;
  // Nothing to spell out: every file came from a tool that reported a path and
  // no content, so the counts stay the plain label they were.
  if (shown.length === 0) return stats;
  return (
    <>
      <span
        ref={anchor}
        className="flex flex-shrink-0 items-center"
        onMouseEnter={() => {
          if (pointerCanHover()) schedule(true, CARD_OPEN_MS);
        }}
        onMouseLeave={() => schedule(false, CARD_CLOSE_MS)}
        // The press under it is the fold opening, which puts the same files on
        // the page as chips; a card left over them is in the way.
        onPointerDown={close}
      >
        {stats}
      </span>
      <Popover.Root
        open={open}
        onOpenChange={(next) => {
          if (!next) close();
        }}
      >
        {open && (
          <Popover.Popup
            side="bottom"
            align="start"
            elevation="lg"
            anchor={anchor}
            className={DIFF_CARD}
          >
            <div
              className="flex max-h-[min(60vh,420px)] flex-col gap-2 overflow-y-auto"
              onMouseEnter={hold}
              onMouseLeave={() => schedule(false, CARD_CLOSE_MS)}
            >
              {shown.map((f) => (
                <FileDiffCard key={f.path} file={f} roots={roots} />
              ))}
              {rest > 0 && (
                <div className={cn("px-1 text-faint", FOOTER_TEXT)}>
                  +{rest} more {rest === 1 ? "file" : "files"}
                </div>
              )}
            </div>
          </Popover.Popup>
        )}
      </Popover.Root>
    </>
  );
}

/** Everything past the row's chip budget, as one count plus its own totals. */
function MoreChip({ files }: { files: TouchedFile[] }) {
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  return (
    <Tooltip
      label={
        files
          .slice(0, 12)
          .map((f) => fileName(f.path))
          .join(", ") + (files.length > 12 ? ", …" : "")
      }
    >
      <span className="ml-1 flex h-6 flex-shrink-0 items-center gap-1.5 rounded-md px-1.5">
        <span className={cn("text-faint", FOOTER_TEXT)}>
          +{files.length} more
        </span>
        <LineStats additions={additions} deletions={deletions} />
      </span>
    </Tooltip>
  );
}

export function LineStats({
  additions,
  deletions,
  className,
}: {
  additions: number;
  deletions: number;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "flex flex-shrink-0 items-center gap-1 text-label font-medium leading-4",
        className,
      )}
    >
      <span className="text-green">+{additions}</span>
      <span className="text-red">-{deletions}</span>
    </span>
  );
}

// Keyed on the entry object, which mergeTranscriptEntries replaces rather than
// mutates when an entry changes, so a hit can never be stale. Worth caching
// because the work is repeated rather than one-off: a streaming transcript
// re-collects every settled turn's files on each frame, and the diff text
// below is built from whole files a Write wrote. mergeTouchedFiles copies
// before it merges, so no caller writes through to a cached row.
const touchedFilesByEntry = new WeakMap<TranscriptEntry, TouchedFile[]>();

/**
 * Per-file line stats from one edit-family tool call, or null for tools that
 * don't write files. Line counts come from the tool inputs (old/new string
 * sizes), so they're the same "±N" a diff would show for those hunks — minus
 * tools that only report paths, such as Bash and Codex FileChange.
 */
export function touchedFilesFromTool(entry: TranscriptEntry): TouchedFile[] {
  const hit = touchedFilesByEntry.get(entry);
  if (hit) return hit;
  const files = readTouchedFiles(entry);
  touchedFilesByEntry.set(entry, files);
  return files;
}

function readTouchedFiles(entry: TranscriptEntry): TouchedFile[] {
  const input = entry.toolInput;
  if (!input || typeof input !== "object") return [];
  const inp = input as Record<string, unknown>;
  // Counting separators rather than splitting: same number, no array per call.
  const lines = (v: unknown) => {
    if (typeof v !== "string" || v.length === 0) return 0;
    let count = 1;
    for (let at = v.indexOf("\n"); at >= 0; at = v.indexOf("\n", at + 1))
      count++;
    return count;
  };
  // Engines disagree on casing: pi writes `filePath`/`oldString`, the
  // Claude SDK `file_path`/`old_string`.
  const key = (...names: string[]) => {
    for (const n of names)
      if (typeof inp[n] === "string" && inp[n]) return inp[n] as string;
    return "";
  };
  const filePath = key("file_path", "filePath");
  switch (canonicalToolName(entry.toolName)) {
    case "Edit": {
      // MultiEdit: several hunks against one file.
      if (filePath && Array.isArray(inp.edits)) {
        let additions = 0;
        let deletions = 0;
        const hunks: string[] = [];
        for (const e of inp.edits) {
          if (!e || typeof e !== "object") continue;
          const ee = e as Record<string, unknown>;
          const oldStr = str(ee.old_string ?? ee.oldString);
          const newStr = str(ee.new_string ?? ee.newString);
          additions += lines(newStr);
          deletions += lines(oldStr);
          hunks.push(replaceHunk(oldStr, newStr));
        }
        return [{ path: filePath, additions, deletions, hunks }];
      }
      if (filePath) {
        const oldStr = key("old_string", "oldString");
        const newStr = key("new_string", "newString");
        return [
          {
            path: filePath,
            additions: lines(newStr),
            deletions: lines(oldStr),
            hunks: [replaceHunk(oldStr, newStr)],
          },
        ];
      }
      // codex's apply_patch names its files inside the patch body.
      return mergeTouchedFiles(patchTouchedFiles(key("patchText", "patch")));
    }
    case "Write":
      if (!filePath) return [];
      return [
        {
          path: filePath,
          additions: lines(inp.content),
          deletions: 0,
          hunks: [addedHunk(str(inp.content))],
        },
      ];
    case "NotebookEdit":
      if (typeof inp.notebook_path !== "string") return [];
      return [
        {
          path: inp.notebook_path,
          additions: lines(inp.new_source),
          deletions: 0,
          hunks: [addedHunk(str(inp.new_source))],
        },
      ];
    case "FileChange": {
      if (!Array.isArray(inp.changes)) return [];
      const files: TouchedFile[] = [];
      for (const change of inp.changes) {
        const path = fileChangePath(change);
        if (!path) continue;
        files.push({ path, additions: 0, deletions: 0, hunks: [] });
      }
      return mergeTouchedFiles(files);
    }
    default:
      return [];
  }
}

/** All files a turn's tool calls edited, merged per path in first-touch order. */
export function collectTouchedFiles(items: TranscriptEntry[]): TouchedFile[] {
  return mergeTouchedFiles(
    items.flatMap((it) => {
      if (it.type !== "tool_use") return [];
      return touchedFilesFromTool(it);
    }),
  );
}

// The merged list for a whole turn, on top of the per-entry cache above.
// TranscriptBlocks rebuilds its blocks in render, so every streamed frame
// re-merges every settled turn: the per-entry cache spares the diff text, but
// mergeTouchedFiles still copies a row and its hunks array per touched file,
// for each turn in the transcript. This hands back the same array instead, so
// a turn nothing has happened in costs nothing.
//
// Keyed on the turn's last entry rather than the array, which the caller
// builds fresh each time. Entries are replaced rather than mutated when they
// change (mergeTranscriptEntries), so the members are compared by identity on
// a hit: a tool call earlier in the turn can be replaced while the last entry
// stands, and the merged list would then be stale.
const touchedFilesByTurn = new WeakMap<
  TranscriptEntry,
  { items: TranscriptEntry[]; files: TouchedFile[] }
>();
const NO_TOUCHED_FILES: TouchedFile[] = [];

/** collectTouchedFiles, holding one array identity while the turn is unchanged. */
export function turnTouchedFiles(items: TranscriptEntry[]): TouchedFile[] {
  const key = items[items.length - 1];
  if (!key) return NO_TOUCHED_FILES;
  const hit = touchedFilesByTurn.get(key);
  if (hit && sameEntries(hit.items, items)) return hit.files;
  const files = collectTouchedFiles(items);
  touchedFilesByTurn.set(key, { items: items.slice(), files });
  return files;
}

function sameEntries(a: TranscriptEntry[], b: TranscriptEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Files (and ± line counts) from a codex-style patch body: "*** Update File:
 * src/x.ts" headers followed by +/- lines, as apply_patch sends them.
 */
function patchTouchedFiles(patch: string): TouchedFile[] {
  if (!patch) return [];
  const files: TouchedFile[] = [];
  let current: TouchedFile | null = null;
  // The patch body is already a diff, so each file's section is its own hunk:
  // kept verbatim, minus the "*** … File:" headers the chip's name replaces.
  let body: string[] = [];
  const closeSection = () => {
    if (current) current.hunks = body.length > 0 ? [body.join("\n")] : [];
    body = [];
  };
  for (const line of patch.split("\n")) {
    const header = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/);
    if (header) {
      closeSection();
      current = {
        path: header[1].trim(),
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      files.push(current);
      continue;
    }
    if (!current || line.startsWith("***")) continue;
    body.push(line);
    if (line.startsWith("+")) current.additions++;
    else if (line.startsWith("-")) current.deletions++;
  }
  closeSection();
  return files;
}

function mergeTouchedFiles(files: TouchedFile[]): TouchedFile[] {
  const byPath = new Map<string, TouchedFile>();
  for (const f of files) {
    const prev = byPath.get(f.path);
    if (prev) {
      prev.additions += f.additions;
      prev.deletions += f.deletions;
      prev.hunks.push(...f.hunks);
    } else {
      // Copy the hunks too: merging appends into this array, and the caller's
      // is the one a later turn would read.
      byPath.set(f.path, { ...f, hunks: [...f.hunks] });
    }
  }
  return [...byPath.values()];
}

/** A replacement as diff text: the old lines cut, the new ones added. Same
 *  shape the tool row renders for a single edit, so a chip and the call it
 *  came from show one file the same way. */
function replaceHunk(oldStr: string, newStr: string): string {
  return [
    ...(oldStr ? oldStr.split("\n").map((l) => `-${l}`) : []),
    ...(newStr ? newStr.split("\n").map((l) => `+${l}`) : []),
  ].join("\n");
}

/** A whole written file as diff text: every line is new. */
function addedHunk(text: string): string {
  if (!text) return "";
  return text
    .split("\n")
    .map((l) => `+${l}`)
    .join("\n");
}

/** Reads a possibly-absent tool input value as a string. */
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function fileChangePath(change: unknown): string | null {
  if (typeof change === "string") {
    const m = change.match(/^(?:add|delete|update)\s+(.+)$/);
    return (m?.[1] || change).trim() || null;
  }
  if (!change || typeof change !== "object") return null;
  const path = (change as Record<string, unknown>).path;
  return typeof path === "string" && path.trim() ? path : null;
}

// navigator.clipboard needs a secure context — opensession is served over plain
// http on the tailnet, so fall back to a hidden-textarea copy.
function copyText(text: string, onDone: () => void) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard
      .writeText(text)
      .then(onDone, () => fallbackCopy(text, onDone));
  } else {
    fallbackCopy(text, onDone);
  }
}

function fallbackCopy(text: string, onDone: () => void) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
    onDone();
  } catch {
    // nothing else to fall back to
  } finally {
    ta.remove();
  }
}
