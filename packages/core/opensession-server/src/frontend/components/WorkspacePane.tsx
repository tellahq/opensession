import { AGENT_NAME } from "../lib/brand";
import React, {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import type {
  UnifiedSession,
  Workspace,
  WSClientMessage,
  WSServerMessage,
} from "../lib/types";
import {
  fetchModels,
  fetchSession,
  fetchWorkspaceOverview,
  updateWorkspaceApi,
  type ModelOption,
} from "../lib/api";
import { Composer } from "./Composer";
import { ConversationPane } from "./ConversationPane";
import { FeedWebPane, refWebPanel } from "./FeedWebPane";
import { SlackChannelPane } from "./SlackChannelPane";
import { MarkdownRepoProvider } from "./MarkdownBody";
import { PrPanel, type PrReviewPage } from "./PrPanel";
import type { PrFocus } from "../lib/pr-focus";
import { RepoTile, repoLabel } from "./RepoTile";
import { WorkspaceInfo } from "./WorkspaceInfo";
import { WorkspaceSummary } from "./WorkspaceSummary";
import { useCurrentUser } from "./UserPicker";
import { useIsPhone } from "../hooks/useIsPhone";
import { useSidePanel } from "../hooks/useSidePanel";
import {
  IconArchive,
  IconArrowUpToLine,
  IconChevronRight,
  IconDotsHorizontal,
  IconHistory,
  IconLink,
  IconPencil,
  IconPlus,
  IconSidebarRight,
  IconTrash,
} from "./icons";
import { Button } from "../ui/button";
import { useConfirm } from "../ui/confirm";
import { Menu, MENU_ICON } from "../ui/menu";
import { CopyCheck, useCopy } from "../ui/copy";
import { toast } from "../ui/toast";
import { Tooltip } from "../ui/tooltip";
import { OverflowFadeText } from "../ui/overflow-fade-text";
import { cn } from "../ui/cn";
import { TopBar, TopBarActions, TopBarLeading } from "../ui/top-bar";
import {
  PANEL_BODY,
  PANEL_OVERLAY,
  PANEL_SHELL,
} from "../lib/session-panel-classes";
import {
  VIEWER_BRANCH,
  VIEWER_BRANCH_EDITABLE,
  VIEWER_BRANCH_RENAME,
  VIEWER_HEADER,
  VIEWER_HEADER_ACTIONS,
  VIEWER_OVERFLOW,
  VIEWER_TITLE,
} from "../lib/session-viewer-classes";
import {
  loadDraft,
  saveDraft,
  clearDraft,
  workspaceDraftKey,
} from "../lib/drafts";
import {
  attachToDraft,
  dropStagingAttachments,
  isStaging,
  sameFiles,
  sameImages,
} from "../lib/attachments";
import { useAttachmentUploads } from "../hooks/useAttachmentUploads";
import type { FileAttachment } from "../lib/images";
import { hasDraggedFiles } from "../lib/file-drag";
import {
  workspaceComposerTarget,
  workspaceDraftPatch,
} from "../lib/workspace-draft";
import { resolveNewSessionModel } from "../lib/default-model-pref";
import { InlineAlert } from "../ui/state";
import { duration, ease } from "../ui/motion";
import { mainSession } from "../lib/landing-session";
import { sessionCarriesPr } from "../lib/session-prs";
import type { NewTabMorphOrigin } from "../lib/session-tabs-types";
import { ArchivedSessionItems } from "./ArchivedSessionItems";
import {
  workspaceSummaryOpen,
  WS_SUMMARY_ROOM_W,
} from "../lib/workspace-summary-open";

interface Props {
  workspace: Workspace;
  /** The workspace's live sessions, strip order (empty for a session-less workspace). */
  workspaceSessions: UnifiedSession[];
  /** All sessions — the Review pane matches the PR target against any of them. */
  sessions: UnifiedSession[];
  /** Foregrounded view tab; null = the workspace home (first-session composer). */
  tab: "review" | "conversation" | "video" | null;
  connected: boolean;
  send: (msg: WSClientMessage) => void;
  addHandler: (handler: (msg: WSServerMessage) => void) => () => void;
  /** `created` is the server's copy of a session the info panel just made
	    (Auto-fix), so the app can open it without a loading placeholder. */
  onOpenSession: (id: string, created?: UnifiedSession | null) => void;
  /** Open another PR in the review panel (stack map layer links). */
  onOpenPr?: (repo: string, branch: string) => void;
  /**
   * The PR this workspace was opened for, when something named one (a sidebar
   * PR row, a `repo#123` chip). Carries the workspace it was resolved
   * against, so an older request can't retarget a workspace opened by other
   * means. See lib/pr-focus.ts.
   */
  focusPr?: PrFocus & { workspaceId?: string };
  /** Whether the workspace has a real choice of tabs. A lone Review pane keeps
   *  the strip hidden and moves its + into the header, like a lone Chat. */
  tabStripVisible: boolean;
  /** Start a sibling session from the header when the lone-tab strip is hidden. */
  onNewSession?: (origin?: NewTabMorphOrigin) => void;
  /** The app's top-bar slot. The header row portals in here, the same slot and
	    the same row a session's header uses, so the chrome doesn't change shape
	    when a workspace has no session yet. */
  topbarEl?: HTMLElement | null;
  /** The phone top bar's trailing slot. The same workspace menu used in the
	    desktop title cluster portals here so both widths expose one menu. */
  headerActionsEl?: HTMLElement | null;
  /** Rename from the shared workspace menu or by double-clicking the title. */
  onRenameWorkspace?: (name: string) => void | Promise<void>;
  /** Closed sessions remain reachable while a workspace-wide tab is active. */
  archivedSessions?: UnifiedSession[];
  onRestoreSession?: (session: UnifiedSession) => void;
  /** Workspace lifecycle belongs here; session lifecycle belongs to its tab. */
  onArchiveWorkspace?: () => void;
  onDeleteWorkspace?: () => void | Promise<void>;
  /** The app's right-column slot — see the header note; the info panel portals
	    in here so it is a full-height column rather than a box below the tabs. */
  rightPanelEl?: HTMLElement | null;
}

/**
 * Top clearance for a view-tab pane on a phone. Unlike the transcript, these
 * panes don't self-pad for the fixed header + docked tab bar, so their own top
 * chrome (the PR header rows, the ticket title) hid underneath it. Their inner
 * scrollers then clip cleanly at the opaque bar's bottom edge.
 * `--strip-clearance` is only set when the docked bar is shown; the
 * `--pane-header-h` term covers the floating pills when it isn't. Desktop has
 * neither, which is why this is phone-only.
 */
const VIEW_MAIN =
  "phone:pt-[calc(var(--pane-header-h)+var(--strip-clearance,0px))]";

/**
 * The session-less workspace container: what a /workspace/<id> route renders when
 * no session is selected. The tab strip above it (SessionTabs) carries the
 * workspace's sessions + view tabs; this pane renders the foregrounded view tab's
 * content — Review via the same PrPanel canvas the in-session tab uses (session
 * APIs when a session carries the PR, repo+branch preview APIs otherwise) — or the
 * workspace home: a composer that starts the first session. PR-backed workspaces
 * start that session on the PR's head branch (fromPr); ticket workspaces inherit
 * plainThreadId server-side from the workspace record.
 */
export function WorkspacePane({
  workspace,
  workspaceSessions,
  sessions,
  tab,
  connected,
  send,
  addHandler,
  onOpenSession,
  onOpenPr,
  focusPr,
  tabStripVisible,
  onNewSession,
  topbarEl,
  headerActionsEl,
  onRenameWorkspace,
  archivedSessions,
  onRestoreSession,
  onArchiveWorkspace,
  onDeleteWorkspace,
  rightPanelEl,
}: Props) {
  const draftKey = workspaceDraftKey(workspace.id);
  // Seed from the local (this-browser) draft first: it's the freshest thing
  // typed here. Fall back to the server's parked draft (typed on
  // another device, or by whoever saved it from the New Session composer).
  const [prompt, setPrompt] = useState(() => {
    const local = loadDraft(draftKey).text;
    return local || workspace.draft?.text || "";
  });
  // Workspace drafts share the ordinary composer attachment path. The server
  // draft carries text across devices; staged attachments stay in this
  // browser's draft store until the first session consumes them.
  const [images, setImages] = useState<string[]>(
    () => loadDraft(draftKey).images,
  );
  const [files, setFiles] = useState<FileAttachment[]>(
    () => loadDraft(draftKey).files,
  );
  const uploads = useAttachmentUploads();
  const staging = uploads.staging;
  const [fileDragActive, setFileDragActive] = useState(false);
  const fileDragWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const workspaceCopy = useCopy();
  const currentUser = useCurrentUser();
  // Only a workspace that mounted with a server draft gets autosaved back to
  // it. Keep that ownership for this mount after the text is cleared, so typing
  // again can restore the row instead of leaving an unreachable local draft.
  // An ordinary sessionless workspace still never invents a server draft.
  const [parksServerDraft] = useState(() => !!workspace.draft);
  const draftAutoNameRef = useRef(workspace.draft?.autoName);
  const promptRef = useRef(prompt);
  const currentUserRef = useRef(currentUser);
  useLayoutEffect(() => {
    if (workspace.draft) draftAutoNameRef.current = workspace.draft.autoName;
    promptRef.current = prompt;
    currentUserRef.current = currentUser;
  });
  const serverDraftPresentRef = useRef(!!workspace.draft);
  const serverDraftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  // Emptying a draft writes null, while typing again writes an object. Keep
  // those requests in edit order so a slower text write cannot resurrect a
  // draft after its later deletion has landed.
  const serverDraftWrites = useRef<Promise<void>>(Promise.resolve());
  // Stable per workspace: refs + module fns otherwise.
  const pushServerDraft = useCallback(
    (text: string) => {
      const patch = workspaceDraftPatch(
        text,
        new Date().toISOString(),
        currentUserRef.current,
        draftAutoNameRef.current,
      );
      serverDraftWrites.current = serverDraftWrites.current
        .then(async () => {
          const updated = await updateWorkspaceApi(workspace.id, patch);
          const present = !!updated.draft;
          const presenceChanged = present !== serverDraftPresentRef.current;
          serverDraftPresentRef.current = present;
          // Only the empty/nonempty edge changes sidebar membership. Publish
          // the latest edge without refetching the whole list after ordinary edits.
          if (presenceChanged && promptRef.current === text)
            window.dispatchEvent(new Event("opensession:workspaces-changed"));
        })
        // Autosave must never block typing. A flaky connection just means
        // the next keystroke's debounce tries again.
        .catch(() => {});
    },
    [workspace.id],
  );
  useEffect(() => {
    saveDraft(draftKey, { text: prompt, images, files });
  }, [draftKey, prompt, images, files]);
  useEffect(() => {
    if (!parksServerDraft) return;
    clearTimeout(serverDraftTimer.current);
    serverDraftTimer.current = setTimeout(() => pushServerDraft(prompt), 800);
    return () => clearTimeout(serverDraftTimer.current);
  }, [prompt, parksServerDraft, pushServerDraft]);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const startingRef = useRef(false);
  const startTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  // A debounced write in flight when the pane unmounts (navigating away)
  // would otherwise be dropped entirely. Flush it instead of losing the
  // last few keystrokes. Not when a session start is what unmounted the
  // pane, though: the server consumed the draft at create, and a flush
  // would park the just-sent prompt back on the workspace as a stale draft.
  // The exit flush is not reactive: it reads the latest refs at teardown.
  const flushServerDraftOnExit = useEffectEvent(() => {
    if (serverDraftTimer.current) {
      clearTimeout(serverDraftTimer.current);
      if (parksServerDraft && !startingRef.current)
        pushServerDraft(promptRef.current);
    }
  });
  useEffect(() => () => flushServerDraftOnExit(), []);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [model, setModel] = useState(""); // "" = default
  const isPhone = useIsPhone();
  const sidePanel = useSidePanel();
  // Review gets a quiet first paint without changing the browser-wide panel
  // preference. If someone opens it here, keep that choice while this pane stays
  // mounted, then restore the ordinary preference on the other tabs.
  const [reviewPanelOpen, setReviewPanelOpen] = useState(false);
  const [reviewPage, setReviewPage] = useState<PrReviewPage>("files");
  const panelOpen = tab === "review" ? reviewPanelOpen : sidePanel.open;
  const setPanelOpen =
    tab === "review" ? setReviewPanelOpen : sidePanel.setOpen;

  useEffect(() => {
    const load = () =>
      fetchModels(workspace.id)
        .then(async (m) => {
          setModels(m.models);
          setDefaultModel(m.default);
          // Preselect this person's own default model and engine (Settings →
          // Preferences); "" keeps the workspace default.
          const preselect = await resolveNewSessionModel(m);
          if (preselect) setModel((current) => current || preselect);
        })
        .catch(() => {});
    void load();
    window.addEventListener("opensession:workspaces-changed", load);
    return () =>
      window.removeEventListener("opensession:workspaces-changed", load);
  }, [workspace.id]);

  // Success navigates away on session_created (App handles it); on failure the
  // `starting` lock would stick forever — reset on server error or timeout
  // (same pattern as the PR/support previews).
  useEffect(() => {
    return addHandler((msg) => {
      if (msg.type === "error" && startingRef.current) {
        clearTimeout(startTimer.current);
        startingRef.current = false;
        setStarting(false);
        setStartError(msg.message || "Failed to start the session.");
      } else if (msg.type === "session_created" && startingRef.current) {
        dropStagingAttachments(draftKey);
        clearDraft(draftKey);
        // Cancel any in-flight draft autosave too: the server consumed
        // the workspace draft at create, and a late debounce landing
        // after that clear would resurrect it as a stale draft.
        clearTimeout(serverDraftTimer.current);
        serverDraftTimer.current = undefined;
      }
    });
  }, [addHandler, draftKey]);
  useEffect(() => () => clearTimeout(startTimer.current), []);

  const addWorkspaceAttachments = useCallback(
    async (picked: FileList | File[]) => {
      const results = await uploads.upload(picked, (file, signal) =>
        attachToDraft(draftKey, [file], signal),
      );
      if (results.some((result) => result.applied)) {
        const stored = loadDraft(draftKey);
        setImages((current) =>
          sameImages(current, stored.images) ? current : stored.images,
        );
        setFiles((current) =>
          sameFiles(current, stored.files) ? current : stored.files,
        );
      }
      const rejected = results.flatMap((result) => result.rejected);
      if (rejected.length) alert(`Couldn't attach:\n${rejected.join("\n")}`);
    },
    [draftKey, uploads],
  );

  useEffect(() => {
    if (tab !== null || !connected || starting) {
      setFileDragActive(false);
      return;
    }
    function resetFileDrag() {
      if (fileDragWatchdogRef.current)
        clearTimeout(fileDragWatchdogRef.current);
      fileDragWatchdogRef.current = null;
      setFileDragActive(false);
    }
    function armFileDragWatchdog() {
      if (fileDragWatchdogRef.current)
        clearTimeout(fileDragWatchdogRef.current);
      fileDragWatchdogRef.current = setTimeout(resetFileDrag, 500);
    }
    function handleDragEnter(event: DragEvent) {
      if (!hasDraggedFiles(event.dataTransfer)) return;
      event.preventDefault();
      armFileDragWatchdog();
      setFileDragActive(true);
    }
    function handleDragLeave(event: DragEvent) {
      if (!hasDraggedFiles(event.dataTransfer)) return;
      const next = event.relatedTarget;
      if (next instanceof Node && document.documentElement.contains(next))
        return;
      resetFileDrag();
    }
    function handleDragOver(event: DragEvent) {
      if (!hasDraggedFiles(event.dataTransfer)) return;
      event.preventDefault();
      armFileDragWatchdog();
      setFileDragActive(true);
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    }
    function handleDrop(event: DragEvent) {
      if (!hasDraggedFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      const dropped = event.dataTransfer?.files;
      resetFileDrag();
      if (dropped?.length) void addWorkspaceAttachments(dropped);
    }
    window.addEventListener("dragenter", handleDragEnter, true);
    window.addEventListener("dragleave", handleDragLeave, true);
    window.addEventListener("dragover", handleDragOver, true);
    window.addEventListener("drop", handleDrop, true);
    return () => {
      window.removeEventListener("dragenter", handleDragEnter, true);
      window.removeEventListener("dragleave", handleDragLeave, true);
      window.removeEventListener("dragover", handleDragOver, true);
      window.removeEventListener("drop", handleDrop, true);
      resetFileDrag();
    };
  }, [tab, connected, starting, addWorkspaceAttachments]);

  // The Review pane's target: the workspace's own PR branch, rendered through
  // the newest session that carries it (session PR APIs) or the repo+branch
  // preview APIs when none does — the PrQueuePreview pattern, workspace-scoped.
  //
  // A named PR wins over the workspace's own branch. This pane is what a
  // workspace shows before its sessions have loaded, which is most of the
  // time a PR link is followed cold — and the workspace's branch is the
  // first PR filed here, not the one the link was for.
  const focusedBranch =
    focusPr?.workspaceId === workspace.id ? focusPr?.branch : undefined;
  const reviewTarget = focusedBranch
    ? {
        repo: focusPr?.repo || workspace.repo || "repository",
        branch: focusedBranch,
      }
    : workspace.branch
      ? { repo: workspace.repo || "repository", branch: workspace.branch }
      : null;
  useEffect(
    () => setReviewPage("files"),
    [reviewTarget?.repo, reviewTarget?.branch],
  );
  const reviewSessions = (() => {
    if (!reviewTarget) return [];
    return sessions.filter(
      (s) =>
        s.workspaceId === workspace.id && sessionCarriesPr(s, reviewTarget),
    );
  })();
  // PR APIs can use the freshest carrier, while workspace presentation belongs
  // to the human conversation that produced the change. Keeping those roles
  // separate prevents a newer bks-ghpr automation session from replacing the
  // walkthrough, assets and summary of the implementation session.
  const reviewSession =
    [...reviewSessions].sort((a, b) =>
      (b.lastActivity || "").localeCompare(a.lastActivity || ""),
    )[0] || null;
  const listedPresentationSession =
    mainSession(
      [...reviewSessions].sort((a, b) =>
        (a.createdAt || "").localeCompare(b.createdAt || ""),
      ),
    ) ?? null;
  const [hydratedPresentationSession, setHydratedPresentationSession] =
    useState<UnifiedSession | null>(null);
  useEffect(() => {
    setHydratedPresentationSession(null);
    if (listedPresentationSession || tab !== "review") return;
    let stale = false;
    const load = async () => {
      await (async () => {
        // The overview is already workspace-scoped on the server and includes
        // archived/filtered members. Its opening prompt identifies the human
        // session even when the sidebar's live slice cannot see that session.
        const overview = await fetchWorkspaceOverview(workspace.id);
        const ids = [
          overview.prompt?.sessionId,
          overview.lastMessage?.sessionId,
        ];
        for (const id of ids) {
          if (!id) continue;
          const candidate = await fetchSession(id);
          if (!stale && candidate) {
            setHydratedPresentationSession(candidate);
            return;
          }
        }
      })().catch(async () => {
        // A genuinely session-less PR still renders through preview APIs.
      });
    };
    void load();
    return () => {
      stale = true;
    };
  }, [listedPresentationSession, tab, workspace.id]);
  const presentationSession =
    listedPresentationSession ?? hydratedPresentationSession ?? reviewSession;

  function handleStart(_text: string, opts?: { pastedTexts?: string[] }) {
    const q = prompt.trim();
    const pastedTexts = opts?.pastedTexts ?? [];
    if (
      (!q &&
        images.length === 0 &&
        files.length === 0 &&
        pastedTexts.length === 0) ||
      isStaging(staging) ||
      starting ||
      !connected
    )
      return;
    setStarting(true);
    startingRef.current = true;
    setStartError(null);
    clearTimeout(startTimer.current);
    startTimer.current = setTimeout(() => {
      if (!startingRef.current) return;
      startingRef.current = false;
      setStarting(false);
      setStartError(
        `${AGENT_NAME} didn't respond. Check your connection and try again.`,
      );
    }, 15_000);
    // PR-backed workspaces keep their existing branch. A parked draft with a
    // repo starts in Code on a fresh branch, matching the New session palette
    // it came from. Ticket workspaces without a draft remain Ask, while repo-less
    // feed workspaces start in Scratch.
    const target = workspaceComposerTarget(workspace, q);
    const message: WSClientMessage = {
      type: "create_session",
      ...target,
      workspaceId: workspace.id,
      prompt: q,
      user: currentUser,
    };
    if (model) message.model = model;
    if (images.length) message.images = images;
    if (files.length)
      message.files = files.map((file) =>
        file.path
          ? { name: file.name, path: file.path }
          : { name: file.name, dataUrl: file.dataUrl },
      );
    if (pastedTexts.length) message.pastedTexts = pastedTexts;
    send(message);
    // App navigates into the session on session_created.
  }

  // The session-scoped APIs the panel's PR / diff / git rows read through. A
  // session-less workspace has none, and the panel simply shows what the
  // workspace record and its overview already say.
  const anchorSession =
    presentationSession ?? workspaceSessions[0] ?? reviewSession;

  // The workspace's right column: the same panel a session shows, with the
  // same Info block in it. A workspace is a first-class surface, so the chrome
  // around it doesn't change when the last session goes — only what the pane
  // beside it holds.
  const infoPanel = !isPhone && panelOpen && (
    <>
      <div className={PANEL_OVERLAY} onClick={() => setPanelOpen(false)} />
      <aside className={PANEL_SHELL} style={sidePanel.style}>
        {sidePanel.resizeHandle}
        <div className={PANEL_BODY}>
          <div className="px-1">
            <WorkspaceInfo
              sessionId={anchorSession?.id || ""}
              workspaceId={workspace.id}
              sessions={workspaceSessions.map((s) => ({
                id: s.id,
                title: s.title,
                createdAt: s.createdAt || "",
                startedBy: s.startedBy,
              }))}
              repo={workspace.repo || undefined}
              prState={anchorSession?.prState}
              send={connected ? send : undefined}
              onOpenSession={onOpenSession}
              liveMediaCount={0}
            />
          </div>
        </div>
      </aside>
    </>
  );

  // The header row, in the app's own top-bar slot so it lands exactly where a
  // session's header does — beside the pane, not across the panel.
  const headerRef = useRef<HTMLDivElement>(null);
  const headerActionsRef = useRef<HTMLDivElement>(null);
  const [reviewSessionActionTarget, setReviewSessionActionTarget] =
    useState<HTMLDivElement | null>(null);
  const [headerW, setHeaderW] = useState(0);
  const [reviewSummaryOpen, setReviewSummaryOpen] =
    useState(workspaceSummaryOpen);
  useLayoutEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const box = getComputedStyle(el);
    setHeaderW(
      el.clientWidth -
        parseFloat(box.paddingLeft) -
        parseFloat(box.paddingRight),
    );
    const observer = new ResizeObserver(([entry]) => {
      setHeaderW(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [topbarEl]);
  const reviewSummaryHasRoom = headerW === 0 || headerW >= WS_SUMMARY_ROOM_W;
  const reviewSummaryVisible =
    tab === "review" &&
    !!presentationSession &&
    reviewSummaryOpen &&
    reviewSummaryHasRoom &&
    !panelOpen &&
    !isPhone;

  function commitWorkspaceRename() {
    const name = renameDraft?.trim();
    setRenameDraft(null);
    if (name && name !== workspace.name) void onRenameWorkspace?.(name);
  }

  // One workspace menu, placed in the title cluster on desktop and portaled
  // into the phone's trailing nav slot. Its trigger is the same Button/Menu
  // composition as SessionViewer's ⋯, so the bar does not change controls when
  // the foreground tab changes from a session to a workspace-wide pane.
  const workspaceMenu = (
    <Menu.Root open={overflowOpen} onOpenChange={setOverflowOpen}>
      <div className={VIEWER_OVERFLOW}>
        <Menu.Trigger
          render={
            <Button
              variant="ghost"
              size="md"
              icon={<IconDotsHorizontal size={22} />}
            />
          }
          className={cn(
            "[corner-shape:squircle]",
            isPhone &&
              "size-11 min-h-11 rounded-control border-transparent text-dim shadow-none [corner-shape:squircle]",
            overflowOpen && "bg-hover text-fg",
          )}
          title="More actions"
          aria-label="More actions"
        />
        <Menu.Popup
          align={isPhone ? "end" : "start"}
          sideOffset={6}
          className="min-w-[240px] max-w-[min(300px,calc(100vw-24px))]"
        >
          {onRenameWorkspace && (
            <Menu.Item onClick={() => setRenameDraft(workspace.name)}>
              <IconPencil size={20} className={MENU_ICON} />
              <span className="grow">Rename workspace</span>
            </Menu.Item>
          )}
          <Menu.Item onClick={() => workspaceCopy.copy(window.location.href)}>
            <CopyCheck
              copied={workspaceCopy.copied}
              idle={<IconLink size={20} />}
              size={20}
              className={MENU_ICON}
            />
            <span className="grow">
              {workspaceCopy.copied ? "Copied" : "Share workspace"}
            </span>
          </Menu.Item>
          {isPhone && onNewSession && (
            <>
              <Menu.Separator />
              <Menu.Item onClick={() => onNewSession()}>
                <IconPlus size={20} className={MENU_ICON} />
                <span className="grow">New session in workspace</span>
              </Menu.Item>
            </>
          )}
          {!!archivedSessions?.length && onRestoreSession && (
            <Menu.SubmenuRoot>
              <Menu.SubmenuTrigger title="Closed sessions in this workspace">
                <IconHistory size={20} className={MENU_ICON} />
                <span className="grow">Archived sessions</span>
                <IconChevronRight size={16} className="text-faint" />
              </Menu.SubmenuTrigger>
              <Menu.Popup className="min-w-[240px] max-w-[320px]">
                <ArchivedSessionItems
                  sessions={archivedSessions}
                  onSelect={(session) => {
                    setOverflowOpen(false);
                    onOpenSession(session.id);
                  }}
                  onRestore={onRestoreSession}
                />
              </Menu.Popup>
            </Menu.SubmenuRoot>
          )}
          {(onArchiveWorkspace || onDeleteWorkspace) && <Menu.Separator />}
          {onArchiveWorkspace && workspaceSessions.length > 0 && (
            <Menu.Item onClick={onArchiveWorkspace}>
              <IconArchive size={20} className={MENU_ICON} />
              <span className="grow">Archive workspace</span>
            </Menu.Item>
          )}
          {onDeleteWorkspace && (
            <Menu.Item
              className="text-red data-[highlighted]:bg-red-soft data-[highlighted]:text-red"
              onClick={() =>
                confirm({
                  title: `Delete workspace "${workspace.name}"?`,
                  description: workspaceSessions.length
                    ? "All sessions in this workspace will be permanently deleted."
                    : undefined,
                  confirmLabel: "Delete",
                  destructive: true,
                  onConfirm: () => void onDeleteWorkspace(),
                })
              }
            >
              <IconTrash size={20} />
              <span className="grow">Delete workspace</span>
            </Menu.Item>
          )}
        </Menu.Popup>
      </div>
    </Menu.Root>
  );

  const showWorkspaceNewSessionAction =
    !tabStripVisible && onNewSession && !(tab === "review" && reviewTarget);
  const header = !isPhone && (
    <TopBar ref={headerRef} className={VIEWER_HEADER}>
      <TopBarLeading className={VIEWER_TITLE}>
        {workspace.repo && (
          <span className="flex min-w-0 shrink-0 items-center gap-[7px]">
            <RepoTile name={workspace.repo} />
            <span className="max-w-[180px] -translate-y-px truncate">
              {repoLabel(workspace.repo)}
            </span>
          </span>
        )}
        {workspace.repo && (
          <IconChevronRight
            size={18}
            className="-mx-1 shrink-0 text-faint"
            aria-hidden="true"
          />
        )}
        {renameDraft !== null ? (
          <input
            className={VIEWER_BRANCH_RENAME}
            value={renameDraft}
            autoFocus
            onChange={(event) => setRenameDraft(event.target.value)}
            onFocus={(event) => event.target.select()}
            onBlur={commitWorkspaceRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitWorkspaceRename();
              else if (event.key === "Escape") setRenameDraft(null);
              event.stopPropagation();
            }}
          />
        ) : (
          <OverflowFadeText
            className={cn(
              VIEWER_BRANCH,
              onRenameWorkspace && VIEWER_BRANCH_EDITABLE,
            )}
            title={
              onRenameWorkspace
                ? `${workspace.name} · double-click to rename`
                : workspace.name
            }
            onDoubleClick={
              onRenameWorkspace
                ? () => setRenameDraft(workspace.name)
                : undefined
            }
          >
            {workspace.name}
          </OverflowFadeText>
        )}
        <div className="-ml-1 flex flex-none items-center gap-0.5">
          {workspaceMenu}
          {tab === "review" && reviewTarget && (
            <div ref={setReviewSessionActionTarget} className="contents" />
          )}
          {showWorkspaceNewSessionAction && (
            <Tooltip label="New tab in this workspace">
              <Button
                variant="ghost"
                size="md"
                className="flex-none rounded-control"
                onClick={(event) => {
                  const reduceMotion = window.matchMedia(
                    "(prefers-reduced-motion: reduce)",
                  ).matches;
                  const rect =
                    event.detail > 0 && !reduceMotion
                      ? event.currentTarget.getBoundingClientRect()
                      : null;
                  onNewSession(
                    rect
                      ? {
                          left: rect.left,
                          top: rect.top,
                          width: rect.width,
                          height: rect.height,
                        }
                      : undefined,
                  );
                }}
                aria-label="New tab"
                icon={<IconPlus size={22} />}
              />
            </Tooltip>
          )}
        </div>
      </TopBarLeading>
      <TopBarActions ref={headerActionsRef} className={VIEWER_HEADER_ACTIONS}>
        {tab === "review" && presentationSession && !panelOpen && (
          <WorkspaceSummary
            session={presentationSession}
            anchor={headerActionsRef}
            onOpenPanelTab={() => setPanelOpen(true)}
            onOpenPr={() => {}}
            onOpenStackPr={onOpenPr}
            onOpenChecks={() => {}}
            onOpenSession={onOpenSession}
            send={connected && !presentationSession.archived ? send : undefined}
            onOpenChange={setReviewSummaryOpen}
            tabStripVisible={tabStripVisible}
            reviewMode
            hasRoom={reviewSummaryHasRoom}
          />
        )}
        <Tooltip label="Toggle side panel">
          <Button
            variant="ghost"
            size="md"
            className="rounded-control text-dim hover:bg-hover hover:text-fg"
            onClick={() => setPanelOpen(!panelOpen)}
            aria-label="Toggle side panel"
            icon={<IconSidebarRight size={22} />}
          />
        </Tooltip>
      </TopBarActions>
    </TopBar>
  );

  // Everything on this pane — the PR body, review comments, the info panel —
  // is about this workspace's repo, so a `#5528` written in any of it means a
  // PR there (markdown.ts). Both portals sit inside the provider: a React
  // portal moves the DOM node, not the context.
  const withPanel = (main: React.ReactNode) => (
    <MarkdownRepoProvider repo={workspace.repo}>
      {topbarEl && header ? createPortal(header, topbarEl) : null}
      {isPhone && headerActionsEl
        ? createPortal(workspaceMenu, headerActionsEl)
        : null}
      <div className="flex h-full min-h-0">
        <div className="flex-1 min-w-0 min-h-0">{main}</div>
      </div>
      {rightPanelEl && infoPanel ? createPortal(infoPanel, rightPanelEl) : null}
      {confirmDialog}
    </MarkdownRepoProvider>
  );

  if (tab === "review" && reviewTarget) {
    return withPanel(
      <div className={cn(VIEW_MAIN, "h-full min-h-0 bg-surface")}>
        <PrPanel
          onOpenPr={onOpenPr}
          key={`${reviewTarget.repo}:${reviewTarget.branch}`}
          sessionId={reviewSession?.id || ""}
          previewTarget={reviewSession ? undefined : reviewTarget}
          send={send}
          addHandler={addHandler}
          sessions={sessions}
          onStartSession={onNewSession ? () => onNewSession() : undefined}
          sessionActionTarget={isPhone ? undefined : reviewSessionActionTarget}
          onOpenSession={
            reviewSession ? () => onOpenSession(reviewSession.id) : undefined
          }
          walkthrough={presentationSession?.walkthrough}
          hideWideOverviewRail={Boolean(presentationSession)}
          page={reviewPage}
          onPageChange={setReviewPage}
          compactToolbar={reviewSummaryVisible}
          flushToolbarTop={!tabStripVisible}
        />
      </div>,
    );
  }

  if (tab === "conversation" && workspace.plainThreadId) {
    return withPanel(
      <div className={`${VIEW_MAIN} flex flex-col h-full min-h-0`}>
        <ConversationPane
          threadId={workspace.plainThreadId}
          onOpenSession={onOpenSession}
          hideTriage={workspaceSessions.length > 0}
        />
      </div>,
    );
  }

  // The feed web panel (a video embed, … — the feeds design) on the
  // session-less workspace route.
  const webRef = (workspace.externalRefs || []).find((r) => refWebPanel(r));
  const webPanel = webRef ? refWebPanel(webRef) : null;
  if (tab === "video" && webPanel) {
    return withPanel(
      <div className={`${VIEW_MAIN} flex flex-col h-full min-h-0`}>
        {webPanel.component === "slack-channel" ? (
          <SlackChannelPane channelId={webPanel.refId} />
        ) : (
          <FeedWebPane
            panel={webPanel}
            title={webRef?.title || workspace.name}
          />
        )}
      </div>,
    );
  }

  // Workspace home: normally only reachable session-less (with sessions, App lands
  // in the first session) — a composer that starts the workspace's first session.
  //
  // The canvas above the composer stays blank, the same way a fresh session's
  // transcript does. This IS a session — it has its own tab in the strip — so
  // it doesn't narrate that there are no sessions yet, and the header row and
  // info panel already say which workspace it belongs to.
  return withPanel(
    <div className={`${VIEW_MAIN} flex flex-col h-full min-h-0`}>
      {fileDragActive &&
        createPortal(
          <>
            <motion.div
              className="pointer-events-none fixed inset-0 z-[12000] flex flex-col items-center justify-center bg-[color-mix(in_srgb,var(--bg-panel)_68%,transparent)] px-6 text-center"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ type: "tween", duration: duration.base, ease }}
              aria-hidden="true"
              data-file-drop-overlay
            >
              <IconArrowUpToLine size={40} className="text-fg" />
              <div className="mt-4 text-title font-semibold text-fg">
                Add files
              </div>
              <div className="mt-1 text-label text-dim">
                Drop here to attach them to your message.
              </div>
            </motion.div>
            <span className="sr-only" role="status">
              Drop files to attach
            </span>
          </>,
          document.body,
        )}
      <div className="flex-1 min-h-0 overflow-y-auto" />
      <div className="w-full max-w-[760px] mx-auto px-5 pb-5 shrink-0">
        <Composer
          value={prompt}
          onChange={setPrompt}
          config={{
            placeholder: starting
              ? "Starting…"
              : "Start a session in this workspace…",
            disabled: starting,
            sendDisabled:
              starting ||
              !connected ||
              isStaging(staging) ||
              (!prompt.trim() && images.length === 0 && files.length === 0),
            sendTitle: "Start a session in this workspace (Enter)",
            models,
            defaultModel,
            model,
            modelTitle: "Model for this session",
            images,
            files,
            staging,
          }}
          actions={{
            onSend: handleStart,
            onModelChange: setModel,
            onImagesChange: setImages,
            onFilesChange: setFiles,
            onAddAttachments: addWorkspaceAttachments,
            onRemovePendingImage: uploads.cancelPendingImage,
            onRemovePendingFile: uploads.cancelPendingFile,
          }}
        />
        {startError && (
          <InlineAlert className="mt-2.5">{startError}</InlineAlert>
        )}
      </div>
    </div>,
  );
}
