import { keptFrameKey, type KeptFrameSpec } from "./kept-frames";
import type { PanelBrowserTarget } from "./portal-pin";
import { LINK_FRAME, PREVIEW_FRAME } from "./preview-url";

/** The page a session's side panel Browser tab keeps loaded. */
export interface PanelBrowserFrame {
  key: string;
  spec: KeptFrameSpec;
}

/**
 * The kept page behind a session's side panel Browser tab: a link handed to
 * it, else the PR's preview deployment. A Portal is not kept, and a preview
 * that refuses framing shows an Open link instead of a page, so neither has
 * one.
 */
export function panelBrowserFrame({
  sessionId,
  target,
  staging,
  stagingUrl,
}: {
  sessionId: string;
  target: PanelBrowserTarget | null;
  staging: { embeddable?: boolean } | null;
  stagingUrl: string | null | undefined;
}): PanelBrowserFrame | null {
  const key = keptFrameKey("panel", sessionId);
  if (target?.kind === "url")
    return { key, spec: { ...LINK_FRAME, url: target.url } };
  if (target?.kind === "portal" || !stagingUrl || !staging?.embeddable)
    return null;
  return { key, spec: { ...PREVIEW_FRAME, url: stagingUrl } };
}
