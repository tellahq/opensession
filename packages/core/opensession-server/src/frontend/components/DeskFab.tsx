import { useDeskFabPosition } from "../hooks/useDeskFabPosition";
import { DESK_FAB } from "../lib/fab-classes";
import { PulseDot } from "../ui/status";
import { Tooltip } from "../ui/tooltip";
import { IconDesk } from "./icons";

/**
 * The Desk trigger. It owns its measured position: the position moves on
 * every step of a window resize or pane drag, and held in the app root it
 * re-rendered the sidebar and the open session each time.
 */
export function DeskFab({
  placed,
  layoutKey,
  callShown,
  onOpen,
}: {
  /** Measure a place beside the composer (desktop, a session in front). */
  placed: boolean;
  /** Changes when the composer columns are swapped or resplit. */
  layoutKey: string;
  callShown: boolean;
  onOpen: () => void;
}) {
  const position = useDeskFabPosition(placed, layoutKey);
  return (
    <Tooltip
      label={callShown ? "Desk call in progress" : "Desk"}
      side="left"
      shortcut={["⌘", "J"]}
    >
      <button
        className={DESK_FAB}
        style={
          position
            ? { left: position.left, right: "auto", bottom: position.bottom }
            : undefined
        }
        onClick={onOpen}
        aria-label={
          callShown ? "Desk call in progress. Open the Desk" : "Open the Desk"
        }
      >
        <IconDesk size={24} />
        {/* The call keeps running behind a minimised Desk; the dot says so
            until the call ends or Desk is back up. */}
        {callShown && (
          <PulseDot className="absolute top-0 right-0 ring-2 ring-[var(--composer-surface)]" />
        )}
      </button>
    </Tooltip>
  );
}
