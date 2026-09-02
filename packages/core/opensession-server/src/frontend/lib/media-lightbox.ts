import type { WorkspaceMediaItem } from "./api";
import type { DiagramMedia } from "./diagram-media";
import type { ImageRegion } from "./image-region-comment";
import type { WalkthroughMediaLabel } from "./walkthrough-label";

export interface ImageRegionAnnotation {
  id: string;
  region: ImageRegion;
  text: string;
}

export interface LightboxItem {
  kind: "image" | "video" | "diagram";
  src: string;
  /** kind "diagram" only: the live SVG to draw, so that zooming a chart to
   * read its labels keeps them sharp instead of magnifying pixels. `src` is
   * the same diagram as a file, which is all Download needs, and being a
   * data: URL, it also opts the link actions out. */
  diagram?: DiagramMedia;
  walkthroughLabel?: WalkthroughMediaLabel;
  sessionTitle?: string;
  description?: string;
  at?: string;
  /** Session that owns this transcript image. Only these images can send a
   * selected region back into chat. */
  commentSessionId?: string;
  /** Existing composer annotations, parsed from the draft that owns this image. */
  regionAnnotations?: ImageRegionAnnotation[];
  /** Composer attachments add or edit the comment in the draft instead of
   * sending a new turn immediately. `keepOpen` is Shift+Enter's add-another path. */
  onRegionComment?: (request: {
    region: ImageRegion;
    text: string;
    keepOpen: boolean;
    existing?: ImageRegionAnnotation;
  }) => void | Promise<void>;
  onDeleteRegionComment?: (
    annotation: ImageRegionAnnotation,
  ) => void | Promise<void>;
}

export interface LightboxState {
  items: LightboxItem[];
  index: number;
  id: number;
  origin?: HTMLElement;
  originIndex: number;
  useHeroTransition: boolean;
  startCommenting?: boolean;
}

export interface LightboxRequest {
  items: LightboxItem[];
  index: number;
  origin?: HTMLElement;
  /** Enter image-region comment mode as soon as the lightbox opens. */
  startCommenting?: boolean;
}

export interface ViewTransitionHandle {
  finished: Promise<void>;
  skipTransition(): void;
}

/** `focusVisible` is honoured by Chromium/Firefox but not yet in TypeScript's
 * DOM lib. Browsers without it fall back to their own heuristic. */
export type FocusOptionsWithVisible = FocusOptions & { focusVisible?: boolean };

export type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => ViewTransitionHandle;
};

export const HERO_TRANSITION_NAME = "lightbox-media";

export const LIGHTBOX_TRANSITION_CSS = `
html[data-lightbox-transition="opening"]::view-transition-old(root),
html[data-lightbox-transition="closing"]::view-transition-new(root) {
  animation: none;
}

html[data-lightbox-transition="opening"]::view-transition-new(root) {
  animation: lightbox-root-in var(--dur) var(--ease) both;
}

/* Exit is a tier faster than the enter: opening is the deliberate act and can
   take its time, closing is the system getting out of the way. */
html[data-lightbox-transition="closing"]::view-transition-old(root) {
  animation: lightbox-root-out var(--dur-micro) var(--ease) both;
}

::view-transition-group(${HERO_TRANSITION_NAME}) {
  z-index: 11001;
  animation-duration: var(--dur-lg);
  animation-timing-function: var(--ease);
}

::view-transition-old(${HERO_TRANSITION_NAME}),
::view-transition-new(${HERO_TRANSITION_NAME}) {
  mix-blend-mode: normal;
}

@keyframes lightbox-root-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes lightbox-root-out {
  from { opacity: 1; }
  to { opacity: 0; }
}
`;

let nextLightboxId = 0;
let host: ((request: LightboxRequest) => void) | null = null;

export function mediaElement(origin?: Element | null): HTMLElement | undefined {
  if (!(origin instanceof HTMLElement)) return undefined;
  if (origin.matches("img, video")) return origin;
  return origin.querySelector<HTMLElement>("img, video") || origin;
}

export function canMorphFrom(origin?: HTMLElement): origin is HTMLElement {
  if (!origin?.isConnected) return false;
  const rect = origin.getBoundingClientRect();
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.right > 0 &&
    rect.bottom > 0 &&
    rect.left < window.innerWidth &&
    rect.top < window.innerHeight
  );
}

export function setTransitionName(
  element: HTMLElement,
  name: string,
): () => void {
  const previous = element.style.viewTransitionName;
  let restored = false;
  element.style.viewTransitionName = name;
  return () => {
    if (restored) return;
    restored = true;
    element.style.viewTransitionName = previous;
  };
}

export function markTransition(
  phase: "opening" | "closing",
  id: number,
): () => void {
  const root = document.documentElement;
  const token = String(id);
  root.dataset.lightboxTransition = phase;
  root.dataset.lightboxTransitionId = token;
  return () => {
    if (root.dataset.lightboxTransitionId !== token) return;
    delete root.dataset.lightboxTransition;
    delete root.dataset.lightboxTransitionId;
  };
}

export function supportsHeroTransition(): boolean {
  return (
    "startViewTransition" in document &&
    document.startViewTransition instanceof Function &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function commentSessionIdFor(
  element?: Element | null,
): string | undefined {
  return element?.closest<HTMLElement>("[data-lightbox-session-id]")?.dataset
    .lightboxSessionId;
}

export function nextMediaLightboxId(): number {
  nextLightboxId += 1;
  return nextLightboxId;
}

export function registerMediaLightboxHost(
  open: (request: LightboxRequest) => void,
): () => void {
  host = open;
  return () => {
    if (host === open) host = null;
  };
}

export function openLightbox(
  items: (LightboxItem | WorkspaceMediaItem)[],
  index: number,
  origin?: Element | null,
  options: { startCommenting?: boolean } = {},
) {
  const source = mediaElement(origin);
  const fromDom = commentSessionIdFor(source);
  host?.({
    items: items.map((item) => {
      if (item.kind !== "image") return item;
      const commentSessionId =
        ("commentSessionId" in item ? item.commentSessionId : undefined) ||
        ("sessionId" in item ? item.sessionId : undefined) ||
        fromDom;
      return commentSessionId ? { ...item, commentSessionId } : item;
    }),
    index,
    origin: source,
    startCommenting: options.startCommenting,
  });
}

function extFromMime(mime: string): string {
  const sub = mime.split("/")[1]?.split(";")[0] || "";
  const special = new Map<string, string>([
    ["jpeg", "jpg"],
    ["svg+xml", "svg"],
    ["quicktime", "mov"],
    ["x-matroska", "mkv"],
  ]);
  return special.get(sub) || sub || "bin";
}

export function suggestedMediaName(item: LightboxItem): string {
  if (!item.src.startsWith("data:") && !item.src.startsWith("blob:")) {
    try {
      const url = new URL(item.src, location.href);
      const from = url.searchParams.get("path") || url.pathname;
      const base = decodeURIComponent(from.split("/").pop() || "");
      if (/\.[a-z0-9]{2,5}$/i.test(base)) return base;
    } catch {}
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const mime = /^data:([^;,]+)/.exec(item.src)?.[1];
  const ext = mime ? extFromMime(mime) : item.kind === "video" ? "mp4" : "png";
  return `${item.kind}-${stamp}.${ext}`;
}

/**
 * Where Download points. It is a real link, not a fetch-to-blob-to-ObjectURL
 * dance. `?download=1` asks our own routes for an attachment disposition. Do
 * not also put the `download` attribute on server-backed links: installed iOS
 * PWAs route those through their preview controller instead of the browser's
 * attachment handling.
 */
export function mediaDownloadHref(item: LightboxItem): string {
  if (item.src.startsWith("data:") || item.src.startsWith("blob:")) {
    return item.src;
  }
  try {
    const url = new URL(item.src, location.href);
    if (url.origin === location.origin) url.searchParams.set("download", "1");
    return url.href;
  } catch {
    return item.src;
  }
}

/** The item's own absolute URL for pasting outside the app. */
export function shareableMediaSrc(item: LightboxItem): string {
  try {
    return new URL(item.src, location.href).href;
  } catch {
    return item.src;
  }
}
