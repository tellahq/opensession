import React, { useState } from "react";
import { z } from "zod";
import { useOrganizationName } from "../hooks/useOrganizationIcon";
import { os1Shell } from "../lib/os1-shell";
import { Button } from "../ui/button";
import { Field, Input } from "../ui/input";
import { Modal } from "../ui/modal";
import { InlineAlert } from "../ui/state";
import { toast } from "../ui/toast";
import { Tooltip } from "../ui/tooltip";
import { IconTile } from "./BrandTile";
import { IconCheck, IconTrash } from "./icons";
import { OrganizationAppIcon } from "./OrganizationAppIcon";

export type OrganizationAccount = {
  id: string;
  label: string;
  url?: string;
  unread: number;
  shortcut: number | null;
};

export type OrganizationList = {
  activeId: string;
  accounts: OrganizationAccount[];
};

type AddOrganizationResult = {
  ok: boolean;
  error?: string;
  canAddAnyway?: boolean;
  url?: string;
};

type RemoveOrganizationResult = { ok: boolean; error?: string };

/** What the desktop shell exposes on `window.os1.organizations`. Older shells
 * lack `remove`, in which case "Manage organizations" falls back to `manage`,
 * the shell's own setup page. */
export type OrganizationBridge = {
  inlineAdd?: boolean;
  list?: () => Promise<OrganizationList | null>;
  switch?: (id: string) => void;
  add?: (
    url: string,
    check?: boolean,
    activate?: boolean,
  ) => Promise<AddOrganizationResult>;
  remove?: (id: string) => Promise<RemoveOrganizationResult>;
  manage?: () => void;
};

const fn = <T,>() =>
  z.custom<T>((value) => value instanceof Function).optional();

const organizationBridgeSchema = z.object({
  inlineAdd: z.boolean().optional(),
  list: fn<NonNullable<OrganizationBridge["list"]>>(),
  switch: fn<NonNullable<OrganizationBridge["switch"]>>(),
  add: fn<NonNullable<OrganizationBridge["add"]>>(),
  remove: fn<NonNullable<OrganizationBridge["remove"]>>(),
  manage: fn<NonNullable<OrganizationBridge["manage"]>>(),
});

export function organizationBridge(): OrganizationBridge | undefined {
  return organizationBridgeSchema.safeParse(os1Shell()?.organizations).data;
}

const ADD_FAILED = "Couldn’t add that organization.";
const REMOVE_FAILED = "Couldn’t remove that organization.";

/** Server-address form state shared by the standalone add dialog and the
 * inline form inside the organizations dialog. Lives in a body component
 * that mounts with the dialog, so a fresh open starts blank. */
function useAddOrganization({
  add,
  activate,
  onAdded,
}: {
  add: OrganizationBridge["add"];
  activate: boolean;
  onAdded: () => void;
}) {
  const [serverAddress, setServerAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [canAddAnyway, setCanAddAnyway] = useState(false);
  const [adding, setAdding] = useState(false);

  function change(value: string) {
    setServerAddress(value);
    setError(null);
    setCanAddAnyway(false);
  }

  async function submit(check: boolean) {
    if (!add || !serverAddress.trim() || adding) return;
    setAdding(true);
    setError(null);
    await (async () => {
      const result = await add(serverAddress, check, activate);
      if (result.ok) {
        change("");
        onAdded();
        return;
      }
      if (result.url) setServerAddress(result.url);
      setCanAddAnyway(!!result.canAddAnyway);
      setError(result.error || ADD_FAILED);
    })()
      .catch(async () => {
        setError(ADD_FAILED);
      })
      .finally(async () => {
        setAdding(false);
      });
  }

  const label = adding
    ? canAddAnyway
      ? "Adding…"
      : "Checking…"
    : canAddAnyway
      ? "Add anyway"
      : "Add organization";

  return {
    serverAddress,
    error,
    canAddAnyway,
    adding,
    ready: !!serverAddress.trim() && !adding,
    label,
    change,
    submit,
  };
}

type AddState = ReturnType<typeof useAddOrganization>;

function AddOrganizationInput({
  state,
  autoFocus,
}: {
  state: AddState;
  autoFocus?: boolean;
}) {
  return (
    <Input
      value={state.serverAddress}
      onChange={(event) => state.change(event.target.value)}
      placeholder="os.example.com"
      inputMode="url"
      autoCapitalize="none"
      autoComplete="off"
      spellCheck={false}
      autoFocus={autoFocus}
      disabled={state.adding}
      required
    />
  );
}

/** Submit button that flips to "Add anyway" once a probe failed but the
 * address is still usable. */
function AddOrganizationButton({ state }: { state: AddState }) {
  return (
    <Button
      variant="primary"
      type={state.canAddAnyway ? "button" : "submit"}
      onClick={state.canAddAnyway ? () => void state.submit(false) : undefined}
      disabled={!state.ready}
    >
      {state.label}
    </Button>
  );
}

function AddOrganizationBody({
  bridge,
  onClose,
}: {
  bridge: OrganizationBridge | undefined;
  onClose: () => void;
}) {
  const state = useAddOrganization({
    add: bridge?.add,
    activate: true,
    onAdded: onClose,
  });
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void state.submit(true);
      }}
    >
      <Field label="Server address">
        <AddOrganizationInput state={state} autoFocus />
      </Field>
      {state.error && <InlineAlert>{state.error}</InlineAlert>}
      <Modal.Footer>
        <Button variant="ghost" onClick={onClose} disabled={state.adding}>
          Cancel
        </Button>
        <AddOrganizationButton state={state} />
      </Modal.Footer>
    </form>
  );
}

/** Quick add from the organization menu: adds and switches to it. */
export function AddOrganizationDialog({
  open,
  onOpenChange,
  bridge,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bridge: OrganizationBridge | undefined;
}) {
  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content>
        <Modal.Header
          title="Add organization"
          description="Connect another Open Session server."
        />
        <AddOrganizationBody
          bridge={bridge}
          onClose={() => onOpenChange(false)}
        />
      </Modal.Content>
    </Modal.Root>
  );
}

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function ManageOrganizationsBody({
  bridge,
  list,
  onListChange,
  onClose,
}: {
  bridge: OrganizationBridge | undefined;
  list: OrganizationList;
  onListChange: (list: OrganizationList) => void;
  onClose: () => void;
}) {
  const name = useOrganizationName();
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  function refresh() {
    void bridge
      ?.list?.()
      .then((result) => {
        if (result?.accounts.length) onListChange(result);
      })
      .catch(() => {});
  }

  const state = useAddOrganization({
    add: bridge?.add,
    activate: false,
    onAdded: () => {
      toast("Organization added", { variant: "success" });
      refresh();
    },
  });

  async function remove(account: OrganizationAccount) {
    const removeAccount = bridge?.remove;
    if (!removeAccount || removing) return;
    setRemoving(account.id);
    setRemoveError(null);
    await (async () => {
      const result = await removeAccount(account.id);
      if (!result.ok) {
        setRemoveError(result.error || REMOVE_FAILED);
        return;
      }
      toast(`Removed ${account.label}`, { variant: "success" });
      refresh();
    })()
      .catch(async () => {
        setRemoveError(REMOVE_FAILED);
      })
      .finally(async () => {
        setRemoving(null);
      });
  }

  const busy = state.adding || removing !== null;

  return (
    <>
      <ul
        className="m-0 flex list-none flex-col gap-0.5 p-0"
        aria-label="Organizations"
      >
        {list.accounts.map((account) => {
          const active = account.id === list.activeId;
          const label = active ? name : account.label;
          const host = hostOf(account.url);
          return (
            <li
              key={account.id}
              className="flex min-h-11 items-center gap-3 py-1.5"
            >
              <span className="flex size-7 shrink-0 items-center justify-center">
                {active ? (
                  <OrganizationAppIcon className="size-7 rounded-md object-cover" />
                ) : (
                  <IconTile name={account.label} size={28} />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body font-medium text-fg">
                  {label}
                </span>
                {host && host !== label && (
                  <span className="block truncate text-supporting text-faint">
                    {host}
                  </span>
                )}
              </span>
              {active ? (
                <span className="flex items-center gap-1 text-label text-faint">
                  <IconCheck size={14} aria-hidden="true" />
                  Current
                </span>
              ) : (
                <Tooltip label="Remove organization" side="left">
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<IconTrash size={18} />}
                    aria-label={`Remove ${account.label}`}
                    disabled={busy}
                    onClick={() => void remove(account)}
                  />
                </Tooltip>
              )}
            </li>
          );
        })}
      </ul>
      {removeError && <InlineAlert>{removeError}</InlineAlert>}
      <form
        className="flex flex-col gap-2 border-t border-line pt-3"
        onSubmit={(event) => {
          event.preventDefault();
          void state.submit(true);
        }}
      >
        <div className="flex items-end gap-2">
          <Field label="Add organization" className="min-w-0 flex-1">
            <AddOrganizationInput state={state} />
          </Field>
          <AddOrganizationButton state={state} />
        </div>
        {state.error && <InlineAlert>{state.error}</InlineAlert>}
      </form>
      <Modal.Footer>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Done
        </Button>
      </Modal.Footer>
    </>
  );
}

/** Every organization this app is signed in to, with removal and an inline
 * add form. Adding here does not switch windows; the current one stays put.
 * The owner holds `list` and reloads it from the shell when opening; the
 * body reports each change back through `onListChange`. */
export function ManageOrganizationsDialog({
  open,
  onOpenChange,
  bridge,
  list,
  onListChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bridge: OrganizationBridge | undefined;
  list: OrganizationList;
  onListChange: (list: OrganizationList) => void;
}) {
  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content>
        <Modal.Header
          title="Organizations"
          description="Servers this app is signed in to."
        />
        <ManageOrganizationsBody
          bridge={bridge}
          list={list}
          onListChange={onListChange}
          onClose={() => onOpenChange(false)}
        />
      </Modal.Content>
    </Modal.Root>
  );
}
