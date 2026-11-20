/**
 * The Support queue's edits from a row's right-click menu: how each one
 * changes the row on screen, and the Plain call that makes it real.
 */
import {
  changePlainThreadLabelsApi,
  setPlainThreadAssigneeApi,
  setPlainThreadPriorityApi,
  setPlainThreadSpamApi,
  setPlainThreadStatusApi,
} from "./api";
import type { TicketChange } from "./plain-ticket";
import type { SupportThread } from "./types";

/**
 * The queue as it will look once Plain has the change. The queue is Plain's
 * Todo inbox, so anything that closes a ticket (Done, a snooze, spam) takes
 * the row out; the rest edit it in place. A label added here has no Plain id
 * yet, so it carries its kind's id until the refetch brings the real one.
 */
export function applyTicketChange(
  threads: SupportThread[],
  threadId: string,
  change: TicketChange,
): SupportThread[] {
  if (
    change.kind === "spam" ||
    (change.kind === "status" && change.status !== "todo")
  )
    return threads.filter((t) => t.id !== threadId);
  return threads.map((t) => {
    if (t.id !== threadId) return t;
    switch (change.kind) {
      case "priority":
        return { ...t, priority: change.priority };
      case "assignee":
        return {
          ...t,
          assignee: change.user ? { ...change.user, isBot: false } : null,
        };
      case "label": {
        const labels = t.labels || [];
        return {
          ...t,
          labels: change.existing
            ? labels.filter((l) => l.id !== change.existing!.id)
            : [
                ...labels,
                {
                  id: change.labelType.id,
                  typeId: change.labelType.id,
                  name: change.labelType.name,
                  icon: null,
                },
              ],
        };
      }
      default:
        return t;
    }
  });
}

export function sendTicketChange(
  threadId: string,
  change: TicketChange,
  user: string,
): Promise<void> {
  switch (change.kind) {
    case "status":
      return setPlainThreadStatusApi(threadId, change.status, {
        durationSeconds: change.durationSeconds,
        user,
      });
    case "priority":
      return setPlainThreadPriorityApi(threadId, change.priority, user);
    case "assignee":
      return setPlainThreadAssigneeApi(threadId, change.user?.id ?? null, user);
    case "label":
      return changePlainThreadLabelsApi(
        threadId,
        change.existing
          ? { removeLabelIds: [change.existing.id] }
          : { addLabelTypeIds: [change.labelType.id] },
        user,
      );
    case "spam":
      return setPlainThreadSpamApi(threadId, true, user);
  }
}
