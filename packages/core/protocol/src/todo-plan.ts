/**
 * The model's own plan — the checklist it writes with the `todowrite` tool
 * (codex spells the same thing `update_plan`; both canonicalize to "TodoWrite"
 * in ToolCallBlock). It is ephemeral per-turn run state and has nothing to do
 * with the Desk todo list in src/server/todos.ts, so UI copy calls this one
 * "Plan" and never "todos" — the two must not read as the same thing.
 *
 * Engines disagree on the payload's spelling, so parsing lives here and the
 * two consumers share it: the status flap above the composer (ComposerAgents)
 * and the expanded tool row in the transcript (ToolCallBlock).
 */

export type PlanItemStatus = "pending" | "in_progress" | "completed";

export interface PlanItem {
  content: string;
  status: PlanItemStatus;
}

function statusOf(value: unknown): PlanItemStatus {
  switch (value) {
    case "in_progress":
    case "active":
    case "running":
      return "in_progress";
    case "completed":
    case "done":
      return "completed";
    default:
      return "pending";
  }
}

/**
 * A todowrite/update_plan tool input → its checklist. Anything that isn't one
 * yields [] — notably `todoread`, which canonicalizes to the same tool name
 * but carries no list — so callers can read empty as "no plan here" and keep
 * scanning.
 */
export function parsePlanItems(input: unknown): PlanItem[] {
  if (!input || typeof input !== "object") return [];
  const inp = input as Record<string, unknown>;
  const list = Array.isArray(inp.todos)
    ? inp.todos
    : Array.isArray(inp.plan)
      ? inp.plan
      : null;
  if (!list) return [];
  const items: PlanItem[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const content = [item.content, item.step, item.activeForm, item.title].find(
      (v): v is string => typeof v === "string" && v.trim() !== "",
    );
    if (!content) continue;
    items.push({ content: content.trim(), status: statusOf(item.status) });
  }
  return items;
}

/** The step the run is on right now, or "" when nothing is in progress. */
export function currentPlanItem(items: readonly PlanItem[]): string {
  return items.find((i) => i.status === "in_progress")?.content ?? "";
}

export function planDoneCount(items: readonly PlanItem[]): number {
  return items.filter((i) => i.status === "completed").length;
}
