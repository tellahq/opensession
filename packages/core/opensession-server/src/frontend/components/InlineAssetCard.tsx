import { useRef, useState } from "react";
import { useCachedSessionAssets } from "../hooks/useApiResources";
import { canAnnotateAsset } from "../lib/asset-annotation";
import { useAssetTabOpener } from "../lib/asset-overlay-store";
import { assetFileFor, assetPreviewKind } from "../lib/asset-preview";
import { useOpenAsset } from "../lib/open-asset";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Tooltip } from "../ui/tooltip";
import { AssetAnnotationLayer } from "./AssetAnnotationLayer";
import { AssetPreview } from "./AssetView";
import { IconBrowserTab, IconExpand, IconMessage } from "./icons";

/**
 * An asset the answer produced or named, shown in place under it, so the file
 * is looked at where it was talked about instead of behind a chip. Expand
 * lifts it over the chat, Open as tab gives it the whole view, and Annotate
 * comments on it right here.
 *
 * The box has a fixed height per kind: the transcript measures its rows, and
 * a page that grew as it loaded would move everything under it.
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
  const openTab = useAssetTabOpener(sessionId);
  const [annotating, setAnnotating] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);
  // A file deleted since: the chip-less answer should not show a broken box.
  if (files && !files.some((file) => file.path === path)) return null;
  const file = assetFileFor(path, files ?? []);
  const kind = assetPreviewKind(path);
  const name = path.split("/").pop() || path;
  const media = kind === "image" || kind === "video";
  return (
    <figure className="m-0 w-full" data-inline-asset={path}>
      <div
        className={cn(
          "relative flex flex-col overflow-hidden rounded-xl bg-panel",
          media ? "h-[360px] phone:h-[260px]" : "h-[440px] phone:h-[360px]",
        )}
      >
        <AssetPreview ref={previewRef} sessionId={sessionId} file={file} />
        {annotating && (
          <AssetAnnotationLayer
            sessionId={sessionId}
            path={path}
            preview={previewRef}
            onExit={() => setAnnotating(false)}
          />
        )}
      </div>
      {/* Under the file, never over it: a framed page takes the pointer, so
          the chat cannot reveal a control on hover there. */}
      <figcaption className="flex min-h-8 items-center gap-0.5 pl-1 text-meta text-faint">
        <span className="min-w-0 flex-1 truncate" title={path}>
          {name}
          {file.description ? ` · ${file.description}` : ""}
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
        <Tooltip label="Expand">
          <Button
            variant="ghost"
            size="sm"
            icon={<IconExpand size={16} />}
            className="phone:size-11"
            aria-label={`Expand ${name}`}
            onClick={() => asset.open(path)}
          />
        </Tooltip>
        {openTab && (
          <Tooltip label="Open as tab">
            <Button
              variant="ghost"
              size="sm"
              icon={<IconBrowserTab size={16} />}
              className="phone:size-11"
              aria-label={`Open ${name} as tab`}
              onClick={() => openTab(path)}
            />
          </Tooltip>
        )}
      </figcaption>
    </figure>
  );
}
