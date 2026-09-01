import type { UnifiedSession, Workspace } from "../../lib/types";
import { isClaimed, ownedBy, pinnedLane } from "../../lib/sidebar-lanes";
import { togglePin } from "../../lib/pins";
import { markRead, markUnread } from "../../lib/reads";
import {
  absoluteLink,
  copyToClipboard,
  sessionPath,
} from "../../lib/share-link";
import { shortcutLabel } from "../../lib/shortcuts";
import type { CtxEntry, Props, WsRow } from "../../lib/sidebar-types";
import {
  IconArchive,
  IconEye,
  IconEyeOff,
  IconInbox,
  IconLink,
  IconMail,
  IconPencil,
  IconPin,
  IconTrash,
} from "../icons";
import { SidebarCtxMenu } from "./SidebarCtxMenu";

export interface WorkspaceMenuTarget {
  id: string;
  x: number;
  y: number;
  source: HTMLButtonElement;
}

interface WorkspaceContextMenuProps {
  menu: WorkspaceMenuTarget;
  workspace?: Workspace;
  row?: WsRow;
  pins: string[];
  currentUser: string;
  activeSnoozeKeys: Set<string>;
  snoozes: Record<string, string>;
  hiddenRowKeys: Set<string>;
  onPinsChange: (pins: string[]) => void;
  onSetStatus: Props["onSetStatus"];
  onSnooze: (row: WsRow, until: string | null) => void;
  onStartWorkspaceRename: (workspace: Workspace) => void;
  onStartSessionRename: (session: UnifiedSession) => void;
  onToast?: (message: string) => void;
  onOpenReview: (session: UnifiedSession) => void;
  onHide: (row: WsRow, hidden: boolean) => void;
  onArchive: (row: WsRow, source: HTMLButtonElement) => void;
  onDeleteDraft: (workspace: Workspace) => void;
  onClose: () => void;
}

export function WorkspaceContextMenu({
  menu,
  workspace,
  row,
  pins,
  currentUser,
  activeSnoozeKeys,
  snoozes,
  hiddenRowKeys,
  onPinsChange,
  onSetStatus,
  onSnooze,
  onStartWorkspaceRename,
  onStartSessionRename,
  onToast,
  onOpenReview,
  onHide,
  onArchive,
  onDeleteDraft,
  onClose,
}: WorkspaceContextMenuProps) {
  const sessions = row?.sessions ?? [];
  const first = sessions[0];
  const pinKey = workspace ? `workspace:${workspace.id}` : menu.id;
  const pinnedKeys = [
    pinKey,
    ...(row
      ? [
          row.key,
          ...row.sessions.flatMap((session) => [
            session.id,
            ...(session.aliasIds || []),
          ]),
        ]
      : []),
  ].filter(
    (key, index, all) => pins.includes(key) && all.indexOf(key) === index,
  );
  const pinned = pinnedKeys.length > 0;
  const togglePinNow = () => {
    if (!pinned) {
      onPinsChange(togglePin(pinKey));
      return;
    }
    let next = pins;
    for (const key of pinnedKeys) next = togglePin(key);
    onPinsChange(next);
  };
  const anyManual = sessions.some((session) => pinnedLane(session));
  const sharedManual =
    first &&
    anyManual &&
    sessions.every((session) => pinnedLane(session) === pinnedLane(first))
      ? (pinnedLane(first) ?? null)
      : null;
  const entries: CtxEntry[] = [];
  const rowUnread = row?.unread ?? false;

  if (sessions.length > 0) {
    entries.push({
      kind: "item",
      icon: <IconMail size={20} />,
      label: rowUnread ? "Mark as read" : "Mark as unread",
      onClick: () =>
        sessions.forEach((session) =>
          rowUnread
            ? markRead(session.id, session.lastActivity)
            : markUnread(session.id),
        ),
    });
  }

  const rowClaimed = sessions.some((session) => isClaimed(session));
  const rowNaturallyInSidebar = sessions.some(
    (session) =>
      !session.spawnedBy &&
      !session.automation &&
      ownedBy(session, currentUser),
  );
  if (sessions.length > 0 && (!rowNaturallyInSidebar || rowClaimed)) {
    entries.push({
      kind: "item",
      icon: <IconInbox size={20} />,
      label: rowClaimed ? "Stop keeping in sidebar" : "Keep in sidebar",
      onClick: () => onSetStatus(sessions, rowClaimed ? null : "mine"),
    });
  }

  entries.push({
    kind: "item",
    icon: <IconPin size={20} fill={pinned ? "currentColor" : "none"} />,
    label: pinned ? "Unpin" : "Pin",
    onClick: togglePinNow,
  });
  if (sessions.length > 0) {
    entries.push({
      kind: "status",
      current: sharedManual,
      onPick: (status) => onSetStatus(sessions, status),
    });
  }
  if (row && sessions.length > 0) {
    entries.push({
      kind: "snooze",
      until: activeSnoozeKeys.has(row.key) ? (snoozes[row.key] ?? null) : null,
      onPick: (until) => onSnooze(row, until),
    });
  }

  if (workspace) {
    entries.push({
      kind: "item",
      icon: <IconPencil size={20} />,
      label: "Rename",
      onClick: () => onStartWorkspaceRename(workspace),
    });
  } else if (first) {
    entries.push({
      kind: "item",
      icon: <IconPencil size={20} />,
      label: "Rename",
      onClick: () => onStartSessionRename(first),
    });
  }
  if (first) {
    entries.push({
      kind: "item",
      icon: <IconLink size={20} />,
      label: "Copy link",
      shortcut: shortcutLabel("session-copy-link") ?? undefined,
      onClick: () =>
        copyToClipboard(absoluteLink(sessionPath(first)), () =>
          onToast?.("Link copied"),
        ),
    });
  }
  if (first && (first.worktreeDir || first.branch)) {
    entries.push({
      kind: "item",
      icon: <IconEye size={20} />,
      label: "Open review",
      onClick: () => onOpenReview(first),
    });
  }

  if (row && sessions.length > 0) {
    entries.push({ kind: "sep" });
    const hidden = hiddenRowKeys.has(row.key);
    entries.push({
      kind: "item",
      icon: hidden ? <IconEye size={20} /> : <IconEyeOff size={20} />,
      label: hidden ? "Restore to my sidebar" : "Hide from my sidebar",
      onClick: () => onHide(row, hidden),
    });
    entries.push({
      kind: "item",
      icon: <IconArchive size={20} />,
      label: "Archive",
      onClick: () => onArchive(row, menu.source),
    });
  } else if (workspace) {
    entries.push({ kind: "sep" });
    entries.push({
      kind: "item",
      icon: <IconTrash size={20} />,
      danger: true,
      label: "Delete draft",
      onClick: () => onDeleteDraft(workspace),
    });
  }

  return (
    <SidebarCtxMenu x={menu.x} y={menu.y} entries={entries} onClose={onClose} />
  );
}
