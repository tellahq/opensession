import { describe, expect, test } from "bun:test";
import {
  automationIntentAlreadySettled,
  supersededPlainThreadIntents,
} from "./automation-intent-recovery";

const ticket = (
  sessionId: string,
  threadId: string,
  acceptedAt: string,
  automationId = "auto-triage",
) => ({
  automationId,
  sessionId,
  trigger: "event",
  eventContext: JSON.stringify({ threadId, title: "t" }),
  acceptedAt,
  coalescePlainThread: true,
});

describe("superseded Plain thread intents", () => {
  test("keeps the earliest intent per thread and supersedes the rest", () => {
    const superseded = supersededPlainThreadIntents(
      [
        ticket("s3", "th_a", "2026-09-09T21:05:00Z"),
        ticket("s1", "th_a", "2026-09-09T20:42:00Z"),
        ticket("s2", "th_a", "2026-09-09T21:01:00Z"),
        ticket("s4", "th_b", "2026-09-09T19:07:00Z"),
      ],
      new Map(),
    );
    expect([...superseded.keys()].sort()).toEqual(["s2", "s3"]);
    expect(superseded.get("s2")).toContain("s1");
  });

  test("a thread with a live session supersedes every intent for it", () => {
    const superseded = supersededPlainThreadIntents(
      [
        ticket("s1", "th_a", "2026-09-09T20:42:00Z"),
        ticket("s2", "th_a", "2026-09-09T21:01:00Z"),
        ticket("s3", "th_b", "2026-09-09T21:02:00Z"),
      ],
      new Map([["th_a", "os-live"]]),
    );
    expect([...superseded.keys()].sort()).toEqual(["s1", "s2"]);
    expect(superseded.get("s1")).toContain("os-live");
  });

  test("an interrupted run keeps its own intent; its siblings are superseded", () => {
    const superseded = supersededPlainThreadIntents(
      [
        ticket("s1", "th_a", "2026-09-09T20:42:00Z"),
        ticket("s2", "th_a", "2026-09-09T21:01:00Z"),
        ticket("s3", "th_a", "2026-09-09T21:05:00Z"),
      ],
      new Map([["th_a", "s2"]]),
    );
    expect([...superseded.keys()].sort()).toEqual(["s1", "s3"]);
    expect(superseded.get("s1")).toContain("s2");
  });

  test("an explicit retrigger replays even when its thread has a live session", () => {
    const retrigger = {
      ...ticket("r1", "th_a", "2026-09-09T21:03:00Z"),
      coalescePlainThread: undefined,
    };
    const superseded = supersededPlainThreadIntents(
      [
        ticket("s1", "th_a", "2026-09-09T20:42:00Z"),
        retrigger,
        ticket("s2", "th_a", "2026-09-09T21:05:00Z"),
      ],
      new Map([["th_a", "os-live"]]),
    );
    expect([...superseded.keys()].sort()).toEqual(["s1", "s2"]);
  });

  test("different automations for the same thread each keep one intent", () => {
    const superseded = supersededPlainThreadIntents(
      [
        ticket("s1", "th_a", "2026-09-09T20:42:00Z", "auto-triage"),
        ticket("s2", "th_a", "2026-09-09T20:43:00Z", "auto-digest"),
      ],
      new Map(),
    );
    expect(superseded.size).toBe(0);
  });

  test("ignores intents without a Plain thread", () => {
    const superseded = supersededPlainThreadIntents(
      [
        {
          automationId: "auto-cron",
          sessionId: "c1",
          trigger: "cron",
          acceptedAt: "2026-09-09T20:00:00Z",
        },
        {
          automationId: "auto-cron",
          sessionId: "c2",
          trigger: "cron",
          acceptedAt: "2026-09-09T21:00:00Z",
        },
        {
          automationId: "auto-event",
          sessionId: "e1",
          trigger: "event",
          eventContext: "not json",
          acceptedAt: "2026-09-09T21:00:00Z",
        },
        {
          automationId: "auto-event",
          sessionId: "e2",
          trigger: "event",
          eventContext: JSON.stringify({ prNumber: 7 }),
          acceptedAt: "2026-09-09T21:00:00Z",
        },
      ],
      new Map([["th_a", "os-live"]]),
    );
    expect(superseded.size).toBe(0);
  });
});

describe("automation intent recovery", () => {
  test("recognizes a completed durable run", () => {
    expect(
      automationIntentAlreadySettled("session-1", [
        { sessionId: "session-1", status: "error" },
      ]),
    ).toBe(true);
  });

  test("does not settle a run that still owns execution", () => {
    expect(
      automationIntentAlreadySettled("session-1", [
        { sessionId: "session-1", status: "running" },
      ]),
    ).toBe(false);
  });

  test("does not cross session identities", () => {
    expect(
      automationIntentAlreadySettled("session-1", [
        { sessionId: "session-2", status: "ok" },
      ]),
    ).toBe(false);
  });
});
