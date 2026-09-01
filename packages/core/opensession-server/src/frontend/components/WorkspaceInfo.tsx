import { mergeStylexProps, mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import { AGENT_NAME, GITHUB_BOT_NAME } from "../lib/brand";
import { BASE_PATH } from "../lib/base";
import { commitPrompt } from "../lib/commit-prompt";
import { useEffect, useEffectEvent, useState, type ReactNode } from "react";
import { parsePatchFiles } from "@pierre/diffs";
import type { FileDiffMetadata } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { useResolvedTheme } from "./CodeHighlight";
import {
  setSessionReviewerApi,
  acceptReviewApi,
  cancelPrReviewApi,
  triggerPrActionApi,
  sessionAssetPreviewUrl,
  type PrAgentAction,
  type WorkspaceCommit,
  type WorkspaceMediaItem,
  type SessionAssetFile,
} from "../lib/api";
import { assetPreviewKind, isVisualAsset } from "../lib/asset-preview";
import { useAssetViewMode } from "../lib/asset-view-mode";
import { AssetViewToggle } from "./AssetViewToggle";
import { PR_WEBHOOK_FALLBACK_POLL_MS } from "../lib/poll";
import {
  useSessionDiffResource,
  useSessionGitResource,
  useSessionPrResource,
  useWorkspaceOverviewResource,
} from "../hooks/useApiResources";
import { getCurrentUser, TEAM, useCurrentUser } from "./UserPicker";
import { personNameForKey, usePeople, useReviewTeams } from "../lib/people";
import { UserAvatar } from "./UserAvatar";
import { Menu } from "../ui/menu";
import { Popover } from "../ui/popover";
import { cn } from "../ui/cn";
import type {
  DiffFile,
  GitStatusInfo,
  PrDetails,
  UnifiedSession,
  WSClientMessage,
} from "../lib/types";
import { formatPrCommentPrompt } from "../lib/pr-prompts";
import { renderMarkdown } from "../lib/markdown";
import { fullTime } from "../lib/time";
import { errorMessage } from "../lib/error-message";
import {
  isMachinePrComment,
  isOutdatedReviewComment,
} from "../lib/pr-comments";
import { personKey, reviewRequestTargetsPerson } from "../lib/review-queue";
import { MarkdownBody, useMarkdownRepo } from "./MarkdownBody";
import type { OverviewSessionRef } from "../lib/workspace-overview";
import {
  GIT_ACTION,
  GIT_ACTION_CARET,
  gitActionClass,
  GIT_DOT,
  GIT_DOT_BG,
  GIT_LABEL,
  GIT_NOTE,
  GIT_ROW,
} from "../lib/pr-tone-classes";
import {
  INFO_LABEL_CLASS,
  INFO_LIST_CLASS,
  INFO_SECTION_CLASS,
} from "../lib/session-viewer-classes";
import { openLightbox } from "../lib/media-lightbox";
import { SandboxBadge } from "./SandboxBadge";
import {
  IconBell,
  IconCheck,
  IconChevronDown,
  IconFile,
  IconGitCommit,
  IconPeople,
  IconPlay,
  IconPlayRectangle,
  IconPullRequest,
  IconRobot,
  IconStack,
} from "./icons";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  size4px: {
    width: "4px",
    height: "4px",
  },
  roundedFull: {
    borderRadius: "calc(infinity * 1px)",
    cornerShape: "round",
  },
  bgCurrent: {
    backgroundColor: "currentcolor",
  },
  size6: {
    width: "calc(4px * 6)",
    height: "calc(4px * 6)",
  },
  shrink0: {
    flexShrink: "0",
  },
  border: {
    borderStyle: "solid",
    borderWidth: "1px",
  },
  borderLine: {
    borderColor: "var(--border)",
  },
  objectCover: {
    objectFit: "cover",
  },
  bgActive: {
    backgroundColor: "var(--bg-active)",
  },
  grid: {
    display: "grid",
  },
  placeItemsCenter: {
    placeItems: "center",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  textWhite: {
    color: "var(--color-white)",
  },
  absolute: {
    position: "absolute",
  },
  right15: {
    right: "calc(4px * 1.5)",
  },
  top12: {
    top: "calc(1 / 2 * 100%)",
  },
  z1: {
    zIndex: "1",
  },
  TranslateY12: {
    translate: "0 calc(calc(1 / 2 * 100%) * -1)",
  },
  roundedControl: {
    borderRadius: "calc(12px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  borderLineStrong: {
    borderColor: "var(--border-strong)",
  },
  bgPanel: {
    backgroundColor: "var(--bg-panel)",
  },
  px2: {
    paddingInline: "calc(4px * 2)",
  },
  py05: {
    paddingBlock: "calc(4px * 0.5)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  opacity0: {
    opacity: "0%",
  },
  transitionOpacity: {
    transitionProperty: "opacity",
    transitionTimingFunction: "var(--tw-ease, var(--ease))",
    transitionDuration: "var(--tw-duration, var(--dur-micro))",
  },
  duration150: {
    transitionDuration: "150ms",
  },
  hoverBorderFaint: {
    "@media (hover: hover)": {
      ":hover": {
        borderColor: "var(--text-faint)",
      },
    },
  },
  hoverBgHover: {
    "@media (hover: hover)": {
      ":hover": {
        backgroundColor: "var(--hover)",
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
  relative: {
    position: "relative",
  },
  flex: {
    display: "flex",
  },
  minW0: {
    minWidth: "0",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  roundedMd: {
    borderRadius: "calc(7px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  py5px: {
    paddingBlock: "5px",
  },
  textLeft: {
    textAlign: "left",
  },
  transitionColors: {
    transitionProperty:
      "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to",
    transitionTimingFunction: "var(--tw-ease, var(--ease))",
    transitionDuration: "var(--tw-duration, var(--dur-micro))",
  },
  flex1: {
    flex: "1",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  leading135: {
    lineHeight: "1.35",
  },
  textFg: {
    color: "var(--text)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  maxHMin560px70vhVarAvailableHeight: {
    maxHeight: "min(560px, 70vh, var(--available-height))",
  },
  wMin440pxCalc100vw24px: {
    width: "min(440px, calc(100vw - 24px))",
  },
  cursorPointer: {
    cursor: "pointer",
  },
  gap9px: {
    gap: "9px",
  },
  overflowHidden: {
    overflow: "hidden",
  },
  px3: {
    paddingInline: "calc(4px * 3)",
  },
  py11px: {
    paddingBlock: "11px",
  },
  contents: {
    display: "contents",
  },
  minH0: {
    minHeight: "0",
  },
  flexCol: {
    flexDirection: "column",
  },
  mb15: {
    marginBottom: "calc(4px * 1.5)",
  },
  itemsBaseline: {
    alignItems: "baseline",
  },
  justifyBetween: {
    justifyContent: "space-between",
  },
  mb5px: {
    marginBottom: "5px",
  },
  overflowYAuto: {
    overflowY: "auto",
  },
  size4: {
    width: "calc(4px * 4)",
    height: "calc(4px * 4)",
  },
  inlineFlex: {
    display: "inline-flex",
  },
  gap1: {
    gap: "4px",
  },
  textGreen: {
    color: "var(--green)",
  },
  textRed: {
    color: "var(--red)",
  },
  maxWFull: {
    maxWidth: "100%",
  },
  maxHMin720px82vhVarAvailableHeight: {
    maxHeight: "min(720px, 82vh, var(--available-height))",
  },
  wMin720pxCalc100vw24px: {
    width: "min(720px, calc(100vw - 24px))",
  },
  py25: {
    paddingBlock: "calc(4px * 2.5)",
  },
  mb2: {
    marginBottom: "calc(4px * 2)",
  },
  overflowAuto: {
    overflow: "auto",
  },
  Mr1: {
    marginRight: "calc(4px * -1)",
  },
  mlAuto: {
    marginLeft: "auto",
  },
  transitionColorBackgroundColor: {
    transitionProperty: "color,background-color",
    transitionTimingFunction: "var(--tw-ease, var(--ease))",
    transitionDuration: "var(--tw-duration, var(--dur-micro))",
  },
  disabledOpacity50: {
    ":disabled": {
      opacity: "50%",
    },
  },
  minW280px: {
    minWidth: "280px",
  },
  itemsStart: {
    alignItems: "flex-start",
  },
  py2: {
    paddingBlock: "calc(4px * 2)",
  },
  mt05: {
    marginTop: "calc(4px * 0.5)",
  },
  maxHMin680pxCalc100vh24pxVarAvailableHeight: {
    maxHeight: "min(680px, calc(100vh - 24px), var(--available-height))",
  },
  wMin680pxCalc100vw24pxVarAvailableWidth: {
    width: "min(680px, calc(100vw - 24px), var(--available-width))",
  },
  wFull: {
    width: "100%",
  },
  gap25: {
    gap: "calc(4px * 2.5)",
  },
  borderB: {
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
  },
  borderDivider: {
    borderColor: "var(--divider)",
  },
  px4: {
    paddingInline: "calc(4px * 4)",
  },
  py3: {
    paddingBlock: "calc(4px * 3)",
  },
  underline: {
    textDecorationLine: "underline",
  },
  decorationLineStrong: {
    textDecorationColor: "var(--border-strong)",
  },
  underlineOffset2: {
    textUnderlineOffset: "2px",
  },
  minW200px: {
    minWidth: "200px",
  },
  size22px: {
    width: "22px",
    height: "22px",
  },
  pb1: {
    paddingBottom: "4px",
  },
  overflowXAuto: {
    overflowX: "auto",
  },
  overflowYHidden: {
    overflowY: "hidden",
  },
  roundedLg: {
    borderRadius: "calc(14px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  p3: {
    padding: "calc(4px * 3)",
  },
  ScrollPaddingLeft12px: {
    scrollPaddingLeft: "12px",
  },
  ScrollbarWidthNone: {
    scrollbarWidth: "none",
  },
  block: {
    display: "block",
  },
  aspectVideo: {
    aspectRatio: "var(--aspect-video)",
  },
  roundedCalc14pxVarRf12px: {
    borderRadius: "calc(14px * var(--rf) - 12px)",
    cornerShape: "var(--cs)",
  },
  bgSurface: {
    backgroundColor: "var(--bg)",
  },
  hFull: {
    height: "100%",
  },
  objectContain: {
    objectFit: "contain",
  },
  pointerEventsNone: {
    pointerEvents: "none",
  },
  inset0: {
    inset: "0",
  },
  size8: {
    width: "calc(4px * 8)",
    height: "calc(4px * 8)",
  },
  bgBlack45: {
    backgroundColor: "color-mix(in oklab, var(--color-black) 45%, transparent)",
  },
  gap4: {
    gap: "calc(4px * 4)",
  },
  pb22px: {
    paddingBottom: "22px",
  },
  pt3: {
    paddingTop: "calc(4px * 3)",
  },
  flexWrap: {
    flexWrap: "wrap",
  },
  gap15: {
    gap: "calc(4px * 1.5)",
  },
  hoverBorderLineStrong: {
    "@media (hover: hover)": {
      ":hover": {
        borderColor: "var(--border-strong)",
      },
    },
  },
  lineClamp2: {
    overflow: "hidden",
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: "2",
  },
  leadingSnug: {
    lineHeight: "var(--leading-snug)",
  },
});

/**
 * Workspace info block at the top of the right side panel (the "Info" tab): a
 * dense, at-a-glance catch-all - workspace actions, local git
 * state, PR comments, changed files, and a compact filmstrip of every screenshot
 * / video from the workspace's sessions. PR state and local git deltas share one
 * compact Git status section; the transcript remains the opening-prompt source.
 *
 * Loading/caching for the overview lives in lib/workspace-overview (shared with
 * the sidebar's workspace hover card), including the pre-restart transcript
 * fallbacks. The PR is fetched here and refreshed on a slow interval.
 */

type PanelTab = "changes" | "pr" | "staging" | "assets";

type ReviewRequestInfo = {
  to: string;
  recipients?: string[];
  by: string;
  at: string;
  accepted?: { by: string; at: string };
};

interface Props {
  /** The open session's session id — anchors the PR + Slack fetches. */
  sessionId: string;
  /** The session's workspace (workspaceId); null = workspace-less (fallback only). */
  workspaceId: string | null;
  /** Sibling sessions, oldest first (the tab strip's list). */
  sessions: Array<OverviewSessionRef & { startedBy?: string | null }>;
  /** Primary repo the workspace's sessions work in. */
  repo?: string;
  /** PR lane state, when the session has a PR — gates the PR fetch. */
  prState?: string | null;
  /** Bumped when a GitHub webhook reports activity for this workspace's PR. */
  refreshTick?: number;
  /** The open session's sandbox opt-in — renders a provider/mode badge in the
	    status row (from session fields only; no container polling). */
  sandbox?: {
    provider: string;
    sandboxId?: string;
    workspace?: "bind" | "volume";
  };
  /** Pending review request for this workspace — the open session's, or a sibling
	    session's (the request is per-session but the band groups by workspace). */
  reviewRequest?: ReviewRequestInfo | null;
  /** The session that owns `reviewRequest` (may be a sibling, not the open one). */
  reviewRequestSessionId?: string;
  /** GitHub's requested reviewers on this workspace's PR (person keys) — the
	    other way a review lands on you, alongside `reviewRequest`. */
  prReviewRequested?: string[];
  /** The request is complete because its reviewer submitted a GitHub review. */
  reviewAcceptedFromPr?: boolean;
  /** Optimistically push a reviewer pick / sign-off into the app-level session
	    list, so the sidebar's review bands + the other chip instance flip at once
	    instead of waiting up to a poll (~5s) for the change to round-trip. */
  onReviewChange?: (sessionId: string, req: ReviewRequestInfo | null) => void;
  /** Jump to a sibling tab when a status chip / reply row is clicked. */
  onOpenTab?: (tab: PanelTab) => void;
  /** The session's scratch assets — listed in the Info panel; clicking one
	    opens the full-width Assets view-tab focused on that file. */
  assets?: SessionAssetFile[];
  /** Open the Assets view-tab focused on a specific asset (a list-row click). */
  onOpenAsset?: (path: string) => void;
  /** Prefill the composer (the per-comment "Add to session" hover action). */
  onAddToInput?: (text: string) => void;
  /** Navigate to a session — used by Auto-fix, which spins up a new session in this
	    workspace and jumps into it. `created` is the server's copy of a session this
	    panel just made, so the caller can open it without a loading placeholder. */
  onOpenSession?: (id: string, created?: UnifiedSession | null) => void;
  /** Prompt the session (the Status section's Commit action) — the WS `prompt`
	    message. Absent in read-only mounts, where Commit is simply hidden. */
  send?: (msg: WSClientMessage) => void;
  /** Media items currently in the open session's live entries — bumps refresh
	    the panel as new screenshots land during a run. */
  liveMediaCount: number;
  /** Images visible in the session UI before the transcript-backed overview catches up. */
  liveMedia?: WorkspaceMediaItem[];
}

/** A Review row's own status band, for the one state that is addressed to the
    reader. A band is pre-attentive only while its absence is the norm: with a
    tinted strip above and a band on every row, nothing read without being read
    and the panel was a stack of coloured fields. So the band is reserved for
    "this wants you" — a blocking reading, a review waiting on you — and every
    settled state carries its colour on the words and the row's own action
    instead, which is where a row is read anyway. */
type ReviewTone = "green" | "yellow" | "red" | "blue" | "muted";
const reviewBand = (tone: ReviewTone): string =>
  tone === "red" ? "bg-red-soft" : "";

/** The leading visual on a Review row: the box a `UserAvatar size={20}` fills,
    so a glyph and a face line up down the section. */
const REVIEW_FACE = utilityClassName(
  "inline-flex size-5 shrink-0 items-center justify-center [&_svg]:block",
);
const INFO_MORE_BUTTON_CLASS = utilityClassName(
  "cursor-pointer bg-panel px-2 py-[7px] text-left text-label font-semibold text-faint transition-colors hover:bg-hover hover:text-fg",
);

function initial(name: string): string {
  return (name.trim()[0] || "?").toUpperCase();
}
function hueFor(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}
/** Flatten a GitHub markdown/HTML comment body into a clean one-glance
		preview: drop HTML comments/tags, collapse markdown emphasis + headings,
		turn links into their label, squash whitespace. */
function plainComment(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, "") // HTML comments (bot markers)
    .replace(/<[^>]+>/g, "") // HTML tags
    .replace(/```[\s\S]*?```/g, " ") // fenced code blocks
    .replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, "") // link-ref defs (Vercel [vc]: #…)
    .replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, "") // markdown table separator rows
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → label
    .replace(/^#{1,6}\s+/gm, "") // heading markers
    .replace(/\s*\|\s*/g, " · ") // table cells → separators
    .replace(/[*_`>]/g, "") // emphasis / code / quote marks
    .replace(/(?:\s·\s)+/g, " · ") // collapse repeated separators
    .replace(/^[\s·]+|[\s·]+$/g, "") // trim leading/trailing separators
    .replace(/\s+/g, " ")
    .trim();
}

/** Clean a GitHub comment body for markdown rendering: drop bot markers and
		link-ref noise, and downgrade raw HTML to equivalent markdown (our renderer
		escapes raw tags for safety, so <h3>/<br>/etc. would otherwise show as
		literal text) — while KEEPING real markdown structure (headings, lists,
		tables, code fences, line breaks). */
function cleanCommentMarkdown(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, "") // HTML comments (bot markers)
    .replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, "") // link-ref defs (Vercel [vc]: #…)
    .replace(
      /<h([1-6])[^>]*>\s*([\s\S]*?)<\/h\1>/gi,
      (_m, _n, t) => `\n### ${t.trim()}\n`,
    )
    .replace(/<br\s*\/?>/gi, "\n") // explicit line breaks
    .replace(/<\/(p|div|li|tr|table|ul|ol|details)>/gi, "\n") // block ends → break
    .replace(/<[^>]+>/g, "") // remaining tags → keep inner text
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** A dot: the mark for a file that already existed and was edited. Sized to
		read as punctuation next to the ± counts rather than as a second glyph. */
const STATUS_DOT = (
  <span
    {...stylex.props(sx.size4px, sx.roundedFull, sx.bgCurrent)}
    aria-hidden
  />
);
/**
 * What the run did to the file, as a mark rather than a letter. A list of
 * changes is nearly always all modifications, and a column of `M`s spends the
 * row's loudest pixel saying the one thing every row already agreed on; the
 * dots settle into that column quietly, and the plus or minus on the one file
 * the run created or removed is what stands out. `untracked` is a file git
 * hasn't been told about yet, which to a reader is simply new.
 */
const STATUS_MARK: Record<
  DiffFile["status"],
  { label: string; glyph: ReactNode; className: string }
> = {
  added: {
    label: "Added",
    glyph: "+",
    className: utilityClassName("bg-green-soft text-green"),
  },
  untracked: {
    label: "Added",
    glyph: "+",
    className: utilityClassName("bg-green-soft text-green"),
  },
  // No tile and no hue: a list of changes is nearly always all
  // modifications, so a tinted square on every row paints a column of colour
  // that says the one thing every row already agreed on. The dot keeps the
  // column's alignment and gives the `+` on the one created file somewhere
  // to stand out against.
  modified: {
    label: "Modified",
    glyph: STATUS_DOT,
    className: utilityClassName("text-faint"),
  },
  deleted: {
    label: "Deleted",
    glyph: "−",
    className: utilityClassName("bg-red-soft text-red"),
  },
  renamed: {
    label: "Renamed",
    glyph: "→",
    className: utilityClassName("bg-accent-soft text-accent"),
  },
};

function relTime(iso?: string): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

// How many file rows / comments the compact preview shows before deferring to
// the drill-down tab.
const FILE_PREVIEW = 6;
const COMMENT_PREVIEW = 3;

/** The author's real GitHub avatar (a review bot, a deploy bot, a human…),
		served at github.com/<login>.png. Falls back to a lettered brand tile if the
		image 404s or the author isn't a plausible login (e.g. a display name). */
function CommentAvatar({ author }: { author: string }) {
  const login = (author || "").trim();
  // GitHub usernames/app slugs: alphanumerics with single interior hyphens,
  // ≤39 chars — skips display names with spaces so we don't 404 on those.
  const canAvatar = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(login);
  const [failed, setFailed] = useState(false);
  if (canAvatar && !failed) {
    return (
      <img
        {...stylex.props(
          sx.size6,
          sx.shrink0,
          sx.roundedFull,
          sx.border,
          sx.borderLine,
          sx.objectCover,
          sx.bgActive,
        )}
        src={`https://github.com/${login}.png?size=48`}
        alt=""
        aria-hidden
        loading="lazy"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span
      {...stylex.props(
        sx.grid,
        sx.size6,
        sx.shrink0,
        sx.placeItemsCenter,
        sx.roundedFull,
        sx.border,
        sx.borderLine,
        sx.bgActive,
        sx.fontSemibold,
        sx.textWhite,
        typography.meta,
      )}
      style={{ background: `hsl(${hueFor(login || "?")} 52% 42%)` }}
      aria-hidden
    >
      {initial(login || "?")}
    </span>
  );
}

/** One PR comment as a single dense row: avatar · one-line title · time. The
		title is the flattened first slice of the body, ellipsised. Hovering floats
		the full markdown comment in a popover on top (never shifting the list); a
		hover "Add to session" drops it into the composer; clicking opens the PR tab. */
function CommentCard({
  comment,
  pr,
  onOpenTab,
  onAddToInput,
}: {
  comment: { author: string; body: string; url?: string; createdAt?: string };
  pr: PrDetails;
  onOpenTab?: (tab: PanelTab) => void;
  onAddToInput?: (text: string) => void;
}) {
  const repo = useMarkdownRepo();
  const html = renderMarkdown(cleanCommentMarkdown(comment.body), { repo });
  // The one-line label: lead with the comment's title/first words, flattened.
  const title = plainComment(comment.body);

  const addBtn = onAddToInput && (
    <button
      type="button"
      {...mergeStylexProps(
        "group-hover:opacity-100",
        sx.absolute,
        sx.right15,
        sx.top12,
        sx.z1,
        sx.TranslateY12,
        sx.roundedControl,
        sx.border,
        sx.borderLineStrong,
        sx.bgPanel,
        sx.px2,
        sx.py05,
        sx.fontSemibold,
        sx.textDim,
        sx.opacity0,
        sx.transitionOpacity,
        sx.duration150,
        sx.hoverBorderFaint,
        sx.hoverBgHover,
        sx.hoverTextFg,
        typography.meta,
      )}
      onClick={(e) => {
        e.stopPropagation();
        onAddToInput(formatPrCommentPrompt(comment, pr));
      }}
      aria-label="Add this comment to the session composer"
    >
      Add to session
    </button>
  );
  const avatar = <CommentAvatar author={comment.author} />;

  return (
    <Popover.Root>
      <Popover.Trigger
        render={<div />}
        nativeButton={false}
        openOnHover
        delay={200}
        closeDelay={90}
        className={mergeStylexOverrideClassName(
          "group",
          sx.relative,
          sx.flex,
          sx.minW0,
          sx.itemsCenter,
          sx.gap2,
          sx.roundedMd,
          sx.px2,
          sx.py5px,
          sx.textLeft,
          sx.transitionColors,
          sx.hoverBgHover,
        )}
        role="button"
        tabIndex={0}
        onClick={() => onOpenTab?.("pr")}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") onOpenTab?.("pr");
        }}
        aria-label={`Comment by ${comment.author}`}
      >
        {avatar}
        <span
          {...stylex.props(
            sx.minW0,
            sx.flex1,
            sx.truncate,
            sx.fontMedium,
            sx.leading135,
            sx.textFg,
            typography.supporting,
          )}
        >
          {title}
        </span>
        <span {...stylex.props(sx.shrink0, sx.textFaint, typography.meta)}>
          {relTime(comment.createdAt)}
        </span>
        {addBtn}
      </Popover.Trigger>
      <Popover.Popup
        side="left"
        align="start"
        sideOffset={10}
        elevation="lg"
        className={mergeStylexOverrideClassName(
          "",
          sx.flex,
          sx.maxHMin560px70vhVarAvailableHeight,
          sx.wMin440pxCalc100vw24px,
          sx.cursorPointer,
          sx.gap9px,
          sx.overflowHidden,
          sx.bgPanel,
          sx.px3,
          sx.py11px,
        )}
      >
        <div {...stylex.props(sx.contents)} onClick={() => onOpenTab?.("pr")}>
          {avatar}
          <div {...stylex.props(sx.flex, sx.minH0, sx.flex1, sx.flexCol)}>
            <div
              {...stylex.props(
                sx.mb15,
                sx.flex,
                sx.minW0,
                sx.itemsBaseline,
                sx.justifyBetween,
                sx.gap2,
              )}
            >
              <span
                {...stylex.props(
                  sx.minW0,
                  sx.truncate,
                  sx.fontSemibold,
                  sx.textFaint,
                  typography.meta,
                )}
              >
                {comment.author}
              </span>
              {comment.createdAt && (
                <span
                  {...stylex.props(sx.shrink0, sx.textFaint, typography.meta)}
                >
                  {relTime(comment.createdAt)}
                </span>
              )}
            </div>
            <div
              {...stylex.props(sx.mb5px, sx.minH0, sx.flex1, sx.overflowYAuto)}
            >
              <MarkdownBody html={html} className="markdown" />
            </div>
          </div>
        </div>
      </Popover.Popup>
    </Popover.Root>
  );
}

/** Read-only render options for the hover diff — no line selection, our own
		header owns the file name, unified view themed to the app appearance. */
const PREVIEW_DIFF_OPTIONS = {
  diffStyle: "unified" as const,
  disableFileHeader: true,
  overflow: "scroll" as const,
  enableLineSelection: false,
};

/** One commit attributed to this workspace. The title is the useful identity;
 * the file count confirms that completed work still exists after the branch
 * diff becomes empty. */
function CommitRow({ commit }: { commit: WorkspaceCommit }) {
  const content = (
    <>
      <span
        {...stylex.props(
          sx.grid,
          sx.size4,
          sx.shrink0,
          sx.placeItemsCenter,
          sx.textFaint,
        )}
      >
        <IconGitCommit size={20} />
      </span>
      <span
        {...stylex.props(
          sx.minW0,
          sx.flex1,
          sx.truncate,
          sx.textFg,
          typography.label,
        )}
      >
        {commit.title}
      </span>
      <span
        {...mergeStylexProps(
          "tabular-nums",
          sx.shrink0,
          sx.fontMedium,
          sx.textDim,
          typography.meta,
        )}
      >
        {commit.filesChanged} file{commit.filesChanged === 1 ? "" : "s"}
      </span>
    </>
  );
  const title = `${commit.title} · ${commit.sha.slice(0, 8)} · ${fullTime(commit.committedAt)}`;
  const className = utilityClassName(
    "flex min-w-0 items-center gap-2 rounded-md px-2 py-[5px] text-left no-underline transition-colors hover:bg-hover",
  );
  return commit.url ? (
    <a
      className={className}
      href={commit.url}
      target="_blank"
      rel="noopener"
      title={title}
    >
      {content}
    </a>
  ) : (
    <div className={className} title={title}>
      {content}
    </div>
  );
}

/**
 * One "file changed" row. Hovering reveals a floated card with the file's actual
 * diff (parsed from the primary repo's patch), mirroring the PR-comment hover in
 * the same panel; clicking still jumps to the full Changes tab. Rows whose file
 * isn't in the parsed patch (binary, or a not-yet-loaded/truncated patch) simply
 * don't open a popover.
 */
function FileRow({
  file,
  meta,
  theme,
  onOpenTab,
}: {
  file: DiffFile;
  meta: FileDiffMetadata | undefined;
  theme: "light" | "dark";
  onOpenTab?: (tab: PanelTab) => void;
}) {
  const slash = file.path.lastIndexOf("/");
  const dir = slash >= 0 ? file.path.slice(0, slash + 1) : "";
  const base = slash >= 0 ? file.path.slice(slash + 1) : file.path;
  const options = {
    ...PREVIEW_DIFF_OPTIONS,
    theme: theme === "light" ? "pierre-light" : "pierre-dark",
    themeType: theme,
  };
  const stats = (
    <span
      {...mergeStylexProps(
        "tabular-nums",
        sx.inlineFlex,
        sx.shrink0,
        sx.itemsCenter,
        sx.gap1,
        sx.fontSemibold,
        typography.meta,
      )}
    >
      {file.additions > 0 && (
        <span {...stylex.props(sx.textGreen)}>+{file.additions}</span>
      )}
      {file.deletions > 0 && (
        <span {...stylex.props(sx.textRed)}>−{file.deletions}</span>
      )}
    </span>
  );
  // The directory is what gives, not the filename: a path long enough to cut
  // is cut in the middle, so the name — the part being read — stays whole.
  const path = (
    <span
      {...stylex.props(
        sx.flex,
        sx.minW0,
        sx.flex1,
        sx.itemsBaseline,
        sx.textLeft,
        typography.label,
      )}
    >
      {dir && <span {...stylex.props(sx.truncate, sx.textDim)}>{dir}</span>}
      <span {...stylex.props(sx.maxWFull, sx.shrink0, sx.truncate, sx.textFg)}>
        {base}
      </span>
    </span>
  );
  const mark = STATUS_MARK[file.status];

  return (
    <Popover.Root>
      <Popover.Trigger
        openOnHover={Boolean(meta)}
        delay={200}
        closeDelay={90}
        type="button"
        className={mergeStylexOverrideClassName(
          "",
          sx.flex,
          sx.minW0,
          sx.itemsCenter,
          sx.gap2,
          sx.roundedMd,
          sx.px2,
          sx.py5px,
          sx.textLeft,
          sx.transitionColors,
          sx.hoverBgHover,
        )}
        onClick={() => onOpenTab?.("changes")}
        aria-label={`${file.path} · ${mark.label.toLowerCase()} · open in Changes`}
      >
        <span
          className={cn(
            // An even box around an even dot: 15px left half-pixels on
            // both axes, which at Retina reads as a dot sitting off
            // its own tile.
            utilityClassName(
              "inline-flex size-4 shrink-0 items-center justify-center rounded-md text-meta font-bold leading-none",
            ),
            mark.className,
          )}
          title={mark.label}
          aria-hidden
        >
          {mark.glyph}
        </span>
        {path}
        {stats}
      </Popover.Trigger>
      {meta && (
        <Popover.Popup
          side="left"
          align="start"
          sideOffset={10}
          elevation="lg"
          className={mergeStylexOverrideClassName(
            "",
            sx.flex,
            sx.maxHMin720px82vhVarAvailableHeight,
            sx.wMin720pxCalc100vw24px,
            sx.cursorPointer,
            sx.flexCol,
            sx.overflowHidden,
            sx.bgPanel,
            sx.px3,
            sx.py25,
          )}
        >
          <div
            {...stylex.props(
              sx.flex,
              sx.minH0,
              sx.flex1,
              sx.flexCol,
              sx.overflowHidden,
            )}
            onClick={() => onOpenTab?.("changes")}
          >
            <div
              {...stylex.props(
                sx.mb2,
                sx.flex,
                sx.minW0,
                sx.itemsBaseline,
                sx.justifyBetween,
                sx.gap2,
              )}
            >
              {path}
              {stats}
            </div>
            <div
              {...stylex.props(
                sx.minH0,
                sx.flex1,
                sx.overflowAuto,
                typography.label,
              )}
            >
              <FileDiff fileDiff={meta} options={options} disableWorkerPool />
            </div>
          </div>
        </Popover.Popup>
      )}
    </Popover.Root>
  );
}

/** The GitHub PR agent behaviors behind the score card. Each maps to an os-*
		PR label, but runs directly from the panel without a GitHub round trip. */
const PR_AGENT_ACTIONS: Array<{
  kind: PrAgentAction;
  label: string;
  hint: string;
}> = [
  {
    kind: "review",
    label: "Review",
    hint: "Full review pass (os-review). Findings are posted on the PR.",
  },
  {
    kind: "autofix",
    label: "Auto-fix",
    hint: "Opens a new session in this workspace that fixes every finding + failing CI and pushes. Watch and steer it live.",
  },
  {
    kind: "simplify",
    label: "Simplify",
    hint: "Quality cleanup pass: reuse, simpler shapes, dead code (os-simplify)",
  },
  {
    kind: "adversarial",
    label: "Adversarial",
    hint: "Deeper two-pass adversarial review (os-adversarial)",
  },
];

function AgentReviewCard({
  sessionId,
  repo,
  pr,
  onOpenSession,
  children,
}: {
  sessionId: string;
  repo?: string;
  pr: PrDetails;
  onOpenSession?: (id: string, created?: UnifiedSession | null) => void;
  /** The human reviewer's row, rendered under the agent's inside the same
	    plate. One section, two people you can ask. */
  children?: React.ReactNode;
}) {
  const [busy, setBusy] = useState<PrAgentAction | null>(null);
  const [reviewCancelling, setReviewCancelling] = useState(false);
  const [reviewCancelRequested, setReviewCancelRequested] = useState(false);
  const [done, setDone] = useState<{
    label: string;
    bksId?: string;
    session?: UnifiedSession | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewQueued, setReviewQueued] = useState<{ at?: string } | null>(
    null,
  );
  const review = pr.osReview;
  const score = review?.confidence;
  const stale = !!review?.stale;
  const actionable = pr.state === "OPEN";
  const active =
    (!!pr.reviewActive && !reviewCancelRequested) ||
    busy === "review" ||
    !!reviewQueued;
  const canFix = actionable && !!review && !stale && review.findings > 0;
  const scoreTone = stale
    ? utilityClassName("text-faint")
    : score && score >= 4
      ? utilityClassName("text-green")
      : score === 3
        ? utilityClassName("text-yellow")
        : score
          ? utilityClassName("text-red")
          : utilityClassName("text-dim");
  // One tone for the row, answering one question: does this reading want you?
  // A blocking review does. 5/5 with no findings does not, and neither does a
  // run still in flight — and a row with no state to lend keeps the neutral
  // plate, band and action alike. The reading is still coloured where it is
  // actually read: the score below, and the state word beside it.
  const rowTone: ReviewTone =
    !active &&
    review &&
    !stale &&
    (review.blocking > 0 || (!!score && score <= 2))
      ? "red"
      : "muted";
  // One line in the panel's git-status grammar: the reading, then the single
  // thing worth knowing about it. The reviewer's reasoning and the run time
  // are a hover away in the summary popup, so the row never carries both.
  let state = "Not reviewed yet";
  if (active) state = "Reviewing…";
  else if (pr.state === "MERGED") state = "Merged";
  else if (pr.state === "CLOSED") state = "Closed";
  else if (stale) state = "New commits since review";
  else if (review?.findings)
    state = `${review.findings} finding${review.findings === 1 ? "" : "s"}${
      review.blocking ? `, ${review.blocking} blocking` : ""
    }`;
  else if (review) state = "No findings";
  const reviewedAgo = review ? relTime(review.at) : "";
  // The score is intentionally compact; the matching GitHub summary comment
  // retains the reviewer's complete reasoning and is available on hover/focus.
  const reviewComment = review
    ? [...(pr.comments || [])]
        .reverse()
        .find((comment) => comment.body.trim().startsWith("<!-- os-review -->"))
    : undefined;
  const reviewMessage = reviewComment?.body.replace(
    /^<!-- os-review -->\s*/,
    "",
  );
  const reviewHtml = reviewMessage
    ? renderMarkdown(cleanCommentMarkdown(reviewMessage), { repo })
    : "";

  // Keep the just-started state latched until a later PR refresh observes the
  // run or its new result; otherwise the button flashes idle after the POST.
  useEffect(() => {
    if (
      reviewQueued &&
      (pr.reviewActive || pr.osReview?.at !== reviewQueued.at)
    ) {
      setReviewQueued(null);
    }
    if (!pr.reviewActive) setReviewCancelRequested(false);
  }, [pr.reviewActive, pr.osReview?.at, reviewQueued]);

  async function cancelReview() {
    if (!pr.reviewActive || reviewCancelling) return;
    setReviewCancelling(true);
    setError(null);
    try {
      await cancelPrReviewApi(sessionId, getCurrentUser(), repo);
      setReviewCancelRequested(true);
    } catch (error) {
      setError(errorMessage(error, "Couldn't cancel the review"));
    }
    setReviewCancelling(false);
  }

  async function run(action: (typeof PR_AGENT_ACTIONS)[number]) {
    if (busy) return;
    setBusy(action.kind);
    setError(null);
    setDone(null);
    try {
      const result = await triggerPrActionApi(
        sessionId,
        action.kind,
        getCurrentUser(),
        repo,
      );
      if (result.ok) {
        if (action.kind === "review") setReviewQueued({ at: review?.at });
        if (result.openSession && result.bksId && onOpenSession) {
          onOpenSession(result.bksId, result.session ?? null);
        } else {
          setDone({
            label: action.label,
            bksId: result.bksId,
            session: result.session,
          });
        }
      } else {
        setError(result.error || result.message || "Couldn't start");
      }
    } catch (error) {
      setError(errorMessage(error, "Couldn't start"));
    }
    setBusy(null);
  }

  // One action on the row, all of them in the menu: the row offers whichever
  // one the current state actually calls for, so the section header stays a
  // label rather than a toolbar.
  const primary = canFix ? PR_AGENT_ACTIONS[1] : PR_AGENT_ACTIONS[0];
  const primaryLabel = busy ? "Starting…" : canFix ? "Fix" : "Review";

  return (
    <div data-agent-score className={INFO_SECTION_CLASS}>
      <div {...stylex.props(sx.flex, sx.itemsCenter, sx.gap2)}>
        {/* One section for both reviewers: the agent's reading and the
				    teammate's request are the same question, so they share a label
				    and a plate rather than sitting in two sections that each say
				    "review". Who each row is about is on the row. */}
        <div className={INFO_LABEL_CLASS}>Review</div>
        {actionable && (
          <Menu.Root>
            <Menu.Trigger
              className={mergeStylexOverrideClassName(
                "",
                sx.Mr1,
                sx.mlAuto,
                sx.grid,
                sx.size6,
                sx.shrink0,
                sx.placeItemsCenter,
                sx.roundedMd,
                sx.textFaint,
                sx.transitionColorBackgroundColor,
                sx.hoverBgHover,
                sx.hoverTextFg,
                sx.disabledOpacity50,
              )}
              disabled={busy !== null}
              aria-label={`${AGENT_NAME} actions`}
            >
              <IconChevronDown size={14} />
            </Menu.Trigger>
            <Menu.Popup
              align="end"
              sideOffset={6}
              className={mergeStylexOverrideClassName("", sx.minW280px)}
            >
              <Menu.Group>
                <Menu.GroupLabel>{AGENT_NAME} actions</Menu.GroupLabel>
                {PR_AGENT_ACTIONS.map((action) => (
                  <Menu.Item
                    key={action.kind}
                    disabled={
                      busy !== null || (action.kind === "review" && active)
                    }
                    onClick={() => run(action)}
                    className={mergeStylexOverrideClassName(
                      "",
                      sx.itemsStart,
                      sx.py2,
                    )}
                  >
                    <div {...stylex.props(sx.minW0)}>
                      <div {...stylex.props(sx.fontSemibold, sx.textFg)}>
                        {action.label}
                      </div>
                      <div
                        {...stylex.props(
                          sx.mt05,
                          sx.leading135,
                          sx.textFaint,
                          typography.supporting,
                        )}
                      >
                        {action.hint}
                      </div>
                    </div>
                  </Menu.Item>
                ))}
              </Menu.Group>
            </Menu.Popup>
          </Menu.Root>
        )}
      </div>
      {/* The plate every other section in the panel uses. It used to run
			    wider, to keep two status bands from reading as one striped
			    block; at most one row carries a band now, so the section goes
			    back to the panel's own list grammar. */}
      <div className={INFO_LIST_CLASS}>
        <div
          className={cn(
            GIT_ROW,
            utilityClassName("rounded-md py-2"),
            reviewBand(rowTone),
          )}
        >
          <Popover.Root>
            <Popover.Trigger
              render={<div />}
              nativeButton={false}
              openOnHover={Boolean(reviewMessage)}
              delay={200}
              closeDelay={120}
              className={cn(
                utilityClassName("flex min-w-0 flex-1 items-center gap-2"),
                reviewMessage && utilityClassName("cursor-help"),
              )}
              tabIndex={reviewMessage ? 0 : undefined}
            >
              {/* Who, then the reading. The section is about people, so the
							    row leads with a face rather than the state dot the Git
							    status rows use: the state's colour is on the words. */}
              <span
                className={cn(
                  REVIEW_FACE,
                  utilityClassName("text-dim"),
                  active && utilityClassName("animate-pulse"),
                )}
                aria-hidden
              >
                <IconRobot size={18} />
              </span>
              <span className={GIT_LABEL}>
                {/* The row names its reviewer now that the section label is
								    the shared "Review": this line is the agent's, the one
								    under it is the teammate's. */}
                {AGENT_NAME}
                <span {...stylex.props(sx.textFaint)}> · </span>
                {score ? (
                  <>
                    {/* No live region: the panel repolls, and a `status` role
									    here would re-announce an unchanged score every time. */}
                    <span
                      className={cn(
                        utilityClassName("font-semibold tabular-nums"),
                        scoreTone,
                      )}
                    >
                      {score}/5
                    </span>
                    <span {...stylex.props(sx.textFaint)}> · </span>
                  </>
                ) : null}
                <span {...stylex.props(sx.textDim)}>{state}</span>
              </span>
            </Popover.Trigger>
            {reviewMessage && (
              <Popover.Popup
                side="left"
                align="start"
                sideOffset={12}
                className={mergeStylexOverrideClassName(
                  "",
                  sx.flex,
                  sx.maxHMin680pxCalc100vh24pxVarAvailableHeight,
                  sx.wMin680pxCalc100vw24pxVarAvailableWidth,
                  sx.minH0,
                  sx.overflowHidden,
                )}
              >
                <div {...stylex.props(sx.flex, sx.minH0, sx.wFull, sx.flexCol)}>
                  <div
                    {...stylex.props(
                      sx.flex,
                      sx.itemsCenter,
                      sx.gap25,
                      sx.borderB,
                      sx.borderDivider,
                      sx.px4,
                      sx.py3,
                    )}
                  >
                    <CommentAvatar
                      author={
                        reviewComment?.author || GITHUB_BOT_NAME || AGENT_NAME
                      }
                    />
                    <div {...stylex.props(sx.minW0, sx.flex1)}>
                      <div
                        {...stylex.props(
                          sx.truncate,
                          sx.fontSemibold,
                          sx.textFg,
                          typography.label,
                        )}
                      >
                        {reviewComment?.author || GITHUB_BOT_NAME || AGENT_NAME}
                      </div>
                      <div {...stylex.props(sx.textFaint, typography.meta)}>
                        Automated review
                        {reviewedAgo ? ` · reviewed ${reviewedAgo} ago` : ""}
                      </div>
                    </div>
                    <span
                      className={cn(
                        utilityClassName("shrink-0 text-label font-semibold"),
                        scoreTone,
                      )}
                    >
                      {score ?? "–"}/5
                    </span>
                  </div>
                  <div
                    {...stylex.props(sx.minH0, sx.overflowAuto, sx.px4, sx.py3)}
                  >
                    <MarkdownBody
                      html={reviewHtml}
                      className="markdown review-preview-markdown"
                    />
                  </div>
                </div>
              </Popover.Popup>
            )}
          </Popover.Root>
          {actionable && (
            <button
              type="button"
              className={gitActionClass(rowTone)}
              disabled={busy !== null || reviewCancelling}
              onClick={
                active ? () => void cancelReview() : () => void run(primary)
              }
              title={active ? `Cancel ${AGENT_NAME} review` : primary.hint}
            >
              {active
                ? reviewCancelling
                  ? "Stopping"
                  : "Cancel"
                : primaryLabel}
            </button>
          )}
        </div>
        {children}
      </div>
      {done && (
        <div {...stylex.props(sx.px3, sx.textDim, typography.supporting)}>
          Started {done.label.toLowerCase()}. {AGENT_NAME} will post results on{" "}
          {pr.url ? (
            <a
              href={pr.url}
              target="_blank"
              rel="noopener"
              {...stylex.props(
                sx.textFg,
                sx.underline,
                sx.decorationLineStrong,
                sx.underlineOffset2,
              )}
            >
              the PR
            </a>
          ) : (
            "the PR"
          )}
          {done.bksId && (
            <>
              {" · "}
              <a
                href={`${BASE_PATH}/session/${encodeURIComponent(done.bksId)}`}
                onClick={(e) => {
                  // Plain click opens the worker in this workspace. Modified
                  // clicks keep native new-tab behavior.
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                  if (!onOpenSession) return;
                  e.preventDefault();
                  onOpenSession(done.bksId!, done.session ?? null);
                }}
                {...stylex.props(
                  sx.textFg,
                  sx.underline,
                  sx.decorationLineStrong,
                  sx.underlineOffset2,
                )}
              >
                open run
              </a>
            </>
          )}
        </div>
      )}
      {error && (
        <div {...stylex.props(sx.px3, sx.textRed, typography.supporting)}>
          {error}
        </div>
      )}
    </div>
  );
}

/** The reviewer action: pick a teammate to flag this
		session as "needs review", so it jumps into a Needs-review band at the top of
		their sidebar and buzzes their registered devices. Re-pick to hand off,
		"Clear review request" to withdraw. Optimistic; the polled session list
		confirms (or reverts) on the next refresh. */
function ReviewerChip({
  sessionId,
  reviewRequest,
  requestSessionId,
  prReviewRequested,
  acceptedFromPr,
  onReviewPr,
  onReviewChange,
}: {
  sessionId: string;
  reviewRequest?: ReviewRequestInfo | null;
  /** The session that actually holds the request — a workspace's request may live
	    on a sibling session, not the open one. Clear/re-assign target this so the
	    chip stays consistent with the sidebar's workspace-level band; a brand-new
	    request (none exists) targets the open `sessionId`. */
  requestSessionId?: string;
  /** GitHub's requested reviewers on this workspace's PR (person keys). */
  prReviewRequested?: string[];
  acceptedFromPr?: boolean;
  /** Open the PR review canvas — offered when a review is waiting on you. */
  onReviewPr?: () => void;
  /** Optimistically mirror a pick / sign-off into the app-level session list so
	    every other surface (sidebar bands, the sibling chip) updates immediately. */
  onReviewChange?: (sessionId: string, req: ReviewRequestInfo | null) => void;
}) {
  const currentUser = useCurrentUser();
  const reviewTeams = useReviewTeams();
  // The roster arrives async and personNameForKey below reads it, so subscribe
  // to it here or a GitHub reviewer stays a bare person key until something
  // else re-renders the panel.
  usePeople();
  const [req, setReq] = useState(reviewRequest ?? null);
  // Why the last pick/sign-off was rejected. Without this the chip just snaps
  // back to its old state, which reads as the button doing nothing at all —
  // the server's reason (an expired GitHub connection, say) is worth showing.
  const [error, setError] = useState<string | null>(null);
  // Follow the polled session as it refreshes (another viewer may re-assign or
  // sign off). Track accepted's timestamp too so the sign-off lands live.
  const reqKey = [
    reviewRequest?.to,
    reviewRequest?.at,
    reviewRequest?.accepted?.at,
  ].join("\0");
  // Content-keyed resync: the trigger is the request's identity fields; the
  // copy lands through an effect event so the object itself stays out of deps.
  const syncRequest = useEffectEvent(() => {
    setReq(reviewRequest ?? null);
    setError(null);
  });
  useEffect(() => {
    syncRequest();
  }, [reqKey]);

  // The session that owns an existing request; a brand-new one anchors to the open session.
  const owner = (req && requestSessionId) || sessionId;
  const accepted = req?.accepted ?? null;
  // Picking here writes Open Session's own review request. Being listed as a
  // reviewer on the PR itself is GitHub's, and only that side can clear it — but
  // both mean "somebody is waiting on you to look at this", so they wear the
  // same chip. The picker below still only ever writes the Open Session request.
  const me = personKey(currentUser);
  // Local so clearing them lands immediately; the polled session confirms.
  const [ghRequested, setGhRequested] = useState(prReviewRequested || []);
  const ghRequestedKey = (prReviewRequested || []).join("\n");
  const syncGhRequested = useEffectEvent(() => {
    setGhRequested(prReviewRequested || []);
  });
  useEffect(() => {
    syncGhRequested();
  }, [ghRequestedKey]);
  const githubRequested = ghRequested.map((person) => person.toLowerCase());
  const githubRequestsMe = githubRequested.some((person) => person === me);
  const needsMyReview =
    githubRequestsMe ||
    (!!req && !accepted && reviewRequestTargetsPerson(req, me));
  // A review asked for on GitHub, aimed at someone else. The picker mirrors
  // its own picks into GitHub's Reviewers list, so the two sides mean the same
  // thing, but a request made on GitHub never came back here and the chip read
  // "Request review" while a reviewer was already waiting. The chip reports
  // them, and "Clear review request" withdraws them on GitHub (there is no
  // local request to drop), so the state the chip shows is always clearable.
  const githubOthers = req ? [] : githubRequested.filter((p) => p !== me);
  const githubNames = githubOthers.map(personNameForKey);
  const githubTarget = githubNames[0] || null;
  const selectedTeam = req
    ? reviewTeams.find((team) => team.github === req.to)
    : undefined;
  const targetLabel = selectedTeam?.name || req?.to;

  function pick(name: string | null, recipients?: string[]) {
    const prev = req;
    const prevGithub = ghRequested;
    const me = getCurrentUser();
    // Re-assigning drops any prior sign-off (a fresh reviewer, fresh review).
    const next = name
      ? {
          to: name,
          ...(recipients ? { recipients } : {}),
          by: me,
          at: new Date().toISOString(),
        }
      : null;
    setReq(next);
    // Clearing a session that has no request of its own withdraws GitHub's
    // pending ones instead, which is what the server does with the same call.
    if (!name && !prev) setGhRequested([]);
    setError(null);
    onReviewChange?.(owner, next);
    setSessionReviewerApi(owner, name, me).catch((error) => {
      setReq(prev);
      setGhRequested(prevGithub);
      onReviewChange?.(owner, prev);
      setError(errorMessage(error, "Failed to set reviewer"));
    });
  }

  function accept(value: boolean) {
    if (!req) return;
    const prev = req;
    const me = getCurrentUser();
    const next: ReviewRequestInfo = {
      ...req,
      accepted: value ? { by: me, at: new Date().toISOString() } : undefined,
    };
    setReq(next);
    setError(null);
    onReviewChange?.(owner, next);
    acceptReviewApi(owner, value, me).catch((error) => {
      setReq(prev);
      onReviewChange?.(owner, prev);
      setError(errorMessage(error, "Failed to update review"));
    });
  }

  // A review waiting on you is an action, not a picker: the row's own action
  // opens the review, and the caret beside it keeps the reassign and sign-off
  // menu, which is still worth reaching ("not me, ask Kent"). Without somewhere
  // to open, the action IS the picker.
  const reviewNow = needsMyReview && !!onReviewPr;
  // `who · where it stands`, in the agent row's grammar right above: the name
  // keeps the row's own ink and the state carries the tone, exactly as the
  // score does. Only the one state addressed to the reader takes the row
  // itself — the red band, and the red on its action — because a review
  // waiting on you is the single thing in this panel worth interrupting for.
  const rowTone: ReviewTone = needsMyReview ? "red" : "muted";
  // The face is the person the review sits with — you, when it is waiting on
  // you, even though the words say so rather than naming you.
  const faceName = selectedTeam
    ? null
    : needsMyReview
      ? currentUser
      : accepted
        ? accepted.by
        : req
          ? req.to
          : githubTarget;
  const rowName = needsMyReview
    ? null
    : accepted
      ? accepted.by
      : req
        ? targetLabel
        : githubTarget
          ? `${githubTarget}${githubOthers.length > 1 ? ` +${githubOthers.length - 1}` : ""}`
          : null;
  const rowState = needsMyReview
    ? "Needs your review"
    : accepted
      ? "reviewed"
      : req || githubTarget
        ? "requested"
        : "No reviewer";
  const stateTone = needsMyReview
    ? utilityClassName("font-semibold text-red")
    : accepted
      ? utilityClassName("text-green")
      : req || githubTarget
        ? utilityClassName("text-yellow")
        : utilityClassName("text-dim");
  const rowTitle = needsMyReview
    ? `Review requested by ${req?.by || "a teammate"}`
    : accepted
      ? `Reviewed by ${accepted.by}`
      : req
        ? `Review requested by ${req.by}`
        : githubTarget
          ? `Review requested on GitHub from ${githubNames.join(", ")}`
          : "Ask a teammate to review this session";
  return (
    <>
      <div
        className={cn(
          GIT_ROW,
          utilityClassName("rounded-md py-2"),
          // Background only: the row's own `text-fg` and a tone utility on
          // the same element would resolve by Tailwind's output order, so
          // the ink goes on the spans inside it instead.
          reviewBand(rowTone),
        )}
      >
        {/* The reviewer's own picture, beside the agent's face on the row
				    above. A team has no one face, and an unasked review has nobody
				    in it yet, so both fall back to a glyph. */}
        {faceName ? (
          <UserAvatar name={faceName} size={20} edge={false} />
        ) : (
          <span
            className={cn(REVIEW_FACE, utilityClassName("text-dim"))}
            aria-hidden
          >
            {selectedTeam ? <IconStack size={18} /> : <IconPeople size={18} />}
          </span>
        )}
        <span className={GIT_LABEL} title={rowTitle}>
          {rowName && (
            <>
              {rowName}
              <span {...stylex.props(sx.textFaint)}> · </span>
            </>
          )}
          <span className={stateTone}>{rowState}</span>
        </span>
        {reviewNow && (
          <button
            type="button"
            className={gitActionClass(rowTone)}
            title={rowTitle}
            onClick={onReviewPr}
          >
            Review now
          </button>
        )}
        <Menu.Root>
          <Menu.Trigger
            className={
              reviewNow
                ? utilityClassName(
                    "-mr-1 ml-1 grid size-6 shrink-0 place-items-center rounded-md text-faint transition-[color,background-color] hover:bg-hover hover:text-fg",
                  )
                : gitActionClass(rowTone, true)
            }
            aria-label="Review options"
            title={rowTitle}
          >
            {reviewNow ? (
              <IconChevronDown size={14} />
            ) : (
              <>
                {req || githubTarget ? "Change" : "Request"}
                <IconChevronDown size={14} className={GIT_ACTION_CARET} />
              </>
            )}
          </Menu.Trigger>
          <Menu.Popup
            align="start"
            sideOffset={6}
            className={mergeStylexOverrideClassName("", sx.minW200px)}
          >
            {req &&
              (accepted ? (
                <Menu.Item
                  onClick={() =>
                    acceptedFromPr && req
                      ? pick(req.to, req.recipients)
                      : accept(false)
                  }
                >
                  <IconBell
                    size={20}
                    className={mergeStylexOverrideClassName("", sx.textDim)}
                  />
                  <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>
                    Reopen review
                  </span>
                </Menu.Item>
              ) : (
                <Menu.Item onClick={() => accept(true)}>
                  <IconCheck
                    size={20}
                    className={mergeStylexOverrideClassName("", sx.textDim)}
                  />
                  <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>
                    Mark as reviewed
                  </span>
                </Menu.Item>
              ))}
            {req && <Menu.Separator />}
            {TEAM.map((name) => (
              <Menu.Item key={name} onClick={() => pick(name)}>
                <UserAvatar name={name} size={22} />
                <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>
                  {name}
                </span>
                <Menu.Check
                  on={req?.to === name}
                  size={20}
                  className={mergeStylexOverrideClassName("", sx.textDim)}
                />
              </Menu.Item>
            ))}
            {reviewTeams.length > 0 && <Menu.Separator />}
            {reviewTeams.map((team) => (
              <Menu.Item
                key={team.github}
                onClick={() => pick(team.github, team.members)}
              >
                <span
                  {...stylex.props(
                    sx.grid,
                    sx.size22px,
                    sx.placeItemsCenter,
                    sx.textDim,
                  )}
                >
                  <IconStack size={20} />
                </span>
                <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>
                  {team.name}
                </span>
                <Menu.Check
                  on={req?.to === team.github}
                  size={20}
                  className={mergeStylexOverrideClassName("", sx.textDim)}
                />
              </Menu.Item>
            ))}
            {(req || githubRequested.length > 0) && (
              <>
                <Menu.Separator />
                <Menu.Item
                  className={mergeStylexOverrideClassName("", sx.textDim)}
                  onClick={() => pick(null)}
                >
                  Clear review request
                </Menu.Item>
              </>
            )}
          </Menu.Popup>
        </Menu.Root>
      </div>
      {error && (
        <div
          {...stylex.props(
            sx.px2,
            sx.pb1,
            sx.fontMedium,
            sx.textRed,
            typography.meta,
          )}
        >
          {error}
        </div>
      )}
    </>
  );
}

/**
 * The Git status section of the info panel: the work sitting in this session's
 * tree that isn't committed yet.
 *
 * Only that. Where the branch stands against the remote and the base — ahead,
 * behind, and their Push and Pull — is the status strip's subject at the top of
 * the panel, and it said so in its own headline while this section repeated it
 * three sections lower with a second button for the same action. One fact, one
 * home: the strip owns the branch, this owns the tree.
 */
function GitStatusRows({
  sessionId,
  git,
  send,
}: {
  sessionId: string;
  git: GitStatusInfo | null;
  send?: (msg: WSClientMessage) => void;
}) {
  const [prompted, setPrompted] = useState<string | null>(null);

  // On a shared checkout the server scopes this to the files this session
  // wrote, so it means the same thing either way: your uncommitted work.
  const dirty = git?.uncommittedFiles ?? 0;
  if (dirty === 0) return null;

  function commit() {
    if (!send) return;
    send({
      type: "prompt",
      sessionId,
      user: getCurrentUser(),
      content: commitPrompt(dirty, git?.sharedCheckout, git?.uncommittedPaths),
    });
    setPrompted("commit the changes");
    setTimeout(() => setPrompted(null), 6000);
  }

  return (
    <div className={INFO_SECTION_CLASS}>
      <div className={INFO_LABEL_CLASS}>Uncommitted</div>
      <div className={INFO_LIST_CLASS}>
        <div className={utilityClassName(`${GIT_ROW} py-2`)}>
          <span className={`${GIT_DOT} ${GIT_DOT_BG.yellow}`} aria-hidden />
          <span className={GIT_LABEL}>
            {dirty} uncommitted file{dirty === 1 ? "" : "s"}
          </span>
          {send && (
            <button
              type="button"
              className={GIT_ACTION}
              onClick={commit}
              title={`Ask ${AGENT_NAME} to commit the uncommitted changes and push`}
            >
              Commit
            </button>
          )}
        </div>
      </div>
      {prompted && (
        <div className={utilityClassName(`${GIT_NOTE} text-faint`)}>
          Asked {AGENT_NAME} to {prompted} ✓
        </div>
      )}
    </div>
  );
}

/** One frame in a media strip, and what clicking it opens. `file` is an asset
 *  with nothing to show: it holds the same tile with a glyph in it, so a
 *  folder of captures and notes stays one set instead of a strip with the
 *  notes stranded under it. */
type StripItem = {
  key: string;
  kind: "image" | "video" | "file";
  src: string;
  /** Native tooltip: where the frame came from, or what the file is. */
  title?: string;
  /** A name under the frame. An asset carries one because its name is how you
	 refer to it ("use option 3"); conversation media has nothing to name. */
  caption?: string;
  onOpen: (from: HTMLElement) => void;
};

/**
 * A scrolling row of media frames, used twice in this panel: for the pictures
 * and recordings the workspace's sessions produced, and for the visual assets
 * this session wrote. Both are the same glance: a file you can only judge by
 * looking at it. So a recording an agent left behind gets a first frame rather
 * than a list row saying `1-push.mp4 · 159 KB`, which is five variants you have
 * to open one at a time.
 */
function MediaStrip({ items }: { items: StripItem[] }) {
  return (
    <div
      // The same card the neighbouring lists sit on (INFO_LIST_CLASS), laid
      // out as a scroller, spelled out rather than composed so its overflow
      // isn't fighting that constant's `overflow-hidden`. Frames scroll
      // *inside* the card, so the panel's padding is there on both sides at
      // rest; a sliver of the next frame at the trailing edge is what says it
      // scrolls. `p-3` rather than the lists' `p-1`: their rows carry their
      // own `px-2`, which puts row content 12px off the card edge. A frame is
      // its own content, so the card holds all 12 itself and the frames line
      // up with the rows and the label above them.
      {...mergeStylexProps(
        "snap-x snap-mandatory [&::-webkit-scrollbar]:hidden",
        sx.flex,
        sx.gap2,
        sx.overflowXAuto,
        sx.overflowYHidden,
        sx.roundedLg,
        sx.bgPanel,
        sx.p3,
        sx.ScrollPaddingLeft12px,
        sx.ScrollbarWidthNone,
      )}
    >
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={(event) => item.onOpen(event.currentTarget)}
          title={item.title}
          className={cn(
            utilityClassName(
              "focus-ring group/frame flex shrink-0 snap-start flex-col gap-1 rounded-[calc(14px*var(--rf)-12px)] text-left",
            ),
            items.length === 1
              ? utilityClassName("w-full")
              : items.length === 2
                ? utilityClassName("w-[calc((100%-8px)/2)]")
                : // Two full frames + the 8px gap + a 22px sliver of the
                  // third, filling the card exactly, so the sliver sits
                  // inside the card's own padding, not against the panel.
                  utilityClassName("w-[calc((100%-30px)/2)]"),
          )}
        >
          <span
            // Concentric with the card: inner = outer − padding, i.e.
            // rounded-lg (14·rf) minus the card's 12px. No token lands
            // there (the neighbouring lists' rows get away with
            // rounded-control because they only sit 4px in), so it's
            // spelled out, and it follows --rf like every other radius.
            // border-line-strong, not border-line: a frame's own edge is
            // whatever the capture happens to end on, so a dark screenshot
            // on the dark panel has no edge at all and the tile dissolves
            // into the card behind it. The frame supplies the edge instead,
            // at the same step every other image in the app is outlined
            // with (NoteBubble, the Slack composer's thumbnails). Hover is
            // the fill alone: there is no line above strong to escalate to.
            {...mergeStylexProps(
              "group-hover/frame:bg-hover",
              sx.relative,
              sx.block,
              sx.aspectVideo,
              sx.wFull,
              sx.overflowHidden,
              sx.roundedCalc14pxVarRf12px,
              sx.border,
              sx.borderLineStrong,
              sx.bgSurface,
              sx.transitionColors,
            )}
          >
            {item.kind === "file" ? (
              <span
                {...stylex.props(
                  sx.grid,
                  sx.hFull,
                  sx.wFull,
                  sx.placeItemsCenter,
                  sx.textFaint,
                )}
              >
                <IconFile size={24} />
              </span>
            ) : item.kind === "image" ? (
              <img
                src={item.src}
                alt=""
                loading="lazy"
                // contain, not cover: a screenshot is only worth showing
                // if the whole frame is there.
                {...stylex.props(sx.hFull, sx.wFull, sx.objectContain)}
              />
            ) : (
              <>
                <video
                  // #t=0.1 makes the browser seek to the first frame and
                  // paint it as a poster. Without it preload="metadata"
                  // leaves the tile blank.
                  src={`${item.src}#t=0.1`}
                  muted
                  playsInline
                  preload="metadata"
                  {...stylex.props(sx.hFull, sx.wFull, sx.objectContain)}
                />
                {/* Dark translucent disc so the wedge reads on any frame
								    (a bare white glyph vanishes on light footage). */}
                <span
                  {...stylex.props(
                    sx.pointerEventsNone,
                    sx.absolute,
                    sx.inset0,
                    sx.grid,
                    sx.placeItemsCenter,
                  )}
                >
                  <span
                    {...mergeStylexProps(
                      "backdrop-blur-sm",
                      sx.grid,
                      sx.size8,
                      sx.placeItemsCenter,
                      sx.roundedFull,
                      sx.bgBlack45,
                      sx.textWhite,
                    )}
                  >
                    <IconPlay size={18} />
                  </span>
                </span>
              </>
            )}
          </span>
          {item.caption && (
            <span
              {...stylex.props(
                sx.block,
                sx.wFull,
                sx.truncate,
                sx.textDim,
                typography.meta,
              )}
            >
              {item.caption}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/** Stable identity for the optional live-media prop: a `= []` default mints a
 *  fresh array on every render, which would defeat the media memo below on any
 *  caller that leaves the prop off. */
const NO_LIVE_MEDIA: WorkspaceMediaItem[] = [];

export function WorkspaceInfo({
  sessionId,
  workspaceId,
  sessions,
  repo,
  prState,
  refreshTick,
  sandbox,
  reviewRequest,
  reviewRequestSessionId,
  prReviewRequested,
  reviewAcceptedFromPr,
  onReviewChange,
  onOpenTab,
  onAddToInput,
  onOpenSession,
  send,
  liveMediaCount,
  liveMedia = NO_LIVE_MEDIA,
  assets = [],
  onOpenAsset,
}: Props) {
  const sessionsKey = sessions.map((c) => c.id).join(",");
  const cacheKey = workspaceId || `sessions:${sessionsKey}`;
  const overviewRevision = `${sessions
    .map((session) => session.lastActivity || session.createdAt)
    .join(",")}\0${liveMediaCount}`;
  const overviewResource = useWorkspaceOverviewResource(
    cacheKey,
    workspaceId,
    sessions,
    { revision: overviewRevision },
  );
  const prResource = useSessionPrResource(sessionId, repo, undefined, {
    enabled: Boolean(prState),
    refreshInterval: PR_WEBHOOK_FALLBACK_POLL_MS,
    revision: refreshTick,
  });
  const diffResource = useSessionDiffResource(sessionId, {
    enabled: Boolean(repo && sessionId),
    refreshInterval: 45_000,
    revision: liveMediaCount,
  });
  const gitResource = useSessionGitResource(sessionId, repo, {
    enabled: Boolean(repo && sessionId),
    refreshInterval: 45_000,
    revision: liveMediaCount,
  });
  const data = overviewResource.data ?? null;
  const commits = data?.commits ?? [];
  const pr = prState ? (prResource.data ?? null) : null;
  const primaryDiff =
    diffResource.data?.repos.find((entry) => entry.primary) ||
    diffResource.data?.repos[0] ||
    null;
  const files: DiffFile[] | null = repo
    ? (primaryDiff?.diff.files ?? (diffResource.data ? [] : null))
    : null;
  const rawPatch = primaryDiff?.diff.rawPatch ?? "";
  const git: GitStatusInfo | null = repo ? (gitResource.data ?? null) : null;
  const [commentsExpanded, setCommentsExpanded] = useState(false);

  useEffect(() => {
    setCommentsExpanded(false);
  }, [cacheKey]);

  // This list is what the team said about the PR, so machines are dropped:
  // deploy bots, preview tables, and the agent's own review, which the review
  // card above already carries in full. Also drop anything that reduces to
  // nothing (link-ref markers, pure HTML-comment bot pings) so no blank cards
  // show. The Review tab keeps the whole conversation.
  // Keyed on the comment list alone: `plainComment` runs a long chain of
  // regex passes per comment, and this component re-renders on every live
  // media frame while a session streams, which is not a reason to flatten
  // the same markdown again.
  const comments = (pr?.comments ?? [])
    .filter((c) => !isMachinePrComment(c))
    .filter((c) => !isOutdatedReviewComment(c.body))
    .map((c) => ({ ...c, preview: plainComment(c.body) }))
    .filter((c) => c.preview.length > 0);
  const changed = files ?? [];
  const totalAdd = changed.reduce((n, f) => n + (f.additions || 0), 0);
  const totalDel = changed.reduce((n, f) => n + (f.deletions || 0), 0);
  // Parse the raw patch once into a path→file-diff map so each file row can
  // hover-reveal its own hunks (same @pierre/diffs parse the Changes tab uses).
  const diffTheme = useResolvedTheme();
  const diffByPath = (() => {
    const m = new Map<string, FileDiffMetadata>();
    if (!rawPatch.trim()) return m;
    try {
      for (const p of parsePatchFiles(rawPatch))
        for (const f of p.files) m.set(f.name, f);
    } catch {
      /* malformed patch — rows just fall back to a plain click. */
    }
    return m;
  })();
  // Live media leads, so a frame the overview has since caught up on keeps its
  // first (live) position. One pass over a seen-set rather than a findIndex
  // per item: this list runs to the hundreds on a long workspace, and it was
  // rebuilt quadratically on every frame of a streaming run.
  const media = (() => {
    const seen = new Set<string>();
    const out: WorkspaceMediaItem[] = [];
    for (const m of [...liveMedia, ...(data?.media || [])]) {
      // NUL-joined: a src is a path or URL and may hold any printable
      // character, so a printable separator could alias two distinct items.
      const key = `${m.kind}\u0000${m.src}\u0000${m.sessionId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(m);
    }
    return out;
  })();

  // A picture or a recording an agent wrote is shown, not listed: its name and
  // size say nothing about it. A page, a report or a data file is the
  // opposite, and its name and description ARE the content. Rather than draw
  // half the band each way and leave the files stranded under a strip of
  // pictures, the whole folder goes one way at a time and the heading's toggle
  // says which. The header's summary card reads the same preference, so one
  // window never shows the same folder two ways.
  const [assetView, setAssetView] = useAssetViewMode();

  // Ahead, behind and the PR itself are the status strip's; this section is
  // only the uncommitted work in the tree.
  const showGit = Boolean(git && git.uncommittedFiles > 0);
  const hasBody = Boolean(
    comments.length > 0 ||
    commits.length > 0 ||
    changed.length > 0 ||
    media.length > 0 ||
    assets.length > 0,
  );

  // The teammate's review row, rendered into whichever section owns the plate
  // below. Held here so both branches pass the same element.
  const reviewerRow = (
    <ReviewerChip
      sessionId={sessionId}
      reviewRequest={reviewRequest}
      requestSessionId={reviewRequestSessionId}
      prReviewRequested={prReviewRequested}
      acceptedFromPr={reviewAcceptedFromPr}
      onReviewPr={onOpenTab ? () => onOpenTab("pr") : undefined}
      onReviewChange={onReviewChange}
    />
  );

  // `workspace-info-panel` is a DOM hook, not styling: the phone session-info
  // page reaches it from an ancestor — `[&_.workspace-info-panel]:pt-0` in
  // INFO_OVERVIEW (lib/session-viewer-classes).
  return (
    <div
      {...mergeStylexProps(
        "workspace-info-panel",
        sx.flex,
        sx.flexCol,
        sx.gap4,
        sx.px2,
        sx.pb22px,
        sx.pt3,
      )}
    >
      {/* Both reviewers in one section. With a PR the agent's card owns the
			    plate and the teammate's row goes in under it; without one there is
			    no agent reading to show, so the row stands in its own section. */}
      {pr?.number ? (
        <AgentReviewCard
          sessionId={sessionId}
          repo={repo}
          pr={pr}
          onOpenSession={onOpenSession}
        >
          {reviewerRow}
        </AgentReviewCard>
      ) : (
        <div className={INFO_SECTION_CLASS}>
          <div className={INFO_LABEL_CLASS}>Review</div>
          <div className={INFO_LIST_CLASS}>{reviewerRow}</div>
        </div>
      )}
      {sandbox && (
        // `px-3`, the label inset: the badge is a section's worth of content
        // with no plate under it, so it lines up with the labels rather than
        // with the rows inside a plate.
        <div
          {...stylex.props(
            sx.flex,
            sx.flexWrap,
            sx.itemsCenter,
            sx.gap15,
            sx.px3,
          )}
        >
          <SandboxBadge sessionId={sessionId} sandbox={sandbox} />
        </div>
      )}
      {showGit && <GitStatusRows sessionId={sessionId} git={git} send={send} />}
      {hasBody ? (
        <div {...stylex.props(sx.grid, sx.gap4)}>
          {comments.length > 0 && (
            <div className={INFO_SECTION_CLASS}>
              <div
                className={cn(
                  INFO_LABEL_CLASS,
                  utilityClassName("flex items-center justify-between gap-2"),
                )}
              >
                <span>
                  {comments.length} PR comment{comments.length === 1 ? "" : "s"}
                </span>
                {onAddToInput && (
                  <button
                    type="button"
                    {...stylex.props(
                      sx.roundedControl,
                      sx.border,
                      sx.borderLine,
                      sx.bgSurface,
                      sx.px2,
                      sx.py05,
                      sx.fontSemibold,
                      sx.textDim,
                      sx.transitionColors,
                      sx.hoverBorderLineStrong,
                      sx.hoverBgHover,
                      sx.hoverTextFg,
                      typography.meta,
                    )}
                    onClick={() =>
                      onAddToInput(formatFixCommentsPrompt(comments, pr!))
                    }
                    title="Add every comment to the composer as a fix task"
                  >
                    Fix
                  </button>
                )}
              </div>
              <div className={INFO_LIST_CLASS}>
                {(commentsExpanded
                  ? comments.slice().reverse()
                  : comments.slice(-COMMENT_PREVIEW).reverse()
                ).map((c, i) => (
                  <CommentCard
                    key={c.url || `${c.author}:${i}`}
                    comment={c}
                    pr={pr!}
                    onOpenTab={onOpenTab}
                    onAddToInput={onAddToInput}
                  />
                ))}
                {comments.length > COMMENT_PREVIEW && (
                  <button
                    type="button"
                    className={INFO_MORE_BUTTON_CLASS}
                    onClick={() => setCommentsExpanded((v) => !v)}
                  >
                    {commentsExpanded
                      ? "Show fewer comments"
                      : `View all ${comments.length} comments`}
                  </button>
                )}
              </div>
            </div>
          )}
          {commits.length > 0 && (
            <div className={INFO_SECTION_CLASS}>
              <div className={INFO_LABEL_CLASS}>Committed</div>
              <div className={INFO_LIST_CLASS}>
                {commits.map((commit) => (
                  <CommitRow key={commit.sha} commit={commit} />
                ))}
              </div>
            </div>
          )}
          {changed.length > 0 && (
            <div className={INFO_SECTION_CLASS}>
              <div
                className={cn(
                  INFO_LABEL_CLASS,
                  utilityClassName("flex items-center justify-between gap-2"),
                )}
              >
                <span>
                  {changed.length} file{changed.length === 1 ? "" : "s"} changed
                </span>
                <span
                  {...mergeStylexProps(
                    "tabular-nums",
                    sx.inlineFlex,
                    sx.shrink0,
                    sx.itemsCenter,
                    sx.gap1,
                    sx.fontSemibold,
                    typography.meta,
                  )}
                >
                  {totalAdd > 0 && (
                    <span {...stylex.props(sx.textGreen)}>+{totalAdd}</span>
                  )}
                  {totalDel > 0 && (
                    <span {...stylex.props(sx.textRed)}>−{totalDel}</span>
                  )}
                </span>
              </div>
              <div className={INFO_LIST_CLASS}>
                {changed.slice(0, FILE_PREVIEW).map((f) => (
                  <FileRow
                    key={f.path}
                    file={f}
                    meta={diffByPath.get(f.path)}
                    theme={diffTheme}
                    onOpenTab={onOpenTab}
                  />
                ))}
                {changed.length > FILE_PREVIEW && (
                  <button
                    type="button"
                    className={INFO_MORE_BUTTON_CLASS}
                    onClick={() => onOpenTab?.("changes")}
                  >
                    View all {changed.length} files in Changes →
                  </button>
                )}
              </div>
            </div>
          )}
          {media.length > 0 && (
            <div className={INFO_SECTION_CLASS}>
              {/* The strip shows recordings too, but screenshots are what
							    people call the set, so that is the word to head it with.
							    What separates this section from the assets below it is
							    still the source: one is what appeared in the conversation,
							    the other is what the session wrote. */}
              <div
                className={cn(
                  INFO_LABEL_CLASS,
                  utilityClassName("flex items-center justify-between gap-2"),
                )}
              >
                <span>Screenshots</span>
                <span className="tabular-nums">{media.length}</span>
              </div>
              <MediaStrip
                items={media.map((m, i) => ({
                  key: `${m.sessionId}:${m.at}:${i}`,
                  kind: m.kind,
                  src: m.src,
                  title: [m.sessionTitle, fullTime(m.at)]
                    .filter(Boolean)
                    .join(" · "),
                  onOpen: (from) => openLightbox(media, i, from),
                }))}
              />
            </div>
          )}
          {assets.length > 0 && (
            <div className={INFO_SECTION_CLASS}>
              <div
                className={cn(
                  INFO_LABEL_CLASS,
                  utilityClassName(
                    "group/assets flex items-center justify-between gap-2",
                  ),
                )}
              >
                <span>Assets</span>
                <span {...stylex.props(sx.flex, sx.itemsCenter, sx.gap15)}>
                  <AssetViewToggle mode={assetView} onChange={setAssetView} />
                  <span className="tabular-nums">{assets.length}</span>
                </span>
              </div>
              {assetView === "preview" ? (
                <MediaStrip
                  items={assets.map((a) => ({
                    key: a.path,
                    kind:
                      assetPreviewKind(a.path) === "video"
                        ? ("video" as const)
                        : isVisualAsset(a.path)
                          ? ("image" as const)
                          : ("file" as const),
                    src: sessionAssetPreviewUrl(sessionId, a),
                    title: [`Open ${a.path}`, a.description]
                      .filter(Boolean)
                      .join(" · "),
                    // The folder is usually shared across a set of
                    // variants; the filename is what tells them apart.
                    caption: a.path.split("/").pop() || a.path,
                    onOpen: () => onOpenAsset?.(a.path),
                  }))}
                />
              ) : (
                <div className={INFO_LIST_CLASS}>
                  {assets.map((a) => (
                    <button
                      key={a.path}
                      type="button"
                      onClick={() => onOpenAsset?.(a.path)}
                      title={`Open ${a.path}`}
                      className={cn(
                        utilityClassName(
                          "flex w-full min-w-0 gap-2 rounded-control px-2 py-[5px] text-left text-label text-fg transition-colors hover:bg-hover",
                        ),
                        // With a description the row is two lines and the icon
                        // and size ride the first one; a bare filename is a
                        // single line, so centre everything on it instead.
                        a.description
                          ? utilityClassName("items-start")
                          : utilityClassName("items-center"),
                      )}
                    >
                      {assetPreviewKind(a.path) === "image" ? (
                        <img
                          src={sessionAssetPreviewUrl(sessionId, a)}
                          alt=""
                          loading="lazy"
                          // Too small to say what the capture is, which is
                          // what the frames are for. What it does is tell
                          // two rows apart once you already know them.
                          className={cn(
                            utilityClassName(
                              "size-3.5 shrink-0 rounded-[3px] border border-line-strong object-cover",
                            ),
                            a.description && utilityClassName("mt-0.5"),
                          )}
                        />
                      ) : assetPreviewKind(a.path) === "video" ? (
                        // A poster frame at 14px is a smudge, so a recording
                        // says what it is instead.
                        <IconPlayRectangle
                          size={14}
                          className={cn(
                            utilityClassName("shrink-0 text-faint"),
                            a.description && utilityClassName("mt-0.5"),
                          )}
                        />
                      ) : (
                        <IconFile
                          size={14}
                          className={cn(
                            utilityClassName("shrink-0 text-faint"),
                            a.description && utilityClassName("mt-0.5"),
                          )}
                        />
                      )}
                      <span {...stylex.props(sx.minW0, sx.flex1)}>
                        <span {...stylex.props(sx.block, sx.truncate)}>
                          {a.path}
                        </span>
                        {a.description && (
                          <span
                            {...stylex.props(
                              sx.mt05,
                              sx.lineClamp2,
                              sx.leadingSnug,
                              sx.textDim,
                              typography.supporting,
                            )}
                          >
                            {a.description}
                          </span>
                        )}
                      </span>
                      <span
                        {...stylex.props(
                          sx.shrink0,
                          sx.textFaint,
                          typography.meta,
                        )}
                      >
                        {fmtBytes(a.size)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Bundle every surfaced PR comment into one "please fix these" composer prompt
		— the Fix button next to the comments heading. Bodies are cleaned to plain
		text and trimmed so the prompt stays readable. */
function formatFixCommentsPrompt(
  comments: Array<{ author: string; body: string; url?: string }>,
  pr: PrDetails,
): string {
  const items = comments
    .map((c, i) => {
      const by = c.author ? ` (${c.author})` : "";
      const link = c.url ? `\n   ${c.url}` : "";
      const body = plainComment(c.body).slice(0, 600);
      return `${i + 1}.${by} ${body}${link}`;
    })
    .join("\n\n");
  return `Please fix the issues raised in these ${comments.length} review comment${
    comments.length === 1 ? "" : "s"
  } on PR #${pr.number} (${pr.title}).\n\n${items}`;
}
