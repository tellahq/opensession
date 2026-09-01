import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  cancelPrReviewApi,
  fetchCommit,
  setSessionReviewerApi,
  sessionAssetPreviewUrl,
  triggerPrActionApi,
  type CommitDetails,
  type WorkspaceCommit,
  type WorkspaceMediaItem,
} from "../lib/api";
import {
  useSessionAssetsResource,
  useSessionDiffResource,
  useSessionGitResource,
  useSessionPrDiffResource,
  useSessionPrResource,
  useWorkspaceOverviewResource,
} from "../hooks/useApiResources";
import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { assetPreviewKind, isVisualAsset } from "../lib/asset-preview";
import { useAssetViewMode } from "../lib/asset-view-mode";
import { AssetViewToggle } from "./AssetViewToggle";
import { useResolvedTheme } from "./CodeHighlight";
import { openLightbox } from "../lib/media-lightbox";
import { fullTime } from "../lib/time";
import { commitPrompt } from "../lib/commit-prompt";
import { errorMessage } from "../lib/error-message";
import { AGENT_NAME, GITHUB_BOT_LOGINS } from "../lib/brand";
import { sessionHasConnectedPr } from "../lib/session-prs";
import { getCurrentUser } from "./UserPicker";
import { PR_WEBHOOK_FALLBACK_POLL_MS } from "../lib/poll";
import { PrStatusBar } from "./PrStatusBar";
import { reviewerStateMeta } from "./pr/PrRows";
import { StagingLink } from "./StagingLink";
import { UserAvatar } from "./UserAvatar";
import {
  personNameForGithubLogin,
  personNameForKey,
  usePeople,
  useReviewTeams,
} from "../lib/people";
import { isBotAuthor } from "../lib/pr-comments";
import { Popover } from "../ui/popover";
import { Button } from "../ui/button";
import { Menu } from "../ui/menu";
import { Tooltip } from "../ui/tooltip";
import { cn } from "../ui/cn";
import type {
  PrCommit,
  PrDetails,
  PrReviewer,
  UnifiedSession,
  WSClientMessage,
} from "../lib/types";
import {
  WS_SUMMARY_ACTION,
  WS_SUMMARY_CARD,
  WS_SUMMARY_COUNT,
  WS_SUMMARY_ICON,
  WS_SUMMARY_LABEL,
  WS_SUMMARY_RAIL,
  WS_SUMMARY_ROW,
  WS_SUMMARY_FRAME,
  WS_SUMMARY_FRAME_CAPTION,
  WS_SUMMARY_FRAME_MEDIA,
  WS_SUMMARY_SECTION,
  WS_SUMMARY_STRIP,
  WS_SUMMARY_STATE,
  WS_SUMMARY_THUMB,
} from "../lib/workspace-summary-classes";
import {
  WS_SUMMARY_OPEN_EVENT,
  WS_SUMMARY_OPEN_KEY,
  workspaceSummaryCanStand,
  workspaceSummaryOpen,
  workspaceSummaryShouldDismissAfterRouting,
  workspaceSummarySideOffset,
} from "../lib/workspace-summary-open";
import {
  IconChevronDown,
  IconChevronRight,
  IconClock,
  IconFile,
  IconGitCommit,
  IconListCircles,
  IconPeople,
  IconPlay,
  IconPlayRectangle,
  IconRobot,
  IconStack,
} from "./icons";

/**
 * The session header's compact stand-in for the right Workspace panel: one
 * floating card carrying what that panel carries, in four bands.
 *
 * 1. The pull request and its current action, unlabelled at the top.
 * 2. Review findings and the people asked to review.
 * 3. Changes, including the diff size and anything still uncommitted.
 * 4. Assets, the session's own files.
 *
 * Why it exists: the Workspace panel is a third of the pane, so the only way
 * to check "did the checks pass / is there a conflict / is anything still
 * running" was to give up that much of the transcript. The header already
 * carries a one-line PR strip, but a single headline cannot say more than one
 * thing at a time. This is the rest of that headline, on demand, over the
 * pane's own gutter, so both side columns can stay shut and the reading column
 * stays wide.
 *
 * What it deliberately does NOT hold: the repo and the branch. They were the
 * two rows that never changed while you worked, and a summary is for what
 * moves. Both are on the session header a few pixels above, and the branch is
 * in the panel's Info section.
 *
 * The PR block is `PrStatusBar` in its `summary` variant rather than rows of
 * this file's own. Everything behind a merge button (headline derivation, the
 * stack merge plan, confirm-then-merge, the ask-the-session paths) belongs to
 * that component, and re-deriving it here would be a second thing that can be
 * wrong about whether a merge is in flight. It replaced hand-written checks,
 * conflict, ahead and behind rows that could report a state without being able
 * to do anything about it.
 *
 * On a pane too narrow to hold both, the card stands down rather than cover
 * the transcript it is summarising. The trigger stays where it is and still
 * opens it, as an overlay that leaves on the next click outside. What a narrow
 * pane cannot do is keep it up on its own. The pinned preference is untouched
 * by any of that, so widening the window brings the card back.
 *
 * Data is fetched only while the card is open, which is what keeps the polls
 * off every session that merely has the header. What is left to fetch here is
 * small: the PR's own line stats feed the diff row, because that number rides
 * along with the PR fetch where a worktree diff would be a second, much
 * heavier request for the same two integers. With no PR (or no branch yet) it
 * falls back to the worktree diff.
 */

interface Props {
  session: UnifiedSession;
  /**
   * What the card aligns its right edge to: the header's actions row, not the
   * trigger. Anchoring to the trigger left it hanging off the middle of the
   * cluster with the panel toggle poking out beside it; against the row it
   * lands flush with the chrome's own right edge, which is where a summary of
   * the right-hand panel belongs.
   */
  anchor?: React.RefObject<HTMLElement | null>;
  /** Open the right panel on a page. */
  onOpenPanelTab: (tab: "info" | "changes") => void;
  /** Open the Review tab (PR + its checks). */
  onOpenPr: () => void;
  /** Open another layer of the stack on its own PR page. */
  onOpenStackPr?: (repo: string, branch: string) => void;
  onOpenChecks: () => void;
  /** Preview one asset over the session without leaving the summary. */
  onOpenAsset?: (path: string) => void;
  /** Open the full Assets tab (the Assets list's deliberate destination). */
  onOpenAssets?: () => void;
  /** Open the live Auto-fix session created from a review finding. */
  onOpenSession?: (id: string, created?: UnifiedSession | null) => void;
  /** Archive through the owning viewer, so it can select the neighbouring
   *  sidebar row. Offered by the PR block once the work has landed. */
  onArchive?: () => void;
  /**
   * The teammate this session's review was handed to, if anyone. Open
   * Session's own request is different from the reviewers on the pull request,
   * but the summary only shows either kind after a PR is connected.
   *
   * The workspace's request may live on a sibling session, so the viewer
   * resolves it (see `effectiveReview`) and hands the answer down.
   */
  reviewRequest?: UnifiedSession["reviewRequest"] | null;
  /** The sibling session that owns `reviewRequest`, when it is not `session`. */
  reviewRequestSessionId?: string;
  /** Mirror a reviewer change into the app-level session list immediately. */
  onReviewChange?: (
    sessionId: string,
    request: NonNullable<UnifiedSession["reviewRequest"]> | null,
  ) => void;
  /** Workspace-wide GitHub requests, including requests held by a sibling session. */
  prReviewRequested?: string[];
  /** Live run state, so the PR block refetches the moment a turn ends. */
  running?: boolean;
  /** The worktree is not ready yet, so worktree and PR status stay quiet. */
  workspacePreparing?: boolean;
  /** Prompt the session (Commit) via WS `prompt`. Absent while disconnected. */
  send?: (msg: WSClientMessage) => void;
  /** Bumped when a webhook or an auto-push reports workspace activity. */
  refreshTick?: number;
  /** Lets the session column make room for the floating card while it is open. */
  onOpenChange?: (open: boolean) => void;
  /** The desktop tab strip sits between the header anchor and the transcript. */
  tabStripVisible?: boolean;
  /** Review starts with the card shut and opens it below its own toolbar. */
  reviewMode?: boolean;
  /** Keep a pinned card visible while its Changes side panel is open. */
  forceOpen?: boolean;
  /** Render the same quiet rows inside the phone Workspace page. */
  embedded?: boolean;
  /** Media already visible in the live transcript, before the overview catches up. */
  liveMedia?: WorkspaceMediaItem[];
  /**
   * Whether the pane is wide enough for the card to hang beside the reading
   * column instead of over it. Below that width the card no longer stands open
   * on its own: it opens from the trigger as an ordinary overlay, and the
   * pinned preference is left alone.
   */
  hasRoom?: boolean;
}

/**
 * One identity per reviewer, merged across the two ways a review lands on
 * someone. Human identities are collected under one labelled band; bots and
 * teams keep their own status rows.
 *
 * The pull request has reviewers, and Open Session has its own "please review
 * this" pointed at a teammate. They are not alternatives: the picker mirrors
 * its picks into GitHub's reviewer list, so the same person arrives from both
 * sides, once as a login and once as a name. Rendered as two lists that reads
 * as "johnnylinsf · Awaiting review" directly above "Johnny · Review asked",
 * which is one person, one fact, and two rows saying it differently.
 *
 * So: one row per person. GitHub's state wins when they have actually
 * submitted something, because "Approved" says more than "we asked"; the
 * request supplies the state otherwise, and the name, which is what a
 * teammate is called here.
 *
 * GitHub also lists a person twice when they answer a request they were
 * already on, so the latest state wins per login before any of this.
 */
const REVIEWERS_SHOWN = 4;

type OpenCommitDetails =
  | { sha: string; status: "loading" }
  | { sha: string; status: "ready"; details: CommitDetails }
  | { sha: string; status: "unavailable" };

type CommitRowTarget =
  | { kind: "workspace"; commit: WorkspaceCommit }
  | { kind: "pr"; commit: PrCommit };

type SummaryChangeFile = {
  key: string;
  path: string;
  additions: number;
  deletions: number;
  meta?: FileDiffMetadata;
};

type ReviewLine = {
  key: string;
  name: string;
  login?: string;
  state: string;
  tone: string;
  human: boolean;
  /** This person was asked to review, here or on GitHub. The reviewer picker
   *  hangs on this row; a row that merely commented is a fact, not a slot. */
  requested: boolean;
};

function reviewLines(
  pr: PrDetails | null,
  request: UnifiedSession["reviewRequest"] | null | undefined,
  prReviewRequested: string[] | undefined,
): ReviewLine[] {
  if (!pr) return [];

  const lines: ReviewLine[] = [];
  const seen = new Map<string, ReviewLine>();
  const add = (line: ReviewLine) => {
    const existing = seen.get(line.key);
    if (existing) return existing;
    seen.set(line.key, line);
    lines.push(line);
    return line;
  };

  // Whoever we asked, first: this is the row whose picker can change the
  // current request while the connected pull request is still visible.
  const requestedPeople = request?.recipients?.length
    ? request.recipients
    : [request?.to];
  for (const key of requestedPeople) {
    if (!key) continue;
    const name = personNameForKey(key);
    add({
      key: name.toLowerCase(),
      name,
      state: request?.accepted ? "Signed off" : "Review asked",
      tone: request?.accepted ? "text-green" : "text-dim",
      human: true,
      requested: true,
    });
  }
  for (const key of prReviewRequested || []) {
    if (!key) continue;
    const name = personNameForKey(key);
    add({
      key: name.toLowerCase(),
      name,
      state: "Awaiting review",
      tone: "text-dim",
      human: true,
      requested: true,
    });
  }

  // Then the PR's own, folded onto the same person where they match. Only
  // while it is open: once it lands the review is history, and the card is for
  // what is still live.
  if (pr?.state === "OPEN") {
    const byLogin = new Map<string, PrReviewer>();
    for (const reviewer of pr.reviewers || []) {
      const previous = byLogin.get(reviewer.login);
      if (!previous || previous.state === "PENDING")
        byLogin.set(reviewer.login, reviewer);
    }
    for (const reviewer of byLogin.values()) {
      const meta = reviewerStateMeta(reviewer.state);
      const personName = reviewer.isTeam
        ? null
        : personNameForGithubLogin(reviewer.login);
      const name = personName || reviewer.login;
      const line = add({
        key: name.toLowerCase(),
        name,
        login: reviewer.isTeam ? undefined : reviewer.login,
        state: meta.label,
        tone: meta.tone === "muted" ? "text-dim" : `text-${meta.tone}`,
        human: !reviewer.isTeam && !isBotAuthor(reviewer.login),
        requested: reviewer.state === "PENDING",
      });
      // Merged onto a request row: keep the request's name, take GitHub's
      // verdict once there is one to take.
      if (line.state !== meta.label && reviewer.state !== "PENDING") {
        line.state = meta.label;
        line.tone = meta.tone === "muted" ? "text-dim" : `text-${meta.tone}`;
        line.login = line.login || reviewer.login;
      }
      line.human ||= !reviewer.isTeam && !isBotAuthor(reviewer.login);
      line.requested ||= reviewer.state === "PENDING";
    }
  }
  return lines;
}

/** How many assets the card lists before it defers to the Assets tab. The card
 *  scrolls, so this is about the list staying a summary rather than about the
 *  height it would take. */
const ASSETS_SHOWN = 6;

/** How many screenshots the strip carries. It scrolls, so this is about how
 *  many pictures the card is willing to load, not about the room it has. */
const ASSET_FRAMES_SHOWN = 6;
const NO_LIVE_MEDIA: WorkspaceMediaItem[] = [];

export function WorkspaceSummary({
  session,
  anchor,
  onOpenChange,
  tabStripVisible,
  reviewMode = false,
  forceOpen = false,
  hasRoom = true,
  ...body
}: Props) {
  /** The standing preference: whether this person keeps the card up. */
  const [pinned, setPinned] = useState(workspaceSummaryOpen);
  const pinnedRef = useRef(pinned);
  useLayoutEffect(() => {
    pinnedRef.current = pinned;
  });
  /** A card opened by hand on a pane too narrow to keep one. Held apart from
   *  the preference so an overlay opened here does not become the setting
   *  every wider window inherits, and dismissing it does not un-pin the card
   *  set there. */
  const [transient, setTransient] = useState(false);
  // Room is the only thing that decides this. Review is not a special case:
  // it is wide, so it keeps the standing card like any other pane.
  const canStand = forceOpen || workspaceSummaryCanStand(hasRoom);
  // Mode decides which of the two answers at render rather than in an effect.
  // An effect would paint one frame of a card the pane should not hold.
  const open = canStand ? pinned : transient;
  const workspaceKey = session.workspaceId || session.id;
  const previousWorkspaceKey = useRef(workspaceKey);
  /** Whether the card open on screen is one this person just opened, as
   *  opposed to one that was already pinned open when the pane mounted. Only
   *  the first kind may take focus. */
  const openedByPerson = useRef(false);
  // One report of what is actually on screen, so the viewer's copy follows
  // every route in: the preference changing in another tab, the person opening
  // the card by hand, the pane narrowing under it.
  useEffect(() => {
    onOpenChange?.(open);
  }, [onOpenChange, open]);
  useEffect(() => () => onOpenChange?.(false), [onOpenChange]);
  // Back at a width that holds the card, the hand-opened overlay has done its
  // job: the preference takes over, and narrowing again starts shut rather
  // than reviving an overlay from two resizes ago.
  useEffect(() => {
    if (canStand) setTransient(false);
  }, [canStand]);
  useEffect(() => {
    const syncOpen = () => {
      const nextOpen = workspaceSummaryOpen();
      if (nextOpen === pinnedRef.current) return;
      pinnedRef.current = nextOpen;
      setPinned(nextOpen);
    };
    const syncStorage = (event: StorageEvent) => {
      if (event.key === WS_SUMMARY_OPEN_KEY) syncOpen();
    };
    window.addEventListener(WS_SUMMARY_OPEN_EVENT, syncOpen);
    window.addEventListener("storage", syncStorage);
    return () => {
      window.removeEventListener(WS_SUMMARY_OPEN_EVENT, syncOpen);
      window.removeEventListener("storage", syncStorage);
    };
  }, []);
  useEffect(() => {
    if (previousWorkspaceKey.current === workspaceKey) return;
    previousWorkspaceKey.current = workspaceKey;
    const nextOpen = workspaceSummaryOpen();
    if (nextOpen === pinnedRef.current) return;
    pinnedRef.current = nextOpen;
    setPinned(nextOpen);
  }, [workspaceKey]);
  function changeOpen(nextOpen: boolean) {
    openedByPerson.current = nextOpen;
    if (!canStand) {
      // On screen now, and nowhere else: a narrow pane opens the card without
      // writing the preference every other window reads.
      setTransient(nextOpen);
      return;
    }
    pinnedRef.current = nextOpen;
    setPinned(nextOpen);
    localStorage.setItem(WS_SUMMARY_OPEN_KEY, String(nextOpen));
    window.dispatchEvent(new Event(WS_SUMMARY_OPEN_EVENT));
  }
  function dismissAfterRouting() {
    if (workspaceSummaryShouldDismissAfterRouting(canStand)) changeOpen(false);
  }
  return (
    <Popover.Root
      open={open}
      onOpenChange={(nextOpen, details) => {
        // This is a pinned workspace view, not a transient menu. Keep it open
        // while the person works elsewhere in the pane or changes workspace.
        // Escape belongs to the surface behind the card, never to the card itself.
        // Only while the pane can hold it: overlaying a narrow one, it behaves
        // like any other popup and leaves on the first click outside.
        if (
          !nextOpen &&
          (details.reason === "escape-key" ||
            (canStand &&
              (details.reason === "outside-press" ||
                details.reason === "focus-out")))
        )
          return;
        changeOpen(nextOpen);
      }}
    >
      <Tooltip label="Workspace summary">
        <Popover.Trigger
          className={cn(
            "inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-control",
            "border-none bg-transparent p-0 text-dim hover:bg-hover hover:text-fg",
            // Open state reads as pressed rather than hovered, so the card
            // and its trigger stay visibly one object.
            "data-[popup-open]:bg-pressed data-[popup-open]:text-fg",
          )}
          aria-label="Workspace summary"
        >
          <IconListCircles size={20} />
        </Popover.Trigger>
      </Tooltip>
      <Popover.Popup
        side="bottom"
        align="end"
        anchor={anchor}
        // Keep the floating layer inside the header actions it follows. The
        // right panel changes the chat pane's width on every pointer move;
        // portaling to body leaves anchor tracking a frame behind, while this
        // ancestor moves the card and the chat edge in the same layout pass.
        portalContainer={anchor}
        positionMethod="absolute"
        // The summary stays above sticky workspace chrome, but reserves the
        // final z-index step for hover previews opened from inside the card.
        positionerClassName="z-[2147483646]"
        // Pull past the header action row's 16px inset to leave a consistent
        // 12px edge gutter. Its quiet shadow does not need more clearance.
        alignOffset={-4}
        collisionPadding={12}
        // The card hangs 12px below whatever chrome it clears, in both
        // positions: the same gutter it keeps at the window's right edge, so
        // it reads as inset into a corner. Offsets are measured from the
        // actions row the card anchors to, whose box ends 8px above the
        // header's own bottom edge and 37px above the tab strip's: 8 + 12
        // with no strip, 37 + 12 with one.
        sideOffset={workspaceSummarySideOffset(Boolean(tabStripVisible))}
        elevation="sm"
        // A menu's hairline is right for a strip of rows; on 300px of quiet
        // text it reads as a box drawn around them rather than the card's own
        // edge. Softened so the corner is what you see.
        ring="soft"
        className={WS_SUMMARY_CARD}
        // Take focus when someone opens the card, so the keyboard reaches its
        // controls. Not when it merely mounts already-open: the card is
        // pinned across sessions, and opening a session would otherwise land
        // focus on a row in here instead of the composer.
        initialFocus={() => openedByPerson.current}
      >
        {/* Mounted only while open. This keeps its data fetches off sessions
				    whose summary is closed. */}
        <WorkspaceSummaryBody
          session={session}
          {...body}
          reviewMode={reviewMode}
          close={dismissAfterRouting}
        />
      </Popover.Popup>
    </Popover.Root>
  );
}

export function WorkspaceSummaryBody({
  session,
  onOpenPanelTab,
  onOpenPr,
  onOpenStackPr,
  onOpenChecks,
  onOpenAsset,
  onOpenAssets,
  onOpenSession,
  onArchive,
  reviewRequest,
  reviewRequestSessionId,
  onReviewChange,
  prReviewRequested,
  running,
  workspacePreparing,
  send,
  refreshTick,
  close,
  embedded = false,
  reviewMode = false,
  liveMedia = NO_LIVE_MEDIA,
}: Omit<Props, "anchor" | "onOpenChange" | "tabStripVisible"> & {
  close: () => void;
}) {
  // Pictures or rows. One preference, shared with the Workspace panel's own
  // Assets section, so the same folder is not drawn two ways in one window.
  const [assetView, setAssetView] = useAssetViewMode();
  const [changesOpen, setChangesOpen] = useState(false);
  const diffTheme = useResolvedTheme();
  // `session` follows the session-list poll; the viewer's explicit value follows
  // the workspace_status socket event and wins when it is available.
  const workspaceIsPreparing =
    workspacePreparing ?? Boolean(session.workspacePreparing);
  const prResource = useSessionPrResource(
    session.id,
    session.repo || undefined,
    undefined,
    {
      enabled: !workspaceIsPreparing,
      refreshInterval: PR_WEBHOOK_FALLBACK_POLL_MS,
      revision: refreshTick,
    },
  );
  const gitResource = useSessionGitResource(
    session.id,
    session.repo || undefined,
    {
      enabled: !workspaceIsPreparing,
      refreshInterval: PR_WEBHOOK_FALLBACK_POLL_MS,
      revision: refreshTick,
    },
  );
  const assetsResource = useSessionAssetsResource(session.id, {
    revision: refreshTick,
  });
  const overviewResource = useWorkspaceOverviewResource(
    session.workspaceId || `sessions:${session.id}`,
    session.workspaceId || null,
    [
      {
        id: session.id,
        title: session.title,
        createdAt: session.createdAt || "",
        lastActivity: session.lastActivity,
      },
    ],
    { revision: `${session.lastActivity || ""}\0${refreshTick || 0}` },
  );
  // A PR already carries line totals, so only fetch the much larger worktree
  // patch when there is no PR (or its revalidation failed without stale data).
  const diffResource = useSessionDiffResource(session.id, {
    enabled:
      !workspaceIsPreparing &&
      (prResource.data === null || Boolean(prResource.error)),
    refreshInterval: PR_WEBHOOK_FALLBACK_POLL_MS,
    revision: refreshTick,
  });
  const pr = prResource.data ?? null;
  // File names come with the PR summary. Its much larger patch waits until the
  // person opens Changes, when it can power the per-file hover previews.
  const prDiffResource = useSessionPrDiffResource(
    session.id,
    session.repo || undefined,
    undefined,
    {
      enabled: changesOpen && Boolean(pr),
      revision: `${pr?.headRefOid || ""}\0${refreshTick || 0}`,
    },
  );
  const hasConnectedPr = sessionHasConnectedPr(session);
  const git = gitResource.data ?? null;
  const assets = assetsResource.data ?? [];
  const commits = overviewResource.data?.commits ?? [];
  const prCommits = pr?.commits ?? [];
  const commitCount = prCommits.length || commits.length;
  const hasCommitDetails = commitCount > 0;
  const media = (() => {
    const seen = new Set<string>();
    return [...liveMedia, ...(overviewResource.data?.media ?? [])].filter(
      (item) => {
        const key = `${item.kind}\0${item.src}\0${item.sessionId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      },
    );
  })();
  const diff =
    diffResource.data?.repos.reduce(
      (sum, repo) => ({
        additions: sum.additions + (repo.diff.totalAdditions || 0),
        deletions: sum.deletions + (repo.diff.totalDeletions || 0),
        files: sum.files + (repo.diff.files?.length || 0),
      }),
      { additions: 0, deletions: 0, files: 0 },
    ) ?? null;
  const [prompted, setPrompted] = useState(false);
  const [commitsOpen, setCommitsOpen] = useState(false);
  const [openCommit, setOpenCommit] = useState<OpenCommitDetails | null>(null);
  const [selectedReview, setSelectedReview] = useState(reviewRequest ?? null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewStarting, setReviewStarting] = useState(false);
  const [reviewCancelling, setReviewCancelling] = useState(false);
  const [fixBusy, setFixBusy] = useState(false);
  const [fixError, setFixError] = useState<string | null>(null);
  const syncReviewRequest = useEffectEvent(() => {
    setSelectedReview(reviewRequest ?? null);
    setReviewError(null);
  });
  useEffect(() => {
    syncReviewRequest();
  }, [reviewRequest?.to, reviewRequest?.at, reviewRequest?.accepted?.at]);

  const additions = pr ? pr.additions : (diff?.additions ?? 0);
  const deletions = pr ? pr.deletions : (diff?.deletions ?? 0);
  const changedFiles = pr ? pr.changedFiles : (diff?.files ?? 0);
  const dirty = git?.uncommittedFiles ?? 0;
  // A shared checkout can have different local and remote commit hashes after
  // a cherry-pick even when their files are identical. Once provenance names
  // the session's commits, that branch diff is a duplicate rather than another
  // state to show. Keep a real PR or feature-branch diff unchanged.
  const showDiffChanges =
    changedFiles > 0 && !(git?.sharedCheckout && commits.length > 0);
  const changeFiles = (() => {
    if (pr) {
      const byPath = new Map<string, FileDiffMetadata>();
      const patchIsCurrent =
        !pr.headRefOid || prDiffResource.data?.headRefOid === pr.headRefOid;
      const patch = patchIsCurrent ? prDiffResource.data?.patch || "" : "";
      if (patch.trim()) {
        try {
          for (const parsedPatch of parsePatchFiles(patch)) {
            for (const file of parsedPatch.files) byPath.set(file.name, file);
          }
        } catch {
          // A truncated or malformed patch still leaves the file list useful.
        }
      }
      return (pr.files ?? []).map((file) => ({
        key: file.path,
        path: file.path,
        additions: file.additions,
        deletions: file.deletions,
        meta: byPath.get(file.path),
      }));
    }

    const files: SummaryChangeFile[] = [];
    for (const repo of diffResource.data?.repos ?? []) {
      const byPath = new Map<string, FileDiffMetadata>();
      if (repo.diff.rawPatch.trim()) {
        try {
          for (const parsedPatch of parsePatchFiles(repo.diff.rawPatch)) {
            for (const file of parsedPatch.files) byPath.set(file.name, file);
          }
        } catch {
          // Keep names and line totals when this repo's patch cannot be parsed.
        }
      }
      for (const file of repo.diff.files) {
        files.push({
          key: `${repo.repo}\0${file.path}`,
          path: file.path,
          additions: file.additions,
          deletions: file.deletions,
          meta: byPath.get(file.path),
        });
      }
    }
    return files;
  })();

  /** Route somewhere else and get out of the way. A card that stayed open
   *  over the thing it just opened would have to be dismissed by hand. */
  function go(open?: () => void) {
    close();
    open?.();
  }

  /** Lift one file over the session. The full Assets tab is a deliberate
   *  follow-up from that preview, not the thumbnail's default destination. */
  function openAsset(path: string) {
    if (onOpenAsset) {
      onOpenAsset(path);
      return;
    }
    go(onOpenAssets);
  }

  function openUncommittedChanges() {
    onOpenPanelTab("changes");
  }

  function askCommit() {
    if (!send) return;
    send({
      type: "prompt",
      sessionId: session.id,
      user: getCurrentUser(),
      content: commitPrompt(dirty, git?.sharedCheckout, git?.uncommittedPaths),
    });
    setPrompted(true);
    setTimeout(() => setPrompted(false), 4000);
  }

  // The roster arrives async and the name lookup below reads it, so subscribe
  // here or a reviewer stays a bare person key until something else happens to
  // re-render the card.
  const people = usePeople();
  const reviewTeams = useReviewTeams();
  const reviewers = reviewLines(pr, selectedReview, prReviewRequested);
  const osReview = pr?.osReview;
  const osReviewActive = Boolean(pr?.reviewActive || reviewStarting);
  const showOsReview = osReviewActive || Boolean(osReview);
  const canRerunOsReview = pr?.state === "OPEN" && Boolean(osReview?.stale);
  const canFixOsReview =
    pr?.state === "OPEN" &&
    Boolean(osReview) &&
    !osReview?.stale &&
    Boolean(osReview?.findings);
  let osReviewState = "Not reviewed yet";
  if (osReviewActive) osReviewState = "Reviewing…";
  else if (pr?.state === "MERGED") osReviewState = "Merged";
  else if (pr?.state === "CLOSED") osReviewState = "Closed";
  else if (osReview?.stale) osReviewState = "New commits since review";
  else if (osReview?.findings)
    osReviewState = `${osReview.findings} finding${osReview.findings === 1 ? "" : "s"}${
      osReview.blocking ? `, ${osReview.blocking} blocking` : ""
    }`;
  else if (osReview) osReviewState = "No findings";
  const osScore = osReview?.confidence;
  const osScoreTone = osReview?.stale
    ? "text-faint"
    : osScore && osScore >= 4
      ? "text-green"
      : osScore === 3
        ? "text-yellow"
        : osScore
          ? "text-red"
          : "text-dim";
  const humanReviewers = reviewers
    .filter((reviewer) => reviewer.human)
    .slice(0, REVIEWERS_SHOWN);
  const otherReviewers = reviewers
    .filter(
      (reviewer) =>
        !reviewer.human &&
        (!showOsReview ||
          !GITHUB_BOT_LOGINS.has(
            (reviewer.login || reviewer.key).toLowerCase(),
          )),
    )
    .slice(0, REVIEWERS_SHOWN);
  // The picker belongs to the request, not to whoever reviewed first. A bot
  // or teammate that merely commented is a status to read; hanging the menu
  // on that row would leave no way to ask someone for a review.
  const pickerIndex = humanReviewers.findIndex(
    (reviewer) => reviewer.requested,
  );
  const pickerReviewer = pickerIndex >= 0 ? humanReviewers[pickerIndex] : null;
  const passiveReviewers = humanReviewers.filter(
    (_, index) => index !== pickerIndex,
  );

  // A capture is shown, not listed: `contact-dark.png` names a file without
  // saying what is in it. A report or a data file is the other way round, and
  // its name IS the content. Rather than split the band down that line and
  // leave the files stranded under a strip of pictures, the whole folder is
  // drawn one way at a time and the heading's toggle says which. A file with
  // nothing to show gets a glyph in the picture's place; a picture in the list
  // gets a thumbnail in the row's rail.
  const shown = assets.slice(
    0,
    assetView === "preview" ? ASSET_FRAMES_SHOWN : ASSETS_SHOWN,
  );
  const assetsHidden = assets.length - shown.length;

  async function rerunOsReview() {
    if (!pr || !canRerunOsReview || reviewStarting) return;
    setReviewStarting(true);
    setReviewError(null);
    await (async () => {
      const result = await triggerPrActionApi(
        session.id,
        "review",
        getCurrentUser(),
        session.repo || undefined,
      );
      if (!result.ok)
        throw new Error(result.error || result.message || "Couldn't start");
      void prResource.mutate(
        { ...pr, reviewActive: true },
        { revalidate: false },
      );
    })()
      .catch((error: unknown) => {
        setReviewError(errorMessage(error, "Couldn't start the re-review"));
      })
      .finally(() => setReviewStarting(false));
  }

  async function cancelOsReview() {
    if (!pr?.reviewActive || reviewCancelling) return;
    setReviewCancelling(true);
    setReviewError(null);
    await (async () => {
      await cancelPrReviewApi(
        session.id,
        getCurrentUser(),
        session.repo || undefined,
      );
      // The stop request is durable before the API answers. Return to the last
      // completed result immediately while the worker unwinds in the background.
      void prResource.mutate(
        { ...pr, reviewActive: false },
        { revalidate: false },
      );
    })()
      .catch((error: unknown) => {
        setReviewError(errorMessage(error, "Couldn't cancel the review"));
      })
      .finally(async () => {
        setReviewCancelling(false);
      });
  }

  async function fixOsReview() {
    if (!canFixOsReview || fixBusy) return;
    setFixBusy(true);
    setFixError(null);
    await (async () => {
      const result = await triggerPrActionApi(
        session.id,
        "autofix",
        getCurrentUser(),
        session.repo || undefined,
      );
      if (!result.ok)
        throw new Error(result.error || result.message || "Couldn't start");
      if (result.openSession && result.bksId && onOpenSession) {
        go(() => onOpenSession(result.bksId!, result.session ?? null));
      }
    })()
      .catch((error: unknown) => {
        setFixError(errorMessage(error, "Couldn't start Auto-fix"));
      })
      .finally(async () => {
        setFixBusy(false);
      });
  }

  function pickReviewer(name: string | null, recipients?: string[]) {
    if (reviewBusy) return;
    const previous = selectedReview;
    const next = name
      ? {
          to: name,
          ...(recipients ? { recipients } : {}),
          by: getCurrentUser(),
          at: new Date().toISOString(),
        }
      : null;
    setSelectedReview(next);
    setReviewError(null);
    setReviewBusy(true);
    // A workspace-level request can be stored on a sibling session. Change or
    // clear that owner, while a brand-new request still belongs to this session.
    const owner = (previous && reviewRequestSessionId) || session.id;
    onReviewChange?.(owner, next);
    setSessionReviewerApi(owner, name, getCurrentUser())
      .catch((error: unknown) => {
        setSelectedReview(previous);
        onReviewChange?.(owner, previous);
        setReviewError(errorMessage(error, "Failed to set reviewer"));
      })
      .finally(() => setReviewBusy(false));
  }

  function fileChangeRow(file: SummaryChangeFile) {
    const slash = file.path.lastIndexOf("/");
    const directory = slash >= 0 ? file.path.slice(0, slash + 1) : "";
    const filename = slash >= 0 ? file.path.slice(slash + 1) : file.path;
    const path = (
      <span className="flex min-w-0 flex-1 items-baseline text-left text-label">
        {directory && <span className="truncate text-dim">{directory}</span>}
        <span className="max-w-full shrink-0 truncate text-fg">{filename}</span>
      </span>
    );
    const stats = (
      <span className="inline-flex shrink-0 items-center gap-1 text-meta font-semibold tabular-nums">
        {file.additions > 0 && (
          <span className="text-green">+{file.additions}</span>
        )}
        {file.deletions > 0 && (
          <span className="text-red">−{file.deletions}</span>
        )}
      </span>
    );
    const options = {
      diffStyle: "unified" as const,
      disableFileHeader: true,
      overflow: "scroll" as const,
      enableLineSelection: false,
      theme: diffTheme === "light" ? "pierre-light" : "pierre-dark",
      themeType: diffTheme,
    };

    return (
      <Popover.Root key={file.key} exclusive={false}>
        <Popover.Trigger
          openOnHover={Boolean(file.meta)}
          delay={200}
          closeDelay={90}
          type="button"
          className="mx-2 flex min-h-7 w-[calc(100%_-_16px)] min-w-0 items-center gap-1.5 rounded-row px-2 text-left transition-colors hover:bg-hover focus-ring"
          onClick={() => go(() => onOpenPanelTab("changes"))}
          aria-label={`${file.path} · open in Changes`}
        >
          <span className={WS_SUMMARY_RAIL} aria-hidden />
          {path}
          {stats}
        </Popover.Trigger>
        {file.meta && (
          <Popover.Popup
            portalContainer={
              typeof document !== "undefined" ? document.body : undefined
            }
            side={embedded ? "top" : "left"}
            align="start"
            sideOffset={10}
            elevation="lg"
            className="flex max-h-[min(720px,82vh,var(--available-height))] w-[min(720px,calc(100vw-24px))] flex-col overflow-hidden bg-panel px-3 py-2.5"
          >
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <div className="mb-2 flex min-w-0 items-baseline justify-between gap-2">
                {path}
                {stats}
              </div>
              <div className="min-h-0 flex-1 overflow-auto text-label">
                <FileDiff
                  fileDiff={file.meta}
                  options={options}
                  disableWorkerPool
                />
              </div>
            </div>
          </Popover.Popup>
        )}
      </Popover.Root>
    );
  }

  function diffChangeRow(label: string) {
    return (
      <>
        <button
          className={WS_SUMMARY_ROW}
          onClick={() => setChangesOpen((open) => !open)}
          aria-expanded={changesOpen}
        >
          <span className={WS_SUMMARY_RAIL}>
            <IconFile size={20} className={WS_SUMMARY_ICON} />
          </span>
          <span className={WS_SUMMARY_LABEL}>{label}</span>
          <span className={WS_SUMMARY_COUNT}>
            <span className="text-green">+{additions}</span>{" "}
            <span className="text-red">−{deletions}</span>
          </span>
          <IconChevronDown
            size={14}
            className={cn(
              "shrink-0 text-faint transition-transform motion-reduce:transition-none",
              changesOpen && "rotate-180",
            )}
          />
        </button>
        {changesOpen && changeFiles.length > 0 ? (
          <div className="pb-1">{changeFiles.map(fileChangeRow)}</div>
        ) : null}
      </>
    );
  }

  function setCommitDetailsOpen(open: boolean, sha: string, repo?: string) {
    if (!open) {
      setOpenCommit((current) => (current?.sha === sha ? null : current));
      return;
    }
    setOpenCommit({ sha, status: "loading" });
    fetchCommit(sha, repo)
      .then((details) => {
        setOpenCommit((current) => {
          if (current?.sha !== sha) return current;
          return details
            ? { sha, status: "ready", details }
            : { sha, status: "unavailable" };
        });
      })
      .catch(() => {
        setOpenCommit((current) =>
          current?.sha === sha ? { sha, status: "unavailable" } : current,
        );
      });
  }

  function commitDetailsPopup(target: CommitRowTarget) {
    const sha =
      target.kind === "workspace" ? target.commit.sha : target.commit.oid;
    const details =
      openCommit?.sha === sha && openCommit.status === "ready"
        ? openCommit.details
        : null;
    const title =
      details?.title ||
      (target.kind === "workspace"
        ? target.commit.title
        : target.commit.messageHeadline);
    const body =
      details?.body ||
      (target.kind === "pr" ? target.commit.messageBody : undefined);
    const author =
      details?.author ||
      (target.kind === "pr" ? target.commit.author : undefined);
    const committedAt =
      details?.committedAt ||
      (target.kind === "workspace"
        ? target.commit.committedAt
        : target.commit.authoredDate);
    const repo =
      details?.repo ||
      (target.kind === "workspace" ? target.commit.repo : session.repo);
    const shortSha = details?.shortSha || sha.slice(0, 8);

    return (
      <Popover.Popup
        portalContainer={
          typeof document !== "undefined" ? document.body : undefined
        }
        side={embedded ? "top" : "left"}
        align="start"
        sideOffset={10}
        className="flex max-h-[min(560px,70vh,var(--available-height))] w-[min(440px,calc(100vw-24px))] flex-col overflow-hidden p-0"
      >
        <div className="flex items-baseline justify-between gap-2.5 border-b border-divider bg-surface px-3 py-[9px]">
          <span className="text-label font-semibold text-fg">Commit</span>
          <code className="text-meta text-faint">{shortSha}</code>
        </div>
        {openCommit?.sha === sha && openCommit.status === "loading" ? (
          <div className="p-3 text-meta text-faint" role="status">
            Loading commit…
          </div>
        ) : (
          <div className="overflow-y-auto p-3 text-meta text-dim">
            <div className="text-label font-semibold leading-relaxed text-fg">
              {title}
            </div>
            {body && (
              <div className="mt-2 whitespace-pre-wrap leading-relaxed">
                {body}
              </div>
            )}
            <div className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
              {author && <span>{author}</span>}
              {repo && <span>{repo}</span>}
              {committedAt && <span>{fullTime(committedAt)}</span>}
              {details && (
                <span className="inline-flex gap-1.5 tabular-nums">
                  <span>
                    {details.filesChanged} file
                    {details.filesChanged === 1 ? "" : "s"}
                  </span>
                  <span className="text-green">+{details.additions}</span>
                  <span className="text-red">−{details.deletions}</span>
                </span>
              )}
            </div>
          </div>
        )}
      </Popover.Popup>
    );
  }

  function committedRow(commit: WorkspaceCommit) {
    const expanded = openCommit?.sha === commit.sha;
    return (
      <Popover.Root
        key={commit.sha}
        open={expanded}
        onOpenChange={(open) =>
          setCommitDetailsOpen(open, commit.sha, commit.repo)
        }
        exclusive={false}
      >
        <Popover.Trigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className={WS_SUMMARY_ROW}
              title="Show commit details"
            >
              <span className={WS_SUMMARY_RAIL}>
                <IconGitCommit size={20} className={WS_SUMMARY_ICON} />
              </span>
              <span className={WS_SUMMARY_LABEL}>{commit.title}</span>
              <span
                className={cn(
                  WS_SUMMARY_STATE,
                  "flex items-baseline gap-2 text-dim tabular-nums",
                )}
              >
                <span>
                  {commit.filesChanged} file
                  {commit.filesChanged === 1 ? "" : "s"}
                </span>
                <span className="text-green">+{commit.additions}</span>
                <span className="text-red">−{commit.deletions}</span>
              </span>
            </Button>
          }
        />
        {commitDetailsPopup({ kind: "workspace", commit })}
      </Popover.Root>
    );
  }

  function prCommittedRow(commit: PrCommit) {
    const expanded = openCommit?.sha === commit.oid;
    return (
      <Popover.Root
        key={commit.oid}
        open={expanded}
        onOpenChange={(open) =>
          setCommitDetailsOpen(open, commit.oid, session.repo)
        }
        exclusive={false}
      >
        <Popover.Trigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className={WS_SUMMARY_ROW}
              title="Show commit details"
            >
              <span className={WS_SUMMARY_RAIL}>
                <IconGitCommit size={20} className={WS_SUMMARY_ICON} />
              </span>
              <span className={WS_SUMMARY_LABEL}>{commit.messageHeadline}</span>
              <code className="shrink-0 text-meta text-faint">
                {commit.oid.slice(0, 7)}
              </code>
            </Button>
          }
        />
        {commitDetailsPopup({ kind: "pr", commit })}
      </Popover.Root>
    );
  }

  /** A long session can commit dozens of times. Keep the completed-work totals
   *  folded, then let the section heading reveal every commit in this card. */
  function committedSummaryRow() {
    if (commits.length === 0) return null;
    const stats = commits.reduce(
      (sum, commit) => ({
        files: sum.files + commit.filesChanged,
        additions: sum.additions + commit.additions,
        deletions: sum.deletions + commit.deletions,
      }),
      { files: 0, additions: 0, deletions: 0 },
    );
    const label = `${commits.length} commit${commits.length === 1 ? "" : "s"}`;
    return (
      <button
        type="button"
        className={WS_SUMMARY_ROW}
        onClick={() => setCommitsOpen(true)}
        aria-expanded={false}
        title={`View ${label}`}
      >
        <span className={WS_SUMMARY_RAIL}>
          <IconGitCommit size={20} className={WS_SUMMARY_ICON} />
        </span>
        <span className={WS_SUMMARY_LABEL}>{label}</span>
        <span
          className={cn(
            WS_SUMMARY_STATE,
            "flex items-baseline gap-2 text-dim tabular-nums",
          )}
        >
          <span>
            {stats.files} file{stats.files === 1 ? "" : "s"}
          </span>
          <span className="text-green">+{stats.additions}</span>
          <span className="text-red">−{stats.deletions}</span>
        </span>
      </button>
    );
  }

  const groupClass = embedded
    ? "flex flex-col overflow-hidden rounded-2xl bg-raised py-2 empty:hidden"
    : "contents";
  const prGroupClass = embedded
    ? cn(
        groupClass,
        "py-0 [&_.ws-summary-band]:mx-0 [&_.ws-summary-band]:mb-0 [&_.ws-summary-band]:px-2 [&_.ws-summary-band]:py-3 [&_.ws-summary-band]:[border-radius:inherit]",
      )
    : cn(groupClass, "[&>.ws-summary-band:last-child]:mb-0");

  return (
    <div
      className={
        embedded
          ? "flex flex-col gap-2.5 [&_button]:min-h-11 [&_a]:min-h-11"
          : "contents"
      }
    >
      {/* These two group names are selector hooks: their DOM boxes disappear via
			    `display: contents`, but they are the actual siblings around the PR band. */}
      <div className={cn(prGroupClass, "ws-summary-pr-group")}>
        {/* Which PR, where it stands, and the one thing to do about it. The
				    strip owns all three; this card only says where they go. */}
        {!workspaceIsPreparing && (
          <PrStatusBar
            variant="summary"
            sessionId={session.id}
            repo={session.repo || undefined}
            archived={session.archived}
            prs={session.prs}
            send={send}
            running={running}
            refreshTick={refreshTick}
            onOpenPrTab={() => go(onOpenPr)}
            onOpenStackPr={
              onOpenStackPr
                ? (repo, branch) => go(() => onOpenStackPr(repo, branch))
                : undefined
            }
            onOpenChecksTab={() => go(onOpenChecks)}
            onArchive={onArchive ? () => go(onArchive) : undefined}
          >
            {/* The PR's preview deploy, inside the band with the rest of that
				      PR's state rather than as a loose row under it. It is the globe
				      the header carries while this card is shut: the header stands
				      down when the card is up, the same way it does for the workspace
				      panel, so the deploy is in exactly one place at a time. Renders
				      nothing when the PR has no preview. */}
            <StagingLink
              session={session}
              variant="summary"
              refreshTick={refreshTick}
            />
          </PrStatusBar>
        )}
      </div>

      <div
        className={cn(
          groupClass,
          "ws-summary-review-group",
          !hasConnectedPr && "hidden!",
        )}
      >
        {/* One review section for both the automated reading and the people asked
				    to review. Its action opens the complete workspace review; the final row
				    owns the picker, so neither action requires the workspace panel. */}
        <div
          className={cn(
            WS_SUMMARY_SECTION,
            "ws-summary-review-heading",
            embedded
              ? "h-11"
              : cn(
                  "h-7",
                  // Match the sibling group wrappers, then reach into Review. Keep a
                  // small breath after the PR without splitting the two groups apart.
                  "[.ws-summary-pr-group:has(>.ws-summary-band:last-child)+.ws-summary-review-group_&]:mt-1",
                ),
          )}
        >
          {reviewMode ? (
            <span>Review</span>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="group/review h-full min-h-0 gap-0 rounded-sm p-0 [color:inherit] [font-size:inherit] [font-weight:inherit] hover:bg-transparent hover:[color:inherit] active:scale-100"
              onClick={() => go(onOpenPr)}
              aria-label="Open review"
            >
              <span>Review</span>
              <IconChevronRight
                size={14}
                className="text-faint opacity-50 transition-[color,opacity,transform] group-hover/review:translate-x-0.5 group-hover/review:text-fg group-hover/review:opacity-100 phone:opacity-100"
              />
            </Button>
          )}
        </div>
        {showOsReview && (
          <>
            {canRerunOsReview && !osReviewActive ? (
              <div className="mx-2 flex h-[31px] w-[calc(100%_-_16px)] min-w-0 shrink-0 items-stretch gap-1 phone:h-11">
                <button
                  type="button"
                  className={cn(
                    WS_SUMMARY_ROW,
                    "mx-0 h-full w-auto min-w-0 flex-1",
                  )}
                  onClick={() => go(() => onOpenPanelTab("info"))}
                  title={`${AGENT_NAME}${osScore ? ` · ${osScore}/5` : ""} · ${osReviewState}`}
                >
                  <span className={WS_SUMMARY_RAIL}>
                    <IconRobot size={20} className={WS_SUMMARY_ICON} />
                  </span>
                  <span className={WS_SUMMARY_LABEL}>
                    {AGENT_NAME}
                    {osScore ? (
                      <>
                        <span className="text-faint"> · </span>
                        <span className={cn("tabular-nums", osScoreTone)}>
                          {osScore}/5
                        </span>
                      </>
                    ) : null}
                  </span>
                  <span className={cn(WS_SUMMARY_STATE, "text-faint")}>
                    New commits
                  </span>
                </button>
                <span
                  className="self-center text-meta text-faint"
                  aria-hidden="true"
                >
                  ·
                </span>
                <button
                  type="button"
                  className={cn(
                    WS_SUMMARY_ACTION,
                    "focus-ring shrink-0 cursor-pointer rounded-row border-none bg-transparent px-1 transition-[color,scale] hover:text-accent active:scale-[0.96] disabled:cursor-default disabled:opacity-50",
                  )}
                  onClick={() => void rerunOsReview()}
                  disabled={reviewStarting}
                >
                  Re-review
                </button>
              </div>
            ) : (
              <button
                className={cn(
                  WS_SUMMARY_ROW,
                  "disabled:cursor-default disabled:opacity-70",
                )}
                onClick={
                  osReviewActive
                    ? () => void cancelOsReview()
                    : canFixOsReview
                      ? () => void fixOsReview()
                      : () => go(() => onOpenPanelTab("info"))
                }
                disabled={reviewStarting || reviewCancelling || fixBusy}
                aria-label={
                  osReviewActive
                    ? `Cancel ${AGENT_NAME} review`
                    : canFixOsReview
                      ? `Fix ${AGENT_NAME} review findings`
                      : undefined
                }
                title={`${AGENT_NAME}${osScore ? ` · ${osScore}/5` : ""} · ${
                  reviewCancelling ? "Cancelling…" : osReviewState
                }`}
              >
                <span className={WS_SUMMARY_RAIL}>
                  <IconRobot
                    size={20}
                    className={cn(
                      WS_SUMMARY_ICON,
                      osReviewActive && "animate-pulse",
                    )}
                  />
                </span>
                <span className={WS_SUMMARY_LABEL}>
                  {AGENT_NAME}
                  {osReviewActive ? (
                    <>
                      <span className="text-faint"> · </span>
                      <span className="text-dim">
                        {reviewCancelling ? "Cancelling…" : "Reviewing…"}
                      </span>
                    </>
                  ) : osScore ? (
                    <>
                      <span className="text-faint"> · </span>
                      <span className={cn("tabular-nums", osScoreTone)}>
                        {osScore}/5
                      </span>
                    </>
                  ) : null}
                </span>
                {osReviewActive ? (
                  <span className={WS_SUMMARY_ACTION}>
                    {reviewCancelling ? "Stopping" : "Cancel"}
                  </span>
                ) : canFixOsReview ? (
                  <span className={cn(WS_SUMMARY_ACTION, "text-red")}>
                    {fixBusy ? "Starting…" : "Fix"}
                  </span>
                ) : (
                  <span
                    className={cn(
                      WS_SUMMARY_STATE,
                      osReview?.blocking ? "text-red" : "text-dim",
                    )}
                  >
                    {osReviewState}
                  </span>
                )}
              </button>
            )}
            {fixError && (
              <div className="px-4 py-1 text-supporting text-red" role="alert">
                {fixError}
              </div>
            )}
          </>
        )}
        {otherReviewers.map((reviewer) => (
          <button
            key={reviewer.key}
            className={WS_SUMMARY_ROW}
            onClick={() => go(onOpenPr)}
            title={`${reviewer.name} · ${reviewer.state}`}
          >
            <span className={WS_SUMMARY_RAIL}>
              <UserAvatar
                name={reviewer.name}
                login={reviewer.login}
                size={16}
                edge={false}
              />
            </span>
            <span className={WS_SUMMARY_LABEL}>{reviewer.name}</span>
            <span className={cn(WS_SUMMARY_STATE, reviewer.tone)}>
              {reviewer.state}
            </span>
          </button>
        ))}

        {pickerReviewer && (
          <Menu.Root>
            <Menu.Trigger className={WS_SUMMARY_ROW} disabled={reviewBusy}>
              <span className={WS_SUMMARY_RAIL}>
                <UserAvatar
                  name={pickerReviewer.name}
                  login={pickerReviewer.login}
                  size={16}
                  edge={false}
                />
              </span>
              <span className={WS_SUMMARY_LABEL}>{pickerReviewer.name}</span>
              <span className={cn(WS_SUMMARY_STATE, pickerReviewer.tone)}>
                {pickerReviewer.state}
              </span>
              <IconChevronDown size={14} className="shrink-0 text-faint" />
            </Menu.Trigger>
            <Menu.Popup align="end" sideOffset={6} className="min-w-[200px]">
              {people.map((person) => (
                <Menu.Item
                  key={person.name}
                  onClick={() => pickReviewer(person.name)}
                >
                  <UserAvatar name={person.name} size={22} />
                  <span className="min-w-0 flex-1 truncate">{person.name}</span>
                  <Menu.Check
                    on={selectedReview?.to === person.name}
                    size={20}
                    className="text-dim"
                  />
                </Menu.Item>
              ))}
              {reviewTeams.length > 0 && <Menu.Separator />}
              {reviewTeams.map((team) => (
                <Menu.Item
                  key={team.github}
                  onClick={() => pickReviewer(team.github, team.members)}
                >
                  <span className="grid size-[22px] place-items-center text-dim">
                    <IconStack size={20} />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{team.name}</span>
                  <Menu.Check
                    on={selectedReview?.to === team.github}
                    size={20}
                    className="text-dim"
                  />
                </Menu.Item>
              ))}
              <Menu.Separator />
              <Menu.Item
                className="text-dim"
                onClick={() => pickReviewer(null)}
              >
                Clear review request
              </Menu.Item>
            </Menu.Popup>
          </Menu.Root>
        )}
        {passiveReviewers.map((reviewer) => (
          <button
            key={reviewer.key}
            className={WS_SUMMARY_ROW}
            onClick={() => go(() => onOpenPanelTab("info"))}
            title={`${reviewer.name} · ${reviewer.state}`}
          >
            <span className={WS_SUMMARY_RAIL}>
              <UserAvatar
                name={reviewer.name}
                login={reviewer.login}
                size={16}
                edge={false}
              />
            </span>
            <span className={WS_SUMMARY_LABEL}>{reviewer.name}</span>
            <span className={cn(WS_SUMMARY_STATE, reviewer.tone)}>
              {reviewer.state}
            </span>
          </button>
        ))}
        {!pickerReviewer && (
          <Menu.Root>
            <Menu.Trigger className={WS_SUMMARY_ROW} disabled={reviewBusy}>
              <span className={WS_SUMMARY_RAIL}>
                <IconPeople size={20} className={WS_SUMMARY_ICON} />
              </span>
              <span className={WS_SUMMARY_LABEL}>
                {passiveReviewers.length > 0
                  ? "Ask for review"
                  : "No reviewers"}
              </span>
              <span
                className={cn(
                  WS_SUMMARY_ACTION,
                  "inline-flex items-center gap-0.5",
                )}
              >
                Add
                <IconChevronDown size={14} />
              </span>
            </Menu.Trigger>
            <Menu.Popup align="end" sideOffset={6} className="min-w-[200px]">
              {people.map((person) => (
                <Menu.Item
                  key={person.name}
                  onClick={() => pickReviewer(person.name)}
                >
                  <UserAvatar name={person.name} size={22} />
                  <span className="min-w-0 flex-1 truncate">{person.name}</span>
                  <Menu.Check
                    on={selectedReview?.to === person.name}
                    size={20}
                    className="text-dim"
                  />
                </Menu.Item>
              ))}
              {reviewTeams.length > 0 && <Menu.Separator />}
              {reviewTeams.map((team) => (
                <Menu.Item
                  key={team.github}
                  onClick={() => pickReviewer(team.github, team.members)}
                >
                  <span className="grid size-[22px] place-items-center text-dim">
                    <IconStack size={20} />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{team.name}</span>
                  <Menu.Check
                    on={selectedReview?.to === team.github}
                    size={20}
                    className="text-dim"
                  />
                </Menu.Item>
              ))}
            </Menu.Popup>
          </Menu.Root>
        )}
        {reviewError && (
          <div className="px-4 py-1 text-meta font-medium text-red">
            {reviewError}
          </div>
        )}
      </div>

      {hasCommitDetails && (
        <div className={groupClass}>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              WS_SUMMARY_SECTION,
              "w-full cursor-pointer justify-between gap-2 border-none bg-transparent text-left hover:bg-transparent hover:text-faint active:scale-100",
            )}
            onClick={() => setCommitsOpen((open) => !open)}
            aria-expanded={commitsOpen}
          >
            <span className="flex items-baseline gap-1.5">
              <span>Committed</span>
              <span className="text-meta tabular-nums">{commitCount}</span>
            </span>
            <IconChevronRight
              size={14}
              className={cn(
                "shrink-0 transition-transform motion-reduce:transition-none",
                commitsOpen && "rotate-90",
              )}
            />
          </Button>
          {commitsOpen
            ? prCommits.length > 0
              ? prCommits.map(prCommittedRow)
              : commits.map(committedRow)
            : committedSummaryRow()}
        </div>
      )}

      {showDiffChanges && (
        <div className={groupClass}>
          <div className={WS_SUMMARY_SECTION}>Changes</div>
          {diffChangeRow(
            `${changedFiles} file${changedFiles === 1 ? "" : "s"} changed`,
          )}
        </div>
      )}

      {dirty > 0 && (
        <div className={groupClass}>
          <div className={WS_SUMMARY_SECTION}>Uncommitted</div>
          <div className="mx-2 flex h-[31px] w-[calc(100%_-_16px)] min-w-0 shrink-0 items-stretch gap-1 phone:h-11">
            <button
              type="button"
              className={cn(
                WS_SUMMARY_ROW,
                "mx-0 h-full w-auto min-w-0 flex-1",
              )}
              onClick={openUncommittedChanges}
              title="View uncommitted changes"
            >
              <span className={WS_SUMMARY_RAIL}>
                <IconClock size={20} className={WS_SUMMARY_ICON} />
              </span>
              <span className={WS_SUMMARY_LABEL}>
                {dirty} file{dirty === 1 ? "" : "s"} uncommitted
              </span>
            </button>
            {send && (
              <button
                type="button"
                className={cn(
                  WS_SUMMARY_ACTION,
                  "focus-ring shrink-0 cursor-pointer rounded-row border-none bg-transparent px-2 hover:bg-hover disabled:cursor-default disabled:hover:bg-transparent",
                )}
                onClick={askCommit}
                disabled={prompted}
                title={`Ask ${AGENT_NAME} to commit the uncommitted changes and push`}
              >
                {prompted ? "Asked" : "Commit"}
              </button>
            )}
          </div>
        </div>
      )}

      {media.length > 0 && (
        <div className={groupClass}>
          {/* The strip carries recordings too, but screenshots are what
					    people call the set, so that is the word to head it with. What
					    separates this band from the assets under it is still the
					    source: one is what appeared in the conversation, the other is
					    what the session wrote. Same word the Workspace panel uses. */}
          <div className={cn(WS_SUMMARY_SECTION, "gap-1.5")}>
            <span>Screenshots</span>
            {/* Every frame is available in the strip. Keep the count beside
						    the label so the heading reads as one fact rather than two
						    ends of a row. */}
            <span className={cn(WS_SUMMARY_COUNT, "text-faint")}>
              {media.length}
            </span>
          </div>
          {/* No view toggle on this band, unlike Assets: a picture someone
					    pasted into the conversation has no filename, so a row of one
					    would be a timestamp and nothing you could act on. */}
          <div className={WS_SUMMARY_STRIP}>
            {media.map((item, index) => (
              <button
                key={`${item.sessionId}:${item.at}:${index}`}
                type="button"
                // One width for every frame, a lone one included. A single
                // picture taken up to the card's width reads as a hero in a
                // list of quiet rows, and pushes everything under it a
                // screenshot's height down for no more information.
                className={cn(WS_SUMMARY_FRAME, "w-[calc((100%_-_30px)/2)]")}
                // Open the same complete set shown in the strip. The card stays
                // up behind it while the lightbox pages between frames.
                onClick={(event) =>
                  openLightbox(media, index, event.currentTarget)
                }
                title={[item.sessionTitle, fullTime(item.at)]
                  .filter(Boolean)
                  .join(" · ")}
              >
                <span className={WS_SUMMARY_FRAME_MEDIA}>
                  {item.kind === "video" ? (
                    <>
                      <video
                        src={`${item.src}#t=0.1`}
                        muted
                        playsInline
                        preload="metadata"
                        className="h-full w-full object-contain"
                      />
                      <span className="pointer-events-none absolute inset-0 grid place-items-center">
                        <span className="grid size-7 place-items-center rounded-full bg-black/45 text-white backdrop-blur-sm">
                          <IconPlay size={16} />
                        </span>
                      </span>
                    </>
                  ) : (
                    <img
                      src={item.src}
                      alt=""
                      loading="lazy"
                      className="h-full w-full object-contain"
                    />
                  )}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {assets.length > 0 && (
        <div className={groupClass}>
          <div
            className={cn(
              WS_SUMMARY_SECTION,
              "group/assets justify-between gap-2",
            )}
          >
            <span className="flex items-center gap-1.5">
              <span>Assets</span>
              <span className={cn(WS_SUMMARY_COUNT, "text-faint")}>
                {assets.length}
              </span>
            </span>
            <AssetViewToggle mode={assetView} onChange={setAssetView} />
          </div>
          {assetView === "preview" ? (
            <div className={WS_SUMMARY_STRIP}>
              {shown.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  // One width, however many there are: two frames plus a
                  // sliver of the next is what says the strip scrolls, and a
                  // lone picture blown up to the card reads as a hero in a
                  // list of quiet rows. It also keeps the two strips the same
                  // size when a card shows both.
                  className={cn(WS_SUMMARY_FRAME, "w-[calc((100%_-_30px)/2)]")}
                  onClick={() => openAsset(file.path)}
                  title={file.path}
                >
                  <span className={WS_SUMMARY_FRAME_MEDIA}>
                    {assetPreviewKind(file.path) === "video" ? (
                      <>
                        <video
                          // #t=0.1 seeks to the first frame and paints it as
                          // a poster; without it the tile stays blank.
                          src={`${sessionAssetPreviewUrl(session.id, file)}#t=0.1`}
                          muted
                          playsInline
                          preload="metadata"
                          className="h-full w-full object-contain"
                        />
                        <span className="pointer-events-none absolute inset-0 grid place-items-center">
                          <span className="grid size-7 place-items-center rounded-full bg-black/45 text-white backdrop-blur-sm">
                            <IconPlay size={16} />
                          </span>
                        </span>
                      </>
                    ) : isVisualAsset(file.path) ? (
                      <img
                        src={sessionAssetPreviewUrl(session.id, file)}
                        alt=""
                        loading="lazy"
                        className="h-full w-full object-contain"
                      />
                    ) : (
                      // A report or a data file has no picture to show, so it
                      // holds the same tile with a glyph in it rather than
                      // dropping out of the set and stranding itself below.
                      <span className="grid h-full w-full place-items-center text-faint">
                        <IconFile size={22} />
                      </span>
                    )}
                  </span>
                  <span className={WS_SUMMARY_FRAME_CAPTION}>
                    {/* The folder is usually shared across a set of
										    variants; the filename is what tells them apart. */}
                    {file.path.split("/").pop() || file.path}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            shown.map((file) => (
              <button
                key={file.path}
                className={WS_SUMMARY_ROW}
                onClick={() => openAsset(file.path)}
                title={file.path}
              >
                <span className={WS_SUMMARY_RAIL}>
                  {assetPreviewKind(file.path) === "image" ? (
                    <img
                      src={sessionAssetPreviewUrl(session.id, file)}
                      alt=""
                      loading="lazy"
                      className={WS_SUMMARY_THUMB}
                    />
                  ) : assetPreviewKind(file.path) === "video" ? (
                    // A poster frame at 16px is a smudge, so a recording
                    // says what it is instead.
                    <IconPlayRectangle size={20} className={WS_SUMMARY_ICON} />
                  ) : (
                    <IconFile size={20} className={WS_SUMMARY_ICON} />
                  )}
                </span>
                <span className={WS_SUMMARY_LABEL}>{file.path}</span>
              </button>
            ))
          )}
          {/* Only under the list, where the last row is the only thing that
					    says the folder ends here. The strip answers it three times over:
					    the heading carries the count, the sliver of the next frame says
					    it scrolls, and each tile previews its file on top. */}
          {assetView === "list" && assetsHidden > 0 && (
            <button className={WS_SUMMARY_ROW} onClick={() => go(onOpenAssets)}>
              <span className={WS_SUMMARY_RAIL} />
              <span className={cn(WS_SUMMARY_LABEL, "text-dim")}>
                View all {assets.length}
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
