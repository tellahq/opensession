import { useState } from "react";
import { usePeople } from "../../lib/people";
import { Menu } from "../../ui/menu";
import { CollaboratorMenuItems } from "../WorkspaceCollaborators";
import { UserAvatar } from "../UserAvatar";
import { useIsPhone } from "../../hooks/useIsPhone";
import { createSpaceApi } from "../../lib/api/workspaces";
import { errorMessage } from "../../lib/error-message";
import { repoLabel } from "../../lib/repo-label";
import { isSendCombo } from "../../lib/send-key";
import { NO_REPO } from "../../lib/session-repo";
import { Button } from "../../ui/button";
import { Field, Input, Textarea } from "../../ui/input";
import { Modal } from "../../ui/modal";
import { OptionSelect } from "../../ui/select";
import { ResponsiveDialog, SheetBody, SheetIconButton } from "../../ui/sheet";
import { toast } from "../../ui/toast";
import { IconPeople, IconX } from "../icons";
import { getCurrentUser, TEAM } from "../UserPicker";

const DESCRIPTION =
  "A space is a shared conversation with an agent that starts and tracks sessions for you.";

/**
 * Start a space: a name, an optional goal, a project, who it is shared with,
 * and optionally the first thing to tell its agent. Without a first message
 * the agent opens the space with a welcome.
 * The server creates the space and its coordinator together (POST /spaces),
 * then this opens the coordinator. A centered modal on desktop, a bottom
 * sheet on phone.
 */
export function NewSpaceDialog({
  open,
  onOpenChange,
  repos,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Registered repository ids, in sidebar order. */
  repos: string[];
  onCreated: (created: { sessionId: string }) => void;
}) {
  const phone = useIsPhone();
  const [title, setTitle] = useState("");
  const [repo, setRepo] = useState<string>(NO_REPO);
  const [prompt, setPrompt] = useState("");
  const [goal, setGoal] = useState("");
  const [sharedWith, setSharedWith] = useState<string[]>([]);
  usePeople();
  const [creating, setCreating] = useState(false);
  // Start blank each time it opens. Tracked on `open` alone, so a repo list
  // refresh while the dialog is up never resets a choice mid-edit.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setTitle("");
      setPrompt("");
      setGoal("");
      setSharedWith([]);
      setRepo(repos[0] ?? NO_REPO);
    }
  }

  const ready = !!title.trim() && !creating;
  function create() {
    if (!ready) return;
    setCreating(true);
    const input: Parameters<typeof createSpaceApi>[0] = {
      title: title.trim(),
      prompt: prompt.trim(),
      goal: goal.trim(),
      sharedWith,
      user: getCurrentUser(),
    };
    if (repo !== NO_REPO) input.repo = repo;
    void createSpaceApi(input)
      .then((created) => {
        onOpenChange(false);
        onCreated({ sessionId: created.sessionId });
      })
      .catch((error) =>
        toast(errorMessage(error, "Couldn't create the space"), {
          variant: "error",
        }),
      )
      .finally(() => setCreating(false));
  }

  const projectOptions = [
    ...repos.map((id) => ({ value: id, label: repoLabel(id) })),
    { value: NO_REPO, label: "No project" },
  ];
  const fields = (
    <div className="flex flex-col gap-3">
      <Field label="Name">
        <Input
          autoFocus={!phone}
          value={title}
          maxLength={120}
          placeholder="Spaces v1"
          onChange={(event) => setTitle(event.target.value)}
          className="phone:min-h-11 phone:text-input-phone"
        />
      </Field>
      <Field label="Goal (optional)">
        <Textarea
          value={goal}
          maxLength={2000}
          placeholder="What the work is for. The agent keeps its threads pointed at it."
          className="min-h-16 phone:text-input-phone"
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
      <SharedWithField value={sharedWith} onChange={setSharedWith} />
      <Field label="First message (optional)">
        <Textarea
          value={prompt}
          placeholder="Leave empty and the agent opens the space with a welcome."
          className="min-h-24 phone:text-input-phone"
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            // Enter is a newline here; Cmd/Ctrl+Enter creates.
            if (isSendCombo(event, "mod-enter")) {
              event.preventDefault();
              create();
            }
          }}
        />
      </Field>
    </div>
  );
  const actions = (
    <>
      <Button
        variant="ghost"
        disabled={creating}
        onClick={() => onOpenChange(false)}
      >
        Cancel
      </Button>
      <Button variant="primary" disabled={!ready} onClick={create}>
        {creating ? "Creating…" : "Create space"}
      </Button>
    </>
  );

  if (phone)
    return (
      <ResponsiveDialog
        open={open}
        onClose={() => onOpenChange(false)}
        phone
        label="New space"
        sheetClassName="max-h-[88dvh]"
      >
        <div className="flex shrink-0 items-center gap-3 px-6 pb-2 pt-0.5">
          <h2 className="m-0 min-w-0 flex-1 text-dialog-title font-semibold leading-tight tracking-[-0.01em] text-fg">
            New space
          </h2>
          <SheetIconButton
            aria-label="Close"
            onClick={() => onOpenChange(false)}
          >
            <IconX />
          </SheetIconButton>
        </div>
        <SheetBody className="flex flex-1 flex-col gap-3 px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
          <p className="m-0 text-supporting leading-relaxed text-dim">
            {DESCRIPTION}
          </p>
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
        <Modal.Header title="New space" description={DESCRIPTION} />
        {fields}
        <Modal.Footer>{actions}</Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}

/** Who the space is shared with: teammates who get it in their sidebar and
 *  can chat in it. The creator always has it. */
function SharedWithField({
  value,
  onChange,
}: {
  value: string[];
  onChange: (names: string[]) => void;
}) {
  const me = getCurrentUser().toLowerCase();
  const candidates = TEAM.filter((name) => name.toLowerCase() !== me);
  if (!candidates.length) return null;
  const on = new Set(value.map((name) => name.toLowerCase()));
  const toggle = (name: string) =>
    onChange(
      on.has(name.toLowerCase())
        ? value.filter((n) => n.toLowerCase() !== name.toLowerCase())
        : [...value, name],
    );
  return (
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
                value.length ? (
                  <span className="flex -space-x-1.5">
                    {value.slice(0, 3).map((name) => (
                      <UserAvatar key={name} name={name} size={18} />
                    ))}
                  </span>
                ) : (
                  <IconPeople size={20} />
                )
              }
            >
              {value.length ? value.join(", ") : "Only you"}
            </Button>
          }
        />
        <Menu.Popup align="start" className="min-w-[220px]">
          <CollaboratorMenuItems
            candidates={candidates}
            isOn={(name) => on.has(name.toLowerCase())}
            toggle={toggle}
          />
        </Menu.Popup>
      </Menu.Root>
    </div>
  );
}
