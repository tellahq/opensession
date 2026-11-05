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
  VIEWER_PRESENCE,
  VIEWER_PRESENCE_AVATAR,
} from "../lib/session-viewer-classes";
import {
  publishWorkspaceRecord,
  useWorkspaceRecord,
} from "../lib/workspace-records";
import { cn } from "../ui/cn";
import { Menu, MENU_ICON } from "../ui/menu";
import { Tooltip } from "../ui/tooltip";
import { dedupeViewers, facepileAvatarStyle } from "../lib/presence";
import { personKey } from "../lib/review-queue";
import { IconChevronDown, IconChevronRight, IconPeople } from "./icons";
import { UserAvatar } from "./UserAvatar";
import { getCurrentUser, TEAM } from "./UserPicker";

/**
 * Add/remove state for a workspace's collaborators, shared by the info
 * panel's row and the session header's pile and ⋯ menu. Null when there is no
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
 * The session header's people pile: whoever else has the session open, and
 * the workspace's collaborators, as one row of faces before Share. A
 * collaborator who is not here is a dimmed face, so a full-strength face still
 * means presence. With a workspace record the pile opens the collaborator
 * picker; without one it is the plain presence pile.
 */
export function HeaderPeople({
  workspaceId,
  sessionId,
  viewers,
}: {
  workspaceId: string | null;
  sessionId?: string;
  /** Other people with the session open, one entry per socket. */
  viewers: string[];
}) {
  const state = useWorkspaceCollaborators(workspaceId, sessionId);
  const present = dedupeViewers(viewers).map((v) => v.name);
  const presentKeys = new Set(present.map(personKey));
  const away = (state?.collaborators ?? [])
    .map((c) => c.name)
    .filter((name) => !presentKeys.has(personKey(name)));
  const faces = [
    ...present.map((name) => ({ name, here: true })),
    ...away.map((name) => ({ name, here: false })),
  ];
  if (!faces.length) return null;
  const label = [
    present.length > 0 && `Viewing: ${present.join(", ")}`,
    state?.collaborators.length &&
      `Collaborators: ${state.collaborators.map((c) => c.name).join(", ")}`,
  ]
    .filter(Boolean)
    .join("\n");
  const pile = faces.map((face, index) => (
    <UserAvatar
      key={face.name}
      name={face.name}
      size={24}
      className={cn(VIEWER_PRESENCE_AVATAR, !face.here && "opacity-50")}
      style={facepileAvatarStyle(index, faces.length, "var(--bg)")}
    />
  ));
  if (!state)
    return (
      <div className={VIEWER_PRESENCE} title={label}>
        {pile}
      </div>
    );
  return (
    <Menu.Root>
      <Tooltip label={label} multiline>
        <Menu.Trigger
          className={cn(
            VIEWER_PRESENCE,
            "cursor-pointer rounded-control border-none bg-transparent p-0.5 hover:bg-hover",
          )}
          aria-label="Collaborators"
        >
          {pile}
        </Menu.Trigger>
      </Tooltip>
      <Menu.Popup align="end" sideOffset={6} className="min-w-[200px]">
        <CollaboratorMenuItems {...state} />
      </Menu.Popup>
    </Menu.Root>
  );
}

/**
 * Collaborators in the header's ⋯ menu: the way to add the first one, since
 * an empty pile draws nothing, and the only way on a phone, whose header has
 * no pile.
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
