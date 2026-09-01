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
