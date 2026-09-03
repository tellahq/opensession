import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
} from "react";
import type { PrFocus } from "../lib/pr-focus";
import { worstPrRef } from "../lib/pr-refs";
import { sessionPrPresentation } from "../lib/session-prs";
import type { UnifiedSession, SessionSlackShare } from "../lib/types";
import { dismissSlackShare } from "../lib/slack-share-dismiss";
import { toast } from "../ui/toast";
import { useNavigation } from "./useNavigation";
import { useShippedShareState } from "./useSessionViewerActionsController";
import {
  reconnectShippedSlackAction,
  shareShippedChangeAction,
  undoShippedChangeAction,
} from "../lib/session-viewer-actions";
import {
  discoveredPrsFromKey,
  reviewReposFromKey,
  toolPathRootsFromKey,
} from "../lib/session-viewer-derive";
import { NO_REVIEW_REPOS } from "../lib/session-viewer-constants";
import { SessionShellTiming } from "../components/session-viewer/shell-timing";
import type { PrReviewPage } from "../components/PrPanel";

interface ReviewNavigationAvailability {
  canOpenNextChat?: boolean;
  canStartNewSession?: boolean;
  canOpenNewWorkspace?: boolean;
  canOpenSession?: boolean;
  canOpenReview?: boolean;
  canOpenAssets?: boolean;
  canOpenPr?: boolean;
  canOpenPortal?: boolean;
  canOpenWorkspace?: boolean;
}

interface ReviewVisibility {
  showReview: boolean;
  showStaging: boolean;
  showAssets: boolean;
  showTerminal: boolean;
  showPreviewTab: boolean;
  showPortal: boolean;
  hasPortalTarget: boolean;
  showSubagent: boolean;
  hasSubagent: boolean;
  showConversation: boolean;
  hasConversation: boolean;
  showVideo: boolean;
  hasVideo: boolean;
}

interface SessionReviewControllerOptions {
  session: UnifiedSession;
  navigation: ReturnType<typeof useNavigation>;
  focused: boolean;
  reviewFocusPr?: {
    repo: string;
    branch?: string;
    number?: number;
    seq: number;
  } | null;
  availability: ReviewNavigationAvailability;
  visibility: ReviewVisibility;
}

export function useSessionReviewController({
  session,
  navigation,
  focused,
  reviewFocusPr,
  availability,
  visibility,
}: SessionReviewControllerOptions) {
  const { canOpenNextChat, canStartNewSession, canOpenNewWorkspace } =
    availability;
  const {
    canOpenSession,
    canOpenReview,
    canOpenAssets,
    canOpenPr,
    canOpenPortal,
    canOpenWorkspace,
  } = availability;
  const goBack = navigation.goBack;
  const openNextChat = canOpenNextChat ? navigation.openNextChat : undefined;
  const openNewSession = canStartNewSession
    ? navigation.openNewSessionInWorkspace
    : undefined;
  const openNewWorkspace = canOpenNewWorkspace
    ? navigation.openNewWorkspace
    : undefined;
  const openSession = canOpenSession ? navigation.openSession : undefined;
  const openReview = canOpenReview ? navigation.openReview : undefined;
  const openAssets = canOpenAssets ? navigation.openAssets : undefined;
  const openPr = canOpenPr ? navigation.openPr : undefined;
  const openPortal = canOpenPortal ? navigation.openPortal : undefined;
  const openCurrentWorkspace = canOpenWorkspace
    ? navigation.openCurrentWorkspace
    : undefined;

  const reviewReposKey = [
    session.repo || "repository",
    ...(session.attachedRepos || []).map((repo) => repo.repo),
  ].join("\u0000");
  const reviewRepos = useMemo(
    () => reviewReposFromKey(reviewReposKey),
    [reviewReposKey],
  );
  const prPresentation = useMemo(
    () => sessionPrPresentation(session.prs),
    [session.prs],
  );
  const worktreeDiffSource: "worktree" | undefined =
    openReview && (prPresentation.primary || prPresentation.additional.length)
      ? "worktree"
      : undefined;
  const changeWorktreeDiffSource = (next: "pull-request" | "worktree") => {
    if (next === "pull-request") openReview?.();
  };
  const mergedPrValue =
    prPresentation.primary?.state === "MERGED"
      ? prPresentation.primary
      : undefined;
  const prNumber = mergedPrValue?.number;
  const prRepo = mergedPrValue?.repo;
  const prBranch = mergedPrValue?.branch;
  const prTitle = mergedPrValue?.title;
  const mergedPrKey = mergedPrValue
    ? [
        mergedPrValue.number,
        mergedPrValue.repo,
        mergedPrValue.branch ?? "",
        mergedPrValue.title ?? "",
      ].join("\u0000")
    : "";
  const mergedPr = useMemo(
    () =>
      mergedPrKey
        ? {
            number: prNumber,
            repo: prRepo,
            branch: prBranch,
            title: prTitle,
          }
        : undefined,
    [mergedPrKey, prNumber, prRepo, prBranch, prTitle],
  );
  const [shippedChangeStatus, setShippedChangeStatus] = useState<
    "idle" | "sharing"
  >("idle");
  const [shippedSlackReconnectRequired, setShippedSlackReconnectRequired] =
    useState(false);
  const [shippedShare, setShippedShare] = useState<SessionSlackShare | null>(
    null,
  );
  const walkthroughScreenshot = session.walkthrough?.shots?.find(
    (shot) => shot.after,
  )?.after;
  useEffect(() => {
    setShippedChangeStatus("idle");
    setShippedSlackReconnectRequired(false);
    setShippedShare(null);
  }, [session.id, mergedPr?.number]);
  const shippedShareState = useShippedShareState({
    sessionId: session.id,
    mergedPrNumber: mergedPr?.number,
  });
  const { dismissKey: shareDismissKey, dismissed: shareDismissed } =
    shippedShareState;
  const dismissShippedChangeShare = useCallback(
    () => dismissSlackShare(shareDismissKey),
    [shareDismissKey],
  );
  const sendShippedChangeToSlack = useCallback(
    async (message: string, channel: string, screenshots: string[]) => {
      await shareShippedChangeAction({
        identity: { sessionId: session.id, mergedPr },
        setters: {
          setStatus: setShippedChangeStatus,
          setReconnectRequired: setShippedSlackReconnectRequired,
          setShare: setShippedShare,
        },
        input: { message, channel, screenshots },
        toast,
      });
    },
    [mergedPr, session.id],
  );
  const undoShippedChangeShare = useCallback(
    async (at: string) => {
      await undoShippedChangeAction({
        sessionId: session.id,
        at,
        setShare: setShippedShare,
        toast,
      });
    },
    [session.id],
  );
  const reconnectShippedSlack = useCallback(async () => {
    await reconnectShippedSlackAction({
      setReconnectRequired: setShippedSlackReconnectRequired,
      toast,
    });
  }, []);
  const promotedPr =
    prPresentation.primary?.source !== "primary"
      ? prPresentation.primary
      : undefined;
  const phonePr =
    prPresentation.primary ?? worstPrRef(prPresentation.additional);
  const discoveredPrsKey = (session.prs || [])
    .filter((ref) => ref.source === "discovered")
    .map((ref) =>
      [
        ref.repo,
        ref.branch,
        ref.number ?? "",
        ref.url ?? "",
        ref.title ?? "",
      ].join("\u0000"),
    )
    .join("\u0001");
  const discoveredPrs = useMemo(
    () => discoveredPrsFromKey(discoveredPrsKey),
    [discoveredPrsKey],
  );
  const [reviewFocus, setReviewFocus] = useState<PrFocus | undefined>(
    undefined,
  );
  const [reviewPage, setReviewPage] = useState<PrReviewPage>("files");
  const focusPrInReview = useCallback(
    (ref?: { repo: string; branch: string }, view?: "checks") => {
      if (ref || view)
        setReviewFocus((prev) => ({ ...ref, view, seq: (prev?.seq ?? 0) + 1 }));
      openReview?.();
    },
    [openReview],
  );
  const syncReviewFocus = useEffectEvent(() => {
    if (!reviewFocusPr) return;
    setReviewFocus((prev) => ({
      repo: reviewFocusPr.repo,
      branch: reviewFocusPr.branch,
      number: reviewFocusPr.number,
      seq: (prev?.seq ?? 0) + 1,
    }));
  });
  useEffect(() => {
    syncReviewFocus();
  }, [reviewFocusPr?.seq]);
  const toolPathRootsKey = [
    session.worktreeDir || "",
    ...(session.attachedRepos || []).map(
      (repo) => `${repo.dir}\u0000${repo.repo}`,
    ),
  ].join("\u0001");
  const toolPathRoots = useMemo(
    () => toolPathRootsFromKey(toolPathRootsKey),
    [toolPathRootsKey],
  );
  const githubReviewRepos = reviewRepos;
  const workspaceOnlyPrs =
    !prPresentation.primary && prPresentation.additional.length > 0;
  const panelReviewRepos =
    promotedPr || workspaceOnlyPrs ? NO_REVIEW_REPOS : githubReviewRepos;
  const [shellTiming] = useState(
    () => new SessionShellTiming(performance.now()),
  );
  const sessionHidden =
    visibility.showReview ||
    visibility.showStaging ||
    visibility.showAssets ||
    visibility.showTerminal ||
    visibility.showPreviewTab ||
    (visibility.showPortal && visibility.hasPortalTarget) ||
    (visibility.showSubagent && visibility.hasSubagent) ||
    (visibility.showConversation && visibility.hasConversation) ||
    (visibility.showVideo && visibility.hasVideo);

  return {
    navigation: {
      navigation,
      goBack,
      openNextChat,
      openNewSession,
      openNewWorkspace,
      openSession,
      openReview,
      openAssets,
      openPr,
      openPortal,
      openCurrentWorkspace,
    },
    review: {
      reviewRepos,
      prPresentation,
      worktreeDiffSource,
      changeWorktreeDiffSource,
      mergedPr,
      promotedPr,
      phonePr,
      discoveredPrs,
      reviewFocus,
      reviewPage,
      setReviewPage,
      focusPrInReview,
      toolPathRoots,
      panelReviewRepos,
    },
    shipped: {
      shippedChangeStatus,
      shippedSlackReconnectRequired,
      shippedShare,
      walkthroughScreenshot,
      shareDismissed,
      dismissShippedChangeShare,
      sendShippedChangeToSlack,
      undoShippedChangeShare,
      reconnectShippedSlack,
    },
    shell: { shellTiming, sessionHidden },
  };
}
