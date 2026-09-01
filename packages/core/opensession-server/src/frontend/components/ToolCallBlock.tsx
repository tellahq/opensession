import { mergeStylexProps, mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { TranscriptEntry } from "../lib/types";
import { CodeHighlight } from "./LazyCode";
import { ToolInputDiff } from "./ToolInputDiff";
import { langForFile, langForGrep } from "../lib/lang";
import { toolInputDiff } from "../lib/tool-input-diff";
import {
  currentPlanItem,
  parsePlanItems,
  planDoneCount,
} from "@tellahq/opensession-protocol/todo-plan";
import { PlanChecklist } from "./PlanChecklist";
import { resolveEntryImageSrc } from "../lib/osBlob";
import { BASE_PATH } from "../lib/base";
import { cn } from "../ui/cn";
import {
  TOOL_CODE_WELL,
  TOOL_PRE,
  TOOL_RESULT_MEDIA,
  TOOL_ROW_CHIP,
  TOOL_ROW_MEDIA_HINT,
} from "../lib/tool-classes";
import { tidyPath, type PathRoot } from "../lib/tidy-path";
import {
  assetToolPath,
  canonicalToolName,
  formatToolDetail,
  isHiddenToolInputKey,
  mcpLabelParts,
  parseMcpTool,
  toolCommand as commandOf,
  toolDetail,
  toolFamily,
  toolFilePath as filePathOf,
  toolInputString as pickStr,
  toolLineStats,
  unwrapMcpDispatcher,
} from "@tellahq/opensession-protocol/tool-presentation";
import { formatDuration, fullTime } from "../lib/time";
import { Tooltip } from "../ui/tooltip";
import { Fold } from "../ui/fold";
import { ExtBadge, fileExt } from "./lang-marks";
import { openGalleryFrom } from "../lib/media-lightbox-gallery";
import { useOpenAsset, useOpenAssetPaths } from "../lib/open-asset";
import { assetPathForMediaSrc } from "../lib/asset-preview";
import { transcriptDisclosureLedger } from "../lib/transcript-disclosures";
// Re-exported so the session view keeps one import for the transcript's
// context providers; the context itself lives with the rest of the
// open-an-asset behaviour, which the turn footer shares.
export { OpenAssetProvider } from "../lib/open-asset";
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
  IconListCircles,
  IconWrench,
  IconChevronDown,
  IconExpand,
  IconArrowUpRight,
} from "./icons";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  block: {
    display: "block",
  },
  minW0: {
    minWidth: "0",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  opacity55: {
    opacity: "55%",
  },
  flexShrink0: {
    flexShrink: "0",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  relative: {
    position: "relative",
  },
  z1: {
    zIndex: "1",
  },
  flex: {
    display: "flex",
  },
  size22px: {
    width: "22px",
    height: "22px",
  },
  selfCenter: {
    alignSelf: "center",
  },
  itemsCenter: {
    alignItems: "center",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  transitionOpacity: {
    transitionProperty: "opacity",
    transitionTimingFunction: "var(--tw-ease, var(--ease))",
    transitionDuration: "var(--tw-duration, var(--dur-micro))",
  },
  duration150: {
    transitionDuration: "150ms",
  },
  itemsBaseline: {
    alignItems: "baseline",
  },
  gap1: {
    gap: "4px",
  },
  overflowHidden: {
    overflow: "hidden",
  },
  leading5: {
    lineHeight: "calc(4px * 5)",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  transitionColors: {
    transitionProperty:
      "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to",
    transitionTimingFunction: "var(--tw-ease, var(--ease))",
    transitionDuration: "var(--tw-duration, var(--dur-micro))",
  },
  phoneFlexShrink0: {
    "@media (max-width: 720px)": {
      flexShrink: "0",
    },
  },
  gap15: {
    gap: "calc(4px * 1.5)",
  },
  leading4: {
    lineHeight: "calc(4px * 4)",
  },
  textGreen: {
    color: "var(--green)",
  },
  textRed: {
    color: "var(--red)",
  },
  size4: {
    width: "calc(4px * 4)",
    height: "calc(4px * 4)",
  },
  shrink0: {
    flexShrink: "0",
  },
  opacity70: {
    opacity: "70%",
  },
  size11px: {
    width: "11px",
    height: "11px",
  },
  animateSpin: {
    animation: "var(--animate-spin)",
  },
  roundedFull: {
    borderRadius: "calc(infinity * 1px)",
    cornerShape: "round",
  },
  border: {
    borderStyle: "solid",
    borderWidth: "1px",
  },
  borderBLineStrong: {
    borderBottomColor: "var(--border-strong)",
  },
  borderLLineStrong: {
    borderLeftColor: "var(--border-strong)",
  },
  borderRLineStrong: {
    borderRightColor: "var(--border-strong)",
  },
  borderTDim: {
    borderTopColor: "var(--text-dim)",
  },
  mb15: {
    marginBottom: "calc(4px * 1.5)",
  },
  ml30px: {
    marginLeft: "30px",
  },
  mt1: {
    marginTop: "4px",
  },
  px1: {
    paddingInline: "4px",
  },
  py15: {
    paddingBlock: "calc(4px * 1.5)",
  },
  roundedControl: {
    borderRadius: "calc(12px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  border0: {
    borderStyle: "solid",
    borderWidth: "0px",
  },
  bgTransparent: {
    backgroundColor: "transparent",
  },
  px15: {
    paddingInline: "calc(4px * 1.5)",
  },
  py1: {
    paddingBlock: "4px",
  },
  fontSans: {
    fontFamily: "var(--sans)",
  },
  hoverBgHover40: {
    "@media (hover: hover)": {
      ":hover": {
        backgroundColor: "color-mix(in oklab, var(--hover) 40%, transparent)",
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
});

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

type FullEntryDetail = Pick<
  TranscriptEntry,
  "content" | "toolInput" | "images"
>;

function useHydratedTranscriptEntry(
  target: TranscriptEntry | undefined,
  enabled: boolean,
  sessionId: string | undefined,
  legacyVoiceInput = false,
): TranscriptEntry | null {
  const [hydrated, setHydrated] = useState<{
    sessionId: string;
    source: TranscriptEntry;
    entry: TranscriptEntry;
  } | null>(null);
  const current =
    hydrated && hydrated.sessionId === sessionId && hydrated.source === target
      ? hydrated.entry
      : null;

  useEffect(() => {
    if (!enabled || !sessionId || !target || current) return;
    const controller = new AbortController();
    void fetch(
      `${BASE_PATH}/api/sessions/${encodeURIComponent(sessionId)}/entry/${encodeURIComponent(target.id)}`,
      { signal: controller.signal },
    )
      .then(async (res) => {
        if (!res.ok) return;
        const detail = (await res.json()) as FullEntryDetail;
        let toolInput = detail.toolInput;
        if (legacyVoiceInput && toolInput === undefined && detail.content) {
          await (async () => {
            toolInput = JSON.parse(detail.content);
          })().catch(async () => {
            toolInput = detail.content;
          });
        }
        setHydrated({
          sessionId,
          source: target,
          entry: {
            ...target,
            ...detail,
            ...(toolInput !== undefined ? { toolInput } : {}),
          },
        });
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        // Keep the bounded transcript row visible if full-detail loading fails.
      });
    return () => controller.abort();
  }, [current, enabled, legacyVoiceInput, sessionId, target]);
  return current;
}

/**
 * The session's worktree roots, so absolute paths in tool rows can render
 * repo-relative ("src/server/chat.ts", not "~/projects/opensession/src/
 * server/chat.ts"). Attached repos carry their project id as a label and keep
 * a "<project>:" prefix, the same form @-mentions use. Context rather than a
 * prop so the preview rows inside TurnBlock get it for free.
 */
const PathRootsContext = createContext<readonly PathRoot[]>([]);
export type { PathRoot };
export {
  assetToolPath,
  canonicalToolName,
  mcpLabelParts,
  mcpServerDisplayName,
  mcpToolDisplayName,
  parseMcpTool,
  toolDisplayName,
  toolFamily,
  toolLineStats,
  unwrapMcpDispatcher,
} from "@tellahq/opensession-protocol/tool-presentation";
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
 * it skips the memoized TurnBlock layers.
 */
export type LiveSubagent = { id?: string; status: string };
const LiveSubagentsContext = createContext<ReadonlyMap<string, LiveSubagent>>(
  new Map(),
);
export const LiveSubagentsProvider = LiveSubagentsContext.Provider;

/**
 * One-line human summary of a tool call (also used for collapsed previews).
 *
 * Identity and content come from the protocol's shared derivation, which the
 * server also runs — so a call reads the same here, on the phone and in the
 * terminal. Only the path shortening is the viewer's own: it depends on the
 * worktrees this client knows about.
 */
export function toolSummary(
  rawName: string,
  rawInput: unknown,
  fallback: string,
  roots: readonly PathRoot[] = [],
): string {
  // Pi routes every bridged MCP call through its `mcp_call` dispatcher, so the
  // envelope is what a transcript stores. Summarize the call inside it.
  const { toolName, input } = unwrapMcpDispatcher(rawName, rawInput);
  const detail = formatToolDetail(toolDetail(toolName, input), (p) =>
    tidyPath(p, roots),
  );
  if (detail) return detail;
  if (parseMcpTool(toolName) && fallback.trim() === `Using ${toolName}`)
    return "";
  return fallback;
}

export function ToolGlyph({
  toolName,
  size = 20,
}: {
  toolName: string;
  size?: number;
}) {
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
    // Full size, like every other family. The three nodes do fill more of the
    // 24-grid than the sparse glyphs, but both ways of pulling it in read
    // worse: a smaller `size` does nothing (icons clamp at 20px, MIN_SIZE in
    // icons.tsx), and a tighter drawing loses the row's rhythm.
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
          return <IconListCircles size={size} />;
        default:
          return <IconWrench size={size} />;
      }
  }
}

/** Split a path so its directory can stay quiet while the row truncates as one line. */
export function pathSummaryParts(path: string) {
  const slash = path.lastIndexOf("/");
  if (slash < 0) return { directory: "", separator: "", filename: path };
  return {
    directory: path.slice(0, slash),
    separator: "/",
    filename: path.slice(slash + 1),
  };
}

export function PathSummary({ path }: { path: string }) {
  const { directory, separator, filename } = pathSummaryParts(path);
  if (!separator) return <>{filename}</>;
  return (
    <span {...stylex.props(sx.block, sx.minW0, sx.truncate)} title={path}>
      {directory && <span {...stylex.props(sx.opacity55)}>{directory}</span>}
      <span {...stylex.props(sx.opacity55)}>{separator}</span>
      <span>{filename}</span>
    </span>
  );
}

export function toolDurationMs(
  entry: TranscriptEntry,
  result?: TranscriptEntry,
  nowMs?: number,
): number | null {
  const startedAt = new Date(entry.timestamp).getTime();
  const endedAt = result ? new Date(result.timestamp).getTime() : nowMs;
  if (!isFinite(startedAt) || endedAt === undefined || !isFinite(endedAt))
    return null;
  const durationMs = endedAt - startedAt;
  return durationMs >= 0 ? durationMs : null;
}

function formatToolDuration(durationMs: number): string {
  return formatDuration(durationMs) ?? "0s";
}

function stepDuration(
  entry: TranscriptEntry,
  result?: TranscriptEntry,
): string | null {
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
      {...mergeStylexProps(
        "tabular-nums",
        sx.flexShrink0,
        sx.textFaint,
        typography.meta,
      )}
    >
      {formatToolDuration(durationMs)}
    </span>
  );
}

// Memoized: a live turn re-renders on every stream event, and a turn holds
// tens to hundreds of these rows. Every prop is identity-stable: the entries
// themselves are (mergeTranscriptEntries replaces rather than mutates), and
// TurnBlock's only caller passes a memoized onOpenSubagent. So a shallow
// compare bails out for every row the event did not touch.
export const ToolCallBlock = function ToolCallBlock({
  entry,
  result,
  pending,
  onOpenSubagent,
  sessionId,
}: Props) {
  const entryNeedsHydration =
    entry.contentClamped || isBoundedToolInput(entry.toolInput);
  const resultNeedsHydration = Boolean(result?.contentClamped);
  // Default closed, and open only for media the agent asked to SHOW. Keep an
  // explicit choice on the transcript entry rather than this component: the
  // history virtualizer unmounts off-screen rows, and a live turn remounts its
  // children whenever its last-entry key changes. Component-local state made
  // either path forget that a person had opened or closed this detail.
  const [rememberedExpanded] = useState(() =>
    transcriptDisclosureLedger.read("tool-call", sessionId, [entry.id]),
  );
  const [expanded, setExpanded] = useState(
    rememberedExpanded ?? Boolean(result?.featuredMedia?.length),
  );
  const userToggledRef = useRef(rememberedExpanded !== undefined);
  const [durationVisible, setDurationVisible] = useState(false);
  function rememberExpansion(next: boolean) {
    userToggledRef.current = true;
    transcriptDisclosureLedger.write("tool-call", sessionId, [entry.id], next);
    setExpanded(next);
  }
  const fullEntry = useHydratedTranscriptEntry(
    entry,
    expanded && Boolean(entryNeedsHydration),
    sessionId,
    entry.id.startsWith("voice-tu-"),
  );
  const fullResult = useHydratedTranscriptEntry(
    result,
    expanded && resultNeedsHydration,
    sessionId,
  );
  const shownInput = fullEntry?.toolInput ?? entry.toolInput;
  const shownResult = fullResult ?? result;
  const imageCount = shownResult?.images?.length ?? 0;
  const videoCount = shownResult?.videos?.length ?? 0;
  const hasMedia = imageCount + videoCount > 0;
  const mediaLabel = !hasMedia
    ? ""
    : videoCount === 0
      ? `${imageCount} image${imageCount === 1 ? "" : "s"}`
      : imageCount === 0
        ? `${videoCount} video${videoCount === 1 ? "" : "s"}`
        : `${imageCount + videoCount} media`;
  // Featured media streaming in later opens an untouched row. Once a person
  // has chosen either state, that choice wins across later results and remounts.
  const hasFeaturedMedia = Boolean(shownResult?.featuredMedia?.length);
  useEffect(() => {
    if (hasFeaturedMedia && !userToggledRef.current) setExpanded(true);
  }, [hasFeaturedMedia]);
  // The transcript stores pi's dispatcher envelope for every bridged MCP call,
  // so the row resolves the call inside it once and derives everything from
  // that: the label, the glyph, the summary, the expanded input.
  const { toolName, input: callInput } = unwrapMcpDispatcher(
    entry.toolName || "Tool",
    shownInput,
  );
  const canonical = canonicalToolName(toolName);
  const roots = useToolPathRoots();
  const mcp = parseMcpTool(toolName);
  const mcpParts = mcp ? mcpLabelParts(mcp.server, mcp.tool) : [];
  const scopedOpenSession =
    mcpParts[0] === "Open Session" && mcpParts.length > 2;
  const summary = toolSummary(toolName, callInput, entry.content, roots);
  const isFileTool =
    canonical === "Read" || canonical === "Edit" || canonical === "Write";
  const lineStats = toolLineStats(toolName, callInput);
  const duration = stepDuration(entry, result);
  const failed = Boolean(shownResult?.isError);
  // The language mark a file row wears in front of its path, the same one the
  // turn's file chips wear: the family glyph says a file was read or written,
  // and this says which kind of file, so a fold full of reads and edits is
  // scanned by language rather than by reading every path to its last word.
  // A name with no extension has no mark, and keeps the path it always had.
  const baseName = isFileTool
    ? (filePathOf((callInput || {}) as Record<string, unknown>)
        .split("/")
        .pop() ?? "")
    : "";
  const fileMark = fileExt(baseName) ? baseName : "";
  const resultContent = visibleResultContent(
    shownResult?.content,
    hasMedia,
    failed,
  );

  // A scratch file this call named: openable straight from the row, because
  // assets live outside every worktree and nothing else in the transcript can
  // say what the path means. A delete names one too, with nothing left to open.
  const assetPath = assetToolPath(toolName, callInput);
  const asset = useOpenAsset();
  const assetPaths = useOpenAssetPaths();
  const canOpenAsset =
    Boolean(assetPath && asset.available) && mcp?.tool !== "delete_asset";
  function showAsset() {
    asset.open(assetPath);
  }

  // A Task/Agent call whose sub-agent transcript we can open in the sidebar.
  // Claude-SDK results carry a structured agentId; pi's task tool only
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
    <div {...stylex.props(sx.relative)} data-eid={entry.id}>
      {/* Tool rows have no spare inline space for a timestamp, so reveal the
          call's wall-clock time on hover or keyboard focus. */}
      <Tooltip label={fullTime(entry.timestamp)}>
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => rememberExpansion(!expanded)}
          onMouseEnter={pending ? () => setDurationVisible(true) : undefined}
          onMouseLeave={pending ? () => setDurationVisible(false) : undefined}
          onFocus={pending ? () => setDurationVisible(true) : undefined}
          onBlur={pending ? () => setDurationVisible(false) : undefined}
          className={cn(
            // Baseline, not centre: the 14px tool name, the 13px mono path and
            // the 11px trailing meta all ride this row, and centring aligns
            // their boxes rather than their text. Items with no text baseline
            // (the glyph, the spinner, the failure mark) opt back into centring.
            utilityClassName(
              "group flex w-full min-w-0 cursor-pointer items-baseline gap-2 rounded-control border-0 bg-transparent px-1 py-[3px] text-left font-sans transition-colors",
            ),
            utilityClassName("hover:bg-hover/40"),
          )}
        >
          <span
            {...stylex.props(
              sx.relative,
              sx.z1,
              sx.flex,
              sx.size22px,
              sx.flexShrink0,
              sx.selfCenter,
              sx.itemsCenter,
              sx.justifyCenter,
              sx.textFaint,
            )}
          >
            <span
              {...mergeStylexProps(
                "group-hover:opacity-0",
                sx.transitionOpacity,
                sx.duration150,
              )}
            >
              <ToolGlyph toolName={toolName} size={20} />
            </span>
            <IconChevronDown
              size={20}
              className={cn(
                utilityClassName(
                  "absolute block text-dim opacity-0 transition-[opacity,transform] duration-150 group-hover:opacity-100",
                ),
                expanded && utilityClassName("rotate-180"),
              )}
            />
          </span>

          {mcp ? (
            // Most general part first, leaf last, and only the leaf at full
            // strength: down a fold of Open Session calls the product name is the
            // same on every row, so it should read as the path to the part that
            // differs rather than compete with it.
            <span
              {...mergeStylexProps(
                "group-hover:text-fg",
                sx.flex,
                sx.minW0,
                sx.itemsBaseline,
                sx.gap1,
                sx.overflowHidden,
                sx.leading5,
                sx.fontMedium,
                sx.textDim,
                sx.transitionColors,
                sx.phoneFlexShrink0,
                typography.itemTitle,
              )}
              title={mcpParts.join(" · ")}
            >
              {mcpParts.map((part, i) => {
                const context = i < mcpParts.length - 1;
                return (
                  <React.Fragment key={i}>
                    {i > 0 && (
                      <span
                        className={cn(
                          utilityClassName("flex-shrink-0 text-faint"),
                          scopedOpenSession &&
                            i === 1 &&
                            utilityClassName("phone:hidden"),
                        )}
                      >
                        ·
                      </span>
                    )}
                    <span
                      className={cn(
                        context
                          ? utilityClassName(
                              "flex-shrink-0 font-normal opacity-70",
                            )
                          : utilityClassName("truncate phone:flex-shrink-0"),
                        scopedOpenSession &&
                          i === 0 &&
                          utilityClassName("phone:hidden"),
                      )}
                    >
                      {part}
                    </span>
                  </React.Fragment>
                );
              })}
            </span>
          ) : (
            <span
              {...mergeStylexProps(
                "group-hover:text-fg",
                sx.flexShrink0,
                sx.leading5,
                sx.fontMedium,
                sx.textDim,
                sx.transitionColors,
                typography.itemTitle,
              )}
            >
              {toolName}
            </span>
          )}

          {/* Baseline, not centre: the path is mono and the ± counts are sans, so
            at one size their line boxes still centre to different baselines.
            The mark opts back out: it has no text baseline of its own, so
            aligning it to one hangs the drawn logo below the path it labels.
            Nothing grows into spare room here: changes and duration should
            follow the tool summary instead of lining up against the right edge. */}
          <span
            className={cn(
              utilityClassName("flex min-w-0 items-baseline gap-2"),
              mcp && utilityClassName("phone:hidden"),
            )}
          >
            <span
              {...stylex.props(sx.flex, sx.minW0, sx.itemsBaseline, sx.gap15)}
            >
              {fileMark && (
                <ExtBadge
                  name={fileMark}
                  className={mergeStylexOverrideClassName("", sx.selfCenter)}
                />
              )}
              <span
                className={cn(
                  utilityClassName("min-w-0 text-label leading-4 text-dim"),
                  isFileTool
                    ? utilityClassName("flex overflow-hidden")
                    : utilityClassName("truncate"),
                )}
              >
                {isFileTool ? <PathSummary path={summary} /> : summary}
              </span>
            </span>
            {lineStats && (
              <span
                {...stylex.props(
                  sx.flex,
                  sx.flexShrink0,
                  sx.gap15,
                  sx.leading4,
                  typography.label,
                )}
              >
                {lineStats.additions > 0 && (
                  <span {...stylex.props(sx.textGreen)}>
                    +{lineStats.additions}
                  </span>
                )}
                {lineStats.deletions > 0 && (
                  <span {...stylex.props(sx.textRed)}>
                    -{lineStats.deletions}
                  </span>
                )}
              </span>
            )}
          </span>

          {canOpenAsset && (
            // Never hover-gated: the artifact is the point of the call, and a
            // hover-only way to it doesn't exist on a phone at all.
            <span
              role="button"
              tabIndex={0}
              className={TOOL_ROW_CHIP}
              onClick={(e) => {
                e.stopPropagation();
                showAsset();
              }}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                e.stopPropagation();
                showAsset();
              }}
              title="Open this file"
            >
              Open
              <IconArrowUpRight
                className={mergeStylexOverrideClassName(
                  "",
                  sx.size4,
                  sx.shrink0,
                  sx.opacity70,
                )}
              />
            </span>
          )}

          {canOpenSubagent && (
            <span
              role="button"
              tabIndex={0}
              className={cn(
                TOOL_ROW_CHIP,
                utilityClassName(
                  "opacity-100 transition-[opacity,color,background-color] focus:opacity-100",
                ),
                !subagentLive &&
                  utilityClassName("md:opacity-0 md:group-hover:opacity-100"),
              )}
              onClick={(e) => {
                e.stopPropagation();
                onOpenSubagent!(agentId!, summary);
              }}
              title="Open this sub-agent's conversation"
            >
              {subagentLive ? "Watch" : "Open"}
              <IconArrowUpRight
                className={mergeStylexOverrideClassName(
                  "",
                  sx.size4,
                  sx.shrink0,
                  sx.opacity70,
                )}
              />
            </span>
          )}

          {!expanded &&
            hasMedia && (
              // The only sign a folded row is holding a screenshot. Always shown,
              // never hover-gated — hover isn't a way to discover anything on a
              // phone, and this is the whole discovery path now that incidental
              // media no longer opens its own row.
              <span className={TOOL_ROW_MEDIA_HINT}>{mediaLabel}</span>
            )}

          {duration && (
            <span
              {...mergeStylexProps(
                "tabular-nums",
                sx.flexShrink0,
                sx.textFaint,
                typography.meta,
              )}
            >
              {duration}
            </span>
          )}
          {pending && durationVisible && <RunningToolDuration entry={entry} />}

          {pending ? (
            // Neutral, not green: green on this row already means "added" (the
            // +N stat) and "passed" elsewhere, so a green ring on a step that can
            // still fail reads as a verdict instead of a state. Border written
            // one side at a time — a `border-color` shorthand next to a
            // `border-top-color` is a two-utilities-one-property race.
            <span
              {...stylex.props(
                sx.size11px,
                sx.flexShrink0,
                sx.selfCenter,
                sx.animateSpin,
                sx.roundedFull,
                sx.border,
                sx.borderBLineStrong,
                sx.borderLLineStrong,
                sx.borderRLineStrong,
                sx.borderTDim,
              )}
            />
          ) : !result ? (
            <span
              {...stylex.props(sx.flexShrink0, sx.textFaint, typography.meta)}
            >
              –
            </span>
          ) : null}
        </button>
      </Tooltip>

      <Fold open={expanded}>
        <div
          {...mergeStylexProps(
            "space-y-1.5",
            sx.relative,
            sx.z1,
            sx.mb15,
            sx.ml30px,
            sx.mt1,
          )}
        >
          <ToolInputDetail toolName={canonical} input={callInput} />
          {shownResult &&
            (resultContent ||
              shownResult.images?.length ||
              shownResult.videos?.length) && (
              <>
                {resultContent && (
                  <div className="space-y-1">
                    <div
                      {...stylex.props(
                        sx.px1,
                        sx.fontMedium,
                        sx.leading4,
                        sx.textFaint,
                        typography.meta,
                      )}
                    >
                      {failed ? "Error" : "Output"}
                    </div>
                    <div className={TOOL_CODE_WELL}>
                      {renderResultContent(
                        canonical,
                        shownInput,
                        resultContent,
                      )}
                    </div>
                  </div>
                )}
                {shownResult.images && shownResult.images.length > 0 && (
                  <div
                    className={cn(
                      TOOL_RESULT_MEDIA,
                      !resultContent && utilityClassName("!mt-0"),
                    )}
                  >
                    {shownResult.images.map((raw, i) => {
                      const src = resolveEntryImageSrc(raw, sessionId);
                      return (
                        <a
                          key={i}
                          href={src}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="md-image-link"
                        >
                          <img
                            className={cn(
                              "md-image",
                              !resultContent && utilityClassName("!my-0"),
                            )}
                            src={src}
                            alt=""
                            loading="lazy"
                          />
                        </a>
                      );
                    })}
                  </div>
                )}
                {shownResult.videos && shownResult.videos.length > 0 && (
                  <div className={TOOL_RESULT_MEDIA}>
                    {shownResult.videos.map((src, i) => {
                      // A recording the call saved to the scratch folder opens as
                      // that asset, so the file is one press from Download instead
                      // of something to hunt for in the Assets tab.
                      const videoAsset = assetPathForMediaSrc(src, assetPaths);
                      const opensAsset = Boolean(videoAsset) && asset.available;
                      return (
                        <div key={i} className="md-video-wrap">
                          <video
                            className="md-video"
                            src={src}
                            controls
                            playsInline
                            preload="metadata"
                          />
                          <button
                            type="button"
                            className="md-video-expand"
                            aria-label={opensAsset ? "Open asset" : "Expand"}
                            title={opensAsset ? "Open asset" : "Expand"}
                            onClick={(e) => {
                              if (opensAsset) {
                                asset.open(videoAsset!);
                                return;
                              }
                              const vid =
                                e.currentTarget.parentElement?.querySelector(
                                  "video",
                                );
                              if (vid) openGalleryFrom(vid);
                            }}
                          >
                            <IconExpand size={20} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
        </div>
      </Fold>
    </div>
  );
};

/** Drop engine acknowledgements when the media itself is the useful result. */
export function visibleResultContent(
  content: string | undefined,
  hasMedia: boolean,
  failed: boolean,
): string {
  if (!content) return "";
  if (
    !failed &&
    hasMedia &&
    /^Image read successfully\.?$/.test(content.trim())
  )
    return "";
  return content;
}

function ToolInputDetail({
  toolName,
  input,
}: {
  toolName: string;
  input: unknown;
}) {
  const inputNode = toolInputNode(toolName, input);
  if (!inputNode) return null;
  return (
    <div
      className={cn(
        toolName === "TodoWrite" &&
          utilityClassName("overflow-hidden rounded-lg bg-panel p-1.5"),
      )}
    >
      {inputNode}
    </div>
  );
}

/**
 * The call's input, rendered by what it is rather than as raw JSON where we
 * can: Bash as a highlighted script, Edit as a unified diff, Write as the file
 * content in the file's language. Everything else falls back to pretty JSON.
 * All variants sit on a code well (its own surface in both themes).
 */
function toolInputNode(
  toolName: string,
  input: unknown,
): React.ReactNode | null {
  const inp = (input && typeof input === "object" ? input : {}) as Record<
    string,
    unknown
  >;

  if (toolName === "Bash" && bashCommand(input)) {
    return (
      <div className={TOOL_CODE_WELL}>
        <CodeHighlight code={bashCommand(input)!} lang="bash" />
      </div>
    );
  }

  if (toolName === "Edit" || toolName === "Write") {
    // Replacement snippets become a real read-only diff: the same renderer,
    // syntax highlighting and changed-line treatment as Files changed. This
    // also covers multi-edit schemas (`edits: [{ oldText, newText }]`) that
    // used to fall through to a raw JSON payload.
    const inputDiff = toolInputDiff(toolName, input);
    if (inputDiff) return <ToolInputDiff patch={inputDiff.patch} />;

    // Codex apply_patch bodies are already diff-shaped, but not unified
    // patches that @pierre/diffs can parse. Keep their highlighted fallback.
    const patch = pickStr(inp, "patchText", "patch");
    if (patch) {
      return (
        <div className={TOOL_CODE_WELL}>
          <ExpandableCode code={patch} lang="diff" />
        </div>
      );
    }
  }

  // The plan is a checklist, not a payload — render it as one (same component
  // the status flap above the composer uses).
  if (toolName === "TodoWrite") {
    const items = parsePlanItems(input);
    if (items.length > 0)
      return (
        <PlanChecklist
          items={items}
          className={mergeStylexOverrideClassName("", sx.px1, sx.py15)}
        />
      );
  }

  // Read's input is fully covered by the row summary (plus offset/limit when
  // present — only show those).
  if (toolName === "Read") {
    const extras = Object.entries(inp).filter(
      ([k]) =>
        k !== "file_path" && k !== "filePath" && !isHiddenToolInputKey(k),
    );
    if (extras.length === 0) return null;
    return (
      <pre className={cn(TOOL_PRE, TOOL_CODE_WELL)}>
        {extras.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")}
      </pre>
    );
  }

  const text = formatInput(input);
  if (!text) return null;
  return <ExpandablePre text={text} className={cn(TOOL_PRE, TOOL_CODE_WELL)} />;
}

/**
 * Tool outputs that carry code get syntax highlighting: Read (cat -n format,
 * lang from file_path) and Grep content output (rg -n format, lang inferred
 * from path/glob/type — only highlighted when the gutter format is detected,
 * so file-list output stays plain).
 */
function renderResultContent(
  toolName: string,
  input: unknown,
  content: string,
) {
  const text = content;
  const lang =
    toolName === "Read"
      ? langForFile(filePathOf((input || {}) as Record<string, unknown>))
      : toolName === "Grep"
        ? langForGrep(input)
        : null;
  if (lang) {
    return (
      <ExpandableCode
        code={text}
        lang={lang}
        gutter
        requireGutter={toolName === "Grep"}
      />
    );
  }
  // Unified diffs (git diff/show in Bash output) highlight as diff
  if (
    toolName === "Bash" &&
    (text.startsWith("diff --git") || /^@@ -\d/m.test(text))
  ) {
    return <ExpandableCode code={text} lang="diff" />;
  }
  return <ExpandablePre text={text} className={TOOL_PRE} />;
}

const TOOL_DETAIL_PREVIEW_CHARS = 32 * 1024;

function detailPreview(text: string): string {
  if (text.length <= TOOL_DETAIL_PREVIEW_CHARS) return text;
  const slice = text.slice(0, TOOL_DETAIL_PREVIEW_CHARS);
  const newline = slice.lastIndexOf("\n");
  return `${newline > TOOL_DETAIL_PREVIEW_CHARS / 2 ? slice.slice(0, newline) : slice}\n…`;
}

function DetailDisclosure({
  expanded,
  length,
  onClick,
}: {
  expanded: boolean;
  length: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      {...stylex.props(
        sx.mt1,
        sx.roundedControl,
        sx.border0,
        sx.bgTransparent,
        sx.px15,
        sx.py1,
        sx.fontSans,
        sx.fontMedium,
        sx.textFaint,
        sx.hoverBgHover40,
        sx.hoverTextFg,
        typography.meta,
      )}
      onClick={onClick}
    >
      {expanded
        ? "Show preview"
        : `Show full detail · ${Math.round(length / 1024)} KB`}
    </button>
  );
}

function ExpandableCode(props: {
  code: string;
  lang: string;
  gutter?: boolean;
  requireGutter?: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const long = props.code.length > TOOL_DETAIL_PREVIEW_CHARS;
  return (
    <>
      <CodeHighlight
        {...props}
        code={showAll ? props.code : detailPreview(props.code)}
      />
      {long && (
        <DetailDisclosure
          expanded={showAll}
          length={props.code.length}
          onClick={() => setShowAll(!showAll)}
        />
      )}
    </>
  );
}

function ExpandablePre({
  text,
  className,
}: {
  text: string;
  className: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const long = text.length > TOOL_DETAIL_PREVIEW_CHARS;
  return (
    <>
      <pre className={className}>{showAll ? text : detailPreview(text)}</pre>
      {long && (
        <DetailDisclosure
          expanded={showAll}
          length={text.length}
          onClick={() => setShowAll(!showAll)}
        />
      )}
    </>
  );
}

function isBoundedToolInput(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  return (
    typeof value.toolName === "string" &&
    typeof value.byteSize === "number" &&
    Array.isArray(value.keys)
  );
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
    if (isHiddenToolInputKey(key)) continue;
    comments.push(`# ${key}: ${JSON.stringify(value)}`);
  }
  return [...comments, command].join("\n");
}

function formatInput(input: unknown): string {
  if (!input) return "";
  if (typeof input === "string") return input;
  if (typeof input === "object" && !Array.isArray(input)) {
    const visible = Object.fromEntries(
      Object.entries(input as Record<string, unknown>).filter(
        ([k]) => !isHiddenToolInputKey(k),
      ),
    );
    return JSON.stringify(visible, null, 2);
  }
  return JSON.stringify(input, null, 2);
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + "…";
}
