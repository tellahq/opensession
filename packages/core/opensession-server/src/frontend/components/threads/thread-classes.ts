import type { ThreadState } from "../../lib/session-threads";

/** The state dot every thread row and card leads with. */
export const THREAD_DOT: Record<ThreadState, string> = {
  blocked: "bg-blue",
  ready: "bg-green",
  working: "bg-yellow",
  idle: "bg-line-strong",
  shipped: "bg-purple",
};

/** The panel's group captions: a size down from the rows, like sidebar lanes.
 *  Each one folds its group. */
export const THREAD_CAPTION =
  "focus-ring flex w-full cursor-pointer items-center gap-1.5 rounded-md border-none bg-transparent px-2 pt-3 pb-1 text-left text-label font-medium text-faint hover:text-dim phone:min-h-11";
