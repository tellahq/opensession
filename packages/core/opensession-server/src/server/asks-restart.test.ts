import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  makeAskHandler,
  pendingAskAwaitingAnswer,
  pendingAskAwaitingAnswerSync,
  pendingAsks,
  pendingAskTimers,
  persistPendingAsks,
  restorePendingAsks,
  settleRestoredAskAfterRecovery,
} from "./asks";
import { sessionWatchers } from "./ws-hub";
import {
  registerSessionControl,
  tryGetSessionControl,
  type SessionControl,
} from "./session-control";
import { setTranscriptForwarder } from "./transcript-forward";
import { __setSessionsDirForTest, sessionsDir } from "./paths";
import { sessionAsk } from "./session-kernel";
import { stripContext } from "./prompt-context";

const SESSION = "os-pending-ask-restart-test";
const QUESTION = {
  header: "Choice",
  question: "Which option?",
  options: [{ label: "One" }, { label: "Two" }],
};

let scratch = "";

async function resetState(): Promise<void> {
  for (const timer of pendingAskTimers.values()) clearTimeout(timer.handle);
  pendingAskTimers.clear();
  await pendingAsks.clear();
  sessionWatchers.delete(SESSION);
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = "";
}

afterEach(resetState);

describe("pending ask restart persistence", () => {
  test("rejects the ask when its initial durable write fails", async () => {
    const originalSet = pendingAsks.set.bind(pendingAsks);
    (pendingAsks as any).set = async () => {
      throw new Error("initial ask write failed");
    };
    try {
      await expect(
        makeAskHandler(SESSION)({ questions: [QUESTION] }),
      ).rejects.toThrow("initial ask write failed");
    } finally {
      (pendingAsks as any).set = originalSet;
    }
  });

  test("keeps an ask answer retryable when its durable write fails", async () => {
    const originalSet = pendingAsks.set.bind(pendingAsks);
    let writes = 0;
    let cardReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      cardReady = resolve;
    });
    sessionWatchers.set(
      SESSION,
      new Set([
        {
          data: { watchingSessionId: SESSION, user: "Test" },
          send: (payload: string) => {
            if (JSON.parse(payload).type === "ask_question") cardReady();
          },
        } as never,
      ]),
    );
    (pendingAsks as any).set = async (sessionId: string, value: any) => {
      writes += 1;
      if (writes === 2) throw new Error("answer write failed");
      return await originalSet(sessionId, value);
    };
    try {
      const result = makeAskHandler(SESSION)({ questions: [QUESTION] });
      await ready;
      const ask = pendingAsks.get(SESSION)!;
      await expect(ask.resolve({ "Which option?": "One" })).rejects.toThrow(
        "answer write failed",
      );
      expect(writes).toBe(2);
      await ask.resolve({ "Which option?": "One" });
      expect(await result).toEqual({
        behavior: "allow",
        updatedInput: {
          questions: [QUESTION],
          answers: { "Which option?": "One" },
        },
      });
    } finally {
      (pendingAsks as any).set = originalSet;
    }
  });
  test("restores the card and keeps the original escalation deadline", async () => {
    scratch = mkdtempSync(join(tmpdir(), "os-asks-restart-"));
    const storePath = join(scratch, "pending-asks.json");
    const askedAt = Date.now() - 60_000;
    writeFileSync(
      storePath,
      JSON.stringify({
        asks: [
          {
            sessionId: SESSION,
            questionId: "q-restored",
            questions: [QUESTION],
            askedAt,
          },
          {
            sessionId: "os-deleted",
            questionId: "q-stale",
            questions: [QUESTION],
            askedAt,
          },
        ],
      }),
    );
    const sent: unknown[] = [];
    sessionWatchers.set(
      SESSION,
      new Set([
        {
          data: { watchingSessionId: SESSION, user: "Test" },
          send: (payload: string) => sent.push(JSON.parse(payload)),
        } as never,
      ]),
    );

    expect(
      await restorePendingAsks({
        storePath,
        now: askedAt + 60_000,
        sessionExists: (id) => id === SESSION,
      }),
    ).toBe(1);
    expect(pendingAsks.get(SESSION)).toMatchObject({
      questionId: "q-restored",
      askedAt,
      restored: true,
    });
    expect(pendingAskTimers.get(SESSION)?.dueAt).toBe(askedAt + 4 * 60_000);
    expect(sent).toContainEqual({
      type: "ask_question",
      sessionId: SESSION,
      questionId: "q-restored",
      questions: [QUESTION],
    });
    const persisted = JSON.parse(readFileSync(storePath, "utf8"));
    expect(
      persisted.asks.map((ask: { sessionId: string }) => ask.sessionId),
    ).toEqual([SESSION]);
  });

  test("a re-emitted engine ask adopts the restored card and live promise", async () => {
    scratch = mkdtempSync(join(tmpdir(), "os-asks-adopt-"));
    const storePath = join(scratch, "pending-asks.json");
    const askedAt = Date.now();
    writeFileSync(
      storePath,
      JSON.stringify({
        asks: [
          {
            sessionId: SESSION,
            questionId: "q-same",
            questions: [QUESTION],
            askedAt,
          },
        ],
      }),
    );
    await restorePendingAsks({ storePath, sessionExists: () => true });

    const resultPromise = makeAskHandler(SESSION)({ questions: [QUESTION] });
    await Bun.sleep(0);
    expect(pendingAsks.get(SESSION)).toMatchObject({
      questionId: "q-same",
      askedAt,
    });
    expect(pendingAsks.get(SESSION)?.restored).toBeUndefined();
    await pendingAsks.get(SESSION)?.resolve({ "Which option?": "Two" });

    expect(await resultPromise).toEqual({
      behavior: "allow",
      updatedInput: {
        questions: [QUESTION],
        answers: { "Which option?": "Two" },
      },
    });
    expect(pendingAsks.get(SESSION)).toMatchObject({ answerReceived: true });
    await settleRestoredAskAfterRecovery(SESSION);
    expect(pendingAsks.has(SESSION)).toBe(false);
    expect(JSON.parse(readFileSync(storePath, "utf8"))).toEqual({ asks: [] });
  });

  test("an answer before adoption resolves the re-emitted tool call", async () => {
    scratch = mkdtempSync(join(tmpdir(), "os-asks-early-answer-"));
    const storePath = join(scratch, "pending-asks.json");
    writeFileSync(
      storePath,
      JSON.stringify({
        asks: [
          {
            sessionId: SESSION,
            questionId: "q-early",
            questions: [QUESTION],
            askedAt: Date.now(),
          },
        ],
      }),
    );
    await restorePendingAsks({ storePath, sessionExists: () => true });
    await pendingAsks.get(SESSION)?.resolve({ "Which option?": "One" });

    expect(pendingAsks.get(SESSION)).toMatchObject({
      questionId: "q-early",
      answerReceived: true,
      earlyAnswer: { "Which option?": "One" },
    });
    // The recovery record stays durable until the run host adopts it, but a
    // reconnecting web or native client must not receive the card again.
    expect(await pendingAskAwaitingAnswer(SESSION)).toBeUndefined();
    expect(pendingAskAwaitingAnswerSync(SESSION)).toBeUndefined();
    const persisted = JSON.parse(readFileSync(storePath, "utf8"));
    expect(persisted.asks[0]).toMatchObject({
      questionId: "q-early",
      answerReceived: true,
      earlyAnswer: { "Which option?": "One" },
    });
    for (const timer of pendingAskTimers.values()) clearTimeout(timer.handle);
    pendingAskTimers.clear();
    await pendingAsks.clear();
    const sent: unknown[] = [];
    sessionWatchers.set(
      SESSION,
      new Set([
        {
          data: { watchingSessionId: SESSION, user: "Test" },
          send: (payload: string) => sent.push(JSON.parse(payload)),
        } as never,
      ]),
    );
    await restorePendingAsks({ storePath, sessionExists: () => true });
    expect(pendingAsks.get(SESSION)).toMatchObject({
      answerReceived: true,
      earlyAnswer: { "Which option?": "One" },
    });
    expect(await pendingAskAwaitingAnswer(SESSION)).toBeUndefined();
    expect(pendingAskAwaitingAnswerSync(SESSION)).toBeUndefined();
    expect(pendingAskTimers.has(SESSION)).toBe(false);
    expect(sent).not.toContainEqual(
      expect.objectContaining({ type: "ask_question" }),
    );

    expect(await makeAskHandler(SESSION)({ questions: [QUESTION] })).toEqual({
      behavior: "allow",
      updatedInput: {
        questions: [QUESTION],
        answers: { "Which option?": "One" },
      },
    });
    expect(pendingAsks.get(SESSION)).toMatchObject({ answerReceived: true });
    await settleRestoredAskAfterRecovery(SESSION);
    expect(pendingAsks.has(SESSION)).toBe(false);
    expect(JSON.parse(readFileSync(storePath, "utf8"))).toEqual({ asks: [] });
  });

  test("records a receipt and hides the terminal recovery delivery", async () => {
    scratch = mkdtempSync(join(tmpdir(), "os-asks-terminal-answer-"));
    const storePath = join(scratch, "pending-asks.json");
    writeFileSync(
      storePath,
      JSON.stringify({
        asks: [
          {
            sessionId: SESSION,
            questionId: "q-terminal-answer",
            questions: [QUESTION],
            askedAt: Date.now(),
            answerReceived: true,
            earlyAnswer: { "Which option?": "Two" },
          },
        ],
      }),
    );
    await restorePendingAsks({ storePath, sessionExists: () => true });

    const previousControl = tryGetSessionControl();
    const deliveries: string[] = [];
    const lines: Record<string, unknown>[] = [];
    registerSessionControl({
      listSessions: () => [],
      getSession: () => undefined,
      transcriptTail: async () => [],
      answerQuestion: () => false,
      deliverToSession: async (_id, content) => {
        deliveries.push(content);
        return { status: "queued", message: "queued" };
      },
      cancelSession: () => false,
      reparentSession: async () => ({ ok: false, error: "not used" }),
      createSession: async () => ({
        id: "unused",
        createdBy: "Test",
        createdAt: "now",
      }),
    });
    setTranscriptForwarder((_sessionId, batch) => lines.push(...batch));
    try {
      expect(await settleRestoredAskAfterRecovery(SESSION)).toBe(true);
      await Bun.sleep(0);
    } finally {
      registerSessionControl(previousControl as SessionControl);
      setTranscriptForwarder(undefined);
    }

    expect(JSON.stringify(lines)).toContain('"answer":"Two"');
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toContain(
      '<opensession:context source="restart-recovery">',
    );
    expect(deliveries[0]).toContain("Question: Which option?\nAnswer: Two");
    expect(stripContext(deliveries[0])).toBe("");
  });

  test("retires a restored card when recovery ends without adopting it", async () => {
    scratch = mkdtempSync(join(tmpdir(), "os-asks-terminal-"));
    const storePath = join(scratch, "pending-asks.json");
    writeFileSync(
      storePath,
      JSON.stringify({
        asks: [
          {
            sessionId: SESSION,
            questionId: "q-terminal",
            questions: [QUESTION],
            askedAt: Date.now(),
          },
        ],
      }),
    );
    await restorePendingAsks({ storePath, sessionExists: () => true });

    await settleRestoredAskAfterRecovery(SESSION);

    expect(pendingAsks.has(SESSION)).toBe(false);
    expect(pendingAskTimers.has(SESSION)).toBe(false);
    expect(JSON.parse(readFileSync(storePath, "utf8"))).toEqual({ asks: [] });
  });

  test("commit \u2192 crash \u2192 restore \u2192 adopt \u2192 retry keeps answer identity", async () => {
    scratch = mkdtempSync(join(tmpdir(), "os-asks-crash-retry-"));
    const previousSessionsDir = sessionsDir();
    __setSessionsDirForTest(scratch);
    try {
      const resultPromise = makeAskHandler(SESSION)({ questions: [QUESTION] });
      const questionId = pendingAsks.get(SESSION)?.questionId ?? null;

      // The actor commits the answer durably; the process crashes before
      // the gateway resolver runs, so nothing retires the record.
      expect(
        await sessionAsk({
          op: "answer",
          sessionId: SESSION,
          questionId,
          answers: { "Which option?": "One" },
          answeredVia: "req-original",
        }),
      ).toEqual({ matched: true });
      // Process loss drops timers and closures, never the durable record.
      clearTimeout(pendingAskTimers.get(SESSION)?.handle);
      pendingAskTimers.delete(SESSION);

      // Restart: recovery reads actor authority and projects the
      // committed answer as answered instead of re-asking.
      await restorePendingAsks({ sessionExists: () => true });
      await restorePendingAsks({ sessionExists: () => true });
      const restored = pendingAsks.get(SESSION);
      expect(restored?.answerReceived).toBe(true);
      expect(restored?.earlyAnswer).toEqual({ "Which option?": "One" });
      expect(restored?.answer?.requestId).toBe("req-original");

      // The recovered engine re-emits its ask; adoption rewrites the
      // record and must carry the receipt with it.
      void makeAskHandler(SESSION)({ questions: [QUESTION] });
      expect(pendingAsks.get(SESSION)?.answer?.requestId).toBe("req-original");

      // The exact caller retries: replay matched with committed answers.
      expect(
        await sessionAsk({
          op: "answer",
          sessionId: SESSION,
          questionId,
          answers: { "Which option?": "Something else" },
          answeredVia: "req-original",
        }),
      ).toEqual({
        matched: true,
        answers: { "Which option?": "One" },
      });
      expect(
        await sessionAsk({
          op: "answer",
          sessionId: SESSION,
          questionId,
          answers: { "Which option?": "Two" },
          answeredVia: "req-other",
        }),
      ).toEqual({ matched: false });

      // The adopted live waiter still wakes with the committed answers.
      await pendingAsks.get(SESSION)?.resolve({ "Which option?": "One" });
    } finally {
      __setSessionsDirForTest(previousSessionsDir);
    }
  });
});
