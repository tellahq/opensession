import { useEffect, useState, type RefObject } from "react";
import { IconArrowUp, IconX } from "./icons";
import { Button } from "../ui/button";
import { openLightbox } from "../lib/media-lightbox";
import {
  pickLookingAtImage,
  type MeasuredTranscriptImage,
} from "../lib/looking-at-image-pip";

interface LookingAtImagePipProps {
  readonly containerRef: RefObject<HTMLDivElement | null>;
  readonly sessionId: string;
  readonly entryCount: number;
}

/**
 * Wide-screen floating Picture-in-Picture preview for the most recently
 * scrolled-past transcript image, anchored cleanly in the right gutter.
 */
export function LookingAtImagePip({
  containerRef,
  sessionId,
  entryCount,
}: LookingAtImagePipProps) {
  const [active, setActive] = useState<MeasuredTranscriptImage | null>(null);
  const [dismissedSrc, setDismissedSrc] = useState<string | null>(null);

  useEffect(() => {
    setActive(null);
    setDismissedSrc(null);
  }, [sessionId]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let raf = 0;

    const measure = () => {
      raf = 0;
      const rect = el.getBoundingClientRect();
      const imgs = el.querySelectorAll<HTMLImageElement>("img.md-image");
      const measured: MeasuredTranscriptImage[] = [];
      for (const img of Array.from(imgs)) {
        const src = img.currentSrc || img.getAttribute("src") || "";
        if (!src) continue;
        const r = img.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        measured.push({
          src,
          alt: img.alt || "",
          top: r.top,
          bottom: r.bottom,
        });
      }
      const next = pickLookingAtImage({
        containerWidth: rect.width,
        containerTop: rect.top,
        containerBottom: rect.bottom,
        scrollTop: el.scrollTop,
        images: measured,
      });
      setActive((prev) =>
        prev?.src === next?.src && prev?.alt === next?.alt ? prev : next,
      );
    };

    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(measure);
    };

    schedule();
    el.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(schedule)
        : null;
    observer?.observe(el);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      el.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
    };
  }, [containerRef, entryCount, sessionId]);

  if (!active || active.src === dismissedSrc) return null;

  const jumpToImage = () => {
    const el = containerRef.current;
    if (!el) return;
    const imgs = el.querySelectorAll<HTMLImageElement>("img.md-image");
    for (const img of Array.from(imgs)) {
      if ((img.currentSrc || img.getAttribute("src")) === active.src) {
        img.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
    }
  };

  return (
    <aside
      aria-label="Looking at image preview"
      className="pointer-events-auto absolute right-4 bottom-4 z-20 hidden w-[196px] overflow-hidden rounded-panel border border-border/80 bg-panel/95 shadow-lg backdrop-blur-md xl:block"
    >
      <div className="flex items-center justify-between gap-1 border-b border-border/60 px-2.5 py-1 text-[11px] font-medium text-dim">
        <span className="truncate">Looking at</span>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="sm"
            icon={<IconArrowUp size={11} />}
            onClick={jumpToImage}
            title="Jump to image in transcript"
            aria-label="Jump to image in transcript"
            className="size-5 p-0 text-faint hover:text-fg"
          />
          <Button
            variant="ghost"
            size="sm"
            icon={<IconX size={11} dense />}
            onClick={() => setDismissedSrc(active.src)}
            title="Hide preview"
            aria-label="Hide preview"
            className="size-5 p-0 text-faint hover:text-fg"
          />
        </div>
      </div>
      <Button
        variant="ghost"
        onClick={() =>
          openLightbox(
            [
              {
                kind: "image",
                src: active.src,
                description: active.alt || undefined,
                commentSessionId: sessionId,
              },
            ],
            0,
          )
        }
        className="block h-auto w-full cursor-zoom-in rounded-none bg-canvas/50 p-1.5"
        title="Click to inspect image"
      >
        <img
          src={active.src}
          alt={active.alt}
          className="max-h-[136px] w-full rounded-sm object-cover"
        />
      </Button>
    </aside>
  );
}
