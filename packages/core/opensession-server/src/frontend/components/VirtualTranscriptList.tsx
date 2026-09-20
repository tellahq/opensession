import {
  Virtualizer,
  defaultRangeExtractor,
  elementScroll,
  observeElementOffset,
  observeElementRect,
  type VirtualItem,
  type VirtualizerOptions,
} from "@tanstack/react-virtual";
import React from "react";
import { flushSync } from "react-dom";
import { PHONE_QUERY } from "../lib/breakpoints";
import { isIOSWebKit } from "../lib/platform";
import {
  loadTranscriptSizes,
  recordTranscriptSizes,
  seededBlockEstimate,
  type TranscriptSizes,
} from "../lib/transcript-sizes";
import { TranscriptArrivalTracker } from "../lib/transcript-arrival";
import { transcriptEnterClass } from "../lib/transcript-motion";
import { TranscriptTopApproachGate } from "../lib/transcript-top-approach";
import {
  registerTranscriptVirtualNavigation,
  type TranscriptVirtualNavigation,
} from "../lib/transcript-virtual-navigation";
import { cn } from "../ui/cn";

export interface VirtualTranscriptItem {
  key: string;
  anchorId: string;
  entryIds: string[];
  /** Previously rendered entry identities this row durably replaces. A fresh
   * outer block with one of these aliases is reconciliation, not an arrival. */
  arrivalAliases?: string[];
  /** Semantic entry revisions for content changes that do not add another id.
   * Used only to select the handful of rows that need a synchronous
   * post-commit measurement. */
  measureVersion?: readonly unknown[];
  /** False for indexed ranges whose payload arrives in read-only hydration
   * slices. Those rows are appearing from history, not arriving live. */
  animateArrival?: boolean;
  estimateSize: number;
  /** Keep the estimate until sparse payload content is available to measure. */
  measure?: boolean;
  className?: string;
  content: React.ReactNode;
}

export function measureTranscriptElement(
  element: Pick<HTMLDivElement, "getBoundingClientRect">,
  entry: ResizeObserverEntry | undefined,
): number {
  const borderBox = entry?.borderBoxSize?.[0];
  return Math.round(
    borderBox?.blockSize ?? element.getBoundingClientRect().height,
  );
}

interface Props {
  items: VirtualTranscriptItem[];
  /** Keep the live-edge tail mounted inside the same virtual coordinate space. */
  trailingMounted: number;
  onVisibleItems?: (items: VirtualTranscriptItem[]) => void;
  /** Explicit host scroller for transcript surfaces outside SessionViewer. */
  scrollElement?: HTMLDivElement | null;
  /** Whether measurement may maintain the live edge in this frame. */
  shouldMaintainEnd?: () => boolean;
  /** The measured virtual extent changed after commit. Following readers use
   * this to reaffirm the live edge after sparse history finishes measuring. */
  onLayout?: () => void;
  /** Fired when the reader climbs near the top of what is mounted, so a
   * caller loading history incrementally can hydrate the next page. Returns
   * whether more history remains available for an underfilled viewport. */
  onTopApproach?: () => boolean;
  /** Re-evaluate visible demand after the caller enables or retries loading. */
  topApproachGeneration?: number;
  /** Range children reuse the renderer without nesting another virtualizer. */
  enabled?: boolean;
  /** Session identity for the measured-height cache. */
  sizeCacheKey?: string;
}

/** A block that just arrived at the live edge fades up into place instead of
 *  popping. One-shot and stateless: the adapter sets `enter` only in the
 *  render that reconciled a new item list against what it had mounted; every
 *  later render of that list, including a row virtualized out and mounted
 *  back in, renders without it. The transform lives on this inner wrapper
 *  because the virtualized row itself positions with an inline translateY
 *  that the keyframe must not fight. */
function EnterRow({
  enter,
  children,
}: {
  enter?: boolean;
  children: React.ReactNode;
}) {
  return <div className={transcriptEnterClass(Boolean(enter))}>{children}</div>;
}

/**
 * Loaded transcript blocks, windowed against their nearest message scroller.
 *
 * TanStack's React hook is intentionally marked incompatible with the React
 * Compiler. The small class adapter below owns that imperative integration;
 * this function component remains compiler-managed and chooses only between
 * the browser virtualizer and the semantic static fallback.
 */
export function VirtualTranscriptList({ enabled = true, ...props }: Props) {
  const canVirtualize =
    enabled && typeof ResizeObserver !== "undefined" && props.items.length > 0;
  if (!canVirtualize) return <>{props.items.map(renderStaticItem)}</>;
  return <TranscriptVirtualizer {...props} />;
}

type AdapterState = { revision: number };

/** The entry the reader is looking at and where it sat in the viewport. */
interface ReaderAnchor {
  node: HTMLElement;
  id: string;
  top: number;
}

/** Content offsets of mounted entries by id: distance from the scroller's
 * content origin, so a reader's scroll movement does not show up in them. */
export type EntryLayout = ReadonlyMap<string, number>;

/** Every mounted entry's offset, and the subset in view. */
export interface EntryLayoutSnapshot {
  mounted: EntryLayout;
  inView: EntryLayout;
}

/** How long the scroller must be quiet after touch activity before an anchor
 * correction is safe. Writing scrollTop sooner cancels the native fling. */
const TOUCH_SETTLE_MS = 150;

/** Imperative adapter for TanStack Virtual core. Class components are outside
 * the React Compiler's function-component transform, so no compiler bailout or
 * opt-out is involved. Its lifecycle mirrors TanStack's official React hook. */
class TranscriptVirtualizer extends React.Component<
  Omit<Props, "enabled">,
  AdapterState
> {
  state: AdapterState = { revision: 0 };
  private root: HTMLDivElement | null = null;
  private mounted = false;
  private rendering = false;
  private committing = false;
  private renderAfterCommit = false;
  private renderQueued = false;
  private mountCleanup: (() => void) | undefined;
  private navigationCleanup: (() => void) | undefined;
  private navigationContainer: HTMLDivElement | null = null;
  private navigationItems: VirtualTranscriptItem[] | null = null;
  private visibleTimer: number | undefined;
  private renderedTotalSize = 0;
  private notifiedTotalSize = -1;
  private containerFor: HTMLDivElement | null = null;
  private explicitContainerFor: HTMLDivElement | null | undefined;
  private container: HTMLDivElement | null = null;
  /** Captured immediately before a commit mutates the DOM. Held across a
   * nested virtualizer commit until the rows and scrollTop agree again. */
  private heldAnchor: ReaderAnchor | undefined;
  /** The virtualizer wrote scrollTop since the last consistent commit. Rows
   * may not have re-rendered against that write yet, so the DOM cannot be
   * measured as a reader viewport until they do. */
  private virtualizerWrote = false;
  /** A virtualizer scroll write whose row transforms have not been rendered.
   * Consumed by the notification that immediately follows the write. */
  private writeAwaitingRender = false;
  private readerInputContainer: HTMLDivElement | null = null;
  private touching = false;
  private lastTouchActivityAt = Number.NEGATIVE_INFINITY;
  /** Where each entry in view stood when it came into view, while touch
   * owns the scroller and corrections wait; what the flush measures against
   * (nextDeferredLedger). */
  private deferredLayout: Map<string, number> | null = null;
  /** A prepend can push the reader's entry completely out of view without
   * any scrolling. Keep that entry until the reader actually moves, rather
   * than mistaking the replacement under the viewport for their new place. */
  private deferredReader: {
    id: string;
    contentTop: number;
    scrollTop: number;
  } | null = null;
  /** Entry positions captured before the current commit changes the DOM,
   * while touch owns the scroller. */
  private preCommitLayout: EntryLayout | null = null;
  private deferredFlushTimer: number | undefined;
  private topApproachContainer: HTMLDivElement | null = null;
  private topApproachCallback: (() => boolean) | undefined;
  private topApproachTimer: number | undefined;
  private underfilledHistoryTimer: number | undefined;
  private topApproachTouchY: number | null = null;
  private topApproachScrollTop: number | null = null;
  private topApproachGate = new TranscriptTopApproachGate();
  private rowObserver: ResizeObserver | null = null;
  private rowRefs = new Map<string, (node: HTMLDivElement | null) => void>();
  /** Block keys and entry identities this adapter instance has mounted, and
   * which tail blocks arrived live since the previous item list. Keyed on the
   * immutable `items` identity: scroll, measurement, and geometry renders
   * reuse the list and cost no reconciliation. */
  private arrivals = new TranscriptArrivalTracker();
  private seeded: { session: string; sizes?: TranscriptSizes } | null = null;
  /** The offset callback TanStack registered through `observeElementOffset`.
   * A scrollTop write made here hands the virtualizer its new offset in the
   * same task, instead of one scroll event (and one paint) later. */
  private offsetCallback:
    | ((offset: number, isScrolling: boolean) => void)
    | undefined;
  private virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>;

  constructor(props: Omit<Props, "enabled">) {
    super(props);
    this.syncSeeded(props.sizeCacheKey);
    this.virtualizer = new Virtualizer(this.options(props));
    // Row refs measure during React's commit, before componentDidMount. A
    // notification raised there must wait for the lifecycle, not flush.
    this.committing = true;
  }

  componentDidMount() {
    this.mounted = true;
    this.runCommitLifecycle(() => {
      this.mountCleanup = this.virtualizer._didMount();
      this.virtualizer._willUpdate();
      this.settleReaderAnchor();
      this.syncTopApproach();
      this.syncReaderInput();
      this.scheduleUnderfilledHistory();
      this.syncNavigation();
      this.scheduleVisibleItems();
      this.notifyLayout();
    });
  }

  getSnapshotBeforeUpdate() {
    // Ref callbacks run between here and componentDidUpdate.
    this.committing = true;
    if (
      shouldCaptureReaderAnchor({
        held: this.heldAnchor !== undefined,
        virtualizerWrote: this.virtualizerWrote,
        following: Boolean(this.props.shouldMaintainEnd?.()),
      })
    )
      this.heldAnchor = this.captureReaderAnchor();
    // While touch owns the scroller this commit's correction waits, and the
    // reader may have flung to any of these entries by the time it lands.
    // Their positions before the DOM changes are what each one is measured
    // against then. Kept across a nested virtualizer commit for the same
    // reason as the held anchor.
    if (
      this.preCommitLayout === null &&
      !this.props.shouldMaintainEnd?.() &&
      this.touchOwnsScroller()
    )
      this.preCommitLayout = this.captureEntryLayout();
    return null;
  }

  componentDidUpdate(prevProps: Omit<Props, "enabled">) {
    this.runCommitLifecycle(() => {
      this.measureCommittedRows(prevProps);
      this.virtualizer._willUpdate();
      this.settleReaderAnchor();
      this.syncTopApproach();
      this.syncReaderInput();
      if (
        prevProps.items.length !== this.props.items.length ||
        prevProps.topApproachGeneration !== this.props.topApproachGeneration
      )
        this.scheduleUnderfilledHistory();
      this.syncNavigation();
      this.scheduleVisibleItems();
      this.notifyLayout();
    });
  }

  componentWillUnmount() {
    this.mounted = false;
    this.mountCleanup?.();
    this.navigationCleanup?.();
    this.clearReaderInput();
    this.clearTopApproach();
    if (this.underfilledHistoryTimer !== undefined)
      window.clearTimeout(this.underfilledHistoryTimer);
    if (this.visibleTimer !== undefined) window.clearTimeout(this.visibleTimer);
    this.rowObserver?.disconnect();
  }

  private notifyLayout() {
    if (this.renderedTotalSize === this.notifiedTotalSize) return;
    this.notifiedTotalSize = this.renderedTotalSize;
    this.props.onLayout?.();
  }

  private syncSeeded(sizeCacheKey?: string) {
    if (!sizeCacheKey) {
      this.seeded = null;
      return;
    }
    if (this.seeded?.session === sizeCacheKey) return;
    this.seeded = {
      session: sizeCacheKey,
      sizes: loadTranscriptSizes(sizeCacheKey),
    };
  }

  private queueRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    queueMicrotask(() => {
      this.renderQueued = false;
      if (this.mounted)
        this.setState(({ revision }) => ({ revision: revision + 1 }));
    });
  }

  private requestRender = (
    _instance: Virtualizer<HTMLDivElement, HTMLDivElement>,
    sync: boolean,
  ) => {
    if (!this.mounted) return;
    if (this.committing) {
      // Mount/update lifecycles already run before paint. Batch virtualizer
      // notifications into one nested update after the lifecycle returns.
      this.renderAfterCommit = true;
      return;
    }
    // setOptions can notify while render is deriving the next range. A
    // microtask still lands before the next paint without forcing React to
    // flush from inside render.
    if (this.rendering) {
      this.queueRender();
      return;
    }
    // The virtualizer just wrote scrollTop to compensate a row measured above
    // the reader (its ResizeObserver path runs in an animation frame, outside
    // any React work). The moved rows must commit in this same frame, or one
    // paint shows the new scrollTop against the old transforms: a visible
    // jump that then snaps back.
    if (this.writeAwaitingRender) {
      this.writeAwaitingRender = false;
      flushSync(() =>
        this.setState(({ revision }) => ({ revision: revision + 1 })),
      );
      return;
    }
    // Scroll-driven range changes also arrive as "sync" notifications. A
    // microtask still lands before paint and coalesces same-turn geometry
    // notifications, so a theme-wide style change costs one render.
    if (sync) this.queueRender();
    else this.setState(({ revision }) => ({ revision: revision + 1 }));
  };

  private runCommitLifecycle(work: () => void) {
    // `renderAfterCommit` is deliberately not reset here: ref callbacks run
    // before this lifecycle with `committing` already set, and a measurement
    // that wrote scrollTop there must still get its nested render.
    this.committing = true;
    try {
      work();
    } finally {
      this.committing = false;
    }
    if (!this.renderAfterCommit) return;
    this.renderAfterCommit = false;
    this.setState(({ revision }) => ({ revision: revision + 1 }));
  }

  private options(
    props: Omit<Props, "enabled">,
  ): VirtualizerOptions<HTMLDivElement, HTMLDivElement> {
    return {
      count: props.items.length,
      getScrollElement: () => this.scrollContainer(),
      // Keyed prepends are anchored by this adapter's reader anchor, not by
      // TanStack's `anchorTo: "end"` mode. That mode rewrites its internal
      // offset the moment history prepends and, on iOS WebKit, defers the
      // matching DOM write while the reader touches or scrolls: until then the
      // mounted range describes a viewport the reader is not looking at, and
      // the late write lands on top of the reader anchor's own correction.
      // Product-level following includes non-virtual tail rows, selections,
      // and disclosure intent, so the host is the sole owner of end following.
      estimateSize: (index) => {
        const item = props.items[index];
        if (!item) return 96;
        return seededBlockEstimate(
          item.estimateSize,
          this.seeded?.sizes,
          item.key,
        );
      },
      getItemKey: (index) => props.items[index]?.key ?? index,
      // Touch momentum can move a phone viewport farther between committed
      // frames than wheel scrolling. Keep twice as much history mounted there
      // so the leading edge cannot expose an unmounted row during a fast fling.
      overscan: transcriptOverscan(
        typeof window !== "undefined" && window.matchMedia(PHONE_QUERY).matches,
      ),
      rangeExtractor: (range) =>
        virtualTranscriptRange(
          defaultRangeExtractor(range),
          range.count,
          props.trailingMounted,
        ),
      observeElementRect,
      observeElementOffset: this.observeOffset,
      scrollToFn: this.scrollToFn,
      measureElement: measureTranscriptElement,
      // Semantic transcript revisions are measured synchronously in
      // componentDidUpdate. ResizeObserver is only the fallback for external
      // geometry changes, so let TanStack coalesce those into the next frame;
      // flushing React from inside observer delivery can resize another row and
      // trigger the browser's undelivered-notifications warning.
      useAnimationFrameWithResizeObserver: true,
      onChange: this.requestRender,
    };
  }

  private setRoot = (node: HTMLDivElement | null) => {
    this.root = node;
  };

  private scrollToFn: VirtualizerOptions<
    HTMLDivElement,
    HTMLDivElement
  >["scrollToFn"] = (offset, options, instance) => {
    this.virtualizerWrote = true;
    this.writeAwaitingRender = true;
    elementScroll(offset, options, instance);
  };

  private observeOffset: VirtualizerOptions<
    HTMLDivElement,
    HTMLDivElement
  >["observeElementOffset"] = (instance, callback) => {
    this.offsetCallback = callback;
    const unsubscribe = observeElementOffset(instance, callback);
    return () => {
      if (this.offsetCallback === callback) this.offsetCallback = undefined;
      unsubscribe?.();
    };
  };

  /** After this adapter writes scrollTop, the virtualizer would otherwise
   * learn the new offset from the scroll event, one frame later, and paint
   * that frame with the range of the old offset: a prepend larger than the
   * overscan leaves the reader over unmounted rows for that paint. Reporting
   * the offset now recomputes the range in the same task. */
  private syncVirtualizerOffset(container: HTMLDivElement) {
    this.offsetCallback?.(container.scrollTop, false);
  }

  private measureCommittedRows(prevProps: Omit<Props, "enabled">) {
    const keys = committedTranscriptMeasureKeys(
      prevProps.items,
      this.props.items,
    );
    if (!this.root || keys.size === 0) return;
    for (const node of this.root.querySelectorAll<HTMLDivElement>(
      "[data-transcript-key]",
    )) {
      if (!keys.has(node.dataset.transcriptKey ?? "")) continue;
      // ResizeObserver reports after the commit. Re-running TanStack's own
      // measurement path here lets it update root height and compensation in
      // the same pre-paint layout phase. Do not mix resizeItem with
      // measureElement on the same index: TanStack documents that as
      // unpredictable because both paths race to own the cached size.
      this.virtualizer.measureElement(node);
    }
  }

  /** The nearest message scroller, cached per root node: `closest` walks the
   * whole ancestor chain and used to run several times on every commit. */
  private scrollContainer(): HTMLDivElement | null {
    const explicit = this.props.scrollElement;
    if (
      this.root !== this.containerFor ||
      explicit !== this.explicitContainerFor
    ) {
      this.containerFor = this.root;
      this.explicitContainerFor = explicit;
      this.container =
        explicit ??
        this.root?.closest<HTMLDivElement>(".viewer-messages") ??
        null;
    }
    return this.container;
  }

  private captureReaderAnchor(): ReaderAnchor | undefined {
    const container = this.scrollContainer();
    const root = this.root;
    if (!container || !root) return undefined;
    return pickReaderAnchor(root, container.getBoundingClientRect().top);
  }

  private captureEntryLayout(): EntryLayout | null {
    const container = this.scrollContainer();
    const root = this.root;
    if (!container || !root) return null;
    return captureEntryLayout(root, container).mounted;
  }

  private touchOwnsScroller() {
    return shouldDeferReaderCorrection({
      touching: this.touching,
      sinceTouchActivity: performance.now() - this.lastTouchActivityAt,
    });
  }

  /** History prepends above the reader, grouped rows change internally,
   * estimates resolve to measurements, and a partial row can grow at its
   * start. Whatever moved, the entry the reader was looking at goes back where
   * it was before this commit, as a delta on the current scroll position: the
   * snapshot was taken synchronously before the DOM changed, so no reader
   * movement can hide inside it.
   *
   * While touch owns the scroller the write waits (it would cancel the fling).
   * With no scroll movement, retain the original entry even if the prepend
   * pushes it offscreen. Once the reader moves, that anchor is not enough:
   * by the time the write is safe, they may have flung through the rows
   * whose measurements displaced the anchor. Entries above those rows never
   * moved, so putting the old anchor back would throw such a reader toward
   * the live edge by the whole growth (measured: 5692px after one fling). So
   * the deferral keeps a ledger of where each entry in view stood when it
   * came into view, and the flush moves the scroller by how far the entry
   * then under the reader has travelled since: only movement the reader was
   * shown (see nextDeferredLedger). */
  private settleReaderAnchor() {
    // A virtualizer scroll write raised a nested render. Until it commits,
    // scrollTop and the row transforms describe different layouts, so hold
    // the anchor and measure after that commit instead.
    if (this.renderAfterCommit) return;
    const anchor = this.heldAnchor;
    const before = this.preCommitLayout;
    this.heldAnchor = undefined;
    this.preCommitLayout = null;
    this.virtualizerWrote = false;
    const container = this.scrollContainer();
    const root = this.root;
    if (!container || !root || this.props.shouldMaintainEnd?.()) return;
    if (this.touchOwnsScroller()) {
      if (!this.deferredReader && anchor)
        this.deferredReader = {
          id: anchor.id,
          contentTop:
            this.deferredLayout?.get(anchor.id) ??
            container.scrollTop + anchor.top,
          scrollTop: container.scrollTop,
        };
      this.deferredLayout = nextDeferredLedger(
        this.deferredLayout,
        before ??
          (anchor && new Map([[anchor.id, container.scrollTop + anchor.top]])),
        captureEntryLayout(root, container),
      );
      this.scheduleDeferredFlush();
      return;
    }
    if (!anchor) return;
    const node = anchor.node.isConnected
      ? anchor.node
      : findTranscriptEntry(root, anchor.id);
    if (!node) return;
    const delta =
      node.getBoundingClientRect().top -
      container.getBoundingClientRect().top -
      anchor.top;
    if (Math.abs(delta) <= 0.5) return;
    container.scrollTop += delta;
    this.syncVirtualizerOffset(container);
  }

  private scheduleDeferredFlush() {
    if (this.deferredFlushTimer !== undefined)
      window.clearTimeout(this.deferredFlushTimer);
    this.deferredFlushTimer = window.setTimeout(() => {
      this.deferredFlushTimer = undefined;
      const container = this.readerInputContainer;
      const root = this.root;
      const ledger = this.deferredLayout;
      if (!container || !root || !ledger) return;
      if (this.touchOwnsScroller()) {
        this.scheduleDeferredFlush();
        return;
      }
      this.deferredLayout = null;
      const retained = this.deferredReader;
      this.deferredReader = null;
      const retainedNode =
        retained && Math.abs(container.scrollTop - retained.scrollTop) <= 0.5
          ? findTranscriptEntry(root, retained.id)
          : null;
      const viewportTop = container.getBoundingClientRect().top;
      const reader = retainedNode
        ? undefined
        : pickReaderAnchor(root, viewportTop);
      const delta =
        retained && retainedNode
          ? retainedNode.getBoundingClientRect().top -
            viewportTop +
            container.scrollTop -
            retained.contentTop
          : deferredReaderCorrection(
              ledger,
              reader && {
                id: reader.id,
                contentTop: container.scrollTop + reader.top,
              },
            );
      if (Math.abs(delta) <= 0.5) return;
      container.scrollTop += delta;
      this.syncVirtualizerOffset(container);
    }, TOUCH_SETTLE_MS);
  }

  private onReaderTouchStart = () => {
    this.touching = true;
    this.lastTouchActivityAt = performance.now();
  };

  private onReaderTouchEnd = () => {
    this.touching = false;
    this.lastTouchActivityAt = performance.now();
    if (this.deferredLayout) this.scheduleDeferredFlush();
  };

  private onReaderScroll = () => {
    const container = this.readerInputContainer;
    if (
      container &&
      this.deferredReader &&
      Math.abs(container.scrollTop - this.deferredReader.scrollTop) > 0.5
    )
      this.deferredReader = null;
    const now = performance.now();
    // Keep following the scroll-event chain started by the touch. A network
    // response can change row geometry long after touchend but while momentum
    // is still producing scroll events; that correction must wait as well.
    if (this.touching || now - this.lastTouchActivityAt < TOUCH_SETTLE_MS)
      this.lastTouchActivityAt = now;
    if (this.deferredLayout) this.scheduleDeferredFlush();
  };

  private clearReaderInput() {
    const container = this.readerInputContainer;
    if (container) {
      container.removeEventListener("touchstart", this.onReaderTouchStart);
      container.removeEventListener("touchend", this.onReaderTouchEnd);
      container.removeEventListener("touchcancel", this.onReaderTouchEnd);
      container.removeEventListener("scroll", this.onReaderScroll, true);
    }
    if (this.deferredFlushTimer !== undefined)
      window.clearTimeout(this.deferredFlushTimer);
    this.deferredFlushTimer = undefined;
    this.deferredLayout = null;
    this.deferredReader = null;
    this.preCommitLayout = null;
    this.touching = false;
    this.lastTouchActivityAt = Number.NEGATIVE_INFINITY;
    this.readerInputContainer = null;
  }

  private syncReaderInput() {
    const container = this.scrollContainer();
    if (container === this.readerInputContainer) return;
    this.clearReaderInput();
    this.readerInputContainer = container;
    if (!container) return;
    const passive = { passive: true } as const;
    container.addEventListener("touchstart", this.onReaderTouchStart, passive);
    container.addEventListener("touchend", this.onReaderTouchEnd, passive);
    container.addEventListener("touchcancel", this.onReaderTouchEnd, passive);
    container.addEventListener("scroll", this.onReaderScroll, {
      passive: true,
      capture: true,
    });
  }

  private observeRowNode(key: string, node: HTMLElement) {
    node.dataset.transcriptKey = key;
    if (!this.rowObserver) {
      this.rowObserver = new ResizeObserver((entries) => {
        const cache = this.seeded?.sizes;
        if (!cache || entries.length === 0) return;
        const measured: Array<readonly [string, number]> = [];
        let width = 0;
        for (const entry of entries) {
          const target = entry.target;
          if (!(target instanceof HTMLElement)) continue;
          const entryKey = target.dataset.transcriptKey;
          const height =
            entry.borderBoxSize?.[0]?.blockSize ??
            target.getBoundingClientRect().height;
          if (entryKey && Number.isFinite(height) && height > 0)
            measured.push([entryKey, height]);
          width ||= entry.borderBoxSize?.[0]?.inlineSize ?? target.offsetWidth;
        }
        recordTranscriptSizes(cache, width, measured);
      });
    }
    this.rowObserver.observe(node);
  }

  private rowRef(key: string) {
    let callback = this.rowRefs.get(key);
    if (!callback) {
      callback = (node) => {
        this.virtualizer.measureElement(node);
        if (this.props.sizeCacheKey && node) this.observeRowNode(key, node);
      };
      if (this.rowRefs.size > 1_000) this.rowRefs.clear();
      this.rowRefs.set(key, callback);
    }
    return callback;
  }

  private syncNavigation() {
    const container = this.scrollContainer();
    if (
      container === this.navigationContainer &&
      this.props.items === this.navigationItems &&
      this.navigationCleanup
    )
      return;
    this.navigationCleanup?.();
    this.navigationCleanup = undefined;
    this.navigationContainer = container;
    this.navigationItems = this.props.items;
    if (!container || this.props.items.length === 0) return;
    const indexByEntry = new Map<string, number>();
    for (let index = 0; index < this.props.items.length; index++) {
      for (const entryId of this.props.items[index]?.entryIds ?? [])
        if (!indexByEntry.has(entryId)) indexByEntry.set(entryId, index);
    }
    const navigation: TranscriptVirtualNavigation = {
      scrollToEntry: (entryId) => {
        const index = indexByEntry.get(entryId);
        if (index === undefined) return false;
        this.virtualizer.scrollToIndex(index, { align: "start" });
        return true;
      },
    };
    this.navigationCleanup = registerTranscriptVirtualNavigation(
      container,
      navigation,
    );
  }

  private evaluateTopApproach = () => {
    const container = this.topApproachContainer;
    const callback = this.topApproachCallback;
    if (
      !container ||
      !callback ||
      !this.topApproachGate.shouldFire(
        container.scrollTop <= container.clientHeight,
        performance.now(),
      )
    )
      return;
    callback();
  };

  private onTopApproachScroll = () => {
    const scrollTop = this.topApproachContainer?.scrollTop;
    if (scrollTop !== undefined) {
      const viewportHeight = this.topApproachContainer?.clientHeight ?? 0;
      const movedTowardHistory = didScrollTranscriptTowardHistory(
        this.topApproachScrollTop ?? scrollTop,
        scrollTop,
        viewportHeight,
        this.topApproachContainer?.scrollHeight ?? 0,
      );
      this.topApproachScrollTop = scrollTop;
      if (movedTowardHistory) {
        this.topApproachGate.request();
        // A scrollbar/Home jump can arrive as one top-edge scroll event. Fire
        // from that event rather than requiring a second gesture to retry the
        // debounced proximity check.
        if (scrollTop <= viewportHeight) {
          this.evaluateTopApproach();
          return;
        }
      }
    }
    if (this.topApproachTimer !== undefined) return;
    this.topApproachTimer = window.setTimeout(() => {
      this.topApproachTimer = undefined;
      this.evaluateTopApproach();
    }, 100);
  };

  private requestTopApproach = () => {
    this.topApproachGate.request();
    this.onTopApproachScroll();
  };

  private scheduleUnderfilledHistory() {
    if (this.underfilledHistoryTimer !== undefined) return;
    const container = this.topApproachContainer;
    if (
      !container ||
      !this.topApproachCallback ||
      !transcriptViewportNeedsHistory(
        container.scrollHeight,
        container.clientHeight,
      )
    )
      return;
    // The complete index becomes demand-ready one frame after positioning.
    // Recheck asynchronously so an opening tail that cannot scroll can request
    // enough real history to create an upward scroll path.
    this.underfilledHistoryTimer = window.setTimeout(() => {
      this.underfilledHistoryTimer = undefined;
      const current = this.topApproachContainer;
      const callback = this.topApproachCallback;
      if (
        !current ||
        !callback ||
        !transcriptViewportNeedsHistory(
          current.scrollHeight,
          current.clientHeight,
        )
      )
        return;
      if (callback()) this.scheduleUnderfilledHistory();
    }, 250);
  }

  private onTopApproachWheel = (event: WheelEvent) => {
    if (event.deltaY < 0) this.requestTopApproach();
  };

  private onTopApproachTouchStart = (event: TouchEvent) => {
    this.topApproachTouchY = event.touches[0]?.clientY ?? null;
  };

  private onTopApproachTouchMove = (event: TouchEvent) => {
    const y = event.touches[0]?.clientY;
    if (y === undefined || this.topApproachTouchY === null) return;
    if (y > this.topApproachTouchY + 1) this.requestTopApproach();
    this.topApproachTouchY = y;
  };

  private clearTopApproach() {
    this.topApproachContainer?.removeEventListener(
      "scroll",
      this.onTopApproachScroll,
      true,
    );
    this.topApproachContainer?.removeEventListener(
      "wheel",
      this.onTopApproachWheel,
    );
    this.topApproachContainer?.removeEventListener(
      "touchstart",
      this.onTopApproachTouchStart,
    );
    this.topApproachContainer?.removeEventListener(
      "touchmove",
      this.onTopApproachTouchMove,
    );
    this.topApproachContainer = null;
    this.topApproachTouchY = null;
    this.topApproachScrollTop = null;
    if (this.topApproachTimer !== undefined) {
      window.clearTimeout(this.topApproachTimer);
      this.topApproachTimer = undefined;
    }
  }

  private syncTopApproach() {
    const container = this.scrollContainer();
    const callback = this.props.onTopApproach;
    const containerChanged = container !== this.topApproachContainer;
    if (!containerChanged && callback === this.topApproachCallback) return;
    this.clearTopApproach();
    this.topApproachCallback = callback;
    if (containerChanged) this.topApproachGate.reset();
    if (!container || !callback) return;
    this.topApproachContainer = container;
    this.topApproachScrollTop = container.scrollTop;
    // Capture before React's scroll listener can synchronously rerender this
    // adapter and replace its listener. In bubble order, a one-step scrollbar
    // jump removed this callback before the same event ever reached it.
    container.addEventListener("scroll", this.onTopApproachScroll, {
      passive: true,
      capture: true,
    });
    container.addEventListener("wheel", this.onTopApproachWheel, {
      passive: true,
    });
    container.addEventListener("touchstart", this.onTopApproachTouchStart, {
      passive: true,
    });
    container.addEventListener("touchmove", this.onTopApproachTouchMove, {
      passive: true,
    });
  }

  // Geometry reads and the near-visible filter run inside the debounce, not
  // at schedule time: scheduling happens on every commit, and reading
  // scrollTop/clientHeight there forced a layout per commit for a result the
  // timeout usually threw away. Firing late also reports the freshest window.
  private scheduleVisibleItems() {
    if (this.visibleTimer !== undefined) window.clearTimeout(this.visibleTimer);
    if (!this.props.onVisibleItems) return;
    this.visibleTimer = window.setTimeout(() => {
      this.visibleTimer = undefined;
      const { onVisibleItems, items } = this.props;
      const virtualItems = this.virtualizer.getVirtualItems();
      if (!onVisibleItems || virtualItems.length === 0) return;
      const container = this.scrollContainer();
      const top = container?.scrollTop ?? 0;
      const viewport = container?.clientHeight ?? 0;
      const bottom = top + viewport;
      onVisibleItems(
        virtualItems
          .filter(
            (item) =>
              !container ||
              (item.end >= top - viewport && item.start <= bottom + viewport),
          )
          .map((virtualItem) => items[virtualItem.index])
          .filter((item): item is VirtualTranscriptItem => Boolean(item)),
      );
    }, 120);
  }

  render() {
    this.rendering = true;
    // Any render lays the rows out against the latest virtualizer offsets, so
    // a write that reached here through a lifecycle render needs no flush.
    this.writeAwaitingRender = false;
    this.syncSeeded(this.props.sizeCacheKey);
    this.virtualizer.setOptions(this.options(this.props));
    this.virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (
      item,
      delta,
      instance,
    ) => {
      // A growing live row must carry scrollTop in the same virtualizer frame.
      // Leaving all live-edge movement to the React layout effect exposed three
      // distinct phone paints: new tool content, then a taller virtual root,
      // then the corrected bottom. Shrinks still fall through to the browser's
      // clamp/follow pass; compensating only positive growth avoids pushing a
      // reader past the new end during a turn's final restructure.
      // One owner per commit. While a reader anchor is held, the entry at
      // the viewport top goes back where it was after the rows commit, from
      // the DOM itself. A size-based guess here (a spanning row measured for
      // the first time, a grouped row growing below the reader) would only
      // be undone by that settle: two writes in one frame instead of one.
      if (this.heldAnchor) return false;
      // Nor may TanStack write while the reader touches, or while iOS WebKit
      // is scrolling. A write under the finger cancels the fling, and on iOS
      // the library does not write at all then: it banks the delta in a
      // bucket of its own and flushes it once scrolling is quiet, on top of
      // whatever the host and this adapter corrected meanwhile. The host's
      // own live-edge writes keep `isScrolling` true through a stream, so
      // that bucket used to collect a whole stream's growth and throw a
      // reader who had since left for history by that sum. The host re-pins
      // the live edge on layout; a parked reader's displacement is measured
      // from the DOM by the anchor of the commit that moves the rows.
      if (this.touchOwnsScroller() || (isIOSWebKit && instance.isScrolling))
        return false;
      const liveEdgeDelta = this.props.shouldMaintainEnd?.()
        ? delta
        : undefined;
      return shouldAdjustTranscriptScroll({
        itemStart: item.start,
        itemEnd: item.end,
        scrollOffset: instance.scrollOffset ?? 0,
        firstMeasurement: !instance.itemSizeCache.has(item.key),
        scrollingBackward: instance.scrollDirection === "backward",
        liveEdgeDelta,
      });
    };
    const virtualItems = this.virtualizer.getVirtualItems();
    const totalSize = this.virtualizer.getTotalSize();
    this.renderedTotalSize = totalSize;
    // Tail-arrival detection runs here, in the imperative adapter, because
    // "mounted by the previous build" is virtualizer knowledge: the function
    // component above is compiler-managed and may re-render without a new
    // item list, and a ref-based previous-set there is a compile error. The
    // tracker walks the list once per identity; a same-list render (scroll,
    // remeasure, resize) gets an empty set and does no reconciliation.
    const enteringSet = this.arrivals.reconcile(this.props.items);
    const result = (
      <div
        ref={this.setRoot}
        className="relative w-full"
        style={{ height: totalSize }}
        data-virtual-transcript
        data-virtual-count={this.props.items.length}
        data-transcript-blocks={this.props.items.length}
      >
        {virtualItems.map((virtualItem: VirtualItem) => {
          const item = this.props.items[virtualItem.index];
          if (!item) return null;
          return (
            <div
              key={item.key}
              ref={item.measure === false ? undefined : this.rowRef(item.key)}
              data-index={virtualItem.index}
              data-eid={item.anchorId}
              data-transcript-key={item.key}
              // Never transition transform here. A row's position is
              // compensated by instant scrollTop writes (the virtualizer's
              // and this adapter's), and a 200ms glide against an instant
              // scroll reads as the transcript wobbling on its own.
              className={cn("absolute left-0 top-0 w-full", item.className)}
              style={{ transform: `translateY(${virtualItem.start}px)` }}
            >
              <EnterRow enter={enteringSet.has(item.key)}>
                {item.content}
              </EnterRow>
            </div>
          );
        })}
      </div>
    );
    this.rendering = false;
    return result;
  }
}

const NO_MEASURE_KEYS: ReadonlySet<string> = new Set();

/** Rows whose semantic content changed between two committed item lists. The
 * lists are immutable snapshots, so the same reference means nothing to
 * remeasure and the scan is skipped outright: geometry and scroll commits
 * reuse the list and must not pay for it. Rows usually keep their position
 * between lists (append, regroup, remeasure), so a positional lookup serves
 * first; the keyed map is built only once a row has moved (history prepend). */
export function committedTranscriptMeasureKeys(
  previous: readonly VirtualTranscriptItem[],
  next: readonly VirtualTranscriptItem[],
): ReadonlySet<string> {
  if (previous === next) return NO_MEASURE_KEYS;
  let previousByKey: Map<string, VirtualTranscriptItem> | undefined;
  const previousFor = (index: number, key: string) => {
    const aligned = previous[index];
    if (aligned?.key === key) return aligned;
    previousByKey ??= new Map(previous.map((item) => [item.key, item]));
    return previousByKey.get(key);
  };
  const changed = new Set<string>();
  for (let index = 0; index < next.length; index++) {
    const item = next[index]!;
    if (item.measure === false) continue;
    const before = previousFor(index, item.key);
    const beforeVersion = before?.measureVersion;
    const nextVersion = item.measureVersion;
    if (
      !before ||
      before.entryIds.length !== item.entryIds.length ||
      before.entryIds.some((id, index) => id !== item.entryIds[index]) ||
      beforeVersion?.length !== nextVersion?.length ||
      Boolean(
        nextVersion?.some(
          (version, index) => version !== beforeVersion?.[index],
        ),
      )
    )
      changed.add(item.key);
  }
  return changed;
}

/**
 * The entry the reader is looking at: the entry-level node at or straddling
 * the viewport top, descended to its innermost `[data-eid]`. That is the
 * choice browser scroll anchoring makes, which Chrome cannot make for
 * transform-positioned rows (measured: 0px compensation in every case). The
 * innermost node matters because a grouped row keeps its outer identity while
 * older steps hydrate into it above the reader.
 *
 * Rows are absolutely positioned, so a row whose content just grew (an image
 * decoded, a code block highlighted) overlaps the rows below it until the
 * virtualizer lays them out again. Later siblings paint on top, so what the
 * reader sees at the viewport top is the last row straddling it in DOM order,
 * not the first. Taking the first picked the grown row, whose own top never
 * moves, and the reader's real row slid out from under them uncorrected.
 */
export function pickReaderAnchor(
  root: HTMLElement,
  viewportTop: number,
): ReaderAnchor | undefined {
  const intersects = (rect: DOMRect) =>
    rect.height > 0 && rect.bottom > viewportTop + 1;
  let picked: { row: HTMLElement; rect: DOMRect } | undefined;
  for (const row of root.children) {
    if (!(row instanceof HTMLElement)) continue;
    const rect = row.getBoundingClientRect();
    if (!intersects(rect)) continue;
    // Past the first intersecting row, only a row that still straddles the
    // top can be painted over the pick; rows that start below it cannot.
    if (picked && rect.top > viewportTop + 1) break;
    picked = { row, rect };
  }
  if (picked) {
    const { row, rect: rowRect } = picked;
    const rowId = row.dataset.eid;
    let anchor: ReaderAnchor | undefined = rowId
      ? { node: row, id: rowId, top: rowRect.top - viewportTop }
      : undefined;
    for (const node of row.querySelectorAll<HTMLElement>("[data-eid]")) {
      const id = node.dataset.eid;
      if (!id) continue;
      const rect = node.getBoundingClientRect();
      if (!intersects(rect)) continue;
      // Doc order lists a node's interior right after it: keep descending
      // while the qualifying node is inside the current pick, and stop at the
      // first qualifying node that is not.
      if (anchor && !anchor.node.contains(node)) break;
      anchor = { node, id, top: rect.top - viewportTop };
    }
    return anchor;
  }
  return undefined;
}

/** Every mounted entry's content offset, and the subset in view. Rows and
 * the entries inside them both carry `data-eid`, so whichever one
 * `pickReaderAnchor` later picks has a record. */
export function captureEntryLayout(
  root: HTMLElement,
  container: HTMLElement,
): EntryLayoutSnapshot {
  const viewport = container.getBoundingClientRect();
  const origin = viewport.top - container.scrollTop;
  const mounted = new Map<string, number>();
  const inView = new Map<string, number>();
  for (const node of root.querySelectorAll<HTMLElement>("[data-eid]")) {
    const id = node.dataset.eid;
    if (!id || mounted.has(id)) continue;
    const rect = node.getBoundingClientRect();
    const top = rect.top - origin;
    mounted.set(id, top);
    if (rect.bottom > viewport.top && rect.top < viewport.bottom)
      inView.set(id, top);
  }
  return { mounted, inView };
}

/** The ledger after a commit whose correction is deferred: every entry now
 * in view, at the position it had when it came into view. An entry already
 * in the ledger keeps its position, so two commits that each move it add up
 * to one displacement. An entry entering the view in this commit takes its
 * position from before the commit if it was mounted then (a growth above
 * that pushed it into view is movement the reader saw), else where it
 * first appeared. Entries that left the view are dropped: what moves them
 * while they are out of view was never shown, and if the reader flings back
 * to one, they arrive at wherever it is now. */
export function nextDeferredLedger(
  ledger: EntryLayout | null,
  before: EntryLayout | null | undefined,
  after: EntryLayoutSnapshot,
): Map<string, number> {
  const next = new Map<string, number>();
  for (const [id, top] of after.inView)
    next.set(id, ledger?.get(id) ?? before?.get(id) ?? top);
  return next;
}

/** How far the entry now under the reader has moved since it came into view.
 * Only that entry's movement is the reader's: an entry the ledger does not
 * hold was not in view when anything last moved. */
export function deferredReaderCorrection(
  ledger: EntryLayout,
  reader: { id: string; contentTop: number } | undefined,
): number {
  if (!reader) return 0;
  const seen = ledger.get(reader.id);
  return seen === undefined ? 0 : reader.contentTop - seen;
}

function findTranscriptEntry(
  root: HTMLElement,
  id: string,
): HTMLElement | null {
  return typeof CSS !== "undefined"
    ? root.querySelector<HTMLElement>(`[data-eid="${CSS.escape(id)}"]`)
    : null;
}

export function shouldCaptureReaderAnchor({
  held,
  virtualizerWrote,
  following,
}: {
  held: boolean;
  virtualizerWrote: boolean;
  following: boolean;
}): boolean {
  // A following reader is owned by the host's live-edge glue. A held anchor
  // predates a virtualizer write whose rows have not committed; the DOM in
  // between describes no viewport a reader ever saw, so keep the earlier one.
  return !following && !held && !virtualizerWrote;
}

export function shouldDeferReaderCorrection({
  touching,
  sinceTouchActivity,
}: {
  touching: boolean;
  sinceTouchActivity: number;
}): boolean {
  // Touch browsers cancel an in-flight fling on any programmatic scroll
  // write. A wheel animation survives one (measured in Chrome), so only touch
  // input defers. Scroll events extend touch activity until the fling settles.
  return touching || sinceTouchActivity < TOUCH_SETTLE_MS;
}

export function transcriptViewportNeedsHistory(
  scrollHeight: number,
  clientHeight: number,
): boolean {
  return clientHeight > 0 && scrollHeight <= clientHeight + 1;
}

export function didScrollTranscriptTowardHistory(
  previousOffset: number,
  nextOffset: number,
  viewportHeight = 0,
  contentHeight = 0,
): boolean {
  if (nextOffset < previousOffset - 0.5) return true;
  // A child virtualizer can subscribe before its parent restores the live edge,
  // leaving the sampled offset at zero. A one-step Home key or scrollbar jump
  // then reports zero again. Treat that top-edge event as intent only when the
  // mounted window is genuinely scrollable and movement was not toward latest.
  return (
    contentHeight > viewportHeight * 2 &&
    nextOffset <= viewportHeight &&
    nextOffset <= previousOffset + 0.5
  );
}

export function shouldAdjustTranscriptScroll({
  itemStart,
  itemEnd,
  scrollOffset,
  firstMeasurement = false,
  scrollingBackward = false,
  liveEdgeDelta,
}: {
  itemStart: number;
  itemEnd: number;
  scrollOffset: number;
  firstMeasurement?: boolean;
  scrollingBackward?: boolean;
  liveEdgeDelta?: number;
}): boolean {
  if (liveEdgeDelta !== undefined) return liveEdgeDelta > 0;
  // Match TanStack's native measurement predicate everywhere else. Supplying
  // the live-edge exception above replaces the core callback, so its default
  // behavior needs to remain intact here. A row that spans the fold and grows
  // (a partial opening suffix hydrating at its start, a streaming step) is
  // not compensated here; the reader anchor settles it after the commit.
  if (firstMeasurement) return itemStart < scrollOffset;
  return itemEnd <= scrollOffset + 1 && !scrollingBackward;
}

export function transcriptOverscan(phone: boolean): number {
  return phone ? 16 : 8;
}

export function virtualTranscriptRange(
  visible: number[],
  count: number,
  trailingMounted: number,
): number[] {
  const indexes = new Set(visible);
  const start = Math.max(0, count - Math.max(0, trailingMounted));
  for (let index = start; index < count; index++) indexes.add(index);
  return [...indexes].sort((a, b) => a - b);
}

function renderStaticItem(item: VirtualTranscriptItem) {
  return (
    <div key={item.key} data-eid={item.anchorId} className={item.className}>
      {item.content}
    </div>
  );
}
