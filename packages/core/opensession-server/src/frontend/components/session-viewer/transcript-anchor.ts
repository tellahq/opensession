/** Read through the live-edge ref without making React Compiler treat
 * `.current` as a memo dependency. SessionViewer's callbacks deliberately
 * depend on the stable ref object; the value itself is read when they run. */
export function readFollowingLive(ref: { readonly current: boolean }): boolean {
  return ref.current;
}

// The element whose position the history hold keeps stable: the first
// entry-level node ([data-eid]: bubbles, tool rows, turn notes — turn-block
// roots too) at or straddling the transcript viewport's top edge, preferring
// the deepest qualifying descendant. Depth matters: anchoring a turn-block
// ROOT is useless against a history page merging into that turn — the merged
// rows land inside it above the reader while the root's own top never moves.
// Anchoring the visible row inside it compensates exactly. (A collapsed turn
// has no row nodes, so its root is the anchor — correct, since merged rows
// stay hidden inside the fold.)
export function pickScrollAnchor(el: HTMLElement): HTMLElement | null {
  const cTop = el.getBoundingClientRect().top;
  const all = el.querySelectorAll<HTMLElement>("[data-eid]");
  let anchor: HTMLElement | null = null;
  for (const n of Array.from(all)) {
    const r = n.getBoundingClientRect();
    if (r.height <= 0 || r.bottom <= cTop + 1) continue;
    if (!anchor) {
      anchor = n;
      continue;
    }
    // Doc order puts a block's interior rows right after the block root:
    // keep descending while the qualifying node is inside the current pick;
    // the first non-descendant qualifying node ends the search.
    if (anchor.contains(n)) anchor = n;
    else break;
  }
  return anchor;
}

export function holdTranscriptAnchor(
  container: HTMLElement,
  entryId: string,
  top: number,
  bottomGap: number,
  onFound: () => void,
  onStop?: () => void,
  settleMs = 2500,
): () => void {
  let raf = 0;
  let stopped = false;
  let foundAt: number | null = null;
  const startedAt = performance.now();
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    container.removeEventListener("wheel", stop);
    container.removeEventListener("touchstart", stop);
    container.removeEventListener("pointerdown", stop);
    window.removeEventListener("keydown", stop);
    onStop?.();
  };
  container.addEventListener("wheel", stop, { passive: true });
  container.addEventListener("touchstart", stop, { passive: true });
  container.addEventListener("pointerdown", stop, { passive: true });
  window.addEventListener("keydown", stop);
  const tick = () => {
    if (stopped || !container.isConnected) {
      stop();
      return;
    }
    const target = container.querySelector<HTMLElement>(
      `[data-eid="${CSS.escape(entryId)}"]`,
    );
    const now = performance.now();
    if (target) {
      if (foundAt === null) {
        foundAt = now;
        onFound();
      }
      const delta =
        target.getBoundingClientRect().top -
        container.getBoundingClientRect().top -
        top;
      if (Math.abs(delta) > 0.5) container.scrollTop += delta;
    } else {
      container.scrollTop = Math.max(
        0,
        container.scrollHeight - container.clientHeight - bottomGap,
      );
    }
    if (
      (foundAt !== null && now - foundAt >= settleMs) ||
      (foundAt === null && now - startedAt >= 6000)
    ) {
      stop();
      return;
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return stop;
}
