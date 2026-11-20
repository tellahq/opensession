/**
 * The choices a Plain ticket's admin controls offer, in one place: the ticket
 * bar's dropdowns (PlainThreadActions) and the queue's right-click menu
 * (SupportTicketContextMenu) list the same options in the same order.
 */
import { SUPPORT_PRIORITY_GROUPS } from "./sidebar-filter";

/** Plain thread priorities, as Plain's own UI names them. */
export const PRIORITY_LABELS = new Map<number, string>(
  SUPPORT_PRIORITY_GROUPS.map((g) => [g.p, g.label]),
);

export function priorityLabel(priority: number | null | undefined): string {
  if (priority == null) return "Priority";
  return PRIORITY_LABELS.get(priority) ?? `P${priority}`;
}

/** The queue colour of a priority worth calling out (Urgent, High). */
export function priorityTone(
  priority: number | null | undefined,
): string | undefined {
  return priority != null && priority <= 1
    ? SUPPORT_PRIORITY_GROUPS[priority].cls
    : undefined;
}

export const SNOOZE_OPTIONS: { label: string; seconds: number }[] = [
  { label: "1 hour", seconds: 3_600 },
  { label: "4 hours", seconds: 4 * 3_600 },
  { label: "1 day", seconds: 86_400 },
  { label: "3 days", seconds: 3 * 86_400 },
  { label: "1 week", seconds: 7 * 86_400 },
];

export type PlainStatusChoice = "todo" | "done" | "snoozed";

/** A label on a ticket, in the one shape both thread payloads reduce to. */
export interface TicketLabel {
  id: string;
  typeId: string;
  name: string;
}

/** One edit to a ticket from the queue's right-click menu. The queue applies
 *  it to its row straight away and then asks Plain. */
export type TicketChange =
  | { kind: "status"; status: PlainStatusChoice; durationSeconds?: number }
  | { kind: "priority"; priority: number }
  | { kind: "assignee"; user: { id: string; name: string } | null }
  | {
      kind: "label";
      labelType: { id: string; name: string };
      /** The label to take off, or undefined to put the kind on. */
      existing?: TicketLabel;
    }
  | { kind: "spam" };
