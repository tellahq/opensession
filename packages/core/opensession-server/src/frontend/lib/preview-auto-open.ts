import { z } from "zod";

// PRs whose preview deploy already put a Browser tab in the strip on this
// device. Each PR gets the tab once: closing it is an answer, so a later poll
// or reload does not bring it back.
const KEY = "opensession-preview-auto-opened";

/** PRs remembered, most recent last. */
const LIMIT = 200;

const Stored = z.array(z.string());

function read(): string[] {
  try {
    const stored = Stored.safeParse(
      JSON.parse(localStorage.getItem(KEY) || "[]"),
    );
    return stored.success ? stored.data : [];
  } catch {
    return [];
  }
}

/**
 * True the first time `pr` (its URL) asks, false after that. Without
 * storage it still answers once per page load.
 */
const seen = new Set<string>();
export function claimPreviewAutoOpen(pr: string): boolean {
  if (seen.has(pr)) return false;
  seen.add(pr);
  const stored = read();
  if (stored.includes(pr)) return false;
  try {
    localStorage.setItem(KEY, JSON.stringify([...stored, pr].slice(-LIMIT)));
  } catch {
    /* private mode / quota: the in-memory set still holds it */
  }
  return true;
}
