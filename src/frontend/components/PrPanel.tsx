import { repoLabel } from "../lib/repo-label";
import { commitPrompt } from "../lib/commit-prompt";
import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import type {
  GitStatusInfo,
  DiffFileGroup,
  PrCheck,
  PrComment,
  PrCommit,
  PrDetails,
  PrFile,
  PrReviewer,
  SessionWalkthrough,
  UnifiedSession,
  WSServerMessage,
} from "../lib/types";
import { PrSessionsList, prRelatedSessions } from "./PrSessions";
import { WalkthroughCard } from "./WalkthroughCard";
import {
  API_BASE,
  fetchPr,
  fetchPrDiff,
  fetchPrDiffGroups,
  fetchPrViewedFiles,
  setPrFileViewed,
  fetchGitStatus,
  fetchReviewGuide,
  gitPushApi,
  submitPrReviewApi,
  mergePrApi,
  closePrApi,
  linkPrApi,
  linkPrStackApi,
  unlinkPrApi,
} from "../lib/api";
import {
  fetchPrPreview,
  fetchPrPreviewDiff,
  fetchPrPreviewGuide,
  submitPrPreviewReviewApi,
  mergePrPreviewApi,
  closePrPreviewApi,
} from "../lib/api";
import { prPath } from "../lib/share-link";
import { useIsPhone } from "../hooks/useIsPhone";
import { Button } from "../ui/button";
import { toast } from "../ui/toast";
import type { FileDiffMetadata } from "@pierre/diffs";
import { CommentableDiff, type CommentTarget, type PendingComment } from "./CommentableDiff";
import { SelectionToSession } from "./SelectionToSession";
import { getCurrentUser } from "./UserPicker";
import { renderMarkdown, renderPrCommentMarkdown } from "../lib/markdown";
import { isOutdatedReviewComment } from "../lib/pr-comments";
import { providerFromUrl, avatarUrl, type Provider } from "../lib/provider";
import { pollWhileVisible, PR_WEBHOOK_FALLBACK_POLL_MS } from "../lib/poll";
import {
  IconCheck,
  IconMessage,
  IconClock,
  IconX,
  IconFile,
} from "./icons";

type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

interface Props {
  sessionId: string;
  /** When provided, renders an "Open workspace" action (used by the Reviews view). */
  onOpenSession?: () => void;
  /** Append PR/check/comment context to this session's composer draft. */
  onAddToInput?: (text: string) => void;
  /** Side-by-side info|diff layout (Reviews drawer, session Review tab). */
  split?: boolean;
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
   * Preselect one of the targets — the PR chips in the Workspace strip open the
   * Review tab on a specific PR. `seq` is bumped per click so clicking the same
   * chip again re-focuses it after the user has switched tabs by hand.
   */
  focusTarget?: { repo?: string; branch?: string; view?: "checks"; seq: number };
  /** Offer the "Link PR" affordance (session Review tab; off in the Reviews drawer). */
  linkable?: boolean;
  /**
   * WebSocket sender. When provided, selecting text in the PR info column shows a
   * "Send to session" popover that delivers the selection + a message to this PR's
   * session (via a `prompt` message — the server steers/queues if it's busy).
   */
  send?: (msg: any) => void;
  /** Agent-published walkthrough (session.walkthrough) — rendered at the top
   *  of the info column; its mirrored section is stripped from the PR body. */
  walkthrough?: SessionWalkthrough;
  /** Diff-first review canvas used by the Pull requests sidebar inbox. */
  reviewCanvas?: boolean;
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
  /** Open another PR in this panel — used by the stack map to move between
   *  layers in-app. Without it the layer rows still link, just via a full
   *  page load. */
  onOpenPr?: (repo: string, branch: string) => void;
  /** WS handler hook — resets the new-session form on server errors. */
  addHandler?: (handler: (msg: WSServerMessage) => void) => () => void;
}

interface PrDiffData {
  number: number;
  headRefOid: string;
  patch: string;
}

/** A PR manually linked to the session (mirrors session.linkedPrs entries). */
export interface LinkedPrEntry {
  repo: string;
  branch: string;
  number?: number;
  url?: string;
  title?: string;
}

/**
 * One selectable PR in the panel: the primary repo's, an attached repo's, or a
 * manually linked one. Primary/attached target by repo id (the server resolves
 * the branch); linked PRs carry an explicit branch since they can live on any
 * branch — including another branch of the primary repo.
 */
interface PrTarget {
  key: string;
  repo: string;
  branch?: string;
  primary?: boolean;
  linked?: boolean;
  /** Found via the session link in the PR body, not stored on the session. */
  discovered?: boolean;
  label: string;
}

/** First target per key wins — a PR reached two ways (linked and discovered,
 *  or an attached repo whose branch also carries a discovered PR) is one tab. */
function dedupeTargets(targets: PrTarget[]): PrTarget[] {
  const seen = new Set<string>();
  return targets.filter((t) => {
    // An attached/primary repo tab has no branch of its own (the server
    // resolves it), so it can't collide with a branch-keyed target.
    const key = t.branch ? `${t.repo}\u0000${t.branch}` : `repo:${t.repo}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** One narrative section of the AI review guide (mirrors the server shape). */
interface ReviewGuideSection {
  title: string;
  explanation: string;
  files: string[];
}

export interface ReviewGuideData {
  number: number;
  headRefOid: string;
  sections: ReviewGuideSection[];
}

/** Split a unified diff into per-file chunks keyed by the new-side path. */
function splitPatchByFile(patch: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of patch.split(/^(?=diff --git )/m)) {
    if (!part.startsWith("diff --git ")) continue;
    const m = part.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    if (m) map.set(m[2], part);
  }
  return map;
}

/**
 * Pair each guide section with the slice of the unified diff covering its
 * files (so inline commenting keeps working inside the guide). Model paths are
 * matched exactly, then by suffix; files no section claimed come back as a
 * trailing "Everything else" section so guide mode never hides part of a PR.
 */
export function sectionsWithPatches(guide: ReviewGuideData, patch: string) {
  const byFile = splitPatchByFile(patch);
  const unclaimed = new Set(byFile.keys());
  const resolve = (file: string): string | null => {
    if (byFile.has(file)) return file;
    for (const path of byFile.keys())
      if (path.endsWith(`/${file}`) || file.endsWith(`/${path}`)) return path;
    return null;
  };
  const out = guide.sections.map((s) => {
    const chunks: string[] = [];
    for (const file of s.files) {
      const path = resolve(file);
      if (!path || !unclaimed.has(path)) continue;
      unclaimed.delete(path);
      chunks.push(byFile.get(path)!);
    }
    return { ...s, patch: chunks.join("") };
  });
  if (unclaimed.size > 0)
    out.push({
      title: "Everything else",
      explanation: "Changes the guide didn't group into a section.",
      files: [...unclaimed],
      patch: [...unclaimed].map((f) => byFile.get(f)!).join(""),
    });
  return out;
}

/** Provider-neutral PR-state glyph (open/draft share the branch icon). */
export function PrStateIcon({ state, isDraft }: { state: string; isDraft?: boolean }) {
  const common = { width: 15, height: 15, viewBox: "0 0 16 16", fill: "currentColor" as const };
  if (state === "MERGED")
    return (
      <svg {...common} aria-hidden>
        <path d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm0 2.122a2.25 2.25 0 1 0-1.5 0v5.256a2.251 2.251 0 1 0 1.5 0V7.5a3.5 3.5 0 0 0 3.5 3.5h1.128a2.251 2.251 0 1 0 0-1.5H8.5A2 2 0 0 1 6.5 7.5v-2.128ZM4.25 12a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5ZM12 9.25a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5Z" />
      </svg>
    );
  if (state === "CLOSED")
    return (
      <svg {...common} aria-hidden>
        <path d="M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 5.81-1.97 1.97a.75.75 0 1 1-1.06-1.06l1.97-1.97-1.97-1.97a.75.75 0 0 1 1.06-1.06l1.97 1.97 1.97-1.97a.75.75 0 1 1 1.06 1.06l-1.97 1.97 1.97 1.97a.75.75 0 1 1-1.06 1.06l-1.97-1.97ZM2.5 13.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 4a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z" />
      </svg>
    );
  return (
    <svg {...common} aria-hidden>
      <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
    </svg>
  );
}

/** One-line derived status: the state label + a tone + an optional qualifier. */
interface StatusLine {
  key: string;
  label: string; // Open / Merged / Closed / Draft
  qualifier: string | null; // Ready to merge / Blocked / Changes requested / …
  tone: "green" | "purple" | "red" | "yellow" | "muted";
}

function deriveStatus(pr: PrDetails): StatusLine {
  if (pr.state === "MERGED")
    return { key: "merged", label: "Merged", qualifier: null, tone: "purple" };
  if (pr.state === "CLOSED")
    return { key: "closed", label: "Closed", qualifier: null, tone: "muted" };
  if (pr.isDraft) return { key: "draft", label: "Draft", qualifier: null, tone: "muted" };
  if (pr.mergeable === "CONFLICTING")
    return { key: "conflicts", label: "Open", qualifier: "Merge conflicts", tone: "red" };
  const checks = summarize(pr.checks);
  if (checks.failed > 0)
    return { key: "failing", label: "Open", qualifier: "Checks failed", tone: "red" };
  if (pr.reviewDecision === "CHANGES_REQUESTED")
    return { key: "changes", label: "Open", qualifier: "Changes requested", tone: "red" };
  if (checks.pending > 0)
    return { key: "running", label: "Open", qualifier: "Checks running", tone: "yellow" };
  if (pr.reviewDecision === "REVIEW_REQUIRED")
    return { key: "review", label: "Open", qualifier: "Review required", tone: "yellow" };
  return { key: "ready", label: "Open", qualifier: "Ready to merge", tone: "green" };
}

function summarize(checks: PrCheck[]) {
  let passed = 0,
    failed = 0,
    pending = 0;
  for (const c of checks) {
    const cls = checkClass(c.status, c.conclusion);
    if (cls === "check-success") passed++;
    else if (cls === "check-failure") failed++;
    else if (cls === "check-pending") pending++;
  }
  return { passed, failed, pending, total: checks.length };
}

export function PrPanel({
  sessionId,
  onOpenSession,
  onAddToInput,
  split,
  repos,
  linkedPrs,
  discoveredPrs,
  focusTarget,
  linkable,
  send,
  walkthrough,
  reviewCanvas,
  previewTarget,
  sessions,
  onOpenSessionById,
  onOpenPr,
  addHandler,
}: Props) {
  // Local copy of the linked-PR list so link/unlink applies instantly; the
  // sessions list catches up on its next refresh.
  const [linkedLocal, setLinkedLocal] = useState<LinkedPrEntry[] | null>(null);
  const linked = linkedLocal ?? linkedPrs ?? [];
  const targets = useMemo<PrTarget[]>(
    () => dedupeTargets([
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
        linked: true,
        label: lp.number
          ? `${repoLabel(lp.repo)} #${lp.number}`
          : `${repoLabel(lp.repo)}:${lp.branch}`,
      })),
      // Last, so an explicit link (which owns the unlink affordance) wins the
      // dedupe over the same PR discovered from its body footer.
      ...(previewTarget ? [] : discoveredPrs ?? []).map((dp) => ({
        key: `${dp.repo} ${dp.branch}`,
        repo: dp.repo,
        branch: dp.branch,
        discovered: true,
        label: dp.number
          ? `${repoLabel(dp.repo)} #${dp.number}`
          : `${repoLabel(dp.repo)}:${dp.branch}`,
      })),
    ]),
    [repos, linked, discoveredPrs, previewTarget?.repo, previewTarget?.branch],
  );
  const [activeKey, setActiveKey] = useState<string | undefined>(
    () => (targets.find((t) => t.primary) ?? targets[0])?.key,
  );
  const active = targets.find((t) => t.key === activeKey) ?? targets[0];
  // A PR chip in the Workspace strip opened the Review tab on a specific PR.
  // Keyed on `seq` so re-clicking the same chip re-focuses it, and so a
  // re-render never fights the user's own tab choice.
  useEffect(() => {
    if (!focusTarget) return;
    if (focusTarget.repo) {
      const match =
        targets.find(
          (t) =>
            t.repo === focusTarget.repo &&
            (focusTarget.branch ? t.branch === focusTarget.branch : !t.branch),
        ) ?? targets.find((t) => t.repo === focusTarget.repo);
      if (match) setActiveKey(match.key);
    }
    if (focusTarget.view) setDiffView(focusTarget.view);
  }, [focusTarget?.seq]);
  const loadTargetKey = previewTarget
    ? `preview:${previewTarget.repo}:${previewTarget.branch}`
    : active?.key || sessionId;
  const [pr, setPr] = useState<PrDetails | null>(null);
  const [git, setGit] = useState<GitStatusInfo | null>(null);
  const [loadedDiff, setDiff] = useState<PrDiffData | null>(null);
  const diff = loadedDiff?.headRefOid === pr?.headRefOid ? loadedDiff : null;
  const diffOutOfDate = !!loadedDiff && !diff;
  const [diffGroups, setDiffGroups] = useState<{
    oid: string;
    groups: DiffFileGroup[] | null;
  } | null>(null);
  const [diffGroupsLoading, setDiffGroupsLoading] = useState(false);
  const [diffGroupsRetry, setDiffGroupsRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(true);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingComment[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewEvent, setReviewEvent] = useState<ReviewEvent>(() =>
    reviewCanvas ? "APPROVE" : "COMMENT",
  );
  const [summary, setSummary] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewDone, setReviewDone] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const [confirmMerge, setConfirmMerge] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [mergeAfterReview, setMergeAfterReview] = useState(reviewCanvas === true);
  const [checksOpen, setChecksOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [allFilesOpen, setAllFilesOpen] = useState(false);
  const [diffView, setDiffView] = useState<
    "guide" | "diff" | "checks" | "conversation" | "commits"
  >(() => "diff");
  const [diffStyle, setDiffStyle] = useState<"unified" | "split">(() => {
    const stored = localStorage.getItem("opensession-pr-diff-style");
    if (stored === "unified" || stored === "split") return stored;
    // Side-by-side columns don't fit a phone viewport, so phones default to unified.
    return window.matchMedia("(max-width: 720px)").matches ? "unified" : "split";
  });
  const changeDiffStyle = (style: "unified" | "split") => {
    setDiffStyle(style);
    try {
      localStorage.setItem("opensession-pr-diff-style", style);
    } catch {}
  };
  const [guide, setGuide] = useState<ReviewGuideData | null>(null);
  const [guideLoading, setGuideLoading] = useState(false);
  const [guideFailed, setGuideFailed] = useState(false);
  // GitHub's per-viewer "Viewed" file state for the shown PR (review canvas
  // checkboxes). Keyed so a stale PR's set never leaks onto the next one.
  const [prViewed, setPrViewed] = useState<{
    key: string;
    prId: string;
    viewed: ReadonlySet<string>;
  } | null>(null);
  const prViewedRef = useRef(prViewed);
  prViewedRef.current = prViewed;
  const [bodyOpen, setBodyOpen] = useState(false);
  const [bodyOverflows, setBodyOverflows] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const loadGenerationRef = useRef(0);
  const activeLoadTargetRef = useRef(loadTargetKey);
  const loadInFlightRef = useRef<{ key: string; promise: Promise<void> } | null>(null);
  activeLoadTargetRef.current = loadTargetKey;

  const load = useCallback((force = false): Promise<void> => {
    if (loadTargetKey !== activeLoadTargetRef.current) return Promise.resolve();
    const existing = loadInFlightRef.current;
    if (!force && existing?.key === loadTargetKey) return existing.promise;

    const generation = ++loadGenerationRef.current;
    setDiffLoading(true);
    let prSettled = false;
    let diffSettled = false;
    let prResult: PrDetails | null = null;
    let diffResult: PrDiffData | null = null;
    const isCurrent = () =>
      generation === loadGenerationRef.current &&
      loadTargetKey === activeLoadTargetRef.current;
    const commitDiff = () => {
      if (!isCurrent() || !prSettled || !diffSettled) return;
      setDiff(
        diffResult?.headRefOid === prResult?.headRefOid ? diffResult : null,
      );
      setDiffLoading(false);
    };
    const prRequest = (previewTarget
      ? fetchPrPreview(previewTarget.repo, previewTarget.branch)
      : fetchPr(sessionId, active?.repo, active?.branch)
    )
      .then((data) => {
        prSettled = true;
        prResult = data;
        if (isCurrent()) {
          setPr(data);
          setLoadError(null);
        }
        commitDiff();
      })
      .catch((e: any) => {
        prSettled = true;
        prResult = null;
        if (isCurrent()) setLoadError(e?.message || "Failed to load the pull request.");
        commitDiff();
      })
      .finally(() => {
        if (isCurrent()) setLoading(false);
      });
    const diffRequest = (previewTarget
      ? fetchPrPreviewDiff(previewTarget.repo, previewTarget.branch)
      : fetchPrDiff(sessionId, active?.repo, active?.branch)
    )
      .then((data) => {
        diffSettled = true;
        diffResult = data;
        if (isCurrent()) setDiffError(null);
        commitDiff();
      })
      .catch((e: any) => {
        diffSettled = true;
        diffResult = null;
        if (isCurrent()) setDiffError(e?.message || "Failed to load pull request changes.");
        commitDiff();
      });
    // A linked PR has no local worktree in this session — no git state.
    const gitRequest = (previewTarget || active?.linked
      ? Promise.resolve(null)
      : fetchGitStatus(sessionId, active?.repo)
    )
      .then((data) => {
        if (isCurrent()) setGit(data);
      })
      .catch(() => {
        if (isCurrent()) setGit(null);
      });

    const promise = Promise.allSettled([prRequest, diffRequest, gitRequest]).then(
      () => undefined,
    );
    loadInFlightRef.current = { key: loadTargetKey, promise };
    void promise.then(() => {
      if (loadInFlightRef.current?.promise === promise) loadInFlightRef.current = null;
    });
    return promise;
  }, [
    sessionId,
    loadTargetKey,
    active?.repo,
    active?.branch,
    active?.linked,
    previewTarget?.repo,
    previewTarget?.branch,
  ]);

  useEffect(() => {
    setLoading(true);
    setLoadError(null);
    setDiffLoading(true);
    setDiffError(null);
    setPr(null);
    setDiff(null);
    setGit(null);
    setPending([]);
    setPrViewed(null);
    load();
    const stopPolling = pollWhileVisible(load, PR_WEBHOOK_FALLBACK_POLL_MS);
    return () => {
      stopPolling();
      loadGenerationRef.current += 1;
    };
  }, [load]);

  // A GitHub webhook reported activity on the shown PR's branch (review, CI,
  // push, merge) — refetch immediately. Primary targets omit their branch, so
  // match those through the loaded PR number/head branch instead.
  // The server invalidated its caches before broadcasting, so this reads
  // fresh data.
  useEffect(() => {
    if (!addHandler) return;
    return addHandler((msg) => {
      if (msg.type !== "pr_updated") return;
      const branch = previewTarget?.branch ?? active?.branch;
      const repo = previewTarget?.repo ?? active?.repo;
      if (
        msg.repo === repo &&
        (branch
          ? msg.branch === branch
          : !pr || msg.number === pr.number || msg.branch === pr.headRefName)
      )
        void load(true);
    });
  }, [
    addHandler,
    load,
    previewTarget?.repo,
    previewTarget?.branch,
    active?.repo,
    active?.branch,
    pr?.number,
    pr?.headRefName,
  ]);

  useEffect(() => {
    const files = pr?.files || [];
    if (!diff?.patch || files.length < 3) {
      setDiffGroups(null);
      setDiffGroupsLoading(false);
      return;
    }
    setDiffGroups(null);
    setDiffGroupsLoading(true);
    let live = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const retryLater = () => {
      retryTimer = setTimeout(() => setDiffGroupsRetry((attempt) => attempt + 1), 125_000);
    };
    fetchPrDiffGroups(
      sessionId,
      files,
      diff.patch,
      active?.repo,
      active?.branch,
    )
      .then((result) => {
        if (!live) return;
        setDiffGroups({ oid: diff.headRefOid, groups: result.groups });
        if (!result.groups) retryLater();
      })
      .catch(() => {
        if (!live) return;
        setDiffGroups({ oid: diff.headRefOid, groups: null });
        retryLater();
      })
      .finally(() => {
        if (live) setDiffGroupsLoading(false);
      });
    return () => {
      live = false;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [
    sessionId,
    active?.repo,
    active?.branch,
    diff?.headRefOid,
    pr?.files?.length,
    diffGroupsRetry,
  ]);

  const loadGuide = useCallback(async () => {
    setGuideLoading(true);
    setGuideFailed(false);
    try {
      const data = previewTarget
        ? await fetchPrPreviewGuide(previewTarget.repo, previewTarget.branch)
        : await fetchReviewGuide(sessionId, active?.repo, active?.branch);
      if (data) setGuide(data);
      else setGuideFailed(true);
    } catch {
      setGuideFailed(true);
    } finally {
      setGuideLoading(false);
    }
  }, [
    sessionId,
    active?.repo,
    active?.branch,
    previewTarget?.repo,
    previewTarget?.branch,
  ]);

  // The guide is generated on demand (the first request per head commit takes
  // the model a while) — only fetch once the reviewer opens the Guide tab, and
  // refetch when a new push moves the head commit.
  useEffect(() => {
    if (diffView !== "guide" || !diff?.patch) return;
    if (guideLoading || guideFailed) return;
    if (guide && guide.headRefOid === diff.headRefOid) return;
    void loadGuide();
  }, [diffView, diff?.patch, diff?.headRefOid, guide, guideLoading, guideFailed, loadGuide]);

  // Conversation stays first in the DOM, but narrow screens should still reveal
  // the selected tab (Files changed is the default review surface).
  useEffect(() => {
    if (!reviewCanvas) return;
    requestAnimationFrame(() => {
      const tab = rootRef.current?.querySelector<HTMLElement>(
        '[role="tablist"] [aria-selected="true"]',
      );
      const tabList = tab?.parentElement;
      if (!tab || !tabList || tabList.scrollWidth <= tabList.clientWidth) return;
      tabList.scrollTo({
        left: tab.offsetLeft - (tabList.clientWidth - tab.offsetWidth) / 2,
      });
    });
  }, [diffView, pr?.number, reviewCanvas]);

  // Inline comments don't post one-by-one — they accumulate as pending and ship
  // together when the reviewer finishes the review (the provider's native flow).
  async function handleAddPending(target: CommentTarget, text: string) {
    setPending((prev) => [...prev, { ...target, text, id: crypto.randomUUID() }]);
    setReviewDone(null);
  }

  function handleRemovePending(id: string) {
    setPending((prev) => prev.filter((c) => c.id !== id));
  }

  async function handleSubmitReview() {
    if (submitting) return;
    const actionTargetKey = loadTargetKey;
    if (
      pending.length === 0 &&
      !summary.trim() &&
      reviewEvent !== "APPROVE"
    ) {
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
        comments: pending.map((c) => ({
          text: c.text,
          path: c.path,
          line: c.endLine,
          startLine: c.startLine !== c.endLine ? c.startLine : undefined,
          side: (c.side === "deletions" ? "LEFT" : "RIGHT") as
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
      if (reviewCanvas && reviewEvent === "APPROVE" && mergeAfterReview) {
        try {
          if (previewTarget)
            await mergePrPreviewApi(
              previewTarget.repo,
              previewTarget.branch,
              "squash",
            );
          else
            await mergePrApi(sessionId, "squash", active?.repo, active?.branch);
          merged = true;
        } catch (e: any) {
          setMergeError(
            `Review approved, but merge failed: ${e.message || "unknown error"}`,
          );
        }
      }
      if (actionTargetKey !== activeLoadTargetRef.current) return;
      setPending([]);
      setSummary("");
      setReviewOpen(false);
      setReviewEvent(reviewCanvas ? "APPROVE" : "COMMENT");
      setReviewDone(merged ? "merged" : result.url || "submitted");
      setTimeout(() => setReviewDone(null), 6000);
      await load(true);
    } catch (e: any) {
      if (actionTargetKey === activeLoadTargetRef.current)
        setReviewError(e.message || "Failed to submit review");
    } finally {
      setSubmitting(false);
    }
  }

  // Two-click confirm guards against accidental merges (this mutates the repo).
  async function handleMerge() {
    if (!confirmMerge) {
      setConfirmMerge(true);
      setMergeError(null);
      setTimeout(() => setConfirmMerge(false), 4000);
      return;
    }
    setConfirmMerge(false);
    setMerging(true);
    setMergeError(null);
    const actionTargetKey = loadTargetKey;
    try {
      if (previewTarget)
        await mergePrPreviewApi(
          previewTarget.repo,
          previewTarget.branch,
          "squash",
        );
      else await mergePrApi(sessionId, "squash", active?.repo, active?.branch);
      if (actionTargetKey === activeLoadTargetRef.current) await load(true);
    } catch (e: any) {
      if (actionTargetKey === activeLoadTargetRef.current)
        setMergeError(e.message || "Merge failed");
    } finally {
      setMerging(false);
    }
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
      if (previewTarget)
        await closePrPreviewApi(previewTarget.repo, previewTarget.branch);
      else await closePrApi(sessionId, active?.repo, active?.branch);
      if (actionTargetKey === activeLoadTargetRef.current) await load(true);
    } catch (e: any) {
      if (actionTargetKey === activeLoadTargetRef.current)
        setCloseError(e.message || "Failed to close pull request");
    } finally {
      setClosing(false);
    }
  }

  // Roll the per-check list up into headline counts, and split deployments
  // (Vercel previews & friends) from CI checks — failing and running entries
  // sort first within each group.
  const checkSummary = useMemo(() => {
    const checks = pr?.checks || [];
    const s = summarize(checks);
    const rank = (c: PrCheck) => {
      const cls = checkClass(c.status, c.conclusion);
      return cls === "check-failure" ? 0 : cls === "check-pending" ? 1 : cls === "check-success" ? 3 : 2;
    };
    const sorted = [...checks].sort((a, b) => rank(a) - rank(b));
    return {
      ...s,
      deployments: sorted.filter(isDeployment),
      checks: sorted.filter((c) => !isDeployment(c)),
    };
  }, [pr]);

  const bodyHtml = useMemo(() => {
    if (!pr?.body) return "";
    // The mirrored walkthrough section is link-only (GitHub can't reach the
    // tailnet media) — drop it here, where WalkthroughCard renders the real thing.
    const stripped = pr.body
      .replace(
        /<!-- opensession:walkthrough -->[\s\S]*?<!-- \/opensession:walkthrough -->/,
        "",
      )
      .trim();
    return stripped ? renderMarkdown(stripped) : "";
  }, [pr?.body]);
  const provider = useMemo(() => providerFromUrl(pr?.url), [pr?.url]);

  // Only offer the expand toggle when the clamped description is actually taller
  // than its collapsed height — a two-line PR body shouldn't get a "Show more".
  useEffect(() => {
    if (bodyOpen) return;
    const el = bodyRef.current;
    setBodyOverflows(!!el && el.scrollHeight - el.clientHeight > 4);
  }, [bodyHtml, bodyOpen]);

  // Files card → diff: scroll the matching file section into view (and open it).
  const scrollToFile = useCallback((path: string) => {
    const root = rootRef.current;
    if (!root) return;
    const el = root.querySelector<HTMLElement>(`[data-diff-file="${CSS.escape(path)}"]`);
    if (!el) {
      const group = [...root.querySelectorAll<HTMLElement>("[data-diff-group-files]")].find(
        (header) => {
          try {
            return JSON.parse(header.dataset.diffGroupFiles || "[]").includes(path);
          } catch {
            return false;
          }
        },
      );
      if (group?.getAttribute("aria-expanded") === "false") {
        group.click();
        requestAnimationFrame(() => scrollToFile(path));
      }
      return;
    }
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    const header = el.querySelector<HTMLElement>(".diff-file-header");
    if (header && header.getAttribute("aria-expanded") === "false") header.click();
  }, []);

  // Changed images render as pictures, served from the repo at the PR's head
  // (new side) / base (old side) refs through the pr-image endpoint.
  const prBase = pr?.baseRefName;
  const prHead = pr?.headRefName;
  const activeRepoId = active?.repo;
  const prImageSrcs = useCallback(
    (file: FileDiffMetadata) => {
      const src = (ref: string, p: string) =>
        `${API_BASE}/pr-image?${activeRepoId ? `repo=${encodeURIComponent(activeRepoId)}&` : ""}ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(p)}`;
      return {
        oldSrc: prBase ? src(prBase, file.prevName || file.name) : undefined,
        newSrc: prHead ? src(prHead, file.name) : undefined,
      };
    },
    [prBase, prHead, activeRepoId],
  );

  // GitHub "Viewed" state: fetched per PR (and refetched when the head moves,
  // since a push flips changed files to DIRTY = unviewed on GitHub's side).
  const viewedKey = diff ? `${activeRepoId || "pr"}#${diff.number}` : null;
  useEffect(() => {
    if (!viewedKey || !diff) return;
    let live = true;
    fetchPrViewedFiles(activeRepoId, diff.number, getCurrentUser())
      .then((res) => {
        if (!live) return;
        setPrViewed({ key: viewedKey, prId: res.prId, viewed: new Set(res.viewed) });
      })
      .catch(() => {
        // Leave prViewed unset — checkboxes just stay hidden for this PR.
      });
    return () => {
      live = false;
    };
  }, [viewedKey, diff?.headRefOid]);

  const handleToggleViewed = useCallback((path: string, next: boolean) => {
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
    void setPrFileViewed(info.prId, path, next, getCurrentUser()).catch(() => {
      setPrViewed((prev) =>
        prev && prev.key === info.key
          ? { ...prev, viewed: apply(prev.viewed, !next) }
          : prev,
      );
    });
  }, []);

  function handleLinked(all: LinkedPrEntry[], justLinked: LinkedPrEntry) {
    setLinkedLocal(all);
    setActiveKey(`${justLinked.repo} ${justLinked.branch}`);
  }

  async function handleUnlink(t: PrTarget) {
    try {
      const res = await unlinkPrApi(sessionId, t.repo, t.branch!);
      setLinkedLocal(res.all);
      if (activeKey === t.key)
        setActiveKey((targets.find((x) => x.primary) ?? targets[0])?.key);
      toast("PR unlinked");
    } catch (e: any) {
      toast(e.message || "Couldn't unlink the PR");
    }
  }

  // Tab bar across the top: one tab per PR (primary repo, attached repos,
  // linked PRs) plus the link affordance. With a single target the bar
  // disappears and "Link PR" moves into the actions row instead.
  // Sessions linked to the shown PR — only when the caller wires the list.
  // Matched against the ACTIVE target (linked PRs carry their own branch; the
  // primary/attached branch resolves through the loaded PR's headRefName).
  const relatedSessions = useMemo(
    () =>
      sessions && active
        ? prRelatedSessions(sessions, active.repo, active.branch, pr)
        : [],
    [sessions, active?.repo, active?.branch, pr?.number, pr?.headRefName],
  );

  const showBar = targets.length > 1;
  const switcher = showBar ? (
    <div className="pr-repo-tabs">
      {targets.map((t) => (
        <button
          key={t.key}
          className={`pr-repo-tab ${t.key === active?.key ? "pr-repo-tab-active" : ""}`}
          onClick={() => setActiveKey(t.key)}
          title={
            t.linked
              ? `Linked PR — branch ${t.branch}`
              : t.discovered
                ? `PR opened by this session — branch ${t.branch}`
                : t.primary
                  ? "Primary repo"
                  : "Attached repo"
          }
        >
          {t.label}
          {t.linked && t.key === active?.key && (
            <span
              className="pr-repo-tab-x"
              role="button"
              title="Unlink this PR from the session"
              onClick={(e) => {
                e.stopPropagation();
                void handleUnlink(t);
              }}
            >
              <IconX size={12} />
            </span>
          )}
        </button>
      ))}
      {linkable && (
        <LinkPrControl sessionId={sessionId} variant="tab" onLinked={handleLinked} />
      )}
    </div>
  ) : null;

  if (loading)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {switcher}
        <div className="panel-placeholder">Loading pull request…</div>
      </div>
    );

  if (loadError && !pr)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {switcher}
        <div className="panel-placeholder panel-error">
          <div>{loadError}</div>
          <Button
            size="sm"
            className="mt-3"
            onClick={() => {
              setLoading(true);
              setLoadError(null);
              void load(true);
            }}
          >
            Retry
          </Button>
        </div>
      </div>
    );

  if (!pr)
    return (
        <div className={`flex min-h-0 flex-1 flex-col ${reviewCanvas ? "h-full overflow-y-auto" : ""}`}>
          {switcher}
          <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4 px-4 py-4 sm:px-5">
            {walkthrough && <WalkthroughCard walkthrough={walkthrough} />}
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
            {linkable && !showBar && (
              <div className="flex flex-wrap items-center gap-2">
                <LinkPrControl sessionId={sessionId} variant="action" onLinked={handleLinked} />
              </div>
            )}
        </div>
      </div>
    );

  const status = deriveStatus(pr);
  const files = pr.files || [];
  const reviewers = pr.reviewers || [];
  // Bot bookkeeping comments are pure HTML markers — hide them, and strip
  // leading markers from real comments' previews.
  const comments = (pr.comments || []).filter(
    (c) => stripHtmlComments(c.body) && !isOutdatedReviewComment(c.body),
  );

  if (reviewCanvas) {
    const canMergeAfterReview =
      pr.state === "OPEN" &&
      !pr.isDraft &&
      pr.mergeable !== "CONFLICTING" &&
      checkSummary.failed === 0 &&
      checkSummary.pending === 0;
    const guideSections =
      guide && diff?.patch ? sectionsWithPatches(guide, diff.patch) : [];
    const reviewSubmitLabel =
      reviewEvent === "APPROVE"
        ? mergeAfterReview && canMergeAfterReview
          ? "Approve & merge"
          : "Approve"
        : reviewEvent === "REQUEST_CHANGES"
          ? "Request changes"
          : "Submit review";
    return (
      <div
        className="selectable relative flex h-full min-h-0 flex-col overflow-hidden bg-surface"
        data-review-canvas="true"
        ref={rootRef}
      >
        {switcher}

        {/* The whole PR — title, branch line, git status, stack, tabs — lives
            inside the one scroll container so the identity scrolls away with
            the diff. Only the tab row sticks, so the reviewer keeps a way back
            to Conversation/Commits/Checks once they're deep in a file. */}
        <main className="min-h-0 flex-1 overflow-y-auto bg-surface pb-24">
          <header className="flex min-h-[96px] shrink-0 items-center gap-5 px-6 py-4 max-[720px]:min-h-[78px] max-[720px]:px-3">
            <div className="min-w-0 flex-1">
              <a
                className="block truncate text-page-title font-semibold tracking-[-0.025em] text-fg no-underline hover:text-accent max-[720px]:text-section-title"
                href={pr.url}
                target="_blank"
                rel="noopener"
              >
                {pr.title} <span className="font-normal text-faint">#{pr.number}</span>
              </a>
              <div className="mt-2 flex items-center gap-2 overflow-hidden whitespace-nowrap text-xs text-dim">
                <span className="truncate">
                  <strong>{pr.author}</strong> wants to merge {pr.commits?.length || 0} commit{pr.commits?.length === 1 ? "" : "s"} into
                  {" "}<span className="rounded-sm bg-blue-soft px-1.5 py-0.5 text-blue">{pr.baseRefName}</span>
                  {" "}from <span className="rounded-sm bg-blue-soft px-1.5 py-0.5 text-blue">{pr.headRefName}</span>
                </span>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2 max-[760px]:hidden">
              {sessions && (
                <button
                  className="border-0 bg-transparent px-1 py-2 text-xs font-medium text-dim hover:text-fg"
                  onClick={() => setSessionsOpen(true)}
                  title="Sessions linked to this PR"
                >
                  Sessions{relatedSessions.length > 0 ? ` · ${relatedSessions.length}` : ""}
                </button>
              )}
              {pr.staging?.url && (
                <a
                  className="px-1 py-2 text-xs font-medium text-dim no-underline hover:text-fg"
                  href={pr.staging.url}
                  target="_blank"
                  rel="noopener"
                >
                  Preview
                </a>
              )}
              {onOpenSession && (
                <button
                  className="border-0 bg-transparent px-1 py-2 text-xs font-medium text-dim hover:text-fg"
                  onClick={onOpenSession}
                >
                  Open workspace
                </button>
              )}
            </div>
          </header>

          {/* Only the branch work that is still outstanding — the PR verdict and
              its Merge button belong to the session header's status bar, which is
              on screen whether or not the workspace panel is open. */}
          <GitDivergenceStrip
            git={git}
            pr={pr}
            sessionId={sessionId}
            repo={active?.repo}
            send={send}
            onRefresh={load}
            onMerge={handleMerge}
            merging={merging}
            confirmMerge={confirmMerge}
          />

          {/* Where this PR sits in its chain of layers — directly under Git
              status, because it reframes what that status means. */}
          <StackSection pr={pr} sessionId={sessionId} repo={active?.repo} onOpenPr={onOpenPr} onLinked={load} />

          {/* The row's bottom line is an inset shadow, not a border: the active tab
              covers it with its own surface-coloured bottom border while sitting
              flush inside the box, so nothing overflows vertically (a 1px overflow
              here parks a scrollbar, since the foundation opts Chrome out of overlay
              scrollbars). Horizontal scrollbars are hidden for the same reason. */}
          <div
            className="sticky top-0 z-[8] flex h-[52px] shrink-0 items-end gap-1 overflow-x-auto overflow-y-hidden bg-surface px-6 shadow-[inset_0_-1px_0_var(--border)] [scrollbar-width:none] max-[720px]:px-2 [&::-webkit-scrollbar]:hidden"
            role="tablist"
          >
            {([
              ["conversation", "Conversation", comments.length, <IconMessage size={17} />],
              ["commits", "Commits", pr.commits?.length || 0, <CommitIcon />],
              ["checks", "Checks", checkSummary.total, <IconCheck size={17} />],
              ["diff", "Files changed", files.length, <IconFile size={17} />],
            ] as const).map(([key, label, count, icon]) => {
              const activeTab = key === "diff" ? diffView === "diff" || diffView === "guide" : diffView === key;
              return (
                <button
                  key={key}
                  role="tab"
                  aria-selected={activeTab}
                  className={`flex h-[44px] shrink-0 items-center gap-2 rounded-t-md border px-4 text-control-label font-medium ${activeTab ? "border-line border-b-surface bg-surface text-fg" : "border-transparent bg-transparent text-dim hover:border-line hover:bg-hover hover:text-fg"}`}
                  onClick={() => setDiffView(key)}
                >
                  {icon}
                  {label}
                  <span className="rounded-full bg-active px-2 py-0.5 text-meta font-semibold text-dim">{count}</span>
                </button>
              );
            })}
            <span className="ml-auto mb-3 shrink-0 text-meta max-[720px]:hidden">
              <span className="text-green">+{pr.additions}</span>{" "}
              <span className="text-red">−{pr.deletions}</span>
            </span>
          </div>

          {(diffView === "diff" || diffView === "guide") && (
            <div className="sticky top-[52px] z-[7] flex h-[54px] items-center border-b border-line bg-surface/95 px-6 backdrop-blur max-[720px]:px-2">
              <div className="inline-flex rounded-md border border-line bg-panel p-0.5">
                <Button
                  variant="ghost"
                  size="sm"
                  className={`rounded-sm border-0 px-3 py-1.5 text-xs font-medium ${diffView === "diff" ? "bg-active text-fg" : "hover:bg-transparent"}`}
                  onClick={() => setDiffView("diff")}
                >
                  All changes
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className={`rounded-sm border-0 px-3 py-1.5 text-xs font-medium ${diffView === "guide" ? "bg-active text-fg" : "hover:bg-transparent"}`}
                  onClick={() => setDiffView("guide")}
                >
                  Review guide
                </Button>
              </div>
              <div className="ml-auto flex items-center gap-3">
                {pending.length > 0 && (
                  <span className="text-meta text-faint">
                    {pending.length} pending comment{pending.length === 1 ? "" : "s"}
                  </span>
                )}
                <div className="inline-flex rounded-md border border-line bg-panel p-0.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    className={`rounded-sm border-0 px-2.5 py-1 text-meta font-medium ${diffStyle === "unified" ? "bg-active text-fg" : "hover:bg-transparent"}`}
                    onClick={() => changeDiffStyle("unified")}
                  >
                    Unified
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={`rounded-sm border-0 px-2.5 py-1 text-meta font-medium ${diffStyle === "split" ? "bg-active text-fg" : "hover:bg-transparent"}`}
                    onClick={() => changeDiffStyle("split")}
                  >
                    Split
                  </Button>
                </div>
              </div>
            </div>
          )}

          <div className={`${diffView === "diff" || diffView === "guide" ? "mx-auto max-w-[1500px] px-5 py-5 max-[720px]:px-2" : "mx-auto max-w-[900px] px-5 py-7 max-[720px]:px-3"}`}>
              {diffView === "checks" ? (
                <ChecksView
                  checks={checkSummary.checks}
                  deployments={checkSummary.deployments}
                />
              ) : diffView === "commits" ? (
                <CommitsView commits={pr.commits || []} />
              ) : diffView === "conversation" ? (
                <ConversationView
                  author={pr.author}
                  descriptionHtml={bodyHtml}
                  comments={comments}
                />
              ) : !diff?.patch ? (
                <div className="py-12 text-center text-sm text-faint">
                  {diffError ? (
                    <>
                      <span className="text-red">{diffError}</span>
                      <button
                        className="ml-2 border-0 bg-transparent text-accent"
                        onClick={() => {
                          setDiffLoading(true);
                          setDiffError(null);
                          void load(true);
                        }}
                      >
                        Retry
                      </button>
                    </>
                  ) : diffLoading
                    ? "Loading pull request changes…"
                    : diffOutOfDate
                      ? "The pull request changed while loading. It will refresh automatically."
                      : "No text diff is available for this pull request."}
                </div>
              ) : diffView === "guide" ? (
                guideLoading ? (
                  <>
                    <div className="mb-4 rounded-sm border border-line bg-panel px-3 py-2 text-xs text-faint">
                      Writing the review guide… You can review the file diff while it groups the change by intent.
                    </div>
                    <CommentableDiff
                      patch={diff.patch}
                      diffStyle={diffStyle}
                      defaultExpandedFiles={Infinity}
                      viewedFiles={prViewed?.key === viewedKey ? prViewed.viewed : undefined}
                      onToggleViewed={handleToggleViewed}
                      submitLabel="Add comment"
                      placeholder={`Comment on #${diff.number} — added to your pending review…`}
                      pendingComments={pending}
                      onRemovePending={handleRemovePending}
                      onSubmit={handleAddPending}
                      imageSrcs={prImageSrcs}
                    />
                  </>
                ) : guideFailed ? (
                  <div className="py-12 text-center text-sm text-faint">
                    Couldn't generate a guide for this PR.
                    <button
                      className="ml-2 border-0 bg-transparent text-accent"
                      onClick={() => void loadGuide()}
                    >
                      Retry
                    </button>
                  </div>
                ) : guide ? (
                  <>
                    <div className="mb-7 grid grid-cols-[54px_minmax(0,1fr)] gap-4 px-1">
                      <div className="text-meta font-medium leading-relaxed text-faint">
                        Review guide
                      </div>
                      <div>
                        <h2 className="m-0 text-item-title font-semibold tracking-[-0.01em] text-fg">
                          {guide.sections.length} focused review step{guide.sections.length === 1 ? "" : "s"}
                        </h2>
                        <p className="mt-1 max-w-[680px] text-xs leading-relaxed text-dim">
                          Review the change by intent rather than alphabetically. Comments stay pending until you finish the review.
                        </p>
                      </div>
                    </div>
                    {guideSections.map((section, index, all) => (
                      <section
                        id={`review-guide-${index}`}
                        className="mb-8 scroll-mt-[118px]"
                        key={`${section.title}-${index}`}
                      >
                        <div className="mb-3 grid grid-cols-[54px_minmax(0,1fr)] gap-4 px-1">
                          <div className="text-meta text-faint">
                            {String(index + 1).padStart(2, "0")} / {String(all.length).padStart(2, "0")}
                          </div>
                          <div>
                            <div className="text-body font-semibold text-fg">{section.title}</div>
                            <div className="mt-1 text-meta leading-relaxed text-dim">
                              {section.explanation}
                            </div>
                          </div>
                        </div>
                        {section.patch && (
                          <CommentableDiff
                            patch={section.patch}
                            diffStyle={diffStyle}
                            defaultExpandedFiles={Infinity}
                            viewedFiles={prViewed?.key === viewedKey ? prViewed.viewed : undefined}
                      onToggleViewed={handleToggleViewed}
                            submitLabel="Add comment"
                            placeholder={`Comment on #${diff.number} — added to your pending review…`}
                            pendingComments={pending}
                            onRemovePending={handleRemovePending}
                            onSubmit={handleAddPending}
                            imageSrcs={prImageSrcs}
                          />
                        )}
                      </section>
                    ))}
                  </>
                ) : null
              ) : (
                <CommentableDiff
                  patch={diff.patch}
                  diffStyle={diffStyle}
                  defaultExpandedFiles={Infinity}
                  viewedFiles={prViewed?.key === viewedKey ? prViewed.viewed : undefined}
                      onToggleViewed={handleToggleViewed}
                  submitLabel="Add comment"
                  placeholder={`Comment on #${diff.number} — added to your pending review…`}
                  pendingComments={pending}
                  onRemovePending={handleRemovePending}
                  onSubmit={handleAddPending}
                  imageSrcs={prImageSrcs}
                />
              )}
          </div>
        </main>

        {sessionsOpen && (
          <>
            <button
              className="absolute inset-0 z-20 cursor-default border-0 bg-black/25"
              aria-label="Close sessions"
              onClick={() => setSessionsOpen(false)}
            />
            <div className="absolute right-5 top-[92px] z-30 w-[460px] max-w-[calc(100%-40px)] rounded-md border border-line-strong bg-panel p-4 shadow-[0_24px_70px_rgba(0,0,0,0.45)]">
              <div className="mb-2 flex items-center">
                <span className="text-sm font-semibold text-fg">
                  Sessions on this PR
                </span>
                <button
                  className="ml-auto border-0 bg-transparent text-item-title text-faint hover:text-fg"
                  onClick={() => setSessionsOpen(false)}
                  aria-label="Close"
                >
                  ×
                </button>
              </div>
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
          </>
        )}

        <div className="pointer-events-none absolute bottom-4 left-4 right-4 z-10 flex min-h-[54px] items-center rounded-md border border-line-strong bg-panel/95 px-3 py-2 shadow-[0_12px_35px_rgba(0,0,0,0.3)] backdrop-blur">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium text-fg">
              {reviewDone === "merged"
                ? "Approved and merged"
                : reviewDone
                  ? "Review submitted"
                  : pending.length > 0
                    ? `${pending.length} pending comment${pending.length === 1 ? "" : "s"}`
                    : "No pending comments"}
            </div>
            <div
              className={`mt-0.5 truncate text-meta ${closeError ? "text-red" : "text-faint"}`}
              title={closeError || undefined}
            >
              {closeError || "Comments are sent together when you finish the review"}
            </div>
          </div>
          <div className="pointer-events-auto ml-3 flex shrink-0 gap-2">
            {onOpenSession && (
              <Button className="text-xs" onClick={onOpenSession}>
                Open workspace
              </Button>
            )}
            {/* Close lives here rather than at the foot of the Conversation tab:
                the bar is the one chrome visible from every sub-tab, and burying
                the only close affordance under a long comment list meant people
                went to GitHub for it. Two-click confirm, same as merge. */}
            {pr.state === "OPEN" && (
              <Button
                /* Outline while it's still a proposal, solid once the next
                   click commits — same pair the confirm modals use. */
                variant={confirmClose ? "destructive" : "danger"}
                className="text-xs"
                onClick={handleClose}
                disabled={closing}
                title="Close this pull request without merging — the branch and its commits stay available"
              >
                {closing ? "Closing…" : confirmClose ? "Confirm close" : "Close"}
              </Button>
            )}
            {pr.state === "OPEN" && !pr.isDraft && (
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

        {reviewOpen && (
          <>
            <button
              className="absolute inset-0 z-20 cursor-default border-0 bg-black/25"
              aria-label="Close review form"
              onClick={() => setReviewOpen(false)}
            />
            <div className="absolute bottom-5 right-5 z-30 w-[430px] max-w-[calc(100%-40px)] rounded-md border border-line-strong bg-panel p-4 shadow-[0_24px_70px_rgba(0,0,0,0.45)]">
              <div className="mb-3 flex items-center">
                <span className="text-sm font-semibold text-fg">Finish review for #{pr.number}</span>
                <button
                  className="ml-auto border-0 bg-transparent text-item-title text-faint hover:text-fg"
                  onClick={() => setReviewOpen(false)}
                  aria-label="Close"
                >
                  ×
                </button>
              </div>
              <textarea
                className="h-20 w-full resize-none rounded-sm border border-line bg-surface p-2.5 text-xs text-fg outline-none focus:border-line-strong"
                placeholder="Review summary (optional for approval)…"
                value={summary}
                onChange={(event) => setSummary(event.target.value)}
              />
              <div className="my-2.5 grid grid-cols-3 gap-1.5">
                {(
                  [
                    ["COMMENT", "Comment"],
                    ["APPROVE", "Approve"],
                    ["REQUEST_CHANGES", "Request changes"],
                  ] as Array<[ReviewEvent, string]>
                ).map(([event, label]) => (
                  <Button
                    key={event}
                    size="sm"
                    className={`rounded-sm px-2 py-2 text-meta shadow-none ${reviewEvent === event ? "border-green/50 bg-green-soft text-green hover:border-green/50 hover:text-green" : "bg-surface"}`}
                    onClick={() => setReviewEvent(event)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
              {reviewEvent === "APPROVE" && canMergeAfterReview && (
                <label className="mb-3 flex cursor-pointer items-center gap-2 px-0.5 text-meta text-dim">
                  <input
                    type="checkbox"
                    checked={mergeAfterReview}
                    onChange={(event) => setMergeAfterReview(event.target.checked)}
                  />
                  Squash and merge immediately after approval
                </label>
              )}
              {reviewError && <div className="mb-2 text-xs text-red">{reviewError}</div>}
              {mergeError && <div className="mb-2 text-xs text-red">{mergeError}</div>}
              <div className="flex justify-end gap-2">
                <Button
                  size="sm"
                  onClick={() => setReviewOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleSubmitReview}
                  disabled={submitting}
                >
                  {submitting ? "Submitting…" : reviewSubmitLabel}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div
      className={`flex min-h-0 flex-1 flex-col ${split ? "lg:grid lg:grid-cols-[minmax(0,760px)_minmax(0,1fr)] lg:items-start lg:gap-6" : ""}`}
      ref={rootRef}
    >
      {switcher}
      <div className="flex min-h-0 flex-1 flex-col lg:contents">
      <SelectionToSession sessionId={sessionId} label={`${provider.changeAbbr} #${pr.number}`} send={send}>
        <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4 px-4 py-4 sm:px-5 lg:mx-0 lg:max-w-none lg:px-0 lg:py-0">
          {/* Header — title + meta line, Linear-style */}
          <div className="flex flex-col gap-2 rounded-panel border border-line bg-panel px-4 py-4 sm:px-5">
            <a
              className="text-section-title font-semibold leading-tight text-fg no-underline hover:text-accent"
              href={pr.url}
              target="_blank"
              rel="noopener"
            >
              {pr.title}
            </a>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-faint">
              {pr.author && <span className="font-medium text-dim">{pr.author}</span>}
              <span>#{pr.number}</span>
              <span
                className="inline-flex items-center gap-1 text-meta text-dim"
                title={`${pr.baseRefName} ← ${pr.headRefName}`}
              >
                <span className="rounded-sm border border-line bg-surface px-1.5 py-0.5">{pr.baseRefName}</span>
                <span className="text-faint">←</span>
                <span className="rounded-sm border border-line bg-surface px-1.5 py-0.5">{pr.headRefName}</span>
              </span>
              <span className="inline-flex items-center gap-1.5 text-meta">
                <span className="text-green">+{pr.additions}</span>
                <span className="text-red">−{pr.deletions}</span>
              </span>
            </div>
          </div>

          {linkable && !showBar && (
            <div>
              <LinkPrControl sessionId={sessionId} variant="action" onLinked={handleLinked} />
            </div>
          )}

          {walkthrough && <WalkthroughCard walkthrough={walkthrough} />}

          {!!bodyHtml && (
            <div className="pr-body pr-body-top">
              <div
                ref={bodyRef}
                className={`pr-body-md markdown ${bodyOpen ? "" : "pr-body-clamped"}`}
                dangerouslySetInnerHTML={{ __html: bodyHtml }}
              />
              {(bodyOverflows || bodyOpen) && (
                <button className="pr-body-toggle" onClick={() => setBodyOpen((o) => !o)}>
                  {bodyOpen ? "Show less" : "Show more"}
                </button>
              )}
            </div>
          )}

          {/* Stack map — where this PR sits in its chain of layers. Above Git
              status because it reframes everything below it: the diff, the
              base branch, and whether a merge is even in order yet. */}
          <StackCard pr={pr} sessionId={sessionId} repo={active?.repo} onOpenPr={onOpenPr} onLinked={load} />

          <PrCard title="Git status">
            <GitStatusRows
              git={git}
              pr={pr}
              sessionId={sessionId}
              repo={active?.repo}
              send={send}
              onRefresh={load}
              onMerge={handleMerge}
              merging={merging}
              confirmMerge={confirmMerge}
            />
            {mergeError && <div className="pr-git-note pr-git-note-error">{mergeError}</div>}
          </PrCard>

          {/* Sessions card — every session linked to this PR + start a new one. */}
          {sessions && (
            <PrCard title="Sessions">
              <PrSessionsList
                sessions={relatedSessions}
                repo={active?.repo || ""}
                branch={active?.branch}
                pr={pr}
                currentSessionId={sessionId || undefined}
                onOpenSession={onOpenSessionById}
                send={send}
                addHandler={addHandler}
                compose
              />
            </PrCard>
          )}

          {/* Reviewers card */}
          {reviewers.length > 0 && (
            <PrCard title="Reviewers">
              {reviewers.map((r) => (
                <ReviewerRow key={r.login} reviewer={r} provider={provider} />
              ))}
            </PrCard>
          )}

          {/* Checks card — one rollup row like Linear; the full list is opt-in. */}
          {pr.checks.length > 0 && (
            <PrCard title="Checks">
              <button
                className="prc-summary-row"
                onClick={() => setChecksOpen((o) => !o)}
                aria-expanded={checksOpen}
              >
                <span
                  className={`prc-summary-mark ${
                    checkSummary.failed > 0
                      ? "prc-tone-red"
                      : checkSummary.pending > 0
                        ? "prc-tone-yellow prc-mark-pending"
                        : "prc-tone-green"
                  }`}
                >
                  {checkSummary.failed > 0 ? (
                    <IconX size={15} />
                  ) : checkSummary.pending > 0 ? (
                    "●"
                  ) : (
                    <IconCheck size={15} />
                  )}
                </span>
                <span className="prc-summary-label">
                  {checkSummary.failed > 0
                    ? "Some checks failed"
                    : checkSummary.pending > 0
                      ? "Checks running"
                      : "All passed"}
                </span>
                <span className="prc-checks-counts">
                  {checkSummary.passed > 0 && (
                    <span className="check-success-text">✓ {checkSummary.passed}</span>
                  )}
                  {checkSummary.failed > 0 && (
                    <span className="check-failure-text">✕ {checkSummary.failed}</span>
                  )}
                  {checkSummary.pending > 0 && (
                    <span className="check-pending-text">● {checkSummary.pending}</span>
                  )}
                </span>
                <span className="prc-chevron">{checksOpen ? "▾" : "▸"}</span>
              </button>
              {checksOpen && (
                <>
                  {checkSummary.deployments.length > 0 && (
                    <div className="pr-checks-group">Deployments</div>
                  )}
                  {checkSummary.deployments.map((check, i) => (
                    <CheckRow key={`d${i}`} check={check} />
                  ))}
                  {checkSummary.deployments.length > 0 && checkSummary.checks.length > 0 && (
                    <div className="pr-checks-group">Checks</div>
                  )}
                  {checkSummary.checks.map((check, i) => (
                    <CheckRow key={`c${i}`} check={check} />
                  ))}
                </>
              )}
            </PrCard>
          )}

          {/* Files changed card — rows visible by default, long lists capped. */}
          {files.length > 0 && (
            <PrCard
              title={`${files.length} file${files.length === 1 ? "" : "s"} changed`}
              headExtra={
                <span className="inline-flex items-center gap-1.5 text-meta">
                  <span className="text-green">+{pr.additions}</span>
                  <span className="text-red">−{pr.deletions}</span>
                </span>
              }
            >
              {(allFilesOpen ? files : files.slice(0, 8)).map((f) => (
                <FileRow
                  key={f.path}
                  file={f}
                  onClick={diff?.patch ? () => scrollToFile(f.path) : undefined}
                />
              ))}
              {files.length > 8 && (
                <button
                  className="mt-1 self-start text-xs font-medium text-accent hover:text-fg"
                  onClick={() => setAllFilesOpen((o) => !o)}
                >
                  {allFilesOpen ? "Show fewer" : `Show all ${files.length} files`}
                </button>
              )}
            </PrCard>
          )}

          {comments.length > 0 && (
            <PrCard
              title="Comments"
              headExtra={
                onAddToInput ? (
                  <button
                    className="pr-comments-add-all"
                    onClick={() => onAddToInput(formatPrCommentsPrompt(comments, pr))}
                  >
                    Add all to chat
                  </button>
                ) : undefined
              }
            >
              {comments.map((comment, i) => (
                <div className="pr-comment-row" key={`${comment.url || comment.createdAt || i}`}>
                  <span className="pr-comment-select" aria-hidden />
                  <div className="pr-comment-meta">
                    <span className="pr-comment-author">{comment.author || "comment"}</span>
                  </div>
                  <div className="pr-comment-body">{stripHtmlComments(comment.body)}</div>
                  {comment.url && (
                    <a className="pr-comment-link" href={comment.url} target="_blank" rel="noopener">
                      ↗
                    </a>
                  )}
                  {onAddToInput && (
                    <button
                      className="pr-comment-add"
                      onClick={() => onAddToInput(formatPrCommentPrompt(comment, pr))}
                    >
                      Add to chat
                    </button>
                  )}
                </div>
              ))}
            </PrCard>
          )}

        </div>
      </SelectionToSession>

      {(diffLoading || diffOutOfDate || diffError) && !diff?.patch && (
        <div className="flex min-h-0 flex-1 flex-col border-t border-line lg:border-l lg:border-t-0">
          <div className={`panel-placeholder ${diffError ? "panel-error" : ""}`}>
            {diffError ? (
              <>
                <div>{diffError}</div>
                <Button
                  size="sm"
                  className="mt-3"
                  onClick={() => {
                    setDiffLoading(true);
                    setDiffError(null);
                    void load(true);
                  }}
                >
                  Retry
                </Button>
              </>
            ) : diffOutOfDate
              ? "The pull request changed while loading. It will refresh automatically."
              : "Loading pull request changes…"}
          </div>
        </div>
      )}
      {diff?.patch && (
        <div className="flex min-h-0 flex-1 flex-col border-t border-line lg:border-l lg:border-t-0">
          <div className="flex min-h-0 flex-1 flex-col bg-panel">
            <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b border-line bg-panel/95 px-4 py-3 backdrop-blur sm:px-5">
              <div className="inline-flex rounded-md border border-line bg-surface p-1" role="tablist">
                {(
                  [
                    ["diff", "Diff"],
                    ["guide", "Guide"],
                  ] as Array<["diff" | "guide", string]>
                ).map(([key, label]) => (
                  <Button
                    key={key}
                    variant="ghost"
                    size="sm"
                    role="tab"
                    aria-selected={diffView === key}
                    className={`rounded-sm border-0 px-2.5 py-1 text-xs font-medium ${diffView === key ? "bg-panel text-fg shadow-sm" : "text-faint hover:bg-transparent"}`}
                    onClick={() => setDiffView(key)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
              <div className="text-right text-meta text-faint">
                Review — comments stay pending until you submit
                {reviewDone &&
                  (reviewDone === "submitted" ? (
                    <span className="ml-2 text-green">review submitted ✓</span>
                  ) : (
                    <a
                      className="ml-2 text-accent no-underline hover:text-fg"
                      href={reviewDone}
                      target="_blank"
                      rel="noopener"
                    >
                      review submitted ↗
                    </a>
                  ))}
              </div>
            </div>
            {diffView === "guide" ? (
              guideLoading ? (
                <div className="px-4 py-6 text-sm text-faint sm:px-5">Writing the review guide…</div>
              ) : guideFailed ? (
                <div className="flex items-center gap-3 px-4 py-6 text-sm text-faint sm:px-5">
                  Couldn't generate a guide for this PR.
                  <button className="text-xs font-medium text-accent hover:text-fg" onClick={() => void loadGuide()}>
                    Retry
                  </button>
                </div>
              ) : guide ? (
                sectionsWithPatches(guide, diff.patch).map((section, i, all) => (
                  <div className="pr-guide-section" key={`${section.title}-${i}`}>
                    <div className="pr-guide-count">
                      {String(i + 1).padStart(2, "0")} / {String(all.length).padStart(2, "0")}
                    </div>
                    <div className="pr-guide-title">{section.title}</div>
                    <div className="pr-guide-expl">{section.explanation}</div>
                    {section.patch && (
                      <CommentableDiff
                        patch={section.patch}
                        defaultExpandedFiles={Infinity}
                        viewedFiles={prViewed?.key === viewedKey ? prViewed.viewed : undefined}
                      onToggleViewed={handleToggleViewed}
                        submitLabel="Add comment"
                        placeholder={`Comment on #${diff.number} — added to your pending review…`}
                        pendingComments={pending}
                        onRemovePending={handleRemovePending}
                        onSubmit={handleAddPending}
                        imageSrcs={prImageSrcs}
                      />
                    )}
                  </div>
                ))
              ) : null
            ) : (
              <CommentableDiff
                patch={diff.patch}
                defaultExpandedFiles={Infinity}
                viewedFiles={prViewed?.key === viewedKey ? prViewed.viewed : undefined}
                      onToggleViewed={handleToggleViewed}
                groups={diffGroups?.oid === diff.headRefOid ? diffGroups.groups || undefined : undefined}
                groupsLoading={diffGroupsLoading}
                submitLabel="Add comment"
                placeholder={`Comment on #${diff.number} — added to your pending review…`}
                pendingComments={pending}
                onRemovePending={handleRemovePending}
                onSubmit={handleAddPending}
                imageSrcs={prImageSrcs}
              />
            )}
          </div>

          {pending.length > 0 && (
			<div className="sticky bottom-0 z-20 border-t border-line bg-surface/80 px-4 py-3 backdrop-blur sm:px-5">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium text-fg">
                  {pending.length} pending comment{pending.length === 1 ? "" : "s"}
                </span>
                <Button
                  size="sm"
                  className="text-meta"
                  onClick={() => setReviewOpen((o) => !o)}
                >
                  {reviewOpen ? "Hide" : "Finish review"}
                </Button>
                {onAddToInput && (
                  <Button
                    size="sm"
                    className="text-meta"
                    onClick={() => onAddToInput(formatPendingCommentsPrompt(pending, pr))}
                  >
                    Add to chat
                  </Button>
                )}
              </div>

              {reviewOpen && (
                <div className="mt-3 flex flex-col gap-3">
                  <textarea
                    className="min-h-[84px] w-full resize-y rounded-sm border border-line bg-panel px-3 py-2 text-xs text-fg outline-none focus:border-line-strong"
                    rows={3}
                    placeholder="Overall review summary (optional)…"
                    value={summary}
                    onChange={(e) => setSummary(e.target.value)}
                  />
                  <div className="flex flex-wrap gap-2">
                    {(
                      [
                        ["COMMENT", "Comment"],
                        ["APPROVE", "Approve"],
                        ["REQUEST_CHANGES", "Request changes"],
                      ] as Array<[ReviewEvent, string]>
                    ).map(([key, label]) => (
                      <Button
                        key={key}
                        size="sm"
                        className={`rounded-sm px-2.5 py-2 text-meta shadow-none ${reviewEvent === key ? "border-green/45 bg-green-soft text-green hover:border-green/45 hover:text-green" : "bg-panel"}`}
                        onClick={() => setReviewEvent(key)}
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                  {reviewError && <div className="diff-comment-error">{reviewError}</div>}
                  <Button
                    variant="primary"
                    size="sm"
                    className="self-start"
                    onClick={handleSubmitReview}
                    disabled={submitting}
                  >
                    {submitting ? "Submitting…" : `Submit review (${pending.length})`}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      </div>
    </div>
  );
}

function PrDescriptionCard({
  author,
  descriptionHtml,
}: {
  author: string;
  descriptionHtml: string;
}) {
  if (!descriptionHtml)
    return (
      <div className="rounded-md border border-dashed border-line px-4 py-10 text-center text-xs text-faint">
        This pull request has no description.
      </div>
    );
  return (
    <article className="rounded-md border border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span className="flex size-7 items-center justify-center rounded-full bg-active text-[11px] font-semibold text-fg">
          {author.slice(0, 1).toUpperCase()}
        </span>
        <div>
          <div className="text-xs font-semibold text-fg">{author}</div>
          <div className="text-meta text-faint">Opened this pull request</div>
        </div>
      </div>
      <div
        className="markdown px-4 py-4 text-body leading-relaxed text-dim"
        dangerouslySetInnerHTML={{ __html: descriptionHtml }}
      />
    </article>
  );
}

function ChecksView({
  checks,
  deployments,
}: {
  checks: PrCheck[];
  deployments: PrCheck[];
}) {
  const total = checks.length + deployments.length;
  return (
    <div className="mx-auto max-w-[760px]">
      <div className="mb-6">
        <h2 className="m-0 text-section-title font-semibold tracking-[-0.01em] text-fg">
          Checks
        </h2>
        <p className="mt-1 text-xs text-faint">
          {total} result{total === 1 ? "" : "s"}
        </p>
      </div>
      {total === 0 ? (
        <div className="rounded-md border border-dashed border-line px-4 py-10 text-center text-xs text-faint">
          No checks reported.
        </div>
      ) : (
        <div className="grid gap-4">
          {checks.length > 0 && (
            <section className="rounded-md border border-line bg-panel p-3">
              <h3 className="m-0 px-2 pb-2 text-xs font-semibold text-fg">CI checks</h3>
              {checks.map((check, index) => (
                <CheckRow key={`${check.name}-${index}`} check={check} />
              ))}
            </section>
          )}
          {deployments.length > 0 && (
            <section className="rounded-md border border-line bg-panel p-3">
              <h3 className="m-0 px-2 pb-2 text-xs font-semibold text-fg">Deployments</h3>
              {deployments.map((check, index) => (
                <CheckRow key={`${check.name}-${index}`} check={check} />
              ))}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function CommitsView({ commits }: { commits: PrCommit[] }) {
  return (
    <div className="mx-auto max-w-[760px]">
      <div className="mb-6">
        <h2 className="m-0 text-section-title font-semibold tracking-[-0.01em] text-fg">
          Commits
        </h2>
        <p className="mt-1 text-xs text-faint">
          {commits.length} commit{commits.length === 1 ? "" : "s"}
        </p>
      </div>
      {commits.length === 0 ? (
        <div className="rounded-md border border-dashed border-line px-4 py-10 text-center text-xs text-faint">
          No commits reported.
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-line bg-panel">
          {commits.map((commit) => (
            <article
              className="flex items-start gap-3 border-b border-line px-4 py-3 last:border-b-0"
              key={commit.oid}
            >
              <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-dim">
                <CommitIcon />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-body font-medium text-fg">{commit.messageHeadline}</div>
                {commit.messageBody && (
                  <div className="mt-1 line-clamp-2 whitespace-pre-wrap text-meta leading-relaxed text-dim">
                    {commit.messageBody}
                  </div>
                )}
                <div className="mt-1.5 text-meta text-faint">
                  {commit.author}
                  {commit.authoredDate ? ` committed ${new Date(commit.authoredDate).toLocaleString()}` : ""}
                </div>
              </div>
              <code className="shrink-0 rounded-sm border border-line bg-surface px-2 py-1 text-meta text-dim">
                {commit.oid.slice(0, 7)}
              </code>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function ConversationView({
  author,
  descriptionHtml,
  comments,
}: {
  author: string;
  descriptionHtml: string;
  comments: PrComment[];
}) {
  return (
    <div className="mx-auto max-w-[760px]">
      <div className="mb-6">
        <h2 className="m-0 text-section-title font-semibold tracking-[-0.01em] text-fg">
          Conversation
        </h2>
        <p className="mt-1 text-xs text-faint">
          {comments.length} comment{comments.length === 1 ? "" : "s"}
        </p>
      </div>

      <div className="mb-4">
        <PrDescriptionCard author={author} descriptionHtml={descriptionHtml} />
      </div>

      {comments.length === 0 ? (
        <div className="rounded-md border border-dashed border-line px-4 py-10 text-center text-xs text-faint">
          No comments yet.
        </div>
      ) : (
        <div className="grid gap-4">
          {comments.map((comment, index) => {
            const body = stripHtmlComments(comment.body);
            const timestamp = comment.createdAt
              ? new Date(comment.createdAt).toLocaleString()
              : null;
            return (
              <article
                className="rounded-md border border-line bg-panel"
                key={`${comment.url || comment.createdAt || index}`}
              >
                <div className="flex items-center gap-2 border-b border-line px-4 py-3">
                  <span className="flex size-7 items-center justify-center rounded-full bg-active text-[11px] font-semibold text-fg">
                    {(comment.author || "?").slice(0, 1).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-semibold text-fg">
                      {comment.author || "Unknown"}
                    </div>
                    {timestamp && (
                      <div className="text-meta text-faint">{timestamp}</div>
                    )}
                  </div>
                  {comment.url && (
                    <a
                      className="text-meta text-faint no-underline hover:text-fg"
                      href={comment.url}
                      target="_blank"
                      rel="noopener"
                    >
                      Open on GitHub
                    </a>
                  )}
                </div>
                <div
                  className="markdown px-4 py-4 text-body leading-relaxed text-dim"
                  dangerouslySetInnerHTML={{ __html: renderPrCommentMarkdown(body) }}
                />
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CommitIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M11.5 7.25a3.5 3.5 0 0 0-6.92 0H1.75a.75.75 0 0 0 0 1.5h2.83a3.5 3.5 0 0 0 6.92 0h2.75a.75.75 0 0 0 0-1.5H11.5ZM8 10a2 2 0 1 1 0-4 2 2 0 0 1 0 4Z" />
    </svg>
  );
}

/**
 * The "Link PR" affordance: a "+" chip in the tab bar (or a quiet button in
 * the actions row when there's no bar yet) that expands into a paste-a-URL
 * input. Linking accepts any PR in a registered repo.
 */
function LinkPrControl({
  sessionId,
  variant,
  onLinked,
}: {
  sessionId: string;
  variant: "tab" | "action";
  onLinked: (all: LinkedPrEntry[], linked: LinkedPrEntry) => void;
}) {
  const [open, setOpen] = useState(false);
  const [val, setVal] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const url = val.trim();
    if (!url || busy) return;
    setBusy(true);
    try {
      const res = await linkPrApi(sessionId, url);
      onLinked(res.all, res.linked);
      toast(
        `Linked ${res.linked.repo}${res.linked.number ? ` #${res.linked.number}` : ""}`,
      );
      setVal("");
      setOpen(false);
    } catch (e: any) {
      toast(e.message || "Couldn't link that PR");
    } finally {
      setBusy(false);
    }
  }

  if (!open)
    return (
      <Button
        size="sm"
        className={
          variant === "tab"
            ? "rounded-sm border-dashed bg-transparent px-2.5 py-1 text-xs text-faint shadow-none"
            : "rounded-sm bg-panel px-3 py-2 text-xs shadow-none hover:bg-hover"
        }
        onClick={() => setOpen(true)}
        title="Link another PR to this session"
      >
        {variant === "tab" ? "+" : "Link PR…"}
      </Button>
    );

  return (
    <form
      className="flex w-full max-w-[420px] items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <input
        autoFocus
        className="min-w-0 flex-1 rounded-sm border border-line bg-panel px-3 py-2 text-xs text-fg outline-none placeholder:text-faint focus:border-line-strong"
        placeholder="Paste a GitHub PR URL…"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
      />
      <Button
        type="submit"
        variant="primary"
        size="sm"
        disabled={busy || !val.trim()}
      >
        {busy ? "Linking…" : "Link"}
      </Button>
    </form>
  );
}

/** A Linear-style titled card: label row + a bordered body of rows. */
function PrCard({
  title,
  headExtra,
  children,
}: {
  title: string;
  headExtra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-panel border border-line bg-panel">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
        <span className="text-meta font-semibold uppercase tracking-[0.08em] text-faint">{title}</span>
        {headExtra}
      </div>
      <div className="flex flex-col gap-2 px-4 py-3 sm:px-5">{children}</div>
    </div>
  );
}

/**
 * The stack map: every layer of a GitHub stack, top layer first (the trunk
 * sits under the last row, the way the stack is drawn on github.com). The row
 * for the PR being viewed is marked rather than linked — it's already here.
 *
 * Also carries the "link into a stack" action for a chat that was branched off
 * another chat's branch but whose PRs were never linked (pr.stackBase, set by
 * the session PR route).
 */
/**
 * The stack map body: every layer of a GitHub stack, top layer first (the
 * trunk sits under the last row, the way the stack is drawn on github.com).
 * The row for the PR being viewed is marked rather than linked — it's already
 * here. Rendered by both PrPanel layouts through the wrappers below.
 *
 * Also carries the "link into a stack" action for a chat that was branched off
 * another chat's branch but whose PRs were never linked (pr.stackBase, set by
 * the session PR route).
 */
function StackBody({
  pr,
  sessionId,
  repo,
  onOpenPr,
  onLinked,
}: {
  pr: PrDetails;
  sessionId?: string;
  /** Registered repo id, for building in-app links to the other layers. */
  repo?: string;
  onOpenPr?: (repo: string, branch: string) => void;
  onLinked: () => void;
}) {
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stack = pr.stack;

  const link = async () => {
    if (!sessionId) return;
    setLinking(true);
    setError(null);
    try {
      await linkPrStackApi(sessionId);
      toast("Linked into a stack");
      onLinked();
    } catch (e: any) {
      setError(e?.message || "Couldn't link the stack");
    } finally {
      setLinking(false);
    }
  };

  if (!stack)
    return (
      <>
        <div className="text-xs leading-relaxed text-dim">
          This branch was cut from{" "}
          <span className="rounded-sm border border-line bg-surface px-1.5 py-0.5 text-meta">
            {pr.stackBase}
          </span>{" "}
          but the PRs aren't a stack on GitHub yet — each is still reviewed against the whole chain.
        </div>
        <div className="flex items-center gap-3 pt-1">
          <Button
            size="sm"
            onClick={link}
            disabled={linking}
          >
            {linking ? "Linking…" : "Link into a stack"}
          </Button>
          {error && <span className="text-xs text-red">{error}</span>}
        </div>
      </>
    );

  // Top of the stack first — the trunk is the base line below the last row.
  const layers = [...stack.layers].sort((a, b) => b.position - a.position);
  return (
    <>
      {layers.map((layer) => {
        const current = layer.number === pr.number;
        const tone =
          layer.state === "MERGED"
            ? "text-purple"
            : layer.state === "CLOSED"
              ? "text-red"
              : layer.isDraft
                ? "text-faint"
                : "text-green";
        const body = (
          <>
            <span className={`shrink-0 ${tone}`}>
              <PrStateIcon state={layer.state} isDraft={layer.isDraft} />
            </span>
            <span className="min-w-0 flex-1 truncate">{layer.title}</span>
            <span className="shrink-0 text-faint">#{layer.number}</span>
          </>
        );
        if (current)
          return (
            <div
              key={layer.number}
              className="flex items-center gap-2 rounded-md bg-surface px-2 py-1.5 text-xs font-medium text-fg"
              aria-current="true"
            >
              {body}
            </div>
          );
        // Other layers open in THIS review panel, not on github.com — the PR
        // title above is already the link out. Falls back to the GitHub URL
        // only when the repo id is unknown, so a row is never a dead end.
        const inApp = repo ? prPath(repo, layer.headRefName) : null;
        return (
          <a
            key={layer.number}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium text-dim no-underline hover:bg-surface hover:text-fg"
            href={inApp || layer.url}
            {...(inApp ? {} : { target: "_blank", rel: "noopener" })}
            onClick={(e) => {
              // Modified clicks keep native new-tab behavior.
              if (!inApp || !onOpenPr || e.metaKey || e.ctrlKey || e.shiftKey) return;
              e.preventDefault();
              onOpenPr(repo!, layer.headRefName);
            }}
            title={layer.headRefName}
          >
            {body}
          </a>
        );
      })}
      <div className="border-t border-line pt-2 text-meta text-faint">
        Bottom of the stack merges into{" "}
        <span className="rounded-sm border border-line bg-surface px-1.5 py-0.5">
          {stack.baseRefName}
        </span>
      </div>
    </>
  );
}

/**
 * Whether this PR has anything stack-shaped to say: a real stack, or a chat
 * stacked locally whose PRs a human could still link. Both layouts gate on
 * this so a standalone PR never grows an empty section.
 */
function hasStackToShow(pr: PrDetails, sessionId?: string): boolean {
  return !!pr.stack || (!!pr.stackBase && !!sessionId);
}

/** Card form — the narrow right-hand column layout. */
function StackCard({
  pr,
  sessionId,
  repo,
  onOpenPr,
  onLinked,
}: {
  pr: PrDetails;
  /** Absent on the session-less /pr/<repo>/<branch> view: the map still
   *  renders there, only the link action needs a chat to act on. */
  sessionId?: string;
  repo?: string;
  onOpenPr?: (repo: string, branch: string) => void;
  onLinked: () => void;
}) {
  if (!hasStackToShow(pr, sessionId)) return null;
  return (
    <PrCard
      title="Stack"
      headExtra={
        pr.stack ? (
          <span className="text-meta text-faint">
            {pr.stack.position} of {pr.stack.size}
          </span>
        ) : undefined
      }
    >
      <StackBody pr={pr} sessionId={sessionId} repo={repo} onOpenPr={onOpenPr} onLinked={onLinked} />
    </PrCard>
  );
}

/** Section form — the wide review-canvas layout, matching Git status above it. */
function StackSection({
  pr,
  sessionId,
  repo,
  onOpenPr,
  onLinked,
}: {
  pr: PrDetails;
  sessionId?: string;
  repo?: string;
  onOpenPr?: (repo: string, branch: string) => void;
  onLinked: () => void;
}) {
  if (!hasStackToShow(pr, sessionId)) return null;
  return (
    <section className="shrink-0 px-6 pb-4 max-[720px]:px-3">
      <h2 className="m-0 mb-1 flex items-center gap-2 text-xs font-semibold text-dim">
        Stack
        {pr.stack && (
          <span className="font-normal text-faint">
            {pr.stack.position} of {pr.stack.size}
          </span>
        )}
      </h2>
      <div className="flex max-w-[680px] flex-col gap-1">
        <StackBody pr={pr} sessionId={sessionId} repo={repo} onOpenPr={onOpenPr} onLinked={onLinked} />
      </div>
    </section>
  );
}

function ReviewerRow({ reviewer, provider }: { reviewer: PrReviewer; provider: Provider }) {
  const src = reviewer.isTeam ? null : avatarUrl(reviewer.login, provider, 40);
  const meta = reviewerStateMeta(reviewer.state);
  const toneClass =
    meta.tone === "green"
      ? "text-green"
      : meta.tone === "red"
        ? "text-red"
        : meta.tone === "yellow"
          ? "text-yellow"
          : "text-faint";
  return (
    <div className="flex items-center gap-3 rounded-sm border border-transparent px-1 py-1.5 hover:border-line hover:bg-hover/50">
      {src ? (
        <img className="size-7 rounded-full object-cover" src={src} alt="" loading="lazy" />
      ) : (
        <span
          className="inline-flex size-7 items-center justify-center rounded-full border border-line bg-surface text-[11px] font-semibold text-faint"
          aria-hidden
        >
          {reviewer.login.slice(0, 1).toUpperCase()}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-sm text-fg">{reviewer.login}</span>
      <span className={`shrink-0 ${toneClass}`} title={meta.label}>
        {meta.icon}
      </span>
    </div>
  );
}

function reviewerStateMeta(state: PrReviewer["state"]): {
  label: string;
  tone: "green" | "red" | "muted" | "yellow";
  icon: React.ReactNode;
} {
  switch (state) {
    case "APPROVED":
      return { label: "Approved", tone: "green", icon: <IconCheck size={16} /> };
    case "CHANGES_REQUESTED":
      return { label: "Requested changes", tone: "red", icon: <IconX size={16} /> };
    case "COMMENTED":
      return { label: "Commented", tone: "muted", icon: <IconMessage size={16} /> };
    default:
      return { label: "Awaiting review", tone: "yellow", icon: <IconClock size={16} /> };
  }
}

function FileRow({ file, onClick }: { file: PrFile; onClick?: () => void }) {
  const slash = file.path.lastIndexOf("/");
  const dir = slash >= 0 ? file.path.slice(0, slash + 1) : "";
  const base = slash >= 0 ? file.path.slice(slash + 1) : file.path;
  return (
    <button
      type="button"
      className="flex w-full items-center gap-3 rounded-sm border border-transparent px-1 py-1.5 text-left hover:border-line hover:bg-hover/50 disabled:cursor-default disabled:hover:border-transparent disabled:hover:bg-transparent"
      onClick={onClick}
      disabled={!onClick}
      title={file.path}
    >
      <IconFile size={16} className="shrink-0 text-faint" />
      <span className="min-w-0 flex-1 truncate text-sm text-fg">
        {dir && <span className="text-faint">{dir}</span>}
        {base}
      </span>
      <span className="inline-flex shrink-0 items-center gap-1.5 text-meta">
        {file.additions > 0 && <span className="text-green">+{file.additions}</span>}
        {file.deletions > 0 && <span className="text-red">−{file.deletions}</span>}
      </span>
    </button>
  );
}

type PrCheckRank = "check-success" | "check-failure" | "check-pending" | "check-neutral";

export function checkClass(status: string, conclusion: string): PrCheckRank {
  if (status !== "COMPLETED" && status !== "") return "check-pending";
  // StatusContexts (Vercel deploys) report a state, not a status — a pending
  // deploy is "COMPLETED"/PENDING here and must not read as neutral.
  if (conclusion === "PENDING" || conclusion === "EXPECTED") return "check-pending";
  switch (conclusion) {
    case "SUCCESS":
      return "check-success";
    case "FAILURE":
    case "TIMED_OUT":
    case "ERROR":
      return "check-failure";
    default:
      return "check-neutral";
  }
}

// Vercel previews arrive as StatusContexts named "Preview – <project>" (no
// workflow); everything with a workflow is CI.
export function isDeployment(check: PrCheck): boolean {
  return (
    !check.workflowName &&
    (/^preview\b/i.test(check.name) || /vercel|deploy/i.test(check.name))
  );
}

function formatCheckDuration(check: PrCheck): string | null {
  if (!check.startedAt || !check.completedAt) return null;
  const secs = Math.round(
    (new Date(check.completedAt).getTime() - new Date(check.startedAt).getTime()) / 1000,
  );
  if (secs <= 0) return null;
  if (secs < 60) return `${secs}s`;
  return `${Math.round(secs / 60)}m`;
}

function formatPendingCommentsPrompt(comments: PendingComment[], pr: PrDetails): string {
  const body = comments
    .map((c, i) => {
      const range =
        c.startLine && c.startLine !== c.endLine
          ? `${c.startLine}-${c.endLine}`
          : String(c.endLine);
      return `${i + 1}. ${c.path}:${range}\n${c.text}`;
    })
    .join("\n\n");
  return `Please address these pending review comments on PR #${pr.number} (${pr.title}).\n\n${body}`;
}

function trimCommentBody(body: string): string {
  return body.trim().replace(/\n{3,}/g, "\n\n");
}

/** Bot comments hide bookkeeping in HTML comments (`<!-- marker -->`) — drop them from previews. */
function stripHtmlComments(body: string): string {
  return body.replace(/<!--[\s\S]*?-->/g, "").trim();
}

export function formatPrCommentPrompt(comment: PrComment, pr: PrDetails): string {
  const author = comment.author ? ` from ${comment.author}` : "";
  const link = comment.url ? `\nURL: ${comment.url}` : "";
  return `Please address this PR comment${author} on PR #${pr.number} (${pr.title}).${link}\n\n${trimCommentBody(comment.body)}`;
}

function formatPrCommentsPrompt(comments: PrComment[], pr: PrDetails): string {
  const body = comments
    .map((c, i) => {
      const by = c.author ? ` by ${c.author}` : "";
      const link = c.url ? `\n${c.url}` : "";
      return `${i + 1}. Comment${by}${link}\n${trimCommentBody(c.body)}`;
    })
    .join("\n\n");
  return `Please review these PR comments on PR #${pr.number} (${pr.title}).\n\n${body}`;
}

export function CheckRow({ check }: { check: PrCheck }) {
  const cls = checkClass(check.status, check.conclusion);
  const mark = cls === "check-success" ? "✓" : cls === "check-failure" ? "✕" : "●";
  const duration = formatCheckDuration(check);
  return (
    <div className="pr-check pr-check-row">
      <a className="pr-check-main" href={check.url} target="_blank" rel="noopener">
        <span className={`pr-check-mark ${cls}-text ${cls === "check-pending" ? "pr-check-mark-pending" : ""}`}>
          {mark}
        </span>
        <span className="pr-check-name">{check.name}</span>
        {duration && <span className="pr-check-duration">{duration}</span>}
        {check.url && <span className="pr-check-open">↗</span>}
      </a>
    </div>
  );
}

/**
 * The local/remote work a branch still owes: conflicts to resolve, base
 * commits to pull, local commits to push, a dirty tree to commit. Shared by
 * the workspace panel's Git status rows and the review canvas's divergence
 * strip so both name the task — and ask Michael for it — identically.
 *
 * Push is a direct server-side `git push`; the judgment calls (resolve
 * conflicts, update from base, commit stray changes) prompt the session —
 * Michael does the work, not a bare button.
 */
/** Status-dot colours for a Git status row — the state, not a step marker. */
type GitDotTone = "green" | "yellow" | "red" | "blue" | "purple" | "muted";

type GitTask = {
  key: "conflicts" | "behind" | "ahead" | "dirty";
  label: string;
  action: string;
  tone: Extract<GitDotTone, "red" | "yellow" | "blue">;
  run: "push" | { label: string; prompt: string };
};

function gitTasks(
  git: GitStatusInfo | null,
  pr: PrDetails | null,
  base: string,
): GitTask[] {
  const tasks: GitTask[] = [];
  if (pr && deriveStatus(pr).key === "conflicts")
    tasks.push({
      key: "conflicts",
      label: `Conflicts with ${base}`,
      action: "Resolve",
      tone: "red",
      run: {
        label: "resolve the conflicts",
        prompt: `The PR has merge conflicts with ${base}. Rebase this branch on the latest origin/${base}, resolve the conflicts, and push.`,
      },
    });
  // Only a real feature branch can be behind its base, and a merged PR has
  // stopped caring.
  if (
    git &&
    git.branch &&
    git.branch !== base &&
    pr?.state !== "MERGED" &&
    git.behindBase > 0
  )
    tasks.push({
      key: "behind",
      label: `${git.behindBase} commit${git.behindBase === 1 ? "" : "s"} behind ${base}`,
      action: "Pull",
      tone: "yellow",
      run: {
        label: `update from ${base}`,
        prompt: `Update this branch with the latest origin/${base} (rebase preferred), resolve any conflicts, and push.`,
      },
    });
  if (git && git.ahead > 0)
    tasks.push({
      key: "ahead",
      label: `${git.ahead} commit${git.ahead === 1 ? "" : "s"} ahead of remote`,
      action: "Push",
      tone: "blue",
      run: "push",
    });
  if (git && git.uncommittedFiles > 0)
    tasks.push({
      key: "dirty",
      label: `${git.uncommittedFiles} uncommitted file${git.uncommittedFiles === 1 ? "" : "s"}`,
      action: "Commit",
      tone: "yellow",
      run: {
        label: "commit the changes",
        prompt: commitPrompt(git.uncommittedFiles, git.sharedCheckout, git.uncommittedPaths),
      },
    });
  return tasks;
}

/** Runs a {@link GitTask} and holds the transient push/prompt/error feedback. */
function useGitTaskRunner({
  sessionId,
  repo,
  send,
  onRefresh,
}: {
  sessionId: string;
  repo?: string;
  send?: (msg: any) => void;
  onRefresh: () => Promise<void> | void;
}) {
  const [pushing, setPushing] = useState(false);
  const [prompted, setPrompted] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function promptSession(label: string, content: string) {
    if (!send) return;
    send({ type: "prompt", sessionId, user: getCurrentUser(), content });
    setPrompted(label);
    setTimeout(() => setPrompted(null), 6000);
  }

  async function push() {
    if (pushing) return;
    setPushing(true);
    setError(null);
    try {
      await gitPushApi(sessionId, repo);
      await onRefresh();
    } catch (e: any) {
      setError(e.message || "Push failed");
    } finally {
      setPushing(false);
    }
  }

  function run(task: GitTask) {
    if (task.run === "push") void push();
    else promptSession(task.run.label, task.run.prompt);
  }

  /** A prompt-driven task needs a live session socket; Push never does. */
  function runnable(task: GitTask) {
    return task.run === "push" || !!send;
  }

  return { run, runnable, promptSession, pushing, prompted, error };
}

/**
 * Branch divergence for the review canvas: only the work that needs doing,
 * with each action sitting next to the sentence that explains it.
 *
 * The canvas used to carry a full "Git status" card here, which restated the
 * PR verdict and its Merge button a third time on one screen — the session
 * header's PrStatusBar carries the verdict plus the primary action whether the
 * workspace panel is open or closed, and the panel's own Git status section
 * says it again. What the canvas can usefully add is the local/remote
 * divergence, so that is all it shows, and only while something is outstanding.
 *
 * Phone is the exception: the session header drops the PR status bar at that
 * width, so the verdict and Merge would have nowhere else to live and the
 * strip takes them back.
 */
function GitDivergenceStrip({
  git,
  pr,
  sessionId,
  repo,
  send,
  onRefresh,
  onMerge,
  merging,
  confirmMerge,
}: {
  git: GitStatusInfo | null;
  pr: PrDetails | null;
  sessionId: string;
  repo?: string;
  send?: (msg: any) => void;
  onRefresh: () => Promise<void> | void;
  onMerge?: () => void;
  merging?: boolean;
  confirmMerge?: boolean;
}) {
  const runner = useGitTaskRunner({ sessionId, repo, send, onRefresh });
  const isPhone = useIsPhone();
  const base = pr?.baseRefName || git?.baseBranch || "main";
  const tasks = gitTasks(git, pr, base).filter(runner.runnable);
  const verdict =
    isPhone && pr && pr.state === "OPEN" && !pr.isDraft && onMerge
      ? deriveStatus(pr)
      : null;
  if (!verdict && tasks.length === 0 && !runner.prompted && !runner.error)
    return null;

  return (
    <section className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 px-6 pb-4 max-[720px]:px-3">
      {verdict && (
        <span className="inline-flex items-center gap-2 text-xs text-dim">
          <span className={`pr-git-dot pr-git-dot-${verdict.tone}`} aria-hidden />
          {verdict.qualifier || verdict.label}
          <Button
            size="xs"
            onClick={onMerge}
            disabled={merging}
            title="Squash and merge this pull request"
          >
            {merging ? "Merging…" : confirmMerge ? "Confirm merge" : "Merge"}
          </Button>
        </span>
      )}
      {tasks.map((task) => (
        <span key={task.key} className="inline-flex items-center gap-2 text-xs text-dim">
          <span className={`pr-git-dot pr-git-dot-${task.tone}`} aria-hidden />
          {task.label}
          <Button
            size="xs"
            onClick={() => runner.run(task)}
            disabled={task.run === "push" && runner.pushing}
          >
            {task.run === "push" && runner.pushing ? "Pushing…" : task.action}
          </Button>
        </span>
      ))}
      {runner.prompted && (
        <span className="text-xs text-faint">Asked Michael to {runner.prompted} ✓</span>
      )}
      {runner.error && <span className="text-xs text-red">{runner.error}</span>}
    </section>
  );
}

/**
 * Local/remote discrepancy rows for the Status card: each gets a line with one
 * action on the right. Push is a direct server-side `git push`; the judgment
 * calls (create the PR, resolve conflicts, update from base, commit stray
 * changes) prompt the session — Michael does the work, not a bare button.
 */
function GitStatusRows({
  git,
  pr,
  sessionId,
  repo,
  send,
  onRefresh,
  onMerge,
  merging,
  confirmMerge,
}: {
  git: GitStatusInfo | null;
  pr: PrDetails | null;
  sessionId: string;
  repo?: string;
  send?: (msg: any) => void;
  onRefresh: () => Promise<void> | void;
  onMerge?: () => void;
  merging?: boolean;
  confirmMerge?: boolean;
}) {
  const runner = useGitTaskRunner({ sessionId, repo, send, onRefresh });
  const { prompted, error } = runner;

  const base = pr?.baseRefName || git?.baseBranch || "main";
  const tasks = gitTasks(git, pr, base);
  const task = (key: GitTask["key"]) => tasks.find((t) => t.key === key);

  const rows: Array<{
    key: string;
    label: string;
    tone: GitDotTone;
    action?: React.ReactNode;
  }> = [];

  if (pr) {
    const status = deriveStatus(pr);
    const conflicts = task("conflicts");
    const resolveAction =
      conflicts && runner.runnable(conflicts) ? (
        <button className="pr-git-action" onClick={() => runner.run(conflicts)}>
          {conflicts.action}
        </button>
      ) : undefined;
    rows.push({
      key: "pr-status",
      label: status.qualifier || status.label,
      tone: status.tone,
      action:
        resolveAction ||
        (pr.state === "OPEN" && !pr.isDraft && onMerge ? (
          <button
            className="pr-git-action"
            onClick={onMerge}
            disabled={merging}
            title="Squash and merge this pull request"
          >
            {merging ? "Merging…" : confirmMerge ? "Confirm merge" : "Merge"}
          </button>
        ) : undefined),
    });
  }

  // Base-sync (rebase) status — lead with it so the panel answers "am I behind
  // main?" at a glance. Shown for any real feature branch (not the base branch
  // itself, not a merged PR): a reassuring green "up to date" when in sync, and
  // a prominent yellow "N behind" with a one-click Update (rebase) when not.
  if (git && git.branch && git.branch !== base && pr?.state !== "MERGED") {
    const behind = task("behind");
    rows.push({
      key: "base-sync",
      label: behind ? behind.label : `Up to date with ${base}`,
      tone: behind ? behind.tone : "green",
      action:
        behind && runner.runnable(behind) ? (
          <button className="pr-git-action" onClick={() => runner.run(behind)}>
            {behind.action}
          </button>
        ) : undefined,
    });
  }

  if (!pr) {
    rows.push({
      key: "no-pr",
      label: "No pull request",
      tone: "muted",
      action: send && (
        <button
          className="pr-git-action"
          onClick={() =>
            runner.promptSession(
              "create a PR",
              "Commit any remaining work, push the branch, and open a PR for it.",
            )
          }
        >
          Create PR
        </button>
      ),
    });
  }
  for (const key of ["ahead", "dirty"] as const) {
    const t = task(key);
    if (!t || !runner.runnable(t)) continue;
    rows.push({
      key,
      label: t.label,
      tone: t.tone,
      action: (
        <button
          className="pr-git-action"
          onClick={() => runner.run(t)}
          disabled={t.run === "push" && runner.pushing}
        >
          {t.run === "push" && runner.pushing ? "Pushing…" : t.action}
        </button>
      ),
    });
  }
  if (rows.length === 0) return null;

  return (
    <>
      {rows.map((row) => (
        <div
          key={row.key}
          className="pr-git-row"
        >
          <span className={`pr-git-dot pr-git-dot-${row.tone}`} aria-hidden />
          <span className="pr-git-label">{row.label}</span>
          {row.action}
        </div>
      ))}
      {prompted && <div className="pr-git-note">Asked Michael to {prompted} ✓</div>}
      {error && <div className="pr-git-note pr-git-note-error">{error}</div>}
    </>
  );
}
