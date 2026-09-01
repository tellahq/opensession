/**
 * How a session's assets are drawn: as pictures, or as rows.
 *
 * Two surfaces show the same folder, the workspace summary card and the
 * Workspace panel, and they answer to one preference so a person who reads
 * their assets as a list does not have to say so twice. Stored rather than
 * held in a component, because it is a standing choice and not a menu state:
 * it survives a reload and follows you from one session to the next, the way
 * the summary card's own open preference does.
 *
 * Preview is the default. An agent's assets are mostly captures, and a
 * capture's filename says nothing about what is in it.
 */
import { useEffect, useState } from "react";

export type AssetViewMode = "preview" | "list";

export const ASSET_VIEW_MODE_KEY = "opensession-asset-view";

/** Same-tab notification that the preference changed. `storage` only fires in
 *  the OTHER tabs, and the panel has to follow the card in this one. */
export const ASSET_VIEW_MODE_EVENT = "opensession-asset-view-changed";

export function assetViewMode(): AssetViewMode {
  return localStorage.getItem(ASSET_VIEW_MODE_KEY) === "list"
    ? "list"
    : "preview";
}

export function setAssetViewMode(mode: AssetViewMode): void {
  localStorage.setItem(ASSET_VIEW_MODE_KEY, mode);
  window.dispatchEvent(new Event(ASSET_VIEW_MODE_EVENT));
}

/** The preference, plus every route it can change by: this surface, the other
 *  one in the same window, and another tab. */
export function useAssetViewMode(): [
  AssetViewMode,
  (mode: AssetViewMode) => void,
] {
  const [mode, setMode] = useState<AssetViewMode>(assetViewMode);
  useEffect(() => {
    const sync = () => setMode(assetViewMode());
    const syncStorage = (event: StorageEvent) => {
      if (event.key === ASSET_VIEW_MODE_KEY) sync();
    };
    window.addEventListener(ASSET_VIEW_MODE_EVENT, sync);
    window.addEventListener("storage", syncStorage);
    return () => {
      window.removeEventListener(ASSET_VIEW_MODE_EVENT, sync);
      window.removeEventListener("storage", syncStorage);
    };
  }, []);
  return [mode, setAssetViewMode];
}
