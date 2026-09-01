/**
 * human-asks — the "human in the loop" registry. Lets an Open Session session ask a
 * *teammate* a question over Slack and fold the answer back into the session,
 * the way the AskUserQuestion machinery asks the session's own driver.
 *
 * Two axes (see src/agents/slack/humans-tools.ts for the tool surface):
 *  - mode: "block" holds the agent's turn open until the teammate replies (bounded
 *    by BLOCK_TIMEOUT_MS, then it degrades to async so a late reply still lands);
 *    "async" returns immediately and the reply is steered into the session later.
 *  - deliver: "now" pings immediately; "when_done" / "on_pr" hold the ping until the
 *    session next goes idle / has opened a PR; { atIso } fires at a scheduled time.
 *
 * Slack is the *fallback* channel, not always the first one: an async ask aimed
 * at the person already driving a web session (see shouldAskInUiFirst) is posed
 * as a question card in that session first, and only DM'd if it goes unanswered
 * for UI_FIRST_WINDOW_MS — the same "OS1 first, Slack after 4 minutes" shape the
 * AskUserQuestion path uses (src/server/asks.ts). The card stays live in
 * parallel once the DM goes out; whoever answers first wins.
 *
 * This module owns the ask *data* (the map + disk persistence + reply matching +
 * audit). The two things only the main opensession process can do — steer an answer
 * into a live session and broadcast — it reaches through the session-control
 * registry (tryGetSessionControl), exactly like the opensession-sessions MCP does.
 * The Slack transport (DM send + option cards) is imported directly from the
 * Slack agent's slack-api helpers; nothing there imports back into the server, so
 * there's no import cycle.
 *
 * Wired into interactive runs only (Slack + Open Session sessions), never automation
 * runs — same privilege boundary as opensession-sessions/opensession-admin: untrusted
 * ticket text must not be able to DM the team as the bot.
 */
import { existsSync, readFileSync } from "node:fs";
import { writeJsonAtomic } from "./shared/atomic-write";
import { homeDir, OPENSESSION_SESSIONS_DIR } from "./paths";
import { audit } from "./audit";
import { tryGetSessionControl } from "./session-control";
import { findSession } from "./session-cache";
import { resolveTeammate } from "./shared/user-mappings";
import { linkThreadInIndex } from "./slack-links";
import { broadcastToSession } from "./ws-hub";
import {
  openDirectMessage,
  postSlackBlocks,
  sendSlackMessage,
  updateSlackBlocks,
} from "../agents/slack/slack-api";
import { configuredServer, personaName, productName } from "./config";
import { registerSessionEffectExecutor, sessionKernel } from "./session-kernel";
import { workspaceName } from "./workspaces";

const HOME = homeDir();
const STORE = `${OPENSESSION_SESSIONS_DIR}/human-asks.json`;
const UI_BASE =
  process.env.OPENSESSION_UI_BASE || configuredServer().publicBaseUrl;

/** How long a "block" ask holds the agent's turn before degrading to async. */
const BLOCK_TIMEOUT_MS = 20 * 60 * 1000;
/** How long a UI-first ask stays a card in the session before we fall back to a DM.
 *  Matches ASK_UI_TIMEOUT_MS in asks.ts so both ask paths escalate on the same beat. */
const UI_FIRST_WINDOW_MS = 4 * 60 * 1000;
/** Terminal asks older than this are pruned from the store on load. */
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type HumanAskState =
  | "scheduled" // registered, not yet delivered (deferred trigger pending)
  | "delivered" // DM sent, awaiting a reply
  | "answered"
  | "cancelled";

/** When the teammate is actually pinged. A string atIso means "at that instant". */
export type DeliverWhen = "now" | "when_done" | "on_pr" | { atIso: string };

export interface HumanAsk {
  id: string;
  /** Open Session session that raised the ask (answers route back here). */
  sessionId: string;
  /** Display name of whoever drove the session when it asked. */
  createdBy: string;
  person: { slackId: string; name: string };
  question: string;
  /** Extra background included in the DM (a file, a screen, a decision, …). */
  context?: string;
  /** Quick-pick option labels → buttons; absent → free-text reply. */
  options?: string[];
  mode: "block" | "async";
  deliver: DeliverWhen;
  /** Pose this in the session's UI first and only DM Slack if it goes unanswered. */
  uiFirst?: boolean;
  /** When the UI card went up — the clock the Slack fallback runs on (survives restarts). */
  uiOfferedAt?: string;
  state: HumanAskState;
  /** Set once delivered: the DM channel and the question message's ts (thread root). */
  slack?: { channel: string; rootTs: string };
  /**
   * Domain hook: a server-side module owns this ask's meaning (e.g. the
   * keychain's approve/decline). When set, the registered handler for `kind`
   * runs at resolution — whichever channel answered — and may replace the
   * text delivered to the session (a grant token instead of the raw button
   * label). Persisted with the ask, so a restart between question and answer
   * still resolves through the domain (handlers re-register at module load).
   */
  domain?: { kind: string; ref: string };
  answer?: string;
  answeredBy?: string;
  createdAt: string;
  deliveredAt?: string;
  answeredAt?: string;
}

interface Stored {
  asks: HumanAsk[];
}

const g = globalThis as any;
/** All asks, by id. Persisted to disk. */
const asks: Map<string, HumanAsk> = (g.__humanAsks ??= new Map());
/** Block-mode resolvers, in-memory only — their presence marks an ask as a live
 *  blocking wait (vs. an async ask, or a block that timed out / lost its process). */
const resolvers: Map<string, (answer: string | null) => void> =
  (g.__humanAskResolvers ??= new Map());
/** Armed timers for { atIso } deliveries, in-memory only (re-armed on boot). */
const atTimers: Map<
  string,
  ReturnType<typeof setTimeout>
> = (g.__humanAskTimers ??= new Map());
/** Live UI cards for uiFirst asks: the card's retract handle plus the timer that
 *  falls back to Slack. In-memory only — re-offered from uiOfferedAt on boot. */
const uiOffers: Map<
  string,
  { close: () => void; timer?: ReturnType<typeof setTimeout> }
> = (g.__humanAskUiOffers ??= new Map());

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function persist(): void {
  try {
    const data: Stored = { asks: [...asks.values()] };
    writeJsonAtomic(STORE, data, false);
  } catch (e) {
    console.error("[human-asks] persist failed:", e);
  }
}

function isTerminal(a: HumanAsk): boolean {
  return a.state === "answered" || a.state === "cancelled";
}

/**
 * Load persisted asks on boot. Prune old terminal asks. Block asks that were
 * mid-flight at the last exit lost their in-process resolver, so degrade them to
 * async — a late teammate reply then still steers into the (resumed) session
 * instead of vanishing. Re-arm timers for scheduled { atIso } deliveries.
 */
async function enqueueAskDelivery(a: HumanAsk, skipUi = false): Promise<void> {
  await sessionKernel(a.sessionId).enqueueEffect(
    "human_ask_deliver",
    { askId: a.id, skipUi },
    `${a.id}:${skipUi || !a.uiFirst ? "slack" : "ui"}`,
  );
}
export function initHumanAsks(): void {
  if (existsSync(STORE)) {
    try {
      const data: Stored = JSON.parse(readFileSync(STORE, "utf-8"));
      const cutoff = Date.now() - TERMINAL_RETENTION_MS;
      for (const a of data.asks || []) {
        if (isTerminal(a)) {
          const t = new Date(a.answeredAt || a.createdAt).getTime();
          if (t && t < cutoff) continue; // prune
        }
        // A delivered block ask can't resume its held turn after a restart.
        if (a.state === "delivered" && a.mode === "block") a.mode = "async";
        asks.set(a.id, a);
      }
    } catch (e) {
      console.error("[human-asks] load failed:", e);
    }
  }
  relinkAskThreads();
  for (const a of asks.values()) {
    if (a.state !== "scheduled") continue;
    if (a.deliver === "now") {
      enqueueAskDelivery(a);
    }
    // Re-arm scheduled time deliveries.
    if (typeof a.deliver === "object" && a.deliver.atIso) {
      armTimer(a);
      continue;
    }
    // A UI-first ask that was mid-window when we went down: its card and its
    // Slack-fallback timer died with the process. Put the card back for the
    // remainder (watchers get it again on reconnect), or ping Slack if the
    // window has run out — either way it can't be stranded by a restart.
    if (a.uiFirst && a.deliver === "now") {
      const startedAt = new Date(a.uiOfferedAt || a.createdAt).getTime();
      const left = UI_FIRST_WINDOW_MS - (Date.now() - startedAt);
      if (left > 5_000) offerAskInUi(a, left);
      else if (a.uiOfferedAt) {
        enqueueAskDelivery(a, true);
      }
    }
  }
}

/**
 * Re-assert every delivered ask's DM thread → session link in the slack-links
 * index. The ask store, not the session file, is the source of truth for these
 * links (an ask's session is often a Slack/Linear one whose file we never
 * write), so they have to be replayed whenever that index is (re)built — on
 * boot, and again after any rebuildIndex() that clears it.
 */
export function relinkAskThreads(): void {
  for (const a of asks.values()) {
    if (a.slack)
      linkThreadInIndex(a.sessionId, a.slack.channel, a.slack.rootTs);
  }
}

function armTimer(a: HumanAsk): void {
  if (typeof a.deliver !== "object") return;
  if (atTimers.has(a.id)) return;
  const fireAt = new Date(a.deliver.atIso).getTime();
  const delay = Math.max(0, fireAt - Date.now());
  // setTimeout caps at ~24.8 days; for anything further, re-check hourly.
  const MAX = 6 * 60 * 60 * 1000;
  const timer = setTimeout(
    () => {
      atTimers.delete(a.id);
      const cur = asks.get(a.id);
      if (!cur || cur.state !== "scheduled") return;
      if (
        typeof cur.deliver === "object" &&
        new Date(cur.deliver.atIso).getTime() > Date.now()
      ) {
        armTimer(cur); // not due yet (long-delay re-check) — re-arm
        return;
      }
      enqueueAskDelivery(a, true);
    },
    Math.min(delay, MAX),
  );
  atTimers.set(a.id, timer);
}

// ---------------------------------------------------------------------------
// Creating + delivering
// ---------------------------------------------------------------------------

export interface CreateAskInput {
  /** Stable id for idempotent external delivery. */
  id?: string;
  sessionId: string;
  createdBy: string;
  person: { slackId: string; name: string };
  question: string;
  context?: string;
  options?: string[];
  mode: "block" | "async";
  deliver: DeliverWhen;
  domain?: { kind: string; ref: string };
}

// ---------------------------------------------------------------------------
// Domain handlers
// ---------------------------------------------------------------------------

/**
 * A domain handler runs inside resolveAsk when a domain-tagged ask is
 * answered, and may return replacement text for what the session receives
 * (both the block resolver's return value and the async steer) — e.g. the
 * keychain swaps "Approve once" for grant instructions. Returning null keeps
 * the raw answer. A throwing handler must not eat the answer: the raw text
 * still goes through.
 *
 * Registry lives on globalThis so hot reloads keep it; owning modules
 * re-register at module load, so the newest code answers.
 */
export type AskDomainHandler = (ask: HumanAsk, answer: string) => string | null;

const domainHandlers: Map<string, AskDomainHandler> = ((
  globalThis as any
).__humanAskDomainHandlers ??= new Map());

export function registerAskDomainHandler(
  kind: string,
  handler: AskDomainHandler,
): void {
  domainHandlers.set(kind, handler);
}

function applyDomainHandler(a: HumanAsk, answer: string): string {
  if (!a.domain) return answer;
  const handler = domainHandlers.get(a.domain.kind);
  if (!handler) {
    console.error(
      `[human-asks] ask ${a.id} carries domain "${a.domain.kind}" but no handler is registered — delivering the raw answer`,
    );
    return answer;
  }
  try {
    return handler(a, answer) ?? answer;
  } catch (e) {
    console.error(
      `[human-asks] domain handler ${a.domain.kind} failed for ${a.id}:`,
      e,
    );
    return answer;
  }
}

/**
 * True when an ask belongs in the session's own UI before it belongs in Slack:
 * an async ask, raised by a web-driven session, aimed at the very person driving
 * that session. They're sitting in front of the session — putting the question
 * there first is both faster and less noisy than a DM, and Slack still catches
 * them if they've wandered off. Deliberately narrow: an ask aimed at a third
 * party ("get John's review") still pings Slack straight away, because John
 * isn't watching this session and shouldn't wait on a window for our benefit.
 */
function shouldAskInUiFirst(input: CreateAskInput): boolean {
  if (input.mode !== "async") return false; // a blocking ask needs the DM now
  try {
    const session = findSession(input.sessionId);
    // Slack/Linear/CLI-driven sessions: their driver lives in that channel, so
    // a DM *is* the in-context answer surface.
    if (session?.source !== "opensession") return false;
    const owner = resolveTeammate(session.startedBy ?? null);
    return !!owner && owner.slackId === input.person.slackId;
  } catch {
    return false;
  }
}

/**
 * Pose a uiFirst ask as a question card in its session and arm the Slack
 * fallback for `windowMs`. The card outlives the fallback on purpose: once the
 * DM goes out both channels stay open and whoever answers first wins (asks.ts
 * works the same way).
 */
function offerAskInUi(a: HumanAsk, windowMs: number): void {
  if (uiOffers.has(a.id)) return;
  if (!a.uiOfferedAt) {
    a.uiOfferedAt = new Date().toISOString();
    asks.set(a.id, a);
    persist();
  }
  audit({
    context: "human_ask",
    action: "offered_in_ui",
    ask_id: a.id,
    session_id: a.sessionId,
    person: a.person.name,
  });

  // Claim the slot synchronously — the card itself arrives a tick later (the
  // dynamic import below breaks the asks.ts ⇄ human-asks.ts cycle), and an
  // answer or a cancel can land in that gap.
  const entry: { close: () => void; timer?: ReturnType<typeof setTimeout> } = {
    close: () => {},
    timer: setTimeout(() => {
      const cur = asks.get(a.id);
      if (!cur || cur.state !== "scheduled") return;
      const live = uiOffers.get(a.id);
      if (live) live.timer = undefined; // card stays up; only the fallback fired
      enqueueAskDelivery(a, true);
    }, windowMs),
  };
  uiOffers.set(a.id, entry);

  void (async () => {
    try {
      const { offerAskCard } = await import("./asks");
      if (asks.get(a.id)?.state !== "scheduled" || uiOffers.get(a.id) !== entry)
        return;
      const card = await offerAskCard(
        a.sessionId,
        [
          {
            question: a.context ? `${a.question}\n\n${a.context}` : a.question,
            header: "Question for you",
            options: a.options?.map((label) => ({ label })),
          },
        ],
        (answers) => {
          const answer = answers
            ? Object.values(answers).filter(Boolean).join("\n")
            : "";
          // Dismissed without an answer: the card is gone but the question
          // isn't — leave the Slack fallback armed rather than stranding it.
          if (!answer) return;
          closeUiOffer(a.id, { retract: false }); // the card retracted itself
          resolveAskFromUI(a.id, answer, a.person.name);
        },
      );
      if (uiOffers.get(a.id) !== entry) {
        await card.close(); // resolved while the card was being built
        return;
      }
      entry.close = () => {
        card
          .close()
          .catch((error) =>
            console.error(
              `[human-asks] UI offer close failed for ${a.id}:`,
              error,
            ),
          );
      };
    } catch (e) {
      console.error(`[human-asks] UI offer failed for ${a.id}:`, e);
    }
  })();
}

/** Take down a live UI card (answered elsewhere / cancelled) and disarm its fallback. */
function closeUiOffer(id: string, opts?: { retract?: boolean }): void {
  const entry = uiOffers.get(id);
  if (!entry) return;
  uiOffers.delete(id);
  if (entry.timer) clearTimeout(entry.timer);
  if (opts?.retract === false) return;
  try {
    entry.close();
  } catch {}
}

/** Register an ask and trigger its delivery if it's due now / arm its timer. */
export function registerAsk(input: CreateAskInput): HumanAsk {
  const id = input.id || `ask-${crypto.randomUUID()}`;
  const existing = asks.get(id);
  if (existing) {
    if (
      existing.sessionId !== input.sessionId ||
      existing.question !== input.question
    )
      throw new Error(`Human ask id ${id} was reused with another request`);
    return existing;
  }
  const ask: HumanAsk = {
    id,
    sessionId: input.sessionId,
    createdBy: input.createdBy,
    person: input.person,
    question: input.question,
    context: input.context,
    options: input.options?.length ? input.options : undefined,
    mode: input.mode,
    deliver: input.deliver,
    uiFirst: shouldAskInUiFirst(input) || undefined,
    domain: input.domain,
    state: "scheduled",
    createdAt: new Date().toISOString(),
  };
  asks.set(ask.id, ask);
  persist();
  audit({
    context: "human_ask",
    action: "created",
    ask_id: ask.id,
    session_id: ask.sessionId,
    created_by: ask.createdBy,
    person: ask.person.name,
    mode: ask.mode,
    deliver:
      typeof ask.deliver === "object" ? `at:${ask.deliver.atIso}` : ask.deliver,
    ui_first: !!ask.uiFirst,
  });

  if (ask.deliver === "now") {
    enqueueAskDelivery(ask);
  } else if (typeof ask.deliver === "object") {
    armTimer(ask);
  } // when_done / on_pr stay scheduled until onSessionIdle fires them.

  return ask;
}

const escapeMrkdwn = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function askDestination(a: HumanAsk): { link: string; subject: string } {
  const session = findSession(a.sessionId);
  return {
    link: `${UI_BASE}/session/${a.sessionId}`,
    subject:
      session?.workspaceName ||
      (session?.workspaceId ? workspaceName(session.workspaceId) : null) ||
      session?.title ||
      "this session",
  };
}

function deliveryBlocks(a: HumanAsk): { fallback: string; blocks: any[] } {
  const { link, subject } = askDestination(a);
  const intro = `*${personaName()} needs your input on <${link}|${escapeMrkdwn(subject)}>*`;
  const blocks: any[] = [
    { type: "section", text: { type: "mrkdwn", text: intro } },
    { type: "section", text: { type: "mrkdwn", text: a.question } },
  ];
  if (a.context) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: a.context.slice(0, 2900) },
    });
  }
  if (a.options?.length) {
    const buttons: any[] = a.options.slice(0, 9).map((label, i) => ({
      type: "button",
      text: { type: "plain_text", text: label.slice(0, 75), emoji: true },
      action_id: `humanask-${a.id}-opt-${i}`,
      value: label,
    }));
    buttons.push({
      type: "button",
      text: { type: "plain_text", text: "Other…", emoji: true },
      action_id: `humanask-${a.id}-other`,
      style: "primary",
    });
    blocks.push({ type: "actions", elements: buttons });
  } else {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "_Reply here and I'll bring it straight back into the session._",
        },
      ],
    });
  }
  return {
    fallback: `${personaName()} needs your input on ${subject}: ${a.question}`,
    blocks,
  };
}

function answeredBlocks(
  a: HumanAsk,
  answer: string,
  answeredBy: string,
  answeredIn: string,
): { fallback: string; blocks: any[] } {
  const { link, subject } = askDestination(a);
  const blocks: any[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${personaName()} received your input on <${link}|${escapeMrkdwn(subject)}>*`,
      },
    },
    { type: "section", text: { type: "mrkdwn", text: a.question } },
  ];
  if (a.context) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: a.context.slice(0, 2900) },
    });
  }
  blocks.push({
    type: "context",
    elements: [
      {
        type: "plain_text",
        text: `Answered in ${answeredIn} by ${answeredBy}: ${answer}`.slice(
          0,
          2000,
        ),
        emoji: false,
      },
    ],
  });
  return {
    fallback: `${personaName()} received input on ${subject}: ${answer}`,
    blocks,
  };
}

function markSlackAskAnswered(
  a: HumanAsk,
  answer: string,
  answeredBy: string,
  answeredIn: string,
): void {
  if (!a.slack) return;
  const settled = answeredBlocks(a, answer, answeredBy, answeredIn);
  void updateSlackBlocks(
    a.slack.channel,
    a.slack.rootTs,
    settled.fallback,
    settled.blocks,
  )
    .then((result) => {
      if (!result?.ok)
        throw new Error(result?.error || "Slack rejected the message update");
    })
    .catch((error) =>
      console.error(
        `[human-asks] couldn't mark ${a.id} answered in Slack:`,
        error,
      ),
    );
}

/**
 * Deliver an ask that has come due. A uiFirst ask goes up as a card in its own
 * session and returns here later through the fallback timer (skipUi); everything
 * else opens a DM with the teammate and posts the question straight away.
 */
export async function deliverAsk(
  id: string,
  opts?: { skipUi?: boolean },
): Promise<boolean> {
  const a = asks.get(id);
  if (!a || a.state !== "scheduled") return false;
  if (a.uiFirst && !opts?.skipUi) {
    offerAskInUi(a, UI_FIRST_WINDOW_MS);
    return true;
  }
  const channel = await openDirectMessage(a.person.slackId);
  if (!channel) {
    console.error(
      `[human-asks] couldn't open DM with ${a.person.name} (${a.person.slackId})`,
    );
    return false;
  }
  const { fallback, blocks } = deliveryBlocks(a);
  const res = await postSlackBlocks(channel, fallback, blocks, undefined, {
    clientMsgId: a.id,
  });
  if (!res?.ok || !res.ts) {
    console.error(`[human-asks] DM post failed for ${id}:`, res?.error);
    return false;
  }
  a.state = "delivered";
  a.slack = { channel, rootTs: res.ts };
  a.deliveredAt = new Date().toISOString();
  asks.set(id, a);
  persist();
  // The DM thread now belongs to the asking session. While the ask is live,
  // matchReply claims replies first (they're an *answer*); once it's moot —
  // cancelled, answered elsewhere, timed out — this link is what keeps a late
  // reply going back to the session that asked instead of spawning a fresh,
  // context-free one (seen live: an ask was cancelled 3s before the human's
  // reply landed, and the answer started a new session that could only say
  // "Done"). The link lives as long as the ask does — terminal asks are pruned
  // after TERMINAL_RETENTION_MS, and the link goes with them at the next
  // rebuild.
  linkThreadInIndex(a.sessionId, channel, res.ts);
  audit({
    context: "human_ask",
    action: "delivered",
    ask_id: id,
    session_id: a.sessionId,
    person: a.person.name,
    channel,
    ui_first: !!a.uiFirst,
  });
  // Keep the session honest about where the question went. Block asks already
  // say it on their own card (humans-tools.ts), so they stay quiet here.
  if (a.mode === "async") {
    broadcastToSession(a.sessionId, {
      type: "notice",
      message: a.uiFirst
        ? `No answer in ${productName()} — asked **${a.person.name}** on Slack.`
        : `📨 Asked **${a.person.name}** on Slack — _${shortQ(a)}_`,
    });
  }
  return true;
}

registerSessionEffectExecutor("human_ask_deliver", async (item) => {
  const payload = item.payload;
  const ask = asks.get(payload.askId);
  if (!ask || ask.state !== "scheduled") return;
  const delivered = await deliverAsk(payload.askId, {
    skipUi: payload.skipUi === true,
  });
  if (!delivered && asks.get(payload.askId)?.state === "scheduled")
    throw new Error(`Human ask ${payload.askId} is still pending delivery`);
});

// ---------------------------------------------------------------------------
// Blocking await
// ---------------------------------------------------------------------------

/**
 * For a "block" ask: register a resolver and return a promise that settles when
 * the teammate replies (the answer), or after BLOCK_TIMEOUT_MS (null). On
 * timeout the ask degrades to async so a later reply still steers into the
 * session rather than being dropped.
 */
export function awaitBlockingAnswer(id: string): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolvers.delete(id);
      const a = asks.get(id);
      if (a && a.state === "delivered") {
        a.mode = "async"; // a late reply now routes back via deliverToSession
        persist();
      }
      resolve(null);
    }, BLOCK_TIMEOUT_MS);
    resolvers.set(id, (answer) => {
      clearTimeout(timer);
      resolvers.delete(id);
      resolve(answer);
    });
  });
}

// ---------------------------------------------------------------------------
// Resolving (a teammate answered)
// ---------------------------------------------------------------------------

function shortQ(a: HumanAsk): string {
  return a.question.length > 80 ? `${a.question.slice(0, 80)}…` : a.question;
}

/** Mark an ask answered, audit it, and route the answer (block resolver if the
 *  wait is still live in this process, otherwise steer it into the session). */
function resolveAsk(
  a: HumanAsk,
  answer: string,
  answeredBy: string,
  via: "slack" | "ui" = "slack",
): void {
  closeUiOffer(a.id); // whichever channel won, take the card down
  a.state = "answered";
  a.answer = answer;
  a.answeredBy = answeredBy;
  a.answeredAt = new Date().toISOString();
  asks.set(a.id, a);
  persist();
  audit({
    context: "human_ask",
    action: "answered",
    ask_id: a.id,
    session_id: a.sessionId,
    person: a.person.name,
    answered_by: answeredBy,
    answer_len: answer.length,
  });

  // A domain-tagged ask (keychain approvals, …) resolves through its owning
  // module FIRST — server-side effects (minting a grant) happen exactly once
  // here, whichever channel answered, and the session receives the domain's
  // text (grant instructions) rather than the raw button label.
  const delivered = applyDomainHandler(a, answer);

  const resolver = resolvers.get(a.id);
  if (resolver) {
    resolver(delivered); // live block — the awaiting tool call returns the answer
    return;
  }
  // Async (or a block whose wait already timed out / lost its process): steer
  // the answer into the session like a human typing in the web UI.
  const ctrl = tryGetSessionControl();
  if (!ctrl) {
    console.error(
      `[human-asks] no session control to deliver answer for ${a.id}`,
    );
    return;
  }
  // Unicode emoji (the Open Session markdown renderer doesn't expand :shortcodes:)
  // and a structured header the web UI keys on to render this as a distinct
  // "human reply" bubble rather than one of the session driver's own messages.
  const who = via === "ui" ? answeredBy || a.person.name : a.person.name;
  const msg = `💬 **${who}** answered${via === "ui" ? "" : " (via Slack)"} — "${shortQ(a)}":\n\n${delivered}`;
  void ctrl
    .deliverToSession(a.sessionId, msg, who, {
      deliveryId: `human-ask-answer:${a.id}`,
    })
    .catch((e) =>
      console.error(`[human-asks] deliver answer to ${a.sessionId} failed:`, e),
    );
}

/**
 * Try to match an inbound Slack message to an outstanding ask. Accepts a reply
 * ONLY from the exact teammate the ask was sent to, in that ask's DM channel.
 * Prefers a reply threaded under the question; falls back to the most recent
 * delivered ask in the channel (teammates often reply without threading in a DM).
 * Returns the matched ask (now answered) or null. This is the one place that
 * deliberately accepts a message from someone other than the trusted user.
 *
 * Only *live* asks match. A reply that arrives once the ask is moot is handled
 * a layer up by the thread→session link deliverAsk registers — but only when
 * it's threaded: an un-threaded DM after a moot ask is indistinguishable from a
 * new request and still takes the normal DM path.
 */
export function matchReply(input: {
  channel: string;
  user: string;
  threadTs?: string;
  text: string;
}): HumanAsk | null {
  const text = (input.text || "").trim();
  if (!text) return null;
  const candidates = [...asks.values()].filter(
    (a) =>
      a.state === "delivered" &&
      a.slack?.channel === input.channel &&
      a.person.slackId === input.user,
  );
  if (!candidates.length) return null;

  let match =
    (input.threadTs &&
      candidates.find((a) => a.slack!.rootTs === input.threadTs)) ||
    undefined;
  if (!match && !input.threadTs) {
    // Newest delivered ask in this DM wins for an un-threaded reply. Only for
    // genuinely un-threaded ones: a reply threaded under some OTHER message is
    // about that thread (often one a session posted and linked), and grabbing
    // it here hijacks it from the thread→session routing downstream
    // (2026-07-23: a reply under an iOS-session thread got steered into a
    // week-old session's stale ask this way).
    match = candidates.sort(
      (x, y) =>
        new Date(y.deliveredAt!).getTime() - new Date(x.deliveredAt!).getTime(),
    )[0];
  }
  if (!match) return null;

  audit({
    context: "human_ask",
    action: "reply_accepted",
    ask_id: match.id,
    session_id: match.sessionId,
    person: match.person.name,
    from_user: input.user,
    threaded: !!(input.threadTs && match.slack!.rootTs === input.threadTs),
  });
  resolveAsk(match, text, match.person.name);
  return match;
}

/**
 * Audit a reply that landed in an ask's DM thread AFTER the ask went moot, and
 * is therefore routed into the asking session as an ordinary message (the
 * thread→session branch in handlers.ts) rather than matched here as an answer.
 * matchReply sits before Slack's allow-list gate on the grounds that every
 * reply it accepts from a non-trusted teammate is audited; these continuations
 * ride the same trust, so they get the same paper trail. No-op for threads that
 * aren't ask threads.
 */
export function noteAskThreadReply(input: {
  channel: string;
  threadTs: string;
  user: string;
}): void {
  const a = [...asks.values()].find(
    (x) =>
      x.slack?.channel === input.channel && x.slack.rootTs === input.threadTs,
  );
  if (!a) return;
  audit({
    context: "human_ask",
    action: "thread_reply_routed",
    ask_id: a.id,
    session_id: a.sessionId,
    ask_state: a.state,
    person: a.person.name,
    from_user: input.user,
  });
}

/** Resolve an ask with an answer given in the session UI. If Slack already
 *  received the ask, replace its card with a read-only answered state so the
 *  teammate cannot answer the same question again. */
export function resolveAskFromUI(
  askId: string,
  answer: string,
  answeredBy: string,
): boolean {
  const a = asks.get(askId);
  if (!a) return false;
  const inUiWindow = a.state === "scheduled" && !!a.uiOfferedAt;
  if (a.state !== "delivered" && !inUiWindow) return false;
  audit({
    context: "human_ask",
    action: "reply_accepted",
    ask_id: a.id,
    session_id: a.sessionId,
    person: a.person.name,
    via: "ui",
    answered_by: answeredBy,
  });
  resolveAsk(a, answer, answeredBy, "ui");
  markSlackAskAnswered(a, answer, answeredBy, productName());
  return true;
}

/** Resolve an option-button / modal answer by ask id (from the Slack interactivity
 *  endpoint). Returns true if it was an outstanding ask. */
export function resolveByOption(askId: string, label: string): boolean {
  const a = asks.get(askId);
  if (!a || a.state !== "delivered") return false;
  audit({
    context: "human_ask",
    action: "reply_accepted",
    ask_id: a.id,
    session_id: a.sessionId,
    person: a.person.name,
    via: "button",
  });
  resolveAsk(a, label, a.person.name);
  markSlackAskAnswered(a, label, a.person.name, "Slack");
  return true;
}

/** True if this ask is still awaiting a reply (used to gate the modal "Other…"). */
export function isAwaiting(askId: string): boolean {
  return asks.get(askId)?.state === "delivered";
}

// ---------------------------------------------------------------------------
// Deferred-trigger firing
// ---------------------------------------------------------------------------

/**
 * Called when a session finishes a run with nothing queued (it just went idle).
 * Fires any scheduled "when_done" asks for it, plus "on_pr" asks once the
 * session has a PR. Idempotent — a delivered ask won't re-fire.
 */
export function onSessionIdle(sessionId: string): void {
  // A block ask can only hold a turn while its run is alive — the session
  // going idle means the awaiting tool call is gone (interrupt, cancel, or
  // crash). Degrade to async so a late reply steers into the session as a new
  // message instead of resolving into the dead tool call and vanishing
  // (2026-07-10: an SSO ask stayed block+delivered after an interrupt; a
  // later Slack reply would have been silently eaten by the orphaned
  // resolver).
  for (const a of asks.values()) {
    if (
      a.sessionId !== sessionId ||
      a.state !== "delivered" ||
      a.mode !== "block"
    )
      continue;
    const resolver = resolvers.get(a.id);
    if (resolver) resolver(null); // settles the orphaned await; its tool is dead
    a.mode = "async";
    asks.set(a.id, a);
    persist();
    audit({
      context: "human_ask",
      action: "degraded_to_async",
      ask_id: a.id,
      session_id: sessionId,
      reason: "session_idle_with_block_pending",
    });
  }

  const pending = [...asks.values()].filter(
    (a) => a.sessionId === sessionId && a.state === "scheduled",
  );
  if (!pending.length) return;
  let hasPr = false;
  const ctrl = tryGetSessionControl();
  if (ctrl) hasPr = !!ctrl.getSession(sessionId)?.prUrl;
  for (const a of pending) {
    if (a.deliver === "when_done" || (a.deliver === "on_pr" && hasPr)) {
      enqueueAskDelivery(a, true);
    }
  }
}

// ---------------------------------------------------------------------------
// Listing + cancelling (for the MCP)
// ---------------------------------------------------------------------------

export function listAsks(opts?: {
  sessionId?: string;
  includeAnswered?: boolean;
}): HumanAsk[] {
  let out = [...asks.values()];
  if (opts?.sessionId) out = out.filter((a) => a.sessionId === opts.sessionId);
  if (!opts?.includeAnswered) {
    out = out.filter((a) => a.state === "scheduled" || a.state === "delivered");
  }
  return out.sort(
    (x, y) => new Date(y.createdAt).getTime() - new Date(x.createdAt).getTime(),
  );
}

export function getAsk(id: string): HumanAsk | undefined {
  return asks.get(id);
}

export function cancelAsk(id: string): boolean {
  const a = asks.get(id);
  if (!a || isTerminal(a)) return false;
  a.state = "cancelled";
  asks.set(id, a);
  closeUiOffer(id);
  const timer = atTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    atTimers.delete(id);
  }
  const resolver = resolvers.get(id);
  if (resolver) resolver(null);
  persist();
  audit({
    context: "human_ask",
    action: "cancelled",
    ask_id: id,
    session_id: a.sessionId,
  });
  // If it was already delivered, let the teammate know it's moot.
  if (a.slack) {
    void sendSlackMessage(
      a.slack.channel,
      `_This question no longer needs an answer. Reply here anyway if you have something to add and I'll pass it to the session._`,
      a.slack.rootTs,
    ).catch(() => {});
  }
  return true;
}
