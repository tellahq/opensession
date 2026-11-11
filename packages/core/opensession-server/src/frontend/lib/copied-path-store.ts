/**
 * Which file path a diff's "Copy path" button just copied, for the check it
 * shows for a beat. One store per CommentableDiff, read by each file header's
 * copy button through useSyncExternalStore, so the flash re-renders the one
 * or two buttons whose state flips instead of every file row in the diff.
 * Copying another path moves the check there at once, like a single shared
 * state would.
 */
export interface CopiedPathStore {
  subscribe(listener: () => void): () => void;
  get(): string | null;
  /** Mark `path` as copied until `ms` pass or another path is copied. */
  show(path: string): void;
  /** Cancel a pending reset (on unmount). */
  dispose(): void;
}

export function createCopiedPathStore(ms = 1400): CopiedPathStore {
  let copied: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const set = (next: string | null) => {
    copied = next;
    for (const listener of listeners) listener();
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get: () => copied,
    show(path) {
      set(path);
      clearTimeout(timer);
      timer = setTimeout(() => set(null), ms);
    },
    dispose() {
      clearTimeout(timer);
    },
  };
}
