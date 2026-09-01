/**
 * Interactive AskUserQuestion: questions broadcast to session watchers, answered
 * from the UI. If nobody answers in the UI within ASK_UI_TIMEOUT_MS, the question
 * is escalated to the session's original prompter over Slack (the opensession-humans
 * transport) and we keep blocking on their reply; the UI question stays live the
 * whole time, so whoever answers first (web or Slack) wins.
 */

import { existsSync, readFileSync, rmSync } from "fs";
import { personaName, productName } from "./config";
import {
  awaitBlockingAnswer,
  cancelAsk,
  getAsk,
  registerAsk,
} from "./human-asks";
import { AWS_HUMAN_AUTH_DENIAL, isAwsHumanAuthRequest } from "./aws-creds";
import { askRecordContent } from "@tellahq/opensession-protocol/notices";
import type { AnsweredAskData } from "@tellahq/opensession-protocol/notices";
import {
  storeAppendUserLineEarly,
  transcriptLineAskRecord,
} from "./transcript-persistence";
import { resolveTeammate } from "./shared/user-mappings";
import { transitionRunState } from "./run-state";
import { findSession } from "./session-cache";
import { sessionsDir } from "./paths";
import { tryGetSessionControl } from "./session-control";
import { writeJsonAtomic } from "./shared/atomic-write";
import { broadcastToSession } from "./ws-hub";
import {
  AskOwnedMap,
  EphemeralSessionMap,
  fireStoredSessionTimer,
  registerSessionTimerHandler,
  sessionAsk,
  sessionAskMigrationComplete,
  sessionKernel,
  markSessionAskMigrationComplete,
} from "./session-kernel";
import { wrapContext } from "./prompt-context";

const ASK_UI_TIMEOUT_MS = 4 * 60 * 1000;
const askMigrationState = ((
  globalThis as typeof globalThis & {
    __opensessionAskMigrationState?: { complete: boolean };
  }
).__opensessionAskMigrationState ??= { complete: false });

// Moved to the protocol package (as AskQuestion); the old name stays for
// existing import sites.
export type { AskQuestion as AskQuestionInput } from "@tellahq/opensession-protocol/session";
import type { AskQuestion as AskQuestionInput } from "@tellahq/opensession-protocol/session";

export interface PendingAsk {
  questionId: string;
  questions: unknown[];
  resolve: (answers: Record<string, string> | null) => void | Promise<void>;
  /** Only run-blocking asks are durable. offerAskCard is restored by human-asks. */
  durable?: boolean;
  askedAt?: number;
  escalatedAskId?: string;
  escalatedPersonName?: string;
  escalationWaitStarted?: boolean;
  answerReceived?: boolean;
  earlyAnswer?: Record<string, string> | null;
  /** Durable answer receipt recorded by the actor before the gateway
   * resolver ran. Preserved through restore so retry identity and the
   * committed payload survive a restart. */
  answer?: { requestId: string; answers: Record<string, string> | null };
  restored?: boolean;
  /** Test/isolated-instance seam; live asks use pendingAskStorePath(). */
  storePath?: string;
}
export const pendingAsks = new AskOwnedMap<PendingAsk>();

/** The durable map may retain a restored ask after its answer arrives, until
 * the detached run host reconnects and adopts that answer. That recovery
 * record is not still actionable and must never be projected back as a card. */
export async function pendingAskAwaitingAnswer(
  sessionId: string,
): Promise<PendingAsk | undefined> {
  const pending = await pendingAsks.getAsync(sessionId);
  return pending?.answerReceived ? undefined : pending;
}

/** Sync projection variant for read-only summary surfaces that cannot await.
 * Applies the same answerReceived filter so an answered-but-not-yet-adopted
 * recovery record is never projected back as an actionable question. */
export function pendingAskAwaitingAnswerSync(
  sessionId: string,
): PendingAsk | undefined {
  const pending = pendingAsks.get(sessionId);
  return pending?.answerReceived ? undefined : pending;
}

/** One actor snapshot for list rendering, instead of one RPC per session. */
export async function pendingAskIdsAwaitingAnswer(): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const [sessionId, value] of await sessionAsk({ op: "entries" })) {
    const pending = value as { answerReceived?: boolean } | undefined;
    if (!pending?.answerReceived) ids.add(sessionId);
  }
  return ids;
}

type PersistedPendingAsk = {
  sessionId: string;
  questionId: string;
  questions: AskQuestionInput[];
  askedAt: number;
  escalatedAskId?: string;
  escalatedPersonName?: string;
  answerReceived?: boolean;
  earlyAnswer?: Record<string, string> | null;
  answer?: { requestId: string; answers: Record<string, string> | null };
};

type PendingAskTimer = {
  handle: ReturnType<typeof setTimeout>;
  dueAt: number;
};

export const pendingAskTimers: Map<string, PendingAskTimer> =
  new EphemeralSessionMap();

export function pendingAskStorePath(): string {
  return `${sessionsDir()}/pending-asks.json`;
}

function removeLegacyAskStore(storePath = pendingAskStorePath()): void {
  try {
    rmSync(storePath, { force: true });
  } catch (error) {
    console.error(
      `[ask] Failed to remove migrated ask store ${storePath}:`,
      error,
    );
  }
}

export function persistPendingAsks(storePath = pendingAskStorePath()): void {
  try {
    // Custom paths remain useful migration/test fixtures. Production JSON is
    // retired after the actor records its one-time import receipt.
    if (storePath === pendingAskStorePath() && askMigrationState.complete)
      return;
    const asks: PersistedPendingAsk[] = [];
    for (const [sessionId, ask] of pendingAsks) {
      if (!ask.durable || !ask.askedAt) continue;
      asks.push({
        sessionId,
        questionId: ask.questionId,
        questions: ask.questions as AskQuestionInput[],
        askedAt: ask.askedAt,
        ...(ask.escalatedAskId ? { escalatedAskId: ask.escalatedAskId } : {}),
        ...(ask.escalatedPersonName
          ? { escalatedPersonName: ask.escalatedPersonName }
          : {}),
        ...(ask.answerReceived
          ? { answerReceived: true, earlyAnswer: ask.earlyAnswer ?? null }
          : {}),
        ...(ask.answer ? { answer: ask.answer } : {}),
      });
    }
    writeJsonAtomic(storePath, { asks }, false, 0o600);
  } catch (e) {
    console.error("[ask] Failed to persist pending asks:", e);
  }
}

async function clearAskTimer(sessionId: string): Promise<void> {
  const timer = pendingAskTimers.get(sessionId);
  if (timer) clearTimeout(timer.handle);
  pendingAskTimers.delete(sessionId);
  await sessionKernel(sessionId).cancelTimer("ask_escalation");
}

async function retirePendingAsk(
  sessionId: string,
  questionId: string,
): Promise<void> {
  await clearAskTimer(sessionId);
  const ask = pendingAsks.get(sessionId);
  if (ask?.questionId === questionId) {
    await pendingAsks.delete(sessionId);
    persistPendingAsks(ask.storePath);
  }
}

function sameQuestions(a: unknown[], b: AskQuestionInput[]): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function fallbackAnswerContext(
  questions: AskQuestionInput[],
  answers: Record<string, string>,
): string {
  const lines = questions.map((question) => {
    const answer = answers[question.question] ?? "";
    return `Question: ${question.question}\nAnswer: ${answer}`;
  });
  return wrapContext(
    `A blocking question was answered before restart recovery finished. Treat this as the person's answer and continue:\n\n${lines.join("\n\n")}`,
    "restart-recovery",
  );
}

/** A restored card initially has no in-process tool promise to resolve. If the
 * adopted engine re-emits its ask, makeAskHandler replaces this resolver with
 * the live one. An answer that wins that race still follows the ordinary
 * steer/queue path instead of disappearing. */
async function resolveRestoredAsk(
  sessionId: string,
  questionId: string,
  questions: AskQuestionInput[],
  answers: Record<string, string> | null,
): Promise<void> {
  const ask = pendingAsks.get(sessionId);
  if (ask?.questionId !== questionId || ask.answerReceived) return;
  await clearAskTimer(sessionId);
  ask.answerReceived = true;
  ask.earlyAnswer = answers;
  await pendingAsks.set(sessionId, ask);
  if (ask.escalatedAskId) cancelAsk(ask.escalatedAskId);
  persistPendingAsks(ask.storePath);
  broadcastToSession(sessionId, {
    type: "ask_resolved",
    sessionId,
    questionId,
  });
  // Keep the answer with the card until the recovered engine re-emits the
  // matching AskUserQuestion. makeAskHandler then resolves the original tool
  // promise instead of turning the answer into an unrelated user prompt.
}

export async function settleRestoredAskAfterRecovery(
  sessionId: string,
): Promise<boolean> {
  const ask = pendingAsks.get(sessionId);
  if (!ask) return false;
  if (!ask.restored) {
    if (ask.answerReceived) await retirePendingAsk(sessionId, ask.questionId);
    return false;
  }
  const answers = ask.answerReceived ? (ask.earlyAnswer ?? null) : null;
  if (!answers) {
    await retirePendingAsk(sessionId, ask.questionId);
    if (ask.escalatedAskId) cancelAsk(ask.escalatedAskId);
    broadcastToSession(sessionId, {
      type: "ask_resolved",
      sessionId,
      questionId: ask.questionId,
    });
    return false;
  }
  const control = tryGetSessionControl();
  if (!control) {
    console.error(
      `[ask] No session control to deliver restored answer for ${sessionId}`,
    );
    return false;
  }
  const questions = ask.questions as AskQuestionInput[];
  const session = findSession(sessionId);
  void control
    .deliverToSession(
      sessionId,
      fallbackAnswerContext(questions, answers),
      session?.startedBy || undefined,
      {
        busy: "queue",
        deliveryId: `restored-ask-answer:${ask.questionId}`,
      },
    )
    .then(async (result) => {
      if (result.status === "error") return;
      // The continuation is now durably admitted under its stable id. Only
      // now may the answered card and recovery intent be retired.
      recordAskAnswer(sessionId, questions, answers);
      await retirePendingAsk(sessionId, ask.questionId);
      if (ask.escalatedAskId) cancelAsk(ask.escalatedAskId);
      broadcastToSession(sessionId, {
        type: "ask_resolved",
        sessionId,
        questionId: ask.questionId,
      });
    })
    .catch((error) =>
      console.error(
        `[ask] Failed to admit restored answer for ${sessionId}:`,
        error,
      ),
    );
  return true;
}

// ── The durable record of an answered card ───────────────────────────────────
//
// The question card is transient: it is removed the moment it resolves, and it
// never was a transcript entry, so a session that stopped to ask something
// showed no sign of it afterwards. What was on offer, and which of those the
// human picked, is often the reason the run went the way it did.
//
// So on resolution we write one system entry: a title carrying the pick, and a
// collapsed body carrying the question and the options it was picked from.
// Deliberately a record rather than a re-render of the card, because it is
// read later by someone scanning what happened, not answered.

const ASK_TITLE_MAX = 72;
const OPTION_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** The wire format joins a multi-select answer with ", " (see AskCard). */
function answerLabels(answer: string): string[] {
  return answer
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** One line for the title row: a question or a typed answer can be prose. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function askRecordTitle(
  questions: AskQuestionInput[],
  answers: Record<string, string>,
): string {
  if (questions.length !== 1) return `Answered ${questions.length} questions`;
  const answer = (answers[questions[0].question] ?? "").trim();
  return answer ? `Answered: ${oneLine(answer, ASK_TITLE_MAX)}` : "Answered";
}

function askRecordBody(
  questions: AskQuestionInput[],
  answers: Record<string, string>,
): string {
  return questions
    .map((q) => {
      const answer = (answers[q.question] ?? "").trim();
      const picked = new Set(answerLabels(answer));
      const options = q.options ?? [];
      const lines: string[] = [];
      lines.push(`**${q.header ? `${q.header}: ` : ""}${q.question}**`, "");
      options.forEach((o, i) => {
        const letter = `${OPTION_LETTERS[i] ?? "-"}.`;
        // The pick is bold against its neighbours: the options are here for
        // context, the choice is the thing being reported.
        lines.push(
          picked.has(o.label)
            ? `- **${letter} ${o.label}**`
            : `- ${letter} ${o.label}`,
        );
      });
      // Anything answered that wasn't on offer was typed into the card's own
      // free-text field, so it has no letter to wear.
      const typed = answerLabels(answer).filter(
        (l) => !options.some((o) => o.label === l),
      );
      if (typed.length) lines.push(`- **${typed.join(", ")}** (typed)`);
      if (!answer) lines.push("- No answer.");
      return lines.join("\n");
    })
    .join("\n\n");
}

/** The record's `content`: title line plus markdown body. Exported for tests,
 *  which is where the compatibility wording is pinned. */
export function askRecordEntryContent(
  questions: AskQuestionInput[],
  answers: Record<string, string>,
): string {
  return askRecordContent(
    askRecordTitle(questions, answers),
    askRecordBody(questions, answers),
  );
}

/** Exact read-only card data. It rides beside the compatibility text in the
 *  JSONL line, preserving option descriptions and multi-select semantics that
 *  cannot be recovered reliably from rendered markdown. */
export function answeredAskData(
  questions: AskQuestionInput[],
  answers: Record<string, string>,
): AnsweredAskData {
  return {
    version: 1,
    questions: questions.map((q) => ({
      question: q.question,
      answer: answers[q.question] ?? "",
      ...(q.header ? { header: q.header } : {}),
      ...(q.options ? { options: q.options } : {}),
      ...(q.multiSelect ? { multiSelect: true } : {}),
    })),
  };
}

/** Persist the answered card. Best-effort: a transcript write must never take
 *  down the run that was waiting on the answer. */
export function recordAskAnswer(
  sessionId: string,
  questions: AskQuestionInput[],
  answers: Record<string, string> | null,
): void {
  if (!answers || !questions.length) return;
  try {
    void storeAppendUserLineEarly(
      sessionId,
      transcriptLineAskRecord(
        askRecordEntryContent(questions, answers),
        answeredAskData(questions, answers),
      ),
    );
  } catch (e) {
    console.error(`[ask] Failed to record answer for ${sessionId}:`, e);
  }
}

// Flatten an AskUserQuestion payload into a single Slack-friendly prompt. Option
// buttons are only offered when there's exactly one question (the human-asks card
// carries one option set); multi-question asks fall back to a free-text reply.
function askToSlackPrompt(questions: AskQuestionInput[]): {
  question: string;
  options?: string[];
} {
  if (questions.length === 1) {
    const q = questions[0];
    const text = q.header ? `*${q.header}* — ${q.question}` : q.question;
    return { question: text, options: q.options?.map((o) => o.label) };
  }
  const text = questions
    .map(
      (q, i) => `${i + 1}. ${q.header ? `*${q.header}* — ` : ""}${q.question}`,
    )
    .join("\n");
  return { question: text };
}

// A Slack reply is a single string; apply it as the answer to every question so
// the AskUserQuestion result has a value for each key it expects.
function slackAnswerToAnswers(
  questions: AskQuestionInput[],
  answer: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const q of questions) out[q.question] = answer;
  return out;
}

function waitForEscalatedAnswer(
  sessionId: string,
  questionId: string,
  questions: AskQuestionInput[],
  askId: string,
  personName: string,
): void {
  const stored = getAsk(askId);
  if (!stored || stored.state === "answered" || stored.state === "cancelled") {
    const answer = stored?.state === "answered" ? stored.answer || null : null;
    queueMicrotask(() => {
      void (async () => {
        const current = pendingAsks.get(sessionId);
        if (current?.questionId !== questionId) return;
        await current.resolve(
          answer == null ? null : slackAnswerToAnswers(questions, answer),
        );
      })().catch((error) => {
        console.error(
          `[asks] Failed to resolve restored Slack answer for ${sessionId}:`,
          error,
        );
      });
    });
    return;
  }
  void awaitBlockingAnswer(askId)
    .then(async (slackAnswer) => {
      const current = pendingAsks.get(sessionId);
      if (current?.questionId !== questionId) return;
      if (slackAnswer == null) {
        await current.resolve(null);
        return;
      }
      broadcastToSession(sessionId, {
        type: "notice",
        message: `💬 **${personName}** answered (via Slack): ${slackAnswer}`,
      });
      await current.resolve(slackAnswerToAnswers(questions, slackAnswer));
    })
    .catch((error) => {
      console.error(
        `[asks] Failed to resolve Slack answer for ${sessionId}:`,
        error,
      );
    });
}

async function escalatePendingAsk(
  sessionId: string,
  questionId: string,
): Promise<void> {
  const current = pendingAsks.get(sessionId);
  if (!current || current.questionId !== questionId || current.answerReceived)
    return;
  if (current.escalatedAskId) {
    if (!current.escalationWaitStarted) {
      current.escalationWaitStarted = true;
      await pendingAsks.set(sessionId, current);
      waitForEscalatedAnswer(
        sessionId,
        questionId,
        current.questions as AskQuestionInput[],
        current.escalatedAskId,
        current.escalatedPersonName || "Your teammate",
      );
    }
    return;
  }
  const escalated = await escalateAskToSlack(
    sessionId,
    current.questionId,
    current.questions as AskQuestionInput[],
  );
  const latest = pendingAsks.get(sessionId);
  if (!latest || latest.questionId !== questionId || latest.answerReceived) {
    if (escalated) cancelAsk(escalated.askId);
    return;
  }
  if (!escalated) {
    await latest.resolve(null);
    return;
  }
  latest.escalatedAskId = escalated.askId;
  latest.escalatedPersonName = escalated.personName;
  latest.escalationWaitStarted = true;
  await pendingAsks.set(sessionId, latest);
  persistPendingAsks(latest.storePath);
  waitForEscalatedAnswer(
    sessionId,
    questionId,
    latest.questions as AskQuestionInput[],
    escalated.askId,
    escalated.personName,
  );
}

registerSessionTimerHandler("ask_escalation", async (timer) => {
  const payload = timer.payload as { questionId?: unknown } | undefined;
  if (typeof payload?.questionId !== "string") return;
  await escalatePendingAsk(timer.sessionId, payload.questionId);
});

async function armAskEscalation(
  sessionId: string,
  ask: PendingAsk,
  questions: AskQuestionInput[],
  now = Date.now(),
): Promise<void> {
  await clearAskTimer(sessionId);
  if (!ask.askedAt) return;
  if (ask.escalatedAskId) {
    if (!ask.escalationWaitStarted) {
      ask.escalationWaitStarted = true;
      waitForEscalatedAnswer(
        sessionId,
        ask.questionId,
        questions,
        ask.escalatedAskId,
        ask.escalatedPersonName || "Your teammate",
      );
    }
    return;
  }
  const dueAt = ask.askedAt + ASK_UI_TIMEOUT_MS;
  await sessionKernel(sessionId).scheduleTimer({
    timerId: "ask_escalation",
    kind: "ask_escalation",
    dueAt,
    payload: { questionId: ask.questionId },
  });
  const handle = setTimeout(
    () => {
      pendingAskTimers.delete(sessionId);
      void fireStoredSessionTimer(sessionId, "ask_escalation").catch((error) =>
        console.error(`[ask] Escalation timer failed for ${sessionId}:`, error),
      );
    },
    Math.max(0, dueAt - now),
  );
  pendingAskTimers.set(sessionId, { handle, dueAt });
}

/** Restore run-blocking cards after a real process restart. The durable entry
 * stays display state only until the adopted engine re-emits the ask and
 * makeAskHandler adopts its original question id and askedAt. */
export async function restorePendingAsks(
  options: {
    storePath?: string;
    now?: number;
    sessionExists?: (sessionId: string) => boolean;
  } = {},
): Promise<number> {
  const storePath = options.storePath ?? pendingAskStorePath();
  const actorAuthority =
    storePath === pendingAskStorePath() &&
    (await sessionAskMigrationComplete());
  if (storePath === pendingAskStorePath())
    askMigrationState.complete = actorAuthority;
  let stored: { asks?: PersistedPendingAsk[] };
  if (actorAuthority) {
    removeLegacyAskStore(storePath);
    const entries = (await sessionAsk({ op: "entries" })) as Array<
      [string, PendingAsk]
    >;
    stored = {
      asks: entries.map(([sessionId, ask]) => ({
        sessionId,
        questionId: ask.questionId,
        questions: ask.questions as AskQuestionInput[],
        askedAt: ask.askedAt || Date.now(),
        ...(ask.escalatedAskId ? { escalatedAskId: ask.escalatedAskId } : {}),
        ...(ask.escalatedPersonName
          ? { escalatedPersonName: ask.escalatedPersonName }
          : {}),
        ...(ask.answerReceived || ask.answer
          ? {
              answerReceived: true,
              earlyAnswer: ask.earlyAnswer ?? ask.answer?.answers ?? null,
            }
          : {}),
        ...(ask.answer ? { answer: ask.answer } : {}),
        // A crash between the actor's durable answer commit and the gateway
        // resolver leaves answerReceived unset; project the committed answer
        // so recovery consumes it instead of re-asking. The answer rides the
        // restored record so its retry identity survives the rewrite.
        ...(ask.answer ? { answer: ask.answer } : {}),
      })),
    };
  } else {
    if (!existsSync(storePath)) {
      if (storePath === pendingAskStorePath()) {
        await markSessionAskMigrationComplete();
        askMigrationState.complete = true;
        removeLegacyAskStore(storePath);
      }
      return 0;
    }
    try {
      stored = JSON.parse(readFileSync(storePath, "utf8"));
    } catch (e) {
      console.error("[ask] Failed to restore pending asks:", e);
      return 0;
    }
  }
  const sessionExists =
    options.sessionExists ?? ((sessionId) => !!findSession(sessionId));
  let restored = 0;
  for (const saved of stored.asks || []) {
    if (
      !saved?.sessionId ||
      !saved.questionId ||
      !Array.isArray(saved.questions) ||
      !Number.isFinite(saved.askedAt) ||
      !sessionExists(saved.sessionId) ||
      (!actorAuthority &&
        (await pendingAsks.getAsync(saved.sessionId)) !== undefined)
    ) {
      continue;
    }
    const ask: PendingAsk = {
      questionId: saved.questionId,
      questions: saved.questions,
      durable: true,
      askedAt: saved.askedAt,
      ...(saved.escalatedAskId ? { escalatedAskId: saved.escalatedAskId } : {}),
      ...(saved.escalatedPersonName
        ? { escalatedPersonName: saved.escalatedPersonName }
        : {}),
      ...(saved.answerReceived || saved.answer
        ? {
            answerReceived: true,
            earlyAnswer: saved.earlyAnswer ?? saved.answer?.answers ?? null,
          }
        : {}),
      ...(saved.answer ? { answer: saved.answer } : {}),
      restored: true,
      storePath,
      resolve: async (answers) =>
        resolveRestoredAsk(
          saved.sessionId,
          saved.questionId,
          saved.questions,
          answers,
        ),
    };
    await pendingAsks.set(saved.sessionId, ask);
    if (!ask.answerReceived) {
      await armAskEscalation(
        saved.sessionId,
        ask,
        saved.questions,
        options.now,
      );
      broadcastToSession(saved.sessionId, {
        type: "ask_question",
        sessionId: saved.sessionId,
        questionId: saved.questionId,
        questions: saved.questions,
      });
    }
    restored++;
  }
  // Drop invalid or deleted-session records immediately. A card removed before
  // the crash is absent because its answer path persists the delete first.
  if (storePath === pendingAskStorePath()) {
    await markSessionAskMigrationComplete();
    askMigrationState.complete = true;
    removeLegacyAskStore(storePath);
  }
  persistPendingAsks(storePath);
  if (restored > 0) {
    console.log(
      `[ask] Restored ${restored} pending question(s) from before restart`,
    );
  }
  return restored;
}

/**
 * Offer a question card on the session WITHOUT the makeAskHandler timeout /
 * Slack-escalation machinery: the card stays up until answered or `close()`d
 * by the caller. Built for humans-tools' blocking Slack asks — the DM is the
 * primary channel and already pings the asked teammate; this card gives the
 * session's own watcher a way to answer (or acknowledge an out-of-band action
 * like an SSO login) without interrupting the run. Answering calls `onAnswer`
 * once; closing retracts the card and never calls it.
 */
export async function offerAskCard(
  sessionId: string,
  questions: AskQuestionInput[],
  onAnswer: (answers: Record<string, string> | null) => void,
): Promise<{ close: () => Promise<void> }> {
  const questionId = crypto.randomUUID();
  let settled = false;
  let settling: Promise<void> | undefined;
  const retract = async () => {
    if (pendingAsks.get(sessionId)?.questionId === questionId) {
      await pendingAsks.delete(sessionId);
    }
    broadcastToSession(sessionId, {
      type: "ask_resolved",
      sessionId,
      questionId,
    });
  };
  const settle = (
    a: Record<string, string> | null,
    notify: boolean,
  ): Promise<void> => {
    if (settled) return Promise.resolve();
    if (settling) return settling;
    const attempt = (async () => {
      await retract();
      settled = true;
      if (notify) {
        recordAskAnswer(sessionId, questions, a);
        onAnswer(a);
      }
    })();
    settling = attempt.finally(() => {
      if (!settled) settling = undefined;
    });
    return settling;
  };
  await pendingAsks.set(sessionId, {
    questionId,
    questions,
    resolve: (a) => settle(a, true),
  });
  broadcastToSession(sessionId, {
    type: "ask_question",
    sessionId,
    questionId,
    questions,
  });
  return {
    close: () => settle(null, false),
  };
}

export function makeAskHandler(sessionId: string) {
  return async (
    input: Record<string, unknown>,
  ): Promise<
    | { behavior: "allow"; updatedInput: Record<string, unknown> }
    | { behavior: "deny"; message: string }
  > => {
    const questions = input.questions as AskQuestionInput[] | undefined;
    if (!questions || questions.length === 0) {
      return { behavior: "allow", updatedInput: input };
    }
    if (questions.some((q) => isAwsHumanAuthRequest(q.header, q.question))) {
      return {
        behavior: "deny",
        message: AWS_HUMAN_AUTH_DENIAL,
      };
    }

    const existing = pendingAsks.get(sessionId);
    const adopted =
      !!existing?.restored &&
      !!existing.durable &&
      sameQuestions(existing.questions, questions);
    if (existing?.restored && !adopted) {
      await retirePendingAsk(sessionId, existing.questionId);
      broadcastToSession(sessionId, {
        type: "ask_resolved",
        sessionId,
        questionId: existing.questionId,
      });
    }
    const questionId = adopted ? existing!.questionId : crypto.randomUUID();
    const askedAt = adopted ? existing!.askedAt! : Date.now();
    let settled = false;
    let escalatedAskId = adopted ? existing!.escalatedAskId || null : null;

    let resolveAnswers!: (answers: Record<string, string> | null) => void;
    let rejectAnswers!: (error: unknown) => void;
    const answersPromise = new Promise<Record<string, string> | null>(
      (resolve, reject) => {
        resolveAnswers = resolve;
        rejectAnswers = reject;
      },
    );
    let finishing: Promise<void> | undefined;
    const finish = (a: Record<string, string> | null): Promise<void> => {
      if (settled) return Promise.resolve();
      if (finishing) return finishing;
      const attempt = (async () => {
        await clearAskTimer(sessionId);
        const durableAnswer = pendingAsks.get(sessionId);
        if (durableAnswer?.questionId === questionId) {
          durableAnswer.answerReceived = true;
          durableAnswer.earlyAnswer = a;
          await pendingAsks.set(sessionId, durableAnswer);
          persistPendingAsks(durableAnswer.storePath);
        }
        await transitionRunState(sessionId, "ask_resolved", {
          answered: a !== null,
        });
        settled = true;
        // Before the card goes: the transcript's only trace of it.
        recordAskAnswer(sessionId, questions, a);
        // If the web UI answered after we'd already pinged Slack, retract the
        // Slack ask so the teammate isn't left answering a moot question.
        if (escalatedAskId) cancelAsk(escalatedAskId);
        resolveAnswers(a);
      })();
      finishing = attempt.finally(() => {
        if (!settled) finishing = undefined;
      });
      return finishing;
    };

    const ask: PendingAsk = {
      questionId,
      questions,
      durable: true,
      askedAt,
      ...(adopted && existing!.escalatedAskId
        ? { escalatedAskId: existing!.escalatedAskId }
        : {}),
      ...(adopted && existing!.escalatedPersonName
        ? { escalatedPersonName: existing!.escalatedPersonName }
        : {}),
      ...(adopted && existing!.escalationWaitStarted
        ? { escalationWaitStarted: true }
        : {}),
      ...(adopted && existing!.answerReceived
        ? {
            answerReceived: true,
            earlyAnswer: existing!.earlyAnswer ?? null,
          }
        : {}),
      // Preserve the durable answer receipt across adoption so retry
      // identity and the committed payload survive the rewrite.
      ...(adopted && existing!.answer ? { answer: existing!.answer } : {}),
      ...(adopted && existing!.storePath
        ? { storePath: existing!.storePath }
        : {}),
      resolve: finish,
    };
    try {
      await pendingAsks.set(sessionId, ask);
      persistPendingAsks(ask.storePath);
      await transitionRunState(sessionId, "ask_posed");
      if (ask.answerReceived) {
        queueMicrotask(() => {
          void finish(ask.earlyAnswer ?? null).catch(rejectAnswers);
        });
      } else {
        await armAskEscalation(sessionId, ask, questions);
        broadcastToSession(sessionId, {
          type: "ask_question",
          sessionId,
          questionId,
          questions,
        });
      }
      // Phone buzz: Web Push to the session owner's registered devices
      // (opt-in per device in Settings → Notifications). Best-effort —
      // never lets a push hiccup affect the ask flow. Deduped on the
      // question text: a restart resumes ask-blocked runs, which re-ask
      // the same question — that re-ask must not buzz again.
      if (!adopted && !ask.answerReceived)
        void (async () => {
          try {
            const s = findSession(sessionId);
            if (!s?.startedBy) return;
            const { sendPushToUser } = await import("./push");
            const { createHash } = await import("node:crypto");
            const qHash = createHash("sha256")
              .update(questions.map((q) => q.question).join("\n"))
              .digest("hex")
              .slice(0, 16);
            await sendPushToUser(
              s.startedBy,
              {
                title: `${personaName()} needs input`,
                body: `${s.title || sessionId} — ${questions[0]?.question || "a question is waiting"}`.slice(
                  0,
                  180,
                ),
                url: `/session/${encodeURIComponent(sessionId)}`,
                tag: `ask-${sessionId}`,
              },
              { dedupeKey: `ask:${sessionId}:${qHash}` },
            );
          } catch {}
        })();
    } catch (error) {
      rejectAnswers(error);
    }
    const answers = await answersPromise;

    broadcastToSession(sessionId, {
      type: "ask_resolved",
      sessionId,
      questionId,
    });

    if (!answers) {
      return {
        behavior: "deny",
        message:
          "Nobody answered in time (web or Slack). Proceed with your best judgment and clearly note the open question and the assumption you made.",
      };
    }
    return { behavior: "allow", updatedInput: { ...input, answers } };
  };
}

// Escalate an unanswered AskUserQuestion to the session's original prompter over
// Slack. Returns the human-ask id (await its blocking answer) + who we asked, or
// null when we can't resolve a teammate. Best-effort: never throws into the handler.
async function escalateAskToSlack(
  sessionId: string,
  questionId: string,
  questions: AskQuestionInput[],
): Promise<{ askId: string; personName: string } | null> {
  try {
    const session = findSession(sessionId);
    const person = resolveTeammate(session?.startedBy ?? null);
    if (!person) return null;

    const { question, options } = askToSlackPrompt(questions);
    const ask = registerAsk({
      id: `ask-${questionId}`,
      sessionId,
      createdBy: session?.startedBy || personaName(),
      person,
      question,
      options,
      mode: "block",
      deliver: "now",
    });
    broadcastToSession(sessionId, {
      type: "notice",
      message: `No answer in ${productName()} — asked ${person.name} over Slack.`,
    });
    return { askId: ask.id, personName: person.name };
  } catch (e) {
    console.error("[ask] Slack escalation failed:", e);
    return null;
  }
}
