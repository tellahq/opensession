import type { ComponentProps } from "react";
import { AssetOverlay } from "../AssetView";

interface AssetOverlayIdentity {
  sessionId: string;
  path: ComponentProps<typeof AssetOverlay>["path"];
  files: ComponentProps<typeof AssetOverlay>["files"];
}

interface AssetOverlayActions {
  refresh: ComponentProps<typeof AssetOverlay>["refresh"];
  onClose: ComponentProps<typeof AssetOverlay>["onClose"];
  onSelectPath: ComponentProps<typeof AssetOverlay>["onSelectPath"];
  onOpenAsTab: ComponentProps<typeof AssetOverlay>["onOpenAsTab"];
  onOpenNewSession: ComponentProps<typeof AssetOverlay>["onOpenNewSession"];
}

interface SessionViewerAssetOverlayProps {
  asset: AssetOverlayIdentity;
  actions: AssetOverlayActions;
}

export function SessionViewerAssetOverlay({
  asset,
  actions,
}: SessionViewerAssetOverlayProps) {
  return (
    <>
      {/* Portals to the body, so it sits over the whole viewer rather than
          inside whichever column opened it. */}
      <AssetOverlay
        sessionId={asset.sessionId}
        path={asset.path}
        files={asset.files}
        refresh={actions.refresh}
        onClose={actions.onClose}
        onSelectPath={actions.onSelectPath}
        onOpenAsTab={actions.onOpenAsTab}
        onOpenNewSession={actions.onOpenNewSession}
      />
    </>
  );
}
