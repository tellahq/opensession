import { useEffect, useState } from "react";

import {
  formatViewportReadout,
  getViewportReadoutPref,
  onViewportReadoutChanged,
  sampleViewport,
} from "../lib/viewport-readout";

/** The Debug > Viewport readout corner box. Renders nothing until the
 * preference is on. */
export function ViewportReadout() {
  const [enabled, setEnabled] = useState(getViewportReadoutPref);
  useEffect(
    () => onViewportReadoutChanged(() => setEnabled(getViewportReadoutPref())),
    [],
  );
  if (!enabled) return null;
  return <ViewportReadoutPanel />;
}

function ViewportReadoutPanel() {
  const [lines, setLines] = useState(() =>
    formatViewportReadout(sampleViewport()),
  );
  useEffect(() => {
    let frame = 0;
    const refresh = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setLines(formatViewportReadout(sampleViewport()));
      });
    };
    const viewport = window.visualViewport;
    const targets: Array<[EventTarget, string, boolean]> = [
      [window, "scroll", false],
      [window, "resize", false],
      [document, "scroll", true],
      [document, "focusin", false],
      [document, "focusout", false],
      [document, "visibilitychange", false],
    ];
    for (const [target, name, capture] of targets)
      target.addEventListener(name, refresh, { capture, passive: true });
    viewport?.addEventListener("scroll", refresh);
    viewport?.addEventListener("resize", refresh);
    // The bootstrap's release record changes without any event of its own.
    const interval = setInterval(refresh, 500);
    return () => {
      cancelAnimationFrame(frame);
      clearInterval(interval);
      for (const [target, name, capture] of targets)
        target.removeEventListener(name, refresh, { capture });
      viewport?.removeEventListener("scroll", refresh);
      viewport?.removeEventListener("resize", refresh);
    };
  }, []);
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed top-[45%] left-2 z-debug max-w-[calc(100vw-16px)] rounded-md bg-popup px-2 py-1.5 font-mono text-meta leading-4 text-fg smooth-shadow-md"
    >
      {lines.map((line) => (
        <div key={line.slice(0, 4)} className="wrap-anywhere">
          {line}
        </div>
      ))}
    </div>
  );
}
