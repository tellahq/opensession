import type * as React from "react";
import { Button } from "../ui/button";
import { Menu } from "../ui/menu";
import { Tooltip } from "../ui/tooltip";
import { IconPlus } from "./icons";

/**
 * The "+" at the right end of a summary section heading (Review,
 * Collaborators). Adding someone is an action on the section, so it sits on
 * the heading rather than taking a row of its own.
 */
export function WorkspaceSummaryAdd({
  label,
  disabled,
  children,
}: {
  label: string;
  disabled?: boolean;
  /** The picker's menu items. */
  children: React.ReactNode;
}) {
  return (
    <Menu.Root>
      <Tooltip label={label}>
        <Menu.Trigger
          disabled={disabled}
          render={
            <Button
              variant="ghost"
              size="sm"
              aria-label={label}
              className="-mr-1.5 ml-auto size-6 min-h-0 p-0 text-faint hover:text-fg phone:size-11"
              icon={<IconPlus size={20} />}
            />
          }
        />
      </Tooltip>
      <Menu.Popup align="end" sideOffset={6} className="min-w-[200px]">
        {children}
      </Menu.Popup>
    </Menu.Root>
  );
}
