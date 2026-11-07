import { useState } from "react";
import { useIsPhone } from "../../hooks/useIsPhone";
import { updateWorkspaceApi } from "../../lib/api/workspaces";
import { cachedRepos } from "../../lib/repo-cache";
import { errorMessage } from "../../lib/error-message";
import { repoLabel } from "../../lib/repo-label";
import { NO_REPO } from "../../lib/session-repo";
import type { Workspace } from "../../lib/types";
import { publishWorkspaceRecord } from "../../lib/workspace-records";
import { Button } from "../../ui/button";
import { Field, Input, Textarea } from "../../ui/input";
import { Menu } from "../../ui/menu";
import { Modal } from "../../ui/modal";
import { OptionSelect } from "../../ui/select";
import { ResponsiveDialog, SheetBody, SheetIconButton } from "../../ui/sheet";
import { toast } from "../../ui/toast";
import { IconPeople, IconX } from "../icons";
import { UserAvatar } from "../UserAvatar";
import {
  CollaboratorMenuItems,
  useWorkspaceCollaborators,
} from "../WorkspaceCollaborators";

/**
 * Change a space after it was made: its name, goal, project and who it is
 * shared with. Sharing applies as you toggle it (the same control as a
 * workspace's collaborators); the rest saves together.
 */
export function SpaceSettingsDialog({
  workspace,
  open,
  onOpenChange,
}: {
  workspace: Workspace;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const phone = useIsPhone();
  const [name, setName] = useState(workspace.name);
  const [goal, setGoal] = useState(workspace.goal ?? "");
  const [repo, setRepo] = useState(workspace.repo ?? NO_REPO);
  const [saving, setSaving] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setName(workspace.name);
      setGoal(workspace.goal ?? "");
      setRepo(workspace.repo ?? NO_REPO);
    }
  }
  const sharing = useWorkspaceCollaborators(workspace.id);

  const projectOptions = [
    ...cachedRepos().map(({ id }) => ({ value: id, label: repoLabel(id) })),
    { value: NO_REPO, label: "No project" },
  ];
  const ready = !!name.trim() && !saving;
  function save() {
    if (!ready) return;
    setSaving(true);
    const patch: Parameters<typeof updateWorkspaceApi>[1] = {
      name: name.trim(),
      goal: goal.trim() || null,
    };
    // A space without a project keeps none; the server has no "clear repo".
    if (repo !== NO_REPO && repo !== workspace.repo) patch.repo = repo;
    void updateWorkspaceApi(workspace.id, patch)
      .then((updated) => {
        publishWorkspaceRecord(updated);
        onOpenChange(false);
      })
      .catch((error) =>
        toast(errorMessage(error, "Couldn't save the space"), {
          variant: "error",
        }),
      )
      .finally(() => setSaving(false));
  }

  const fields = (
    <div className="flex flex-col gap-3">
      <Field label="Name">
        <Input
          value={name}
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
          className="phone:min-h-11 phone:text-input-phone"
        />
      </Field>
      <Field label="Goal">
        <Textarea
          value={goal}
          maxLength={2000}
          placeholder="What the work is for. The agent keeps its threads pointed at it."
          className="min-h-20 phone:text-input-phone"
          onChange={(event) => setGoal(event.target.value)}
        />
      </Field>
      <div className="flex min-w-0 flex-col gap-1.5">
        <span className="text-label font-medium text-dim">Project</span>
        <OptionSelect
          label="Project"
          value={repo}
          options={projectOptions}
          onChange={setRepo}
          className="w-full"
        />
      </div>
      {sharing && (
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-label font-medium text-dim">Shared with</span>
          <Menu.Root>
            <Menu.Trigger
              render={
                <Button
                  variant="default"
                  caret
                  className="w-full justify-start phone:min-h-11"
                  icon={
                    sharing.collaborators.length ? (
                      <span className="flex -space-x-1.5">
                        {sharing.collaborators.slice(0, 3).map((c) => (
                          <UserAvatar key={c.name} name={c.name} size={18} />
                        ))}
                      </span>
                    ) : (
                      <IconPeople size={20} />
                    )
                  }
                >
                  {sharing.collaborators.length
                    ? sharing.collaborators.map((c) => c.name).join(", ")
                    : `Only ${workspace.createdBy}`}
                </Button>
              }
            />
            <Menu.Popup align="start" className="min-w-[220px]">
              <CollaboratorMenuItems {...sharing} />
            </Menu.Popup>
          </Menu.Root>
          {sharing.error && (
            <span className="text-meta font-medium text-red">
              {sharing.error}
            </span>
          )}
        </div>
      )}
    </div>
  );
  const actions = (
    <>
      <Button
        variant="ghost"
        disabled={saving}
        onClick={() => onOpenChange(false)}
      >
        Cancel
      </Button>
      <Button variant="primary" disabled={!ready} onClick={save}>
        {saving ? "Saving…" : "Save"}
      </Button>
    </>
  );

  if (phone)
    return (
      <ResponsiveDialog
        open={open}
        onClose={() => onOpenChange(false)}
        phone
        label="Space settings"
        sheetClassName="max-h-[88dvh]"
      >
        <div className="flex shrink-0 items-center gap-3 px-6 pb-2 pt-0.5">
          <h2 className="m-0 min-w-0 flex-1 text-dialog-title font-semibold leading-tight text-fg">
            Space settings
          </h2>
          <SheetIconButton
            aria-label="Close"
            onClick={() => onOpenChange(false)}
          >
            <IconX />
          </SheetIconButton>
        </div>
        <SheetBody className="flex flex-1 flex-col gap-3 px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
          {fields}
          <div className="flex flex-wrap items-center justify-end gap-2 [&>button]:min-h-11">
            {actions}
          </div>
        </SheetBody>
      </ResponsiveDialog>
    );

  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content widthClassName="max-w-[34rem]">
        <Modal.Header title="Space settings" />
        {fields}
        <Modal.Footer>{actions}</Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
