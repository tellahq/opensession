import { keptFrameKey, type KeptFrameSpec } from "./kept-frames";
import type { PanelBrowserTarget } from "./portal-pin";
import { sidePanelKey } from "./side-panel-store";
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
  const key = keptFrameKey("panel", sidePanelKey(sessionId));
  if (target?.kind === "url")
    return { key, spec: { ...LINK_FRAME, url: target.url } };
  if (target?.kind === "portal" || !stagingUrl || !staging?.embeddable)
    return null;
  return { key, spec: { ...PREVIEW_FRAME, url: stagingUrl } };
}

/**
 * The page the workspace summary card previews, or null. It is the kept page
 * of the Browser tab, wherever that tab lives, and only while the tab is not
 * on screen.
 *
 * Without the auto-open preference the card previews only a side panel
 * Browser tab that is already in the strip. With it, a ready preview deploy
 * is previewed even with no tab: one the person closed, or one the main strip
 * keeps when Browser opens there.
 */
export function summaryBrowserFrame({
  dock,
  showing,
  hasPanelTab,
  autoOpen,
  scope,
  ...page
}: Parameters<typeof panelBrowserFrame>[0] & {
  /** Where Browser opens: the side panel or the main tab strip. */
  dock: "panel" | "main";
  /** Its tab is the one on screen. */
  showing: boolean;
  hasPanelTab: boolean;
  autoOpen: boolean;
  /** The main strip's workspace scope (viewTabScope), if known. */
  scope: string | null;
}): PanelBrowserFrame | null {
  if (showing) return null;
  if (dock === "panel")
    return hasPanelTab || autoOpen ? panelBrowserFrame(page) : null;
  const { staging, stagingUrl } = page;
  if (!autoOpen || !scope || !stagingUrl || !staging?.embeddable) return null;
  return {
    key: keptFrameKey("staging", scope),
    spec: { ...PREVIEW_FRAME, url: stagingUrl },
  };
}
