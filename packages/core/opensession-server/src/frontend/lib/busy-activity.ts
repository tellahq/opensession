import type { RunActivity } from "@tellahq/opensession-protocol/events";
import { toolFamily } from "@tellahq/opensession-protocol/tool-presentation";

export interface BusyActivityStatus {
  /** Words beside the dot. Only a pause the transcript above cannot explain
   * (a compaction, a retry wait) gets them; a tool, a thought or a reply
   * already shows itself above, so the row is just the dot and the time. */
  label: string | null;
  /** A quieter second fact about the same phase ("attempt 2 of 3"). */
  detail?: string;
  /** The phase in words for assistive tech, which cannot see the dot. */
  spoken: string;
  elapsed: string;
}

/** A run's live age, counted up from the first second: "0s", "59s",
 * "1m 05s", "1h 02m". Floored, so the count never runs ahead of the clock,
 * and padded past a minute, so the seconds hold their width. */
export function liveElapsed(ms: number): string {
  const secs = Math.floor(Math.max(0, ms) / 1000);
  if (!Number.isFinite(secs)) return "0s";
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${String(secs % 60).padStart(2, "0")}s`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

/** What one running tool is doing, by family rather than by tool name: the
 * tool's own row says which command or file, this only names the phase. */
function toolLabel(toolName: string | undefined, count: number): string {
  if (count > 1) return `Running ${count} tools`;
  return runningToolLabel(toolName);
}

/** One running tool in words ("Running a command"), for a folded row that
 * would otherwise name the tool and dump its input. */
export function runningToolLabel(toolName: string | undefined): string {
  switch (toolFamily(toolName || "")) {
    case "run":
      return "Running a command";
    case "file":
      return "Reading a file";
    case "edit":
      return "Editing a file";
    case "find":
      return "Searching";
    case "web":
      return "Reading the web";
    case "agent":
      return "Waiting for an agent";
    case "skill":
      return "Loading a skill";
    case "checklist":
      return "Updating the plan";
    default:
      return "Calling a tool";
  }
}

function preparingLabel(toolName: string | undefined): string {
  switch (toolFamily(toolName || "")) {
    case "run":
      return "Writing a command";
    case "edit":
      return "Writing an edit";
    default:
      return "Preparing a tool call";
  }
}

/**
 * The phase the engine reported, in words. Null for a phase this client does
 * not know (a newer server), so the caller falls back to the neutral wording.
 */
function activityLabel(
  activity: RunActivity,
  nowMs: number,
): Pick<BusyActivityStatus, "label" | "detail"> | null {
  switch (activity.kind) {
    case "waiting":
      return { label: "Waiting for the model" };
    case "thinking":
      return { label: "Thinking" };
    case "writing":
      return { label: "Writing" };
    case "preparing":
      return { label: preparingLabel(activity.toolName) };
    case "tool":
      return { label: toolLabel(activity.toolName, activity.count) };
    case "compacting":
      return { label: "Compacting the conversation" };
    case "retrying": {
      const seconds = Math.ceil((activity.retryAt - nowMs) / 1000);
      return {
        label: seconds > 0 ? `Retrying in ${seconds}s` : "Retrying",
        detail: `attempt ${activity.attempt} of ${activity.maxAttempts}`,
      };
    }
    default:
      return null;
  }
}

/** Phases the row names in words: neither is the model talking or a tool
 * row, so nothing above explains the pause. */
function pauseNeedsWords(activity: RunActivity | null | undefined): boolean {
  return activity?.kind === "compacting" || activity?.kind === "retrying";
}

/**
 * Status for a live run: the elapsed time from its first second, plus words
 * only for a compaction or a retry wait. The phase is still named for screen
 * readers; without one it only claims what the client knows, that the request
 * remains active, so the wording never invents a model or tool phase.
 */
export function busyActivityStatus(
  elapsedMs: number,
  activity?: RunActivity | null,
  nowMs: number = Date.now(),
): BusyActivityStatus {
  const elapsed = liveElapsed(elapsedMs);
  const named = activity ? activityLabel(activity, nowMs) : null;
  const spoken = named?.label ?? "Working";
  const shown = pauseNeedsWords(activity) ? named : null;
  const status: BusyActivityStatus = {
    label: shown?.label ?? null,
    spoken,
    elapsed,
  };
  if (shown?.detail) status.detail = shown.detail;
  return status;
}
