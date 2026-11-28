import type React from "react";
import { useRef } from "react";
import { usePlainDirectory } from "../hooks/usePlainDirectory";
import { plainStatusIcon, plainStatusInk } from "../lib/plain-status";
import {
  SNOOZE_OPTIONS,
  priorityLabel,
  priorityTone,
  type TicketChange,
  type TicketLabel,
} from "../lib/plain-ticket";
import type { SupportThread } from "../lib/types";
import { ContextMenu, MENU_ICON, Menu } from "../ui/menu";
import {
  IconArrowUpRight,
  IconChevronRight,
  IconFlag,
  IconForbid,
  IconPerson,
  IconTag,
} from "./icons";
import { plainThreadUrl } from "./PlainThreadPanel";
import {
  PlainAssigneeItems,
  PlainLabelItems,
  PlainPriorityItems,
} from "./PlainTicketMenuItems";

/**
 * A queue row's right-click menu: the ticket bar's admin, reachable without
 * opening the ticket. A long press opens it on a phone, which has no right
 * click.
 *
 * Closing and snoozing lead, because they are what a pass through the queue
 * mostly does, and both take the ticket out of the Todo queue. Priority,
 * assignee and labels follow as submenus that show the current value, with
 * the same rows the bar's dropdowns list. Rename stays in the bar: it needs
 * the ticket open to see what you are renaming.
 */
export function SupportTicketContextMenu({
  thread,
  onChange,
  children,
}: {
  thread: SupportThread;
  onChange: (change: TicketChange) => void;
  /** The row, rendered as the trigger. */
  children: React.ComponentProps<typeof ContextMenu.Trigger>["render"];
}) {
  // A long press opens the menu while the finger is still down, and lifting
  // it can then land as a tap on the row, which would open the ticket behind
  // the menu. Swallow a click on the row while its menu is open.
  const open = useRef(false);
  return (
    <ContextMenu.Root
      onOpenChange={(next) => {
        open.current = next;
      }}
    >
      <ContextMenu.Trigger
        render={children}
        onClickCapture={(e) => {
          if (!open.current) return;
          e.preventDefault();
          e.stopPropagation();
        }}
      />
      <ContextMenu.Popup>
        <TicketMenuBody thread={thread} onChange={onChange} />
      </ContextMenu.Popup>
    </ContextMenu.Root>
  );
}

const SUB_ARROW = <IconChevronRight size={20} className="text-faint" />;

/** Mounted only while the menu is open, so a queue of a hundred rows asks
 *  Plain for its teammates and labels once someone right-clicks, not before. */
function TicketMenuBody({
  thread,
  onChange,
}: {
  thread: SupportThread;
  onChange: (change: TicketChange) => void;
}) {
  const { users, usersError, labelTypes, labelTypesError } =
    usePlainDirectory();
  const labels: TicketLabel[] = (thread.labels || []).map((l) => ({
    id: l.id,
    typeId: l.typeId,
    name: l.name,
  }));
  const DoneIcon = plainStatusIcon("DONE");
  const SnoozeIcon = plainStatusIcon("SNOOZED");
  const flagTone = priorityTone(thread.priority);
  const plainUrl = plainThreadUrl(thread.id);
  const customer =
    thread.customer.name || thread.customer.email || "this customer";

  return (
    <>
      <ContextMenu.Item
        onClick={() => onChange({ kind: "status", status: "done" })}
      >
        <DoneIcon size={20} className={plainStatusInk("DONE")} />
        <span className="grow">Mark done</span>
      </ContextMenu.Item>
      <ContextMenu.SubmenuRoot>
        <ContextMenu.SubmenuTrigger>
          <SnoozeIcon size={20} className={plainStatusInk("SNOOZED")} />
          <span className="grow">Snooze</span>
          {SUB_ARROW}
        </ContextMenu.SubmenuTrigger>
        <Menu.Popup>
          {SNOOZE_OPTIONS.map((o) => (
            <Menu.Item
              key={o.seconds}
              onClick={() =>
                onChange({
                  kind: "status",
                  status: "snoozed",
                  durationSeconds: o.seconds,
                })
              }
            >
              {o.label}
            </Menu.Item>
          ))}
        </Menu.Popup>
      </ContextMenu.SubmenuRoot>
      <ContextMenu.Separator />
      <ContextMenu.SubmenuRoot>
        <ContextMenu.SubmenuTrigger>
          <IconFlag size={20} className={flagTone ?? MENU_ICON} />
          <span className="grow">Priority</span>
          <ContextMenu.Shortcut>
            {priorityLabel(thread.priority)}
          </ContextMenu.Shortcut>
          {SUB_ARROW}
        </ContextMenu.SubmenuTrigger>
        <Menu.Popup>
          <PlainPriorityItems
            priority={thread.priority}
            onPick={(priority) => onChange({ kind: "priority", priority })}
          />
        </Menu.Popup>
      </ContextMenu.SubmenuRoot>
      <ContextMenu.SubmenuRoot>
        <ContextMenu.SubmenuTrigger>
          <IconPerson size={20} className={MENU_ICON} />
          <span className="grow">Assign</span>
          {thread.assignee && (
            <ContextMenu.Shortcut className="max-w-[120px] truncate">
              {thread.assignee.name}
            </ContextMenu.Shortcut>
          )}
          {SUB_ARROW}
        </ContextMenu.SubmenuTrigger>
        <Menu.Popup className="max-w-[280px]">
          <PlainAssigneeItems
            assigneeId={thread.assignee?.id}
            users={users}
            error={usersError}
            onPick={(userId) =>
              onChange({
                kind: "assignee",
                user: userId
                  ? {
                      id: userId,
                      name: users?.find((u) => u.id === userId)?.name ?? "",
                    }
                  : null,
              })
            }
          />
        </Menu.Popup>
      </ContextMenu.SubmenuRoot>
      <ContextMenu.SubmenuRoot>
        <ContextMenu.SubmenuTrigger>
          <IconTag size={20} className={MENU_ICON} />
          <span className="grow">Labels</span>
          {labels.length > 0 && (
            <ContextMenu.Shortcut className="max-w-[120px] truncate">
              {labels.length > 1
                ? `${labels[0].name} +${labels.length - 1}`
                : labels[0].name}
            </ContextMenu.Shortcut>
          )}
          {SUB_ARROW}
        </ContextMenu.SubmenuTrigger>
        <Menu.Popup className="max-h-[min(420px,70vh)] max-w-[280px]">
          <PlainLabelItems
            labels={labels}
            labelTypes={labelTypes}
            error={labelTypesError}
            onToggle={(labelType, existing) =>
              onChange({ kind: "label", labelType, existing })
            }
          />
        </Menu.Popup>
      </ContextMenu.SubmenuRoot>
      <ContextMenu.Separator />
      {plainUrl && (
        <ContextMenu.Item
          render={<a href={plainUrl} target="_blank" rel="noreferrer" />}
        >
          <IconArrowUpRight size={20} className={MENU_ICON} />
          <span className="grow">Open in Plain</span>
        </ContextMenu.Item>
      )}
      <ContextMenu.Item
        tone="danger"
        onClick={() => {
          if (
            window.confirm(
              `Mark ${customer} as spam?\n\nPlain filters all their threads and this one is closed right away. Reversible via “Not spam” on the ticket.`,
            )
          )
            onChange({ kind: "spam" });
        }}
      >
        <IconForbid size={20} />
        <span className="grow">Mark as spam</span>
      </ContextMenu.Item>
    </>
  );
}
