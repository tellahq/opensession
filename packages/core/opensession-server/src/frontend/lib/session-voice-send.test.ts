import { expect, spyOn, test } from "bun:test";
import { sendSessionMessage } from "./session-viewer-send";
import { promptOutbox, type PromptOutboxInput } from "./prompt-outbox";
import { TranscriptViewStore } from "./transcript-view-store";
import * as userPicker from "../components/UserPicker";
import * as hides from "./hides";

test("voice uses the existing durable queue without consuming the composer's draft or settings", () => {
  const sent: PromptOutboxInput[] = [];
  const enqueue = spyOn(promptOutbox, "enqueue").mockImplementation((input) => {
    sent.push(input);
    return {
      ...input,
      clientId: "spoken-message",
      state: "pending",
      attempts: 0,
      createdAt: 1,
      nextAttemptAt: 1,
    };
  });
  const user = spyOn(userPicker, "getCurrentUser").mockReturnValue("Alice");
  const unhide = spyOn(hides, "unhideForSession").mockImplementation(() => {});
  const untouched = () => {
    throw new Error("Voice must not touch the draft");
  };
  try {
    const accepted = sendSessionMessage("Spoken request", undefined, [], {
      identity: {
        noEngine: false,
        noteMode: false,
        session: {
          id: "session",
          title: "Existing agent",
          source: "opensession",
          branch: "work",
          worktreeDir: null,
          startedBy: "Alice",
          createdAt: "2026-09-18",
          lastActivity: "2026-09-18",
          isRunning: true,
          model: "existing-model",
        },
      },
      draft: {
        draftKey: "session",
        images: ["unsent-image"],
        files: [{ name: "unsent-file", type: "text/plain", path: "/draft" }],
        quote: { id: "quote", text: "Unsent quote" },
        contextSessions: ["unsent-context"],
        forkFrom: null,
        setImages: untouched,
        setFiles: untouched,
        setQuote: untouched,
        setContextSessions: untouched,
        setForkFrom: untouched,
      },
      runtime: {
        isBusy: true,
        effort: "high",
        fastMode: true,
        pendingRef: { current: [] },
        setPending() {},
        dispatch() {},
      },
      transcript: {
        viewStore: new TranscriptViewStore(),
        sequenceRef: { current: { sessionId: "session", lastSeq: 3 } },
        tailActionNeedsLayoutScrollRef: { current: false },
        cancelIndexAnchorHold() {},
        scrollToLatest() {},
      },
      send() {
        throw new Error("Voice must use the durable outbox, not bypass it");
      },
    });
    expect(accepted).toBe(true);
    expect(sent).toEqual([
      {
        sessionId: "session",
        content: "Spoken request",
        user: "Alice",
        effort: "high",
        fastMode: true,
        busyMode: "queue",
        transcriptAfterEntryId: null,
        transcriptAfterSeq: 3,
      },
    ]);
  } finally {
    enqueue.mockRestore();
    user.mockRestore();
    unhide.mockRestore();
  }
});
