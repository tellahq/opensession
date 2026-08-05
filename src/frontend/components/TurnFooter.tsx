import React, { useState, Suspense, lazy } from "react";
import type { TranscriptEntry } from "../lib/types";
import { Menu } from "../ui/menu";
import { Tooltip } from "../ui/tooltip";
import { Popover } from "../ui/popover";
import { cn } from "../ui/cn";
import {
  IconBranches,
  IconCheck,
  IconClock,
  IconCopy,
  IconDotsHorizontal,
  IconSparkle,
} from "./icons";
import { fullTime } from "../lib/time";
import { friendlyModelSlug, opencodeModelParts } from "./ModelEffortSelect";
import { canonicalToolName } from "./ToolCallBlock";
import { LANG_MARKS } from "./lang-marks";

/** One change a tool made to a file: old text removed, new text added.
 * Writes have old: "" (the whole content is an addition). */
export interface FileEdit {
  old: string;
  new: string;
}

export interface TouchedFile {
  path: string;
  additions: number;
  deletions: number;
  edits: FileEdit[];
}

// Same lazy split as ToolCallBlock: Shiki is multi-MB, load it only when a
// diff preview actually opens. Until then the diff shows as a plain pre.
const CodeHighlightLazy = lazy(() =>
  import("./CodeHighlight").then((m) => ({ default: m.CodeHighlight }))
);

interface Props {
  /** The turn's final answer entry — copy copies its markdown, fork forks from it. */
  entry: TranscriptEntry;
  durationMs: number;
  files: TouchedFile[];
  onFork?: (entryId: string) => void;
}

/**
 * Conductor-style meta row under a turn's final answer: how long the turn
 * took, copy / more-options actions, and one chip per file the turn edited
 * with its ±line counts. Always visible (no hover reveal — hover-only
 * affordances are unreachable on iOS).
 */
export const TurnFooter = React.memo(function TurnFooter({
  entry,
  durationMs,
  files,
  onFork,
}: Props) {
  const [copied, setCopied] = useState(false);
  const doCopy = () => {
    copyText(entry.content, () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const duration = formatDuration(durationMs);
  const shown = files.slice(0, MAX_CHIPS);
  const rest = files.slice(MAX_CHIPS);

  return (
    <div className="mx-auto -mt-2.5 mb-[18px] flex w-full max-w-[var(--chat-col)] flex-wrap items-center gap-x-0.5 gap-y-1.5">
      {duration && (
        <span className={cn("mr-1.5 text-faint", FOOTER_TEXT)}>{duration}</span>
      )}
      <Tooltip label={copied ? "Copied" : "Copy message"}>
        <button type="button" onClick={doCopy} className={BTN}>
          {copied ? (
            <IconCheck size={20} className="text-green" />
          ) : (
            <IconCopy size={20} />
          )}
        </button>
      </Tooltip>
      <Menu.Root>
        <Menu.Trigger className={BTN + " data-[popup-open]:bg-hover data-[popup-open]:text-dim"}>
          <IconDotsHorizontal size={20} />
        </Menu.Trigger>
        <Menu.Popup side="bottom" align="start" sideOffset={4}>
          {onFork && (
            <Menu.Item onClick={() => onFork(entry.id)}>
              <IconBranches size={20} className="text-faint" />
              Fork from here
            </Menu.Item>
          )}
          <Menu.Item onClick={doCopy}>
            <IconCopy size={20} className="text-faint" />
            Copy message
          </Menu.Item>
          <Menu.Separator className="my-1" />
          {/* Touch has no hover, so the time also lives here — menus open on tap. */}
		  <div className="flex items-center gap-2 px-2.5 py-1.5 text-label font-medium text-faint">
            <IconClock size={20} />
            {fullTime(entry.timestamp)}
          </div>
          {entry.model && (
			<div className="flex items-center gap-2 px-2.5 py-1.5 text-label font-medium text-faint">
              <IconSparkle size={20} />
              Written by {messageModelLabel(entry.model)}
            </div>
          )}
        </Menu.Popup>
      </Menu.Root>
      {shown.map((f) => (
        <FileChip key={f.path} file={f} />
      ))}
      {rest.length > 0 && <MoreChip files={rest} />}
      {/* When the turn actually happened, last in the row: it trails the file
          chips on the right when there's room and wraps to the line below when
          there isn't, rather than painting over a chip. It's opacity-toggled
          rather than mounted on hover (see .turn-footer-time), so its space is
          always reserved and revealing it never shifts the buttons out from
          under the cursor. */}
      <span className={cn("turn-footer-time ml-auto pl-3 text-faint", FOOTER_TEXT)}>
        {fullTime(entry.timestamp)}
      </span>
    </div>
  );
}, turnFooterPropsEqual);

function turnFooterPropsEqual(prev: Props, next: Props): boolean {
  if (
    prev.entry !== next.entry ||
    prev.durationMs !== next.durationMs ||
    prev.onFork !== next.onFork ||
    prev.files.length !== next.files.length
  )
    return false;
  for (let i = 0; i < next.files.length; i++) {
    const a = prev.files[i];
    const b = next.files[i];
    if (a.path !== b.path || a.additions !== b.additions || a.deletions !== b.deletions)
      return false;
  }
  return true;
}

const BTN =
	"flex size-7 flex-shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 text-faint transition-colors hover:bg-hover hover:text-dim focus-ring";

/** Friendly name for a per-message model id: opencode ids take their model
 * part, raw API ids drop the date suffix — "opencode/anthropic/claude-sonnet-5"
 * and "claude-sonnet-5-20250929" both read "Sonnet 5". */
function messageModelLabel(id: string): string {
  const slug = opencodeModelParts(id)?.model || id;
  return friendlyModelSlug(slug.replace(/-\d{8}$/, ""));
}

const MAX_CHIPS = 4;

/**
 * One size and one line box for every text run in the footer — the duration,
 * the file names, the ± counts, the timestamp. Flex centring aligns *boxes*,
 * not text, so a run set a size apart lands its baseline a fraction off its
 * neighbours': the ± counts at 11px sat 0.67px below the 13px file name they
 * ride beside. With identical line boxes, centring and baseline alignment are
 * the same thing — inside a chip and bare in the row alike, since the chip is
 * itself centred in that row. Same 13px/16px pair the fold line above uses.
 */
const FOOTER_TEXT = "text-label font-medium leading-4";

function FileChip({ file }: { file: TouchedFile }) {
  const name = file.path.split("/").pop() || file.path;
  return (
    <Popover.Root>
      <Popover.Trigger
        openOnHover
        delay={250}
        closeDelay={100}
        className="ml-1 flex h-6 min-w-0 cursor-pointer items-center gap-1.5 overflow-hidden rounded-md bg-panel pr-1.5"
      >
        <ExtBadge name={name} flush />
        <span className={cn("max-w-[180px] truncate text-dim", FOOTER_TEXT)}>
          {name}
        </span>
        <LineStats additions={file.additions} deletions={file.deletions} />
      </Popover.Trigger>
      <Popover.Popup
        side="top"
        align="start"
        className="w-[min(520px,calc(100vw-24px))] overflow-hidden"
      >
        {/* Baseline rather than centre: the path is mono and the counts are
            sans, and two fonts at one size still centre to different baselines
            (1px apart here) because their ascents differ. */}
        <div className="flex items-baseline gap-2 border-b border-line px-2.5 py-2">
          <ExtBadge name={name} />
          <span className="min-w-0 flex-1 truncate text-meta text-dim">
            {tidyPath(file.path)}
          </span>
          <LineStats
            additions={file.additions}
            deletions={file.deletions}
            className="text-meta"
          />
        </div>
        <div className="max-h-[min(360px,55vh)] overflow-y-auto p-1.5">
          {file.edits.length === 0 ? (
			<div className="px-1.5 py-2 text-label text-faint">
              No captured changes for this file.
            </div>
          ) : (
            file.edits.map((e, i) => (
              <div
                key={i}
                className={cn(
                  "tool-code-surface overflow-hidden rounded-md",
                  i > 0 && "mt-1.5"
                )}
              >
                <DiffHighlight code={truncateDiff(editDiffText(e))} />
              </div>
            ))
          )}
        </div>
      </Popover.Popup>
    </Popover.Root>
  );
}

/** Hunk-style text for one edit: removed lines then added lines. */
function editDiffText(e: FileEdit): string {
  const lines: string[] = [];
  if (e.old) for (const l of e.old.split("\n")) lines.push(`-${l}`);
  if (e.new) for (const l of e.new.split("\n")) lines.push(`+${l}`);
  return lines.join("\n");
}

function truncateDiff(s: string): string {
  return s.length <= 3000 ? s : s.slice(0, 3000) + "\n…";
}

function tidyPath(p: string): string {
  return p.replace(/^\/home\/[^/]+\//, "~/");
}

function DiffHighlight({ code }: { code: string }) {
  return (
    <Suspense fallback={<pre className="tool-pre">{code}</pre>}>
      <CodeHighlightLazy code={code} lang="diff" />
    </Suspense>
  );
}

function MoreChip({ files }: { files: TouchedFile[] }) {
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  return (
    <Tooltip
      label={files
        .slice(0, 12)
        .map((f) => f.path.split("/").pop())
        .join(", ") + (files.length > 12 ? ", …" : "")}
    >
      <span className="ml-1 flex h-6 items-center gap-1.5 rounded-md bg-panel px-1.5">
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
        className
      )}
    >
      <span className="text-green">+{additions}</span>
      <span className="text-red">-{deletions}</span>
    </span>
  );
}

/**
 * Compact colored file-type badge (linguist-ish hues, muted for white text).
 * `flush` fills its container edge to edge instead of floating inside it — the
 * file chip clips it to its own rounded corners, so the colour becomes the
 * chip's leading edge rather than a square with padding around it.
 */
function ExtBadge({ name, flush }: { name: string; flush?: boolean }) {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : "";
  const color = EXT_COLORS[ext] || "#6e7681";
  const Glyph = LANG_MARKS[ext];
  return (
    <span
      className={cn(
        "flex flex-shrink-0 items-center justify-center text-meta font-bold leading-none text-white",
        flush
          ? "min-w-6 self-stretch px-1"
          : "h-5 min-w-5 self-center rounded-[calc(3px*var(--rf))] px-0.5"
      )}
      style={{ background: color }}
    >
      {Glyph ? <Glyph size={flush ? 13 : 11} /> : extLabel(ext)}
    </span>
  );
}

/**
 * An extension keeps its real name up to four characters and is cut to three
 * beyond that. A blind three-letter cut spelled "JSO", "YAM", "SCS" and "JAV"
 * — word-shaped enough to read as a typo rather than an abbreviation, and the
 * badge is elastic, so the fourth character costs a few pixels.
 */
function extLabel(ext: string): string {
  if (!ext) return "?";
  return (ext.length <= 4 ? ext : ext.slice(0, 3)).toUpperCase();
}

const EXT_COLORS: Record<string, string> = {
  ts: "#3178c6",
  tsx: "#3178c6",
  js: "#a38319",
  jsx: "#a38319",
  mjs: "#a38319",
  cjs: "#a38319",
  css: "#663399",
  scss: "#c6538c",
  html: "#e34c26",
  md: "#0969da",
  mdx: "#0969da",
  json: "#953800",
  yaml: "#cb171e",
  yml: "#cb171e",
  toml: "#9c4221",
  sh: "#459721",
  bash: "#459721",
  py: "#3572a5",
  rs: "#b7410e",
  go: "#0091b5",
  rb: "#701516",
  swift: "#f05138",
  java: "#b07219",
  sql: "#bf7600",
  svg: "#ca6f06",
  // Linguist's ReScript red (#ed5051) is the loudest hue in this map and only
  // clears 3.6:1 against the white label — darkened to sit with its neighbours.
  res: "#c93a3c",
  resi: "#c93a3c",
};

/**
 * Per-file line stats from one edit-family tool call, or null for tools that
 * don't write files. Line counts come from the tool inputs (old/new string
 * sizes), so they're the same "±N" a diff would show for those hunks — minus
 * tools that only report paths, such as Bash and Codex FileChange.
 */
export function touchedFilesFromTool(entry: TranscriptEntry): TouchedFile[] {
  const input = entry.toolInput;
  if (!input || typeof input !== "object") return [];
  const inp = input as Record<string, unknown>;
  const lines = (v: unknown) =>
    typeof v === "string" && v.length > 0 ? v.split("\n").length : 0;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  // Engines disagree on casing: opencode writes `filePath`/`oldString`, the
  // Claude SDK `file_path`/`old_string`.
  const key = (...names: string[]) => {
    for (const n of names) if (typeof inp[n] === "string" && inp[n]) return inp[n] as string;
    return "";
  };
  const filePath = key("file_path", "filePath");
  switch (canonicalToolName(entry.toolName)) {
    case "Edit": {
      // MultiEdit: several hunks against one file.
      if (filePath && Array.isArray(inp.edits)) {
        let additions = 0;
        let deletions = 0;
        const edits: FileEdit[] = [];
        for (const e of inp.edits) {
          if (!e || typeof e !== "object") continue;
          const ee = e as Record<string, unknown>;
          const oldStr = str(ee.old_string ?? ee.oldString);
          const newStr = str(ee.new_string ?? ee.newString);
          additions += lines(newStr);
          deletions += lines(oldStr);
          edits.push({ old: oldStr, new: newStr });
        }
        return [{ path: filePath, additions, deletions, edits }];
      }
      if (filePath) {
        const oldStr = key("old_string", "oldString");
        const newStr = key("new_string", "newString");
        return [{
          path: filePath,
          additions: lines(newStr),
          deletions: lines(oldStr),
          edits: [{ old: oldStr, new: newStr }],
        }];
      }
      // codex's apply_patch names its files inside the patch body.
      return mergeTouchedFiles(patchTouchedFiles(key("patchText", "patch")));
    }
    case "Write":
      if (!filePath) return [];
      return [{
        path: filePath,
        additions: lines(inp.content),
        deletions: 0,
        edits: [{ old: "", new: str(inp.content) }],
      }];
    case "NotebookEdit":
      if (typeof inp.notebook_path !== "string") return [];
      return [{
        path: inp.notebook_path,
        additions: lines(inp.new_source),
        deletions: 0,
        edits: [{ old: "", new: str(inp.new_source) }],
      }];
    case "FileChange": {
      if (!Array.isArray(inp.changes)) return [];
      const files: TouchedFile[] = [];
      for (const change of inp.changes) {
        const path = fileChangePath(change);
        if (!path) continue;
        files.push({ path, additions: 0, deletions: 0, edits: [] });
      }
      return mergeTouchedFiles(files);
    }
    default:
      return [];
  }
}

export function touchedFileFromTool(entry: TranscriptEntry): TouchedFile | null {
  return touchedFilesFromTool(entry)[0] || null;
}

/** All files a turn's tool calls edited, merged per path in first-touch order. */
export function collectTouchedFiles(items: TranscriptEntry[]): TouchedFile[] {
  return mergeTouchedFiles(
    items.flatMap((it) => {
      if (it.type !== "tool_use") return [];
      return touchedFilesFromTool(it);
    })
  );
}

/**
 * Files (and ± line counts) from a codex-style patch body: "*** Update File:
 * src/x.ts" headers followed by +/- lines, as apply_patch sends them.
 */
function patchTouchedFiles(patch: string): TouchedFile[] {
  if (!patch) return [];
  const files: TouchedFile[] = [];
  let current: TouchedFile | null = null;
  for (const line of patch.split("\n")) {
    const header = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/);
    if (header) {
      current = { path: header[1].trim(), additions: 0, deletions: 0, edits: [] };
      files.push(current);
      continue;
    }
    if (!current || line.startsWith("***")) continue;
    if (line.startsWith("+")) current.additions++;
    else if (line.startsWith("-")) current.deletions++;
  }
  return files;
}

function mergeTouchedFiles(files: TouchedFile[]): TouchedFile[] {
  const byPath = new Map<string, TouchedFile>();
  for (const f of files) {
    const prev = byPath.get(f.path);
    if (prev) {
      prev.additions += f.additions;
      prev.deletions += f.deletions;
      prev.edits.push(...f.edits);
    } else {
      byPath.set(f.path, { ...f, edits: [...f.edits] });
    }
  }
  return [...byPath.values()];
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

/** "10m, 57s" / "1h, 4m" / "42s"; null under a second (nothing worth showing). */
function formatDuration(ms: number): string | null {
  const secs = Math.round(ms / 1000);
  if (!isFinite(secs) || secs < 1) return null;
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m, ${secs % 60}s`;
  return `${Math.floor(mins / 60)}h, ${mins % 60}m`;
}

// navigator.clipboard needs a secure context — backstage is served over plain
// http on the tailnet, so fall back to a hidden-textarea copy.
function copyText(text: string, onDone: () => void) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(onDone, () => fallbackCopy(text, onDone));
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
