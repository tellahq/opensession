/**
 * How many of a diff's open files may mount their FileDiff, grown a batch per
 * frame (see MOUNT_FIRST_BATCH in CommentableDiff). Kept outside React state so
 * a batch re-renders only the per-file gates that read it, not the whole list
 * of file headers.
 */
export type DiffMountBudget = {
  read: () => number;
  subscribe: (listener: () => void) => () => void;
  /** Grow a batch per frame until the budget covers `target`. Returns a cancel. */
  grow: (target: number) => () => void;
};

export function createDiffMountBudget(
  first: number,
  perFrame: number,
  requestFrame: (callback: () => void) => number = requestAnimationFrame,
  cancelFrame: (handle: number) => void = cancelAnimationFrame,
): DiffMountBudget {
  let budget = first;
  const listeners = new Set<() => void>();
  return {
    read: () => budget,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    grow(target) {
      let frame = 0;
      const step = () => {
        if (budget >= target) return;
        frame = requestFrame(() => {
          budget += perFrame;
          for (const listener of listeners) listener();
          step();
        });
      };
      step();
      return () => cancelFrame(frame);
    },
  };
}
