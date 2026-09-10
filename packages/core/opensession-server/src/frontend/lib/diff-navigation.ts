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
 * the diff itself still loading, another repo's diff still showing) when
 * the request is made. The pane mounts one repo's diff at a time under
 * `[data-diff-repo]`, so the file is looked for inside its own repo's
 * element only; while another repo is showing, the file's repo tab is
 * pressed, the way a folded group is opened above. Polls a frame at a time
 * for a few seconds, then gives up quietly; `root` is read each time
 * because the pane's element may not exist yet either.
 */
export function revealDiffFileWhenMounted(
  root: () => HTMLElement | null,
  file: { repo: string; path: string },
  attempt = 0,
): void {
  const el = root();
  const repo = CSS.escape(file.repo);
  const diff = el?.querySelector<HTMLElement>(`[data-diff-repo="${repo}"]`);
  const mounted = diff?.querySelector(
    `[data-diff-file="${CSS.escape(file.path)}"]`,
  );
  if (diff && mounted) {
    revealDiffFile(diff, file.path);
    return;
  }
  if (!diff)
    el?.querySelector<HTMLElement>(`[data-diff-repo-tab="${repo}"]`)?.click();
  if (attempt >= 300) return;
  requestAnimationFrame(() =>
    revealDiffFileWhenMounted(root, file, attempt + 1),
  );
}
