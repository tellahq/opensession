import { useState } from "react";
import type { PortalTarget } from "../lib/portals";
import { Button } from "../ui/button";
import { PageLoader } from "../ui/page-loader";
import {
  IconArrowUpRight,
  IconExpand,
  IconGlobe,
  IconRestore,
  IconX,
} from "./icons";

/** Browser-like pane for one service exposed by a session portal. */
export function PortalPane({
  target,
  onExpand,
  onClose,
}: {
  target: PortalTarget;
  onExpand?: () => void;
  onClose?: () => void;
}) {
  const [reloadNonce, setReloadNonce] = useState(0);
  const [loading, setLoading] = useState(true);

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="flex min-h-11 items-center gap-2 border-b border-divider px-3 py-1.5">
        <span
          className="h-2 w-2 shrink-0 rounded-full bg-green"
          aria-hidden="true"
        />
        <div
          className="flex min-w-0 flex-1 items-center gap-2 rounded-control border border-line bg-surface px-3 py-1.5 text-supporting text-dim"
          title={target.url}
        >
          <IconGlobe size={14} className="shrink-0 opacity-60" />
          <span className="truncate">{target.url}</span>
        </div>
        <Button
          variant="ghost"
          size="md"
          icon={<IconRestore size={16} />}
          onClick={() => {
            setLoading(true);
            setReloadNonce((nonce) => nonce + 1);
          }}
          aria-label={`Reload ${target.name}`}
          title="Reload portal"
        />
        {onExpand ? (
          <Button
            variant="ghost"
            size="md"
            icon={<IconExpand size={16} />}
            onClick={onExpand}
            aria-label={`Expand ${target.name} to full width`}
            title="Expand to full width"
          />
        ) : null}
        <Button
          variant="ghost"
          size="md"
          icon={<IconArrowUpRight size={16} />}
          onClick={() =>
            window.open(
              target.url,
              `portal-${target.sessionId}-${target.key}`,
              "noopener",
            )
          }
          aria-label={`Open ${target.name} in a separate browser window`}
          title="Open in browser"
        />
        {onClose ? (
          <Button
            variant="ghost"
            size="md"
            icon={<IconX size={16} />}
            onClick={onClose}
            aria-label={`Close ${target.name} side panel`}
            title="Close side panel"
          />
        ) : null}
      </div>
      <div className="relative min-h-0 flex-1 bg-white">
        {loading ? (
          <div
            role="status"
            aria-label={`Loading ${target.name}`}
            className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-panel"
          >
            <PageLoader className="text-dim" />
          </div>
        ) : null}
        <iframe
          key={`${target.url}#${reloadNonce}`}
          className="block h-full w-full border-0 bg-white"
          src={target.url}
          title={`${target.name} portal`}
          onLoad={() => setLoading(false)}
          allow="clipboard-read; clipboard-write; fullscreen"
          sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads"
        />
      </div>
    </div>
  );
}
