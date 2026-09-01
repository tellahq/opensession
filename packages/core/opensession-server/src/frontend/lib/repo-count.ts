/**
 * How many projects this instance has registered, remembered across loads.
 *
 * The sidebar's default grouping depends on it (lib/sidebar-filter): one
 * project has nothing to group by, so it reads as a plain inbox, while
 * several get that inbox nested under each project. That default has to
 * resolve during the first render, long before `/api/repos` answers, so the
 * count is cached here as the repo list arrives and read back synchronously
 * at boot.
 */

const KEY = "opensession-repo-count";
const CHANGE_EVENT = "opensession-repo-count-changed";

let cached: number | null | undefined;

/** The count as of the last load, or null the very first time. */
export function repoCount(): number | null {
  if (cached === undefined) {
    try {
      const raw = localStorage.getItem(KEY);
      const n = raw === null ? Number.NaN : Number.parseInt(raw, 10);
      cached = Number.isFinite(n) ? n : null;
    } catch {
      cached = null;
    }
  }
  return cached;
}

/** Record the size of the registered set (called as the repo list lands). */
export function rememberRepoCount(count: number): void {
  if (cached === count) return;
  cached = count;
  try {
    localStorage.setItem(KEY, String(count));
  } catch {
    // A browser with storage blocked still gets the in-memory count.
  }
  // Server rendering and tests have no browser event target.
  if (
    typeof window !== "undefined" &&
    typeof window.dispatchEvent === "function"
  )
    window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function onRepoCountChanged(handler: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, handler);
  return () => window.removeEventListener(CHANGE_EVENT, handler);
}
