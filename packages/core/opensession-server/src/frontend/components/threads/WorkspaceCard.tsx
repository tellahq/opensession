import { useState } from "react";
import { repoLabel } from "../../lib/repo-label";
import type { Workspace } from "../../lib/types";
import {
  WS_SUMMARY_ACTION,
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
import { IconCheckCircle, IconGear, IconPeople } from "../icons";
import { RepoTile } from "../RepoTile";
import {
  CollaboratorMenuItems,
  useWorkspaceCollaborators,
} from "../WorkspaceCollaborators";
import { WorkspaceSettingsDialog } from "../WorkspaceSettingsDialog";

/** A row that only reports: no pointer, no hover pill. */
const STILL_ROW = cn(WS_SUMMARY_ROW, "cursor-default hover:bg-transparent");

/**
 * The top of the threads panel, in the workspace summary card's row grammar:
 * the card steps down while the side panel is open, so the panel carries what
 * a coordinator needs from it. Name, goal, then quiet rows for the project,
 * progress and the people in it, where teammates are added. Plain rows on the
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
      {total > 0 && <ProgressRow shipped={shipped} total={total} />}
      <PeopleRow workspace={workspace} rootId={rootId} />
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

/** Threads shipped against everything started, with a thin bar. */
function ProgressRow({ shipped, total }: { shipped: number; total: number }) {
  return (
    <div className={STILL_ROW}>
      <span className={WS_SUMMARY_RAIL}>
        <IconCheckCircle size={20} className={WS_SUMMARY_ICON} />
      </span>
      <span className={WS_SUMMARY_LABEL}>
        {shipped} of {total} shipped
      </span>
      <span
        className="h-1 w-14 shrink-0 overflow-hidden rounded-[999px] bg-hover"
        role="img"
        aria-label={`${shipped} of ${total} threads shipped`}
      >
        <span
          className="block h-full rounded-[999px] bg-purple transition-[width] duration-300"
          style={{ width: `${(shipped / total) * 100}%` }}
        />
      </span>
    </div>
  );
}

/**
 * Who is in the workspace, and the way to bring someone in: the whole row
 * opens the teammate picker. Each collaborator gets the workspace in their
 * own sidebar.
 */
function PeopleRow({
  workspace,
  rootId,
}: {
  workspace: Workspace;
  rootId: string;
}) {
  const state = useWorkspaceCollaborators(workspace.id, rootId);
  if (!state) return null;
  const names = [workspace.createdBy, ...state.collaborators.map((c) => c.name)]
    .filter(Boolean)
    .filter((name, i, all) => all.indexOf(name) === i);
  const title = state.collaborators
    .map((c) => `${c.name}, added by ${c.by}`)
    .join("\n");
  return (
    <>
      <Menu.Root>
        <Menu.Trigger
          className={WS_SUMMARY_ROW}
          aria-label="Collaborators"
          title={title || undefined}
        >
          <span className={WS_SUMMARY_RAIL}>
            <IconPeople size={20} className={WS_SUMMARY_ICON} />
          </span>
          <span className={WS_SUMMARY_LABEL}>{names.join(", ")}</span>
          <span className={WS_SUMMARY_ACTION}>Add</span>
        </Menu.Trigger>
        <Menu.Popup align="end" sideOffset={6} className="min-w-[200px]">
          <CollaboratorMenuItems {...state} />
        </Menu.Popup>
      </Menu.Root>
      {state.error && (
        <div className="px-4 py-1 text-meta font-medium text-red">
          {state.error}
        </div>
      )}
    </>
  );
}
