import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { Tooltip } from "../../ui/tooltip";
import { IconSidebarRight } from "../icons";

/**
 * The side panel's open/close button. The header shows it while the panel is
 * closed; the panel's own top row shows it while open (`inPanel`), so it stays
 * in the window's top-right corner instead of following the main area's edge.
 */
export function SidePanelToggle({
  onClick,
  inPanel = false,
}: {
  onClick: () => void;
  inPanel?: boolean;
}) {
  return (
    <Tooltip label="Toggle side panel">
      <Button
        variant="ghost"
        size="md"
        // Passed as `icon` (not children) so the primitive keeps its 32px
        // icon-only square, the size of the ⋯ and share buttons beside it.
        className={cn(
          "rounded-control text-dim hover:bg-hover hover:text-fg",
          // Land on the header's spot: its actions end 18px from the edge,
          // the strip's px-2 gives 8, and the strip's bottom border pulls
          // centered content half a pixel up.
          inPanel && "mr-2.5 mt-px shrink-0",
        )}
        onClick={onClick}
        aria-label="Toggle side panel"
        icon={<IconSidebarRight size={22} />}
      />
    </Tooltip>
  );
}
