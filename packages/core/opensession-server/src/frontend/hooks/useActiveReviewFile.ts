import { useEffect, useRef, useState } from "react";

/** Track the file at the reading edge, including after lazy diff mounts and collapses. */
export function useActiveReviewFile(scroller: HTMLElement | null) {
  const [active, setActive] = useState<string | null>(null);
  const picked = useRef<{ path: string; scrollTop: number } | null>(null);
  const selectFile = (path: string) => {
    if (scroller) picked.current = { path, scrollTop: scroller.scrollTop };
    setActive(path);
  };
  useEffect(() => {
    if (!scroller) return;
    let frame = 0;
    let files: HTMLElement[] = [];
    picked.current = null;
    const focusFile = (event: FocusEvent) => {
      if (!(event.target instanceof HTMLElement)) return;
      const file = event.target.closest<HTMLElement>("[data-diff-file]");
      if (!file?.dataset.diffFile) return;
      picked.current = {
        path: file.dataset.diffFile,
        scrollTop: scroller.scrollTop,
      };
      setActive(picked.current.path);
    };
    const update = () => {
      frame = 0;
      // A short last file cannot always reach the top. Keep an explicit jump
      // selected until the reader scrolls again rather than bouncing to its predecessor.
      const selection = picked.current;
      if (
        selection &&
        selection.scrollTop === scroller.scrollTop &&
        files.some((file) => file.dataset.diffFile === selection.path)
      )
        return;
      picked.current = null;
      const top = scroller.getBoundingClientRect().top + 4;
      const current = files.find(
        (file) => file.getBoundingClientRect().bottom > top,
      );
      setActive(current?.dataset.diffFile ?? null);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const resize = new ResizeObserver(schedule);
    const refresh = () => {
      files = [...scroller.querySelectorAll<HTMLElement>("[data-diff-file]")];
      resize.disconnect();
      // The content's height changes when highlighted diffs or images finish loading.
      if (scroller.firstElementChild)
        resize.observe(scroller.firstElementChild);
      schedule();
    };
    const mutations = new MutationObserver(refresh);
    mutations.observe(scroller, { childList: true, subtree: true });
    scroller.addEventListener("scroll", schedule, { passive: true });
    scroller.addEventListener("focusin", focusFile);
    window.addEventListener("resize", schedule);
    refresh();
    return () => {
      mutations.disconnect();
      resize.disconnect();
      scroller.removeEventListener("scroll", schedule);
      scroller.removeEventListener("focusin", focusFile);
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [scroller]);
  return { activeFile: active, selectFile };
}
