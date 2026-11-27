import { repairDesktopPalettePaint } from "./palette-repaint";

export type DiffPalette = "default" | "colorblind";

const KEY = "opensession-diff-palette";
const CHANGE_EVENT = "opensession-diff-palette-changed";

export function isDiffPalette(value: unknown): value is DiffPalette {
  return value === "default" || value === "colorblind";
}

export function getDiffPalette(): DiffPalette {
  try {
    const stored = localStorage.getItem(KEY);
    return isDiffPalette(stored) ? stored : "default";
  } catch {
    return "default";
  }
}

export function applyDiffPalette(palette: DiffPalette = getDiffPalette()) {
  if (typeof document === "undefined") return;
  if (palette === "colorblind") {
    document.documentElement.dataset.diffPalette = "colorblind";
  } else {
    delete document.documentElement.dataset.diffPalette;
  }
  repairDesktopPalettePaint();
}

export function setDiffPalette(palette: DiffPalette) {
  try {
    if (palette === "colorblind") {
      localStorage.setItem(KEY, palette);
    } else {
      localStorage.removeItem(KEY);
    }
  } catch {}
  applyDiffPalette(palette);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: palette }));
  }
}

export function onDiffPaletteChanged(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) {
      applyDiffPalette();
      cb();
    }
  };
  window.addEventListener(CHANGE_EVENT, cb);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, cb);
    window.removeEventListener("storage", onStorage);
  };
}
