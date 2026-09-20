import { expect, test } from "bun:test";
import { SessionVoiceRuntime } from "./session-voice-runtime";
import type { SessionVoiceClient } from "./session-voice-client";
import type { PromptOutboxInput } from "./prompt-outbox";
import type { TranscriptEntry } from "./types";

function setup(deliveryIds = false, failPrompt?: string) {
  let options: ConstructorParameters<typeof SessionVoiceClient>[0] | undefined;
  let stops = 0;
  let user = "Alice";
  const prompts: PromptOutboxInput[] = [];
  const contexts: string[] = [];
  const replies: string[] = [];
  const replyPrompts: Array<string | undefined> = [];
  const replyCounts: Array<number | undefined> = [];
  const runtime = new SessionVoiceRuntime({
    currentUser: () => user,
    enqueue: (input) => {
      if (input.content === failPrompt) throw new Error("Outbox unavailable");
      prompts.push(input);
      return deliveryIds ? `delivery-${prompts.length}` : undefined;
    },
    createClient: (opts) => {
      options = opts;
      return {
        start: async () => opts.onState("listening"),
        setPaused: (paused) => opts.onState(paused ? "paused" : "listening"),
        stop: () => {
          stops++;
        },
        updateContext: (context) => {
          contexts.push(context);
        },
        agentReply: (reply, prompt, count) => {
          if (reply !== null) replies.push(reply);
          replyPrompts.push(prompt);
          replyCounts.push(count);
        },
      };
    },
  });
  return {
    runtime,
    prompts,
    contexts,
    replies,
    replyPrompts,
    replyCounts,
    options: () => options!,
    stops: () => stops,
    switchUser: () => {
      user = "Bob";
    },
  };
}
function entry(
  id: string,
  type: TranscriptEntry["type"],
  content: string,
  seq: number,
): TranscriptEntry {
  return {
    id,
    type,
    content,
    seq,
    timestamp: new Date(seq * 1000).toISOString(),
  };
}
const seed = [entry("old", "assistant", "Existing answer", 1)];

test("navigation moves the call to the global panel without hanging up or changing its source", () => {
  const h = setup();
  const sourceView = Symbol();
  const otherView = Symbol();
  h.runtime.setView(sourceView, "source", true);
  h.runtime.start({
    sessionId: "source",
    title: "Original thread",
    entries: seed,
    busy: false,
  });
  expect(h.runtime.getSnapshot().sourceVisible).toBe(true);
  h.runtime.removeView(sourceView);
  h.runtime.setView(otherView, "other", true);
  expect(h.stops()).toBe(0);
  expect(h.runtime.getSnapshot()).toMatchObject({
    active: true,
    sessionId: "source",
    sourceVisible: false,
  });
  h.runtime.setView(sourceView, "source", true);
  expect(h.runtime.getSnapshot().sourceVisible).toBe(true);
  expect(h.stops()).toBe(0);
});

test("submitted work keeps targeting the original thread after its composer unmounts", async () => {
  const h = setup();
  h.runtime.start({
    sessionId: "source",
    title: "Original",
    entries: seed,
    busy: true,
  });
  h.runtime.setView(Symbol(), "other", true);
  expect(await h.options().onAgentRequest("Check the test")).toBe(true);
  expect(h.prompts).toEqual([
    {
      sessionId: "source",
      content: "Check the test",
      user: "Alice",
      busyMode: "steer",
    },
  ]);
  h.runtime.receive({
    type: "transcript_append",
    sessionId: "other",
    entries: [entry("other-answer", "assistant", "Wrong thread", 5)],
  });
  expect(h.contexts).toEqual([]);
  h.runtime.receive({
    type: "transcript_append",
    sessionId: "source",
    entries: [
      entry("question", "user", "Check the test", 2),
      entry("answer", "assistant", "The test passes", 3),
    ],
  });
  expect(h.replies).toEqual([]);
  h.runtime.receive({
    type: "session_status",
    sessionId: "source",
    isRunning: false,
  });
  expect(h.replies).toEqual(["The test passes"]);
  expect(h.contexts[0]).toContain("The test passes");
});

test("explicit hangup or identity change prevents a stale call from submitting work", async () => {
  const h = setup();
  h.runtime.start({
    sessionId: "source",
    title: "Original",
    entries: seed,
    busy: false,
  });
  h.switchUser();
  expect(await h.options().onAgentRequest("Do not send")).toBe(false);
  h.runtime.stop();
  expect(await h.options().onAgentRequest("Do not send")).toBe(false);
  expect(h.prompts).toEqual([]);
  expect(h.stops()).toBe(1);
});

test("starting a new call replaces the old call only on explicit request", () => {
  const h = setup();
  h.runtime.start({
    sessionId: "source",
    title: "Original",
    entries: seed,
    busy: false,
  });
  h.runtime.start({
    sessionId: "other",
    title: "Other",
    entries: [],
    busy: false,
  });
  expect(h.stops()).toBe(1);
  expect(h.runtime.getSnapshot()).toMatchObject({
    sessionId: "other",
    active: true,
  });
});

test("the global pause control retains the call and source", () => {
  const h = setup();
  h.runtime.start({
    sessionId: "source",
    title: "Original",
    entries: seed,
    busy: false,
  });
  h.runtime.togglePause();
  expect(h.runtime.getSnapshot()).toMatchObject({
    sessionId: "source",
    state: "paused",
    active: true,
  });
  h.runtime.togglePause();
  expect(h.runtime.getSnapshot()).toMatchObject({
    sessionId: "source",
    state: "listening",
    active: true,
  });
  expect(h.stops()).toBe(0);
});

test.each([
  "Adjust the orb.\nMake microphone reactions stronger and remove clipping.",
  "Propose a design for the orb. Do not implement it yet.",
])("the outbox receives the requested task unchanged: %s", async (prompt) => {
  const h = setup();
  h.runtime.start({
    sessionId: "source",
    title: "Original",
    entries: seed,
    busy: false,
  });
  expect(await h.options().onAgentRequest(prompt)).toBe(true);
  expect(h.prompts).toEqual([
    {
      sessionId: "source",
      content: prompt,
      user: "Alice",
      busyMode: "steer",
    },
  ]);
});

test("three tasks absorbed by one run share its final result, narrated once", async () => {
  const h = setup();
  h.runtime.start({
    sessionId: "source",
    title: "Original",
    entries: seed,
    busy: false,
  });
  for (const prompt of ["First task", "Same task", "Same task"])
    expect(await h.options().onAgentRequest(prompt)).toBe(true);
  expect(h.prompts.map((prompt) => prompt.busyMode)).toEqual([
    "steer",
    "steer",
    "steer",
  ]);
  h.runtime.receive({ type: "stream_start", sessionId: "source" });
  h.runtime.receive({
    type: "transcript_append",
    sessionId: "source",
    entries: [
      entry("q1", "user", "First task", 2),
      entry("a1", "assistant", "First result", 3),
      entry("q2", "user", "Same task", 4),
      entry("a2", "assistant", "Second result", 5),
    ],
  });
  expect(h.replies).toEqual([]);
  h.runtime.receive({
    type: "transcript_append",
    sessionId: "source",
    entries: [
      entry("q3", "user", "Same task", 6),
      entry("a3", "assistant", "Third result", 7),
    ],
  });
  expect(h.replies).toEqual([]);
  h.runtime.receive({
    type: "session_status",
    sessionId: "source",
    isRunning: false,
  });
  expect(h.replies).toEqual(["Third result"]);
  expect(h.replyPrompts).toEqual(["First task\n\nSame task\n\nSame task"]);
  expect(h.replyCounts).toEqual([3]);
  h.runtime.receive({
    type: "session_status",
    sessionId: "source",
    isRunning: false,
  });
  expect(h.replies).toHaveLength(1);
});

test("tasks answered by separate runs each narrate their own result", async () => {
  const h = setup(true);
  h.runtime.start({
    sessionId: "source",
    title: "Original",
    entries: seed,
    busy: false,
  });
  await h.options().onAgentRequest("First task");
  h.runtime.receive({ type: "stream_start", sessionId: "source" });
  h.runtime.receive({
    type: "transcript_append",
    sessionId: "source",
    entries: [
      {
        ...entry("turn-1", "user", "First task", 2),
        sourceMessageIds: ["delivery-1"],
      },
      entry("a1", "assistant", "First result", 3),
    ],
  });
  h.runtime.receive({
    type: "session_status",
    sessionId: "source",
    isRunning: false,
  });
  expect(h.replies).toEqual(["First result"]);
  await h.options().onAgentRequest("Second task");
  h.runtime.receive({ type: "stream_start", sessionId: "source" });
  h.runtime.receive({
    type: "transcript_append",
    sessionId: "source",
    entries: [
      {
        ...entry("turn-2", "user", "Second task", 4),
        sourceMessageIds: ["delivery-2"],
      },
      entry("a2", "assistant", "Second result", 5),
    ],
  });
  expect(h.replies).toEqual(["First result"]);
  h.runtime.receive({
    type: "session_status",
    sessionId: "source",
    isRunning: false,
  });
  expect(h.replies).toEqual(["First result", "Second result"]);
  expect(h.replyCounts).toEqual([1, 1]);
});

test("tasks steered into a running turn share its final reply and skip mid-run commentary", async () => {
  const h = setup(true);
  h.runtime.start({
    sessionId: "source",
    title: "Original",
    entries: [
      entry("typed-prompt", "user", "Refactor the parser", 1),
      entry("working", "assistant", "Starting on the parser", 2),
    ],
    busy: true,
  });
  await h.options().onAgentRequest("Check CI");
  // A steered task lands inside the running turn: the user row's id is the
  // outbox delivery id and its sourceMessageIds carry that same id.
  h.runtime.receive({
    type: "transcript_append",
    sessionId: "source",
    entries: [
      {
        ...entry("delivery-1", "user", "[Alice] Check CI", 3),
        sourceMessageIds: ["delivery-1"],
      },
      entry("commentary", "assistant", "Looking at CI now", 4),
    ],
  });
  await h.options().onAgentRequest("Also run lint");
  h.runtime.receive({
    type: "transcript_append",
    sessionId: "source",
    entries: [
      {
        ...entry("delivery-2", "user", "[Alice] Also run lint", 5),
        sourceMessageIds: ["delivery-2"],
      },
      entry("final", "assistant", "Parser refactored, CI green, lint clean", 6),
    ],
  });
  expect(h.prompts.map((prompt) => prompt.busyMode)).toEqual([
    "steer",
    "steer",
  ]);
  expect(h.replies).toEqual([]);
  h.runtime.receive({
    type: "session_status",
    sessionId: "source",
    isRunning: false,
  });
  expect(h.replies).toEqual(["Parser refactored, CI green, lint clean"]);
  expect(h.replyPrompts).toEqual(["Check CI\n\nAlso run lint"]);
  expect(h.replyCounts).toEqual([2]);
  h.runtime.receive({
    type: "session_status",
    sessionId: "source",
    isRunning: false,
  });
  expect(h.replies).toHaveLength(1);
});

test("a message from someone else during the run still ends the task's turn", async () => {
  const h = setup(true);
  h.runtime.start({
    sessionId: "source",
    title: "Original",
    entries: seed,
    busy: true,
  });
  await h.options().onAgentRequest("Check CI");
  h.runtime.receive({
    type: "transcript_append",
    sessionId: "source",
    entries: [
      {
        ...entry("delivery-1", "user", "[Alice] Check CI", 2),
        sourceMessageIds: ["delivery-1"],
      },
      entry("ci", "assistant", "CI is green", 3),
      {
        ...entry("bob-turn", "user", "[Bob] Deploy it", 4),
        sourceMessageIds: ["bob-delivery"],
      },
      entry("deploy", "assistant", "Deployed", 5),
    ],
  });
  h.runtime.receive({
    type: "session_status",
    sessionId: "source",
    isRunning: false,
  });
  expect(h.replies).toEqual(["CI is green"]);
});

test("pause keeps submitted work, hangup and replacement ignore stale callbacks and replies", async () => {
  const h = setup();
  h.runtime.start({
    sessionId: "source",
    title: "Original",
    entries: seed,
    busy: true,
  });
  const old = h.options();
  expect(await old.onAgentRequest("One")).toBe(true);
  expect(await old.onAgentRequest("Two")).toBe(true);
  h.runtime.togglePause();
  expect(await old.onAgentRequest("While paused")).toBe(false);
  h.runtime.receive({
    type: "transcript_append",
    sessionId: "source",
    entries: [
      entry("q1", "user", "One", 2),
      entry("a1", "assistant", "One done", 3),
    ],
  });
  h.runtime.receive({
    type: "session_status",
    sessionId: "source",
    isRunning: false,
  });
  h.runtime.receive({ type: "stream_start", sessionId: "source" });
  h.runtime.receive({
    type: "transcript_append",
    sessionId: "source",
    entries: [
      entry("q2", "user", "Two", 4),
      entry("a2", "assistant", "Two done", 5),
    ],
  });
  h.runtime.receive({
    type: "session_status",
    sessionId: "source",
    isRunning: false,
  });
  expect(h.replies).toEqual(["One done", "Two done"]);
  h.runtime.stop();
  h.runtime.start({
    sessionId: "other",
    title: "Other",
    entries: [],
    busy: false,
  });
  expect(await old.onAgentRequest("Late")).toBe(false);
  old.onState("working");
  expect(h.runtime.getSnapshot().state).toBe("listening");
  h.runtime.receive({
    type: "transcript_append",
    sessionId: "source",
    entries: [entry("late", "assistant", "Late", 6)],
  });
  expect(h.replies).toHaveLength(2);
  expect(h.prompts).toHaveLength(2);
});

test("durable delivery IDs correlate merged repeated tasks and narrate their shared result once", async () => {
  const h = setup(true);
  h.runtime.start({
    sessionId: "source",
    title: "Original",
    entries: seed,
    busy: true,
  });
  await h.options().onAgentRequest("Same task");
  await h.options().onAgentRequest("Same task");
  h.runtime.receive({
    type: "transcript_append",
    sessionId: "source",
    entries: [
      {
        ...entry("batch", "user", "[Alice] Same task", 2),
        sourceMessageIds: ["delivery-1"],
      },
      {
        ...entry("batch-j2", "user", "[Alice] Same task", 3),
        sourceMessageIds: ["delivery-2"],
      },
      entry("answer", "assistant", "Partial", 4),
      { ...entry("next", "system", "", 5), turnBoundary: true },
      entry("later", "assistant", "Unrelated background result", 6),
    ],
  });
  expect(h.replies).toEqual([]);
  h.runtime.receive({
    type: "transcript_append",
    sessionId: "source",
    entries: [entry("answer", "assistant", "Both tasks finished", 4)],
  });
  h.runtime.receive({
    type: "session_status",
    sessionId: "source",
    isRunning: false,
  });
  expect(h.replies).toEqual(["Both tasks finished"]);
  expect(h.replyPrompts).toEqual(["Same task\n\nSame task"]);
  expect(h.replyCounts).toEqual([2]);
  h.runtime.receive({
    type: "session_status",
    sessionId: "source",
    isRunning: false,
  });
  expect(h.replies).toHaveLength(1);
});

test("several deliveries represented by one user entry consume all matching requests", async () => {
  const h = setup(true);
  h.runtime.start({
    sessionId: "source",
    title: "Original",
    entries: seed,
    busy: true,
  });
  await h.options().onAgentRequest("One");
  await h.options().onAgentRequest("Two");
  h.runtime.receive({
    type: "transcript_append",
    sessionId: "source",
    entries: [
      {
        ...entry("batch", "user", "Combined tasks", 2),
        sourceMessageIds: ["delivery-1", "delivery-2"],
      },
      entry("answer", "assistant", "Both done", 3),
    ],
  });
  h.runtime.receive({
    type: "session_status",
    sessionId: "source",
    isRunning: false,
  });
  expect(h.replies).toEqual(["Both done"]);
  expect(h.replyCounts).toEqual([2]);
});

test("failed enqueue preserves earlier requests and does not leave a phantom pending request", async () => {
  const h = setup(false, "Fail");
  h.runtime.start({
    sessionId: "source",
    title: "Original",
    entries: seed,
    busy: false,
  });
  expect(await h.options().onAgentRequest("Fail")).toBe(false);
  expect(await h.options().onAgentRequest("First")).toBe(true);
  expect(h.prompts[0]?.busyMode).toBe("steer");
  expect(await h.options().onAgentRequest("Fail")).toBe(false);
  expect(await h.options().onAgentRequest("Second")).toBe(true);
  expect(h.prompts[1]?.busyMode).toBe("steer");
  h.runtime.receive({
    type: "transcript_append",
    sessionId: "source",
    entries: [
      entry("q1", "user", "First", 2),
      entry("a1", "assistant", "First done", 3),
    ],
  });
  h.runtime.receive({
    type: "transcript_append",
    sessionId: "source",
    entries: [
      entry("q2", "user", "Second", 4),
      entry("a2", "assistant", "Second done", 5),
    ],
  });
  expect(h.replies).toEqual(["First done", "Second done"]);
  expect(h.replyCounts).toEqual([1, 1]);
});

test("late hydration of another delivery in a completed batch never narrates its answer twice", async () => {
  const h = setup(true);
  h.runtime.start({
    sessionId: "source",
    title: "Original",
    entries: seed,
    busy: false,
  });
  await h.options().onAgentRequest("Same");
  await h.options().onAgentRequest("Same");
  h.runtime.receive({
    type: "transcript_append",
    sessionId: "source",
    entries: [
      {
        ...entry("batch", "user", "Same", 2),
        sourceMessageIds: ["delivery-1"],
      },
      entry("answer", "assistant", "Done", 4),
    ],
  });
  expect(h.replies).toEqual(["Done"]);
  h.runtime.receive({
    type: "transcript_append",
    sessionId: "source",
    entries: [
      {
        ...entry("batch-j2", "user", "Same", 3),
        sourceMessageIds: ["delivery-2"],
      },
    ],
  });
  expect(h.replies).toEqual(["Done"]);
  expect(h.replyCounts).toEqual([1, 1]);
  await h.options().onAgentRequest("Next");
  expect(h.prompts.at(-1)?.busyMode).toBe("steer");
});
