export interface PinnedDragView {
  /** Mid-drag, Motion's in-flight order of the Pinned entries. */
  draft: string[] | null;
  /** The entry floating under the pointer. */
  dragKey: string | null;
}

/** The Pinned band's in-flight drag, kept outside Sidebar state. Each swap
 *  during a drag used to re-render the whole sidebar and every row; now only
 *  the Pinned list subscribes (PinnedReorderList). */
export interface PinnedDragStore {
  get: () => PinnedDragView;
  set: (patch: Partial<PinnedDragView>) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createPinnedDragStore(): PinnedDragStore {
  let view: PinnedDragView = { draft: null, dragKey: null };
  const listeners = new Set<() => void>();
  return {
    get: () => view,
    set: (patch) => {
      const next = { ...view, ...patch };
      if (next.draft === view.draft && next.dragKey === view.dragKey) return;
      view = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
