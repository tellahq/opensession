import type * as React from "react";
import { Button } from "../ui/button";
import { Menu } from "../ui/menu";
import { Tooltip } from "../ui/tooltip";
import {
  WS_SUMMARY_LABEL,
  WS_SUMMARY_RAIL,
  WS_SUMMARY_ROW,
} from "../lib/workspace-summary-classes";
import { cn } from "../ui/cn";
import { IconPeople, IconPlus } from "./icons";

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

/**
 * An empty section (no reviewers, no collaborators) as one row instead of a
 * heading. A lone heading reads as the label of whatever row comes next, so
 * the empty case carries its own glyph like every other row, and the whole
 * row opens the picker.
 */
export function WorkspaceSummaryAddRow({
  label,
  action,
  disabled,
  children,
}: {
  /** The section's name, shown as the row's label. */
  label: string;
  /** What the "+" does, for its accessible name. */
  action: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger
        className={WS_SUMMARY_ROW}
        disabled={disabled}
        aria-label={action}
      >
        <span className={WS_SUMMARY_RAIL}>
          <IconPeople size={20} className="text-faint" />
        </span>
        <span className={cn(WS_SUMMARY_LABEL, "text-dim")}>{label}</span>
        <IconPlus
          size={20}
          className="shrink-0 text-faint group-hover/ws:text-fg"
        />
      </Menu.Trigger>
      <Menu.Popup align="end" sideOffset={6} className="min-w-[200px]">
        {children}
      </Menu.Popup>
    </Menu.Root>
  );
}
