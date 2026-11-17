import type { MineStatus } from "./sidebar-types";

export type ActivityBand =
  | "inprogress"
  | "needsaction"
  | "drafts"
  | "recent"
  | "yesterday"
  | "earlier"
  | "merged";

export interface ActivityRow {
  lastActivity: string;
  mention?: string;
  running: boolean;
  status: MineStatus;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Activity keeps live work separate from idle work in the date-based bands.
    Idle rows whose PR landed collect in Merged instead of a date band. */
export function activityBandFor(
  row: ActivityRow,
  todayStartMs: number,
  draft: boolean,
  merged = false,
): ActivityBand {
  // Preserve the existing attention priority when a row is both live and blocked.
  if (draft) return "drafts";
  if (row.status === "needsinput" || row.mention) return "needsaction";
  if (row.running) return "inprogress";
  if (merged) return "merged";

  const time = Date.parse(row.lastActivity || "");
  if (time >= todayStartMs) return "recent";
  if (time >= todayStartMs - DAY_MS) return "yesterday";
  return "earlier";
}
