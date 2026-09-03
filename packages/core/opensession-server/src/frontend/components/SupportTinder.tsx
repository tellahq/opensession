import React, {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { AnimatePresence } from "motion/react";
import type { PlainThread, SupportThread } from "../lib/types";
import {
  fetchPlainThreadById,
  fetchSupportThreads,
  setPlainThreadSpamApi,
  setPlainThreadStatusApi,
  startPlainTriageApi,
} from "../lib/api";
import { PlainEntryRow, plainThreadUrl } from "./PlainThreadPanel";
import { useCurrentUser } from "./UserPicker";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { DeckDone, SwipeCard } from "../ui/swipe-deck";
import { dismissToast, toast, type ToastOptions } from "../ui/toast";
import { UNDO_MS, ageLabel, ageTone, shuffle } from "../lib/swipe-deck";
import { errorMessage } from "../lib/error-message";

/**
 * Support Tinder — the swipe deck for the Plain Todo queue, one ticket at
 * a time:
 *   swipe right / Skip  (→ or k) → leave it as-is (status untouched), next
 *   swipe left  / Spam  (← or s) → mark the customer spam (closes thread), next
 *   Session (e) → jump into the ticket's opensession session (reuses the live
 *                 triage session, or boots a fresh triage run if none exists)
 *   Done  (d) → mark the thread Done, next
 *   Plain (o) → open the thread in the Plain app
 *   Back  (b) → previous card · Esc → leave
 * Spam and Done land on the undo stack (z / header ↩ / toast). The deck is
 * shuffled per visit — random order beats the queue's
 * age order here, so old tickets don't wall off the fresh ones.
 */

type Action = "skip" | "spam" | "done";

/** One reversible deck action; `at` is the card's index, for jumping back. */
type UndoEntry =
  | { kind: "spam"; t: SupportThread; at: number }
  | { kind: "done"; t: SupportThread; at: number };

interface Props {
  /** Leave the deck (back / done). */
  onExit: () => void;
  /** Navigate into a session (the Session button resolves one over HTTP). */
  onOpenSession: (id: string) => void;
}

/** Plain thread priorities, as Plain's own UI names them. Filled, not drawn:
 *  the app's chips are a wash of their own tone (lib/plain-status.ts, the
 *  source chips), so an outlined one here read as a different family. */
const PRIORITY = new Map([
  [0, { label: "Urgent", cls: "bg-red-soft text-red" }],
  [1, { label: "High", cls: "bg-yellow-soft text-yellow" }],
  [2, { label: "Normal", cls: "bg-active text-dim" }],
  [3, { label: "Low", cls: "bg-active text-faint" }],
]);

/** The deck's action row keeps a 44px touch target: it is the phone's only
 * path through the queue, and `lg` alone is 36px. */
const DECK_ACTION = "min-h-11";

export function SupportTinder({ onExit, onOpenSession }: Props) {
  const currentUser = useCurrentUser();

  // One fetch per visit; the deck is shuffled once and then frozen — acting
  // on cards never reorders the rest.
  const [deck, setDeck] = useState<SupportThread[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchSupportThreads()
      .then((threads) => {
        if (alive) setDeck(shuffle(threads));
      })
      .catch((e) => {
        if (alive) setError(e.message || String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  const [index, setIndex] = useState(0);
  const [dir, setDir] = useState<Action | null>(null);
  const toastId = useRef<number | null>(null);
  const [busy, setBusy] = useState(false);
  // The busy flag, readable from long-lived closures (toast undo buttons).
  const busyRef = useRef(false);
  useLayoutEffect(() => {
    busyRef.current = busy;
  });
  // Undo stack, newest last. Lives in a ref so toast/keyboard closures always
  // see the current stack; the length mirror re-renders the header ↩ button.
  const historyRef = useRef<UndoEntry[]>([]);
  const [historyLen, setHistoryLen] = useState(0);
  function pushHistory(e: UndoEntry) {
    historyRef.current.push(e);
    setHistoryLen(historyRef.current.length);
  }

  const cards = deck || [];
  const card: SupportThread | undefined = cards[index];
  const done = deck !== null && index >= cards.length;
  const next = cards[index + 1];

  // The card shows the whole conversation, so timelines are fetched lazily —
  // current card + one ahead — and cached for the visit (back stays instant).
  const [timelines, setTimelines] = useState<
    Record<string, PlainThread | "error">
  >({});
  const fetching = useRef(new Set<string>());
  // Reads the live card objects through an effect event, so the trigger set
  // stays "which cards are in view + what is cached".
  const ensureTimelines = useEffectEvent(() => {
    let alive = true;
    for (const t of [card, next]) {
      if (!t || timelines[t.id] || fetching.current.has(t.id)) continue;
      fetching.current.add(t.id);
      fetchPlainThreadById(t.id)
        .then((thread) => {
          if (alive)
            setTimelines((prev) => ({ ...prev, [t.id]: thread || "error" }));
        })
        .catch(() => {
          if (alive) setTimelines((prev) => ({ ...prev, [t.id]: "error" }));
        });
    }
    return () => {
      alive = false;
    };
  });
  useEffect(() => {
    ensureTimelines();
  }, [card?.id, next?.id, timelines]);

  // A new card always starts at the top (the deck area is one normal scroll).
  const deckScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    deckScrollRef.current?.scrollTo(0, 0);
  }, [index]);

  function showToast(text: string, undo?: () => void) {
    if (toastId.current !== null) dismissToast(toastId.current);
    const options: ToastOptions = { duration: UNDO_MS };
    if (undo) {
      options.variant = "success";
      options.action = { label: "Undo", onClick: undo };
    }
    toastId.current = toast(text, options);
  }
  useEffect(
    () => () => {
      if (toastId.current !== null) dismissToast(toastId.current);
    },
    [],
  );

  function advance(action: Action) {
    setDir(action);
    setIndex((i) => i + 1);
  }

  function customerLabel(t: SupportThread): string {
    return t.customer.name || t.customer.email || "customer";
  }

  function skip() {
    if (!card) return;
    advance("skip");
  }

  function spam() {
    if (!card || busy) return;
    const target = card;
    const at = index;
    setBusy(true);
    setPlainThreadSpamApi(target.id, true, currentUser)
      .then(() => {
        setBusy(false);
        pushHistory({ kind: "spam", t: target, at });
        advance("spam");
        showToast(`Marked ${customerLabel(target)} as spam`, undoLast);
      })
      .catch((e) => {
        setBusy(false);
        showToast(`Spam failed: ${e.message}`);
      });
  }

  function markDone() {
    if (!card || busy) return;
    const target = card;
    const at = index;
    setBusy(true);
    setPlainThreadStatusApi(target.id, "done", { user: currentUser })
      .then(() => {
        setBusy(false);
        pushHistory({ kind: "done", t: target, at });
        advance("done");
        showToast(
          `Marked "${target.title || customerLabel(target)}" Done`,
          undoLast,
        );
      })
      .catch((e) => {
        setBusy(false);
        showToast(`Done failed: ${e.message}`);
      });
  }

  // Jump into the ticket's opensession session. The API reuses the newest
  // live session linked to the thread (instant) or boots a fresh triage run
  // (~15-60s) — keep the button in a visible in-progress state the whole way.
  // Navigating away leaves the deck; the ticket's status is untouched.
  const [opening, setOpening] = useState(false);
  function openSession() {
    if (!card || opening) return;
    const target = card;
    setOpening(true);
    startPlainTriageApi(target.id)
      .then((sessionId) => {
        setOpening(false);
        onOpenSession(sessionId);
      })
      .catch((e) => {
        setOpening(false);
        showToast(`Session failed: ${e.message}`);
      });
  }

  // Reverse the newest action on the stack and jump back to its card. Works
  // any time (z / header ↩ / the toast button) — not just while a toast shows.
  function undoLast() {
    if (busyRef.current) return;
    const entry = historyRef.current[historyRef.current.length - 1];
    if (!entry) return;
    const finish = (msg: string) => {
      historyRef.current.pop();
      setHistoryLen(historyRef.current.length);
      setBusy(false);
      setDir(null);
      setIndex(entry.at);
      showToast(msg);
    };
    const fail = (error: Parameters<typeof errorMessage>[0]) => {
      setBusy(false);
      showToast(`Undo failed: ${errorMessage(error, "unknown error")}`);
    };
    setBusy(true);
    if (entry.kind === "spam") {
      // Plain reopens the customer's threads itself on unmark.
      setPlainThreadSpamApi(entry.t.id, false, currentUser)
        .then(() => finish(`Unmarked ${customerLabel(entry.t)} as spam`))
        .catch(fail);
    } else {
      setPlainThreadStatusApi(entry.t.id, "todo", { user: currentUser })
        .then(() =>
          finish(`Back to Todo: ${entry.t.title || customerLabel(entry.t)}`),
        )
        .catch(fail);
    }
  }

  function back() {
    setDir(null);
    setIndex((i) => Math.max(0, i - 1));
  }

  // Keyboard: →/k skip, ←/s spam, e session, d done, o Plain, b back, z undo;
  // Esc leaves the deck.
  // The keymap reads the latest card and actions through an effect event, so
  // the listener subscribes once.
  const supportKeys = useEffectEvent(function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      return onExit();
    }
    const el = e.target instanceof HTMLElement ? e.target : null;
    if (
      el &&
      (el.tagName === "TEXTAREA" ||
        el.tagName === "INPUT" ||
        el.isContentEditable)
    )
      return;
    // Undo works even on the "Deck done" screen (no card left). Plain z,
    // and ⌘Z/^Z for muscle memory.
    if (e.key === "z") {
      e.preventDefault();
      return undoLast();
    }
    if (!card) return;
    if (e.key === "ArrowRight" || e.key === "k") {
      e.preventDefault();
      skip();
    } else if (e.key === "ArrowLeft" || e.key === "s") {
      e.preventDefault();
      spam();
    } else if (e.key === "e") {
      e.preventDefault();
      openSession();
    } else if (e.key === "d") {
      e.preventDefault();
      markDone();
    } else if (e.key === "o" || e.key === "p") {
      e.preventDefault();
      window.open(plainThreadUrl(card.id), "_blank", "noopener");
    } else if (e.key === "b") {
      e.preventDefault();
      back();
    }
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => supportKeys(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col items-center bg-surface">
      {/* Header: back + "N Left" counter, with the phone-only back chevron. */}
      <div className="relative flex w-full items-center justify-between px-4 py-3">
        <Button
          variant="ghost"
          size="md"
          className="hidden phone:inline-flex"
          onClick={onExit}
          title="Back (Esc)"
          aria-label="Back"
          icon={
            <svg width="20" height="20" viewBox="0 0 16 16" fill="none">
              <path
                d="M10 3.5 5.5 8l4.5 4.5"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          }
        />
        <div className="absolute left-1/2 -translate-x-1/2 text-sm font-semibold text-fg">
          {deck === null
            ? "Support Tinder"
            : done
              ? "Queue clear"
              : `${cards.length - index} Left`}
        </div>
        {/* ml-auto: with the chevron hidden this is the row's only in-flow
				    child, and justify-between alone would pack it against the left. */}
        <Button
          variant="ghost"
          size="md"
          className="ml-auto"
          onClick={undoLast}
          disabled={historyLen === 0 || busy}
          title="Undo last action (z)"
          aria-label="Undo last action"
          icon={
            <svg width="20" height="20" viewBox="0 0 16 16" fill="none">
              <path
                d="M6.5 3.5 3 7l3.5 3.5M3 7h6.75A3.25 3.25 0 0 1 13 10.25v.25"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          }
        />
      </div>

      {error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <div className="text-sm font-semibold text-red">
            Couldn't load the queue
          </div>
          <div className="max-w-sm text-sm text-dim">{error}</div>
        </div>
      ) : deck === null ? (
        <div className="flex flex-1 items-center justify-center text-sm text-faint">
          Dealing support tickets…
        </div>
      ) : done ? (
        <DeckDone
          emoji="🎉"
          title="Queue clear"
          message={
            index > 0
              ? `You went through ${index} ticket${index === 1 ? "" : "s"}.`
              : "No Todo tickets right now."
          }
          onExit={onExit}
        />
      ) : (
        /* The deck area scrolls like a normal page: the card is auto-height
				   (the full conversation, no inner scroll pane) and long threads
				   just flow past the fold. */
        <div
          ref={deckScrollRef}
          className="min-h-0 w-full flex-1 overflow-y-auto px-4 pb-4"
        >
          <div className="relative mx-auto w-full max-w-[640px]">
            {/* Peek of the next card behind the top one, for depth. */}
            {next && (
              <div
                className="absolute inset-x-0 -bottom-1.5 top-3 scale-x-[0.97] rounded-xl bg-panel opacity-60"
                aria-hidden
              />
            )}
            <AnimatePresence initial={false} custom={dir}>
              <TicketCard
                key={card!.id}
                thread={card!}
                timeline={timelines[card!.id]}
                custom={dir}
                onSkip={skip}
                onSpam={spam}
              />
            </AnimatePresence>
          </div>
        </div>
      )}

      {/* Action bar (works without gestures). */}
      {deck !== null && !done && !error && (
        <div className="flex w-full max-w-[640px] items-stretch gap-2.5 px-4 pb-[max(16px,env(safe-area-inset-bottom))]">
          <Button
            variant="danger"
            size="lg"
            className={DECK_ACTION}
            onClick={spam}
            disabled={busy}
            title="Mark customer as spam, closes the thread (← or s). Undo available."
          >
            Spam
          </Button>
          <Button
            size="lg"
            className={cn(DECK_ACTION, "flex-1 hover:text-green")}
            onClick={markDone}
            disabled={busy}
            title="Mark this thread Done (d). Undo available."
          >
            Done
          </Button>
          <Button
            size="lg"
            className={cn(DECK_ACTION, "flex-1")}
            onClick={openSession}
            disabled={opening}
            title="Open the ticket's opensession session, starting triage if none exists (e)"
          >
            {opening ? "Opening…" : "Session"}
          </Button>
          <Button
            size="lg"
            className={cn(DECK_ACTION, "flex-1")}
            onClick={() =>
              card && window.open(plainThreadUrl(card.id), "_blank", "noopener")
            }
            title="Open in Plain (o)"
          >
            Plain
          </Button>
          <Button
            variant="success-strong"
            size="lg"
            className={cn(DECK_ACTION, "flex-1")}
            onClick={skip}
            title="Skip, leaving the ticket as-is (→ or k)"
          >
            Skip
          </Button>
        </div>
      )}
    </div>
  );
}

function TicketCard({
  thread,
  timeline,
  custom,
  onSkip,
  onSpam,
}: {
  thread: SupportThread;
  timeline: PlainThread | "error" | undefined;
  custom: Action | null;
  onSkip: () => void;
  onSpam: () => void;
}) {
  const prio =
    thread.priority != null ? PRIORITY.get(thread.priority) : undefined;

  return (
    // Exit flings left for spam/done (dealt with and gone), right for skip;
    // the card lives in normal flow, hence popOnExit.
    <SwipeCard
      className="relative z-10 w-full"
      custom={custom}
      exitFor={(a) => (a === "spam" || a === "done" ? "left" : "right")}
      exitDistance={640}
      popOnExit
      stampLeft="Spam"
      stampRight="Skip"
      onSwipeLeft={onSpam}
      onSwipeRight={onSkip}
    >
      {/* Card head: customer, ages, priority, title. */}
      <div className="shrink-0 border-b border-divider px-5 py-3.5">
        <div className="flex flex-wrap items-center gap-2 text-xs text-faint">
          <span className="font-semibold text-dim">
            {thread.customer.name ||
              thread.customer.email ||
              "Unknown customer"}
          </span>
          {thread.customer.name && thread.customer.email && (
            <span className="truncate">{thread.customer.email}</span>
          )}
          {thread.createdAt && (
            <>
              <span>·</span>
              <span className={ageTone(thread.createdAt, 1, 4)}>
                {ageLabel(thread.createdAt)} old
              </span>
            </>
          )}
          {prio && (
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-meta font-bold tracking-[-0.01em] ${prio.cls}`}
            >
              {prio.label}
            </span>
          )}
        </div>
        <div className="mt-1 text-item-title font-semibold leading-snug text-fg">
          {thread.title || "(no subject)"}
        </div>
      </div>

      {/* Full-height conversation: every message renders, no inner scroll —
			    overflow flows into the deck's normal page scroll. */}
      <div className="flex flex-col gap-3 px-5 py-4">
        {timeline === undefined ? (
          thread.previewText ? (
            <div className="text-label leading-relaxed text-dim">
              {thread.previewText}
            </div>
          ) : (
            <div className="text-sm italic text-faint">
              Loading conversation…
            </div>
          )
        ) : timeline === "error" ? (
          <div className="text-sm text-red">
            Couldn't load the conversation. Open it in Plain.
          </div>
        ) : timeline.entries.length === 0 ? (
          <div className="text-sm italic text-faint">
            No messages in this thread yet.
          </div>
        ) : (
          timeline.entries.map((e) => <PlainEntryRow key={e.id} entry={e} />)
        )}
      </div>
    </SwipeCard>
  );
}
