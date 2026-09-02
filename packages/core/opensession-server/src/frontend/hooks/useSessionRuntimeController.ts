import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { sessionPrTargetKeys } from "../components/session-viewer/runtime-controller";
import { getCurrentUser, useCurrentUser } from "../components/UserPicker";
import {
  fetchPreview,
  fetchPr,
  fetchSessionSubagents,
  promoteSessionApi,
  startPortalRecipeApi,
  type PreviewPortalRecipe,
  type PreviewStatus,
} from "../lib/api";
import { blockingOverlayOpen } from "../lib/blocking-overlay";
import {
  isHiddenForSession,
  onHidesChanged,
  unhideForSession,
} from "../lib/hides";
import { getLane, onLanesChanged } from "../lib/lanes";
import type { LiveTurnStore } from "../lib/live-turn-store";
import { isPinned, onPinsChanged, togglePin } from "../lib/pins";
import { pollWhileVisible, PR_WEBHOOK_FALLBACK_POLL_MS } from "../lib/poll";
import { portalTargetFor } from "../lib/portals";
import { withPreviewPath } from "../lib/preview-url";
import type { SessionViewerProps } from "../lib/session-viewer-bindings";
import { sessionHasWorkspace } from "../lib/session-workspace";
import { ownedBy } from "../lib/sidebar-lanes";
import { copyToClipboard } from "../lib/share-link";
import { matchesShortcut } from "../lib/shortcuts";
import type {
  SessionPrRef,
  TranscriptEntry,
  UnifiedSession,
} from "../lib/types";
import { toast } from "../ui/toast";
import type { SessionSocketSend } from "./useSessionSocket";

interface RuntimeControllerOptions {
  identity: {
    session: UnifiedSession;
    focused: boolean;
    optimisticEmpty: boolean;
    workspaceSessions: UnifiedSession[] | undefined;
    onSetStatus: SessionViewerProps["workspace"]["onSetStatus"];
  };
  run: {
    isRunningLive: boolean;
    isStreaming: boolean;
    safety: UnifiedSession["safety"];
    entries: TranscriptEntry[];
    loading: boolean;
    liveTurnStore: LiveTurnStore;
    forkFrom: { kind: "tip" } | { kind: "message"; messageId: string } | null;
  };
  staging: {
    phonePr: SessionPrRef | undefined;
    show: boolean;
    onClose: (() => void) | undefined;
  };
  socket: { send: SessionSocketSend };
}

type PreviewStatusEffectOptions = {
  showPreviewTab: boolean;
  showPortal: boolean;
  activePanelOpen: boolean;
  infoPageOpen: boolean;
  sessionId: string;
  worktreeDir: string | null | undefined;
};

function stagingIsRelevant(
  session: UnifiedSession,
  phonePr: SessionPrRef | undefined,
) {
  return phonePr
    ? (phonePr.state ??
        (phonePr.source === "primary" ? session.prState : undefined)) === "OPEN"
    : !!session.prUrl && session.prState === "OPEN";
}

export function useSessionRuntimeController({
  identity: {
    session,
    focused,
    optimisticEmpty,
    workspaceSessions,
    onSetStatus,
  },
  run: {
    isRunningLive,
    isStreaming,
    safety,
    entries,
    loading,
    liveTurnStore,
    forkFrom,
  },
  staging: { phonePr, show: showStaging, onClose: onCloseStaging },
  socket: { send },
}: RuntimeControllerOptions) {
  // Bumped on git pushes and matching GitHub webhook events so every mounted PR
  // surface revalidates immediately.
  const [gitRefreshTick, setGitRefreshTick] = useState(0);
  const sessionPrTargetsRef = useRef<Set<string>>(new Set());
  useLayoutEffect(() => {
    sessionPrTargetsRef.current = new Set(
      sessionPrTargetKeys({
        repo: session.repo,
        branch: session.branch,
        attachedRepos: session.attachedRepos,
        prs: session.prs,
      }),
    );
  }, [session.repo, session.branch, session.attachedRepos, session.prs]);
  const [viewers, setViewers] = useState<string[]>([]);
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  // The create run is still preparing this session's worktree (new workspaces
  // announce the session before the slow git work). While true the conversation
  // shows creation progress, and the opening message holds above the composer.
  // Flipped off by the workspace_status event, kept in sync with
  // the sessions poll otherwise.
  const [workspacePreparing, setWorkspacePreparing] = useState(
    !!session.workspacePreparing,
  );
  useEffect(() => {
    setWorkspacePreparing(!!session.workspacePreparing);
  }, [session.workspacePreparing]);

  // Sub-agents the session spawned directly (pi task-tool children /
  // SDK Task agents) — shown in the Agents tab next to workflow runs. Seeded
  // here; the polling effect below (after isBusy exists) keeps them live.
  const [subagents, setSubagents] = useState<
    Awaited<ReturnType<typeof fetchSessionSubagents>>["subagents"]
  >([]);
  useEffect(() => setSubagents([]), [session.id]);

  // Keep the pin star in sync with the store (changes can come from the tab bar
  // or the Home screen) and reset when switching sessions.
  const currentUser = useCurrentUser();
  const [pinned, setPinned] = useState(() => isPinned(session.id));
  useEffect(() => setPinned(isPinned(session.id)), [session.id]);
  useEffect(
    () => onPinsChanged(() => setPinned(isPinned(session.id))),
    [session.id],
  );

  // Claimed into your own sidebar lanes (lib/lanes.ts) — the whole workspace,
  // since that's the unit the sidebar row claims. Lanes live in a module cache
  // like pins, so mirror it into state and re-read on every change.
  const claimSessions = workspaceSessions?.length
    ? workspaceSessions
    : [session];
  const claimIds = claimSessions.map((candidate) => candidate.id).join(",");
  const claimedGlobally = claimSessions.some(
    (candidate) => !!candidate.manualStatus,
  );
  const [claimedLane, setClaimedLane] = useState(false);
  useEffect(() => {
    const read = () =>
      setClaimedLane(claimIds.split(",").some((id) => !!getLane(id)));
    read();
    return onLanesChanged(read);
  }, [claimIds]);
  const claimed = claimedLane || claimedGlobally;
  const hiddenFromSidebar = useSyncExternalStore(
    onHidesChanged,
    () => isHiddenForSession(session),
    () => false,
  );
  // A linked session can be open without belonging to your sidebar: teammate
  // work, automation runs and agent-spawned probes all stay out until claimed.
  // A session you started (or a workspace with one) already renders in your
  // sidebar bands without a lane claim, so it must not offer Add to sidebar.
  const naturallyInSidebar = claimSessions.some(
    (candidate) =>
      !candidate.spawnedBy &&
      !candidate.automation &&
      ownedBy(candidate, currentUser),
  );
  const canKeepInSidebar =
    !session.archived &&
    !!onSetStatus &&
    (hiddenFromSidebar || (!claimed && !naturallyInSidebar));
  function keepInSidebar() {
    unhideForSession(session);
    if (!claimed && !naturallyInSidebar) onSetStatus?.(claimSessions, "mine");
  }
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (
        !focused ||
        e.defaultPrevented ||
        !matchesShortcut(e, "session-pin") ||
        blockingOverlayOpen()
      )
        return;
      e.preventDefault();
      togglePin(session.id);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focused, session.id]);

  // Switching modes is immediate in the interface. The only slow part is the
  // workspace setup behind it, so code affordances appear now and show their
  // own setup state until the server has cut the branch.
  const [promoting, setPromoting] = useState(false);
  const [promotionReady, setPromotionReady] = useState(false);
  const codeMode = session.mode === "code" || promoting || promotionReady;
  const isAsk = session.mode === "ask" && !codeMode;
  const hasWorkspace = sessionHasWorkspace(session) || codeMode;
  // Everything that only makes sense against a repo: the diff, the Changes
  // tab, the PR strip, the repo switch/attach bar. A repo-less session still
  // has a workspace (terminal, agents, assets run in its scratch dir), so
  // these ride their own flag rather than `hasWorkspace`. Promotion gives a
  // repo-less Ask session the selected/default repo on the server.
  const hasRepoWork = hasWorkspace && (!session.repoLess || codeMode);
  async function handlePromote(onDone?: () => void) {
    if (promoting) return;
    setPromoting(true);
    onDone?.();
    try {
      await promoteSessionApi(session.id);
      setPromotionReady(true);
      setPromoting(false);
    } catch (error) {
      toast(
        error instanceof Error
          ? error.message
          : "Could not switch to code mode",
      );
      setPromoting(false);
    }
  }

  const isBusy = !safety && (isRunningLive || isStreaming);
  // Sub-agent list: fetch on open, then re-poll while the session runs so
  // live task-tool spawns appear/settle. Keyed on isBusy too: a run starting
  // after mount restarts the poll loop, and the flip back to idle lands one
  // final fetch that settles statuses.
  useEffect(() => {
    let stale = false;
    let timer: number | undefined;
    const load = async () => {
      try {
        const data = await fetchSessionSubagents(session.id);
        if (stale) return;
        // Keep the previous array when nothing changed: downstream memos
        // (and the LiveSubagents context feeding every ToolCallBlock)
        // only re-render on real updates, not on every 4s poll tick.
        setSubagents((current) =>
          JSON.stringify(current) === JSON.stringify(data.subagents)
            ? current
            : data.subagents,
        );
        if (data.sessionRunning) timer = window.setTimeout(load, 4000);
      } catch {
        // Transient (auth refresh, reload) — the next poll or session
        // switch retries.
      }
    };
    load();
    return () => {
      stale = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [session.id, isBusy]);

  // Derived, not the raw flag: transcript content or streaming text means the
  // opening run already started, so the worktree is done — this guards against
  // a stale sessions poll re-asserting the flag after the workspace_status
  // event already cleared it.
  const waitingForWorkspace =
    promoting ||
    (workspacePreparing && entries.length === 0 && !liveTurnStore.hasText());
  // A sibling session already owns a ready workspace, so its optimistic shell
  // can show the blank conversation and composer immediately. A genuinely new
  // workspace keeps the setup state until its worktree is ready.
  const settingUpWorkspace = waitingForWorkspace && !optimisticEmpty;

  // Anchor for the agent-working elapsed timer. A run that starts
  // while we're watching anchors to now; opening a session mid-run anchors to
  // the server's journaled run start (runStartedAt — survives switches and
  // refreshes), falling back to the turn's user prompt in the transcript, so
  // the timer shows the run's real age, not time-since-I-opened-the-tab. The
  // ref tracks which case we're in: it stays true until we've observed the
  // session idle.
  const [busySince, setBusySince] = useState<number | null>(null);
  // When the Stop was asked for, so the click can be acknowledged locally at
  // once. The server's isRunning:false only lands after the aborted turn
  // actually unwinds — an abort signal is observed at the next await, so a
  // long bash command, an MCP call or a retrying model request holds it for
  // seconds — and until then this row went on counting up as if the click had
  // never happened. 18% of stops in the audit log are a second stop on the
  // same session within a minute (median 1.9s apart): people clicking again
  // because the first click showed them nothing.
  const [stopRequestedAt, setStopRequestedAt] = useState<number | null>(null);
  const anchorFromTranscript = useRef(session.isRunning);
  useEffect(() => {
    anchorFromTranscript.current = true;
    setBusySince(null);
    setStopRequestedAt(null);
  }, [session.id]);
  useEffect(() => {
    if (!isBusy) {
      anchorFromTranscript.current = false;
      setBusySince(null);
      setStopRequestedAt(null);
      return;
    }
    // The journaled run start is authoritative whenever we have it — for a
    // run that starts while watching it's ~now anyway (App stamps it on the
    // status flip), and mid-run it's the real start even when a stale
    // isRunning=false at mount already flipped the anchor ref.
    if (session.runStartedAt) {
      const timestamp = Date.parse(session.runStartedAt);
      if (Number.isFinite(timestamp)) {
        setBusySince((current) => current ?? timestamp);
        return;
      }
    }
    // Mid-run open: wait for the transcript so we can find the turn's prompt.
    if (anchorFromTranscript.current && loading) return;
    setBusySince((current) => {
      if (current != null) return current;
      if (anchorFromTranscript.current) {
        for (let index = entries.length - 1; index >= 0; index--) {
          if (entries[index].type !== "user") continue;
          const timestamp = new Date(entries[index].timestamp).getTime();
          if (Number.isFinite(timestamp)) return timestamp;
          break;
        }
      }
      return Date.now();
    });
  }, [isBusy, loading, entries, session.runStartedAt]);

  // ⌘. asks to stop the running turn from anywhere in the session. Escape
  // asks the same question, but only with the composer focused — which is
  // exactly where you are not when you have been reading the transcript.
  //
  // Both land on the composer's own confirmation. The dialog, and the rule
  // that it goes away when the turn finishes on its own rather than stopping
  // the next one, live there; this only asks for it, through a counter, so
  // there is no second copy of any of that here. (The stop BUTTON stays
  // immediate: pressing it is already deliberate.)
  const [stopRequest, setStopRequest] = useState(0);
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!focused || e.defaultPrevented) return;
      if (!matchesShortcut(e, "run-stop")) return;
      // Nothing running: leave the chord alone rather than swallowing it.
      if (!isBusy || forkFrom) return;
      e.preventDefault();
      setStopRequest((count) => count + 1);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focused, isBusy, forkFrom]);

  // Preview environment for the ⌘O chord — mirrors StagingLink's poll (same
  // relevance gate; the server caches PR details for 30s, so the duplicate
  // fetch stays cheap). Kept here because StagingLink mounts per layout
  // variant, so a window listener inside it would register multiple times.
  const stagingRelevant = stagingIsRelevant(session, phonePr);
  const [staging, setStaging] = useState<{
    url: string;
    status: string;
    embeddable?: boolean;
  } | null>(null);
  // True once the PR fetch has resolved at least once for this session — lets us
  // tell "staging genuinely absent" from "not loaded yet" (the fetch starts null
  // and fills in async), so the Preview environment view-tab auto-closes only on the former
  // rather than flicker-closing during load.
  const [stagingSettled, setStagingSettled] = useState(false);
  useEffect(() => {
    setStagingSettled(false);
    if (!stagingRelevant) {
      setStaging(null);
      setStagingSettled(true);
      return;
    }
    let alive = true;
    const load = () =>
      fetchPr(session.id, phonePr?.repo, phonePr?.branch)
        .then((pullRequest) => {
          if (alive) {
            setStaging(pullRequest?.staging ?? null);
            setStagingSettled(true);
          }
        })
        .catch(() => {});
    load();
    const stop = pollWhileVisible(load, PR_WEBHOOK_FALLBACK_POLL_MS);
    return () => {
      alive = false;
      stop();
    };
  }, [
    session.id,
    stagingRelevant,
    gitRefreshTick,
    phonePr?.repo,
    phonePr?.branch,
  ]);
  const stagingUrl = staging
    ? withPreviewPath(staging.url, session.previewPath)
    : null;
  // The Preview environment pane is a top-strip view-tab now (App owns whether it's
  // foregrounded). If the deploy vanishes while its tab is open+active — PR
  // merged/closed, so `stagingRelevant` drops and the fetch settles with no
  // staging — close the tab rather than leave it pointing at nothing.
  useEffect(() => {
    if (showStaging && stagingSettled && !stagingUrl) onCloseStaging?.();
  }, [showStaging, stagingSettled, stagingUrl, onCloseStaging]);

  // ⌘O opens the PR's preview environment (the Vercel preview StagingLink's globe
  // points at); ⌘G opens its GitHub PR and ⌘⇧G copies that URL instead.
  // Chords without a target (no staging deploy / no PR) fall through to the
  // browser.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!focused) return;
      const openPr = matchesShortcut(e, "open-pr");
      const copyPr = matchesShortcut(e, "pr-copy-link");
      const openPreview = matchesShortcut(e, "open-preview");
      if (
        e.defaultPrevented ||
        (!openPr && !copyPr && !openPreview) ||
        blockingOverlayOpen()
      )
        return;
      // Same composer exemption as the archive chords above: the composer
      // autofocuses, so an unconditional editable-focus bail would leave
      // these dead almost always. Other inputs keep the guard.
      const target = e.target;
      const editable =
        target instanceof HTMLElement
          ? target.closest(
              "input, textarea, select, [contenteditable='true'], [contenteditable='']",
            )
          : null;
      if (editable && !editable.classList.contains("composer-textarea")) return;
      if (openPr || copyPr) {
        // Primary branch's PR, falling back to the first attached/linked
        // repo PR on multi-repo sessions.
        const prUrl = session.prUrl ?? session.prs?.find((ref) => ref.url)?.url;
        if (!prUrl) return;
        e.preventDefault();
        if (copyPr) {
          copyToClipboard(prUrl, () => toast("Pull request link copied"));
          return;
        }
        window.open(prUrl, "_blank", "noopener");
      } else if (openPreview && staging) {
        e.preventDefault();
        // Match the globe's click semantics: before the first deploy goes
        // Ready the branch alias 404s, so swallow the chord with the same
        // explanatory toast instead of opening a dead link. (A rebuild
        // after a push keeps status Ready and stays openable — the alias
        // serves the previous deploy until the new one lands.)
        if (staging.status !== "Ready") {
          toast(
            `Preview environment is ${staging.status.toLowerCase()}. The link goes live once the first deploy finishes.`,
          );
          return;
        }
        window.open(
          withPreviewPath(staging.url, session.previewPath),
          "_blank",
          "noopener",
        );
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focused, session.prUrl, session.prs, session.previewPath, staging]);

  const [previewStatus, setPreviewStatus] = useState<PreviewStatus | null>(
    null,
  );
  useEffect(() => setPreviewStatus(null), [session.id]);
  async function startDeclaredPortal(recipe: PreviewPortalRecipe) {
    if (!recipe.command) {
      if (!recipe.skill) throw new Error("This Portal has no start command.");
      send({
        type: "prompt",
        sessionId: session.id,
        user: getCurrentUser(),
        content: `Use the $${recipe.skill} skill to start the “${recipe.name}” Portal, then verify it is ready.`,
      });
      return;
    }
    setPreviewStatus(await startPortalRecipeApi(session.id, recipe.id));
  }
  // Services with a route we can open: what the panel's tab strip reports
  // beside Portals, so the count is the openable ones rather than every port
  // the repository declares.
  const livePortals = (previewStatus?.services ?? []).filter((service) =>
    portalTargetFor(session.id, service),
  ).length;
  return {
    agents: {
      subagents,
      currentUser,
      pinned,
      canKeepInSidebar,
      keepInSidebar,
      promoting,
      codeMode,
      isAsk,
      hasWorkspace,
      hasRepoWork,
      handlePromote,
    },
    presence: {
      gitRefreshTick,
      setGitRefreshTick,
      sessionPrTargetsRef,
      viewers,
      setViewers,
      typingUsers,
      setTypingUsers,
      workspacePreparing,
      setWorkspacePreparing,
    },
    run: {
      isBusy,
      busySince,
      stopRequestedAt,
      setStopRequestedAt,
      stopRequest,
      waitingForWorkspace,
      settingUpWorkspace,
    },
    staging: { deployment: staging, url: stagingUrl },
    preview: {
      status: previewStatus,
      setStatus: setPreviewStatus,
      startDeclaredPortal,
      livePortals,
    },
  };
}

export function useSessionPreviewStatusEffect(
  preview: ReturnType<typeof useSessionRuntimeController>["preview"],
  {
    showPreviewTab,
    showPortal,
    activePanelOpen,
    infoPageOpen,
    sessionId,
    worktreeDir,
  }: PreviewStatusEffectOptions,
) {
  const setPreviewStatus = useEffectEvent((status: PreviewStatus) => {
    preview.setStatus(status);
  });
  // The header preview control used to keep this status warm. Now that the
  // launcher lives in the overflow menu. Keep status warm while Preview or the
  // portal browser is up, and while the workspace panel is open. Its bottom
  // bar counts live portals and its portals page lists them. Status requests
  // also renew the authenticated Caddy routes for remote sandbox services.
  useEffect(() => {
    if (
      (!showPreviewTab && !showPortal && !activePanelOpen && !infoPageOpen) ||
      !worktreeDir
    )
      return;
    let alive = true;
    const load = () =>
      fetchPreview(sessionId)
        .then((status) => {
          if (alive) setPreviewStatus(status);
        })
        .catch(() => {});
    load();
    const stop = pollWhileVisible(load, 3000);
    return () => {
      alive = false;
      stop();
    };
  }, [
    showPreviewTab,
    showPortal,
    activePanelOpen,
    infoPageOpen,
    sessionId,
    worktreeDir,
  ]);
}
