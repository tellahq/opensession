import React, {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  fetchWorktrees,
  fetchModels,
  fetchToolAccounts,
  fetchSandboxStatus,
  requestSandboxPrewarm,
  suggestBranch,
  configuredNewSessionRepo,
  fetchProviderAccounts,
  fetchRepos,
  cachedRepos,
  type RepoInfo,
  createWorkspaceApi,
  updateWorkspaceApi,
  deleteWorkspaceApi,
  ApiError,
  type ProviderAccountOption,
  type ModelOption,
  type SandboxStatusInfo,
} from "../lib/api";
import { getCurrentUser } from "./UserPicker";
import { type FileAttachment } from "../lib/images";
import {
  createPastedTextAttachment,
  type PastedTextAttachment,
} from "../lib/pasted-text";
import {
  loadDraft,
  saveDraft,
  clearDraft,
  onDraftsChanged,
  NEW_SESSION_DRAFT_KEY as DRAFT_KEY,
  workspaceDraftKey,
} from "../lib/drafts";
import {
  attachToDraft,
  dropStagingAttachments,
  isStaging,
  removeDraftFile,
  removeDraftImage,
  sameFiles,
  sameImages,
} from "../lib/attachments";
import { useAttachmentUploads } from "../hooks/useAttachmentUploads";
import { resolveNewSessionModel } from "../lib/default-model-pref";
import { projectComposerSessions } from "../lib/composer-session-projection";
import { baseModelId, modelEngine } from "./ModelEffortSelect";
import { getSendKeyPref, onSendKeyChanged } from "../lib/send-key-pref";
import { effectiveSendKey, MOD_ENTER_GLYPH } from "../lib/send-key";
import { NO_REPO } from "../lib/session-repo";
import {
  getSessionCheckoutPrefs,
  onSessionCheckoutPrefChanged,
  resolveSessionCheckoutPref,
} from "../lib/session-checkout-pref";
import { repoSelectionHint, toggleRepoSelection } from "../lib/repo-selection";
import { fallbackBranchName } from "../lib/workspace-draft";
import { newSessionDefaultRepo } from "../lib/new-session-repo";
import { NewSessionPrompt } from "./NewSessionPrompt";
import type { NewSessionPromptHandle } from "../lib/new-session-prompt-types";
import { ComposerContextChip } from "./ComposerContextChip";
import {
  IconPaperclip,
  IconArrowUp,
  IconChevronDown,
  IconChevronRight,
  IconConnections,
  IconDotsHorizontal,
  IconEye,
  IconReturn,
  IconBox,
  IconMessage,
  IconNewBranch,
  IconX,
} from "./icons";
import type { WSClientMessage, WSServerMessage } from "../lib/types";
import { findPrWorkspaceId } from "../lib/pr-workspace";
import { newClientSessionId } from "../lib/session-id";
import { errorMatchesPendingCreate } from "../lib/new-session-navigation";
import {
  consumeNewSessionWorkspaceDraft,
  forgetParkedNewSessionWorkspace,
  getParkedNewSessionWorkspaceId,
  rememberParkedNewSessionWorkspace,
} from "../lib/new-session-workspace-draft";
import { VoiceInput } from "./VoiceInput";
import { useIsPhone } from "../hooks/useIsPhone";
import { handOffSoftKeyboard } from "../lib/soft-keyboard";
import { PaletteSelect } from "./PaletteSelect";
import { RepoTile } from "./RepoTile";
import { ModelEffortSelect } from "./ModelEffortSelect";
import { Menu } from "../ui/menu";
import { displayName } from "../brand-logos";
import { IconTile } from "./BrandTile";
import { Tooltip } from "../ui/tooltip";
import { Modal, useEnterOnMount } from "../ui/modal";
import { composerMorph } from "../ui/motion";
import { useShortcutKeys } from "../hooks/useShortcutBindings";
import { matchesShortcut } from "../lib/shortcuts";
import { foregroundFileComposerOwns, hasDraggedFiles } from "../lib/file-drag";
import { FullPageFileDropOverlay } from "./FullPageFileDropOverlay";
import { NewSessionPrPicker } from "./NewSessionPrPicker";
import { askSurface } from "../lib/tinted-surface";
import { toast } from "../ui/toast";
import { cn } from "../ui/cn";
import { PhoneTopBar, PhoneTopBarAction } from "../ui/top-bar";
import { paletteIconBtnOn } from "../lib/palette-classes";
import {
  ASK_BTN_ON,
  ASK_SURFACE,
  CHEVRON,
  CREATE_ACTIONS,
  CREATE_CARET,
  CREATE_KBD,
  CREATE_LABELS,
  CREATE_MAIN,
  CREATE_MAIN_SPLIT,
  CREATE_MAIN_WHOLE,
  CREATE_MENU,
  CREATE_MENU_ITEM,
  CREATE_SPLIT,
  CYCLE_SHORTCUT,
  EDGE_DIVIDER,
  ERROR,
  FOOTER,
  FOOTER_ICON_BTN,
  FOOTER_LEFT,
  FOOTER_RIGHT,
  HEADER,
  INLINE_CARD,
  MOBILE_PICKER,
  MOBILE_TRIGGER,
  MODEL_PILL,
  MULTI_MODIFIER,
  PHONE_SEND,
  TRIGGER_STRONG,
  type CreateAction,
  type CreateStatus,
} from "../lib/new-session-classes";
import {
  consumePendingDraftParks,
  draftParkInFlight,
  firstNonEmptyLine,
  migratedRepoPref,
  pendingDraftParks,
  readPrefill,
  type NewSessionCreateDraft,
  type NewSessionProps,
  type PendingDraftPark,
  type RepoOption,
  type SessionStartPoint,
  type Worktree,
} from "../lib/new-session-state";

export type { NewSessionCreateDraft } from "../lib/new-session-state";

type NewSessionCreateMessage = Extract<
  WSClientMessage,
  { type: "create_session" }
> & {
  attachRepos?: string[];
  modelWorkspaceId?: string;
};

interface AskSurfaceStyle extends React.CSSProperties {
  "--palette-ask-bg": string;
}

export function NewSession({
  onBack,
  inline,
  focusSeq,
  send,
  addHandler,
  connected,
  prefillPrompt,
  initialMcpServers,
  forceMode,
  workspaceId,
  modelWorkspaceId,
  forceRepo,
  forceBranch,
  workspaces,
  sessions,
  onCreateStarted,
}: NewSessionProps) {
  const [prefill] = useState(readPrefill);
  // What the session may do, and nothing else — the footer's Ask toggle. The
  // repo is a separate axis, so Scratch is not a third value here: it is what
  // Code with no repo already is (same write access, same repo-less scratch
  // dir), and `mode` below derives it rather than asking anyone to pick it.
  const [permissionState, setPermissionState] = useState<"ask" | "code">(
    (forceMode || prefill.mode) === "ask" ? "ask" : "code",
  );
  const permission = forceMode === "ask" ? "ask" : permissionState;
  // In a workspace, default to its shared repo; else the prefill/filter repo.
  // `forceMode: "scratch"` (a feed workspace) is a repo-less create, so it
  // arrives here as the repo rather than as a mode.
  const [repo, setRepo] = useState(
    forceMode === "scratch" ? NO_REPO : forceRepo || prefill.repo,
  );
  // Exactly one start point owns the branch semantics. A PR is not merely an
  // existing worktree: it must send `fromPr` so the server checks out the
  // existing head branch rather than trying to create it again.
  const defaultStartPoint = (): SessionStartPoint =>
    forceBranch ? { kind: "worktree", branch: forceBranch } : { kind: "new" };
  const [startPoint, setStartPoint] =
    useState<SessionStartPoint>(defaultStartPoint);
  const selectedPullRequest =
    startPoint.kind === "pull-request" ? startPoint.pullRequest : null;
  /**
   * Repos the session works in BESIDES `repo`, in the order they were added
   * (the picker's ⌘-click). Each becomes an attached worktree on the session's
   * branch, so the agent can read and edit across them from its first turn.
   * Only a Code session with a repo can carry them — see `canAddRepos`.
   */
  const [extraRepos, setExtraRepos] = useState<string[]>([]);
  /**
   * Flipping Ask moves the repo with it: Ask means "no repo" unless you go and
   * pick one, and Code goes back to the repo you were last working in. Most
   * asking is not about a checkout, and the pair that stayed pointed at a repo
   * you had chosen for a code session read as Ask silently inheriting it.
   *
   * A palette scoped to a workspace (`forceRepo`) is exempt: there the repo is
   * the whole point of the create, so Ask stays on it.
   */
  function togglePermission() {
    const next = permission === "ask" ? "code" : "ask";
    setPermissionState(next);
    // An Ask session reads one pinned checkout and cuts no worktree, so it has
    // nowhere to put a second repo. Drop them on the way in rather than
    // carrying a selection the create would have to refuse.
    if (next === "ask") setExtraRepos([]);
    if (forceRepo || startPoint.kind === "pull-request") return;
    if (next === "ask") setRepo(NO_REPO);
    else if (repo === NO_REPO)
      setRepo(migratedRepoPref() || configuredDefaultRepo || NO_REPO);
  }

  // The three modes the server stores, from the two axes above. Ask reads (a
  // repo, or nothing); Code writes, on a branch when it has a repo and in a
  // plain scratch dir when it doesn't.
  const mode: "ask" | "code" | "scratch" =
    permission === "ask" ? "ask" : repo === NO_REPO ? "scratch" : "code";
  const [checkoutPrefs, setCheckoutPrefs] = useState(getSessionCheckoutPrefs);
  useEffect(
    () =>
      onSessionCheckoutPrefChanged(() =>
        setCheckoutPrefs(getSessionCheckoutPrefs()),
      ),
    [],
  );
  const checkoutPref = resolveSessionCheckoutPref(checkoutPrefs, repo);
  const repoOptions = (items: RepoInfo[]): RepoOption[] =>
    items.map((item) => ({
      id: item.id,
      label: item.label || item.id,
      default: item.default,
      sharedCheckout: item.sharedCheckout,
    }));
  // The workspace's configured choice is what a user with no preference of
  // their own starts on; the repo flagged `default` is the fallback behind it.
  // With no registered repos, start in Scratch instead.
  const resolveDefaultRepo = (options: RepoOption[]): string =>
    newSessionDefaultRepo(options, configuredNewSessionRepo());
  // Seeded from the repos this browser saw last (lib/repo-cache) so the picker
  // opens on the real list, and the palette settles on the right default,
  // without waiting for /repos. The fetch below still runs and corrects both.
  const [repos, setRepos] = useState<RepoOption[]>(() =>
    repoOptions(cachedRepos()),
  );
  const [configuredDefaultRepo, setConfiguredDefaultRepo] = useState(() => {
    const seeded = repoOptions(cachedRepos());
    return seeded.length ? resolveDefaultRepo(seeded) : "";
  });
  const startsInLocalCheckout =
    mode === "code" &&
    startPoint.kind === "new" &&
    (checkoutPref === "checkout" ||
      (checkoutPref === "default" &&
        !!repos.find((option) => option.id === repo)?.sharedCheckout));
  // A second repo is an isolated worktree on this session's branch. Ask,
  // Scratch, pull-request starts, and local-checkout sessions cannot carry one.
  const canAddRepos =
    mode === "code" &&
    startPoint.kind !== "pull-request" &&
    !startsInLocalCheckout;
  useEffect(() => {
    let live = true;
    fetchRepos()
      .then((items) => {
        if (!live) return;
        const options = repoOptions(items);
        setRepos(options);
        setConfiguredDefaultRepo(resolveDefaultRepo(options));
      })
      .catch(() => {
        // A failed refresh keeps the cached rows rather than emptying the picker.
        if (!live) return;
        setRepos((current) => current);
      });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    setRepo((current) => {
      // "No repo" is a real choice, not an unresolved id — without this it
      // fails the `repos.some(...)` membership test below and gets replaced by
      // the configured default the moment /repos lands.
      if (forceRepo === NO_REPO || current === NO_REPO) return current;
      if (forceRepo && repos.some((item) => item.id === forceRepo))
        return forceRepo;
      if (repos.some((item) => item.id === current)) return current;
      return configuredDefaultRepo;
    });
  }, [configuredDefaultRepo, forceRepo, repos]);

  /** A repo's picker label, falling back to its id before `/repos` lands. */
  const repoOptionLabel = (id: string) =>
    repos.find((item) => item.id === id)?.label || id;
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [newBranch, setNewBranch] = useState(prefill.branch);
  // An explicit prefill (Home hand-off, deep link) wins; otherwise restore the
  // stored draft so closing the palette / navigating away doesn't lose a
  // half-written task. A default create clears it as soon as the send is
  // accepted; App restores the submitted copy if creation fails.
  //
  // The draft itself belongs to NewSessionPrompt rather than to this component,
  // because typing must not re-render the palette around it. What stays here is
  // only what the palette reads: the current text in a ref, for the moment a
  // create is submitted; whether there is any text, which is the Create
  // button's gate; and the text once typing stops, which is what the branch
  // name is suggested from.
  const [initialPrompt] = useState(
    () => prefillPrompt || prefill.prompt || loadDraft(DRAFT_KEY).text,
  );
  const promptText = useRef(initialPrompt);
  const promptHandle = useRef<NewSessionPromptHandle | null>(null);
  const [hasPromptText, setHasPromptText] = useState(() =>
    /\S/.test(initialPrompt),
  );
  const [settledPrompt, setSettledPrompt] = useState(initialPrompt);
  const [mentionOpen, setMentionOpen] = useState(false);
  // Whether the user has hand-edited the branch field. Once true we stop
  // auto-suggesting so we never clobber what they typed. A prefilled branch
  // (deep link) counts as already-owned.
  const [branchEdited, setBranchEdited] = useState(!!prefill.branch);
  // Attachments live in the draft store, and this is its mirror. Staging a
  // file outlives the palette (lib/attachments.ts), so the store is what an
  // upload writes to and what a reopened palette reads back; keeping a second
  // copy authoritative here is what used to lose a screenshot pasted just
  // before the card closed.
  const [images, setImages] = useState<string[]>(
    () => loadDraft(DRAFT_KEY).images,
  );
  const [files, setFiles] = useState<FileAttachment[]>(
    () => loadDraft(DRAFT_KEY).files,
  );
  // Large pastes, held as chips beside the field and sent as `pastedTexts`.
  // Same home as the other attachments: the draft store, mirrored here.
  const [pastedTexts, setPastedTexts] = useState<PastedTextAttachment[]>(
    () => loadDraft(DRAFT_KEY).pastedTexts,
  );
  const uploads = useAttachmentUploads();
  const staging = uploads.staging;
  const [fileDragActive, setFileDragActive] = useState(false);
  const fileDragWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  // Stable identity: module loader + setters only.
  const adoptDraftAttachments = useCallback(() => {
    const stored = loadDraft(DRAFT_KEY);
    setImages((prev) =>
      sameImages(prev, stored.images) ? prev : stored.images,
    );
    setFiles((prev) => (sameFiles(prev, stored.files) ? prev : stored.files));
    setPastedTexts((prev) =>
      prev.length === stored.pastedTexts.length &&
      prev.every((item, i) => item.id === stored.pastedTexts[i]?.id)
        ? prev
        : stored.pastedTexts,
    );
  }, []);
  // An upload that lands while this palette is open belongs on screen even
  // though it was staged by the instance that closed: the store fires on an
  // attachment change for exactly this.
  useEffect(
    () => onDraftsChanged(adoptDraftAttachments),
    [adoptDraftAttachments],
  );
  const [status, setStatus] = useState<CreateStatus>({ kind: "idle" });
  const busy = status.kind === "creating" || status.kind === "reconnecting";
  // Which edges of the prompt have content beyond them, and so earn a hairline.
  const [edges, setEdges] = useState({ top: false, bottom: false });
  const [models, setModels] = useState<ModelOption[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [model, setModel] = useState(""); // "" = default
  // The shared model settings menu carries the same choices as an existing
  // session's composer. Both values persist on the new session and apply to
  // its opening turn.
  const [effort, setKnownEffort] =
    useState<NonNullable<NewSessionCreateMessage["effort"]>>("high");
  function setEffort(nextEffort: string) {
    switch (nextEffort) {
      case "none":
      case "low":
      case "medium":
      case "high":
      case "xhigh":
      case "max":
        setKnownEffort(nextEffort);
    }
  }
  const [fastMode, setFastMode] = useState(false);
  // Pinned provider account for the new session ("" = auto pool pick).
  // Soft pin: the runner prefers it and falls back on exhaustion. Only
  // meaningful for Anthropic/OpenAI subscription-backed models.
  const [accountId, setAccountId] = useState("");
  const [accounts, setAccounts] = useState<ProviderAccountOption[]>([]);
  useEffect(() => {
    fetchProviderAccounts()
      .then(setAccounts)
      .catch(() => {});
  }, []);
  const effectiveNewModel = model || defaultModel;
  const accountProvider = models.find(
    (item) => item.id === baseModelId(effectiveNewModel),
  )?.accountProvider;
  // A pin belongs to one provider pool. Drop it when the selected model moves
  // to another family so an opaque id is never reinterpreted.
  useEffect(() => {
    const account = accounts.find((item) => item.id === accountId);
    if (accountId && account?.provider !== accountProvider) setAccountId("");
  }, [accountProvider, accountId, accounts]);
  // What a create does with the view behind the palette. Chosen from the
  // Create split-button's dropdown; the primary button reflects the choice.
  const [chosenCreateAction, setCreateAction] = useState<CreateAction>("open");
  // Inline there is no view behind the card: "background" would leave you on an
  // empty page and "more" is what the card already does, so a create opens the
  // session it just made. The caret that picks between them is hidden too.
  const createAction: CreateAction = inline ? "open" : chosenCreateAction;
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const createSplitRef = useRef<HTMLDivElement>(null);
  const isPhone = useIsPhone();
  /** The palette as a phone sheet: close and send ride in the top bar, and the
   *  footer keeps only the tools. The inline card has no bar of its own to put
   *  them in, so it keeps the footer's Create at every width. */
  const phoneBar = isPhone && !inline;
  // "Send messages with" (Settings → Preferences). The session composer honors it,
  // so this field has to as well — otherwise Enter silently does nothing here
  // while the Create button advertises ↩.
  // Resolved per client: a soft keyboard keeps ↩ for newlines (effectiveSendKey).
  const [storedSendKey, setStoredSendKey] = useState(getSendKeyPref);
  useEffect(
    () => onSendKeyChanged(() => setStoredSendKey(getSendKeyPref())),
    [],
  );
  const sendKey = effectiveSendKey(storedSendKey);
  const attachKeys = useShortcutKeys("composer-attach");

  // Sandbox provider picker: the complete model engine + workspace run in the
  // selected environment; native Codex is the sole host-only family.
  // "" = This machine (host, no sandbox); otherwise an explicit provider id
  // sent as the create's `sandbox` string. Options come from
  // /api/sandbox/status (fetched once when the palette opens) — only
  // configured providers are offered, and the whole control hides when the
  // server has no sandbox config or the kill switch is on.
  const [sandboxProvider, setSandboxProvider] = useState("");
  const [sandboxStatus, setSandboxStatus] = useState<SandboxStatusInfo | null>(
    null,
  );
  const sandboxSelectionTouched = useRef(false);
  useEffect(() => {
    fetchSandboxStatus(getCurrentUser())
      .then((status) => {
        setSandboxStatus(status);
        // This machine remains the clear default. Sandbox configuration belongs
        // behind the explicit Sandbox choice, never in an invisible default.
        if (!sandboxSelectionTouched.current) setSandboxProvider("");
      })
      .catch(() => {});
  }, []);
  const sandboxChoices = sandboxStatus?.connections?.length
    ? sandboxStatus.connections
        .filter((connection) => connection.state === "ready")
        .map((connection) => ({
          id: connection.provider,
          note: undefined,
        }))
    : (sandboxStatus?.providers || []).filter(
        (p) => p.configured && p.certified,
      );
  const selectedSandboxAvailable =
    !sandboxProvider ||
    sandboxChoices.some((choice) => choice.id === sandboxProvider);
  const visibleSandboxChoices =
    sandboxProvider && !selectedSandboxAvailable
      ? [
          {
            id: sandboxProvider,
            note: "Unavailable. Choose This machine or a ready Sandbox before creating.",
          },
          ...sandboxChoices,
        ]
      : sandboxChoices;
  const showSandboxPicker = !!sandboxStatus;
  const sandboxLabel = (id: string) =>
    id === ""
      ? "This machine"
      : id === "docker"
        ? "Docker"
        : id === "daytona"
          ? "Daytona"
          : id === "e2b"
            ? "E2B"
            : id === "box"
              ? "Box"
              : id === "modal"
                ? "Modal"
                : id === "lambda-microvm"
                  ? "AWS Lambda MicroVM"
                  : id;

  // Provider-independent family check, driven by the same server list the
  // create path enforces.
  const effectiveModelId = model || defaultModel;
  const effectiveModelProvider = effectiveModelId.startsWith("pi/")
    ? "pi"
    : (models.find((m) => m.id === effectiveModelId)?.provider ?? "claude");
  const modelFamily = (sandboxStatus?.modelFamilies || []).find(
    (f) => f.match.provider === effectiveModelProvider,
  );
  const sandboxModelWarning = (() => {
    if (sandboxProvider && !selectedSandboxAvailable) {
      return `${sandboxLabel(sandboxProvider)} is unavailable. Choose This machine or a ready Sandbox.`;
    }
    if (!sandboxProvider || !modelFamily) return null;
    if (modelFamily.sandboxable) return null;
    return (
      `${modelFamily.label} models can't run in a Sandbox` +
      (modelFamily.hint ? ` · ${modelFamily.hint}` : "") +
      "."
    );
  })();

  // Brain-inside remote/MicroVM sessions all adopt a full-runner prewarm.
  // Strictly fire-and-forget: failure must never surface or block typing.
  const isRemoteSandbox =
    sandboxProvider === "daytona" ||
    sandboxProvider === "e2b" ||
    sandboxProvider === "box" ||
    sandboxProvider === "modal" ||
    sandboxProvider === "lambda-microvm";
  const shouldPrewarm = isRemoteSandbox;
  const [sandboxWarmed, setSandboxWarmed] = useState(false);
  const lastPrewarmAtRef = useRef(0);
  useEffect(() => {
    // Provider/repo switch: allow an immediate re-fire for the new key.
    lastPrewarmAtRef.current = 0;
    setSandboxWarmed(false);
  }, [sandboxProvider, repo]);
  useEffect(() => {
    // Whether the prompt has anything in it, not what it says: the throttle
    // below means only the first character of a draft ever fires this.
    if (!shouldPrewarm || !hasPromptText || busy) return;
    if (Date.now() - lastPrewarmAtRef.current < 60_000) return;
    lastPrewarmAtRef.current = Date.now();
    requestSandboxPrewarm(sandboxProvider, repo, getCurrentUser())
      .then((r) => setSandboxWarmed(r.state === "ready"))
      .catch(() => {});
  }, [hasPromptText, shouldPrewarm, sandboxProvider, repo, busy]);

  // An empty selection means every available service; one or more picks narrow
  // the session to those services. Command-menu shortcuts seed this same state
  // so their selection stays visible and removable before Create.
  const [selectedMcpServers, setSelectedMcpServers] = useState<string[]>(
    () => initialMcpServers || [],
  );
  const [availableMcpServers, setAvailableMcpServers] = useState<string[]>([]);
  useEffect(() => {
    fetchToolAccounts()
      .then((c) => {
        setAvailableMcpServers(c.servers.map((s) => s.name));
      })
      .catch(() => {});
  }, []);
  function toggleMcpServer(name: string, on: boolean) {
    setSelectedMcpServers((prev) =>
      on ? [...prev, name] : prev.filter((m) => m !== name),
    );
  }

  const promptRef = useRef<HTMLTextAreaElement>(null);
  const voiceOverlayRef = useRef<HTMLDivElement>(null);
  const [dictating, setDictating] = useState(false);
  const [dictationClipping, setDictationClipping] = useState(false);
  function handleDictationActive(active: boolean) {
    setDictating(active);
    if (active) setDictationClipping(true);
  }
  // Hidden <input type="file"> driven by the "Add file" button — the mobile
  // path, since there's no clipboard paste there.
  const fileInputRef = useRef<HTMLInputElement>(null);

  // (The prompt is focused on open by Modal.Content's initialFocus — a mount
  // effect here would run a frame before the dialog's popup exists.)
  //
  // Inline there is no dialog to do it, and the children mount in the same
  // commit, so an ordinary effect is enough. On a phone this raises the
  // keyboard right away, so starting a session is one tap and then typing.
  useEffect(() => {
    if (!inline) return;
    promptRef.current?.focus();
  }, [inline, focusSeq]);

  // On a phone the dialog's own initialFocus lands a frame after the tap that
  // opened it, which is too late for iOS to raise the keyboard. The tap parked
  // the keyboard on a stand-in field (lib/soft-keyboard); take it over here,
  // as soon as the real prompt exists.
  useEffect(() => {
    if (inline) return;
    handOffSoftKeyboard(() => promptRef.current);
  }, [inline]);

  // (The prompt's auto-grow, its scroll-fade and the draft store it writes
  // through all live in NewSessionPrompt now, beside the text they read.)

  // Close the Create dropdown on an outside click.
  useEffect(() => {
    if (!createMenuOpen) return;
    function onDown(e: MouseEvent) {
      if (
        createSplitRef.current &&
        e.target instanceof Node &&
        !createSplitRef.current.contains(e.target)
      ) {
        setCreateMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [createMenuOpen]);

  // Step through the Create options without leaving the prompt: the primary
  // button's label is the feedback, and an open dropdown moves its check. This
  // rides on the dialog rather than on window because Base UI's
  // popup stops keydown propagation before it leaves the card, which is also
  // why it can use a chord the rest of the app is free to bind elsewhere.
  function cycleCreateAction(e: React.KeyboardEvent) {
    if (busy) return;
    if (!(e.metaKey || e.ctrlKey) || !e.altKey || e.shiftKey) return;
    const step = e.code === "ArrowDown" ? 1 : e.code === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const at = CREATE_ACTIONS.indexOf(createAction);
    setCreateAction(
      CREATE_ACTIONS[
        (at + step + CREATE_ACTIONS.length) % CREATE_ACTIONS.length
      ],
    );
  }

  function handleCardKeyDown(e: React.KeyboardEvent) {
    if (!busy && matchesShortcut(e, "composer-attach")) {
      e.preventDefault();
      fileInputRef.current?.click();
      return;
    }
    cycleCreateAction(e);
  }

  useEffect(() => {
    fetchModels(modelWorkspaceId || workspaceId)
      .then(async (m) => {
        setModels(m.models);
        setDefaultModel(m.default);
        // Untouched picker: start on this person's own default model and
        // engine (Settings → Preferences); "" is no preference, which keeps
        // the workspace default.
        const preselect = await resolveNewSessionModel(m);
        setModel((current) => {
          if (current) {
            // Pi-routed ids validate against their base entry (the pi/ prefix
            // is routing, not a listed model).
            return m.models.some((item) => item.id === baseModelId(current))
              ? current
              : "";
          }
          return preselect;
        });
      })
      .catch(() => {});
  }, [modelWorkspaceId, workspaceId]);

  // Worktrees are per-repo; refetch and reset the selection when it changes.
  // Inside a workspace, snap back to the shared sibling branch, not "New branch".
  //
  // The `live` guard is what keeps a fetch from outliving the repo it was for:
  // switching to Auto before it lands used to clear the list and then have the
  // old repo's branches arrive on top of the empty one, which now decides
  // whether the branch row exists at all — the menu offered branches from a
  // repo the session was no longer pointed at.
  useEffect(() => {
    let live = true;
    setStartPoint((current) =>
      current.kind === "pull-request" && current.pullRequest.repo === repo
        ? current
        : forceBranch
          ? { kind: "worktree", branch: forceBranch }
          : { kind: "new" },
    );
    if (!repo || repo === NO_REPO) {
      setWorktrees([]);
      return;
    }
    fetchWorktrees(repo)
      .then((items) => {
        if (live) setWorktrees(items);
      })
      .catch(() => {
        if (live) setWorktrees([]);
      });
    return () => {
      live = false;
    };
  }, [repo, forceBranch]);

  // Auto-suggest a branch name from the prompt (a Haiku call, once typing has
  // stopped), but only while the field is "ours" — once the user types in it
  // (branchEdited) we back off. The latest-request guard drops a stale response
  // if the user starts editing the branch while a suggestion is in flight.
  //
  // The wait for typing to stop is the prompt field's, not this component's:
  // this is the one thing here that reads what the draft SAYS, so it is handed
  // the text once it has held still rather than on every character.
  const branchEditedRef = useRef(branchEdited);
  useLayoutEffect(() => {
    branchEditedRef.current = branchEdited;
  }, [branchEdited]);
  const suggestSeqRef = useRef(0);
  useEffect(() => {
    if (mode !== "code" || startPoint.kind !== "new" || branchEdited) return;
    if (settledPrompt.trim().length < 10) return;
    suggestSeqRef.current += 1;
    const seq = suggestSeqRef.current;
    void (async () => {
      const branch = await suggestBranch(settledPrompt.trim());
      // Drop if superseded by a newer prompt or the user grabbed the field.
      if (seq !== suggestSeqRef.current || branchEditedRef.current) return;
      if (branch) setNewBranch(branch);
    })();
  }, [settledPrompt, mode, startPoint.kind, branchEdited]);

  // Registered from mount and gated on a ref set synchronously in handleCreate:
  // session_created is announced before the worktree even boots, so it can
  // arrive before a creating-gated effect would have registered this handler.
  const creatingRef = useRef(false);
  const createSessionIdRef = useRef<string | null>(null);
  const createMessageRef = useRef<WSClientMessage | null>(null);
  const createWorkspaceIdRef = useRef<string | null>(null);
  const replayCreateRef = useRef(false);
  // A successful create replaces the surface behind this dialog. Returning
  // focus to the now-removed opener makes Base UI advance to the new session's
  // "+" button, so Enter immediately creates another session. Cancelling still
  // restores focus normally.
  const createdRef = useRef(false);
  const handleCreationMessage = useEffectEvent((msg: WSServerMessage) => {
    if (!creatingRef.current) return;
    if (
      msg.type === "error" &&
      errorMatchesPendingCreate(msg.sessionId, createSessionIdRef.current)
    ) {
      creatingRef.current = false;
      createSessionIdRef.current = null;
      createMessageRef.current = null;
      createWorkspaceIdRef.current = null;
      replayCreateRef.current = false;
      setStatus({ kind: "failed", message: msg.message });
    } else if (
      msg.type === "session_created" &&
      msg.id === createSessionIdRef.current
    ) {
      creatingRef.current = false;
      createSessionIdRef.current = null;
      createMessageRef.current = null;
      const consumedWorkspaceId = createWorkspaceIdRef.current;
      createWorkspaceIdRef.current = null;
      replayCreateRef.current = false;
      // The prompt was consumed. Drop both copies and their pending writes: the
      // global composer copy, plus the workspace copy made when it was closed.
      promptHandle.current?.dropPendingDraftWrite();
      dropStagingAttachments(DRAFT_KEY);
      clearDraft(DRAFT_KEY);
      if (consumedWorkspaceId)
        consumeNewSessionWorkspaceDraft(consumedWorkspaceId);
      // "Create more" stays in the palette and resets for the next task. The
      // other actions close it after App handles the same announcement.
      if (createAction === "more" || inline) {
        setStatus({ kind: "idle" });
        promptHandle.current?.setText("");
        setImages([]);
        setFiles([]);
        setPastedTexts([]);
        setNewBranch("");
        setBranchEdited(false);
        promptRef.current?.focus();
      } else {
        createdRef.current = createAction === "open";
        onBack();
      }
    }
  });
  useEffect(() => {
    return addHandler((msg) => handleCreationMessage(msg));
  }, [addHandler]);

  // Re-send the same client-minted id after a drop. The server deduplicates an
  // in-flight request and returns the existing session if it already persisted.
  useEffect(() => {
    if (!creatingRef.current) return;
    if (!connected) {
      replayCreateRef.current = true;
      setStatus({ kind: "reconnecting" });
      return;
    }
    if (!replayCreateRef.current || !createMessageRef.current) return;
    replayCreateRef.current = false;
    setStatus({ kind: "creating" });
    send(createMessageRef.current);
  }, [connected, send]);

  async function addAttachments(picked: FileList | File[]) {
    // The staging commits to the draft store itself, so a screenshot pasted
    // while the app is still loading survives this palette closing before
    // its upload lands. Adopt the store rather than the result: it is the
    // one place that has both these files and anything else that arrived.
    const results = await uploads.upload(picked, (file, signal) =>
      attachToDraft(DRAFT_KEY, [file], signal),
    );
    adoptDraftAttachments();
    const rejected = results.flatMap((result) => result.rejected);
    if (rejected.length) alert(`Couldn't attach:\n${rejected.join("\n")}`);
  }

  const addDroppedAttachments = useEffectEvent((picked: FileList | File[]) => {
    void addAttachments(picked);
  });

  // Leaving the palette with an unsent prompt saves it, rather than asking you
  // to say so in advance. The text is parked on a workspace (a fresh one, or
  // the one this palette is scoped to) and shows up in the sidebar as a draft.
  // Nothing runs. This never sends create_session, so it is separate from
  // handleCreate's session_created wait below.
  //
  // The local composer draft is never cleared by leaving: reopening the
  // palette shows exactly what you typed, and the parked workspace draft is a
  // copy, not a move. Staged attachments are copied onto the workspace's own
  // composer, so the draft you find in the sidebar has its files too.
  const parkingDraftRef = useRef(false);
  async function parkDraftOnExit() {
    const text = promptText.current.trim();
    if (
      !text ||
      busy ||
      parkingDraftRef.current ||
      draftParkInFlight(text, workspaceId)
    )
      return;
    parkingDraftRef.current = true;
    const operation: PendingDraftPark = { text, workspaceId, consumed: false };
    pendingDraftParks.add(operation);
    const draft = {
      text,
      updatedAt: new Date().toISOString(),
      by: getCurrentUser(),
    };
    await (async () => {
      const createWorkspace = () => {
        const input: Parameters<typeof createWorkspaceApi>[0] = {
          name: firstNonEmptyLine(text).slice(0, 80) || "Draft",
          draft: { ...draft, autoName: true },
        };
        if (repo && repo !== NO_REPO) input.repo = repo;
        return createWorkspaceApi(input);
      };
      const parkedId = getParkedNewSessionWorkspaceId();
      const workspace = workspaceId
        ? // Scoped to an existing workspace: update its draft, never rename it.
          await updateWorkspaceApi(workspaceId, { draft })
        : parkedId
          ? // Re-parking the draft this palette already saved. The name still
            // follows the text server-side while autoName holds. Only a
            // workspace that is gone earns a fresh one; any other failure is
            // reported rather than answered with a duplicate.
            await updateWorkspaceApi(parkedId, {
              draft: { ...draft, autoName: true },
            }).catch((e) => {
              if (e instanceof ApiError && e.status === 404) {
                forgetParkedNewSessionWorkspace(parkedId);
                return createWorkspace();
              }
              throw e;
            })
          : await createWorkspace();
      if (operation.consumed) {
        // The same prompt started while this request was in flight. A create
        // that adopted this workspace only needs its late draft cleared. When
        // it created elsewhere, remove the now-empty duplicate workspace.
        if (workspaceId || operation.consumedIntoWorkspaceId === workspace.id) {
          await updateWorkspaceApi(workspace.id, { draft: null });
        } else {
          forgetParkedNewSessionWorkspace(workspace.id);
          await deleteWorkspaceApi(workspace.id);
        }
      } else {
        if (!workspaceId) rememberParkedNewSessionWorkspace(workspace.id);
        // Attachments live in this browser's draft store, not on the server
        // record, so hand them to the workspace composer directly.
        const staged = loadDraft(DRAFT_KEY);
        saveDraft(workspaceDraftKey(workspace.id), {
          text,
          images: staged.images,
          files: staged.files,
          pastedTexts: staged.pastedTexts,
        });
      }
      window.dispatchEvent(new Event("opensession:workspaces-changed"));
    })()
      .catch(async (e) => {
        if (!operation.consumed) {
          toast(
            e instanceof ApiError
              ? `Couldn't save the draft: ${e.message}`
              : "Couldn't save the draft. It is still in the composer.",
          );
        }
      })
      .finally(async () => {
        pendingDraftParks.delete(operation);
        parkingDraftRef.current = false;
      });
  }

  function handleCreate() {
    if (!canCreate) return;
    const prompt = promptText.current.trim();
    const createRepo = repo;
    const branch =
      startPoint.kind === "pull-request"
        ? startPoint.pullRequest.branch
        : startPoint.kind === "new"
          ? newBranch.trim() || fallbackBranchName(prompt)
          : startPoint.branch;
    const attachRepos = extraRepos.filter((id) => id !== createRepo);
    const createMode = mode;

    // With "Create more" off, App tears down the palette when the
    // session_created event arrives (and drops us into the new session).
    setStatus({ kind: "creating" });
    creatingRef.current = true;
    // Workspace linkage: scoped to an existing workspace (the tab/sidebar +),
    // the session joins it. An unscoped composer that was closed already made
    // a draft workspace, so reopening and creating adopts that same workspace
    // instead of leaving the draft beside a second, live workspace.
    const prWorkspaceId = selectedPullRequest
      ? findPrWorkspaceId(workspaces, sessions, {
          repo: selectedPullRequest.repo,
          branch: selectedPullRequest.branch,
          number: selectedPullRequest.number,
        }) || undefined
      : undefined;
    // A PR source owns its workspace identity too. Prefer its known lane over a
    // parked generic draft; without one, ask the server to mint a PR-named lane.
    const createWorkspaceId =
      workspaceId ||
      prWorkspaceId ||
      (!selectedPullRequest
        ? getParkedNewSessionWorkspaceId() || undefined
        : undefined);
    const worktreeMode =
      createMode === "ask"
        ? "ask"
        : startPoint.kind === "new"
          ? "stack"
          : "share";
    const clientSessionId = newClientSessionId();
    // The server applies `defaultModel` when no personal override is sent. Carry
    // that known choice into the optimistic shell so the phone title bar does
    // not wait for its own catalog fetch before naming the model.
    const optimisticModel = model || defaultModel;
    const pastedBlocks = pastedTexts.map((item) => item.text);
    const optimisticCreate: NewSessionCreateDraft = {
      id: clientSessionId,
      prompt,
      mode: createMode,
      // The optimistic shell is replaced once the persisted record lands.
      repo: createRepo,
      branch: createMode === "code" || selectedPullRequest ? branch : null,
    };
    if (createWorkspaceId) optimisticCreate.workspaceId = createWorkspaceId;
    // Replaces `...(optimisticModel ? { model: optimisticModel } : {})`.
    if (optimisticModel) optimisticCreate.model = optimisticModel;
    if (images.length) optimisticCreate.images = images;
    if (files.length) optimisticCreate.files = files;
    if (pastedBlocks.length) optimisticCreate.pastedTexts = pastedBlocks;
    // The default action opens against this deterministic id without waiting
    // for workspace or model setup. This assignment replaces the former
    // `createAction === "open" ? { openImmediately: true }` fragment.
    // The other actions keep their own surface.
    if (createAction === "open") optimisticCreate.openImmediately = true;
    if (createAction === "background") optimisticCreate.background = true;

    const createMessage: NewSessionCreateMessage = {
      type: "create_session",
      clientSessionId,
      mode: createMode,
      repo: createRepo,
      // A branch or PR picked in this palette is more specific than the standing
      // preference, so it keeps its isolated worktree.
      checkoutMode: startPoint.kind === "new" ? checkoutPref : "worktree",
      branch: createMode === "code" || selectedPullRequest ? branch : "",
      prompt,
      titlePrompt: projectComposerSessions(prompt).displayText,
      user: getCurrentUser(),
      effort,
    };
    // Repos to work in beside `repo`. The server cuts each an isolated
    // worktree on this session's branch before the first turn runs, so the
    // agent is told about them in the same breath as its own checkout.
    if (attachRepos.length && canAddRepos)
      createMessage.attachRepos = attachRepos;
    if (createWorkspaceId) {
      // Replaces `{ workspaceId: createWorkspaceId, worktreeMode }` in the
      // wire message and `{ workspaceId: createWorkspaceId }` in its optimistic
      // counterpart.
      createMessage.workspaceId = createWorkspaceId;
      createMessage.worktreeMode = worktreeMode;
    } else {
      createMessage.createWorkspace = selectedPullRequest
        ? {
            name: `PR #${selectedPullRequest.number}: ${selectedPullRequest.title}`
              .trim()
              .slice(0, 80),
          }
        : {};
    }
    if (modelWorkspaceId) createMessage.modelWorkspaceId = modelWorkspaceId;
    // This assignment replaces `selectedPullRequest ? { fromPr: true } : {}`.
    if (selectedPullRequest) createMessage.fromPr = true;
    if (model) createMessage.model = model;
    // This assignment replaces `...(fastMode ? { fastMode: true } : {})`.
    if (fastMode) createMessage.fastMode = true;
    if (accountProvider && accountId) createMessage.accountId = accountId;
    // Once defaults have loaded, Host is an explicit override ("local").
    // Omitting the field would make the server re-apply the user's default.
    if (sandboxStatus) createMessage.sandbox = sandboxProvider || "local";
    if (selectedMcpServers.length) {
      createMessage.mcpServers = selectedMcpServers;
    }
    if (images.length) createMessage.images = images;
    if (pastedBlocks.length) createMessage.pastedTexts = pastedBlocks;
    if (files.length) {
      createMessage.files = files.map((file) =>
        file.path
          ? { name: file.name, path: file.path }
          : { name: file.name, dataUrl: file.dataUrl },
      );
    }
    createSessionIdRef.current = clientSessionId;
    createMessageRef.current = createMessage;
    // A globally selected PR adopts its workspace, but its composer draft did
    // not come from that workspace and must not clear a teammate's parked text.
    createWorkspaceIdRef.current = selectedPullRequest
      ? null
      : (createWorkspaceId ?? null);
    try {
      send(createMessage);
      consumePendingDraftParks(prompt, workspaceId, createWorkspaceId);
      if (createAction === "open") {
        // The send was accepted. Consume the global composer now, before App
        // opens the optimistic session, so reopening it during workspace setup
        // starts on the next message rather than the one already queued.
        // App owns the submitted copy and restores it if creation fails.
        promptHandle.current?.dropPendingDraftWrite();
        dropStagingAttachments(DRAFT_KEY);
        clearDraft(DRAFT_KEY);
        promptHandle.current?.setText("");
      }
      onCreateStarted?.(optimisticCreate);
    } catch (error) {
      creatingRef.current = false;
      createSessionIdRef.current = null;
      createMessageRef.current = null;
      createWorkspaceIdRef.current = null;
      setStatus({
        kind: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const canCreate =
    !busy &&
    // An attachment is not attached until its upload lands, and the create
    // reads the list as it stands. Creating a second earlier would send the
    // prompt without the screenshot it is about, silently.
    !isStaging(staging) &&
    connected &&
    // "No repo" is a choice, so it passes; only an unresolved picker (an
    // instance with no repositories registered yet) blocks.
    !!repo &&
    // Unsupported model × environment combo: the server would reject the
    // create with the same message (resolveRequestedSandbox). Block here
    // so the wall is discovered before submit, not after.
    !sandboxModelWarning &&
    (hasPromptText ||
      images.length > 0 ||
      files.length > 0 ||
      pastedTexts.length > 0);

  /** The latest `handleCreate`, for a caller that has to wait a render before
   *  it can create. The dictation bar's ↑ is the one: it writes the transcript
   *  through the prompt's own state, so a closure captured at the moment of
   *  the press would still be looking at the draft as it was. */
  const createRef = useRef<() => void>(() => {});
  // Deliberate latest-value mirror: runs after every commit by design.
  useLayoutEffect(() => {
    createRef.current = handleCreate;
  });

  // The base a code session branches off. It sits in the footer's overflow
  // menu rather than the header: a fresh branch is what almost every session
  // gets, so the row it used to occupy was a picker nobody moved, beside the
  // one thing you do choose. Only a Code session with a repo has a branch at
  // all — Ask cuts no worktree, and Code with no repo has nothing to cut one
  // from.
  const createFromLabel =
    startPoint.kind === "pull-request"
      ? `PR #${startPoint.pullRequest.number}`
      : startPoint.kind === "worktree"
        ? startPoint.branch
        : startsInLocalCheckout
          ? "Local checkout"
          : "New branch";
  const createFromOptions: Array<{ label: string; point: SessionStartPoint }> =
    [
      {
        point: { kind: "new" },
        label: startsInLocalCheckout
          ? "Local checkout"
          : workspaceId && forceBranch
            ? `New stacked branch (off ${forceBranch})`
            : "New branch",
      },
      ...worktrees.map((wt) => ({
        point: { kind: "worktree" as const, branch: wt.branch },
        label: wt.branch,
      })),
    ];
  // The branch this palette starts on: a sibling's inside a workspace, a fresh
  // one everywhere else. Anything else is a deliberate pick, and one level
  // behind a button it has to light that button up to be visible at all.
  const branchPicked =
    mode === "code" &&
    !startsInLocalCheckout &&
    (startPoint.kind === "pull-request" ||
      (startPoint.kind === "worktree" && startPoint.branch !== forceBranch));
  // A row worth opening needs a second thing to pick. A local-checkout default
  // still shows the row when an existing worktree offers a deliberate override.
  const showBranchPicker =
    mode === "code" &&
    (worktrees.length > 0 ||
      (!startsInLocalCheckout && startPoint.kind !== "new"));

  // Which edges of the prompt earn a hairline. The field measures its own
  // scroller and reports; holding the previous object when nothing moved is
  // what keeps a scroll (or a keystroke) from re-rendering the card.
  function handlePromptEdges(next: { top: boolean; bottom: boolean }) {
    setEdges((prev) =>
      prev.top === next.top && prev.bottom === next.bottom ? prev : next,
    );
  }

  // One frame closed so the palette animates in; App mounts us already-open.
  const open = useEnterOnMount();

  function resetFileDrag() {
    if (fileDragWatchdogRef.current) clearTimeout(fileDragWatchdogRef.current);
    fileDragWatchdogRef.current = null;
    setFileDragActive(false);
  }

  function armFileDragWatchdog() {
    if (fileDragWatchdogRef.current) clearTimeout(fileDragWatchdogRef.current);
    fileDragWatchdogRef.current = setTimeout(resetFileDrag, 500);
  }

  useEffect(() => {
    if (inline || !open) return;
    function ownsFileDrag() {
      const composer = document.querySelector<HTMLElement>(
        '[data-global-file-composer="new-session"]',
      );
      return foregroundFileComposerOwns(composer);
    }
    function handleDragEnter(event: DragEvent) {
      if (!hasDraggedFiles(event.dataTransfer)) return;
      if (!ownsFileDrag()) {
        resetFileDrag();
        return;
      }
      event.preventDefault();
      armFileDragWatchdog();
      setFileDragActive(true);
    }
    function handleDragLeave(event: DragEvent) {
      if (!hasDraggedFiles(event.dataTransfer)) return;
      if (!ownsFileDrag()) {
        resetFileDrag();
        return;
      }
      const next = event.relatedTarget;
      if (next instanceof Node && document.documentElement.contains(next))
        return;
      resetFileDrag();
    }
    function handleDragOver(event: DragEvent) {
      if (!hasDraggedFiles(event.dataTransfer)) return;
      if (!ownsFileDrag()) {
        resetFileDrag();
        return;
      }
      event.preventDefault();
      armFileDragWatchdog();
      setFileDragActive(true);
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    }
    function handleDrop(event: DragEvent) {
      if (!hasDraggedFiles(event.dataTransfer)) return;
      if (!ownsFileDrag()) {
        resetFileDrag();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const dropped = event.dataTransfer?.files;
      resetFileDrag();
      if (dropped?.length) addDroppedAttachments(dropped);
    }
    window.addEventListener("dragenter", handleDragEnter, true);
    window.addEventListener("dragleave", handleDragLeave, true);
    window.addEventListener("dragover", handleDragOver, true);
    window.addEventListener("drop", handleDrop, true);
    window.addEventListener("dragend", resetFileDrag, true);
    return () => {
      window.removeEventListener("dragenter", handleDragEnter, true);
      window.removeEventListener("dragleave", handleDragLeave, true);
      window.removeEventListener("dragover", handleDragOver, true);
      window.removeEventListener("drop", handleDrop, true);
      window.removeEventListener("dragend", resetFileDrag, true);
      resetFileDrag();
    };
  }, [inline, open]);

  // Ask mode's surface, shared with the session composer so one mode is one
  // strength wherever you meet it. Only the base differs: mixed into
  // `transparent` rather than an opaque colour, because the palette is glass
  // and an opaque tint would paint the blur out.
  const askSurfaceStyle: AskSurfaceStyle = {
    "--palette-ask-bg": askSurface("transparent"),
  };

  // The card itself: the same rows whether it floats over the page as a
  // palette or sits on it as the empty state's session input.
  const card = (
    <>
      {/* Header: what the session is pointed at, and nothing else. The mode
          switch sits with the tools in the footer, and the branch one level
          behind them, because a fresh branch is what almost every code
          session wants. Either mode can be pointed at nothing: Ask with no
          repo is a conversation with your tools, Code with no repo is a
          scratch dir.

          On a phone this row is also the sheet's title bar: dismiss, the
          project, commit. One row rather than two, because a sheet over an
          open keyboard has about half a screen to spend and an attachment
          takes its share of it. */}
      <PhoneTopBar
        className={cn(HEADER, !dictating && edges.top && EDGE_DIVIDER)}
      >
        {phoneBar && (
          <>
            <Modal.Close
              render={
                <PhoneTopBarAction
                  aria-label="Close"
                  icon={<IconX size={22} />}
                />
              }
            />
            {/* The sheet still has a name, it just isn't drawn: the dialog
                needs one, and a screen reader has no card to look at. */}
            <Modal.Title className="sr-only">New session</Modal.Title>
          </>
        )}
        <div className={MOBILE_PICKER}>
          <PaletteSelect
            className={cn(TRIGGER_STRONG, MOBILE_TRIGGER)}
            title="Project"
            value={repo}
            options={[
              ...repos.map((p) => ({
                value: p.id,
                label: p.label,
                icon: <RepoTile name={p.id} />,
                // A shared-checkout repo has no isolated worktree to attach,
                // so it can be the session's repo but never a second one.
                singleOnly:
                  startPoint.kind === "new" &&
                  (resolveSessionCheckoutPref(checkoutPrefs, p.id) ===
                    "checkout" ||
                    (resolveSessionCheckoutPref(checkoutPrefs, p.id) ===
                      "default" &&
                      p.sharedCheckout)),
              })),
              // Either mode can run without a repo, and the Ask toggle in the
              // footer says which one you get: Ask reads nothing, Code writes
              // in a plain scratch dir with no branch or PR flow.
              {
                value: NO_REPO,
                label: "No repo",
                icon: <IconMessage size={20} />,
                singleOnly: true,
              },
            ]}
            onChange={(nextRepo) => {
              setRepo(nextRepo);
              // Picking a project is a fresh source choice, even when it is the
              // same repo as the selected PR. Otherwise the title says Project
              // while create_session still checks out the PR's existing branch.
              setStartPoint(defaultStartPoint());
              // A plain pick is "work here", not "and here too": it replaces
              // the whole selection, which is what it did before any of this.
              // It does NOT become your default either — that is a setting
              // now (Settings → Preferences), not a thing the picker infers.
              setExtraRepos([]);
            }}
            extraValues={extraRepos}
            onToggleExtra={
              canAddRepos
                ? (id) => {
                    const next = toggleRepoSelection(
                      { repo, extras: extraRepos },
                      id,
                    );
                    setRepo(next.repo);
                    setExtraRepos(next.extras);
                  }
                : undefined
            }
            multiHint={repoSelectionHint(
              extraRepos,
              repoOptionLabel,
              MULTI_MODIFIER,
            )}
            // A feed workspace is repo-less by construction (its subject is a
            // a feed item, not a checkout), so its create doesn't offer one.
            disabled={busy || forceMode === "scratch"}
            ariaLabel="Project"
            isPhone={isPhone}
          >
            {repo === NO_REPO ? (
              <IconMessage className="shrink-0" size={18} />
            ) : (
              <RepoTile name={repo} />
            )}
            <span className="truncate">
              {repo === NO_REPO
                ? "No repo"
                : repoOptionLabel(repo) || repo || "No repositories"}
            </span>
            {/* The trigger has room for one repo, so the rest ride as a count —
                the same shorthand the session header's repo pill uses. */}
            {extraRepos.length > 0 && (
              <span
                className="shrink-0 text-label font-medium text-dim"
                title={extraRepos.map(repoOptionLabel).join(", ")}
              >
                +{extraRepos.length}
              </span>
            )}
            {forceMode !== "scratch" && (
              <IconChevronDown className={CHEVRON} size={22} />
            )}
          </PaletteSelect>
        </div>
        {phoneBar && (
          <button
            type="button"
            className={cn(PHONE_SEND, dictating && "invisible")}
            onClick={handleCreate}
            disabled={!canCreate}
            aria-label={CREATE_LABELS[createAction]}
          >
            <IconArrowUp size={22} />
          </button>
        )}
      </PhoneTopBar>

      <motion.div
        initial={false}
        animate={{ height: dictating ? (isPhone ? 64 : 62) : "auto" }}
        transition={composerMorph}
        onAnimationComplete={() => {
          if (!dictating) setDictationClipping(false);
        }}
        className={cn(
          "relative flex min-h-0 flex-col",
          dictationClipping && "overflow-hidden",
        )}
      >
        {/* Dictation replaces everything below Project while the card itself
            supplies the surface, border and shadow. Keeping this target inside
            the card avoids drawing a second rounded container over the first. */}
        <div
          ref={voiceOverlayRef}
          className="pointer-events-none !absolute inset-0 !z-[6]"
        />
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col",
            dictating && "invisible",
          )}
        >
          {/* Picked services, above the field like every other thing attached to
          what you are about to send. The picker is two levels inside a menu,
          so without this the only trace of a pick is a count on the overflow
          button, and the pick governs the whole session rather than one
          prompt. The row stays mounted so the last chip can animate out. */}
          <div className="flex flex-wrap items-start gap-x-1 px-4 phone:px-3 phone:pt-1">
            {selectedMcpServers.length > 0 && (
              <span className="mr-1 self-center text-meta font-medium text-faint phone:block desktop:hidden">
                Using
              </span>
            )}
            <AnimatePresence initial={false}>
              {selectedMcpServers.map((mcp) => (
                <ComposerContextChip
                  key={mcp}
                  icon={<IconTile name={mcp} size={15} />}
                  label={displayName(mcp)}
                  title={`${displayName(mcp)} is on. A session gets only the services you pick here.`}
                  onRemove={() => toggleMcpServer(mcp, false)}
                  removeLabel={`Remove ${displayName(mcp)}`}
                  disabled={busy}
                />
              ))}
            </AnimatePresence>
          </div>

          {/* Prompt. It owns the draft: see NewSessionPrompt for why the text
            does not live in this component. */}
          <NewSessionPrompt
            config={{
              initialText: initialPrompt,
              repo,
              mcpServers: selectedMcpServers,
              // Ask sessions read and explain; they never touch the code. Asking
              // "what to work on" in that mode invites a prompt the session
              // cannot carry out.
              placeholder:
                mode === "ask"
                  ? "What do you want to find out?"
                  : "What do you want to work on?",
              disabled: busy,
              images,
              files,
              pastedTexts,
              staging,
              sendKey,
              canCreate,
            }}
            refs={{
              textarea: promptRef,
              value: promptText,
              handle: promptHandle,
            }}
            actions={{
              removePendingImage: uploads.cancelPendingImage,
              removePendingFile: uploads.cancelPendingFile,
              removeImage: (index) => {
                removeDraftImage(DRAFT_KEY, index);
                adoptDraftAttachments();
              },
              removeFile: (index) => {
                removeDraftFile(DRAFT_KEY, index);
                adoptDraftAttachments();
              },
              addAttachments: (picked) => void addAttachments(picked),
              addPastedText: (text) => {
                const next = [...pastedTexts, createPastedTextAttachment(text)];
                setPastedTexts(next);
                saveDraft(DRAFT_KEY, { pastedTexts: next });
              },
              removePastedText: (id) => {
                const next = pastedTexts.filter((item) => item.id !== id);
                setPastedTexts(next);
                saveDraft(DRAFT_KEY, { pastedTexts: next });
              },
              create: handleCreate,
              changeHasText: setHasPromptText,
              settleDraft: setSettledPrompt,
              changeEdges: handlePromptEdges,
              changeMentionOpen: setMentionOpen,
            }}
          />

          {status.kind === "failed" && (
            <div className={ERROR}>{status.message}</div>
          )}
          {sandboxModelWarning && (
            <div className={ERROR} role="alert">
              {sandboxModelWarning}
            </div>
          )}

          {/* Footer toolbar */}
          <div className={cn(FOOTER, edges.bottom && EDGE_DIVIDER)}>
            <div className={FOOTER_LEFT}>
              <Tooltip label="Attach a file" shortcut={attachKeys ?? undefined}>
                <button
                  type="button"
                  className={FOOTER_ICON_BTN}
                  onClick={() => fileInputRef.current?.click()}
                  disabled={busy}
                  aria-label="Attach a file"
                >
                  <IconPaperclip size={20} />
                </button>
              </Tooltip>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files?.length)
                    void addAttachments(e.target.files);
                  e.target.value = "";
                }}
              />
              {/* Ask sits with the tools rather than in the header: Code is what
                you are almost always doing, so the header should show what you
                are working on (the repo, the branch) and this is the one
                switch that changes it. Off it is a quiet icon; on it names
                itself and wears the green the card and the composer's Ask pill
                also wear, because read-only running silently is the one state
                worth being loud about. */}
              {!workspaceId && forceMode !== "scratch" && (
                <NewSessionPrPicker
                  repo={repo}
                  selected={selectedPullRequest}
                  disabled={busy}
                  onSelect={(pullRequest) => {
                    setRepo(pullRequest.repo);
                    setExtraRepos([]);
                    setStartPoint({ kind: "pull-request", pullRequest });
                  }}
                  onClear={() => setStartPoint(defaultStartPoint())}
                />
              )}
              {!forceMode && (
                <Tooltip
                  label={
                    permission === "ask"
                      ? "Ask mode on · reads, changes nothing. Click to write code instead"
                      : "Ask mode · read-only, and no repo unless you pick one"
                  }
                >
                  <button
                    type="button"
                    className={
                      permission === "ask" ? ASK_BTN_ON : FOOTER_ICON_BTN
                    }
                    onClick={togglePermission}
                    disabled={busy}
                    aria-pressed={permission === "ask"}
                    aria-label="Ask mode"
                  >
                    <IconEye size={permission === "ask" ? 14 : 20} />
                    {permission === "ask" && "Ask"}
                  </button>
                </Tooltip>
              )}
              {/* Rarely changed execution settings stay one level behind a single
                overflow button. Their current values remain visible in the
                submenu rows, while attachment stays one tap away. */}
              <Menu.Root>
                <Tooltip label="More options">
                  <Menu.Trigger
                    type="button"
                    className={cn(
                      FOOTER_ICON_BTN,
                      (branchPicked ||
                        sandboxProvider ||
                        modelEngine(effectiveModelId) !== "pi" ||
                        selectedMcpServers.length > 0) &&
                        paletteIconBtnOn,
                    )}
                    disabled={busy}
                    aria-label="More options"
                  >
                    <IconDotsHorizontal size={20} />
                  </Menu.Trigger>
                </Tooltip>
                <Menu.Popup
                  align="start"
                  sideOffset={6}
                  className="min-w-[260px] max-w-[min(360px,calc(100vw-1rem))]"
                >
                  {showBranchPicker && (
                    <Menu.SubmenuRoot>
                      <Menu.SubmenuTrigger className="justify-between gap-3">
                        <span className="flex flex-none items-center gap-2">
                          <IconNewBranch
                            className="shrink-0 text-dim"
                            size={20}
                          />
                          <span>Branch</span>
                        </span>
                        <span className="flex min-w-0 items-center gap-1 text-dim">
                          <span className="truncate">{createFromLabel}</span>
                          <IconChevronRight
                            className="shrink-0 text-faint"
                            size={17}
                          />
                        </span>
                      </Menu.SubmenuTrigger>
                      <Menu.Popup className="max-w-[min(340px,calc(100vw-1rem))]">
                        {createFromOptions.map((opt) => {
                          const selected =
                            opt.point.kind === startPoint.kind &&
                            (opt.point.kind !== "worktree" ||
                              (startPoint.kind === "worktree" &&
                                opt.point.branch === startPoint.branch));
                          return (
                            <Menu.Item
                              key={
                                opt.point.kind === "worktree"
                                  ? opt.point.branch
                                  : opt.point.kind
                              }
                              onClick={() => setStartPoint(opt.point)}
                            >
                              <Menu.Check on={selected} className="text-dim" />
                              <span className="min-w-0 truncate">
                                {opt.label}
                              </span>
                            </Menu.Item>
                          );
                        })}
                      </Menu.Popup>
                    </Menu.SubmenuRoot>
                  )}
                  {showSandboxPicker && (
                    <Menu.SubmenuRoot>
                      <Menu.SubmenuTrigger className="justify-between gap-3">
                        <span className="flex min-w-0 items-center gap-2">
                          <IconBox className="shrink-0 text-dim" size={20} />
                          <span className="truncate">Sandbox</span>
                        </span>
                        <span className="flex flex-none items-center gap-1 text-dim">
                          {sandboxLabel(sandboxProvider)}
                          {sandboxWarmed && shouldPrewarm && (
                            <span className="text-faint">· ready</span>
                          )}
                          <IconChevronRight
                            className="shrink-0 text-faint"
                            size={17}
                          />
                        </span>
                      </Menu.SubmenuTrigger>
                      <Menu.Popup className="max-w-[min(340px,calc(100vw-1rem))]">
                        {[
                          { id: "", note: undefined },
                          ...visibleSandboxChoices,
                        ].map((opt) => {
                          const selected = sandboxProvider === opt.id;
                          return (
                            <Menu.Item
                              key={opt.id || "host"}
                              onClick={() => {
                                sandboxSelectionTouched.current = true;
                                setSandboxProvider(opt.id);
                              }}
                              className="items-start"
                            >
                              <Menu.Check
                                on={selected}
                                className="mt-0.5 text-dim"
                              />
                              <span className="flex min-w-0 flex-col gap-0.5">
                                <span>{sandboxLabel(opt.id)}</span>
                                {opt.note && (
                                  <span className="whitespace-normal text-supporting leading-snug text-faint">
                                    {opt.note}
                                  </span>
                                )}
                              </span>
                            </Menu.Item>
                          );
                        })}
                      </Menu.Popup>
                    </Menu.SubmenuRoot>
                  )}
                  <Menu.SubmenuRoot>
                    <Menu.SubmenuTrigger className="justify-between gap-3">
                      <span className="flex min-w-0 items-center gap-2">
                        <IconConnections
                          className="shrink-0 text-dim"
                          size={20}
                        />
                        <span className="truncate">Connected services</span>
                      </span>
                      <span className="flex flex-none items-center gap-1 text-dim">
                        {/* Nothing picked is not "none": an empty allowlist means
                          the run gets every service you can see
                          (filterMcpServers, scope "all"), so the readout says
                          so rather than promising a session with no tools. */}
                        {selectedMcpServers.length
                          ? `${selectedMcpServers.length} on`
                          : "All"}
                        <IconChevronRight
                          className="shrink-0 text-faint"
                          size={17}
                        />
                      </span>
                    </Menu.SubmenuTrigger>
                    <Menu.Popup className="max-w-[min(360px,calc(100vw-1rem))]">
                      {availableMcpServers.length > 0 && (
                        <div className="max-w-[300px] px-2 pb-1 text-supporting leading-snug text-faint">
                          Picked services are the only ones the session gets.
                        </div>
                      )}
                      {availableMcpServers.length === 0 && (
                        <Menu.Item disabled className="text-faint">
                          No services available
                        </Menu.Item>
                      )}
                      {availableMcpServers.map((mcp) => {
                        const checked = selectedMcpServers.includes(mcp);
                        return (
                          <Menu.CheckboxItem
                            key={mcp}
                            checked={checked}
                            closeOnClick={false}
                            onCheckedChange={(on) => toggleMcpServer(mcp, on)}
                            className={cn(
                              "justify-between gap-3",
                              checked && "bg-hover",
                            )}
                          >
                            <span className="flex min-w-0 items-center gap-2.5">
                              <IconTile name={mcp} size={20} />
                              <span className="min-w-0 truncate">
                                {displayName(mcp)}
                              </span>
                            </span>
                            <Menu.Check on={checked} className="text-dim" />
                          </Menu.CheckboxItem>
                        );
                      })}
                    </Menu.Popup>
                  </Menu.SubmenuRoot>
                  {/* The phone's send is one round button, so what the desktop
                    caret holds lives here instead. Flat rows rather than a
                    submenu: a submenu opens on hover, which a finger does not
                    have. A plain div rather than Menu.GroupLabel, which stops
                    the sibling submenus above from opening at all. */}
                  {phoneBar && (
                    <>
                      <div className="px-2 pb-1 pt-1.5 text-meta font-medium text-faint">
                        On create
                      </div>
                      {CREATE_ACTIONS.map((action) => (
                        <Menu.Item
                          key={action}
                          onClick={() => setCreateAction(action)}
                        >
                          <Menu.Check
                            on={createAction === action}
                            className="text-dim"
                          />
                          <span className="min-w-0 truncate">
                            {CREATE_LABELS[action]}
                          </span>
                        </Menu.Item>
                      ))}
                    </>
                  )}
                </Menu.Popup>
              </Menu.Root>
            </div>

            <div className={FOOTER_RIGHT}>
              {/* Always visible — on phones too, so a non-default (dumber) model
                is never silently in effect. */}
              <ModelEffortSelect
                selection={{
                  models,
                  defaultModel,
                  model,
                  effort,
                  fastMode,
                  accounts,
                  accountId,
                }}
                appearance={{
                  className: MODEL_PILL,
                  title: "Model and reasoning effort",
                  disabled: busy,
                }}
                actions={{
                  changeModel: setModel,
                  changeEffort: setEffort,
                  changeFastMode: setFastMode,
                  changeAccount: setAccountId,
                }}
              />
              <VoiceInput
                className={FOOTER_ICON_BTN}
                disabled={busy}
                editTargetRef={promptRef}
                overlayTargetRef={voiceOverlayRef}
                onActiveChange={handleDictationActive}
                onText={(t) => {
                  promptHandle.current?.appendText(t);
                  promptRef.current?.focus();
                }}
                onTextSend={(t) => {
                  promptHandle.current?.appendText(t);
                  // One turn of the loop before creating: the transcript reaches
                  // the prompt through its own state, and `canCreate` only
                  // catches up on the render after it. `createRef` is read then
                  // rather than captured now for the same reason.
                  setTimeout(() => createRef.current(), 0);
                }}
                // The parent card owns the only visible surface. This layer is
                // just controls and waveform clipped by that card's outer edge.
                overlayClassName="rounded-none bg-transparent [backdrop-filter:none]"
              />

              {!phoneBar && (
                <div className={CREATE_SPLIT} ref={createSplitRef}>
                  <button
                    className={cn(
                      CREATE_MAIN,
                      inline ? CREATE_MAIN_WHOLE : CREATE_MAIN_SPLIT,
                    )}
                    onClick={handleCreate}
                    disabled={!canCreate}
                  >
                    {status.kind === "reconnecting"
                      ? "Reconnecting…"
                      : status.kind === "creating"
                        ? "Creating…"
                        : isStaging(staging)
                          ? "Attaching…"
                          : CREATE_LABELS[createAction]}
                    {/* The hint has to match the preference — a bare ↩ next to a
                    field that only creates on ⌘↩ is what made Enter look
                    broken in the first place. */}
                    {sendKey === "mod-enter" ? (
                      <span
                        className={`${CREATE_KBD} mx-0 phone:hidden text-xs`}
                      >
                        {MOD_ENTER_GLYPH}
                      </span>
                    ) : (
                      /* Snug the return glyph up to the label and nudge it off the
                     button edge. "Create more" is a desktop workflow, so the
                     hint goes away with the caret on phones. */
                      <IconReturn
                        className={`${CREATE_KBD} -mx-[3px] phone:hidden`}
                        size={20}
                      />
                    )}
                  </button>
                  {/* The tooltip is where the cycle shortcut is taught: the caret
                  is the only thing on screen that says these options exist.
                  Inline there are no options to pick between, so the button is
                  whole and the caret is gone. */}
                  {!inline && (
                    <Tooltip label="Create options" shortcut={CYCLE_SHORTCUT}>
                      <button
                        type="button"
                        className={CREATE_CARET}
                        onClick={() => setCreateMenuOpen((v) => !v)}
                        // Not having a prompt yet leaves the caret alone: the options
                        // are still worth reading, and picking one is how you change
                        // what Enter will do. A create in flight is the one thing that
                        // closes it off, and then it greys out with the main button
                        // beside it, so the pair still reads as one busy control. An
                        // attachment on its way to disk holds the same pair the same
                        // way, for the second or two it takes.
                        disabled={busy || isStaging(staging)}
                        aria-haspopup="menu"
                        aria-expanded={createMenuOpen}
                        aria-label="Create options"
                      >
                        <IconChevronDown
                          className={`transition-transform ${createMenuOpen ? "rotate-180" : ""}`}
                          size={22}
                        />
                      </button>
                    </Tooltip>
                  )}
                  {!inline && createMenuOpen && (
                    <div className={CREATE_MENU} role="menu">
                      {[
                        {
                          action: "open" as const,
                          title: "Create",
                          desc: "Open the new session",
                        },
                        {
                          action: "background" as const,
                          title: "Create in background",
                          desc: "Stay where you are",
                        },
                        {
                          action: "more" as const,
                          title: "Create more",
                          desc: "Stay here to start another",
                        },
                      ].map((opt) => (
                        <button
                          key={opt.action}
                          type="button"
                          role="menuitemradio"
                          aria-checked={createAction === opt.action}
                          className={CREATE_MENU_ITEM}
                          onClick={() => {
                            setCreateAction(opt.action);
                            setCreateMenuOpen(false);
                          }}
                        >
                          <Menu.Check
                            on={createAction === opt.action}
                            size={22}
                            className="mt-px text-dim"
                          />
                          <span className="flex min-w-0 flex-col gap-px">
                            <span className="text-label font-semibold">
                              {opt.title}
                            </span>
                            <span className="text-supporting text-dim">
                              {opt.desc}
                            </span>
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </motion.div>
    </>
  );

  if (inline) {
    return (
      <div
        className={cn(
          INLINE_CARD,
          ASK_SURFACE,
          mode === "ask" && "before:opacity-100 after:opacity-100",
        )}
        style={askSurfaceStyle}
        role="group"
        aria-label="New session"
        onKeyDown={handleCardKeyDown}
      >
        {card}
      </div>
    );
  }

  return (
    <Modal.Root
      open={open}
      // Escape and outside presses both land here. App's global Esc-closes-a-
      // palette shortcut can't double-fire: Base UI stops the keydown before it
      // reaches window, so this is the only close (which matters, because
      // closePalette also pops a /new deep link off history).
      onOpenChange={(next) => {
        if (next || busy) return;
        // Whatever is still in the prompt was worth typing, so leaving parks it
        // as a draft instead of dropping it behind the palette.
        void parkDraftOnExit();
        onBack();
      }}
      // Focus is trapped, but the page is neither inerted nor scroll-locked: the
      // "@"-mention popup portals to <body>, and inerting would leave it dead.
      modal="trap-focus"
      // Mid-create the palette isn't dismissable. An open mention popup also
      // owns the next click: it lives outside the dialog, so pressing it would
      // otherwise read as an outside press and close the whole palette.
      disablePointerDismissal={busy || mentionOpen}
    >
      <Modal.Content
        data-global-file-composer="new-session"
        variant="palette"
        widthClassName="w-[min(820px,100%)] phone:w-full"
        // The bottom pad is the keyboard's own height (lib/keyboard-inset).
        // The sheet is anchored to the bottom of the LAYOUT viewport, which iOS
        // does not shrink for the keyboard, so without it the composer sits
        // behind the keys and the page has to be panned to reach it. It is 0px
        // wherever nothing covers the window.
        viewportClassName="phone:items-end phone:px-0 phone:pb-[var(--kb-inset,0px)] phone:pt-3"
        className={cn(
          // A phone sheet carries a rounder top corner than the floating
          // palette does: it meets the screen's own edge on three sides, so the
          // two corners it keeps are the whole of its shape.
          //
          // The keyboard cap is what keeps the title bar on screen: a tall
          // enough sheet (a prompt carrying an image) ran off the top and took
          // dismiss and send with it. 43dvh fits the strip left above an iPhone
          // keyboard and its suggestion bar, and the 100% holds the sheet
          // inside that strip on a client whose keyboard is taller than the
          // one 43dvh was measured against. Past the cap the prompt scrolls,
          // which is what its scroller is for.
          "max-h-[calc(89dvh-1rem)] phone:max-h-[calc(100dvh-12px)] phone:[body.kb-open_&]:max-h-[min(43dvh,100%)] phone:rounded-t-[calc(40px*var(--rf))] phone:rounded-b-none phone:[&_textarea]:min-h-[160px] phone:[&_textarea]:text-input-phone",
          ASK_SURFACE,
          mode === "ask" && "before:opacity-100 after:opacity-100",
        )}
        style={askSurfaceStyle}
        aria-label="New session"
        onKeyDown={handleCardKeyDown}
        // The prompt, not the repo picker Base UI would otherwise land on as the
        // first tabbable.
        initialFocus={promptRef}
        finalFocus={() => !createdRef.current}
      >
        {card}
        <FullPageFileDropOverlay active={fileDragActive} />
      </Modal.Content>
    </Modal.Root>
  );
}
