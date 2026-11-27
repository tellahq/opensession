import { useLayoutEffect, useRef, useState } from "react";
import { useCachedSessionAssets } from "../hooks/useApiResources";
import { canAnnotateAsset } from "../lib/asset-annotation";
import { useOpenAsset } from "../lib/open-asset";
import { assetFileFor, assetPreviewKind } from "../lib/asset-preview";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Tooltip } from "../ui/tooltip";
import { AssetAnnotationLayer } from "./AssetAnnotationLayer";
import { AssetPreview } from "./AssetView";
import { IconExpand, IconMessage } from "./icons";

/**
 * The width an HTML asset lays out at inline: a desktop window, drawn scaled
 * down to the chat column, so a page made for a screen shows whole instead of
 * cropped to a column-wide slice of its layout.
 */
const PAGE_WIDTH = 1440;

/**
 * An asset the answer produced or named, shown in place under it, so the file
 * is looked at where it was talked about instead of behind a chip. The row
 * above names it, Open full size gives it the Assets tab, and Annotate
 * comments on it right here.
 *
 * The box has a fixed height per kind (a page keeps its desktop window's
 * 16:10): the transcript measures its rows, and a page that grew as it loaded
 * would move everything under it.
 */
export function InlineAssetCard({
  sessionId,
  path,
}: {
  sessionId: string;
  path: string;
}) {
  const files = useCachedSessionAssets(sessionId);
  const asset = useOpenAsset();
  const [annotating, setAnnotating] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ width: number; height: number } | null>(
    null,
  );
  useLayoutEffect(() => {
    const element = boxRef.current;
    if (!element) return;
    const measure = () =>
      setBox((current) =>
        current?.width === element.clientWidth &&
        current.height === element.clientHeight
          ? current
          : { width: element.clientWidth, height: element.clientHeight },
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // A file deleted since: the chip-less answer should not show a broken box.
  if (files && !files.some((file) => file.path === path)) return null;
  const file = assetFileFor(path, files ?? []);
  const kind = assetPreviewKind(path);
  const name = path.split("/").pop() || path;
  const media = kind === "image" || kind === "video";
  const page = kind === "html";
  const scale =
    page && box && box.width < PAGE_WIDTH ? box.width / PAGE_WIDTH : 1;
  return (
    <figure className="m-0 w-full" data-inline-asset={path}>
      {/* Above the file, never over it: a framed page takes the pointer, so
          the chat cannot reveal a control on hover there. */}
      <figcaption className="flex min-h-8 items-center gap-0.5 pb-1 pl-1">
        <span
          className="min-w-0 flex-1 truncate text-label font-medium text-dim"
          title={path}
        >
          {name}
        </span>
        {canAnnotateAsset(kind) && (
          <Tooltip label={annotating ? "Stop annotating" : "Annotate"}>
            <Button
              variant="ghost"
              size="sm"
              icon={<IconMessage size={16} />}
              className={cn(
                "phone:size-11",
                annotating && "bg-hover text-fg hover:bg-pressed",
              )}
              aria-pressed={annotating}
              aria-label={
                annotating ? `Stop annotating ${name}` : `Annotate ${name}`
              }
              onClick={() => setAnnotating(!annotating)}
            />
          </Tooltip>
        )}
        <Tooltip label="Open full size">
          <Button
            variant="ghost"
            size="sm"
            icon={<IconExpand size={16} />}
            className="phone:size-11"
            aria-label={`Open ${name} full size`}
            onClick={() => asset.open(path)}
          />
        </Tooltip>
      </figcaption>
      <div
        ref={boxRef}
        className={cn(
          "relative flex flex-col overflow-hidden rounded-xl bg-panel",
          page
            ? "aspect-[16/10]"
            : media
              ? "h-[360px] phone:h-[260px]"
              : "h-[440px] phone:h-[360px]",
        )}
      >
        {scale < 1 && box ? (
          <div
            // Out of flow: the 1440px page must not size the card, or the
            // card's aspect ratio grows with its own content.
            className="absolute top-0 left-0 flex origin-top-left flex-col"
            style={{
              width: PAGE_WIDTH,
              height: box.height / scale,
              transform: `scale(${scale})`,
            }}
          >
            <AssetPreview ref={previewRef} sessionId={sessionId} file={file} />
          </div>
        ) : (
          <AssetPreview ref={previewRef} sessionId={sessionId} file={file} />
        )}
        {annotating && (
          <AssetAnnotationLayer
            sessionId={sessionId}
            path={path}
            preview={previewRef}
            onExit={() => setAnnotating(false)}
          />
        )}
      </div>
    </figure>
  );
}
