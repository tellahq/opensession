import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import {
  getKeptFrames,
  keptFrameLoaded,
  subscribeKeptFrames,
  type KeptFrame,
} from "../lib/kept-frames";
import { BROWSER_FRAME, BrowserLoading } from "./BrowserPane";

/**
 * Where kept Browser and Portal frames live (see lib/kept-frames.ts). Mounted
 * once as the detail pane's last child, so it survives session switches,
 * slides with the pane on a phone, and paints over the slots it covers while
 * the pane's raised chrome and every popup still paint over it.
 */
export function KeptFrameLayer() {
  const frames = useSyncExternalStore(
    subscribeKeptFrames,
    getKeptFrames,
    getKeptFrames,
  );
  const hostRef = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={hostRef}
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      {/* Keyed and never reordered: moving an iframe reloads it. */}
      {frames.map((frame) => (
        <KeptFrameBox key={frame.key} frame={frame} hostRef={hostRef} />
      ))}
    </div>
  );
}

function KeptFrameBox({
  frame,
  hostRef,
}: {
  frame: KeptFrame;
  hostRef: React.RefObject<HTMLDivElement | null>;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const { slot } = frame;

  // Follows the slot: placed before paint, then on every size change of the
  // slot or the pane (tab strip, side panel, split ratio, window). A slot with
  // no size sits under a hidden ancestor, so the frame hides with it.
  useLayoutEffect(() => {
    const box = boxRef.current;
    const host = hostRef.current;
    if (!box || !host) return;
    if (!slot) {
      box.style.display = "none";
      return;
    }
    const place = () => {
      const to = slot.getBoundingClientRect();
      if (to.width === 0 || to.height === 0) {
        box.style.display = "none";
        return;
      }
      const from = host.getBoundingClientRect();
      box.style.display = "block";
      box.style.left = `${to.left - from.left}px`;
      box.style.top = `${to.top - from.top}px`;
      box.style.width = `${to.width}px`;
      box.style.height = `${to.height}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(slot);
    observer.observe(host);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [slot, hostRef]);

  return (
    <div
      ref={boxRef}
      className="pointer-events-auto absolute hidden bg-white"
      data-kept-frame={frame.key}
    >
      {frame.loading ? <BrowserLoading name={frame.name} /> : null}
      <iframe
        key={`${frame.address}#${frame.nonce}`}
        className={BROWSER_FRAME}
        src={frame.address}
        title={frame.title}
        onLoad={() => keptFrameLoaded(frame.key)}
        allow={frame.allow}
        sandbox={frame.sandbox}
      />
    </div>
  );
}
