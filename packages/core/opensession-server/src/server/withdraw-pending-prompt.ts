import { appendTranscriptEvents, transcript } from "./actor-transcript";
import { retractAgentSteer } from "./agent-runner";
import {
  deleteQueuedPrompt,
  promptQueues,
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
  const pending = withdrawablePendingPrompt(session.id, entryId);
  if (!pending) return false;
  if (
    pending.slot === "steered" &&
    !(await retractAgentSteer(
      [session.claudeSessionId, session.codexThreadId, session.id],
      pending.item.id,
    ))
  )
    return false;
  if (!(await deleteQueuedPrompt(session.id, pending.item.id))) return false;
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
  return true;
}
