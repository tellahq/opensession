let repaintQueued = false;

/**
 * Rebuild the desktop shell's paint tree after changing a root palette.
 *
 * Electron's transparent vibrancy window can keep presenting the old renderer
 * surface after a data-theme or data-accent change. Layout remains correct, but
 * only a narrow strip is painted until route navigation rebuilds the tree. A
 * synchronous display reset repairs that state. Queue it until the current
 * event finishes so React can commit the picker's selected state first, and
 * coalesce theme/accent changes made in the same turn.
 */
export function repairDesktopPalettePaint() {
  if (
    typeof document === "undefined" ||
    !document.documentElement.classList?.contains("desktop-shell") ||
    repaintQueued
  )
    return;

  repaintQueued = true;
  queueMicrotask(() => {
    repaintQueued = false;
    const app = document.querySelector<HTMLElement>(".app");
    if (!app) return;

    const display = app.style.getPropertyValue("display");
    const priority = app.style.getPropertyPriority("display");
    app.style.setProperty("display", "none", "important");
    void app.offsetHeight;
    if (display) app.style.setProperty("display", display, priority);
    else app.style.removeProperty("display");
  });
}
