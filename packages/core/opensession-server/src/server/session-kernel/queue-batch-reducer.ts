/**
 * Pure queue-batch selection for the actor's atomic delivery claim. The
 * "queued messages deliver only when the agent FULLY completes" promise stays
 * unit-testable while the gateway supplies only live policy facts. The reducer
 * never mutates its input.
 */
import { AUTO_CONTINUE_USER } from "../auto-continue";
import type { QueueItem } from "../queue-state";
import { delegatedActorParent } from "../session-actors";

export type QueueBatchPlan =
  | { kind: "deliver"; batch: QueueItem[]; rest: QueueItem[] }
  | { kind: "hold"; heldCount: number };

function splitAtDelegatedMessage(queue: QueueItem[]): QueueBatchPlan | null {
  const index = queue.findIndex(
    (item) => delegatedActorParent(item.user) !== null,
  );
  if (index < 0) return null;
  const batch = index === 0 ? [queue[0]] : queue.slice(0, index);
  const selected = new Set(batch);
  return {
    kind: "deliver",
    batch,
    rest: queue.filter((item) => !selected.has(item)),
  };
}

export function selectQueueBatch(
  queue: QueueItem[],
  opts: {
    /** Interrupt targeted one specific item (queue chip ▲): deliver only it. */
    soloId?: string;
    /** The queue head was armed by aborting the running turn (Esc+Enter):
     *  the user asked for delivery NOW — the hold never applies. */
    interruptMark?: boolean;
    /** The session is still logically working past its own turn end
     *  (running child worker sessions): hold human composer sends. */
    stillWorking?: boolean;
  },
): QueueBatchPlan {
  const soloIndex = opts.soloId
    ? queue.findIndex((m) => m.id === opts.soloId)
    : -1;
  if (soloIndex >= 0) {
    return {
      kind: "deliver",
      batch: [queue[soloIndex]],
      rest: queue.filter((_, i) => i !== soloIndex),
    };
  }
  // An auto-continue at the head delivers alone: it exists to let the agent
  // FINISH its announced work while queued messages stay parked behind it —
  // batching them in would deliver them mid-task, the exact thing queueing
  // promises not to do.
  if (queue[0]?.user === AUTO_CONTINUE_USER) {
    return { kind: "deliver", batch: [queue[0]], rest: queue.slice(1) };
  }
  // A review handoff is an automation phase boundary. Anything ahead of it is
  // an earlier human request and gets its own turn first; the handoff then
  // drains alone, preserving both transcript order and the reviewed SHA's
  // meaning instead of folding feedback into unrelated work.
  const handoffAt = queue.findIndex((m) => m.reviewHandoff);
  if (handoffAt === 0)
    return { kind: "deliver", batch: [queue[0]], rest: queue.slice(1) };
  if (handoffAt > 0) {
    const beforeReview = queue.slice(0, handoffAt);
    const delegated = splitAtDelegatedMessage(beforeReview);
    if (delegated?.kind === "deliver") {
      const selected = new Set(delegated.batch);
      return {
        kind: "deliver",
        batch: delegated.batch,
        rest: queue.filter((item) => !selected.has(item)),
      };
    }
    return {
      kind: "deliver",
      batch: beforeReview,
      rest: queue.slice(handoffAt),
    };
  }
  if (opts.stillWorking && !opts.interruptMark) {
    const ready = queue.filter((m) => !m.hold);
    if (ready.length === 0) return { kind: "hold", heldCount: queue.length };
    const delegated = splitAtDelegatedMessage(ready);
    if (delegated?.kind === "deliver") {
      const selected = new Set(delegated.batch);
      return {
        kind: "deliver",
        batch: delegated.batch,
        rest: queue.filter((item) => !selected.has(item)),
      };
    }
    return { kind: "deliver", batch: ready, rest: queue.filter((m) => m.hold) };
  }
  return (
    splitAtDelegatedMessage(queue) ?? {
      kind: "deliver",
      batch: [...queue],
      rest: [],
    }
  );
}
