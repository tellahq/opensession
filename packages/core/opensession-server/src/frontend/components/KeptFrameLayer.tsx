import {
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { animate } from "motion/react";
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
import {
  WS_SUMMARY_FRAME_EDGE,
  WS_SUMMARY_FRAME_HOST,
} from "../lib/workspace-summary-classes";
import { useFrameFocus } from "../hooks/useFrameFocus";
import { useFrameLocation } from "../hooks/useFrameLocation";
import { duration, ease } from "../ui/motion";
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

  // Where the frame last showed, so moving between the summary card's
  // thumbnail and a tab grows or shrinks the page instead of jumping.
  const shown = useRef<Shown | null>(null);

  // Follows the slot: placed before paint, then on every size change of the
  // slot or the pane (tab strip, side panel, split ratio, window). A slot with
  // no size sits under a hidden ancestor, so the frame hides with it.
  useLayoutEffect(() => {
    const box = boxRef.current;
    const page = pageRef.current;
    const host = hostRef.current;
    if (!box || !page || !host) return;
    const from = handoff(shown.current, slot ? "slot" : "thumb");
    if (!slot) {
      if (thumb && thumbReady) {
        const follow = () => followThumb(box, page, host, thumb, shown);
        if (!from) return follow();
        const target = () => thumbPose(thumb);
        return glide(box, page, host, from, target, follow, shown);
      }
      return holdOrHide(box, shown.current);
    }
    const follow = () => followSlot(box, host, slot, shown);
    if (!from) return follow();
    const target = () => slotPose(slot);
    return glide(box, page, host, from, target, follow, shown);
  }, [slot, thumb, thumbReady, hostRef]);

  return (
    <div
      ref={boxRef}
      className={
        thumb
          ? // Above the card it sits in (its popup's z), and out of the
            // pointer's way so a click lands on the tile under it. An open
            // media viewer drops the shell's stacking context to lift the
            // composer, so the thumbnail steps just under the viewer (z
            // 11000) or it would paint over the open image.
            "pointer-events-none absolute z-[2147483646] hidden bg-white " +
            "[html[data-lightbox-composer]_&]:z-[10999]"
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
      {thumb ? <span className={WS_SUMMARY_FRAME_EDGE} /> : null}
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

interface Box {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

/**
 * Where a frame shows on screen, in viewport pixels: the page's own box (its
 * top left corner and width, scaled from `layoutWidth`), the part of it left
 * visible, and the corner radius of that visible part.
 */
interface Pose {
  kind: "slot" | "thumb";
  page: { left: number; top: number; width: number };
  visible: Box;
  radius: number;
  /** The width the page is laid out at. */
  layoutWidth: number;
}

/** The last pose a frame showed at, and when it stopped showing there. */
interface Shown extends Pose {
  endedAt: number | null;
  /** The slot it showed in and that slot's ancestors, for a slot pose. */
  slotAncestors?: readonly HTMLElement[];
}

/**
 * How long after a frame leaves a thumbnail or a slot it can still grow or
 * shrink from there. Opening a tab and hiding the card happen in one commit,
 * but closing the side panel brings the card back a few renders later.
 */
const HANDOFF_MS = 400;

/**
 * The pose to glide from into a `kind` placement: the last one, if it was the
 * other kind and ended just now. Reduced motion jumps instead.
 */
function handoff(last: Shown | null, kind: Pose["kind"]): Pose | null {
  if (!last || last.kind === kind || last.endedAt === null) return null;
  if (performance.now() - last.endedAt > HANDOFF_MS) return null;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches)
    return null;
  return last;
}

function ended(shown: React.RefObject<Shown | null>) {
  if (shown.current && shown.current.endedAt === null)
    shown.current = { ...shown.current, endedAt: performance.now() };
}

/**
 * Hides a frame nothing shows. A page whose slot just left with the region it
 * sat in (the side panel closing) stays where it was for a few frames first:
 * the summary card comes back a few renders later, and the page shrinks into
 * its tile from there rather than blinking out and back. A slot that gave way
 * to other content (another panel tab) hides at once.
 */
function holdOrHide(box: HTMLDivElement, last: Shown | null): () => void {
  let frames = HOLD_FRAMES;
  let raf = 0;
  const hold = () => {
    if (frames-- > 0) raf = requestAnimationFrame(hold);
    else box.style.display = "none";
  };
  if (!handoff(last, "thumb") || !regionClosed(last?.slotAncestors ?? []))
    frames = 0;
  hold();
  return () => cancelAnimationFrame(raf);
}

/** How many frames a page waits for the card it may shrink into. */
const HOLD_FRAMES = 4;

/**
 * Whether a slot left along with the whole region it sat in, given its
 * ancestors from while it showed. The nearest one still in the document is
 * where the region was; with no size left, the region closed rather than
 * showing something else.
 */
function regionClosed(ancestors: readonly HTMLElement[]): boolean {
  const rest = ancestors.find((el) => el.isConnected);
  if (!rest || rest === ancestors[0]) return false;
  const { width, height } = rest.getBoundingClientRect();
  return width === 0 || height === 0;
}

/** A slot's pose, or null while it has no size. */
function slotPose(slot: HTMLElement): Pose | null {
  const to = slot.getBoundingClientRect();
  if (to.width === 0 || to.height === 0) return null;
  return {
    kind: "slot",
    page: { left: to.left, top: to.top, width: to.width },
    visible: { top: to.top, left: to.left, right: to.right, bottom: to.bottom },
    radius: 0,
    layoutWidth: to.width,
  };
}

/** The ancestors that clip a thumbnail tile, and those that fade it. */
function tileAncestors(tile: HTMLElement) {
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
  return { clips, ancestors };
}

/**
 * A thumbnail tile's pose: the page laid out at the tile's
 * `data-kept-frame-width` (else THUMB_PAGE_WIDTH), scaled down to the tile,
 * cut off where a scrolling ancestor (the summary card) hides the tile. Null
 * while none of it is visible.
 */
function thumbPose(
  tile: HTMLElement,
  clips = tileAncestors(tile).clips,
): Pose | null {
  const to = tile.getBoundingClientRect();
  let { top, left, right, bottom } = to;
  for (const clip of clips) {
    const r = clip.getBoundingClientRect();
    top = Math.max(top, r.top);
    left = Math.max(left, r.left);
    right = Math.min(right, r.right);
    bottom = Math.min(bottom, r.bottom);
  }
  if (to.width === 0 || right <= left || bottom <= top) return null;
  return {
    kind: "thumb",
    page: { left: to.left, top: to.top, width: to.width },
    visible: { top, left, right, bottom },
    radius: parseFloat(getComputedStyle(tile).borderTopLeftRadius) || 0,
    layoutWidth: Number(tile.dataset.keptFrameWidth) || THUMB_PAGE_WIDTH,
  };
}

/**
 * Places the box over the pose's visible part, with its rounded corners, and
 * lays the page in it out at the pose's layout width, scaled into the pose.
 * The box stays full size, so what it shows over the page (the address) does
 * too.
 */
function placeScaled(
  box: HTMLDivElement,
  page: HTMLDivElement,
  host: HTMLElement,
  pose: Pose,
) {
  const from = host.getBoundingClientRect();
  const { visible, layoutWidth } = pose;
  const scale = pose.page.width / layoutWidth;
  const height = visible.bottom - pose.page.top;
  const inset = [
    visible.top - pose.page.top,
    pose.page.left + pose.page.width - visible.right,
    0,
    visible.left - pose.page.left,
  ]
    .map((px) => `${Math.max(0, px)}px`)
    .join(" ");
  box.style.display = "block";
  box.style.left = `${pose.page.left - from.left}px`;
  box.style.top = `${pose.page.top - from.top}px`;
  box.style.width = `${pose.page.width}px`;
  box.style.height = `${height}px`;
  box.style.clipPath = `inset(${inset} round ${pose.radius}px)`;
  page.style.width = `${layoutWidth}px`;
  page.style.height = `${height / scale}px`;
  page.style.transformOrigin = "0 0";
  page.style.transform = `scale(${scale})`;
}

function unscale(box: HTMLDivElement, page: HTMLDivElement) {
  box.style.opacity = "";
  box.style.clipPath = "";
  page.style.width = "";
  page.style.height = "";
  page.style.transform = "";
  page.style.transformOrigin = "";
}

/** Lays the frame over its slot, following every size change. */
function followSlot(
  box: HTMLDivElement,
  host: HTMLElement,
  slot: HTMLElement,
  shown: React.RefObject<Shown | null>,
): () => void {
  const slotAncestors: HTMLElement[] = [];
  for (let el: HTMLElement | null = slot; el; el = el.parentElement)
    slotAncestors.push(el);
  const place = () => {
    const pose = slotPose(slot);
    if (!pose) {
      shown.current = null;
      box.style.display = "none";
      return;
    }
    shown.current = { ...pose, endedAt: null, slotAncestors };
    const from = host.getBoundingClientRect();
    box.style.display = "block";
    box.style.left = `${pose.page.left - from.left}px`;
    box.style.top = `${pose.page.top - from.top}px`;
    box.style.width = `${pose.page.width}px`;
    box.style.height = `${pose.visible.bottom - pose.visible.top}px`;
  };
  place();
  const observer = new ResizeObserver(place);
  observer.observe(slot);
  observer.observe(host);
  window.addEventListener("resize", place);
  return () => {
    observer.disconnect();
    window.removeEventListener("resize", place);
    ended(shown);
  };
}

/**
 * Lays the frame over a thumbnail tile (see thumbPose). It also fades with
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
  shown: React.RefObject<Shown | null>,
): () => void {
  const { clips, ancestors } = tileAncestors(tile);
  let last = "";
  let raf = 0;
  const place = () => {
    raf = requestAnimationFrame(place);
    const pose = thumbPose(tile, clips);
    const from = host.getBoundingClientRect();
    let opacity = 1;
    for (const el of ancestors) opacity *= Number(getComputedStyle(el).opacity);
    const at = JSON.stringify([pose, from.left, from.top, opacity]);
    if (at === last) return;
    last = at;
    if (!pose || opacity === 0) {
      shown.current = null;
      box.style.display = "none";
      return;
    }
    shown.current = { ...pose, endedAt: null };
    placeScaled(box, page, host, pose);
    box.style.opacity = String(opacity);
  };
  place();
  return () => {
    cancelAnimationFrame(raf);
    box.style.display = "none";
    unscale(box, page);
    ended(shown);
  };
}

/**
 * Where to head for `to` from `from`. A slot still opening (the side panel
 * widens from nothing at its right edge) counts as at least as wide as the
 * page already is, so the page grows from its tile rather than first
 * shrinking toward the panel's sliver.
 */
function aim(to: Pose | null, from: Pose): Pose | null {
  if (!to || to.kind !== "slot" || to.page.width >= from.page.width) return to;
  const width = from.page.width;
  const left = to.visible.right - width;
  return {
    ...to,
    page: { ...to.page, left, width },
    visible: { ...to.visible, left },
  };
}

/**
 * Grows or shrinks the frame from where it last showed (`from`) to where it
 * shows now, then hands it to `follow`. The target is read every frame, since
 * it moves while it animates in: the side panel widens as it opens, and the
 * summary card comes back as the panel closes.
 *
 * The page's layout width moves from one end's to the other's late in the
 * flight, after its size mostly has: early on it would follow a panel that is
 * still a sliver. It lands laid out exactly as the target shows it.
 */
function glide(
  box: HTMLDivElement,
  page: HTMLDivElement,
  host: HTMLElement,
  from: Pose,
  target: () => Pose | null,
  follow: () => () => void,
  shown: React.RefObject<Shown | null>,
): () => void {
  let to = aim(target(), from) ?? from;
  // Full strength while it flies, though the card it leaves or lands in
  // fades.
  box.style.opacity = "1";
  const place = (t: number) => {
    to = aim(target(), from) ?? to;
    const mix = (a: number, b: number) => a + (b - a) * t;
    const late = (a: number, b: number) => a + (b - a) * t ** 3;
    const width = mix(from.page.width, to.page.width);
    const pose: Pose = {
      kind: to.kind,
      page: {
        left: mix(from.page.left, to.page.left),
        top: mix(from.page.top, to.page.top),
        width,
      },
      visible: {
        top: mix(from.visible.top, to.visible.top),
        left: mix(from.visible.left, to.visible.left),
        right: mix(from.visible.right, to.visible.right),
        bottom: mix(from.visible.bottom, to.visible.bottom),
      },
      radius: mix(from.radius, to.radius),
      // Never wider on screen than laid out: a page scaled up blurs.
      layoutWidth: Math.max(
        late(from.layoutWidth, to.layoutWidth),
        Math.min(width, to.layoutWidth),
      ),
    };
    // Cut short (the panel closes while it opens), it turns back from here.
    shown.current = { ...pose, endedAt: null };
    placeScaled(box, page, host, pose);
  };
  place(0);
  let stop = () => {};
  // From the next frame, as the panel's own CSS transition does: the first
  // frame of an opening panel is a long one, and a clock started before it
  // would leave the page ahead of the panel it flies into.
  let flight: { stop: () => void } | null = null;
  const raf = requestAnimationFrame(() => {
    flight = animate(0, 1, {
      duration: duration.large,
      ease,
      onUpdate: place,
      onComplete: () => {
        unscale(box, page);
        stop = follow();
      },
    });
  });
  return () => {
    cancelAnimationFrame(raf);
    flight?.stop();
    stop();
    unscale(box, page);
    ended(shown);
  };
}
