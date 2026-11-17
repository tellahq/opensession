import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import { wideSidePanelWidth } from "../hooks/useSidePanel";
import {
  getKeptFrame,
  hideKeptFrameThumb,
  showKeptFrameThumb,
  subscribeKeptFrames,
} from "../lib/kept-frames";
import type { PanelBrowserFrame } from "../lib/panel-browser-frame";
import {
  WS_SUMMARY_FRAME,
  WS_SUMMARY_FRAME_CAPTION,
  WS_SUMMARY_FRAME_MEDIA,
  WS_SUMMARY_SECTION,
} from "../lib/workspace-summary-classes";
import { cn } from "../ui/cn";

/**
 * The side panel's Browser page, live and small, while the panel is not
 * showing it. It is the same kept page the Browser tab shows (see
 * lib/kept-frames.ts), laid over this tile, so it costs no second load and
 * opening the tab finds it exactly where the thumbnail was.
 */
export function WorkspaceSummaryBrowser({
  frame,
  onOpen,
}: {
  frame: PanelBrowserFrame;
  onOpen: () => void;
}) {
  const [tile, setTile] = useState<HTMLSpanElement | null>(null);
  const { key } = frame;
  const { url, name, title, allow, sandbox } = frame.spec;
  const read = () => getKeptFrame(key);
  const kept = useSyncExternalStore(subscribeKeptFrames, read, read);
  useLayoutEffect(() => {
    if (!tile) return;
    showKeptFrameThumb(key, { url, name, title, allow, sandbox }, tile);
    return () => hideKeptFrameThumb(key, tile);
  }, [key, tile, url, name, title, allow, sandbox]);
  // Laid out at the width the tab opens at, so opening it changes nothing
  // but the size.
  const [pageWidth] = useState(wideSidePanelWidth);

  const address = kept ? (kept.location ?? kept.address) : url;
  let host = address;
  try {
    host = new URL(address).host;
  } catch {
    /* not a URL: show it as it is */
  }

  return (
    <>
      <div className={WS_SUMMARY_SECTION}>Browser</div>
      <button
        type="button"
        className={cn(WS_SUMMARY_FRAME, "mx-4 w-[calc(100%_-_32px)] pt-1")}
        onClick={onOpen}
        title={address}
        aria-label={`Open ${host} in the Browser tab`}
      >
        <span
          ref={setTile}
          data-kept-frame-width={pageWidth}
          className={WS_SUMMARY_FRAME_MEDIA}
        >
          {/* Under the page, which covers it once it has loaded. */}
          <span className="grid h-full w-full place-items-center text-meta text-faint">
            Loading…
          </span>
        </span>
        <span className={WS_SUMMARY_FRAME_CAPTION}>{host}</span>
      </button>
    </>
  );
}
