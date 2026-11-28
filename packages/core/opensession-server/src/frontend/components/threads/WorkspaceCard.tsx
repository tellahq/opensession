import { useState } from "react";
import { repoLabel } from "../../lib/repo-label";
import type { Workspace } from "../../lib/types";
import {
  WS_SUMMARY_ICON,
  WS_SUMMARY_LABEL,
  WS_SUMMARY_RAIL,
  WS_SUMMARY_ROW,
} from "../../lib/workspace-summary-classes";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { Menu } from "../../ui/menu";
import { Tooltip } from "../../ui/tooltip";
import { HuddleButton } from "../huddle/HuddleButton";
import { IconCheckCircle, IconGear, IconPlus } from "../icons";
import { RepoTile } from "../RepoTile";
import {
  CollaboratorMenuItems,
  useWorkspaceCollaborators,
} from "../WorkspaceCollaborators";
import { UserAvatar } from "../UserAvatar";
import { WorkspaceSettingsDialog } from "../WorkspaceSettingsDialog";

/** A row that only reports: no pointer, no hover pill. */
const STILL_ROW = cn(WS_SUMMARY_ROW, "cursor-default hover:bg-transparent");

/**
 * The top of the threads panel, in the workspace summary card's row grammar:
 * the card steps down while the side panel is open, so the panel carries what
 * a coordinator needs from it. Name, goal, then quiet rows for the project,
 * progress beside the people in it, where teammates are added. Plain rows on the
 * panel itself, no surface of its own.
 */
export function WorkspaceCard({
  workspace,
  rootId,
  showTitle,
  shipped,
  total,
}: {
  workspace: Workspace;
  rootId: string;
  showTitle: boolean;
  shipped: number;
  total: number;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <section
      aria-label="Workspace summary"
      className="-mx-2 flex min-w-0 flex-col"
    >
      {/* Where the page already names the workspace, the goal takes the
          title's place beside the controls. */}
      <div
        className={cn(
          "flex min-w-0 gap-1 pr-2 pl-4",
          showTitle ? "items-center" : "items-start",
        )}
      >
        {showTitle ? (
          <h2 className="m-0 min-w-0 flex-1 truncate text-section-title font-semibold leading-tight text-fg">
            {workspace.name}
          </h2>
        ) : (
          <Goal goal={workspace.goal} className="flex-1 pt-2" />
        )}
        <span className="flex shrink-0 items-center">
          <HuddleButton
            target={{
              roomId: `workspace:${workspace.id}`,
              label: workspace.name,
              sessionId: rootId,
            }}
          />
          <Tooltip label="Workspace settings">
            <Button
              size="md"
              variant="ghost"
              icon={<IconGear size={20} />}
              aria-label="Workspace settings"
              className="flex-none rounded-control text-dim"
              onClick={() => setEditing(true)}
            />
          </Tooltip>
        </span>
      </div>
      {showTitle && <Goal goal={workspace.goal} className="px-4" />}
      {workspace.repo && (
        <div className={STILL_ROW}>
          <span className={WS_SUMMARY_RAIL}>
            <RepoTile name={workspace.repo} size={16} />
          </span>
          <span className={WS_SUMMARY_LABEL}>{repoLabel(workspace.repo)}</span>
        </div>
      )}
      <ProgressRow
        workspace={workspace}
        rootId={rootId}
        shipped={shipped}
        total={total}
      />
      <WorkspaceSettingsDialog
        workspace={workspace}
        open={editing}
        onOpenChange={setEditing}
      />
    </section>
  );
}

function Goal({ goal, className }: { goal?: string; className: string }) {
  if (!goal) return <span className={className} />;
  return (
    <p
      className={cn(
        "m-0 mb-1 min-w-0 whitespace-pre-line text-supporting text-dim",
        className,
      )}
    >
      {goal}
    </p>
  );
}

/**
 * One row for where the work stands and who is in on it: threads shipped
 * with a thin bar on the left, the people's faces on the right and a "+"
 * tile at the end of them that adds a teammate. Each collaborator gets the workspace in
 * their own sidebar.
 */
function ProgressRow({
  workspace,
  rootId,
  shipped,
  total,
}: {
  workspace: Workspace;
  rootId: string;
  shipped: number;
  total: number;
}) {
  const state = useWorkspaceCollaborators(workspace.id, rootId);
  const collaborators = workspace.collaborators ?? [];
  const people = [
    { name: workspace.createdBy, title: `${workspace.createdBy}, started it` },
    ...collaborators.map((c) => ({
      name: c.name,
      title: `${c.name}, added by ${c.by}`,
    })),
  ].filter(
    (person, i, all) =>
      person.name && all.findIndex((p) => p.name === person.name) === i,
  );
  return (
    <>
      <div className={STILL_ROW}>
        {total > 0 ? (
          <>
            <span className={WS_SUMMARY_RAIL}>
              <IconCheckCircle size={20} className={WS_SUMMARY_ICON} />
            </span>
            <span className="shrink-0 tabular-nums">
              {shipped} of {total} shipped
            </span>
            <span
              className="ml-1 h-1 w-12 shrink overflow-hidden rounded-capsule bg-hover"
              role="img"
              aria-label={`${shipped} of ${total} threads shipped`}
            >
              <span
                className="block h-full rounded-capsule bg-purple transition-[width] duration-long"
                style={{ width: `${(shipped / total) * 100}%` }}
              />
            </span>
          </>
        ) : null}
        <span
          className="ml-auto flex shrink-0 items-center pl-2"
          aria-label="People"
          role="group"
        >
          {people.map((person, i) => (
            <Tooltip key={person.name} label={person.title}>
              <UserAvatar
                name={person.name}
                size={22}
                className={cn(i > 0 && "-ml-1")}
              />
            </Tooltip>
          ))}
          {/* The add is one more tile at the end of the faces, so it reads
              as part of the group rather than a control beside it. */}
          {state && (
            <Menu.Root>
              <Tooltip label="Add collaborator">
                <Menu.Trigger
                  aria-label="Add collaborator"
                  className={cn(
                    "grid size-[22px] shrink-0 cursor-pointer place-items-center rounded-avatar border-none bg-active p-0 text-dim shadow-avatar focus-ring",
                    "transition-colors hover:bg-pressed hover:text-fg data-[popup-open]:bg-pressed data-[popup-open]:text-fg",
                    people.length > 0 && "-ml-1",
                  )}
                >
                  <IconPlus size={20} className="size-3.5" />
                </Menu.Trigger>
              </Tooltip>
              <Menu.Popup align="end" sideOffset={6} className="min-w-[200px]">
                <CollaboratorMenuItems {...state} />
              </Menu.Popup>
            </Menu.Root>
          )}
        </span>
      </div>
      {state?.error && (
        <div className="px-4 py-1 text-meta font-medium text-red">
          {state.error}
        </div>
      )}
    </>
  );
}
