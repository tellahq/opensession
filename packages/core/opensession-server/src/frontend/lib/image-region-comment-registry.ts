import type { ImageRegion } from "./image-region-comment";

export interface ImageRegionCommentRequest {
  sessionId: string;
  src: string;
  region: ImageRegion;
  text: string;
}

export type ImageRegionCommentHandler = (
  request: ImageRegionCommentRequest,
) => Promise<void>;

const handlers = new Map<string, ImageRegionCommentHandler>();

/** Register the send path owned by one mounted session viewer. */
export function registerImageRegionCommentHandler(
  sessionId: string,
  handler: ImageRegionCommentHandler,
): () => void {
  handlers.set(sessionId, handler);
  return () => {
    if (handlers.get(sessionId) === handler) handlers.delete(sessionId);
  };
}

export function canCommentOnImageRegion(sessionId?: string): boolean {
  return Boolean(sessionId && handlers.has(sessionId));
}

/** Dispatch from the global lightbox back to the session that owns the image. */
export async function submitImageRegionComment(
  request: ImageRegionCommentRequest,
): Promise<void> {
  const handler = handlers.get(request.sessionId);
  if (!handler) throw new Error("That session is no longer open");
  await handler(request);
}
