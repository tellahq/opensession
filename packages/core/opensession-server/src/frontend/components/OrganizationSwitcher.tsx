import { os1Shell } from "../lib/os1-shell";
import React, { useState } from "react";
import { z } from "zod";
import { useOrganizationName } from "../hooks/useOrganizationIcon";
import { APP_LOGO_STATUS } from "../lib/app-header-classes";
import { BASE_PATH } from "../lib/base";
import { SIDEBAR_RAIL_GAP } from "../lib/sidebar-classes";
import { Button } from "../ui/button";
import { Field, Input } from "../ui/input";
import { Menu, MENU_ICON } from "../ui/menu";
import { Modal } from "../ui/modal";
import { InlineAlert } from "../ui/state";
import { toast } from "../ui/toast";
import { IconTile } from "./BrandTile";
import { setupRequest } from "./setup-shared";
import { GithubMemberDialog } from "./SetupTeam";
import { DownloadAppsDialog } from "./DownloadAppsDialog";
import {
  IconArrowDown,
  IconChevronDown,
  IconCopy,
  IconGear,
  IconPeople,
  IconPlus,
  IconServer,
} from "./icons";
import { OrganizationAppIcon } from "./OrganizationAppIcon";

type OrganizationAccount = {
  id: string;
  label: string;
  unread: number;
  shortcut: number | null;
};

type OrganizationList = {
  activeId: string;
  accounts: OrganizationAccount[];
};

type AddOrganizationResult = {
  ok: boolean;
  error?: string;
  canAddAnyway?: boolean;
  url?: string;
};

type OrganizationBridge = {
  inlineAdd?: boolean;
  list?: () => Promise<OrganizationList | null>;
  switch?: (id: string) => void;
  add?: (url: string, check?: boolean) => Promise<AddOrganizationResult>;
  manage?: () => void;
};

const organizationBridgeSchema = z.object({
  inlineAdd: z.boolean().optional(),
  list: z
    .custom<NonNullable<OrganizationBridge["list"]>>(
      (value) => value instanceof Function,
    )
    .optional(),
  switch: z
    .custom<NonNullable<OrganizationBridge["switch"]>>(
      (value) => value instanceof Function,
    )
    .optional(),
  add: z
    .custom<NonNullable<OrganizationBridge["add"]>>(
      (value) => value instanceof Function,
    )
    .optional(),
  manage: z
    .custom<NonNullable<OrganizationBridge["manage"]>>(
      (value) => value instanceof Function,
    )
    .optional(),
});

function organizationBridge(): OrganizationBridge | undefined {
  return organizationBridgeSchema.safeParse(os1Shell()?.organizations).data;
}

/** Active organization identity and account switcher. */
export function OrganizationSwitcher({
  connected,
  onOpenSettings,
  variant = "sidebar",
}: {
  connected: boolean;
  onOpenSettings: (section?: "general" | "members") => void;
  variant?: "sidebar" | "topbar";
}) {
  const name = useOrganizationName();
  const bridge = organizationBridge();
  const fallbackId = "current";
  const [accounts, setAccounts] = useState<OrganizationAccount[]>([
    { id: fallbackId, label: name, unread: 0, shortcut: null },
  ]);
  const [activeId, setActiveId] = useState(fallbackId);
  const [memberCount, setMemberCount] = useState<number | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [serverAddress, setServerAddress] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [canAddAnyway, setCanAddAnyway] = useState(false);
  const [adding, setAdding] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [invitedLogin, setInvitedLogin] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const status = connected ? "Connected" : "Reconnecting…";

  function loadMenu() {
    void bridge
      ?.list?.()
      .then((result) => {
        if (!result?.accounts.length) return;
        setAccounts(result.accounts);
        setActiveId(result.activeId);
      })
      .catch(() => {});
    void setupRequest<{ members: unknown[] }>("/api/setup/team")
      .then((result) => setMemberCount(result.members.length))
      .catch(() => setMemberCount(null));
  }

  const subtitle = `${status}${memberCount === null ? "" : ` · ${memberCount} ${memberCount === 1 ? "member" : "members"}`}`;
  const itemClass = "phone:min-h-11";
  const organizationUrl = `${window.location.origin}${BASE_PATH}/`;

  function openAddOrganization() {
    setServerAddress("");
    setAddError(null);
    setCanAddAnyway(false);
    setAddOpen(true);
  }

  async function addOrganization(check: boolean) {
    const add = bridge?.add;
    if (!add || !serverAddress.trim() || adding) return;
    setAdding(true);
    setAddError(null);
    await (async () => {
      const result = await add(serverAddress, check);
      if (result.ok) {
        setAddOpen(false);
        return;
      }
      if (result.url) setServerAddress(result.url);
      setCanAddAnyway(!!result.canAddAnyway);
      setAddError(result.error || "Couldn’t add that organization.");
    })()
      .catch(async () => {
        setAddError("Couldn’t add that organization.");
      })
      .finally(async () => {
        setAdding(false);
      });
  }

  async function copyOrganizationLink() {
    await (async () => {
      await navigator.clipboard.writeText(organizationUrl);
      setCopied(true);
      toast("Organization link copied", { variant: "success" });
    })().catch(async () => {
      toast("Couldn’t copy the organization link", { variant: "error" });
    });
  }

  return (
    <>
      <Menu.Root onOpenChange={(open) => open && loadMenu()}>
        {variant === "topbar" ? (
          <Menu.Trigger
            className="focus-ring relative flex size-11 shrink-0 items-center justify-center rounded-control bg-transparent p-0 text-fg transition-[background-color,scale] active:scale-[0.96] active:bg-hover motion-reduce:transform-none"
            aria-label={`Open organization menu, current: ${name}`}
          >
            <span className="relative inline-flex size-10 items-center justify-center">
              <OrganizationAppIcon className="size-10 rounded-control object-cover" />
              <span
                className={APP_LOGO_STATUS}
                style={{
                  background: connected ? "var(--green)" : "var(--red)",
                }}
                title={status}
              />
            </span>
          </Menu.Trigger>
        ) : (
          <Menu.Trigger
            className={`group flex w-full items-center ${SIDEBAR_RAIL_GAP} rounded-row bg-transparent px-[calc(var(--sidebar-icon-left)-var(--sidebar-nav-x))] py-[var(--sidebar-tool-pad)] text-left text-body font-medium text-fg transition-[background-color,scale] hover:bg-hover active:scale-[0.96] phone:py-[13px] desktop:text-item-title motion-reduce:transform-none`}
            aria-label={`Open organization menu, current: ${name}`}
          >
            <span className="relative inline-flex size-[22px] shrink-0 items-center justify-center">
              <OrganizationAppIcon className="size-5 rounded-sm object-cover" />
              <span
                className={APP_LOGO_STATUS}
                style={{
                  background: connected ? "var(--green)" : "var(--red)",
                }}
                title={status}
              />
            </span>
            <span className="min-w-0 flex-1 truncate">{name}</span>
            <IconChevronDown
              size={16}
              className="shrink-0 text-faint transition-[color,rotate] group-hover:text-dim group-data-[popup-open]:rotate-180"
              aria-hidden="true"
            />
          </Menu.Trigger>
        )}

        <Menu.Popup
          side="bottom"
          align="start"
          sideOffset={5}
          className="w-[290px] max-w-[calc(100vw-16px)]"
        >
          <div className="flex items-center gap-3 px-2 py-2">
            <span className="relative inline-flex size-9 shrink-0 items-center justify-center">
              <OrganizationAppIcon className="size-9 rounded-md object-cover" />
              <span
                className={APP_LOGO_STATUS}
                style={{
                  background: connected ? "var(--green)" : "var(--red)",
                }}
                aria-hidden="true"
              />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-body font-semibold text-fg">
                {name}
              </span>
              <span className="block truncate text-supporting text-faint">
                {subtitle}
              </span>
            </span>
          </div>
          <Menu.Separator />
          <Menu.Item className={itemClass} onClick={() => onOpenSettings()}>
            <IconGear size={19} className={MENU_ICON} />
            <span className="min-w-0 flex-1 truncate">Settings</span>
          </Menu.Item>
          <Menu.Item
            className={itemClass}
            onClick={() => onOpenSettings("members")}
          >
            <IconPeople size={19} className={MENU_ICON} />
            <span className="min-w-0 flex-1 truncate">Members</span>
            {memberCount !== null && (
              <span className="text-label tabular-nums text-faint">
                {memberCount}
              </span>
            )}
          </Menu.Item>
          <Menu.Item
            className={itemClass}
            onClick={() => setDownloadOpen(true)}
          >
            <IconArrowDown size={19} className={MENU_ICON} />
            <span className="min-w-0 flex-1 truncate">Download apps</span>
          </Menu.Item>
          <Menu.Item
            className={`${itemClass} text-accent`}
            onClick={() => setInviteOpen(true)}
          >
            <IconPlus size={19} className="text-accent" />
            <span className="min-w-0 flex-1 truncate">Invite member</span>
          </Menu.Item>
          <Menu.Separator />
          <Menu.Group>
            <Menu.GroupLabel>Organizations</Menu.GroupLabel>
            <Menu.RadioGroup value={activeId}>
              {accounts.map((account) => {
                const active = account.id === activeId;
                return (
                  <Menu.RadioItem
                    key={account.id}
                    value={account.id}
                    closeOnClick
                    className={itemClass}
                    onClick={() => {
                      if (!active) bridge?.switch?.(account.id);
                    }}
                  >
                    <span className="flex size-[22px] shrink-0 items-center justify-center">
                      {active ? (
                        <OrganizationAppIcon className="size-[22px] rounded-sm object-cover" />
                      ) : (
                        <IconTile name={account.label} size={22} />
                      )}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {active ? name : account.label}
                    </span>
                    {account.unread > 0 && (
                      <span className="rounded-full bg-accent px-1.5 text-meta font-semibold tabular-nums text-on-accent">
                        {account.unread}
                      </span>
                    )}
                    {account.shortcut !== null && (
                      <Menu.Shortcut>⌘⇧{account.shortcut}</Menu.Shortcut>
                    )}
                    <Menu.Check on={active} className="text-dim" />
                  </Menu.RadioItem>
                );
              })}
            </Menu.RadioGroup>
            {bridge?.inlineAdd && bridge.add && (
              <Menu.Item
                className={`${itemClass} text-accent`}
                onClick={openAddOrganization}
              >
                <IconPlus size={19} className="text-accent" />
                <span className="min-w-0 flex-1 truncate">
                  Add organization
                </span>
              </Menu.Item>
            )}
            {bridge?.manage && accounts.length > 1 && (
              <Menu.Item
                className={itemClass}
                onClick={() => bridge.manage?.()}
              >
                <IconServer size={19} className={MENU_ICON} />
                <span className="min-w-0 flex-1 truncate">
                  Manage organizations
                </span>
              </Menu.Item>
            )}
          </Menu.Group>
        </Menu.Popup>
      </Menu.Root>
      <DownloadAppsDialog open={downloadOpen} onOpenChange={setDownloadOpen} />
      <Modal.Root
        open={addOpen}
        onOpenChange={(open) => {
          if (!adding) setAddOpen(open);
        }}
      >
        <Modal.Content>
          <Modal.Header
            title="Add organization"
            description="Connect another Open Session server."
          />
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void addOrganization(true);
            }}
          >
            <Field label="Server address">
              <Input
                value={serverAddress}
                onChange={(event) => {
                  setServerAddress(event.target.value);
                  setAddError(null);
                  setCanAddAnyway(false);
                }}
                placeholder="os.example.com"
                inputMode="url"
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
                autoFocus
                disabled={adding}
                required
              />
            </Field>
            {addError && <InlineAlert>{addError}</InlineAlert>}
            <Modal.Footer>
              <Button
                variant="ghost"
                onClick={() => setAddOpen(false)}
                disabled={adding}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                type={canAddAnyway ? "button" : "submit"}
                onClick={
                  canAddAnyway ? () => void addOrganization(false) : undefined
                }
                disabled={!serverAddress.trim() || adding}
              >
                {adding
                  ? canAddAnyway
                    ? "Adding…"
                    : "Checking…"
                  : canAddAnyway
                    ? "Add anyway"
                    : "Add organization"}
              </Button>
            </Modal.Footer>
          </form>
        </Modal.Content>
      </Modal.Root>
      <GithubMemberDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        inviteUrl={organizationUrl}
        title="Invite member"
        actionLabel="Invite member"
        onSaved={(login) => {
          setInviteOpen(false);
          setInvitedLogin(login);
          setCopied(false);
          setMemberCount((count) => (count === null ? count : count + 1));
        }}
      />
      <Modal.Root
        open={invitedLogin !== null}
        onOpenChange={(open) => {
          if (!open) setInvitedLogin(null);
        }}
      >
        <Modal.Content>
          <Modal.Header
            title="Member added"
            description={`@${invitedLogin || "member"} can now sign in to ${name} with GitHub.`}
          />
          <div className="truncate rounded-control bg-panel px-3 py-2 text-control-label text-dim">
            {organizationUrl}
          </div>
          <Modal.Footer>
            <Button variant="ghost" onClick={() => setInvitedLogin(null)}>
              Done
            </Button>
            <Button
              variant="primary"
              icon={<IconCopy size={18} />}
              onClick={() => void copyOrganizationLink()}
            >
              {copied ? "Copied" : "Copy invite link"}
            </Button>
          </Modal.Footer>
        </Modal.Content>
      </Modal.Root>
    </>
  );
}
