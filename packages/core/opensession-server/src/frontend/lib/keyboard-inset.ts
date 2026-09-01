// How much of the fixed viewport the on-screen keyboard covers, published as
// `--kb-inset` for any surface anchored to the bottom of the window.
//
// `position: fixed` is laid out against the layout viewport, and iOS does not
// shrink that one for the keyboard. A sheet anchored to the bottom of the
// window therefore keeps its place behind the keys: what you see is the top of
// the sheet, the composer under it is off screen, and the page reads as
// pannable because dragging the visible strip is the only way to reach it.
//
// visualViewport reports the visible strip's bottom including WebKit's focus
// pan (`height + offsetTop`), so it is authoritative when available.
// window.innerHeight is the fallback for clients without that API. When neither
// moves, the var stays 0px, which is the layout every other client already had.

import { isTouchPrimary } from "./platform";

/** Re-measures across the keyboard's own animation, which reports no resize of
 *  its own on some clients. */
const SETTLE_MS = [60, 180, 350, 600];

let clients = 0;
let probe: HTMLDivElement | null = null;
let detach: (() => void) | null = null;
let timers: ReturnType<typeof setTimeout>[] = [];

function write(inset: number) {
  document.documentElement.style.setProperty("--kb-inset", `${inset}px`);
}

function measure() {
  if (!probe) return;
  // The probe is the fixed viewport itself, so this holds whether the client
  // letterboxes the standalone window, shrinks it, or does neither.
  const frame = probe.clientHeight;
  if (!frame) return;
  const viewport = window.visualViewport;
  // visualViewport wins whenever it exists: it is the only reading that
  // accounts for WebKit's focus pan (`offsetTop`). window.innerHeight reports
  // the shrunk height WITHOUT the pan, so taking the smaller of the two
  // counted the pan a second time and lifted a bottom-anchored surface above
  // the keyboard, leaving a gap the page could then be scrolled inside.
  const visible = viewport
    ? viewport.height + viewport.offsetTop
    : window.innerHeight || frame;
  // A reading that claims most of the window is covered is a bad reading, not
  // a keyboard.
  write(Math.round(Math.min(Math.max(frame - visible, 0), frame * 0.8)));
}

/** Publish `--kb-inset` for as long as the caller needs it. Returns the
 *  matching release; the measurement is shared and torn down with the last
 *  caller. No-op with a hardware keyboard. */
export function trackKeyboardInset(): () => void {
  if (!isTouchPrimary) return () => {};
  if (!probe) {
    const el = document.createElement("div");
    el.setAttribute("aria-hidden", "true");
    el.style.cssText =
      "position:fixed;inset:0;visibility:hidden;pointer-events:none;";
    document.body.appendChild(el);
    probe = el;
    const viewport = window.visualViewport;
    window.addEventListener("resize", measure);
    viewport?.addEventListener("resize", measure);
    viewport?.addEventListener("scroll", measure);
    detach = () => {
      window.removeEventListener("resize", measure);
      viewport?.removeEventListener("resize", measure);
      viewport?.removeEventListener("scroll", measure);
    };
  }
  clients++;
  measure();
  timers.push(...SETTLE_MS.map((delay) => setTimeout(measure, delay)));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--clients > 0) return;
    for (const timer of timers) clearTimeout(timer);
    timers = [];
    detach?.();
    detach = null;
    probe?.remove();
    probe = null;
    write(0);
  };
}
