import { repoLabel } from "../lib/repo-label";
import { AGENT_NAME } from "../lib/brand";
import { randomUUID } from "../lib/random-uuid";
import React, {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useState,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import type {
  PrCheck,
  PrDetails,
  SessionWalkthrough,
  UnifiedSession,
  WSClientMessage,
  WSServerMessage,
} from "../lib/types";
import { PrSessionsList, prRelatedSessions } from "./PrSessions";
import { WalkthroughCard } from "./WalkthroughCard";
import { PrOverviewPage } from "./pr/PrOverviewPage";
import { PrFilesPage } from "./pr/PrFilesPage";
import { FinishReviewDialog, type ReviewEvent } from "./pr/FinishReviewDialog";
import { DiffPanel } from "./DiffPanel";
import {
  API_BASE,
  fetchPrViewedFiles,
  fetchPrFile,
  setPrFileViewed,
  fetchGitStatus,
  fetchWorktreeFile,
  saveWorktreeFile,
  submitPrReviewApi,
  mergePrApi,
  closePrApi,
  unlinkPrApi,
} from "../lib/api";
import {
  submitPrPreviewReviewApi,
  mergePrPreviewApi,
  closePrPreviewApi,
} from "../lib/api";
import { Button } from "../ui/button";
import { toast } from "../ui/toast";
import type { FileDiffMetadata } from "@pierre/diffs";
import type { CommentTarget, PendingComment } from "../lib/commentable-diff";
import { getCurrentUser } from "./UserPicker";
import { UserAvatar } from "./UserAvatar";
import { renderPrCommentMarkdown } from "../lib/markdown";
import { useMarkdownRepo } from "./MarkdownBody";
import { isOutdatedReviewComment } from "../lib/pr-comments";
import {
  dedupeTargets,
  matchFocusTarget,
  type PrFocus,
  type PrTarget,
} from "../lib/pr-focus";
import { providerFromUrl, prCapabilities } from "../lib/provider";
import { WS_SUMMARY_REVIEW_CANVAS_CLEARANCE } from "../lib/workspace-summary-classes";
import { errorMessage } from "../lib/error-message";
import {
  IconBranches,
  IconCheck,
  IconChevronRight,
  IconCopy,
  IconDotsHorizontal,
  IconGitMerge,
  IconGlobe,
  IconMessage,
  IconMessages,
  IconPlus,
  IconPullRequest,
  IconSliders,
  IconUndo,
  IconX,
} from "./icons";
import { Menu, MENU_ICON } from "../ui/menu";
import { Tooltip } from "../ui/tooltip";
import { TopBar } from "../ui/top-bar";
import { Popover } from "../ui/popover";
import { Segmented, SegmentedOption } from "../ui/segmented";
import { SettingRow } from "../ui/setting-row";
import {
  CodeDisplaySettings,
  CodeOrganizationSettings,
  DiffSourceSetting,
} from "./CodeDisplaySettings";
import {
  useCodeDisplaySettings,
  useCodeOrganizationSettings,
} from "../hooks/useCodeDisplaySettings";

import { checkClass, isDeployment, summarize } from "../lib/pr-status-derive";
import { prStatusMark } from "../lib/pr-status";
import { PR_NO_PR_BAR, PR_REPO_TABS } from "../lib/pr-tone-classes";
import { stripHtmlComments } from "../lib/pr-prompts";
import { PrStateIcon } from "./pr/PrStateIcon";
import { LinkPrControl } from "./pr/LinkPrControl";
import { PrCard } from "./pr/PrCard";
import { StackLinkSection } from "./pr/Stack";
import { PrStackChip } from "./pr/StackPopover";
import { ReviewRail } from "./pr/ReviewRail";
import { GitStatusRows } from "./pr/GitStatus";
import { ReviewToolbar } from "./pr/ReviewToolbar";
import { EmptyState, LoadingState } from "../ui/state";
import { ResponsiveDialog } from "../ui/sheet";
import { useIsPhone } from "../hooks/useIsPhone";
import { revealDiffFile } from "../lib/diff-navigation";
import { BrandMark } from "./BrandTile";
import { useCopy } from "../ui/copy";
import { useDeferredMergePhase } from "../hooks/useDeferredMerge";
import { useOptionalSessionSocket } from "../hooks/useSessionSocket";
import { usePrData } from "../hooks/usePrData";
import { sectionsWithPatches } from "../lib/pr-review-guide";
import {
  cancelDeferredMergeByKey,
  deferredMergeKey,
  scheduleDeferredMerge,
} from "../lib/deferred-merge";

type CodeView = "all" | "guide" | "flow";
type DiffSource = "pull-request" | "worktree";
export type PrReviewPage = "overview" | "files";

const NO_PR_FILES: NonNullable<PrDetails["files"]> = [];
const NOOP_SEND = () => {};

interface Props {
  sessionId: string;
  /** When provided, the review action bar offers "Open workspace" (Reviews view). */
  onOpenSession?: () => void;
  /** Append PR/check/comment context to this session's composer draft. */
  onAddToInput?: (text: string) => void;
  /**
   * Repos in this session (primary + attached). Together with `linkedPrs`
   * these form the PR targets; when more than one, a tab bar selects which PR
   * to show. Omit for single-repo callers (e.g. the Reviews drawer) — they
   * target the primary branch as before.
   */
  repos?: Array<{ repo: string; primary: boolean }>;
  /** PRs manually linked to the session (session.linkedPrs) — extra targets. */
  linkedPrs?: LinkedPrEntry[];
  /**
   * PRs the server discovered through the session link in their body footer
   * (`session.prs` entries with source "discovered") — the PRs this session
   * opened on branches it doesn't own. Same tabs as a linked PR, minus the
   * unlink affordance: the link is derived from the PR itself, not stored.
   */
  discoveredPrs?: LinkedPrEntry[];
  /**
   * Preselect one of the targets — the PR chips in the Workspace strip, and
   * `repo#123` mentions in prose, open the Review tab on a specific PR. `seq`
   * is bumped per click so clicking the same chip again re-focuses it after
   * the user has switched tabs by hand. See lib/pr-focus.ts for the matching.
   */
  focusTarget?: PrFocus;
  /** Offer the "Link PR" affordance (session Review tab; off in the Reviews drawer). */
  linkable?: boolean;
  /**
   * WebSocket sender. When provided, selecting text in the PR info column shows a
   * "Send to session" popover that delivers the selection + a message to this PR's
   * session (via a `prompt` message — the server steers/queues if it's busy).
   */
  send?: (msg: WSClientMessage) => void;
  /** Agent-published walkthrough (session.walkthrough) — rendered at the top
   *  of the info column; its mirrored section is stripped from the PR body. */
  walkthrough?: SessionWalkthrough;
  /**
   * Allow in-place edit mode (@pierre/diffs edit) on the review canvas's diff.
   * Only meaningful for callers whose session backs the shown PR with a live
   * worktree; carries the same agent-idle gate as the Changes tab (edits and
   * agent writes must not race). Linked/discovered PRs and session-less
   * previews stay read-only regardless.
   */
  editGate?: boolean;
  /** Session-less PR target; uses the same canvas with repo+branch APIs. */
  previewTarget?: { repo: string; branch: string };
  /**
   * Live sessions list. When provided, the panel surfaces every session
   * linked to the shown PR (matched by repo + head branch / number) and — with
   * `send` — offers starting a new session on the PR's head branch.
   */
  sessions?: UnifiedSession[];
  /** Navigate to a session picked from the linked-sessions list. */
  onOpenSessionById?: (id: string) => void;
  /** Host the session action in surrounding workspace chrome. `undefined`
   * keeps it in this PR toolbar for standalone review views. */
  sessionActionTarget?: HTMLElement | null;
  /** Open another PR in this panel — used by the stack map to move between
   *  layers in-app. Without it the layer rows still link, just via a full
   *  page load. */
  onOpenPr?: (repo: string, branch: string) => void;
  /** WS handler hook — resets the new-session form on server errors. */
  addHandler?: (handler: (msg: WSServerMessage) => void) => () => void;
  /** The surrounding review header already offers the workspace summary.
   * Keep this panel's metadata rail only when it stacks for a narrow canvas. */
  hideWideOverviewRail?: boolean;
  /** Controlled page for hosts that preserve Review state outside the panel. */
  page?: PrReviewPage;
  onPageChange?: (page: PrReviewPage) => void;
  /** Move file controls into the identity row and omit the secondary row. */
  compactToolbar?: boolean;
  /** Legacy caller hint; Review now keeps its desktop top inset either way. */
  flushToolbarTop?: boolean;
}

/** A PR manually linked to the session (mirrors session.linkedPrs entries). */
export interface LinkedPrEntry {
  repo: string;
  branch: string;
  number?: number;
  url?: string;
  title?: string;
}

const NO_LINKED_PRS: LinkedPrEntry[] = [];

export function PrPanel({
  sessionId,
  onOpenSession,
  onAddToInput,
  repos,
  linkedPrs,
  discoveredPrs,
  focusTarget,
  linkable,
  send: sendProp,
  walkthrough,
  editGate,
  previewTarget,
  sessions,
  onOpenSessionById,
  sessionActionTarget,
  onOpenPr,
  addHandler: addHandlerProp,
  hideWideOverviewRail = false,
  page: controlledPage,
  onPageChange,
  compactToolbar = false,
}: Props) {
  const sessionSocket = useOptionalSessionSocket();
  const send = sendProp ?? sessionSocket?.send;
  const addHandler = addHandlerProp ?? sessionSocket?.addHandler;
  // Local copy of the linked-PR list so link/unlink applies instantly; the
  // sessions list catches up on its next refresh.
  const [linkedLocal, setLinkedLocal] = useState<LinkedPrEntry[] | null>(null);
  // One identity for "no linked PRs", or the `targets` memo below re-runs on
  // every render for the (common) session with none.
  const linked = linkedLocal ?? linkedPrs ?? NO_LINKED_PRS;
  const [targetPickerOpen, setTargetPickerOpen] = useState(false);
  const targets = dedupeTargets([
    ...(previewTarget
      ? [
          {
            key: `preview:${previewTarget.repo}:${previewTarget.branch}`,
            repo: previewTarget.repo,
            branch: previewTarget.branch,
            primary: true,
            label: previewTarget.repo,
          },
        ]
      : (repos ?? []).map((r) => ({
          key: r.repo,
          repo: r.repo,
          primary: r.primary,
          label: r.repo,
        }))),
    ...linked.map((lp) => ({
      key: `${lp.repo} ${lp.branch}`,
      repo: lp.repo,
      branch: lp.branch,
      number: lp.number,
      linked: true,
      label: lp.number
        ? `${repoLabel(lp.repo)} #${lp.number}`
        : `${repoLabel(lp.repo)}:${lp.branch}`,
    })),
    // Last, so an explicit link (which owns the unlink affordance) wins the
    // dedupe over the same PR discovered from its body footer.
    ...(previewTarget ? [] : (discoveredPrs ?? [])).map((dp) => ({
      key: `${dp.repo} ${dp.branch}`,
      repo: dp.repo,
      branch: dp.branch,
      number: dp.number,
      discovered: true,
      label: dp.number
        ? `${repoLabel(dp.repo)} #${dp.number}`
        : `${repoLabel(dp.repo)}:${dp.branch}`,
    })),
  ]);
  const [activeKey, setActiveKey] = useState<string | undefined>(
    () => (targets.find((t) => t.primary) ?? targets[0])?.key,
  );
  const active = targets.find((t) => t.key === activeKey) ?? targets[0];
  const loadTargetKey = previewTarget
    ? `preview:${previewTarget.repo}:${previewTarget.branch}`
    : active?.key || sessionId;
  // Scalars rather than the per-render preview object: usePrData takes these
  // as primitive props, so its effect dependencies only change when the
  // preview target actually changes.
  const previewRepo = previewTarget?.repo;
  const previewBranch = previewTarget?.branch;
  // `#5528` in a PR body or review comment means a PR in the repo THIS panel is
  // showing — which is the attached repo's, not the session's, when the strip
  // is on a sibling PR. Only fall back to the surrounding surface's repo.
  const contextRepo = useMarkdownRepo();
  const markdownRepo = previewTarget?.repo || active?.repo || contextRepo;
  const [pending, setPending] = useState<PendingComment[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewEvent, setReviewEvent] = useState<ReviewEvent>("APPROVE");
  // Only the dialog's opening value and what it hands back on close. The live
  // field lives in FinishReviewDialog: a keystroke here would re-render every
  // mounted file of the diff behind it.
  const [summaryDraft, setSummaryDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewDone, setReviewDone] = useState<string | null>(null);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  // The branch has no PR yet and the bar's Create PR action has been asked for.
  // The agent does the work, so this only confirms the ask briefly while the PR
  // itself is still being created.
  const [prRequested, setPrRequested] = useState(false);
  useEffect(() => {
    if (!prRequested) return;
    const timer = window.setTimeout(() => setPrRequested(false), 6000);
    return () => window.clearTimeout(timer);
  }, [prRequested]);
  const { copy: copyPrLink } = useCopy();
  // Merging is a separate decision from approving, so it starts off: the
  // reviewer opts into it, and the primary action stays "Approve".
  const [mergeAfterReview, setMergeAfterReview] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const isPhone = useIsPhone();
  /**
   * The review is two places, not six tabs: Overview (the conversation and the
   * PR's metadata) and Files changed (the code). `codeView` is which lens the
   * code page uses, held apart from the page so a trip to Overview and back
   * never re-triggers guide or code-flow generation.
   */
  const [localPage, setLocalPage] = useState<PrReviewPage>("files");
  const page = controlledPage ?? localPage;
  const setPage = (next: PrReviewPage) => {
    setLocalPage(next);
    onPageChange?.(next);
  };
  const [codeView, setCodeView] = useState<"all" | "guide" | "flow">("all");
  const [diffSource, setDiffSource] = useState<DiffSource>("pull-request");
  const worktreeAvailable =
    !!sessionId && !previewTarget && !active?.linked && !active?.discovered;
  const sessionRunning = !!sessions?.find((session) => session.id === sessionId)
    ?.isRunning;
  useEffect(() => setDiffSource("pull-request"), [loadTargetKey]);
  /** A check chip elsewhere in the app asked for the checks (focusTarget). */
  const [focusChecksSeq, setFocusChecksSeq] = useState(0);
  // A PR chip or prose link can request a target before session PRs arrive.
  // Apply each request once after both the page setters and targets exist.
  const focusApplied = useRef<{ target?: number; checks?: number }>({});
  const applyFocusTarget = useEffectEvent(() => {
    if (!focusTarget) return;
    const { seq } = focusTarget;
    if (focusTarget.repo && focusApplied.current.target !== seq) {
      const match = matchFocusTarget(targets, focusTarget);
      if (match) {
        focusApplied.current.target = seq;
        setActiveKey(match.key);
      }
    }
    if (focusTarget.view === "checks" && focusApplied.current.checks !== seq) {
      focusApplied.current.checks = seq;
      setPage("overview");
      setFocusChecksSeq((prev) => prev + 1);
    }
  });
  useEffect(() => {
    applyFocusTarget();
  }, [focusTarget?.seq, targets]);
  /** A file picked on Overview, waiting for the code page to have its diff. */
  const [pendingReveal, setPendingReveal] = useState<string | null>(null);
  const phoneLayout = window.matchMedia("(max-width: 720px)").matches;
  // Rendering preferences are shared with sidebar Changes, so choosing wrap,
  // split view, highlighting or a theme in either viewer updates the other.
  const codeDisplaySettings = useCodeDisplaySettings(
    phoneLayout ? "unified" : "split",
  );
  const {
    diffStyle,
    wrapLines,
    structuralHighlighting,
    showFileStats,
    codeTheme,
  } = codeDisplaySettings;
  const organizationSettings = useCodeOrganizationSettings();
  const { grouping, fileListMode, fileOrder, sortDirection, hideReviewed } =
    organizationSettings;
  // GitHub's per-viewer "Viewed" file state for the shown PR (review canvas
  // checkboxes). Keyed so a stale PR's set never leaks onto the next one.
  const [prViewed, setPrViewed] = useState<{
    key: string;
    prId: string;
    viewed: ReadonlySet<string>;
  } | null>(null);
  const prViewedRef = useRef(prViewed);
  useLayoutEffect(() => {
    prViewedRef.current = prViewed;
  }, [prViewed]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  /**
   * The rail collapses on the panel's own width, not the viewport's. In the
   * workspace this panel is flanked by the sidebar and the workspace panel, so
   * it is around 990px inside a 1440px window and `phone:` (a viewport query)
   * never fires for it. Below the threshold the rail stacks above the
   * conversation instead of sitting beside it.
   */
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);
  const [diffControlsTarget, setDiffControlsTarget] =
    useState<HTMLDivElement | null>(null);
  const [worktreeToolbarTarget, setWorktreeToolbarTarget] =
    useState<HTMLDivElement | null>(null);
  const [railStacked, setRailStacked] = useState(false);
  const [headerCompact, setHeaderCompact] = useState(
    () => window.matchMedia("(max-width: 720px)").matches,
  );
  const setRoot = (el: HTMLDivElement | null) => {
    rootRef.current = el;
    setRootEl(el);
  };
  useEffect(() => {
    if (!rootEl || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      setRailStacked(entry.contentRect.width < 880);
      setHeaderCompact(entry.contentRect.width < 640);
    });
    observer.observe(rootEl);
    return () => observer.disconnect();
  }, [rootEl]);
  const loadRepo = active?.repo;
  const loadBranch = active?.branch;
  const loadLinked = active?.linked;
  const showingGuide = page === "files" && codeView === "guide";
  const showingFlow = page === "files" && codeView === "flow";
  const {
    pr,
    git,
    setGit,
    diff,
    diffOutOfDate,
    diffLoadPolicy,
    diffGroups,
    diffGroupsLoading,
    loading,
    loadError,
    diffLoading,
    diffError,
    load,
    retryPr,
    retryDiff,
    currentGuide,
    guideLoading,
    guideFailed,
    loadGuide,
    codeFlowKey,
    codeFlow,
    codeFlowLoading,
    codeFlowError,
    prPatchVersion,
    refreshCodeFlow,
    resetCodeFlowError,
    reviewThreads,
    activeLoadTargetRef,
  } = usePrData({
    sessionId,
    loadTargetKey,
    previewRepo,
    previewBranch,
    loadRepo,
    loadBranch,
    loadLinked,
    addHandler,
    showingGuide,
    showingFlow,
    onCodeViewChange: setCodeView,
    onTargetReset: () => {
      setPending([]);
      setReviewing(false);
      setReviewOpen(false);
      setPrViewed(null);
    },
  });
  const mergeKey = deferredMergeKey(pr?.url);
  const mergePhase = useDeferredMergePhase(mergeKey);
  const merging = mergePhase === "running";
  const mergeScheduled = mergePhase === "scheduled";

  // Inline comments don't post one-by-one — they accumulate as pending and ship
  // together when the reviewer finishes the review (the provider's native flow).
  // Both are stable: they ride diffOptions into every mounted file row, so a new
  // identity here re-renders the whole diff.
  const handleAddPending = async (target: CommentTarget, text: string) => {
    setPending((prev) => [...prev, { ...target, text, id: randomUUID() }]);
    setReviewDone(null);
  };

  const handleRemovePending = (id: string) => {
    setPending((prev) => prev.filter((c) => c.id !== id));
  };

  function handleFixChecks(summary: string) {
    if (!send || !pr) return;
    send({
      type: "prompt",
      sessionId,
      user: getCurrentUser(),
      content: `Investigate the failing checks on PR #${pr.number}, fix the failures, run the relevant tests, commit the changes, and push them.`,
    });
    setSummaryDraft(summary);
    setReviewError(null);
    setMergeAfterReview(false);
    setReviewOpen(false);
    toast("Fixing checks…");
  }

  async function handleSubmitReview(summary: string) {
    if (submitting) return;
    const actionTargetKey = loadTargetKey;
    if (pending.length === 0 && !summary.trim() && reviewEvent !== "APPROVE") {
      setReviewError("Add a comment or a summary first");
      return;
    }
    setSubmitting(true);
    setReviewError(null);
    try {
      const payload = {
        user: getCurrentUser(),
        event: reviewEvent,
        summary: summary.trim() || undefined,
        repo: active?.repo,
        branch: active?.branch,
        comments: pending.map((comment) => ({
          text: comment.text,
          path: comment.path,
          line: comment.endLine,
          startLine:
            comment.startLine !== comment.endLine
              ? comment.startLine
              : undefined,
          side: (comment.side === "deletions" ? "LEFT" : "RIGHT") as
            | "LEFT"
            | "RIGHT",
        })),
      };
      const result = previewTarget
        ? await submitPrPreviewReviewApi(
            previewTarget.repo,
            previewTarget.branch,
            payload,
          )
        : await submitPrReviewApi(sessionId, payload);
      let merged = false;
      if (reviewEvent === "APPROVE" && mergeAfterReview) {
        try {
          if (previewTarget) {
            await mergePrPreviewApi(
              previewTarget.repo,
              previewTarget.branch,
              "squash",
            );
          } else {
            await mergePrApi(sessionId, "squash", active?.repo, active?.branch);
          }
          merged = true;
        } catch (error) {
          setMergeError(
            `Review approved, but merge failed: ${errorMessage(error, "unknown error")}`,
          );
        }
      }
      if (actionTargetKey === activeLoadTargetRef.current) {
        setPending([]);
        setSummaryDraft("");
        setReviewOpen(false);
        setReviewEvent("APPROVE");
        setMergeAfterReview(false);
        setReviewDone(merged ? "merged" : result.url || "submitted");
        setTimeout(() => {
          if (actionTargetKey !== activeLoadTargetRef.current) return;
          setReviewDone(null);
          setReviewing(false);
        }, 6000);
        await load(true);
      }
    } catch (error) {
      if (actionTargetKey === activeLoadTargetRef.current) {
        setReviewError(errorMessage(error, "Failed to submit review"));
      }
    }
    setSubmitting(false);
  }

  function handleMerge() {
    if (!mergeKey) return;
    if (mergePhase === "scheduled") {
      cancelDeferredMergeByKey(mergeKey);
      return;
    }
    if (mergePhase !== "idle") return;
    setMergeError(null);
    const actionTargetKey = loadTargetKey;
    scheduleDeferredMerge(mergeKey, async () => {
      try {
        if (previewTarget) {
          await mergePrPreviewApi(
            previewTarget.repo,
            previewTarget.branch,
            "squash",
          );
        } else {
          await mergePrApi(sessionId, "squash", active?.repo, active?.branch);
        }
        if (actionTargetKey === activeLoadTargetRef.current) await load(true);
      } catch (error) {
        if (actionTargetKey === activeLoadTargetRef.current) {
          const message = errorMessage(error, "Merge failed");
          setMergeError(message);
          toast(message);
        }
      }
    });
  }

  async function handleClose() {
    if (!confirmClose) {
      setConfirmClose(true);
      setCloseError(null);
      setTimeout(() => setConfirmClose(false), 4000);
      return;
    }
    setConfirmClose(false);
    setClosing(true);
    setCloseError(null);
    const actionTargetKey = loadTargetKey;
    try {
      if (previewTarget) {
        await closePrPreviewApi(previewTarget.repo, previewTarget.branch);
      } else {
        await closePrApi(sessionId, active?.repo, active?.branch);
      }
      if (actionTargetKey === activeLoadTargetRef.current) await load(true);
    } catch (error) {
      if (actionTargetKey === activeLoadTargetRef.current) {
        setCloseError(errorMessage(error, "Failed to close pull request"));
      }
    }
    setClosing(false);
  }

  // Roll the per-check list up into headline counts, and split deployments
  // (Vercel previews & friends) from CI checks — failing and running entries
  // sort first within each group.
  const checkSummary = (() => {
    const checks = pr?.checks || [];
    const s = summarize(checks);
    const rank = (c: PrCheck) => {
      const cls = checkClass(c.status, c.conclusion);
      return cls === "check-failure"
        ? 0
        : cls === "check-pending"
          ? 1
          : cls === "check-success"
            ? 3
            : 2;
    };
    const sorted = [...checks].sort((a, b) => rank(a) - rank(b));
    return {
      ...s,
      deployments: sorted.filter(isDeployment),
      checks: sorted.filter((c) => !isDeployment(c)),
    };
  })();

  const bodyHtml = (() => {
    if (!pr?.body) return "";
    // The mirrored walkthrough section is for GitHub readers; here
    // WalkthroughCard renders the real thing, so drop the mirror.
    const stripped = pr.body
      .replace(
        /<!-- opensession:walkthrough -->[\s\S]*?<!-- \/opensession:walkthrough -->/,
        "",
      )
      .trim();
    // A PR body is PR prose like its comments: the same `<details>` blocks,
    // `<img>` screenshots and bot markup, rendered by the same allowlist.
    return stripped
      ? renderPrCommentMarkdown(stripped, { repo: markdownRepo })
      : "";
  })();
  const provider = providerFromUrl(pr?.url);
  // Host capability gating: absent (GitHub, older cache entries) means all
  // true, so nothing GitHub-shaped ever disappears. code.storage payloads
  // carry an explicit set (no checks/reviewers/comments/viewed state/stacks).
  const caps = prCapabilities(pr?.capabilities);

  // A file picked anywhere but the code itself (the Overview rail, a code-flow
  // location) has to wait: the code page may not be mounted yet, and its diff
  // loads on its own clock. Park the path and let the effect below spend it
  // once both are true, rather than revealing into a tree that isn't there.
  const scrollToFile = (path: string) => {
    if (page === "files" && codeView !== "flow") {
      revealDiffFile(rootRef.current, path);
      return;
    }
    setPage("files");
    if (codeView === "flow") setCodeView("all");
    setPendingReveal(path);
  };
  useEffect(() => {
    if (
      !pendingReveal ||
      page !== "files" ||
      codeView === "flow" ||
      !diff?.patch
    )
      return;
    const frame = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        revealDiffFile(rootRef.current, pendingReveal);
        setPendingReveal(null);
      }),
    );
    return () => cancelAnimationFrame(frame);
  }, [pendingReveal, page, codeView, diff?.patch]);

  // Changed images render as pictures, served from the repo at the PR's head
  // (new side) / base (old side) refs through the pr-image endpoint.
  const prBase = pr?.baseRefName;
  const prHead = pr?.headRefName;
  const activeRepoId = active?.repo;
  const prImageSrcs = (file: FileDiffMetadata) => {
    const src = (ref: string, p: string) =>
      `${API_BASE}/pr-image?${activeRepoId ? `repo=${encodeURIComponent(activeRepoId)}&` : ""}ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(p)}`;
    return {
      oldSrc: prBase ? src(prBase, file.prevName || file.name) : undefined,
      newSrc: prHead ? src(prHead, file.name) : undefined,
    };
  };
  // The pr-image endpoint serves blobs through the GitHub API — on hosts
  // without it, image files fall back to the plain binary-diff placeholder.
  const imageSrcs = caps.images ? prImageSrcs : undefined;
  const fileActions = (() => {
    const ref = pr?.headRefOid || pr?.headRefName;
    const prUrl = pr?.url;
    return {
      providerName: provider.name,
      url: (file: FileDiffMetadata) => {
        if (provider.key !== "github" || !prUrl || !ref) return null;
        try {
          const url = new URL(prUrl);
          url.pathname = `${url.pathname.replace(/\/pull\/\d+.*$/, "")}/blob/${encodeURIComponent(ref)}/${file.name
            .split("/")
            .map(encodeURIComponent)
            .join("/")}`;
          url.search = "";
          url.hash = "";
          return url.toString();
        } catch {
          return null;
        }
      },
      loadContents:
        provider.key === "github" && ref
          ? (file: FileDiffMetadata) =>
              fetchPrFile(activeRepoId, ref, file.name)
          : undefined,
    };
  })();

  // In-place edit mode on the review canvas. Only targets backed by one of the
  // session's own worktrees qualify (primary/attached repos — their worktree is
  // the PR's head branch); linked/discovered PRs live on branches this session
  // doesn't have checked out, so they stay read-only. Saves only touch the
  // worktree — the PR diff won't reflect them until they're committed and
  // pushed — so saved files accumulate into a "tell the agent" note that asks
  // it to commit them on this branch.
  const [handEdited, setHandEdited] = useState<string[]>([]);
  useEffect(() => setHandEdited([]), [sessionId, activeRepoId]);
  const worktreeEditable =
    !!editGate && !previewTarget && !!active && !active.branch;
  const editFile = worktreeEditable
    ? {
        load: (file: FileDiffMetadata, side: "new" | "base") =>
          fetchWorktreeFile(
            sessionId,
            side === "base" ? file.prevName || file.name : file.name,
            activeRepoId,
            side,
          ),
        save: async (path: string, content: string) => {
          await saveWorktreeFile(sessionId, path, content, activeRepoId);
          setHandEdited((prev) =>
            prev.includes(path) ? prev : [...prev, path],
          );
          // The diff column is the PR's committed state, so it can't show
          // the edit yet — but the divergence strip's dirty state can.
          void fetchGitStatus(sessionId, activeRepoId)
            .then((g) => setGit(g))
            .catch(() => {});
        },
      }
    : undefined;
  const tellAgentAboutEdits = () => {
    if (!send || !handEdited.length) return;
    const list = handEdited.map((p) => `- \`${p}\``).join("\n");
    send({
      type: "prompt",
      sessionId,
      user: getCurrentUser(),
      content:
        `${getCurrentUser()} hand-edited these files directly in the worktree via the review tab editor` +
        `${activeRepoId ? ` (${activeRepoId} repo)` : ""}:\n\n${list}\n\n` +
        `Review the edits, keep them (don't revert them unless they're clearly broken), and commit + push them on this branch so the pull request picks them up.`,
    });
    setHandEdited([]);
  };

  // GitHub "Viewed" state: fetched per PR (and refetched when the head moves,
  // since a push flips changed files to DIRTY = unviewed on GitHub's side).
  // Hosts without viewed state never fetch — prViewed stays unset, so the
  // checkboxes stay hidden.
  const viewedKey = diff ? `${activeRepoId || "pr"}#${diff.number}` : null;
  const viewedPrNumber = diff?.number;
  useEffect(() => {
    if (!caps.viewedState || !viewedKey || viewedPrNumber === undefined) return;
    let live = true;
    fetchPrViewedFiles(activeRepoId, viewedPrNumber, getCurrentUser())
      .then((res) => {
        if (!live) return;
        setPrViewed({
          key: viewedKey,
          prId: res.prId,
          viewed: new Set(res.viewed),
        });
      })
      .catch(() => {
        // Leave prViewed unset — checkboxes just stay hidden for this PR.
      });
    return () => {
      live = false;
    };
  }, [
    viewedKey,
    viewedPrNumber,
    diff?.headRefOid,
    activeRepoId,
    caps.viewedState,
  ]);

  const handleToggleViewed = (path: string, next: boolean) => {
    const info = prViewedRef.current;
    if (!info) return;
    const apply = (set: ReadonlySet<string>, add: boolean) => {
      const v = new Set(set);
      if (add) v.add(path);
      else v.delete(path);
      return v;
    };
    // Optimistic: flip locally, revert if GitHub rejects the mutation.
    setPrViewed({ ...info, viewed: apply(info.viewed, next) });
    void setPrFileViewed(
      activeRepoId,
      info.prId,
      path,
      next,
      getCurrentUser(),
    ).catch(() => {
      setPrViewed((prev) =>
        prev && prev.key === info.key
          ? { ...prev, viewed: apply(prev.viewed, !next) }
          : prev,
      );
    });
  };

  function handleLinked(all: LinkedPrEntry[], justLinked: LinkedPrEntry) {
    setLinkedLocal(all);
    setActiveKey(`${justLinked.repo} ${justLinked.branch}`);
  }

  async function handleUnlink(target: PrTarget) {
    if (!target.branch) return;
    try {
      const result = await unlinkPrApi(sessionId, target.repo, target.branch);
      setLinkedLocal(result.all);
      if (activeKey === target.key) {
        setActiveKey(
          (targets.find((candidate) => candidate.primary) ?? targets[0])?.key,
        );
      }
      toast("PR unlinked");
    } catch (error) {
      toast(errorMessage(error, "Couldn't unlink the PR"));
    }
  }

  // Tab bar across the top: one tab per PR (primary repo, attached repos,
  // linked PRs) plus the link affordance. With a single target the bar
  // disappears and "Link PR" moves into the actions row instead.
  // Sessions linked to the shown PR — only when the caller wires the list.
  // Matched against the ACTIVE target (linked PRs carry their own branch; the
  // primary/attached branch resolves through the loaded PR's headRefName).
  const relatedSessions =
    sessions && active
      ? prRelatedSessions(sessions, active.repo, active.branch, pr)
      : [];
  const sessionActionLabel =
    relatedSessions.length === 0
      ? "Start session"
      : relatedSessions.length === 1
        ? "Open session"
        : `Open ${relatedSessions.length} sessions`;
  const sessionActionButton = sessions ? (
    sessionActionTarget === undefined ? (
      <Button
        variant="default"
        size="sm"
        icon={<IconMessages size={18} />}
        onClick={() => setSessionsOpen(true)}
      >
        {sessionActionLabel}
      </Button>
    ) : (
      <Tooltip label={sessionActionLabel}>
        <Button
          variant="ghost"
          size="md"
          className="flex-none rounded-control"
          aria-label={sessionActionLabel}
          icon={<IconPlus size={22} />}
          onClick={() => setSessionsOpen(true)}
        />
      </Tooltip>
    )
  ) : null;

  const files = pr?.files ?? NO_PR_FILES;
  const reviewedFiles =
    prViewed?.key === viewedKey ? prViewed.viewed : undefined;
  const reviewFiles = (() => {
    const visible =
      hideReviewed && reviewedFiles
        ? files.filter((file) => !reviewedFiles.has(file.path))
        : [...files];
    if (fileOrder === "pull-request")
      return sortDirection === "asc" ? visible : visible.reverse();
    const direction = sortDirection === "asc" ? 1 : -1;
    return visible.sort((left, right) => {
      const result =
        fileOrder === "changes"
          ? left.additions + left.deletions - right.additions - right.deletions
          : left.path.localeCompare(right.path);
      return (result || left.path.localeCompare(right.path)) * direction;
    });
  })();
  const visibleFileOrder = reviewFiles.map((file) => file.path);

  // Slicing the patch per section walks every byte of it, so it cannot run on
  // renders it has nothing to do with — while the guide is the open lens, that
  // would be once per keystroke in the review summary.
  const guideSections =
    currentGuide && diff?.patch
      ? sectionsWithPatches(currentGuide, diff.patch)
      : [];

  // Every diff on the code page is the same commentable surface; only the
  // patch it is handed differs (the whole PR, or one guide section). The React
  // Compiler keeps this options object stable so unrelated state changes do not
  // re-render every mounted file row.
  const diffOptions = diff && {
    diffStyle,
    controlsTarget: codeView === "all" ? diffControlsTarget : undefined,
    showViewedProgress: false,
    wrapLines,
    structuralHighlighting,
    showFileStats,
    codeTheme,
    visibleFileOrder,
    // PR file cards scroll beneath the sticky toolbar as one surface. Sidebar
    // Changes opts into pinned file headers separately.
    stickyFileHeaders: false,
    defaultExpandedFiles: diffLoadPolicy.defaultExpandedFiles,
    allowExpandAll: diffLoadPolicy.allowExpandAll,
    viewedFiles: prViewed?.key === viewedKey ? prViewed.viewed : undefined,
    onToggleViewed: handleToggleViewed,
    disabled: !reviewing || !caps.reviewComments,
    disabledHint: !caps.reviewComments
      ? `Inline review comments aren't supported on ${provider.name}`
      : "Start a review to add inline comments.",
    submitLabel: "Add comment",
    placeholder: `Comment on #${diff.number}, added to your pending review…`,
    pendingComments: reviewing ? pending : undefined,
    onRemovePending: handleRemovePending,
    reviewThreads:
      reviewThreads?.key === loadTargetKey ? reviewThreads.threads : undefined,
    commentRepo: markdownRepo,
    onSubmit: handleAddPending,
    imageSrcs,
    fileActions,
    editFile,
  };

  const showBar = targets.length > 1;
  const targetPicker = showBar ? (
    <Popover.Root open={targetPickerOpen} onOpenChange={setTargetPickerOpen}>
      <Tooltip label="Switch review target">
        <Popover.Trigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="min-w-0 max-w-[180px] px-2 text-label phone:min-h-9 phone:max-w-[104px]"
              aria-label={`Switch review target. Current: ${active?.label || "repository"}`}
              caret
            >
              <span className="truncate">{active?.label}</span>
              {!headerCompact && (
                <span className="shrink-0 text-faint">
                  +{targets.length - 1}
                </span>
              )}
            </Button>
          }
        />
      </Tooltip>
      <Popover.Popup
        side="bottom"
        align="start"
        initialFocus
        className="w-[280px] p-1.5"
      >
        <div className="px-2 py-1.5 text-meta font-medium text-faint">
          Review target
        </div>
        <div className="flex flex-col gap-0.5">
          {targets.map((target) => {
            const selected = target.key === active?.key;
            const detail = target.linked
              ? "Linked pull request"
              : target.discovered
                ? "Opened by this session"
                : target.primary
                  ? "Primary repo"
                  : "Attached repo";
            return (
              <button
                key={target.key}
                type="button"
                className={`flex min-h-10 w-full items-center gap-2 rounded-md border-0 px-2 text-left hover:bg-hover phone:min-h-11 ${selected ? "bg-active" : "bg-transparent"}`}
                aria-current={selected ? "page" : undefined}
                onClick={() => {
                  setTargetPickerOpen(false);
                  setActiveKey(target.key);
                }}
              >
                <IconBranches size={17} className="shrink-0 text-dim" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-label font-medium text-fg">
                    {target.label}
                  </span>
                  <span className="block truncate text-meta text-faint">
                    {detail}
                  </span>
                </span>
                {selected && (
                  <IconCheck size={16} className="shrink-0 text-fg" />
                )}
              </button>
            );
          })}
        </div>
        {linkable && (
          <div className="mt-1.5 border-t border-divider-soft px-1 pt-1.5">
            <LinkPrControl
              sessionId={sessionId}
              variant="action"
              onLinked={handleLinked}
            />
          </div>
        )}
      </Popover.Popup>
    </Popover.Root>
  ) : null;
  const switcher = showBar ? (
    <div className={PR_REPO_TABS}>{targetPicker}</div>
  ) : null;

  const reviewStateClass = `flex-1 ${compactToolbar ? WS_SUMMARY_REVIEW_CANVAS_CLEARANCE : ""}`;

  if (loading)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {switcher}
        <LoadingState className={`${reviewStateClass} -translate-y-5`}>
          <span className="text-control-label font-medium text-fg">
            Loading pull request…
          </span>
        </LoadingState>
      </div>
    );

  if (loadError && !pr)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {switcher}
        <EmptyState
          className={reviewStateClass}
          role="alert"
          icon={<IconX size={22} className="text-red" />}
          title="Couldn’t load pull request"
          action={
            <Button size="sm" onClick={retryPr}>
              Try again
            </Button>
          }
        >
          <span className="text-pretty">{loadError}</span>
        </EmptyState>
      </div>
    );

  if (!pr) {
    const showWorktreeDiff =
      !!sessionId && !previewTarget && !active?.linked && !active?.discovered;
    // The branch's own changes are the review here, so they lead. Opening the
    // PR is the one action this state offers, and it sits in the bar rather
    // than inside a card below the diff.
    const createPr = () => {
      if (!send || !sessionId) return;
      send({
        type: "prompt",
        sessionId,
        user: getCurrentUser(),
        content:
          "Commit any remaining work, push the branch, and open a PR for it.",
      });
      setPrRequested(true);
      toast(`Asked ${AGENT_NAME} to open a pull request`);
    };
    return (
      <div
        className={`selectable relative flex h-full min-h-0 flex-col bg-surface ${compactToolbar ? "overflow-x-hidden overflow-y-auto" : "overflow-hidden"}`}
        data-review-canvas="true"
      >
        <ReviewToolbar compact={compactToolbar}>
          <div className={PR_NO_PR_BAR}>
            {targetPicker}
            {/* Opening the PR is what this state is for, so its action leads
                before the shared diff controls. */}
            {showWorktreeDiff && !!send && (
              <Button
                variant="primary"
                size="sm"
                className="phone:min-h-11"
                icon={<IconPullRequest size={20} />}
                disabled={prRequested}
                onClick={createPr}
              >
                {prRequested ? "Opening…" : "Create PR"}
              </Button>
            )}
            {linkable && (
              <LinkPrControl
                sessionId={sessionId}
                variant="action"
                onLinked={handleLinked}
              />
            )}
            {showWorktreeDiff && (
              <div
                ref={setWorktreeToolbarTarget}
                className="ml-auto flex shrink-0 items-center gap-2.5 text-label"
              />
            )}
          </div>
        </ReviewToolbar>
        {/* Match the PR-backed canvas: without a standing summary, content
            owns the scrollport and the toolbar stays outside it. With the
            summary, the shared outer scrollport lets its toolbar stick. */}
        <main
          className={`min-h-0 flex-1 bg-surface ${compactToolbar ? "overflow-y-visible" : "overflow-y-auto"}`}
        >
          {walkthrough && (
            <div className="mx-auto w-full max-w-[760px] px-4 pt-4 sm:px-5">
              <WalkthroughCard walkthrough={walkthrough} />
            </div>
          )}
          {showWorktreeDiff ? (
            <div
              className={`max-w-[1500px] px-2 pb-2 phone:w-full phone:px-1 ${compactToolbar ? `w-auto pt-0 ${WS_SUMMARY_REVIEW_CANVAS_CLEARANCE}` : "mx-auto w-full pt-2"}`}
              data-no-pr-worktree-diff
            >
              <DiffPanel
                sessionId={sessionId}
                isRunning={sessionRunning}
                canSend={!!send && !!editGate}
                send={send ?? NOOP_SEND}
                toolbarTarget={worktreeToolbarTarget}
              />
            </div>
          ) : (
            <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4 px-4 py-4 sm:px-5">
              <PrCard title="Git status">
                <GitStatusRows
                  git={git}
                  pr={null}
                  sessionId={sessionId}
                  repo={active?.repo}
                  send={send}
                  onRefresh={load}
                />
              </PrCard>
            </div>
          )}
        </main>
      </div>
    );
  }

  // Bot bookkeeping comments are pure HTML markers — hide them, and strip
  // leading markers from real comments' previews.
  const comments = (pr.comments || []).filter(
    (c) => stripHtmlComments(c.body) && !isOutdatedReviewComment(c.body),
  );
  const stateLabel = pr.isDraft
    ? "Draft"
    : pr.state === "OPEN"
      ? "Open"
      : pr.state === "MERGED"
        ? "Merged"
        : "Closed";
  // The state reads in the app's own PR language rather than a badge of its
  // own: the glyph carries the colour (prStatusMark, the same green/yellow/
  // red/purple the sidebar row and the workspace rows paint) and the word
  // beside it stays coarse. That way the header agrees with the sidebar entry
  // for this PR, including the states a badge cannot show at all: a conflict,
  // or checks still running.
  const statusMark = prStatusMark({ ...pr, checks: checkSummary });
  const canMergeAfterReview =
    pr.state === "OPEN" &&
    !pr.isDraft &&
    pr.mergeable !== "CONFLICTING" &&
    checkSummary.failed === 0 &&
    checkSummary.pending === 0;
  const reviewSubmitLabel =
    reviewEvent === "APPROVE"
      ? mergeAfterReview && canMergeAfterReview
        ? "Approve and merge"
        : "Approve"
      : reviewEvent === "REQUEST_CHANGES"
        ? "Request changes"
        : "Submit review";
  const rail = (
    <ReviewRail
      className={railStacked ? "min-w-0" : "w-[264px] shrink-0"}
      pr={pr}
      git={git}
      sessionId={sessionId}
      repo={active?.repo}
      provider={provider}
      caps={caps}
      checkSummary={checkSummary}
      send={send}
      onRefresh={load}
      onMerge={handleMerge}
      merging={merging}
      mergeScheduled={mergeScheduled}
      mergeError={mergeError}
      onOpenFile={scrollToFile}
      onOpenFiles={() => setPage("files")}
      onOpenSessions={sessions ? () => setSessionsOpen(true) : undefined}
      sessionCount={relatedSessions.length}
      focusChecksSeq={focusChecksSeq}
      compact={railStacked}
    />
  );

  const codeSettings = (
    <Popover.Root>
      <Tooltip label="Code view settings">
        <Popover.Trigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="desktop:-mr-1.5"
              aria-label="Code view settings"
              icon={<IconSliders size={18} />}
            />
          }
        />
      </Tooltip>
      {/* The content lens stands alone. File filtering and organization come
          next; lower-frequency rendering preferences come last. Every setting
          remains one row wearing the shape of its answer, which is the
          vocabulary in `ui/setting-row`. */}
      <Popover.Popup
        side="bottom"
        align="end"
        initialFocus
        className="flex w-[340px] flex-col gap-0.5 p-3"
      >
        {worktreeAvailable && (
          <>
            <DiffSourceSetting
              value={diffSource}
              onValueChange={setDiffSource}
            />
            <div aria-hidden className="mx-2 my-1.5 h-px bg-line" />
          </>
        )}
        <SettingRow label="Code view">
          <Segmented
            label="Code view"
            size="sm"
            value={codeView}
            onValueChange={(next) => {
              const key = next as CodeView;
              if (key === "flow" && codeView !== "flow" && codeFlowError) {
                resetCodeFlowError();
              }
              setCodeView(key);
            }}
          >
            <SegmentedOption value="all">Changes</SegmentedOption>
            <SegmentedOption value="guide">Guide</SegmentedOption>
            <SegmentedOption
              value="flow"
              disabled={
                (!diff?.patch && !diff?.skippedFiles) || !prPatchVersion
              }
            >
              Flow
            </SegmentedOption>
          </Segmented>
        </SettingRow>

        <div aria-hidden className="mx-2 my-1.5 h-px bg-line" />

        <CodeOrganizationSettings
          settings={organizationSettings}
          reviewedFilesAvailable={!!reviewedFiles}
          defaultOrderLabel="Pull request"
        />

        <div aria-hidden className="mx-2 my-1.5 h-px bg-line" />

        <CodeDisplaySettings {...codeDisplaySettings} />
      </Popover.Popup>
    </Popover.Root>
  );

  const pageOptions = [
    ["overview", "Overview", comments.length || undefined],
    ["files", "Files", files.length || undefined],
  ] as const;

  // Page navigation shares the identity bar on desktop, preserving the code
  // canvas' vertical space. Phone keeps the full-width row and larger targets.
  const titlePageSwitcher = (
    <Segmented
      label="Pull request pages"
      value={page}
      onValueChange={(next) => {
        if (next === "overview" || next === "files") setPage(next);
      }}
      size="sm"
      className="shrink-0 phone:hidden"
    >
      {pageOptions.map(([key, label, count]) => (
        <SegmentedOption key={key} value={key}>
          {label}
          {count !== undefined && (
            <span className="text-meta text-faint tabular-nums">{count}</span>
          )}
        </SegmentedOption>
      ))}
    </Segmented>
  );

  const phonePageTabs = pageOptions.map(([key, label, count]) => (
    <button
      key={key}
      role="tab"
      aria-selected={page === key}
      className={`flex h-11 shrink-0 items-center gap-1.5 border-0 bg-transparent px-3 text-control-label font-medium transition-colors ${
        page === key ? "text-fg" : "text-dim hover:text-fg"
      }`}
      onClick={() => setPage(key)}
    >
      {label}
      {count !== undefined && (
        <span
          className={`min-w-5 rounded-full px-[7px] py-px text-center text-meta font-semibold tabular-nums ${
            page === key ? "bg-accent-soft text-accent" : "bg-active text-dim"
          }`}
        >
          {count}
        </span>
      )}
    </button>
  ));

  const fileControls = page === "files" && (
    <div
      className={`flex shrink-0 items-center gap-1.5 phone:gap-2 ${compactToolbar ? "" : "ml-auto"}`}
    >
      {diffSource === "worktree" ? (
        <div
          ref={setWorktreeToolbarTarget}
          className="flex shrink-0 items-center gap-2.5 text-label"
        />
      ) : (
        <>
          {handEdited.length > 0 && send && (
            <Button
              variant="default"
              size="sm"
              onClick={tellAgentAboutEdits}
              title="Sends a note listing your hand-edits so they get committed and pushed"
            >
              Tell {AGENT_NAME} about {handEdited.length} edit
              {handEdited.length === 1 ? "" : "s"}
            </Button>
          )}
          <div
            ref={setDiffControlsTarget}
            className="flex shrink-0 items-center gap-1.5 phone:gap-2"
          />
          {codeSettings}
        </>
      )}
    </div>
  );

  const reviewBar = (
    <div className="flex h-11 shrink-0 items-center gap-2 overflow-x-auto overflow-y-hidden bg-surface px-2 [scrollbar-width:none] desktop:hidden [&::-webkit-scrollbar]:hidden">
      <div
        className="flex shrink-0 items-center gap-0.5 self-stretch"
        role="tablist"
        aria-orientation="horizontal"
        aria-label="Pull request pages"
      >
        {phonePageTabs}
      </div>
      {phoneLayout && fileControls}
    </div>
  );

  return (
    <div
      className={`selectable relative flex h-full min-h-0 flex-col bg-surface ${compactToolbar ? "overflow-x-hidden overflow-y-auto" : "overflow-hidden"}`}
      data-review-canvas="true"
      ref={setRoot}
    >
      {sessionActionTarget && sessionActionButton
        ? createPortal(sessionActionButton, sessionActionTarget)
        : null}
      {/* Desktop keeps page navigation and file controls in the identity row.
          Phone keeps one edge-to-edge navigation and controls row below it. */}
      <ReviewToolbar compact={compactToolbar}>
        <TopBar as="header" className="h-10 shrink-0 gap-2.5 px-4 phone:px-3">
          {/* State, in the app's own PR language, filled rather than drawn: the
            tone washes the whole chip and the glyph and word share its ink.
            It is its own object, so it gets more air than the pieces of the
            identity line it precedes. */}
          <Tooltip label={statusMark.label}>
            <span
              className={`mr-1.5 flex h-6 shrink-0 items-center gap-1.5 rounded-control px-2 ${statusMark.bgClassName} ${statusMark.className}`}
            >
              <PrStateIcon state={pr.state} isDraft={pr.isDraft} />
              {!headerCompact && (
                <span className="text-label font-medium">{stateLabel}</span>
              )}
            </span>
          </Tooltip>
          {targetPicker}
          {/* Author and title in the session header's own breadcrumb shape: a
            tight picture-and-name pill, a chevron, then the name of the thing
            you are looking at. Same spacing and weights as RepoBar's
            `[icon] repo › title`, so the two headers read as one bar. */}
          {!headerCompact && (
            <>
              <span className="flex shrink-0 items-center gap-[7px] text-item-title font-medium text-fg">
                <UserAvatar
                  name={pr.author}
                  login={provider.key === "github" ? pr.author : null}
                  size={18}
                  edge={false}
                  title={pr.author}
                />
                <span className="max-w-[180px] truncate">{pr.author}</span>
              </span>
              <IconChevronRight size={18} className="shrink-0 text-faint" />
            </>
          )}
          {/* Title only. Counts, commits and the sessions on this PR are the
            rail's job, so the bar stays one line of identity.

            The title is the name of the page you are already on, so it is
            inert. The outbound jump rides the number, which is the reference
            everywhere else in the app. */}
          <h1
            className="flex min-w-0 flex-1 items-baseline gap-1 text-item-title font-medium leading-[1.2] text-fg"
            title={`${pr.title} #${pr.number}`}
          >
            <span className="truncate">{pr.title}</span>
            <Tooltip label={`Open on ${provider.name}`}>
              <a
                className="shrink-0 font-normal text-faint no-underline hover:text-link"
                href={pr.url}
                target="_blank"
                rel="noopener"
              >
                #{pr.number}
              </a>
            </Tooltip>
          </h1>
          {titlePageSwitcher}
          {(compactToolbar || !phoneLayout) && fileControls}
          {/* A stack is secondary navigation, not page content. Keep its compact
            position/size chip in the identity bar and reveal the full rail in
            the shared popover instead of spending permanent canvas height. */}
          {caps.stacks && pr.stack && (
            <PrStackChip
              pr={pr}
              tone={statusMark.tone}
              size="bar"
              headline={statusMark.label}
              repo={active?.repo}
              onOpenPr={onOpenPr}
            />
          )}
          {pr.staging?.url && !headerCompact && (
            <Tooltip label="Open the preview environment">
              <a
                /* An icon-only control carries its glyph ~6px inside its box,
                 so the last one in the row is outdented to put that glyph on
                 the row's content edge — where the view control below it
                 sits, since a bordered control is flush with its own box. */
                className={`ml-auto inline-flex size-8 shrink-0 items-center justify-center rounded-control text-dim no-underline hover:bg-hover hover:text-fg ${pr.state === "OPEN" ? "" : "-mr-1.5"}`}
                href={pr.staging.url}
                target="_blank"
                rel="noopener"
                aria-label="Open the preview environment"
              >
                <IconGlobe size={19} />
              </a>
            </Tooltip>
          )}
          {pr.state === "OPEN" &&
            !pr.isDraft &&
            caps.reviewComments &&
            !reviewing &&
            !headerCompact && (
              /* The one call to action on a wide canvas, so it takes the accent
               plate. Compact canvases move it into the actions menu instead
               of squeezing the repository and pull request identity. */
              <Button
                variant="primary"
                size="sm"
                className={pr.staging?.url ? undefined : "ml-auto"}
                onClick={() => {
                  setDiffSource("pull-request");
                  setReviewing(true);
                  setPage("files");
                }}
              >
                Review
              </Button>
            )}
          {sessionActionTarget === undefined &&
            !headerCompact &&
            sessionActionButton}
          <Menu.Root>
            <Tooltip label="Pull request actions">
              <Menu.Trigger
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    className="-mr-1.5"
                    aria-label="Pull request actions"
                    icon={<IconDotsHorizontal size={18} />}
                  />
                }
              />
            </Tooltip>
            <Menu.Popup align="end">
              {headerCompact &&
                pr.state === "OPEN" &&
                !pr.isDraft &&
                caps.reviewComments &&
                !reviewing && (
                  <Menu.Item
                    onClick={() => {
                      setDiffSource("pull-request");
                      setReviewing(true);
                      setPage("files");
                    }}
                  >
                    <IconMessage size={18} className={MENU_ICON} />
                    <span className="min-w-0 flex-1 truncate">
                      Start review
                    </span>
                  </Menu.Item>
                )}
              {sessions &&
                sessionActionTarget === undefined &&
                headerCompact && (
                  <Menu.Item onClick={() => setSessionsOpen(true)}>
                    <IconMessages size={18} className={MENU_ICON} />
                    <span className="min-w-0 flex-1 truncate">
                      {relatedSessions.length === 0
                        ? "Start a session"
                        : relatedSessions.length === 1
                          ? "Open session"
                          : `Open ${relatedSessions.length} sessions`}
                    </span>
                  </Menu.Item>
                )}
              <Menu.Item
                render={<a href={pr.url} target="_blank" rel="noopener" />}
              >
                <BrandMark
                  name={provider.key}
                  size={16}
                  className={MENU_ICON}
                />
                <span className="min-w-0 flex-1 truncate">
                  Open on {provider.name}
                </span>
              </Menu.Item>
              {pr.staging?.url && (
                <Menu.Item
                  render={
                    <a href={pr.staging.url} target="_blank" rel="noopener" />
                  }
                >
                  <IconGlobe size={18} className={MENU_ICON} />
                  <span className="min-w-0 flex-1 truncate">Open preview</span>
                </Menu.Item>
              )}
              <Menu.Item
                onClick={() =>
                  copyPrLink(pr.url, { toast: "Pull request link copied" })
                }
              >
                <IconCopy size={18} className={MENU_ICON} />
                <span className="min-w-0 flex-1 truncate">Copy PR link</span>
              </Menu.Item>
              {pr.state === "OPEN" && (
                <>
                  <Menu.Separator />
                  {canMergeAfterReview && (
                    <Menu.Item onClick={handleMerge} disabled={merging}>
                      {mergeScheduled ? (
                        <IconUndo size={18} className={MENU_ICON} />
                      ) : (
                        <IconGitMerge size={18} className={MENU_ICON} />
                      )}
                      {merging
                        ? "Merging…"
                        : mergeScheduled
                          ? "Undo"
                          : "Squash and merge"}
                    </Menu.Item>
                  )}
                  <Menu.Item
                    className="text-red data-[highlighted]:bg-red-soft"
                    onClick={handleClose}
                    closeOnClick={confirmClose}
                    disabled={closing}
                  >
                    <IconX size={18} className={MENU_ICON} />
                    {closing
                      ? "Closing…"
                      : confirmClose
                        ? "Confirm close pull request"
                        : "Close pull request"}
                  </Menu.Item>
                </>
              )}
            </Menu.Popup>
          </Menu.Root>
        </TopBar>
        {reviewBar}
      </ReviewToolbar>

      {caps.stacks && !pr.stack && (
        <StackLinkSection pr={pr} sessionId={sessionId} onLinked={load} />
      )}

      {page === "overview" ? (
        <PrOverviewPage
          compactToolbar={compactToolbar}
          reviewing={reviewing}
          sessionId={sessionId}
          provider={provider}
          pr={pr}
          send={send}
          railStacked={railStacked}
          rail={rail}
          hideWideOverviewRail={hideWideOverviewRail}
          walkthrough={walkthrough}
          bodyHtml={bodyHtml}
          comments={comments}
          markdownRepo={markdownRepo}
          onAddToInput={onAddToInput}
        />
      ) : (
        <PrFilesPage
          compactToolbar={compactToolbar}
          reviewing={reviewing}
          diffSource={diffSource}
          fileListMode={fileListMode}
          files={files}
          reviewFiles={reviewFiles}
          showFileStats={showFileStats}
          onOpenFile={scrollToFile}
          sessionId={sessionId}
          sessionRunning={sessionRunning}
          canSend={!!send && !!editGate}
          send={send ?? NOOP_SEND}
          activeRepoId={activeRepoId}
          worktreeToolbarTarget={worktreeToolbarTarget}
          onDiffSourceChange={setDiffSource}
          codeView={codeView}
          codeFlowData={codeFlow?.key === codeFlowKey ? codeFlow.data : null}
          codeFlowLoading={
            codeFlowLoading || (codeFlow?.key !== codeFlowKey && !codeFlowError)
          }
          codeFlowError={codeFlowError}
          onRetryCodeFlow={() => void refreshCodeFlow()}
          diff={diff}
          diffOptions={diffOptions}
          diffError={diffError}
          diffLoading={diffLoading}
          diffOutOfDate={diffOutOfDate}
          onRetryDiff={retryDiff}
          guideLoading={guideLoading}
          currentGuide={currentGuide}
          guideFailed={guideFailed}
          onRetryGuide={() => void loadGuide()}
          guideSections={guideSections}
          grouping={grouping}
          diffGroups={diffGroups}
          diffGroupsLoading={diffGroupsLoading}
        />
      )}

      <ResponsiveDialog
        open={sessionsOpen}
        onClose={() => setSessionsOpen(false)}
        phone={isPhone}
        label="Sessions on this pull request"
        sheetClassName="max-h-[88dvh]"
        modalClassName="w-[min(460px,calc(100vw-32px))]"
      >
        <div className="flex min-h-0 flex-col">
          <div className="flex shrink-0 items-center gap-3 px-5 pb-3 pt-5 phone:pt-2">
            <div className="min-w-0 flex-1">
              <h2 className="text-item-title font-semibold text-fg">
                Sessions on this PR
              </h2>
              <p className="mt-0.5 text-supporting text-dim">
                Open existing work or start something new on this branch.
              </p>
            </div>
            <Button
              variant="ghost"
              className="size-10 shrink-0 phone:size-11"
              icon={<IconX size={20} />}
              aria-label="Close sessions"
              onClick={() => setSessionsOpen(false)}
            />
          </div>
          <div className="min-h-0 overflow-y-auto px-5 pb-5">
            <PrSessionsList
              sessions={relatedSessions}
              repo={active?.repo || ""}
              branch={active?.branch}
              pr={pr}
              currentSessionId={sessionId || undefined}
              onOpenSession={(id) => {
                setSessionsOpen(false);
                onOpenSessionById?.(id);
              }}
              send={send}
              addHandler={addHandler}
              compose
            />
          </div>
        </div>
      </ResponsiveDialog>

      {/* Review controls only exist while the person is actively reviewing.
          Passive PR browsing should not imply that a review is in progress. */}
      {reviewing && (
        <div className="pointer-events-none absolute bottom-4 left-4 right-4 z-10 flex min-h-[54px] items-center gap-3 rounded-md border border-line-strong bg-panel/95 px-3 py-2 smooth-shadow-soft backdrop-blur phone:flex-col phone:items-stretch phone:gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium text-fg">
              {reviewDone === "merged"
                ? "Approved and merged"
                : reviewDone
                  ? "Review submitted"
                  : !caps.reviewComments
                    ? "Review"
                    : pending.length > 0
                      ? `${pending.length} pending comment${pending.length === 1 ? "" : "s"}`
                      : "No pending comments"}
            </div>
            <div
              className={`mt-0.5 truncate text-supporting ${closeError ? "text-red" : "text-faint"}`}
              title={closeError || undefined}
            >
              {closeError ||
                (caps.reviewComments
                  ? "Comments are sent together when you finish the review"
                  : `${provider.name} has no reviews. Merge or close when you're done.`)}
            </div>
          </div>
          <div className="pointer-events-auto flex shrink-0 flex-wrap justify-end gap-2">
            {onOpenSession && (
              <Button
                variant="soft"
                className="text-xs"
                onClick={onOpenSession}
              >
                Open workspace
              </Button>
            )}
            <Button
              variant="soft"
              className="text-xs"
              onClick={() => setReviewing(false)}
            >
              Exit review
            </Button>
            {pr.state === "OPEN" && !pr.isDraft && caps.reviewComments && (
              <Button
                variant="success"
                className="text-xs"
                onClick={() => setReviewOpen(true)}
              >
                Finish review
              </Button>
            )}
          </div>
        </div>
      )}

      {reviewOpen && (
        <FinishReviewDialog
          prNumber={pr.number}
          pendingCount={pending.length}
          event={reviewEvent}
          onEventChange={setReviewEvent}
          defaultSummary={summaryDraft}
          canMerge={canMergeAfterReview}
          onFixChecks={
            checkSummary.failed > 0 && send ? handleFixChecks : undefined
          }
          mergeAfterReview={mergeAfterReview}
          onMergeAfterReviewChange={setMergeAfterReview}
          error={reviewError || mergeError}
          submitting={submitting}
          submitLabel={reviewSubmitLabel}
          onSubmit={handleSubmitReview}
          onClose={(summary) => {
            setSummaryDraft(summary);
            setReviewOpen(false);
          }}
        />
      )}
    </div>
  );
}
