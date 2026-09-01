import { describe, expect, test } from "bun:test";
import { AUTO_CONTINUE_USER } from "../auto-continue";
import { selectQueueBatch } from "./queue-batch-reducer";
import type { QueueItem } from "../queue-state";
import { agentActor, workerActor } from "../session-actors";

const SOURCE = "os-019fe194-5fbe-7000-a81e-d0a656ad77f4";
const human = (id: string): QueueItem => ({
  id,
  content: id,
  user: "Jaap",
  hold: true,
});
const report = (id: string): QueueItem => ({
  id,
  content: id,
  user: workerActor(SOURCE),
});
const agentMessage = (id: string): QueueItem => ({
  id,
  content: id,
  user: agentActor(SOURCE),
});

describe("selectQueueBatch", () => {
  test("idle: whole queue delivers combined", () => {
    const q = [human("a"), human("b")];
    expect(selectQueueBatch(q, {})).toEqual({
      kind: "deliver",
      batch: q,
      rest: [],
    });
  });

  test("solo interrupt delivers only the targeted item, bypassing the hold", () => {
    const plan = selectQueueBatch([human("a"), human("b"), human("c")], {
      soloId: "b",
      stillWorking: true,
    });
    if (plan.kind !== "deliver") throw new Error("expected deliver");
    expect(plan.batch.map((m) => m.id)).toEqual(["b"]);
    expect(plan.rest.map((m) => m.id)).toEqual(["a", "c"]);
  });

  test("stale solo marker falls back to normal selection", () => {
    const q = [human("a")];
    expect(selectQueueBatch(q, { soloId: "gone" })).toEqual({
      kind: "deliver",
      batch: q,
      rest: [],
    });
  });

  test("head auto-continue delivers alone even while working", () => {
    const ac: QueueItem = { id: "ac", content: "go", user: AUTO_CONTINUE_USER };
    const plan = selectQueueBatch([ac, human("a")], { stillWorking: true });
    if (plan.kind !== "deliver") throw new Error("expected deliver");
    expect(plan.batch.map((m) => m.id)).toEqual(["ac"]);
    expect(plan.rest.map((m) => m.id)).toEqual(["a"]);
  });

  test("keeps review feedback behind earlier user work and drains it alone", () => {
    const review: QueueItem = {
      id: "review",
      content: "findings",
      user: "GitHub",
      reviewHandoff: true,
    };
    const first = selectQueueBatch([human("a"), review, human("b")], {});
    if (first.kind !== "deliver") throw new Error("expected deliver");
    expect(first.batch.map((m) => m.id)).toEqual(["a"]);
    const second = selectQueueBatch(first.rest, {});
    if (second.kind !== "deliver") throw new Error("expected deliver");
    expect(second.batch.map((m) => m.id)).toEqual(["review"]);
    expect(second.rest.map((m) => m.id)).toEqual(["b"]);
  });

  test("still working: all-human queue holds", () => {
    expect(
      selectQueueBatch([human("a"), human("b")], { stillWorking: true }),
    ).toEqual({ kind: "hold", heldCount: 2 });
  });

  test("still working: orchestration traffic flows, human sends stay parked", () => {
    const plan = selectQueueBatch([human("a"), report("r1"), human("b")], {
      stillWorking: true,
    });
    if (plan.kind !== "deliver") throw new Error("expected deliver");
    expect(plan.batch.map((m) => m.id)).toEqual(["r1"]);
    expect(plan.rest.map((m) => m.id)).toEqual(["a", "b"]);
  });

  test("delegated messages drain alone instead of merging with human prompts", () => {
    const first = selectQueueBatch(
      [human("a"), agentMessage("agent"), human("b")],
      {},
    );
    if (first.kind !== "deliver") throw new Error("expected deliver");
    expect(first.batch.map((m) => m.id)).toEqual(["a"]);

    const second = selectQueueBatch(first.rest, {});
    if (second.kind !== "deliver") throw new Error("expected deliver");
    expect(second.batch.map((m) => m.id)).toEqual(["agent"]);
    expect(second.rest.map((m) => m.id)).toEqual(["b"]);
  });

  test("multiple delegated messages each get their own turn while work continues", () => {
    const first = selectQueueBatch(
      [human("a"), report("r1"), agentMessage("agent"), report("r2")],
      { stillWorking: true },
    );
    if (first.kind !== "deliver") throw new Error("expected deliver");
    expect(first.batch.map((m) => m.id)).toEqual(["r1"]);
    expect(first.rest.map((m) => m.id)).toEqual(["a", "agent", "r2"]);
  });

  test("explicit interrupt mark bypasses the hold without merging delegated traffic", () => {
    const q = [human("a"), agentMessage("agent"), human("b")];
    expect(
      selectQueueBatch(q, { stillWorking: true, interruptMark: true }),
    ).toEqual({
      kind: "deliver",
      batch: [q[0]],
      rest: [q[1], q[2]],
    });
  });
});
