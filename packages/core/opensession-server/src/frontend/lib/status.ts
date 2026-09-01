import type { UnifiedSession } from "./types";

export type StatusTone =
  | "green"
  | "blue"
  | "purple"
  | "red"
  | "yellow"
  | "gray";

export interface SessionStatus {
  label: string;
  tone: StatusTone;
}

export function sessionStatus(s: UnifiedSession): SessionStatus {
  if (s.safety) return { label: "Paused for safety", tone: "yellow" };
  if (s.isRunning) return { label: "Working", tone: "green" };
  if (s.prState === "MERGED") return { label: "Merged", tone: "purple" };
  if (s.prState === "CLOSED") return { label: "Closed", tone: "red" };
  if (s.prState === "OPEN") return { label: "PR open", tone: "blue" };
  if (Date.now() - new Date(s.lastActivity).getTime() < 3_600_000) {
    return { label: "Recent", tone: "yellow" };
  }
  return { label: "Idle", tone: "gray" };
}
