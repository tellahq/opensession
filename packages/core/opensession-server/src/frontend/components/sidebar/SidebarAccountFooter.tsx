import type { ReactNode } from "react";
import { SIDEBAR_HOVER_LAYER } from "../../lib/sidebar-classes";
import { usePeople } from "../../lib/people";
import { cn } from "../../ui/cn";
import { Tooltip } from "../../ui/tooltip";
import { IconGear } from "../icons";
import { UserAvatar } from "../UserAvatar";
import { useCurrentUser } from "../UserPicker";

/**
 * Desktop only: the last row of the sidebar. Who you are on the left, Settings
 * on the right, with `accessory` (the Update nudge) beside it. Phones reach
 * both through the top bar's organization menu and the Settings sheet's own
 * account card, so they carry no second copy here.
 */
export function SidebarAccountFooter({
  onOpenSettings,
  accessory,
}: {
  onOpenSettings: () => void;
  accessory?: ReactNode;
}) {
  const currentUser = useCurrentUser();
  const people = usePeople();
  const fullName =
    people.find((p) => p.name.toLowerCase() === currentUser.toLowerCase())
      ?.fullName || currentUser;

  return (
    <div className="flex flex-none items-center gap-2 border-x-0 border-b-0 border-t border-solid border-divider px-3 py-2">
      <UserAvatar name={currentUser} size={28} className="shrink-0" />
      <span
        className="min-w-0 flex-1 truncate text-label font-semibold text-fg"
        title={fullName}
      >
        {fullName}
      </span>
      {accessory}
      <Tooltip label="Settings" side="top">
        <button
          className={cn(
            "inline-flex size-[34px] shrink-0 items-center justify-center rounded-control bg-transparent text-dim hover:text-fg",
            SIDEBAR_HOVER_LAYER,
          )}
          onClick={() => onOpenSettings()}
          aria-label="Settings"
        >
          <IconGear size={22} />
        </button>
      </Tooltip>
    </div>
  );
}
