import { appendTranscriptEvents, transcript } from "./actor-transcript";
import { retractAgentSteer } from "./agent-runner";
import {
  deleteQueuedPrompt,
  isEditableQueueItem,
  promptQueues,
  queueActorMatches,
  steeredReceipts,
  type QueueItem,
} from "./queue-state";

type SessionEngineIds = {
  id: string;
  claudeSessionId?: string | null;
  codexThreadId?: string | null;
};

/** Where a conversation row that no run has read yet is still held. Only these
 * two can be taken back: a dispatch or a prepared steer is already on its way
 * to the engine, so its row stays. */
export function withdrawablePendingPrompt(
  sessionId: string,
  entryId: string,
): { slot: "queued" | "steered"; item: QueueItem & { id: string } } | null {
  const matches = (item: QueueItem): item is QueueItem & { id: string } =>
    !!item.id && item.promptEntryId === entryId;
  const queued = (promptQueues.get(sessionId) ?? []).find(matches);
  if (queued) return { slot: "queued", item: queued };
  const steered = (steeredReceipts.get(sessionId) ?? []).find(matches);
  if (steered) return { slot: "steered", item: steered };
  return null;
}

/**
 * Delete a message that was accepted into the conversation but never picked
 * up. Its delivery item leaves the queue (a steer is first retracted from the
 * engine), then its transcript row is upserted empty, which every client
 * already treats as nothing to show. Returns false when the message is no
 * longer withdrawable, typically because a run just took it.
 */
export async function withdrawPendingPrompt(
  session: SessionEngineIds,
  entryId: string,
): Promise<boolean> {
  return !!(await takePendingPrompt(session, entryId));
}

/**
 * Withdraw a waiting message the way Delete does and hand back its full
 * payload, so the person can put it in the composer and change it. Only their
 * own ordinary composer messages qualify, like editing a queued one.
 */
export async function takePendingPromptForEdit(
  session: SessionEngineIds,
  entryId: string,
  actor?: string,
): Promise<QueueItem | undefined> {
  return takePendingPrompt(
    session,
    entryId,
    (item) => isEditableQueueItem(item) && queueActorMatches(item, actor),
  );
}

async function takePendingPrompt(
  session: SessionEngineIds,
  entryId: string,
  allowed: (item: QueueItem) => boolean = () => true,
): Promise<QueueItem | undefined> {
  const pending = withdrawablePendingPrompt(session.id, entryId);
  if (!pending || !allowed(pending.item)) return;
  if (
    pending.slot === "steered" &&
    !(await retractAgentSteer(
      [session.claudeSessionId, session.codexThreadId, session.id],
      pending.item.id,
    ))
  )
    return;
  if (!(await deleteQueuedPrompt(session.id, pending.item.id))) return;
  const entry = await transcript
    .getFullEntry(session.id, entryId)
    .catch(() => null);
  if (entry?.type === "user")
    await appendTranscriptEvents(session.id, [
      {
        id: entry.id,
        type: "user",
        content: "",
        timestamp: entry.timestamp,
      },
    ]);
  return pending.item;
}
