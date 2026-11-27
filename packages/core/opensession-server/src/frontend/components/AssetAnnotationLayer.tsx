import type { RefObject } from "react";
import {
  captureMarkedImage,
  inspectAssetPreview,
  scrollAssetPreview,
} from "../lib/asset-annotation";
import { sessionAssetRawUrl } from "../lib/api";
import { assetPreviewKind } from "../lib/asset-preview";
import { captureMarkedFrame } from "../lib/browser-annotation-capture";
import { BrowserAnnotationLayer } from "./BrowserAnnotationLayer";

/**
 * Annotate mode over an asset preview, wherever the preview is: inline in the
 * chat, in the overlay, or in the Assets tab. The comment goes to the chat
 * naming the file and where on it, with the marked picture when there is one.
 */
export function AssetAnnotationLayer({
  sessionId,
  path,
  preview,
  onExit,
}: {
  sessionId: string;
  path: string;
  /** The preview's scrolling root, which the layer sits over. */
  preview: RefObject<HTMLDivElement | null>;
  onExit: () => void;
}) {
  const image = assetPreviewKind(path) === "image";
  return (
    <BrowserAnnotationLayer
      sessionId={sessionId}
      url={sessionAssetRawUrl(sessionId, path)}
      asset={path}
      hint={
        image ? "Click or drag an area" : "Click an element or drag an area"
      }
      inspect={(layer, point) =>
        inspectAssetPreview(preview.current, layer, point)
      }
      capture={(layer, box) =>
        image
          ? captureMarkedImage(preview.current, layer, box)
          : captureMarkedFrame(layer, box)
      }
      scrollBy={(dx, dy) => scrollAssetPreview(preview.current, dx, dy)}
      onExit={onExit}
    />
  );
}
