/**
 * End this process when the one that started it is gone.
 *
 * A server run by something else on a person's machine (the Mac app's "This
 * Mac", see packages/clients/mac/src/local-server.js) is meant to live exactly
 * as long as that program. The program stops it on a normal quit, but a crash,
 * a force quit or a kill never reaches that code, and the server would keep
 * running with nothing left to stop it.
 *
 * With `OPENSESSION_EXIT_WITH_PARENT=<pid>` set, the process checks once a
 * second that `<pid>` is still its parent and, when it is not, sends itself
 * SIGTERM: the same graceful shutdown a normal stop gets.
 * `OPENSESSION_EXIT_WITH_PARENT_DELAY_MS` holds that back, so a process others
 * depend on (the session kernel) can outlast them.
 *
 * Unset, which is every install that runs under a service manager, this does
 * nothing.
 */

const CHECK_EVERY_MS = 1_000;

export interface ParentWatchOptions {
  env?: Record<string, string | undefined>;
  parent?: () => number;
  end?: () => void;
  everyMs?: number;
}

const g = globalThis as typeof globalThis & {
  __parentWatch?: { stop(): void };
};

/** The watched pid and delay, or null when the variable is unset or not a
 * pid. */
export function parentWatchPlan(
  env: Record<string, string | undefined>,
): { pid: number; delayMs: number } | null {
  const pid = Number(env.OPENSESSION_EXIT_WITH_PARENT);
  if (!Number.isInteger(pid) || pid <= 1) return null;
  const delay = Number(env.OPENSESSION_EXIT_WITH_PARENT_DELAY_MS);
  return {
    pid,
    delayMs: Number.isFinite(delay) && delay > 0 ? Math.min(delay, 60_000) : 0,
  };
}

/** Boot entry point: one watch per process. Returns its stop, or null when
 * there is nothing to watch. */
export function startParentWatch({
  env = process.env,
  parent = () => process.ppid,
  end = () => process.kill(process.pid, "SIGTERM"),
  everyMs = CHECK_EVERY_MS,
}: ParentWatchOptions = {}): { stop(): void } | null {
  if (g.__parentWatch) return g.__parentWatch;
  const plan = parentWatchPlan(env);
  if (!plan) return null;
  let pending: ReturnType<typeof setTimeout> | null = null;
  const timer = setInterval(() => {
    // An orphan is handed to another parent, so the pid stops matching.
    if (parent() === plan.pid) return;
    clearInterval(timer);
    console.error(
      `[parent-watch] parent ${plan.pid} is gone; shutting down${plan.delayMs ? ` in ${plan.delayMs} ms` : ""}`,
    );
    pending = setTimeout(end, plan.delayMs);
  }, everyMs);
  return (g.__parentWatch = {
    stop() {
      clearInterval(timer);
      if (pending) clearTimeout(pending);
      g.__parentWatch = undefined;
    },
  });
}
