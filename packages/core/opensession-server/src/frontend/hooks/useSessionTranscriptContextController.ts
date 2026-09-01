import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Dispatch, MouseEvent, SetStateAction } from "react";
import { loadDraft } from "../lib/drafts";
import type { FileAttachment } from "../lib/images";
import { prReviewCompletion } from "../lib/review-queue";
import type { Quote } from "../lib/quotes";
import type { UnifiedSession } from "../lib/types";

interface TranscriptContextIdentity {
  session: UnifiedSession;
  sessionHidden: boolean;
}

interface TranscriptContextDraft {
  draftKey: string;
  images: string[];
  files: FileAttachment[];
  contextSessions: string[];
  setContextSessions: Dispatch<SetStateAction<string[]>>;
}

interface TranscriptContextWorkspace {
  allSessions: UnifiedSession[] | undefined;
  workspaceSessions: UnifiedSession[] | undefined;
}

interface TranscriptContextNavigation {
  openSession: ((sessionId: string) => void) | undefined;
  openAsset: (path: string) => void;
}

interface SessionTranscriptContextOptions {
  identity: TranscriptContextIdentity;
  draft: TranscriptContextDraft;
  workspace: TranscriptContextWorkspace;
  navigation: TranscriptContextNavigation;
}

export function useSessionTranscriptContextController({
  identity: { session, sessionHidden },
  draft: { draftKey, images, files, contextSessions, setContextSessions },
  workspace: { allSessions, workspaceSessions },
  navigation: { openSession, openAsset: openAssetFromTranscript },
}: SessionTranscriptContextOptions) {
  // Session and asset links navigate on a delegated click. markdown.ts renders
  // them into dangerouslySetInnerHTML, where they cannot carry React handlers;
  // data attributes identify which in-app surface should open.
  const handleMessagesClick = useCallback(
    (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const assetEl = target.closest("[data-asset-path]");
      const assetPath =
        assetEl instanceof HTMLElement ? assetEl.dataset.assetPath : undefined;
      if (assetPath) {
        // Modified clicks keep the anchor's raw-file fallback and native new-tab
        // behaviour. A normal click stays in context, in the asset preview.
        if (
          (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) &&
          assetEl?.getAttribute("href")
        )
          return;
        event.preventDefault();
        openAssetFromTranscript(assetPath);
        return;
      }
      const sessionEl = target.closest("[data-session-id]");
      const id =
        sessionEl instanceof HTMLElement
          ? sessionEl.dataset.sessionId
          : undefined;
      if (!id || !openSession) return;
      // Modified clicks on href-carrying chips (markdown links to session
      // URLs) keep native browser behavior (open in new tab, etc.).
      if (
        (event.metaKey || event.ctrlKey || event.shiftKey) &&
        sessionEl?.getAttribute("href")
      )
        return;
      event.preventDefault();
      openSession(id);
    },
    [openSession, openAssetFromTranscript],
  );

  // The transcript passage explicitly attached to the next message. It stays
  // highlighted until the message sends or the person removes it.
  const [quote, setQuote] = useState<Quote | null>(null);
  const clearQuote = useCallback(() => setQuote(null), []);
  // Whether a draft is in the way of reopening a message in the composer, read
  // through a ref. Every value it reads changes as you type or attach, and
  // the transcript's onEditMessage has to keep one identity across all of
  // that: the memoized TranscriptBlocks is what stands between a keystroke
  // and a re-render of the whole conversation.
  const composerDraftRef = useRef({
    draftKey,
    images,
    files,
    quote,
    contextSessions,
  });
  useLayoutEffect(() => {
    composerDraftRef.current = {
      draftKey,
      images,
      files,
      quote,
      contextSessions,
    };
  }, [draftKey, images, files, quote, contextSessions]);
  const composerHasDraft = useCallback(() => {
    const current = composerDraftRef.current;
    const stored = loadDraft(current.draftKey);
    return Boolean(
      stored.text.trim() ||
      stored.pastedTexts.length ||
      current.images.length ||
      current.files.length ||
      current.quote ||
      current.contextSessions.length,
    );
  }, []);
  // Switching sessions drops staged selections: they quote THAT transcript.
  useEffect(() => {
    setQuote(null);
  }, [session.id]);
  // Full-width view tabs unmount the transcript and its visible highlight. Do
  // not leave that context invisibly attached when the conversation returns.
  useEffect(() => {
    if (sessionHidden) setQuote(null);
  }, [sessionHidden]);
  const [showAllContextSessions, setShowAllContextSessions] = useState(false);
  const contextSessionOptions = useMemo(() => {
    // Whole workspace, archived sessions included — the common case is exactly a
    // closed (archived-after-merge) sibling whose context the new session needs.
    // workspaceSessions (the live tab strip) is the fallback when the session has no
    // workspace id of its own.
    const siblings = session.workspaceId
      ? (allSessions || []).filter(
          (candidate) => candidate.workspaceId === session.workspaceId,
        )
      : workspaceSessions || [];
    return siblings
      .filter(
        (candidate) =>
          candidate.id !== session.id &&
          // Legacy hidden sessions are not valid workspace context options.
          // Only sessions with something to hand over — a session that has
          // actually run a turn. These are LIST rows, so `ran` is the only
          // form of that answer they carry.
          candidate.ran,
      )
      .sort((left, right) =>
        (right.lastActivity || "").localeCompare(left.lastActivity || ""),
      );
  }, [allSessions, workspaceSessions, session.id, session.workspaceId]);
  const resetContextSessions = useEffectEvent(() => setContextSessions([]));
  useEffect(() => {
    resetContextSessions();
    setShowAllContextSessions(false);
  }, [session.id]);

  // Whose Desk this is. Every Desk is titled "Desk" and carries no repo, so
  // the owner is the only thing that tells one apart from another — see the
  // mobile title pill's leading slot.
  const deskOwner = session.desk ? session.startedBy || "" : "";
  // The review request is stored per session, but the sidebar's "Awaiting/Needs
  // review" bands group by workspace — so a request set on a sibling session lit
  // the band while the open session's Reviewer chip read empty. Surface the
  // workspace's request in the chip: the open session's own if it has one, else a
  // sibling's, carrying the owner id so clear/re-assign target the right session.
  // GitHub reviews can complete an explicit request; GitHub's own requested
  // reviewers ride alongside as `prReviewRequested`, since being added as a
  // reviewer on the PR is the other way a review lands on you. It writes no
  // Open Session request — only the picker does that — so the chip reads both.
  const owner = session.reviewRequest
    ? session
    : (workspaceSessions || []).find((candidate) => candidate.reviewRequest);
  const request = owner?.reviewRequest ?? null;
  const completion =
    owner && request ? prReviewCompletion(request, owner) : null;
  const effectiveReview = {
    req: request
      ? completion
        ? { ...request, accepted: completion }
        : request
      : null,
    ownerId: owner?.id ?? session.id,
    acceptedFromPr: !!completion,
    // A workspace can span several PRs; a request on any of them is a
    // request on the workspace, which is the unit the chip speaks for.
    prReviewRequested: [
      ...new Set(
        (workspaceSessions?.length ? workspaceSessions : [session]).flatMap(
          (candidate) => candidate.prReviewRequested || [],
        ),
      ),
    ],
  };

  return {
    quote: { quote, setQuote, clearQuote },
    draft: { composerHasDraft },
    context: {
      showAllContextSessions,
      setShowAllContextSessions,
      contextSessionOptions,
    },
    navigation: { handleMessagesClick },
    metadata: { deskOwner, effectiveReview },
  };
}
