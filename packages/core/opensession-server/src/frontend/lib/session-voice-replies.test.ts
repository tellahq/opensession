import { expect, test } from "bun:test";
import {
  SessionVoiceReplies,
  SessionVoiceAgentReply,
  sessionVoiceRequests,
} from "./session-voice-replies";
import type { TranscriptEntry } from "./types";

function reply(id: string, content = "Done", seq = 1): TranscriptEntry {
  return {
    id,
    content,
    seq,
    type: "assistant",
    timestamp: new Date(seq * 1000).toISOString(),
  };
}

test("does not narrate existing history, reasoning, or busy partial replies", () => {
  const old = reply("old");
  const tracker = new SessionVoiceReplies([old]);
  expect(tracker.take([old], false)).toBeNull();
  const next = reply("next", "Partial", 3);
  expect(tracker.take([old, next], true)).toBeNull();
  expect(tracker.take([old, { ...next, content: "Finished" }], false)).toBe(
    "Finished",
  );
  expect(
    tracker.take([old, { ...next, content: "Finished" }], false),
  ).toBeNull();
  expect(
    tracker.take(
      [old, next, { ...reply("thinking", "Private", 4), isReasoning: true }],
      true,
    ),
  ).toBeNull();
});

test("history hydration and replay never read older replies aloud", () => {
  const tracker = new SessionVoiceReplies([reply("newest", "Latest", 10)]);
  expect(tracker.take([reply("older", "Old", 2)], false)).toBeNull();
  expect(tracker.take([reply("newest", "Latest", 10)], false)).toBeNull();
  expect(tracker.take([reply("new", "Fresh", 11)], false)).toBe("Fresh");
  expect(tracker.take([reply("newest", "Latest", 10)], false)).toBeNull();
});

test("a call started mid-turn speaks the completed version of that reply", () => {
  const partial = reply("partial", "Working", 5);
  const tracker = new SessionVoiceReplies([partial]);
  expect(tracker.take([{ ...partial, content: "Finished" }], true)).toBeNull();
  expect(tracker.take([{ ...partial, content: "Finished" }], false)).toBe(
    "Finished",
  );
});

test("an empty initial view does not narrate history fetched after the call starts", () => {
  const tracker = new SessionVoiceReplies([], 100_000);
  expect(tracker.take([reply("history", "Old", 50)], false)).toBeNull();
  expect(tracker.take([reply("new", "New", 101)], false)).toBe("New");
});

test("rewrites of an already spoken reply are not narrated twice", () => {
  const tracker = new SessionVoiceReplies([reply("old")]);
  expect(tracker.take([reply("new", "Done", 2)], false)).toBe("Done");
  expect(
    tracker.take([reply("new", "Done with linked references", 2)], false),
  ).toBeNull();
});

test("a requested task waits for its own queued turn, not the previous run", () => {
  const old = reply("old");
  const tracker = new SessionVoiceAgentReply("Check CI", [old]);
  const earlier = reply("earlier-run", "Previous job completed", 2);
  expect(tracker.take([old, earlier], false)).toBeNull();
  const question = {
    ...reply("question", "Check CI", 3),
    type: "user" as const,
  };
  const answer = reply("answer", "CI passes", 4);
  expect(tracker.take([old, earlier, question, answer], true)).toBeNull();
  expect(tracker.take([old, earlier, question, answer], false)).toBe(
    "CI passes",
  );
  expect(tracker.take([old, earlier, question, answer], false)).toBeNull();
});

test("an old identical prompt cannot satisfy a newly requested task", () => {
  const question = {
    ...reply("old-question", "Check CI", 1),
    type: "user" as const,
  };
  const old = reply("old-answer", "Old CI result", 2);
  const tracker = new SessionVoiceAgentReply("Check CI", [question, old]);
  expect(tracker.take([question, old], false)).toBeNull();
});

test("a batched later answer cannot replace the requested turn's answer", () => {
  const tracker = new SessionVoiceAgentReply("First", []);
  const entries = [
    { ...reply("q1", "First", 1), type: "user" as const },
    reply("a1", "First answer", 2),
    { ...reply("q2", "Second", 3), type: "user" as const },
    reply("a2", "Second answer", 4),
  ];
  expect(tracker.take(entries, false)).toBe("First answer");
  expect(tracker.take(entries, false)).toBeNull();
});

test("a request with no answer never borrows a later turn's result", () => {
  const tracker = new SessionVoiceAgentReply("First", []);
  expect(
    tracker.take(
      [
        { ...reply("q1", "First", 1), type: "user" as const },
        { ...reply("q2", "Second", 2), type: "user" as const },
        reply("a2", "Second answer", 3),
      ],
      false,
    ),
  ).toBeNull();
});

test("a running request retains its delivery anchor when a bounded transcript drops the user entry", () => {
  const tracker = new SessionVoiceAgentReply("Task", []);
  tracker.messageId = "delivery";
  expect(
    tracker.take(
      [
        {
          ...reply("question", "Task", 1),
          type: "user",
          sourceMessageIds: ["delivery"],
        },
        reply("answer", "Partial", 2),
      ],
      true,
    ),
  ).toBeNull();
  expect(tracker.take([reply("answer", "Finished", 502)], true)).toBeNull();
  expect(tracker.take([reply("answer", "Finished", 502)], false)).toBe(
    "Finished",
  );
});

function steered(
  deliveryId: string,
  content: string,
  seq: number,
): TranscriptEntry {
  // A task steered into a running turn lands as a user row whose id is the
  // outbox delivery id and whose sourceMessageIds carry that same id.
  return {
    ...reply(deliveryId, content, seq),
    type: "user",
    sourceMessageIds: [deliveryId],
  };
}

test("a sibling task steered into the same run does not end the request; both share the final reply", () => {
  const requests = sessionVoiceRequests();
  requests.deliveryIds.add("delivery-1").add("delivery-2");
  const first = new SessionVoiceAgentReply("Check CI", [], requests);
  first.messageId = "delivery-1";
  const second = new SessionVoiceAgentReply("Run lint", [], requests);
  second.messageId = "delivery-2";
  const entries = [
    steered("delivery-1", "[Alice] Check CI", 1),
    reply("commentary", "Looking at CI now", 2),
    steered("delivery-2", "[Alice] Run lint", 3),
    reply("final", "CI is green and lint is clean", 4),
  ];
  expect(first.take(entries, true)).toBeNull();
  expect(first.take(entries, false)).toBe("CI is green and lint is clean");
  expect(second.take(entries, false)).toBe("CI is green and lint is clean");
  expect(first.replyId).toBe("final");
  expect(second.replyId).toBe("final");
});

test("a message from anyone else still ends the request's turn", () => {
  const requests = sessionVoiceRequests();
  requests.deliveryIds.add("delivery-1");
  const tracker = new SessionVoiceAgentReply("Check CI", [], requests);
  tracker.messageId = "delivery-1";
  expect(
    tracker.take(
      [
        steered("delivery-1", "[Alice] Check CI", 1),
        reply("answer", "CI is green", 2),
        {
          ...reply("other-turn", "[Bob] Deploy it", 3),
          type: "user",
          sourceMessageIds: ["bob-delivery"],
        },
        reply("other-answer", "Deployed", 4),
      ],
      false,
    ),
  ).toBe("CI is green");
});

test("a sibling entry that gains its delivery id later reopens the turn", () => {
  const requests = sessionVoiceRequests();
  requests.deliveryIds.add("delivery-1").add("delivery-2");
  const tracker = new SessionVoiceAgentReply("Check CI", [], requests);
  tracker.messageId = "delivery-1";
  const anchor = steered("delivery-1", "[Alice] Check CI", 1);
  const commentary = reply("commentary", "Looking", 2);
  const bare = {
    ...reply("delivery-2", "[Alice] Run lint", 3),
    type: "user" as const,
  };
  expect(tracker.take([anchor, commentary, bare], true)).toBeNull();
  const hydrated = [
    anchor,
    commentary,
    steered("delivery-2", "[Alice] Run lint", 3),
    reply("final", "Both done", 4),
  ];
  expect(tracker.take(hydrated, false)).toBe("Both done");
});

test("without delivery ids a sibling claimed by content is recognized once anchored", () => {
  const requests = sessionVoiceRequests();
  const first = new SessionVoiceAgentReply("Check CI", [], requests);
  const second = new SessionVoiceAgentReply("Run lint", [], requests);
  const entries = [
    { ...reply("q1", "Check CI", 1), type: "user" as const },
    { ...reply("q2", "Run lint", 2), type: "user" as const },
    reply("final", "Both done", 3),
  ];
  expect(first.anchor(entries)).toBe(true);
  expect(second.anchor(entries)).toBe(true);
  expect(first.take(entries, false)).toBe("Both done");
  expect(second.take(entries, false)).toBe("Both done");
});
