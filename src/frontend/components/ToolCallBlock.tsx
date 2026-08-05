import React, { Suspense, createContext, lazy, useContext, useEffect, useState } from "react";
import type { TranscriptEntry } from "../lib/types";
import { langForFile, langForGrep } from "../lib/lang";
import { resolveEntryImageSrc } from "../lib/osBlob";
import { cn } from "../ui/cn";
import { openGalleryFrom } from "./MediaLightbox";
import {
  IconTerminal,
  IconFile,
  IconPencil,
  IconSearch,
  IconGlobe,
  IconSparkle,
  IconConnections,
  IconBook,
  IconBranches,
  IconListChecks,
  IconWrench,
  IconChevronDown,
  IconX,
  IconExpand,
} from "./icons";

// Shiki (the syntax highlighter) is multi-MB; keep it out of the initial
// bundle and load it only when a tool call is actually expanded. Until the
// chunk arrives, the code shows as a plain pre.
const CodeHighlightLazy = lazy(() =>
  import("./CodeHighlight").then((m) => ({ default: m.CodeHighlight }))
);

function CodeHighlight(props: {
  code: string;
  lang: string;
  gutter?: boolean;
  requireGutter?: boolean;
}) {
  return (
    <Suspense fallback={<pre className="tool-pre">{props.code}</pre>}>
      <CodeHighlightLazy {...props} />
    </Suspense>
  );
}

interface Props {
  entry: TranscriptEntry;
  result?: TranscriptEntry;
  /** The run is live and this call hasn't returned yet — show a spinner. */
  pending?: boolean;
  /** For Task/Agent calls with a known sub-agent id: open its conversation. */
  onOpenSubagent?: (agentId: string, label: string) => void;
  /** Lets os-blob: image markers (transcript-v2 bounded entries) resolve to
   *  the transcript-image route. Optional — without it markers pass through. */
  sessionId?: string;
}

/**
 * The session's worktree roots, so absolute paths in tool rows can render
 * repo-relative ("src/server/chat.ts", not "~/projects/tella-backstage/src/
 * server/chat.ts"). Attached repos carry their project id as a label and keep
 * a "<project>:" prefix, the same form @-mentions use. Context rather than a
 * prop so the preview rows inside TurnBlock/WorkBlock get it for free.
 */
export type PathRoot = { dir: string; label?: string };
const PathRootsContext = createContext<readonly PathRoot[]>([]);
export const ToolPathRootsProvider = PathRootsContext.Provider;
export function useToolPathRoots(): readonly PathRoot[] {
  return useContext(PathRootsContext);
}

/**
 * Live sub-agent snapshots keyed by the spawning Task call's tool_use id
 * (SessionViewer's subagent poll feeds it). A completed Task call carries its
 * child session id in the result text, but a RUNNING one has no result yet —
 * this map is how the row learns the child id early enough to offer the
 * drill-in while the sub-agent is still working. Context rather than a prop so
 * it skips the memoized TurnBlock/WorkBlock layers.
 */
export type LiveSubagent = { id?: string; status: string };
const LiveSubagentsContext = createContext<ReadonlyMap<string, LiveSubagent>>(
  new Map()
);
export const LiveSubagentsProvider = LiveSubagentsContext.Provider;

/**
 * Engine tool ids → the canonical names the renderers below key on. opencode
 * (the engine every current run uses) emits lowercase ids with camelCase input
 * keys; Claude-SDK transcripts from before the migration use "Read" and
 * "file_path"; codex has its own pair. Canonicalizing here means one set of
 * summaries, icons and detail renderers covers all three.
 */
const TOOL_ALIASES: Record<string, string> = {
  read: "Read",
  view_image: "Read",
  write: "Write",
  edit: "Edit",
  multiedit: "Edit",
  patch: "Edit",
  apply_patch: "Edit",
  bash: "Bash",
  shell: "Bash",
  exec_command: "Bash",
  grep: "Grep",
  glob: "Glob",
  list: "Glob",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  task: "Task",
  skill: "Skill",
  todowrite: "TodoWrite",
  todoread: "TodoWrite",
  update_plan: "TodoWrite",
};

/** Engine-native tools that contain an underscore but are not MCP calls. */
const NATIVE_TOOLS = new Set([
  "invalid",
  "oracle",
  "exit_plan_mode",
  "notebook_edit",
  "web_search",
  "web_fetch",
  "str_replace_editor",
]);

/** The name the renderers key on. Display still uses the raw engine id. */
export function canonicalToolName(name?: string): string {
  if (!name) return "Tool";
  return TOOL_ALIASES[name] ?? name;
}

/**
 * "mcp__linear__list_issues" (Claude SDK) or "linear_list_issues" (opencode's
 * flattened form) → { server: "linear", tool: "list_issues" }. Native tools are
 * excluded by name first, so "apply_patch" doesn't read as an "apply" server.
 */
export function parseMcpTool(name: string): { server: string; tool: string } | null {
  const parts = name.split("__");
  if (parts[0] === "mcp" && parts.length >= 3) {
    return { server: parts[1], tool: parts.slice(2).join("__") };
  }
  if (TOOL_ALIASES[name] || NATIVE_TOOLS.has(name)) return null;
  const flat = name.match(/^([A-Za-z][A-Za-z0-9-]*)_(.+)$/);
  return flat ? { server: flat[1], tool: flat[2] } : null;
}

/** "mcp__linear__list_issues" → "linear · list_issues", else the tool name. */
export function toolDisplayName(name?: string): string {
  if (!name) return "Tool";
  const mcp = parseMcpTool(name);
  return mcp ? `${mcp.server} · ${mcp.tool}` : name;
}

/** First non-empty string among `keys` — engines disagree on the spelling. */
function pickStr(inp: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const v = inp[key];
    if (typeof v === "string" && v) return v;
  }
  return "";
}

const filePathOf = (inp: Record<string, unknown>) => pickStr(inp, "file_path", "filePath");
const commandOf = (inp: Record<string, unknown>) => pickStr(inp, "command", "cmd");

/** Internal plumbing that shouldn't show up in a summary or the input JSON. */
const HIDDEN_INPUT_KEYS = new Set(["__bks_oc_session"]);

/** One-line human summary of a tool call (also used for collapsed previews). */
export function toolSummary(
  toolName: string,
  input: unknown,
  fallback: string,
  roots: readonly PathRoot[] = []
): string {
  if (!input || typeof input !== "object") return fallback;
  const inp = input as Record<string, unknown>;

  switch (canonicalToolName(toolName)) {
    case "Read":
    case "Edit":
    case "Write": {
      const path = filePathOf(inp);
      // codex's apply_patch names its files inside the patch body instead.
      return path ? tidyPath(path, roots) : patchFilesSummary(inp, roots) || fallback;
    }
    case "FileChange":
      return fileChangeSummary(inp, roots) || fallback;
    case "Bash":
      return truncate((commandOf(inp) || fallback).replace(/\s*\n\s*/g, " ⏎ "), 160);
    case "Grep":
      return `/${inp.pattern || ""}/ ${tidyPath(pickStr(inp, "path"), roots)}`.trim();
    case "Glob":
      return (
        [inp.pattern, tidyPath(pickStr(inp, "path"), roots)].filter(Boolean).join(" ") || fallback
      );
    case "Task":
    case "Agent":
      return [inp.subagent_type, inp.description].filter(Boolean).join(": ") || fallback;
    case "Workflow":
      return (inp.name as string) || (inp.description as string) || "orchestration script";
    case "Skill":
      return pickStr(inp, "skill", "name") || fallback;
    case "TodoWrite":
      return todoSummary(inp) || fallback;
    case "WebFetch":
    case "WebSearch":
      return (inp.url as string) || (inp.query as string) || fallback;
    case "TaskCreate":
      return (inp.subject as string) || (inp.title as string) || fallback;
    default:
      // MCP and other tools: a compact "key: value" render of the input reads
      // better than the generic "Using <tool>" content fallback.
      return compactInput(inp) || fallback;
  }
}

export function toolLineStats(
  toolName: string,
  input: unknown
): { additions: number; deletions: number } | null {
  if (!input || typeof input !== "object") return null;
  const canonical = canonicalToolName(toolName);
  if (canonical !== "Edit" && canonical !== "Write") return null;
  const inp = input as Record<string, unknown>;
  const patch = pickStr(inp, "patchText", "patch");
  if (patch) {
    let additions = 0;
    let deletions = 0;
    for (const line of patch.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }
    return additions || deletions ? { additions, deletions } : null;
  }

  const edits = Array.isArray(inp.edits) ? inp.edits : [inp];
  let additions = 0;
  let deletions = 0;
  for (const value of edits) {
    if (!value || typeof value !== "object") continue;
    const edit = value as Record<string, unknown>;
    const oldText = pickStr(edit, "old_string", "oldString");
    const newText = pickStr(edit, "new_string", "newString", "content");
    additions += lineCount(newText);
    deletions += lineCount(oldText);
  }
  return additions || deletions ? { additions, deletions } : null;
}

function lineCount(value: string): number {
  return value ? value.split("\n").length : 0;
}

/** "3/7 done" plus whatever the run is on right now. */
function todoSummary(inp: Record<string, unknown>): string {
  const list = Array.isArray(inp.todos) ? inp.todos : Array.isArray(inp.plan) ? inp.plan : null;
  if (!list) return "";
  const items = list.filter(
    (t): t is Record<string, unknown> => Boolean(t) && typeof t === "object"
  );
  if (items.length === 0) return "";
  const active = items.find((t) => t.status === "in_progress");
  const done = items.filter((t) => t.status === "completed").length;
  return [pickStr(active || {}, "content", "step", "activeForm"), `${done}/${items.length} done`]
    .filter(Boolean)
    .join("  ·  ");
}

/** Files touched by a codex-style patch body ("*** Update File: src/x.ts"). */
function patchFilesSummary(inp: Record<string, unknown>, roots: readonly PathRoot[]): string {
  const text = pickStr(inp, "patchText", "patch");
  if (!text) return "";
  const files = [...text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) =>
    tidyPath(m[1].trim(), roots)
  );
  if (files.length === 0) return "";
  const shown = files.slice(0, 3).join("  ·  ");
  return files.length > 3 ? `${shown}  ·  +${files.length - 3}` : shown;
}

function compactInput(inp: Record<string, unknown>): string {
  const parts = Object.entries(inp)
    .filter(([k, v]) => !HIDDEN_INPUT_KEYS.has(k) && v !== undefined && v !== null && v !== "")
    .slice(0, 4)
    .map(([k, v]) => {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      return `${k}: ${truncate(String(s).replace(/\s+/g, " "), 48)}`;
    });
  return parts.join("  ·  ");
}

function fileChangeSummary(inp: Record<string, unknown>, roots: readonly PathRoot[]): string {
  if (!Array.isArray(inp.changes)) return "";
  return inp.changes
    .map((change) => {
      if (typeof change === "string") return change;
      if (!change || typeof change !== "object") return "";
      const c = change as Record<string, unknown>;
      const path = typeof c.path === "string" ? tidyPath(c.path, roots) : "";
      return [c.kind, path].filter(Boolean).join(" ");
    })
    .filter(Boolean)
    .slice(0, 4)
    .join("  ·  ");
}

type FamilyKey =
  | "run" | "file" | "edit" | "find" | "web" | "agent" | "mcp" | "skill" | "plain";

export function toolFamily(toolName: string): FamilyKey {
  if (parseMcpTool(toolName)) return "mcp";
  switch (canonicalToolName(toolName)) {
    case "Bash":
    case "BashOutput":
      return "run";
    case "Read":
    case "NotebookEdit":
      return "file";
    case "Edit":
    case "Write":
    case "FileChange":
      return "edit";
    case "Grep":
    case "Glob":
    case "LSP":
    case "ToolSearch":
      return "find";
    case "WebFetch":
    case "WebSearch":
      return "web";
    case "Task":
    case "Agent":
    case "Workflow":
      return "agent";
    case "Skill":
      return "skill";
    default:
      return "plain";
  }
}

export function ToolGlyph({ toolName, size = 20 }: { toolName: string; size?: number }) {
  switch (toolFamily(toolName)) {
    case "run":
      return <IconTerminal size={size} />;
    case "file":
      return <IconFile size={size} />;
    case "edit":
      return <IconPencil size={size} />;
    case "find":
      return <IconSearch size={size} />;
    case "web":
      return <IconGlobe size={size} />;
    case "agent":
      return <IconSparkle size={size} />;
    // IconConnections, not IconPlug: the plug only draws the middle half of
    // the 24-grid, so it read a size smaller than every glyph beside it.
    case "mcp":
      return <IconConnections size={size} />;
    case "skill":
      return <IconBook size={size} />;
    default:
      switch (canonicalToolName(toolName)) {
        case "EnterWorktree":
        case "ExitWorktree":
          return <IconBranches size={size} />;
        case "TaskCreate":
        case "TaskUpdate":
        case "TaskList":
        case "TaskGet":
        case "TodoWrite":
          return <IconListChecks size={size} />;
        default:
          return <IconWrench size={size} />;
      }
  }
}

/**
 * Shorten a path for display: inside one of the session's worktrees it renders
 * repo-relative (an attached repo keeps a "<project>:" prefix so it stays
 * unambiguous); anything outside them just collapses $HOME to "~".
 */
function tidyPath(p: string, roots: readonly PathRoot[] = []): string {
  if (!p) return "";
  for (const root of roots) {
    if (!root.dir) continue;
    if (p === root.dir) return root.label ? `${root.label}:.` : ".";
    if (p.startsWith(`${root.dir}/`)) {
      const rel = p.slice(root.dir.length + 1);
      return root.label ? `${root.label}:${rel}` : rel;
    }
  }
  return p.replace(/^\/home\/[^/]+\//, "~/");
}

/** Path summary with the directory dimmed and the basename readable. */
function PathSummary({ path }: { path: string }) {
  const idx = path.lastIndexOf("/");
  if (idx < 0) return <>{path}</>;
  return (
    <>
      <span className="opacity-55">{path.slice(0, idx + 1)}</span>
      {path.slice(idx + 1)}
    </>
  );
}

export function toolDurationMs(
  entry: TranscriptEntry,
  result?: TranscriptEntry,
  nowMs?: number
): number | null {
  const startedAt = new Date(entry.timestamp).getTime();
  const endedAt = result ? new Date(result.timestamp).getTime() : nowMs;
  if (!isFinite(startedAt) || endedAt === undefined || !isFinite(endedAt)) return null;
  const durationMs = endedAt - startedAt;
  return durationMs >= 0 ? durationMs : null;
}

function formatToolDuration(durationMs: number): string {
  const secs = Math.round(durationMs / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function stepDuration(entry: TranscriptEntry, result?: TranscriptEntry): string | null {
  const durationMs = toolDurationMs(entry, result);
  if (durationMs === null || durationMs < 1500) return null;
  return formatToolDuration(durationMs);
}

function RunningToolDuration({ entry }: { entry: TranscriptEntry }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const durationMs = toolDurationMs(entry, undefined, nowMs);
  if (durationMs === null) return null;
  return (
    <span
      data-tool-duration
      className="hidden flex-shrink-0 text-meta tabular-nums text-faint group-hover:block"
    >
      {formatToolDuration(durationMs)}
    </span>
  );
}

export function ToolCallBlock({ entry, result, pending, onOpenSubagent, sessionId }: Props) {
  const hasMedia = Boolean(result?.images?.length || result?.videos?.length);
  // Default closed for text-only output, but auto-open when media arrives
  // (covers both initial render and the live tool_result streaming in later).
  const [expanded, setExpanded] = useState(hasMedia);
  useEffect(() => {
    if (hasMedia) setExpanded(true);
  }, [hasMedia]);
  const toolName = entry.toolName || "Tool";
  const canonical = canonicalToolName(toolName);
  const roots = useToolPathRoots();
  const mcp = parseMcpTool(toolName);
  const summary = toolSummary(toolName, entry.toolInput, entry.content, roots);
  const isFileTool = canonical === "Read" || canonical === "Edit" || canonical === "Write";
  const lineStats = toolLineStats(toolName, entry.toolInput);
  const duration = stepDuration(entry, result);
  const failed = Boolean(result?.isError);
  const inputNode = expanded ? toolInputNode(canonical, entry.toolInput) : null;
  const resultContent = visibleResultContent(result?.content, hasMedia, failed);
  const mediaOnly = hasMedia && !resultContent && !inputNode;

  // A Task/Agent call whose sub-agent transcript we can open in the sidebar.
  // Claude-SDK results carry a structured agentId; opencode's task tool only
  // embeds the child session id in the result text (<task id="ses_…">) — the
  // subagent route accepts either. Before the result exists, the live
  // subagents map (fed by SessionViewer's poll) supplies the child id so a
  // still-running sub-agent can be watched mid-flight.
  const isAgent = canonical === "Task" || canonical === "Agent";
  const liveSubs = useContext(LiveSubagentsContext);
  const liveSub =
    isAgent && entry.toolUseId ? liveSubs.get(entry.toolUseId) : undefined;
  const agentId =
    result?.agentId ??
    (isAgent
      ? (result?.content?.match(/<task id="(ses_[A-Za-z0-9]+)"/)?.[1] ??
        liveSub?.id)
      : undefined);
  const canOpenSubagent = isAgent && agentId && onOpenSubagent;
  // No result yet = the sub-agent is still working: surface the drill-in
  // unconditionally instead of hover-gated, so its progress is one click away.
  const subagentLive = canOpenSubagent && !result;

  return (
    <div className="relative" data-eid={entry.id}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className={cn(
          // Baseline, not centre: the 14px tool name, the 13px mono path and
          // the 11px trailing meta all ride this row, and centring aligns
          // their boxes rather than their text. Items with no text baseline
          // (the glyph, the spinner, the failure mark) opt back into centring.
          "group flex w-full min-w-0 cursor-pointer items-baseline gap-2 rounded-md border-0 bg-transparent px-1 py-[3px] text-left font-sans transition-colors focus-ring",
          "hover:bg-hover/40"
        )}
      >
        <span
          className={cn(
            "relative z-[1] flex size-[22px] flex-shrink-0 self-center items-center justify-center",
            failed ? "text-red/70" : "text-faint"
          )}
        >
          <span className="transition-opacity duration-150 group-hover:opacity-0">
            <ToolGlyph toolName={toolName} size={20} />
          </span>
          <IconChevronDown
            size={20}
            className={cn(
              "absolute block text-dim opacity-0 transition-[opacity,transform] duration-150 group-hover:opacity-100",
              expanded && "rotate-180"
            )}
          />
        </span>

        {mcp ? (
		  <span className="flex min-w-0 flex-shrink-0 items-baseline gap-1.5 text-body leading-5">
            <span className="rounded bg-panel px-1.5 py-px text-label leading-4 font-bold tracking-[-0.01em] text-dim">
              {mcp.server}
            </span>
            <span className="font-medium text-dim transition-colors group-hover:text-fg">{mcp.tool}</span>
          </span>
        ) : (
		  <span className="flex-shrink-0 text-body leading-5 font-medium text-dim transition-colors group-hover:text-fg">{toolName}</span>
        )}

        {/* Baseline, not centre: the path is mono and the ± counts are sans, so
            at one size their line boxes still centre to different baselines. */}
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span
            className={cn(
              "min-w-0 truncate text-label leading-4",
              failed ? "text-red/80" : "text-dim"
            )}
          >
            {isFileTool ? <PathSummary path={summary} /> : summary}
          </span>
          {lineStats && (
            <span className="flex flex-shrink-0 gap-1.5 text-label leading-4">
              {lineStats.additions > 0 && (
                <span className="text-green">+{lineStats.additions}</span>
              )}
              {lineStats.deletions > 0 && (
                <span className="text-red">-{lineStats.deletions}</span>
              )}
            </span>
          )}
        </span>

        {canOpenSubagent && (
          <span
            role="button"
            tabIndex={0}
            className={cn(
			  "flex-shrink-0 rounded border border-line px-1.5 py-px text-meta text-dim opacity-100 transition-opacity hover:border-line-strong hover:text-fg focus:opacity-100 focus-ring",
              !subagentLive && "md:opacity-0 md:group-hover:opacity-100"
            )}
            onClick={(e) => {
              e.stopPropagation();
              onOpenSubagent!(agentId!, summary);
            }}
            title="Open this sub-agent's conversation"
          >
            {subagentLive ? "Watch ↗" : "Open ↗"}
          </span>
        )}

        {duration && (
          <span className="flex-shrink-0 text-meta tabular-nums text-faint">{duration}</span>
        )}
        {pending && <RunningToolDuration entry={entry} />}

        {pending ? (
          <span className="size-[10px] flex-shrink-0 self-center animate-spin rounded-full border-2 border-green-soft border-t-green" />
        ) : failed ? (
          <span className="flex-shrink-0 self-center text-red">
            <IconX size={20} />
          </span>
        ) : !result ? (
          <span className="flex-shrink-0 text-meta text-faint">—</span>
        ) : null}
      </button>

      {expanded && (
        <div
          className={cn(
            "relative z-[1] mb-1.5 ml-[30px] mt-0.5",
            mediaOnly ? "overflow-visible" : "overflow-hidden rounded-lg bg-panel"
          )}
        >
          {inputNode && <div className="p-1.5">{inputNode}</div>}
          {result && (resultContent || result.images?.length || result.videos?.length) && (
            <>
              {resultContent && (
                <div
                  className={cn(
                    "px-2.5 pb-1 pt-1.5 text-meta font-bold tracking-[-0.01em]",
                    failed ? "text-red" : "text-faint"
                  )}
                >
                  {failed ? "Error" : "Output"}
                </div>
              )}
              <div
                className={cn(
                  resultContent && "px-1.5 pb-1.5",
                  failed && "[&_.tool-pre]:text-red/75"
                )}
              >
                {resultContent && (
		<div className="tool-code-surface overflow-x-auto rounded-md border border-white/6 bg-[#0d0f13] px-2.5 py-2 [tab-size:2] [html[data-theme=light]_&]:border-[#d8dee4] [html[data-theme=light]_&]:bg-[#f6f8fa] [&_.tool-pre]:text-[#b6bcc8] [html[data-theme=light]_&_.tool-pre]:text-[#57606a] [&_.shiki-gutter]:text-[#565d6b] [html[data-theme=light]_&_.shiki-gutter]:text-[#8c959f]">
                    {renderResultContent(canonical, entry.toolInput, resultContent)}
                  </div>
                )}
                {result.images && result.images.length > 0 && (
                  <div className={cn("tool-result-images", !resultContent && "!mt-0")}>
                    {result.images.map((raw, i) => {
                      const src = resolveEntryImageSrc(raw, sessionId);
                      return (
                        <a key={i} href={src} target="_blank" rel="noopener noreferrer" className="md-image-link">
                          <img
                            className={cn("md-image", !resultContent && "!my-0")}
                            src={src}
                            alt=""
                            loading="lazy"
                          />
                        </a>
                      );
                    })}
                  </div>
                )}
                {result.videos && result.videos.length > 0 && (
                  <div className="tool-result-videos">
                    {result.videos.map((src, i) => (
                      <div key={i} className="md-video-wrap">
                        <video className="md-video" src={src} controls playsInline preload="metadata" />
                        <button
                          type="button"
                          className="md-video-expand"
                          aria-label="Expand"
                          title="Expand"
                          onClick={(e) => {
                            const vid = e.currentTarget.parentElement?.querySelector("video");
                            if (vid) openGalleryFrom(vid);
                          }}
                        >
                          <IconExpand size={20} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Drop engine acknowledgements when the media itself is the useful result. */
export function visibleResultContent(
  content: string | undefined,
  hasMedia: boolean,
  failed: boolean
): string {
  if (!content) return "";
  if (!failed && hasMedia && /^Image read successfully\.?$/.test(content.trim())) return "";
  return content;
}

/**
 * The call's input, rendered by what it is rather than as raw JSON where we
 * can: Bash as a highlighted script, Edit as a unified diff, Write as the file
 * content in the file's language. Everything else falls back to pretty JSON.
 * All variants sit on a .tool-code-surface (dark in both themes).
 */
function toolInputNode(toolName: string, input: unknown): React.ReactNode | null {
  const inp = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;

  if (toolName === "Bash" && bashCommand(input)) {
    return (
		  <div className="tool-code-surface overflow-x-auto rounded-md border border-white/6 bg-[#0d0f13] px-2.5 py-2 [tab-size:2] [html[data-theme=light]_&]:border-[#d8dee4] [html[data-theme=light]_&]:bg-[#f6f8fa] [&_.tool-pre]:text-[#b6bcc8] [html[data-theme=light]_&_.tool-pre]:text-[#57606a] [&_.shiki-gutter]:text-[#565d6b] [html[data-theme=light]_&_.shiki-gutter]:text-[#8c959f]">
        <CodeHighlight code={bashCommand(input)!} lang="bash" />
      </div>
    );
  }

  if (toolName === "Edit") {
    // A patch body is already a diff; an old/new string pair becomes one.
    const patch = pickStr(inp, "patchText", "patch");
    const oldStr = pickStr(inp, "old_string", "oldString");
    const newStr = pickStr(inp, "new_string", "newString");
    const diff =
      patch ||
      (oldStr || newStr
        ? [
            ...oldStr.split("\n").map((l) => `-${l}`),
            ...newStr.split("\n").map((l) => `+${l}`),
          ].join("\n")
        : "");
    if (diff) {
      return (
		<div className="tool-code-surface overflow-x-auto rounded-md border border-white/6 bg-[#0d0f13] px-2.5 py-2 [tab-size:2] [html[data-theme=light]_&]:border-[#d8dee4] [html[data-theme=light]_&]:bg-[#f6f8fa] [&_.tool-pre]:text-[#b6bcc8] [html[data-theme=light]_&_.tool-pre]:text-[#57606a] [&_.shiki-gutter]:text-[#565d6b] [html[data-theme=light]_&_.shiki-gutter]:text-[#8c959f]">
          <CodeHighlight code={truncate(diff, 4000)} lang="diff" />
        </div>
      );
    }
  }

  if (toolName === "Write" && typeof inp.content === "string") {
    return (
      <div className="tool-code-surface">
        <CodeHighlight
          code={truncate(inp.content, 4000)}
          lang={langForFile(filePathOf(inp)) || "markdown"}
        />
      </div>
    );
  }

  // Read's input is fully covered by the row summary (plus offset/limit when
  // present — only show those).
  if (toolName === "Read") {
    const extras = Object.entries(inp).filter(
      ([k]) => k !== "file_path" && k !== "filePath" && !HIDDEN_INPUT_KEYS.has(k)
    );
    if (extras.length === 0) return null;
    return (
      <pre className="tool-pre tool-code-surface">
        {extras.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")}
      </pre>
    );
  }

  const text = formatInput(input);
  if (!text) return null;
  return <pre className="tool-pre tool-code-surface">{truncate(text, 4000)}</pre>;
}

/**
 * Tool outputs that carry code get syntax highlighting: Read (cat -n format,
 * lang from file_path) and Grep content output (rg -n format, lang inferred
 * from path/glob/type — only highlighted when the gutter format is detected,
 * so file-list output stays plain).
 */
function renderResultContent(toolName: string, input: unknown, content: string) {
  const text = truncate(content, 2000);
  const lang =
    toolName === "Read"
      ? langForFile(filePathOf((input || {}) as Record<string, unknown>))
      : toolName === "Grep"
        ? langForGrep(input)
        : null;
  if (lang) {
    return <CodeHighlight code={text} lang={lang} gutter requireGutter={toolName === "Grep"} />;
  }
  // Unified diffs (git diff/show in Bash output) highlight as diff
  if (toolName === "Bash" && (text.startsWith("diff --git") || /^@@ -\d/m.test(text))) {
    return <CodeHighlight code={text} lang="diff" />;
  }
  return <pre className="tool-pre">{text}</pre>;
}

/**
 * Bash input rendered as a script: description and flags become `#` comments
 * above the command, so the whole block highlights as bash without losing info.
 */
function bashCommand(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const inp = input as Record<string, unknown>;
  const command = commandOf(inp);
  if (!command) return null;

  const comments: string[] = [];
  if (typeof inp.description === "string" && inp.description) {
    comments.push(`# ${inp.description}`);
  }
  for (const [key, value] of Object.entries(inp)) {
    if (key === "command" || key === "cmd" || key === "description") continue;
    if (HIDDEN_INPUT_KEYS.has(key)) continue;
    comments.push(`# ${key}: ${JSON.stringify(value)}`);
  }
  return [...comments, command].join("\n");
}

function formatInput(input: unknown): string {
  if (!input) return "";
  if (typeof input === "string") return input;
  if (typeof input === "object" && !Array.isArray(input)) {
    const visible = Object.fromEntries(
      Object.entries(input as Record<string, unknown>).filter(([k]) => !HIDDEN_INPUT_KEYS.has(k))
    );
    return JSON.stringify(visible, null, 2);
  }
  return JSON.stringify(input, null, 2);
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + "…";
}
