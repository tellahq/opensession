import {
  currentAgentRunToken,
  interruptAndSteerAgentRunToken,
  steerAgentRunToken,
} from "./agent-runner";
import {
  acceptQueuedSteer,
  broadcastQueue,
  prepareQueuedSteer,
  rejectQueuedSteer,
  type QueueItem,
} from "./queue-state";
import type { ImageInput } from "./run-events";
import {
  storeAppendUserLineEarly,
  transcriptLineUser,
} from "./transcript-persistence";
import { sessionKernel } from "./session-kernel";

type QueuedSteerFence = {
  token: string;
  runId: string;
  generation: number;
};

export type QueuedSteerDeps = {
  target(sessionId: string): QueuedSteerFence | undefined;
  prepare(
    sessionId: string,
    itemId: string,
    target: QueuedSteerFence,
    directItem?: QueueItem,
  ): Promise<QueueItem | undefined>;
  steer(
    token: string,
    text: string,
    images: ImageInput[] | undefined,
    itemId: string,
  ): boolean;
  accept(
    sessionId: string,
    itemId: string,
    target: QueuedSteerFence,
  ): Promise<boolean>;
  reject(
    sessionId: string,
    itemId: string,
    target: QueuedSteerFence,
  ): Promise<boolean>;
  prepared?(
    sessionId: string,
    itemId: string,
    item: QueueItem,
    text: string,
    images: ImageInput[] | undefined,
  ): Promise<void>;
};

const queuedSteerDeps: QueuedSteerDeps = {
  target(sessionId) {
    const token = currentAgentRunToken(sessionId);
    const run = sessionKernel(sessionId).runStateProjection();
    if (!token || !run.currentRunId) return undefined;
    return { token, runId: run.currentRunId, generation: run.generation };
  },
  prepare: prepareQueuedSteer,
  steer: steerAgentRunToken,
  accept: acceptQueuedSteer,
  reject: rejectQueuedSteer,
  async prepared(sessionId, itemId, item, text, images) {
    const promptEntryId = item.promptEntryId || itemId;
    if (text.trim() || images?.length) {
      await storeAppendUserLineEarly(
        sessionId,
        transcriptLineUser(text, promptEntryId, undefined, images, [itemId]),
        { required: true },
      );
    }
    // The transcript row is now the user-facing receipt. Publish the delivery
    // projection before touching the runner so every client removes the old
    // queue row and can render this entry as pending delivery.
    await broadcastQueue(sessionId);
  },
};

function sameFence(
  before: QueuedSteerFence,
  after: QueuedSteerFence | undefined,
): boolean {
  return (
    !!after &&
    after.token === before.token &&
    after.runId === before.runId &&
    after.generation === before.generation
  );
}

/** Prepare durably, then steer only the immutable run captured before await. */
export async function prepareAndSteerQueuedPrompt(
  input: {
    sessionId: string;
    itemId: string;
    item?: QueueItem;
    text: string;
    images?: ImageInput[];
  },
  deps: QueuedSteerDeps = queuedSteerDeps,
): Promise<"steered" | "rejected" | "not_prepared"> {
  const before = deps.target(input.sessionId);
  if (!before) return "not_prepared";
  const directItem = input.item
    ? {
        ...input.item,
        promptEntryId: input.item.promptEntryId || input.itemId,
      }
    : undefined;
  const prepared = await deps.prepare(
    input.sessionId,
    input.itemId,
    before,
    directItem,
  );
  if (!prepared) return "not_prepared";
  try {
    await deps.prepared?.(
      input.sessionId,
      input.itemId,
      prepared,
      input.text,
      input.images,
    );
  } catch (error) {
    if (!(await deps.reject(input.sessionId, input.itemId, before)))
      throw new Error(
        "Pending steer changed while transcript admission failed",
        {
          cause: error,
        },
      );
    throw error;
  }
  if (!sameFence(before, deps.target(input.sessionId))) {
    if (!(await deps.reject(input.sessionId, input.itemId, before)))
      throw new Error("Pending steer changed before fenced rejection");
    return "rejected";
  }
  if (!deps.steer(before.token, input.text, input.images, input.itemId)) {
    if (!(await deps.reject(input.sessionId, input.itemId, before)))
      throw new Error("Pending steer changed before fenced rejection");
    return "rejected";
  }
  if (!(await deps.accept(input.sessionId, input.itemId, before)))
    throw new Error("Pending steer changed before runner acceptance");
  return "steered";
}

/** Prepare durably, then interrupt only the immutable run captured before await. */
export async function prepareAndInterruptQueuedPrompt(
  input: {
    sessionId: string;
    itemId: string;
    item?: QueueItem;
    text: string;
    images?: ImageInput[];
  },
  deps: QueuedSteerDeps = {
    ...queuedSteerDeps,
    steer: (token, text, images) =>
      interruptAndSteerAgentRunToken(token, text, images),
  },
): Promise<"interrupted" | "target_changed" | "unsupported" | "not_prepared"> {
  const before = deps.target(input.sessionId);
  if (!before) return "not_prepared";
  const directItem = input.item
    ? {
        ...input.item,
        promptEntryId: input.item.promptEntryId || input.itemId,
      }
    : undefined;
  const prepared = await deps.prepare(
    input.sessionId,
    input.itemId,
    before,
    directItem,
  );
  if (!prepared) return "not_prepared";
  try {
    await deps.prepared?.(
      input.sessionId,
      input.itemId,
      prepared,
      input.text,
      input.images,
    );
  } catch (error) {
    if (!(await deps.reject(input.sessionId, input.itemId, before)))
      throw new Error(
        "Pending interrupt steer changed while transcript admission failed",
        {
          cause: error,
        },
      );
    throw error;
  }
  if (!sameFence(before, deps.target(input.sessionId))) {
    if (!(await deps.reject(input.sessionId, input.itemId, before)))
      throw new Error(
        "Pending interrupt steer changed before fenced rejection",
      );
    return "target_changed";
  }
  if (!deps.steer(before.token, input.text, input.images, input.itemId)) {
    if (!(await deps.reject(input.sessionId, input.itemId, before)))
      throw new Error(
        "Pending interrupt steer changed before fenced rejection",
      );
    return "unsupported";
  }
  if (!(await deps.accept(input.sessionId, input.itemId, before)))
    throw new Error("Pending interrupt steer changed before runner acceptance");
  return "interrupted";
}
