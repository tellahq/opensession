import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { WorkspaceMediaItem } from "../lib/api";
import type { UnifiedSession } from "../lib/types";
import type { useSessionRuntime } from "./useSessionRuntime";
import type { useSessionSocket } from "./useSessionSocket";
import {
  useSessionOverflowState,
  useSessionArchiveShortcut,
} from "./useSessionViewerActionsController";
import { useBackSwipe } from "./useBackSwipe";
import { getCurrentUser } from "../components/UserPicker";
import { otherViewers } from "../lib/presence";
import {
  moveAndCreatePrAction,
  moveSessionToBranchAction,
  deleteSessionAction,
  archiveSessionAction,
} from "../lib/session-viewer-actions";
import { toast } from "../ui/toast";
import { useSessionPreviewStatusEffect } from "./useSessionRuntimeController";

interface ChromeIdentity {
  session: UnifiedSession;
  compactHeader: boolean;
  isPhone: boolean;
  focused: boolean;
  connected: boolean;
}
interface ChromePanel {
  infoPageOpen: boolean;
  setInfoPageOpen: Dispatch<SetStateAction<boolean>>;
  setInfoPageScrolled: Dispatch<SetStateAction<boolean>>;
  panelPage: null | "changes" | "portals" | "agents" | "terminal";
}
interface ChromeRuntime {
  isBusy: boolean;
  hasRepoWork: boolean;
  send: ReturnType<typeof useSessionSocket>["send"];
  viewers: string[];
  pending: ReturnType<typeof useSessionRuntime>[0]["queued"];
  queued: ReturnType<typeof useSessionRuntime>[0]["queued"];
}
interface ChromeLifecycle {
  goBack: () => void;
  onArchive?: () => void;
  onArchived?: (stopped: boolean) => void;
  openNextChat?: () => void;
  showAssets: boolean;
  assetFileCount: number;
  onCloseAssets?: () => void;
}
interface ChromeDeleteState {
  setDeleteLabel: Dispatch<SetStateAction<string>>;
  setDeleting: Dispatch<SetStateAction<boolean>>;
  setShowDeleteConfirm: Dispatch<SetStateAction<boolean>>;
  archiving: boolean;
  setArchiving: Dispatch<SetStateAction<boolean>>;
}
interface ChromePreview {
  controller: Parameters<typeof useSessionPreviewStatusEffect>[0];
  showPreviewTab: boolean;
  showPortal: boolean;
  activePanelOpen: boolean;
  worktreeDir?: string | null;
}

export function useSessionChromeController({
  identity,
  panel,
  runtime,
  lifecycle,
  deletion,
  preview,
  primaryPrNumber,
}: {
  identity: ChromeIdentity;
  panel: ChromePanel;
  runtime: ChromeRuntime;
  lifecycle: ChromeLifecycle;
  deletion: ChromeDeleteState;
  preview: ChromePreview;
  primaryPrNumber?: number;
}) {
  const { infoPageOpen, setInfoPageOpen, setInfoPageScrolled, panelPage } =
    panel;
  const panelSettersRef = useRef({ setInfoPageOpen, setInfoPageScrolled });
  const { showAssets, assetFileCount, onCloseAssets } = lifecycle;
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowState = useSessionOverflowState({
    sessionId: identity.session.id,
    repo: identity.session.repo || undefined,
    branch: identity.session.branch,
    hasRepoWork: runtime.hasRepoWork,
    primaryPrNumber,
  });
  const infoPageRef = useRef<HTMLDivElement | null>(null);
  const infoHeroNameRef = useRef<HTMLHeadingElement | null>(null);
  useBackSwipe({
    active: identity.isPhone && infoPageOpen,
    onBack: () => setInfoPageOpen(false),
    paneRef: infoPageRef,
    priority: 2,
  });
  useEffect(() => {
    if (!infoPageOpen || panelPage !== null) {
      panelSettersRef.current.setInfoPageScrolled(false);
      return;
    }
    const root = infoPageRef.current;
    const title = infoHeroNameRef.current;
    if (!root || !title) return;
    const topbar = root.querySelector<HTMLElement>(".session-info-topbar");
    const topInset = Math.ceil(topbar?.getBoundingClientRect().height || 52);
    const observer = new IntersectionObserver(
      ([entry]) =>
        panelSettersRef.current.setInfoPageScrolled(!entry.isIntersecting),
      { root, rootMargin: `-${topInset}px 0px 0px`, threshold: 0 },
    );
    observer.observe(title);
    return () => observer.disconnect();
  }, [infoPageOpen, identity.isPhone, panelPage]);
  useEffect(() => {
    if (!infoPageOpen) return;
    const app = document.querySelector<HTMLElement>(".app");
    app?.setAttribute("inert", "");
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape")
        panelSettersRef.current.setInfoPageOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      app?.removeAttribute("inert");
    };
  }, [infoPageOpen]);
  useEffect(() => {
    const toggle = () =>
      panelSettersRef.current.setInfoPageOpen((open) => {
        if (!open) panelSettersRef.current.setInfoPageScrolled(false);
        return !open;
      });
    window.addEventListener("opensession:toggle-session-settings", toggle);
    return () =>
      window.removeEventListener("opensession:toggle-session-settings", toggle);
  }, [identity.session.id]);
  useEffect(() => {
    setOverflowOpen(false);
    panelSettersRef.current.setInfoPageOpen(false);
  }, [identity.compactHeader]);
  const others = otherViewers(runtime.viewers, getCurrentUser());
  const liveOverviewMedia = useMemo<WorkspaceMediaItem[]>(() => {
    const fromImages = (
      items: Array<{ images?: string[]; sentAt?: number }>,
    ): WorkspaceMediaItem[] =>
      items.flatMap((item) =>
        (item.images || []).map((src, index) => ({
          kind: "image" as const,
          src,
          sessionId: identity.session.id,
          sessionTitle: identity.session.title,
          at: new Date((item.sentAt || Date.now()) + index).toISOString(),
        })),
      );
    return [...fromImages(runtime.pending), ...fromImages(runtime.queued)];
  }, [
    runtime.pending,
    runtime.queued,
    identity.session.id,
    identity.session.title,
  ]);
  async function handleDelete(cleanWorktree: boolean) {
    await deleteSessionAction({
      sessionId: identity.session.id,
      cleanWorktree,
      setLabel: deletion.setDeleteLabel,
      setDeleting: deletion.setDeleting,
      setConfirmOpen: deletion.setShowDeleteConfirm,
      goBack: lifecycle.goBack,
    });
  }
  const handleArchive = useCallback(async () => {
    await archiveSessionAction({
      sessionId: identity.session.id,
      archived: identity.session.archived,
      callbacks: {
        onArchive: lifecycle.onArchive,
        onArchived: lifecycle.onArchived,
        goBack: lifecycle.goBack,
      },
      setters: { setArchiving: deletion.setArchiving, setOverflowOpen },
    });
  }, [
    lifecycle.onArchive,
    lifecycle.onArchived,
    lifecycle.goBack,
    identity.session.archived,
    identity.session.id,
    deletion.setArchiving,
    setOverflowOpen,
  ]);
  useSessionArchiveShortcut({
    identity: {
      focused: identity.focused,
      archiving: deletion.archiving,
      archived: identity.session.archived,
    },
    actions: { archive: handleArchive, openNextChat: lifecycle.openNextChat },
  });
  useEffect(() => {
    if (showAssets && assetFileCount === 0) onCloseAssets?.();
  }, [showAssets, assetFileCount, onCloseAssets]);
  useSessionPreviewStatusEffect(preview.controller, {
    showPreviewTab: preview.showPreviewTab,
    showPortal: preview.showPortal,
    activePanelOpen: preview.activePanelOpen,
    infoPageOpen,
    sessionId: identity.session.id,
    worktreeDir: preview.worktreeDir,
  });
  const {
    branchActionBusy,
    setBranchActionBusy,
    branchConfirmOpen,
    setBranchConfirmOpen,
    branchConfirmMode,
    setBranchConfirmMode,
  } = overflowState.branch;
  async function moveToBranchFromMenu() {
    await moveSessionToBranchAction({
      sessionId: identity.session.id,
      isBusy: runtime.isBusy,
      state: {
        busy: branchActionBusy,
        setBusy: setBranchActionBusy,
        closeOverflow: () => setOverflowOpen(false),
        closeConfirm: () => setBranchConfirmOpen(false),
      },
      toast,
    });
  }
  function requestCreatePr() {
    if (!identity.connected) return;
    runtime.send({
      type: "prompt",
      sessionId: identity.session.id,
      user: getCurrentUser(),
      content:
        "Commit any remaining work, push the branch, and open a PR for it.",
    });
  }
  function createPrFromMenu() {
    setOverflowOpen(false);
    requestCreatePr();
  }
  async function moveAndCreatePr() {
    await moveAndCreatePrAction({
      sessionId: identity.session.id,
      connected: identity.connected,
      isBusy: runtime.isBusy,
      state: {
        busy: branchActionBusy,
        setBusy: setBranchActionBusy,
        closeOverflow: () => setOverflowOpen(false),
        closeConfirm: () => setBranchConfirmOpen(false),
      },
      requestCreatePr,
      toast,
    });
  }
  return {
    overflow: {
      overflowOpen,
      setOverflowOpen,
      ...overflowState.menu,
      ...overflowState.git,
      branchActionBusy,
      setBranchActionBusy,
      branchConfirmOpen,
      setBranchConfirmOpen,
      branchConfirmMode,
      setBranchConfirmMode,
      moveToBranchFromMenu,
      createPrFromMenu,
      moveAndCreatePr,
    },
    info: { infoPageRef, infoHeroNameRef, others, liveOverviewMedia },
    lifecycle: { handleDelete, handleArchive },
  };
}
