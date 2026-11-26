import type { PlainLabelType, PlainWorkspaceUser } from "../lib/types";
import { SUPPORT_PRIORITY_GROUPS } from "../lib/sidebar-filter";
import {
  STATUS_LABEL,
  plainStatusIcon,
  plainStatusInk,
} from "../lib/plain-status";
import {
  SNOOZE_OPTIONS,
  type PlainStatusChoice,
  type TicketLabel,
} from "../lib/plain-ticket";
import { cn } from "../ui/cn";
import { Menu } from "../ui/menu";
import { IconFlag } from "./icons";
import { UserAvatar } from "./UserAvatar";

/**
 * The rows of a Plain ticket's admin menus. The ticket bar's dropdowns and
 * the queue's right-click submenus render these same parts, so a status or a
 * priority reads the same wherever it is changed. They are Menu parts, which
 * a ContextMenu shares (Base UI builds both on one primitive).
 */

const LOADER_ROW = "max-w-[240px] px-2.5 py-1.5 text-label leading-snug";

/** Todo and Done, then how long to snooze for. Each status row leads with the
 *  glyph and colour its badge wears, so the menu teaches the badge. */
export function PlainStatusItems({
  status,
  onPick,
}: {
  status: string | null | undefined;
  onPick: (status: PlainStatusChoice, durationSeconds?: number) => void;
}) {
  const current = status?.toUpperCase();
  return (
    <>
      {(["TODO", "DONE"] as const).map((s) => {
        const Icon = plainStatusIcon(s);
        return (
          <Menu.Item
            key={s}
            onClick={() => onPick(s === "TODO" ? "todo" : "done")}
          >
            <Icon size={20} className={plainStatusInk(s)} />
            <span className="min-w-0 flex-1">{STATUS_LABEL[s]}</span>
            <Menu.Check on={current === s} />
          </Menu.Item>
        );
      })}
      <Menu.Separator />
      <Menu.Group>
        <Menu.GroupLabel className="flex items-center gap-2 px-2">
          {(() => {
            const Icon = plainStatusIcon("SNOOZED");
            return <Icon size={20} className={plainStatusInk("SNOOZED")} />;
          })()}
          Snooze for
        </Menu.GroupLabel>
        {SNOOZE_OPTIONS.map((o) => (
          <Menu.Item
            key={o.seconds}
            onClick={() => onPick("snoozed", o.seconds)}
          >
            <span className="size-5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">{o.label}</span>
          </Menu.Item>
        ))}
      </Menu.Group>
    </>
  );
}

/** Urgent to Low, each flag in its queue lane's colour. */
export function PlainPriorityItems({
  priority,
  onPick,
}: {
  priority: number | null | undefined;
  onPick: (priority: number) => void;
}) {
  return (
    <>
      {SUPPORT_PRIORITY_GROUPS.map((g) => (
        <Menu.Item key={g.p} onClick={() => onPick(g.p)}>
          <IconFlag size={20} className={g.cls} />
          <span className="min-w-0 flex-1">{g.label}</span>
          <Menu.Check on={priority === g.p} />
        </Menu.Item>
      ))}
    </>
  );
}

export function PlainAssigneeItems({
  assigneeId,
  users,
  error,
  onPick,
}: {
  assigneeId: string | null | undefined;
  users: PlainWorkspaceUser[] | null;
  error: string | null;
  /** null unassigns. */
  onPick: (userId: string | null) => void;
}) {
  if (error)
    return (
      <div role="alert" className={cn(LOADER_ROW, "text-red")}>
        {error}
      </div>
    );
  if (!users)
    return <div className={cn(LOADER_ROW, "text-faint")}>Loading…</div>;
  return (
    <>
      {users.map((u) => (
        <Menu.Item key={u.id} onClick={() => onPick(u.id)}>
          <UserAvatar name={u.name} size={18} />
          <span className="min-w-0 flex-1 truncate">{u.name}</span>
          <Menu.Check on={assigneeId === u.id} />
        </Menu.Item>
      ))}
      {assigneeId && (
        <>
          <Menu.Separator />
          <Menu.Item onClick={() => onPick(null)}>
            <span className="size-[18px] shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">Unassign</span>
          </Menu.Item>
        </>
      )}
    </>
  );
}

/** Every label kind, ticked when the ticket carries it. Toggling leaves the
 *  menu open, since a ticket often takes more than one. */
export function PlainLabelItems({
  labels,
  labelTypes,
  error,
  onToggle,
}: {
  labels: TicketLabel[];
  labelTypes: PlainLabelType[] | null;
  error: string | null;
  /** `existing` is the label to remove, or undefined to add the kind. */
  onToggle: (
    labelType: PlainLabelType,
    existing: TicketLabel | undefined,
  ) => void;
}) {
  if (error)
    return (
      <div role="alert" className={cn(LOADER_ROW, "text-red")}>
        {error}
      </div>
    );
  if (!labelTypes)
    return <div className={cn(LOADER_ROW, "text-faint")}>Loading…</div>;
  if (labelTypes.length === 0)
    return (
      <div className={cn(LOADER_ROW, "text-faint")}>No labels in Plain</div>
    );
  return (
    <>
      {labelTypes.map((lt) => {
        const existing = labels.find((l) => l.typeId === lt.id);
        return (
          <Menu.CheckboxItem
            key={lt.id}
            checked={!!existing}
            closeOnClick={false}
            onClick={() => onToggle(lt, existing)}
          >
            <span className="min-w-0 flex-1">{lt.name}</span>
            <Menu.Check on={!!existing} className="ml-auto" />
          </Menu.CheckboxItem>
        );
      })}
    </>
  );
}
