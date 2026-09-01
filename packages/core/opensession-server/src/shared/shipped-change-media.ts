import type { TranscriptEntry } from "@tellahq/opensession-protocol";

const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp)$/i;

export function localScreenshotPath(src: string): string | undefined {
  if (src.startsWith("/media?")) {
    const path =
      new URL(src, "http://localhost").searchParams.get("path") || "";
    return path.startsWith("/") && IMAGE_EXT_RE.test(path) ? path : undefined;
  }
  return src.startsWith("/") && IMAGE_EXT_RE.test(src) ? src : undefined;
}

export function latestFeaturedScreenshot(
  entries: Pick<TranscriptEntry, "featuredMedia">[],
): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const media = entries[i]?.featuredMedia || [];
    for (let j = media.length - 1; j >= 0; j--) {
      const path = localScreenshotPath(media[j]!);
      if (path) return path;
    }
  }
  return undefined;
}
