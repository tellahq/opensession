import {
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { frameAudioReport } from "../lib/frame-audio";
import {
  getKeptFrames,
  keptFrameAudible,
  keptFrameEntered,
  keptFrameInPanel,
  keptFrameLoaded,
  keptFrameNavigated,
  keptFrameReturned,
  subscribeKeptFrames,
  type KeptFrame,
} from "../lib/kept-frames";
import { addressHost } from "../lib/preview-url";
import { WS_SUMMARY_FRAME_HOST } from "../lib/workspace-summary-classes";
import { useFrameFocus } from "../hooks/useFrameFocus";
import { useFrameLocation } from "../hooks/useFrameLocation";
import { BROWSER_FRAME, BrowserLoading } from "./BrowserPane";

/**
 * Where kept Browser and Portal frames live (see lib/kept-frames.ts). Mounted
 * once as the detail pane's last child, so it survives session switches,
 * slides with the pane on a phone, and paints over the slots it covers while
 * the pane's raised chrome and every popup still paint over it.
 *
 * The side panel's frames get a second layer, `panel`, mounted after the
 * panel's column. Below 920px the panel floats at z-30, so its frames rise
 * with it; on a phone there is no panel. The layer itself takes no z-index,
 * so each frame stacks on its own: that is what lets a thumbnail rise above
 * the summary card it sits in.
 */
export function KeptFrameLayer({ panel = false }: { panel?: boolean }) {
  const frames = useSyncExternalStore(
    subscribeKeptFrames,
    getKeptFrames,
    getKeptFrames,
  );
  const hostRef = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={hostRef}
      className={
        panel
          ? "pointer-events-none absolute inset-0 overflow-hidden phone:hidden"
          : "pointer-events-none absolute inset-0 overflow-hidden"
      }
    >
      {/* Keyed and never reordered: moving an iframe reloads it. */}
      {frames
        .filter((frame) => keptFrameInPanel(frame.key) === panel)
        .map((frame) => (
          <KeptFrameBox
            key={frame.key}
            frame={frame}
            hostRef={hostRef}
            panel={panel}
          />
        ))}
    </div>
  );
}

function KeptFrameBox({
  frame,
  hostRef,
  panel,
}: {
  frame: KeptFrame;
  hostRef: React.RefObject<HTMLDivElement | null>;
  panel: boolean;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const { slot, key } = frame;
  // A pane's slot wins; the thumbnail only shows a page nobody else is.
  const thumb = slot ? null : frame.thumb;
  // Held back until the page has painted something: a loader scaled down to
  // a thumbnail is a smudge, and the card's tile says "Loading" itself.
  const thumbReady = !frame.loading;
  useFrameFocus(
    frameRef,
    () => keptFrameEntered(key),
    () => keptFrameReturned(key, window.history.length),
  );
  useFrameLocation(frameRef, (href) => keptFrameNavigated(key, href));
  // Whether the page is playing sound, for the sidebar's speaker.
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      const audible = frameAudioReport(event, frameRef.current?.contentWindow);
      if (audible !== null) keptFrameAudible(key, audible);
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [key]);

  // Follows the slot: placed before paint, then on every size change of the
  // slot or the pane (tab strip, side panel, split ratio, window). A slot with
  // no size sits under a hidden ancestor, so the frame hides with it.
  useLayoutEffect(() => {
    const box = boxRef.current;
    const page = pageRef.current;
    const host = hostRef.current;
    if (!box || !page || !host) return;
    if (!slot) {
      if (thumb && thumbReady) return followThumb(box, page, host, thumb);
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
  }, [slot, thumb, thumbReady, hostRef]);

  return (
    <div
      ref={boxRef}
      className={
        thumb
          ? // Above the card it sits in (its popup's z), and out of the
            // pointer's way so a click lands on the tile under it.
            "pointer-events-none absolute z-[2147483646] hidden bg-white"
          : panel
            ? "pointer-events-auto absolute hidden bg-white max-[920px]:z-30"
            : "pointer-events-auto absolute hidden bg-white"
      }
      data-kept-frame={frame.key}
    >
      {frame.loading && !thumb ? <BrowserLoading name={frame.name} /> : null}
      {/* Scaled down as a thumbnail; the box and its address stay full size. */}
      <div ref={pageRef} className="h-full w-full">
        <iframe
          key={`${frame.address}#${frame.nonce}`}
          ref={frameRef}
          className={BROWSER_FRAME}
          src={frame.address}
          title={frame.title}
          onLoad={() => keptFrameLoaded(key, window.history.length)}
          allow={frame.allow}
          sandbox={frame.sandbox}
        />
      </div>
      {thumb ? (
        <span className={WS_SUMMARY_FRAME_HOST}>
          {addressHost(frame.location ?? frame.address)}
        </span>
      ) : null}
    </div>
  );
}

/** The width a thumbnail lays its page out at when its tile names none. */
const THUMB_PAGE_WIDTH = 1280;

/**
 * Lays the frame over a thumbnail tile: the box takes the tile's place, and
 * the page in it keeps a full-size layout (the tile's
 * `data-kept-frame-width`, else THUMB_PAGE_WIDTH) scaled down to the tile.
 * The box has the tile's rounded corners and is and cut off where a
 * scrolling ancestor (the summary card) hides the tile. It also fades with
 * its ancestors, so it comes and goes with the card's own animation.
 *
 * The tile moves without resizing whenever the card's content above it
 * changes or the card scrolls, which no observer reports, so this follows it
 * every animation frame while it is shown and only writes when it moved.
 */
function followThumb(
  box: HTMLDivElement,
  page: HTMLDivElement,
  host: HTMLElement,
  tile: HTMLElement,
): () => void {
  const pageWidth = Number(tile.dataset.keptFrameWidth) || THUMB_PAGE_WIDTH;
  const radius = parseFloat(getComputedStyle(tile).borderTopLeftRadius) || 0;
  const clips: HTMLElement[] = [];
  const ancestors: HTMLElement[] = [];
  for (
    let el = tile.parentElement;
    el && el !== document.body;
    el = el.parentElement
  ) {
    ancestors.push(el);
    const style = getComputedStyle(el);
    if (style.overflowX !== "visible" || style.overflowY !== "visible")
      clips.push(el);
  }
  let last = "";
  let raf = 0;
  const place = () => {
    raf = requestAnimationFrame(place);
    const to = tile.getBoundingClientRect();
    const from = host.getBoundingClientRect();
    let { top, left, right, bottom } = to;
    for (const clip of clips) {
      const r = clip.getBoundingClientRect();
      top = Math.max(top, r.top);
      left = Math.max(left, r.left);
      right = Math.min(right, r.right);
      bottom = Math.min(bottom, r.bottom);
    }
    let opacity = 1;
    for (const el of ancestors) opacity *= Number(getComputedStyle(el).opacity);
    const at = [to.left, to.top, to.width, to.height, top, left, right]
      .concat(bottom, from.left, from.top, opacity)
      .join();
    if (at === last) return;
    last = at;
    if (to.width === 0 || right <= left || bottom <= top || opacity === 0) {
      box.style.display = "none";
      return;
    }
    const scale = to.width / pageWidth;
    const inset = [top - to.top, to.right - right, to.bottom - bottom]
      .concat(left - to.left)
      .map((px) => `${px}px`)
      .join(" ");
    box.style.display = "block";
    box.style.opacity = String(opacity);
    box.style.left = `${to.left - from.left}px`;
    box.style.top = `${to.top - from.top}px`;
    box.style.width = `${to.width}px`;
    box.style.height = `${to.height}px`;
    box.style.clipPath = `inset(${inset} round ${radius}px)`;
    page.style.width = `${pageWidth}px`;
    page.style.height = `${to.height / scale}px`;
    page.style.transformOrigin = "0 0";
    page.style.transform = `scale(${scale})`;
  };
  place();
  return () => {
    cancelAnimationFrame(raf);
    box.style.display = "none";
    box.style.opacity = "";
    box.style.clipPath = "";
    page.style.width = "";
    page.style.height = "";
    page.style.transform = "";
    page.style.transformOrigin = "";
  };
}
