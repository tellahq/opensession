import type { ThreadState } from "../../lib/session-threads";

/** The state dot every thread row and card leads with. */
export const THREAD_DOT: Record<ThreadState, string> = {
  blocked: "bg-blue",
  ready: "bg-green",
  working: "bg-yellow",
  idle: "bg-line-strong",
  shipped: "bg-purple",
};

/** The panel's group captions: a size down from the rows, like sidebar lanes. */
export const THREAD_CAPTION =
  "flex items-baseline gap-1.5 px-2 pt-3 pb-1 text-label font-semibold text-faint";
