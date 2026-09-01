import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  fetchGitStatus,
  fetchPr,
  fetchPrCodeFlow,
  fetchPrDiff,
  fetchPrDiffGroups,
  fetchPrPreview,
  fetchPrPreviewCodeFlow,
  fetchPrPreviewDiff,
  fetchPrPreviewGuide,
  fetchPrReviewThreads,
  fetchReviewGuide,
} from "../lib/api";
import type { PrReviewThread } from "../lib/api/prs";
import { errorMessage } from "../lib/error-message";
import { pollWhileVisible, PR_WEBHOOK_FALLBACK_POLL_MS } from "../lib/poll";
import { reviewDiffLoadPolicy } from "../lib/review-diff";
import type {
  CodeFlowResult,
  DiffFileGroup,
  GitStatusInfo,
  PrDetails,
  PrDiffResponse,
  ReviewGuideData,
  WSServerMessage,
} from "../lib/types";

type CodeView = "all" | "guide" | "flow";

interface UsePrDataOptions {
  sessionId: string;
  loadTargetKey: string;
  previewRepo?: string;
  previewBranch?: string;
  loadRepo?: string;
  loadBranch?: string;
  loadLinked?: boolean;
  addHandler?: (handler: (message: WSServerMessage) => void) => () => void;
  showingGuide: boolean;
  showingFlow: boolean;
  onCodeViewChange: (view: CodeView) => void;
  onTargetReset: () => void;
}

/** Owns all target- and head-keyed pull request data loading. */
export function usePrData({
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
  onCodeViewChange,
  onTargetReset,
}: UsePrDataOptions) {
  const [pr, setPr] = useState<PrDetails | null>(null);
  const [git, setGit] = useState<GitStatusInfo | null>(null);
  const [loadedDiff, setDiff] = useState<PrDiffResponse | null>(null);
  const diff = loadedDiff?.headRefOid === pr?.headRefOid ? loadedDiff : null;
  const diffOutOfDate = !!loadedDiff && !diff;
  const diffLoadPolicy = reviewDiffLoadPolicy(
    diff?.patch.length ?? 0,
    pr?.changedFiles ?? 0,
  );
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

  // Keyed like the code flow below, so one target's guide never renders under
  // another's diff and a slow response can't land after the panel moved on.
  const [guide, setGuide] = useState<{
    key: string;
    data: ReviewGuideData;
  } | null>(null);
  const [guideLoading, setGuideLoading] = useState(false);
  const [guideFailed, setGuideFailed] = useState(false);
  const guideGenerationRef = useRef(0);
  const [codeFlow, setCodeFlow] = useState<{
    key: string;
    data: CodeFlowResult;
  } | null>(null);
  const [codeFlowLoading, setCodeFlowLoading] = useState(false);
  const [codeFlowError, setCodeFlowError] = useState<string | null>(null);
  const codeFlowGenerationRef = useRef(0);
  const [reviewThreads, setReviewThreads] = useState<{
    key: string;
    threads: PrReviewThread[];
  } | null>(null);

  const loadGenerationRef = useRef(0);
  const activeLoadTargetRef = useRef(loadTargetKey);
  const loadInFlightRef = useRef<{
    key: string;
    promise: Promise<void>;
  } | null>(null);
  useLayoutEffect(() => {
    activeLoadTargetRef.current = loadTargetKey;
  }, [loadTargetKey]);

  const load = (force = false): Promise<void> => {
    if (loadTargetKey !== activeLoadTargetRef.current) {
      return Promise.resolve();
    }
    const existing = loadInFlightRef.current;
    if (!force && existing?.key === loadTargetKey) return existing.promise;

    const generation = ++loadGenerationRef.current;
    setDiffLoading(true);
    let prSettled = false;
    let diffSettled = false;
    let prResult: PrDetails | null = null;
    let diffResult: PrDiffResponse | null = null;
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

    const prRequest = (
      previewRepo && previewBranch
        ? fetchPrPreview(previewRepo, previewBranch)
        : fetchPr(sessionId, loadRepo, loadBranch)
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
      .catch((error: unknown) => {
        prSettled = true;
        prResult = null;
        if (isCurrent()) {
          setLoadError(errorMessage(error, "Failed to load the pull request."));
        }
        commitDiff();
      })
      .finally(() => {
        if (isCurrent()) setLoading(false);
      });
    const diffRequest = (
      previewRepo && previewBranch
        ? fetchPrPreviewDiff(previewRepo, previewBranch)
        : fetchPrDiff(sessionId, loadRepo, loadBranch)
    )
      .then((data) => {
        diffSettled = true;
        diffResult = data;
        if (isCurrent()) setDiffError(null);
        commitDiff();
      })
      .catch((error: unknown) => {
        diffSettled = true;
        diffResult = null;
        if (isCurrent()) {
          setDiffError(
            errorMessage(error, "Failed to load pull request changes."),
          );
        }
        commitDiff();
      });
    const gitRequest = (
      previewRepo || loadLinked
        ? Promise.resolve(null)
        : fetchGitStatus(sessionId, loadRepo)
    )
      .then((data) => {
        if (isCurrent()) setGit(data);
      })
      .catch(() => {
        if (isCurrent()) setGit(null);
      });
    const reviewThreadsRequest = prRequest.then(async () => {
      if (!prResult) return;
      try {
        const threads = await fetchPrReviewThreads(loadRepo, prResult.number);
        if (isCurrent()) setReviewThreads({ key: loadTargetKey, threads });
      } catch {
        // Resolved threads are supporting context and never block the diff.
      }
    });

    const promise = Promise.allSettled([
      prRequest,
      diffRequest,
      gitRequest,
      reviewThreadsRequest,
    ]).then(() => undefined);
    loadInFlightRef.current = { key: loadTargetKey, promise };
    void promise.then(() => {
      if (loadInFlightRef.current?.promise === promise) {
        loadInFlightRef.current = null;
      }
    });
    return promise;
  };

  const loadForEffect = useEffectEvent((force = false) => load(force));
  const resetTargetState = useEffectEvent(onTargetReset);
  useEffect(() => {
    setLoading(true);
    setLoadError(null);
    setDiffLoading(true);
    setDiffError(null);
    setPr(null);
    setDiff(null);
    setGit(null);
    resetTargetState();
    setReviewThreads(null);
    setCodeFlow(null);
    setCodeFlowLoading(false);
    setCodeFlowError(null);
    codeFlowGenerationRef.current += 1;
    void loadForEffect();
    // useEffectEvent functions must be called, not passed: hand the poller a
    // plain closure so the Effect Event is only ever invoked directly.
    const stopPolling = pollWhileVisible(
      () => loadForEffect(),
      PR_WEBHOOK_FALLBACK_POLL_MS,
    );
    return () => {
      stopPolling();
      loadGenerationRef.current += 1;
    };
  }, [
    sessionId,
    loadTargetKey,
    previewRepo,
    previewBranch,
    loadRepo,
    loadBranch,
    loadLinked,
  ]);

  // A GitHub webhook reported activity on the shown PR's branch (review, CI,
  // push, merge) — refetch immediately. Primary targets omit their branch, so
  // match those through the loaded PR number/head branch instead.
  // The server invalidated its caches before broadcasting, so this reads
  // fresh data.
  const hasLoadedPr = pr !== null;
  useEffect(() => {
    if (!addHandler) return;
    return addHandler((message) => {
      if (message.type !== "pr_updated") return;
      if (
        message.repo === loadRepo &&
        (loadBranch
          ? message.branch === loadBranch
          : !hasLoadedPr ||
            message.number === pr?.number ||
            message.branch === pr?.headRefName)
      )
        void loadForEffect(true);
    });
  }, [
    addHandler,
    previewRepo,
    previewBranch,
    loadRepo,
    loadBranch,
    hasLoadedPr,
    pr?.number,
    pr?.headRefName,
  ]);

  const loadDiffGroups = useEffectEvent(() => {
    const files = pr?.files || [];
    if (!diff?.patch || files.length < 3 || !diffLoadPolicy.groupFiles) {
      setDiffGroups(null);
      setDiffGroupsLoading(false);
      return;
    }
    setDiffGroups(null);
    setDiffGroupsLoading(true);
    let live = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const retryLater = () => {
      retryTimer = setTimeout(
        () => setDiffGroupsRetry((attempt) => attempt + 1),
        125_000,
      );
    };
    fetchPrDiffGroups(sessionId, files, diff.patch, loadRepo, loadBranch)
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
  });
  useEffect(
    () => loadDiffGroups(),
    [
      sessionId,
      loadRepo,
      loadBranch,
      diff?.headRefOid,
      diffLoadPolicy.groupFiles,
      pr?.files?.length,
      diffGroupsRetry,
    ],
  );

  // A guide belongs to one target's head commit: the key is what makes a
  // guide from the PR the panel just left read as absent rather than current.
  const guideKey = diff ? `${loadTargetKey}\0${diff.headRefOid}` : "";
  const loadGuide = async () => {
    if (!guideKey) return;
    const generation = ++guideGenerationRef.current;
    const isCurrent = () => generation === guideGenerationRef.current;
    setGuideLoading(true);
    setGuideFailed(false);
    try {
      const data =
        previewRepo && previewBranch
          ? await fetchPrPreviewGuide(previewRepo, previewBranch)
          : await fetchReviewGuide(sessionId, loadRepo, loadBranch);
      if (isCurrent()) {
        if (data) setGuide({ key: guideKey, data });
        else setGuideFailed(true);
      }
    } catch {
      if (isCurrent()) setGuideFailed(true);
    }
    if (isCurrent()) setGuideLoading(false);
  };
  const loadGuideForEffect = useEffectEvent(loadGuide);

  const prPatchVersion = diff?.diffVersion || "";
  const codeFlowKey =
    diff && prPatchVersion
      ? `${loadTargetKey}\0${diff.headRefOid}\0${prPatchVersion}`
      : "";
  const loadCodeFlow = async () => {
    if ((!diff?.patch && !diff?.skippedFiles) || !codeFlowKey) return;
    const generation = ++codeFlowGenerationRef.current;
    const isCurrent = () => generation === codeFlowGenerationRef.current;
    setCodeFlowLoading(true);
    setCodeFlowError(null);
    try {
      const data =
        previewRepo && previewBranch
          ? await fetchPrPreviewCodeFlow(previewRepo, previewBranch)
          : await fetchPrCodeFlow(sessionId, loadRepo, loadBranch);
      if (!data) {
        if (isCurrent())
          setCodeFlowError("Code flow isn't available for this pull request.");
      } else if (data.diffVersion !== prPatchVersion) {
        if (isCurrent()) {
          setCodeFlowError(
            "The pull request updated while code flow was loading. Try again.",
          );
        }
      } else if (isCurrent()) {
        setCodeFlow({ key: codeFlowKey, data });
      }
    } catch (error: unknown) {
      if (isCurrent())
        setCodeFlowError(errorMessage(error, "Couldn't load code flow."));
    }
    if (isCurrent()) setCodeFlowLoading(false);
  };
  const loadCodeFlowForEffect = useEffectEvent(loadCodeFlow);

  const refreshCodeFlow = async () => {
    codeFlowGenerationRef.current += 1;
    setCodeFlow(null);
    setCodeFlowError(null);
    setCodeFlowLoading(true);
    await load(true);
    setCodeFlowLoading(false);
  };

  // The guide is generated on demand (the first request per head commit takes
  // the model a while) — only fetch once the reviewer opens the Guide tab, and
  // refetch when a new push moves the head commit.
  const hasSkippedFiles = !!diff?.skippedFiles;
  // A different PR or a new head commit is a different guide: drop the in-flight
  // and failed flags with it, or one failure would disable auto-load for the
  // rest of the panel's life. The keyed `guide` itself goes stale on its own.
  useEffect(() => {
    guideGenerationRef.current += 1;
    setGuideLoading(false);
    setGuideFailed(false);
  }, [guideKey]);

  useEffect(() => {
    if (!showingGuide || !diff?.patch || !guideKey) return;
    if (guideLoading || guideFailed) return;
    if (guide?.key === guideKey) return;
    void loadGuideForEffect();
  }, [
    showingGuide,
    diff?.patch,
    guideKey,
    guide,
    guideLoading,
    guideFailed,
    sessionId,
    previewRepo,
    previewBranch,
    loadRepo,
    loadBranch,
  ]);

  const changeCodeView = useEffectEvent(onCodeViewChange);
  useEffect(() => {
    if (!showingFlow || codeFlowLoading || codeFlowError) return;
    if (!diff?.patch && !hasSkippedFiles) {
      if (diffLoading || diffOutOfDate) return;
      changeCodeView("all");
      return;
    }
    if (codeFlow && codeFlow.key !== codeFlowKey) {
      setCodeFlowError(
        "The pull request updated. Refresh code flow to analyze the latest diff.",
      );
      return;
    }
    if (!codeFlow) void loadCodeFlowForEffect();
  }, [
    showingFlow,
    diff?.patch,
    hasSkippedFiles,
    diffLoading,
    diffOutOfDate,
    codeFlow,
    codeFlowKey,
    codeFlowLoading,
    codeFlowError,
    sessionId,
    prPatchVersion,
    previewRepo,
    previewBranch,
    loadRepo,
    loadBranch,
  ]);

  const retryPr = () => {
    setLoading(true);
    setLoadError(null);
    void load(true);
  };
  const retryDiff = () => {
    setDiffLoading(true);
    setDiffError(null);
    void load(true);
  };
  const resetCodeFlowError = () => {
    setCodeFlow(null);
    setCodeFlowError(null);
  };

  return {
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
    guideKey,
    currentGuide: guide?.key === guideKey ? guide.data : null,
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
  };
}
