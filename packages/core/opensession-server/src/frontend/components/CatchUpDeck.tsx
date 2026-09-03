import React, { useEffect, useEffectEvent, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import type {
  UnifiedSession,
  Workspace,
  TranscriptEntry,
  WSClientMessage,
} from "../lib/types";
import {
  fetchTranscript,
  fetchModels,
  fetchProviderAccounts,
  fetchFileMentions,
  fetchMentionSuggestions,
  fetchSkillMentions,
  type ModelOption,
  type ProviderAccountOption,
} from "../lib/api";
import { loadDraft, saveDraft } from "../lib/drafts";
import { Button } from "../ui/button";
import { InlineAlert } from "../ui/state";
import type { FileAttachment } from "../lib/images";
import { getReads, isUnread, markRead } from "../lib/reads";
import { TranscriptBlocks } from "./TranscriptBlocks";
import { Composer } from "./Composer";
import { useCurrentUser } from "./UserPicker";
import { shortTime, elapsedSince } from "../lib/time";
import { SwipeCard } from "../ui/swipe-deck";
import { PulseDot } from "../ui/status";
import {
  PhoneTopBar,
  PhoneTopBarAction,
  PhoneTopBarTitle,
} from "../ui/top-bar";
import { IconChevronLeft, IconPlus } from "./icons";
import { errorMessage } from "../lib/error-message";

/**
 * Catch-up deck — a Slack-style "swipe through your unread" card stack. Each
 * card is one of your unread workspaces: you can read the full conversation and
 * reply inline, then act to advance:
 *   swipe left  / Archive      → archive the workspace, next
 *   swipe right / Mark as Read → mark it read, next
 *   tap up      / Keep Unread  → skip without changing state, next
 *   reply                      → sends the message, marks read, next
 * The queue is snapshotted once (frozen) so marking-read / archiving / live
 * activity doesn't reshuffle the cards out from under you as you go.
 */

const DEFAULT_REPO = "repository";

type Action = "archive" | "read" | "keep";

interface CatchupCard {
  key: string;
  workspaceId: string | null;
  name: string;
  sessions: UnifiedSession[]; // createdAt asc
  repo: string;
  owner: string;
  lastActivity: string;
}

/** The session a read/reply lands on: the freshest one in the workspace. */
function replyTarget(card: CatchupCard): UnifiedSession {
  return card.sessions.reduce((best, c) =>
    c.lastActivity > best.lastActivity ? c : best,
  );
}

interface Props {
  sessions: UnifiedSession[];
  workspaces: Workspace[];
  /** WebSocket sender — used to post a reply into a session. */
  send: (msg: WSClientMessage) => void;
  connected: boolean;
  /** Archive every session in a workspace (reuses App's archive handler). */
  onArchive: (sessions: UnifiedSession[]) => void;
  /** Open the real session behind a card. */
  onOpenSession: (id: string) => void;
  /** Start a fresh workspace (opens the new-session palette). */
  onNewWorkspace: () => void;
  /** Leave the deck (back / done). */
  onExit: () => void;
}

export function CatchUpDeck({
  sessions,
  workspaces,
  send,
  connected,
  onArchive,
  onOpenSession,
  onNewWorkspace,
  onExit,
}: Props) {
  const currentUser = useCurrentUser();

  // Model / subscription options for the reply composer (fetched once, shared
  // across cards). Empty until they load — the composer degrades gracefully.
  const [models, setModels] = useState<ModelOption[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [modelLoadError, setModelLoadError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<ProviderAccountOption[]>([]);
  const [accountLoadError, setAccountLoadError] = useState<string | null>(null);
  useEffect(() => {
    fetchModels()
      .then((m) => {
        setModels(m.models);
        setDefaultModel(m.default);
      })
      .catch((cause: unknown) =>
        setModelLoadError(errorMessage(cause, "Could not load models")),
      );
    fetchProviderAccounts({
      onPoolError: (cause) =>
        setAccountLoadError(
          errorMessage(cause, "Could not load provider accounts"),
        ),
    })
      .then(setAccounts)
      .catch((cause: unknown) =>
        setAccountLoadError(
          errorMessage(cause, "Could not load provider accounts"),
        ),
      );
  }, []);

  // The unread queue is snapshotted once and then frozen — subsequent refreshes
  // (from our own mark-read / archive / reply, or live WS activity) must not
  // reorder or drop cards mid-swipe. It's frozen on the first render where the
  // session list has actually loaded, NOT on the very first mount: a deep-link
  // to <base>/catchup mounts before `sessions` arrives, and freezing []
  // there would strand the deck on "All caught up" forever.
  const [frozen, setFrozen] = useState<CatchupCard[] | null>(null);
  const live = (() => {
    const reads = getReads();
    const me = currentUser.toLowerCase();
    const unread = sessions.filter(
      (s) =>
        !s.archived &&
        !s.automation &&
        // The Desk is a summonable overlay you already read as you talk to
        // it (⌘J), not work to catch up on.
        !s.desk &&
        // A spawned worker is an implementation detail of its parent, the
        // same rule the workspace rows apply, so it never puts a card in
        // the queue on its own.
        !s.parentSessionId &&
        !!s.startedBy &&
        s.startedBy.toLowerCase() === me &&
        isUnread(s.id, s.lastActivity, reads),
    );
    const groups = new Map<string, UnifiedSession[]>();
    const order: string[] = [];
    for (const s of unread) {
      const key = s.workspaceId ? `ws:${s.workspaceId}` : `session:${s.id}`;
      if (!groups.has(key)) {
        groups.set(key, []);
        order.push(key);
      }
      groups.get(key)!.push(s);
    }
    const out = order.map((key): CatchupCard => {
      const sessions = groups
        .get(key)!
        .slice()
        .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
      const wsId = key.startsWith("ws:") ? key.slice(3) : null;
      const ws = wsId ? workspaces.find((p) => p.id === wsId) : null;
      return {
        key,
        workspaceId: wsId,
        // Workspace name first, the same rule the sidebar rows follow: the
        // server stamps it on every session, so a card is titled correctly
        // before the workspace list has loaded.
        name:
          ws?.name ||
          sessions.find((c) => c.workspaceName)?.workspaceName ||
          sessions[0].title,
        sessions,
        repo: sessions[0].repo || DEFAULT_REPO,
        owner: sessions[0].startedBy || "",
        lastActivity: sessions.reduce(
          (m, c) => (c.lastActivity > m ? c.lastActivity : m),
          "",
        ),
      };
    });
    out.sort((a, b) =>
      (b.lastActivity || "").localeCompare(a.lastActivity || ""),
    );
    return out;
  })();
  const cards = frozen ?? live;
  // Freeze once the list has loaded (even to an empty queue — that's a
  // genuine "all caught up"). While it's still empty we keep recomputing.
  useEffect(() => {
    if (frozen === null && sessions.length > 0) setFrozen(live);
  }, [frozen, sessions.length, live]);

  const [index, setIndex] = useState(0);
  const [dir, setDir] = useState<Action | null>(null);
  const card = cards[index];
  const total = cards.length;
  const remaining = total - index;

  function act(action: Action) {
    if (!card) return;
    if (action === "read") {
      for (const c of card.sessions) markRead(c.id, c.lastActivity);
    } else if (action === "archive") {
      onArchive(card.sessions);
    }
    setDir(action);
    setIndex((i) => i + 1);
  }

  // After a reply is sent (by the card's composer, into the freshest session),
  // mark the workspace read and advance — same as a right-swipe.
  function onReplied() {
    if (card) act("read");
  }

  // Keyboard: ←/→ act, ↑ skip, esc leaves. (Space is left for the composer.)
  // The subscription is stable; the Effect Event reads the current card and
  // callbacks without tearing down the window listener on every swipe.
  const handleDeckKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.key === "Escape") return onExit();
    if (!card) return;
    // Don't hijack arrows while typing a reply.
    if (
      e.target instanceof HTMLTextAreaElement ||
      e.target instanceof HTMLInputElement
    )
      return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      act("archive");
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      act("read");
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      act("keep");
    }
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => handleDeckKey(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const done = index >= total;
  const next = cards[index + 1];

  return (
    // `isolate` scopes the z-indexes the two bars use to hold the card stack
    // under them, so they cannot climb over the app's own chrome.
    <div className="isolate flex min-h-0 flex-1 flex-col items-center bg-surface">
      {/* Header: back + "N Left" counter + new-workspace (Slack-style). This is
			    the deck's only top bar — the app's mobile back bar is suppressed for
			    the catch-up view — so it carries the safe-area top inset itself.
			    The chevron is that suppressed bar's stand-in and stays phone-only:
			    on desktop the sidebar (and its ‹ caret) is always there, no other
			    view offers a back control, and the pane's left edge belongs to the
			    collapsed-sidebar controls. Esc still leaves the deck.

			    It owns a fill and sits above the card stack: a dragged card tilts
			    up to 9°, which lifts its top corner well past its own box (65px on
			    a desktop-width card), and the up-fling of Keep Unread crosses the
			    whole row. Cards pass UNDER the bar instead of over it, so the
			    counter stays readable through every swipe. */}
      <PhoneTopBar className="relative z-10 w-full bg-surface px-4 pb-3 pt-[max(12px,env(safe-area-inset-top))] phone:h-auto">
        <PhoneTopBarAction
          className="hidden phone:inline-flex"
          onClick={onExit}
          title="Back"
          aria-label="Back"
          icon={<IconChevronLeft size={24} />}
        />
        <PhoneTopBarTitle className="absolute left-1/2 -translate-x-1/2 text-sm font-semibold">
          {done ? "All caught up" : `${remaining} Left`}
        </PhoneTopBarTitle>
        {/* ml-auto, not just justify-between: with Back hidden this is the
				    row's only in-flow child on desktop. */}
        <PhoneTopBarAction
          className="ml-auto"
          onClick={onNewWorkspace}
          title="New workspace"
          aria-label="New workspace"
          icon={<IconPlus size={24} />}
        />
      </PhoneTopBar>

      {!done && (modelLoadError || accountLoadError) && (
        <div className="flex w-full max-w-[860px] flex-col gap-2 px-4">
          {modelLoadError && (
            <InlineAlert onDismiss={() => setModelLoadError(null)}>
              {modelLoadError}
            </InlineAlert>
          )}
          {accountLoadError && (
            <InlineAlert onDismiss={() => setAccountLoadError(null)}>
              {accountLoadError}
            </InlineAlert>
          )}
        </div>
      )}

      {done ? (
        <CaughtUp total={total} onExit={onExit} />
      ) : (
        <div className="relative flex w-full max-w-[860px] flex-1 items-center justify-center px-4 pb-4">
          {/* Peek of the next card behind the top one, for depth. */}
          {next && (
            <div
              className="absolute inset-x-4 top-1 bottom-5 scale-[0.97] rounded-xl bg-panel opacity-60"
              aria-hidden
            />
          )}
          <AnimatePresence initial={false} custom={dir}>
            {/* Exit flings left for archive, right for read, up for skip;
						    the card is already absolutely positioned, so no popOnExit. */}
            <SwipeCard
              key={card.key}
              className="absolute inset-x-4 top-1 bottom-5"
              custom={dir}
              exitFor={(a) =>
                a === "archive"
                  ? "left"
                  : a === "read"
                    ? "right"
                    : a === "keep"
                      ? "up"
                      : null
              }
              exitDistance={560}
              stampLeft="Archive"
              stampRight="Read"
              onSwipeLeft={() => act("archive")}
              onSwipeRight={() => act("read")}
            >
              <CardBody
                card={card}
                connected={connected}
                models={models}
                defaultModel={defaultModel}
                accounts={accounts}
                send={send}
                currentUser={currentUser}
                onOpen={() => onOpenSession(replyTarget(card).id)}
                onReplied={onReplied}
              />
            </SwipeCard>
          </AnimatePresence>
        </div>
      )}

      {/* Action bar (works without gestures; mirrors the screenshot). Above
			    the card stack for the same reason the header is: a tilted card
			    reaches past its own box at both ends. */}
      {!done && (
        <div className="relative z-10 flex w-full max-w-[860px] shrink-0 items-stretch gap-2.5 bg-surface px-4 pb-[max(16px,env(safe-area-inset-bottom))]">
          <Button
            size="lg"
            className="flex-1 py-3 text-sm"
            onClick={() => act("keep")}
            title="Keep unread (↑)"
          >
            Keep Unread
          </Button>
          <Button
            variant="danger"
            size="lg"
            /* The soft fill is always on here rather than only on hover:
						   this is a standing choice in a triage deck, not a
						   warning you hover into. */
            className="bg-red-soft py-3 text-sm"
            onClick={() => act("archive")}
            title="Archive (←)"
            aria-label="Archive"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
            >
              <rect x="2.25" y="2.75" width="11.5" height="3" rx="0.6" />
              <path d="M3.25 5.75v6.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1v-6.5" />
              <path d="M6.5 8.5h3" strokeLinecap="round" />
            </svg>
          </Button>
          <Button
            /* Strong green, not `primary` — this is the affirmative half of
						   the pair, not the app's accent CTA, and it commits rather
						   than proposes, because it's the deck's dominant action. */
            variant="success-strong"
            size="lg"
            className="flex-1 py-3 text-sm"
            onClick={() => act("read")}
            title="Mark as read (→)"
          >
            Mark as Read
          </Button>
        </div>
      )}
    </div>
  );
}

function CardBody({
  card,
  connected,
  models,
  defaultModel,
  accounts,
  send,
  currentUser,
  onOpen,
  onReplied,
}: {
  card: CatchupCard;
  connected: boolean;
  models: ModelOption[];
  defaultModel: string;
  accounts: ProviderAccountOption[];
  send: (msg: WSClientMessage) => void;
  currentUser: string;
  onOpen: () => void;
  onReplied: () => void;
}) {
  const target = replyTarget(card);
  const [entries, setEntries] = useState<TranscriptEntry[] | null>(null);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const scrollElRef = useRef<HTMLDivElement | null>(null);
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(
    null,
  );
  const contentElRef = useRef<HTMLDivElement | null>(null);
  const [nodesVersion, setNodesVersion] = useState(0);
  // These callback refs update state, so their identities must remain stable:
  // React detaches an old callback ref with null before attaching a new one.
  const [setScrollEl] = useState(() => (node: HTMLDivElement | null) => {
    if (scrollElRef.current === node) return;
    scrollElRef.current = node;
    setScrollElement(node);
    setNodesVersion((version) => version + 1);
  });
  const [setContentEl] = useState(() => (node: HTMLDivElement | null) => {
    if (contentElRef.current === node) return;
    contentElRef.current = node;
    setNodesVersion((version) => version + 1);
  });
  const pinned = useRef(true);
  const shouldMaintainEnd = () => pinned.current;

  useEffect(() => {
    let alive = true;
    setEntries(null);
    setTranscriptError(null);
    pinned.current = true;
    fetchTranscript(target.id)
      .then((e) => {
        if (alive) setEntries(e);
      })
      .catch((cause: unknown) => {
        if (!alive) return;
        setTranscriptError(errorMessage(cause, "Could not load transcript"));
        setEntries([]);
      });
    return () => {
      alive = false;
    };
  }, [target.id]);

  // Open on the newest message (the unread part), like Slack lands you at the
  // bottom of the thread — and STAY there. One scroll-to-bottom when the
  // entries land is not enough: markdown, syntax highlighting, images and the
  // live ticker all resolve after that paint, and each one grows the
  // transcript under a scroll position that was correct when it was set,
  // leaving the last message below the fold. Follow the content until the
  // reader scrolls away from the bottom themselves.
  useEffect(() => {
    const scrollEl = scrollElRef.current;
    const contentEl = contentElRef.current;
    if (!scrollEl || !contentEl) return;
    // Wrapped in an object so the closures below mutate a property, not a
    // captured binding (which the compiler rejects).
    const pos = { last: scrollEl.scrollTop };
    const toBottom = () => {
      scrollEl.scrollTop = scrollEl.scrollHeight;
      pos.last = scrollEl.scrollTop;
    };
    toBottom();
    // Unpin on the reader moving UP, never on distance alone. A running
    // session grows between our scroll and the event it fires, so measuring
    // "am I at the bottom" in the handler reads our own catch-up as the
    // reader walking away, and the card stops following after one tick.
    const onScroll = () => {
      const top = scrollEl.scrollTop;
      if (top < pos.last - 1) pinned.current = false;
      else if (scrollEl.scrollHeight - scrollEl.clientHeight - top <= 24)
        pinned.current = true;
      pos.last = top;
    };
    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    const observer = new ResizeObserver(() => {
      if (pinned.current) toBottom();
    });
    observer.observe(contentEl);
    observer.observe(scrollEl);
    return () => {
      observer.disconnect();
      scrollEl.removeEventListener("scroll", onScroll);
    };
  }, [nodesVersion]);

  const meta = [
    card.repo,
    card.sessions.length > 1 ? `${card.sessions.length} sessions` : null,
    card.lastActivity ? shortTime(card.lastActivity) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <button
        className="flex w-full shrink-0 flex-col items-start gap-0.5 border-b border-line bg-transparent px-5 py-3.5 text-left"
        onClick={onOpen}
        title="Open the full session"
      >
        <span className="line-clamp-1 text-item-title font-semibold text-fg">
          {card.name}
        </span>
        <span className="text-xs text-faint">{meta}</span>
      </button>

      {/* touch-pan-y so vertical gestures scroll the transcript but horizontal
			    ones bubble up to the card's drag handler (otherwise the scroll
			    container eats the swipe on touch devices). */}
      <div
        ref={setScrollEl}
        className="catchup-scroll min-h-0 flex-1 touch-pan-y overflow-y-auto px-4 py-3"
      >
        {/* One wrapper so the bottom-pin has a single box to measure: a
				    ResizeObserver on the scroll container itself never sees its
				    content grow. */}
        <div ref={setContentEl}>
          {transcriptError ? (
            <InlineAlert onDismiss={() => setTranscriptError(null)}>
              {transcriptError}
            </InlineAlert>
          ) : entries === null ? (
            <div className="space-y-2">
              <div className="h-3 w-1/3 animate-pulse rounded bg-surface" />
              <div className="h-3 w-full animate-pulse rounded bg-surface" />
              <div className="h-3 w-4/5 animate-pulse rounded bg-surface" />
            </div>
          ) : entries.length === 0 ? (
            <div className="text-sm text-faint">No messages yet.</div>
          ) : (
            <TranscriptBlocks
              entries={entries}
              owner={card.owner}
              scrollElement={scrollElement}
              shouldMaintainEnd={shouldMaintainEnd}
            />
          )}
          {/* Live "still working" ticker: while the session we're reading is mid-run,
					    show a pulsing dot + elapsed clock at the bottom of the transcript so
					    the card reads as in-progress (mirrors SessionViewer's busy row). */}
          {target.isRunning && <CatchupWorking target={target} />}
        </div>
      </div>

      <CatchUpComposer
        target={target}
        connected={connected}
        models={models}
        defaultModel={defaultModel}
        accounts={accounts}
        send={send}
        currentUser={currentUser}
        onReplied={onReplied}
      />
    </>
  );
}

/**
 * The catch-up reply box is the full shared Composer, wired to the card's
 * reply-target session — so a reply from the deck has the same reach as one
 * from the session view: attach images/files, switch the model + reasoning
 * effort, pin a subscription, set a goal, dictate, and @-mention repo files.
 * Model / subscription / goal changes route through the /model, /sub and /goal
 * slash commands (persisted + broadcast server-side), exactly like SessionViewer.
 * Slack sessions can switch models too (the /model command syncs the loop's
 * store server-side); Linear-owned sessions keep the model fixed — that's the
 * owning agent's call — but still get attachments and effort.
 */
function CatchUpComposer({
  target,
  connected,
  models,
  defaultModel,
  accounts,
  send,
  currentUser,
  onReplied,
}: {
  target: UnifiedSession;
  connected: boolean;
  models: ModelOption[];
  defaultModel: string;
  accounts: ProviderAccountOption[];
  send: (msg: WSClientMessage) => void;
  currentUser: string;
  onReplied: () => void;
}) {
  // Share the session's draft with the main session view (same key), so a reply
  // half-typed here shows up there and vice-versa. Images/files are parked in
  // the same draft record (Composer only owns the text).
  const draftKey = `session:${target.id}`;
  const [images, setImages] = useState<string[]>(
    () => loadDraft(draftKey).images,
  );
  const [files, setFiles] = useState<FileAttachment[]>(
    () => loadDraft(draftKey).files,
  );
  useEffect(() => {
    saveDraft(draftKey, { images, files });
  }, [draftKey, images, files]);

  const [model, setModel] = useState(target.model || "");
  const [accountId, setAccountId] = useState(target.accountId || "");
  const [effort, setEffort] = useState("high");
  // Optimistic goal (the /goal command persists but doesn't broadcast a live
  // update); `undefined` defers to the session's stored goal.
  const [goalOverride, setGoalOverride] = useState<string | null | undefined>(
    undefined,
  );
  const currentGoal =
    goalOverride !== undefined ? goalOverride : (target.goal ?? null);

  const isNative = target.source === "opensession";
  // Send the reply into the target session (images fold in as content blocks;
  // files route to the queue server-side), then advance the deck.
  function handleSend(
    raw: string,
    opts?: { steer?: boolean; pastedTexts?: string[] },
  ): boolean {
    const text = raw.trim();
    const pastedTexts = opts?.pastedTexts ?? [];
    if (
      !text &&
      images.length === 0 &&
      files.length === 0 &&
      pastedTexts.length === 0
    )
      return false;
    if (!connected) return false;
    // Prefer the staged disk path (HTTP upload); fall back to inline dataUrl.
    const filePayload = files.map((f) =>
      f.path
        ? { name: f.name, path: f.path }
        : { name: f.name, dataUrl: f.dataUrl },
    );
    const message: Extract<WSClientMessage, { type: "prompt" }> = {
      type: "prompt",
      sessionId: target.id,
      content: text,
      user: currentUser,
      effort,
    };
    if (images.length > 0) message.images = images;
    if (files.length > 0) message.files = filePayload;
    if (pastedTexts.length > 0) message.pastedTexts = pastedTexts;
    send(message);
    setImages([]);
    setFiles([]);
    onReplied();
    return true;
  }

  // Model / account / goal all route through their slash commands (they
  // persist, notice, and broadcast to other viewers) — mirrors SessionViewer.
  function handleModelChange(next: string) {
    const targetModel = next || defaultModel;
    if (!targetModel || targetModel === (model || defaultModel)) return;
    setModel(next);
    send({
      type: "prompt",
      sessionId: target.id,
      content: `/model ${targetModel}`,
      user: currentUser,
    });
  }
  function handleAccountChange(next: string) {
    if (next === (accountId || "")) return;
    setAccountId(next);
    const acct = next ? accounts.find((a) => a.id === next) : null;
    send({
      type: "prompt",
      sessionId: target.id,
      content: next ? `/account ${acct?.id || next}` : "/account auto",
      user: currentUser,
    });
  }
  function handleSetGoal(goal: string | null) {
    setGoalOverride(goal);
    send({
      type: "prompt",
      sessionId: target.id,
      content: goal ? `/goal ${goal}` : "/goal clear",
      user: currentUser,
    });
  }

  return (
    // Stop pointerdown from reaching the card's drag handler so typing, the
    // menus and text selection in the composer never start a swipe.
    <div
      className="shrink-0 border-t border-line p-2.5"
      onPointerDownCapture={(e) => e.stopPropagation()}
    >
      <Composer
        config={{
          draftKey,
          placeholder: connected ? "Reply…" : "Not connected",
          disabled: !connected,
          sendDisabled: (text) =>
            !text.trim() && images.length === 0 && files.length === 0,
          images,
          files,
          models,
          defaultModel,
          model,
          modelDisabled: !isNative && target.source !== "slack",
          modelTitle:
            isNative || target.source === "slack"
              ? "Switch the model for this session"
              : "Set the model from the owning agent (its session file is agent-owned)",
          effort,
          accounts: isNative ? accounts : undefined,
          accountId,
          goal: currentGoal,
        }}
        actions={{
          onSend: handleSend,
          onImagesChange: setImages,
          onFilesChange: setFiles,
          onModelChange: handleModelChange,
          onEffortChange: setEffort,
          onAccountChange: isNative ? handleAccountChange : undefined,
          onSetGoal: isNative ? handleSetGoal : undefined,
          mentionFetch: (query) => fetchFileMentions(query, target.id),
          paletteFetch: (query) =>
            fetchMentionSuggestions(query, target.id, currentUser),
          skillsFetch: (query) => fetchSkillMentions(query, target.id),
        }}
      />
    </div>
  );
}

/**
 * Live "still working" ticker shown at the tail of a card's transcript while the
 * session is mid-run. Self-ticks once a second so the re-render stays inside this
 * tiny node. Anchors to the run's start (runStartedAt, which survives a refresh),
 * falling back to lastActivity for external runs that never stamped one.
 */
function CatchupWorking({ target }: { target: UnifiedSession }) {
  const raw = target.runStartedAt || target.lastActivity;
  const t = raw ? Date.parse(raw) : NaN;
  const since = Number.isNaN(t) ? Date.now() : t;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="mt-2 flex items-center gap-2 px-1 text-xs text-faint">
      <PulseDot />
      <span>Working</span>
      <span className="tabular-nums">{elapsedSince(since, now)}</span>
    </div>
  );
}

function CaughtUp({ total, onExit }: { total: number; onExit: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="text-4xl">✨</div>
      <div className="text-item-title font-semibold text-fg">All caught up</div>
      <div className="max-w-xs text-sm text-dim">
        {total > 0
          ? `You went through ${total} workspace${total === 1 ? "" : "s"}.`
          : "Nothing unread right now."}
      </div>
      <Button size="lg" className="mt-2 text-sm" onClick={onExit}>
        Done
      </Button>
    </div>
  );
}
