import { clearUndoAction, registerUndoAction, type UndoHandle } from "./undo";

export const MERGE_UNDO_DELAY_MS = 5000;

export type DeferredMergePhase = "idle" | "scheduled" | "running";

export type DeferredMergeHandle = {
  key: string;
  token: number;
};

type DeferredMergeEntry = {
  token: number;
  phase: Exclude<DeferredMergePhase, "idle">;
  timer: ReturnType<typeof setTimeout> | null;
  run: () => void;
  undo: UndoHandle | null;
};

const entries = new Map<string, DeferredMergeEntry>();
const listeners = new Set<() => void>();
let nextToken = 1;

function emit() {
  for (const listener of listeners) listener();
}

export function subscribeDeferredMerges(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The PR URL is shared by the session strip, review panel and preview routes. */
export function deferredMergeKey(
  prUrl: string | null | undefined,
): string | null {
  if (!prUrl) return null;
  try {
    const url = new URL(prUrl);
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return `pr:${url.toString()}`;
  } catch {
    return `pr:${prUrl.replace(/[?#].*$/, "").replace(/\/+$/, "")}`;
  }
}

export function deferredMergePhase(key: string | null): DeferredMergePhase {
  if (!key) return "idle";
  return entries.get(key)?.phase ?? "idle";
}

/**
 * Hold one merge per PR for an undo window. State stays module-level so a
 * scheduled merge survives navigation and every mounted surface sees it.
 */
export function scheduleDeferredMerge(
  key: string,
  run: () => void,
  delayMs = MERGE_UNDO_DELAY_MS,
): DeferredMergeHandle | null {
  if (entries.has(key)) return null;

  const token = nextToken++;
  const entry: DeferredMergeEntry = {
    token,
    phase: "scheduled",
    timer: null,
    run,
    undo: null,
  };
  entry.timer = setTimeout(() => {
    if (entries.get(key) !== entry) return;
    clearUndoAction(entry.undo);
    entry.undo = null;
    entry.phase = "running";
    emit();
    void Promise.resolve()
      .then(entry.run)
      .catch(() => undefined)
      .finally(() => {
        if (entries.get(key) !== entry) return;
        entries.delete(key);
        emit();
      });
  }, delayMs);
  entries.set(key, entry);
  entry.undo = registerUndoAction(`deferred-merge:${key}`, () => {
    cancelScheduledMerge(key, token);
  });
  emit();
  return { key, token };
}

function cancelScheduledMerge(key: string, token?: number): boolean {
  const entry = entries.get(key);
  if (
    !entry ||
    (token !== undefined && entry.token !== token) ||
    entry.phase !== "scheduled"
  )
    return false;
  if (entry.timer) clearTimeout(entry.timer);
  clearUndoAction(entry.undo);
  entry.undo = null;
  entries.delete(key);
  emit();
  return true;
}

/** Undo only the exact schedule represented by this handle. */
export function cancelDeferredMerge(handle: DeferredMergeHandle): boolean {
  return cancelScheduledMerge(handle.key, handle.token);
}

/** Undo the current schedule from any merge control showing that PR. */
export function cancelDeferredMergeByKey(key: string): boolean {
  return cancelScheduledMerge(key);
}
