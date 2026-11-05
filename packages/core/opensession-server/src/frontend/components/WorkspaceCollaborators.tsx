import { useState } from "react";
import {
  addWorkspaceCollaboratorApi,
  removeWorkspaceCollaboratorApi,
} from "../lib/api";
import { errorMessage } from "../lib/error-message";
import { usePeople } from "../lib/people";
import {
  GIT_ACTION_CARET,
  gitActionClass,
  GIT_LABEL,
  GIT_ROW,
} from "../lib/pr-tone-classes";
import {
  INFO_LABEL_CLASS,
  INFO_LIST_CLASS,
  INFO_SECTION_CLASS,
} from "../lib/session-viewer-classes";
import {
  publishWorkspaceRecord,
  useWorkspaceRecord,
} from "../lib/workspace-records";
import { cn } from "../ui/cn";
import { Menu, MENU_ICON } from "../ui/menu";
import { IconChevronDown, IconChevronRight, IconPeople } from "./icons";
import { UserAvatar } from "./UserAvatar";
import { getCurrentUser, TEAM } from "./UserPicker";

/**
 * Add/remove state for a workspace's collaborators, shared by the info
 * panel's row and the session header's ⋯ menu. Null when there is no
 * workspace record or nobody to add.
 */
export function useWorkspaceCollaborators(
  workspaceId: string | null,
  sessionId?: string,
) {
  // The roster arrives async; TEAM below reads it.
  usePeople();
  const workspace = useWorkspaceRecord(workspaceId);
  const [error, setError] = useState<string | null>(null);
  if (!workspace) return null;

  const collaborators = workspace.collaborators || [];
  const names = new Set(collaborators.map((c) => c.name.toLowerCase()));
  const creator = workspace.createdBy.toLowerCase();
  const candidates = TEAM.filter((name) => name.toLowerCase() !== creator);
  if (!candidates.length && !collaborators.length) return null;

  function toggle(name: string) {
    if (!workspace) return;
    const on = names.has(name.toLowerCase());
    const optimistic = on
      ? collaborators.filter((c) => c.name.toLowerCase() !== name.toLowerCase())
      : [
          ...collaborators,
          { name, by: getCurrentUser(), at: new Date().toISOString() },
        ];
    const previous = workspace;
    setError(null);
    publishWorkspaceRecord({ ...workspace, collaborators: optimistic });
    const request = on
      ? removeWorkspaceCollaboratorApi(workspace.id, name)
      : addWorkspaceCollaboratorApi(
          workspace.id,
          name,
          getCurrentUser(),
          sessionId || undefined,
        );
    request.then(publishWorkspaceRecord).catch((cause: unknown) => {
      publishWorkspaceRecord(previous);
      setError(
        errorMessage(
          cause,
          on ? "Failed to remove collaborator" : "Failed to add collaborator",
        ),
      );
    });
  }

  return {
    collaborators,
    candidates,
    isOn: (name: string) => names.has(name.toLowerCase()),
    toggle,
    error,
  };
}

export type WorkspaceCollaboratorsState = NonNullable<
  ReturnType<typeof useWorkspaceCollaborators>
>;

export function CollaboratorMenuItems({
  candidates,
  isOn,
  toggle,
}: {
  candidates: string[];
  isOn: (name: string) => boolean;
  toggle: (name: string) => void;
}) {
  return candidates.map((name) => (
    <Menu.Item key={name} closeOnClick={false} onClick={() => toggle(name)}>
      <UserAvatar name={name} size={22} />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <Menu.Check on={isOn(name)} size={20} className="text-dim" />
    </Menu.Item>
  ));
}

/**
 * The info panel's Collaborators section: teammates added to this workspace
 * besides its creator. Each one gets the workspace in their own sidebar, and
 * the server notifies them once, when they are first added.
 */
export function WorkspaceCollaborators({
  workspaceId,
  sessionId,
}: {
  workspaceId: string | null;
  /** The open session, where the new collaborator's notification points. */
  sessionId?: string;
}) {
  const state = useWorkspaceCollaborators(workspaceId, sessionId);
  if (!state) return null;
  const { collaborators, error } = state;
  const shown = collaborators.slice(0, 3);
  const label = collaborators.length
    ? collaborators.map((c) => c.name).join(", ")
    : "Only the creator";
  return (
    <div className={INFO_SECTION_CLASS}>
      <div className={INFO_LABEL_CLASS}>Collaborators</div>
      <div className={INFO_LIST_CLASS}>
        <div className={`${GIT_ROW} rounded-md py-2`}>
          {shown.length ? (
            <span className="flex shrink-0 -space-x-1.5">
              {shown.map((c) => (
                <UserAvatar key={c.name} name={c.name} size={20} />
              ))}
            </span>
          ) : (
            <span className="inline-flex size-5 shrink-0 items-center justify-center text-dim">
              <IconPeople size={18} />
            </span>
          )}
          <span
            className={`${GIT_LABEL} ${collaborators.length ? "" : "text-dim"}`}
            title={collaborators
              .map((c) => `${c.name}, added by ${c.by}`)
              .join("\n")}
          >
            {label}
          </span>
          <Menu.Root>
            <Menu.Trigger
              className={gitActionClass("muted", true)}
              aria-label="Collaborators"
            >
              {collaborators.length ? "Change" : "Add"}
              <IconChevronDown size={14} className={GIT_ACTION_CARET} />
            </Menu.Trigger>
            <Menu.Popup align="start" sideOffset={6} className="min-w-[200px]">
              <CollaboratorMenuItems {...state} />
            </Menu.Popup>
          </Menu.Root>
        </div>
      </div>
      {error && (
        <div className="px-3 text-meta font-medium text-red">{error}</div>
      )}
    </div>
  );
}

/**
 * Collaborators in the header's ⋯ menu. The presence pile stays presence
 * only, so this submenu is where collaborators are seen and changed.
 */
export function CollaboratorsSubmenu({
  workspaceId,
  sessionId,
}: {
  workspaceId: string | null;
  sessionId?: string;
}) {
  const state = useWorkspaceCollaborators(workspaceId, sessionId);
  if (!state) return null;
  return (
    <Menu.SubmenuRoot>
      <Menu.SubmenuTrigger title="Teammates who get this workspace in their sidebar">
        <IconPeople size={20} className={MENU_ICON} />
        <span className="grow">Collaborators</span>
        <IconChevronRight size={16} className="text-faint" />
      </Menu.SubmenuTrigger>
      <Menu.Popup className="min-w-[200px]">
        <CollaboratorMenuItems {...state} />
      </Menu.Popup>
    </Menu.SubmenuRoot>
  );
}
