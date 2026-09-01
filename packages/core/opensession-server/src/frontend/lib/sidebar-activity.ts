import type { MineStatus } from "./sidebar-types";

export type ActivityBand =
  | "inprogress"
  | "needsaction"
  | "drafts"
  | "recent"
  | "yesterday"
  | "earlier";

export interface ActivityRow {
  lastActivity: string;
  mention?: string;
  running: boolean;
  status: MineStatus;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Activity keeps live work separate from idle work in the date-based bands. */
export function activityBandFor(
  row: ActivityRow,
  todayStartMs: number,
  draft: boolean,
): ActivityBand {
  // Preserve the existing attention priority when a row is both live and blocked.
  if (draft) return "drafts";
  if (row.status === "needsinput" || row.mention) return "needsaction";
  if (row.running) return "inprogress";

  const time = Date.parse(row.lastActivity || "");
  if (time >= todayStartMs) return "recent";
  if (time >= todayStartMs - DAY_MS) return "yesterday";
  return "earlier";
}
