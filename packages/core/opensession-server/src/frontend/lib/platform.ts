// Coarse client-platform detection, shared by every surface that renders
// keyboard-shortcut labels or picks modifier keys. Evaluated once at module
// load — the platform doesn't change under a running page.

/** Apple device (macOS or iOS/iPadOS): ⌘-family shortcuts and glyph labels. */
export const isApple = /Mac|iPhone|iPad|iPod/.test(navigator.platform);

/**
 * Touch-primary client: a phone or tablet, where the keyboard is on screen.
 * A soft keyboard has no Shift+Enter and no ⌘/Ctrl, so the return key is the
 * only way to type a second line and cannot also be the send key.
 */
export const isTouchPrimary =
  typeof window !== "undefined" &&
  !!window.matchMedia?.("(hover: none) and (pointer: coarse)").matches;

/**
 * iOS WebKit: iPhone, iPod, iPad, including iPadOS presenting itself as a
 * Mac with touch. Kept identical to TanStack Virtual's own detection because
 * the transcript virtualizer has to predict when that library will hold a
 * scrollTop write back on this platform instead of applying it.
 */
export const isIOSWebKit =
  typeof navigator !== "undefined" &&
  (/iP(hone|od|ad)/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 0));

/**
 * Chromium-engine browser (Chrome, Chromium, iOS Chrome, Edge, Opera).
 * Chromium reserves some chords (e.g. ⌘E) before the page sees them, so a few
 * surfaces advertise a different working alias there.
 */
export const isChromium = /Chrome|Chromium|CriOS|Edg|OPR/.test(
  navigator.userAgent,
);
