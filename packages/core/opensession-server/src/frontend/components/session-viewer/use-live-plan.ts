import { canonicalToolName } from "../ToolCallBlock";
import {
  parsePlanItems,
  type PlanItem,
} from "@tellahq/opensession-protocol/todo-plan";
import type { TranscriptEntry } from "../../lib/types";

const NO_PLAN: PlanItem[] = [];

// A two-item "plan" is ceremony, not a plan — below this the flap stays shut
// and the checklist lives in the transcript like any other tool call.
const MIN_PLAN_ITEMS = 3;

/**
 * The model's own plan for the turn that's running right now: the newest
 * todowrite/update_plan checklist written since the last user message.
 *
 * Both bounds matter. Stopping at the last user entry keeps a finished turn's
 * plan from being adopted by the next one (a steer mid-turn also stops the
 * scan — the plan reappears the moment the model writes the next one). Gating
 * on `running` means a half-checked list can never outlive its turn above the
 * composer, where it would read as work still in flight.
 */
function livePlan(entries: TranscriptEntry[], running: boolean): PlanItem[] {
  if (!running) return NO_PLAN;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "user") break;
    if (e.type !== "tool_use") continue;
    if (canonicalToolName(e.toolName) !== "TodoWrite") continue;
    // todoread canonicalizes to the same name and carries no list —
    // parsing to nothing means "keep looking", not "no plan".
    const items = parsePlanItems(e.toolInput);
    if (items.length === 0) continue;
    return items.length >= MIN_PLAN_ITEMS ? items : NO_PLAN;
  }
  return NO_PLAN;
}

export function useLivePlan(
  entries: TranscriptEntry[],
  running: boolean,
): PlanItem[] {
  return livePlan(entries, running);
}
