import type { PortalTarget } from "../lib/portals";
import { Button } from "../ui/button";
import { BrowserPane } from "./BrowserPane";
import { IconExpand, IconPin, IconX } from "./icons";

/** Browser-like pane for one service exposed by a session portal. */
export function PortalPane({
  target,
  onExpand,
  onPin,
  onClose,
  keepAliveKey,
}: {
  target: PortalTarget;
  keepAliveKey?: string;
  onExpand?: () => void;
  /** Move this page into the side panel, beside the conversation. */
  onPin?: () => void;
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
      sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads"
      leading={
        <span
          className="mr-1 h-2 w-2 shrink-0 rounded-full bg-green"
          aria-hidden="true"
        />
      }
      actions={
        <>
          {onPin ? (
            <Button
              variant="ghost"
              size="md"
              icon={<IconPin size={16} />}
              onClick={onPin}
              aria-label={`Pin ${target.name} beside the conversation`}
              title="Pin beside conversation"
            />
          ) : null}
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
        </>
      }
    />
  );
}
