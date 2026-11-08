import {
  setCoordinatorMode,
  useIsCoordinating,
} from "../../lib/coordinator-mode";
import { errorMessage } from "../../lib/error-message";
import { composerMenuIcon, composerMenuItem } from "../../lib/composer-classes";
import type { UnifiedSession } from "../../lib/types";
import { useWorkspaceRecord } from "../../lib/workspace-records";
import { Menu, MENU_ICON } from "../../ui/menu";
import { toast } from "../../ui/toast";
import { ComposerPressButton } from "../composer/ComposerControls";
import { IconDelegate, IconGear } from "../icons";
import { openWorkspaceSettings } from "../WorkspaceSettingsDialog";

function toggleCoordinatorMode(sessionId: string, on: boolean) {
  void setCoordinatorMode(sessionId, !on)
    .then(() =>
      toast(
        on
          ? "Coordinator mode is off"
          : "Coordinator mode is on. The agent hands work to threads from the next message.",
      ),
    )
    .catch((error) =>
      toast(errorMessage(error, "Couldn't change coordinator mode"), {
        variant: "error",
      }),
    );
}

/**
 * The composer "+" menu's coordinator controls: switch coordinator mode for
 * this session, and open the workspace's settings (name, goal, project,
 * sharing), which is where a coordinator's goal lives.
 */
export function CoordinatorMenuItems({
  session,
  close,
}: {
  session: UnifiedSession;
  close: () => void;
}) {
  const workspace = useWorkspaceRecord(session.workspaceId ?? null);
  const on = useIsCoordinating(session, workspace);
  return (
    <>
      <ComposerPressButton
        type="button"
        className={composerMenuItem}
        aria-pressed={on}
        title={
          on
            ? "Do the work in this session again"
            : "Hand work to threads by default and track them here"
        }
        onPress={() => {
          close();
          toggleCoordinatorMode(session.id, on);
        }}
      >
        <span className={composerMenuIcon}>
          <IconDelegate size={22} />
        </span>
        <span className="grow whitespace-nowrap">
          {on ? "Turn off coordinator mode" : "Turn on coordinator mode"}
        </span>
      </ComposerPressButton>
      {workspace && (
        <ComposerPressButton
          type="button"
          className={composerMenuItem}
          title="Name, goal, project and who it is shared with"
          onPress={() => {
            close();
            openWorkspaceSettings(workspace.id);
          }}
        >
          <span className={composerMenuIcon}>
            <IconGear size={22} />
          </span>
          <span className="grow whitespace-nowrap">Workspace settings…</span>
        </ComposerPressButton>
      )}
    </>
  );
}

/** The same controls in the session header's ⋯ menu, which is the quick
 *  session menu on a phone. */
export function CoordinatorOverflowItems({
  session,
  close,
}: {
  session: UnifiedSession;
  close: () => void;
}) {
  const workspace = useWorkspaceRecord(session.workspaceId ?? null);
  const on = useIsCoordinating(session, workspace);
  return (
    <>
      <Menu.Item
        onClick={() => {
          close();
          toggleCoordinatorMode(session.id, on);
        }}
      >
        <IconDelegate size={20} className={MENU_ICON} />
        <span className="grow">
          {on ? "Turn off coordinator mode" : "Turn on coordinator mode"}
        </span>
      </Menu.Item>
      {workspace && (
        <Menu.Item
          onClick={() => {
            close();
            openWorkspaceSettings(workspace.id);
          }}
        >
          <IconGear size={20} className={MENU_ICON} />
          <span className="grow">Workspace settings…</span>
        </Menu.Item>
      )}
    </>
  );
}
