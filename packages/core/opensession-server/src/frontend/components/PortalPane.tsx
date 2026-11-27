import type { PortalTarget } from "../lib/portals";
import { Button } from "../ui/button";
import { BrowserPane } from "./BrowserPane";
import { IconExpand, IconX } from "./icons";

/** Browser-like pane for one service exposed by a session portal. */
export function PortalPane({
  target,
  onExpand,
  onClose,
  keepAliveKey,
  commentSessionId,
}: {
  target: PortalTarget;
  keepAliveKey?: string;
  /** Where a comment on the page goes; enables Annotate. */
  commentSessionId?: string;
  onExpand?: () => void;
  onClose?: () => void;
}) {
  return (
    <BrowserPane
      url={target.url}
      name={target.name}
      frameTitle={`${target.name} portal`}
      openWindowName={`portal-${target.sessionId}-${target.key}`}
      allow="clipboard-read; clipboard-write; fullscreen"
      keepAliveKey={keepAliveKey}
      commentSessionId={commentSessionId}
      sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads"
      leading={
        <span
          className="mr-1 h-2 w-2 shrink-0 rounded-full bg-green"
          aria-hidden="true"
        />
      }
      actions={
        <>
          {onExpand ? (
            <Button
              variant="ghost"
              size="md"
              className="rounded-control"
              icon={<IconExpand size={20} />}
              onClick={onExpand}
              aria-label={`Expand ${target.name} to full width`}
              title="Expand to full width"
            />
          ) : null}
          {onClose ? (
            <Button
              variant="ghost"
              size="md"
              className="rounded-control"
              icon={<IconX size={20} />}
              onClick={onClose}
              aria-label={`Close ${target.name} side panel`}
              title="Close side panel"
            />
          ) : null}
        </>
      }
    />
  );
}
