/** Reveal a file inside CommentableDiff's grouped/collapsible DOM. */
export function revealDiffFile(
  root: HTMLElement | null,
  path: string,
  attempt = 0,
): void {
  if (!root) return;
  const file = root.querySelector<HTMLElement>(
    `[data-diff-file="${CSS.escape(path)}"]`,
  );
  if (!file) {
    const group = [
      ...root.querySelectorAll<HTMLElement>("[data-diff-group-files]"),
    ].find((header) => {
      try {
        return JSON.parse(header.dataset.diffGroupFiles || "[]").includes(path);
      } catch {
        return false;
      }
    });
    if (attempt < 2 && group) {
      if (group.getAttribute("aria-expanded") === "false") group.click();
      requestAnimationFrame(() => revealDiffFile(root, path, attempt + 1));
    }
    return;
  }
  file.scrollIntoView({ behavior: "smooth", block: "start" });
  const header = file.querySelector<HTMLElement>(".diff-file-header");
  if (header?.getAttribute("aria-expanded") === "false") header.click();
  header?.focus({ preventScroll: true });
}

/**
 * Reveal a file once the diff that holds it has mounted: the Changes pane
 * may still be opening (a side panel sliding in, a phone page appearing,
 * the diff itself still loading) when the request is made. Polls a frame at
 * a time for a few seconds, then gives up quietly; `root` is read each time
 * because the pane's element may not exist yet either.
 */
export function revealDiffFileWhenMounted(
  root: () => HTMLElement | null,
  path: string,
  attempt = 0,
): void {
  const el = root();
  const mounted = el?.querySelector(`[data-diff-file="${CSS.escape(path)}"]`);
  if (mounted) {
    revealDiffFile(el, path);
    return;
  }
  if (attempt >= 300) return;
  requestAnimationFrame(() =>
    revealDiffFileWhenMounted(root, path, attempt + 1),
  );
}
