import { mergeStylexProps, mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import React, { useState } from "react";
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
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  relative: {
    position: "relative",
  },
  flex: {
    display: "flex",
  },
  size11: {
    width: "calc(4px * 11)",
    height: "calc(4px * 11)",
  },
  shrink0: {
    flexShrink: "0",
  },
  itemsCenter: {
    alignItems: "center",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  roundedControl: {
    borderRadius: "calc(12px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  bgTransparent: {
    backgroundColor: "transparent",
  },
  p0: {
    padding: "0",
  },
  textFg: {
    color: "var(--text)",
  },
  transitionBackgroundColorScale: {
    transitionProperty: "background-color,scale",
    transitionTimingFunction: "var(--tw-ease, var(--ease))",
    transitionDuration: "var(--tw-duration, var(--dur-micro))",
  },
  activeScale096: {
    ":active": {
      scale: "0.96",
    },
  },
  activeBgHover: {
    ":active": {
      backgroundColor: "var(--hover)",
    },
  },
  motionReduceTransformNone: {
    "@media (prefers-reduced-motion: reduce)": {
      "@media (prefers-reduced-motion:reduce)": {
        transform: "none",
      },
    },
  },
  inlineFlex: {
    display: "inline-flex",
  },
  size10: {
    width: "calc(4px * 10)",
    height: "calc(4px * 10)",
  },
  objectCover: {
    objectFit: "cover",
  },
  size22px: {
    width: "22px",
    height: "22px",
  },
  size5: {
    width: "calc(4px * 5)",
    height: "calc(4px * 5)",
  },
  roundedSm: {
    borderRadius: "calc(4px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  minW0: {
    minWidth: "0",
  },
  flex1: {
    flex: "1",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  transitionColorRotate: {
    transitionProperty: "color,rotate",
    transitionTimingFunction: "var(--tw-ease, var(--ease))",
    transitionDuration: "var(--tw-duration, var(--dur-micro))",
  },
  w290px: {
    width: "290px",
  },
  maxWCalc100vw16px: {
    maxWidth: "calc(100vw - 16px)",
  },
  gap3: {
    gap: "calc(4px * 3)",
  },
  px2: {
    paddingInline: "calc(4px * 2)",
  },
  py2: {
    paddingBlock: "calc(4px * 2)",
  },
  size9: {
    width: "calc(4px * 9)",
    height: "calc(4px * 9)",
  },
  roundedMd: {
    borderRadius: "calc(7px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  block: {
    display: "block",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  roundedFull: {
    borderRadius: "calc(infinity * 1px)",
    cornerShape: "round",
  },
  bgAccent: {
    backgroundColor: "var(--accent)",
  },
  px15: {
    paddingInline: "calc(4px * 1.5)",
  },
  textOnAccent: {
    color: "var(--on-accent)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  flexCol: {
    flexDirection: "column",
  },
  bgPanel: {
    backgroundColor: "var(--bg-panel)",
  },
  px3: {
    paddingInline: "calc(4px * 3)",
  },
});

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

function organizationBridge(): OrganizationBridge | undefined {
  return (window as unknown as { os1?: { organizations?: OrganizationBridge } })
    .os1?.organizations;
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
  const itemClass = utilityClassName("phone:min-h-11");
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
            className={mergeStylexOverrideClassName(
              "focus-ring",
              sx.relative,
              sx.flex,
              sx.size11,
              sx.shrink0,
              sx.itemsCenter,
              sx.justifyCenter,
              sx.roundedControl,
              sx.bgTransparent,
              sx.p0,
              sx.textFg,
              sx.transitionBackgroundColorScale,
              sx.activeScale096,
              sx.activeBgHover,
              sx.motionReduceTransformNone,
            )}
            aria-label={`Open organization menu, current: ${name}`}
          >
            <span
              {...stylex.props(
                sx.relative,
                sx.inlineFlex,
                sx.size10,
                sx.itemsCenter,
                sx.justifyCenter,
              )}
            >
              <OrganizationAppIcon
                className={mergeStylexOverrideClassName(
                  "",
                  sx.size10,
                  sx.roundedControl,
                  sx.objectCover,
                )}
              />
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
            className={utilityClassName(
              `group flex w-full items-center ${SIDEBAR_RAIL_GAP} rounded-row bg-transparent px-[calc(var(--sidebar-icon-left)-var(--sidebar-nav-x))] py-[var(--sidebar-tool-pad)] text-left text-body font-medium text-fg transition-[background-color,scale] hover:bg-hover active:scale-[0.96] phone:py-[13px] desktop:text-item-title motion-reduce:transform-none`,
            )}
            aria-label={`Open organization menu, current: ${name}`}
          >
            <span
              {...stylex.props(
                sx.relative,
                sx.inlineFlex,
                sx.size22px,
                sx.shrink0,
                sx.itemsCenter,
                sx.justifyCenter,
              )}
            >
              <OrganizationAppIcon
                className={mergeStylexOverrideClassName(
                  "",
                  sx.size5,
                  sx.roundedSm,
                  sx.objectCover,
                )}
              />
              <span
                className={APP_LOGO_STATUS}
                style={{
                  background: connected ? "var(--green)" : "var(--red)",
                }}
                title={status}
              />
            </span>
            <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>
              {name}
            </span>
            <IconChevronDown
              size={16}
              className={mergeStylexOverrideClassName(
                "group-hover:text-dim group-data-[popup-open]:rotate-180",
                sx.shrink0,
                sx.textFaint,
                sx.transitionColorRotate,
              )}
              aria-hidden="true"
            />
          </Menu.Trigger>
        )}

        <Menu.Popup
          side="bottom"
          align="start"
          sideOffset={5}
          className={mergeStylexOverrideClassName(
            "",
            sx.w290px,
            sx.maxWCalc100vw16px,
          )}
        >
          <div
            {...stylex.props(sx.flex, sx.itemsCenter, sx.gap3, sx.px2, sx.py2)}
          >
            <span
              {...stylex.props(
                sx.relative,
                sx.inlineFlex,
                sx.size9,
                sx.shrink0,
                sx.itemsCenter,
                sx.justifyCenter,
              )}
            >
              <OrganizationAppIcon
                className={mergeStylexOverrideClassName(
                  "",
                  sx.size9,
                  sx.roundedMd,
                  sx.objectCover,
                )}
              />
              <span
                className={APP_LOGO_STATUS}
                style={{
                  background: connected ? "var(--green)" : "var(--red)",
                }}
                aria-hidden="true"
              />
            </span>
            <span {...stylex.props(sx.minW0)}>
              <span
                {...stylex.props(
                  sx.block,
                  sx.truncate,
                  sx.fontSemibold,
                  sx.textFg,
                  typography.body,
                )}
              >
                {name}
              </span>
              <span
                {...stylex.props(
                  sx.block,
                  sx.truncate,
                  sx.textFaint,
                  typography.supporting,
                )}
              >
                {subtitle}
              </span>
            </span>
          </div>
          <Menu.Separator />
          <Menu.Item className={itemClass} onClick={() => onOpenSettings()}>
            <IconGear size={19} className={MENU_ICON} />
            <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>
              Settings
            </span>
          </Menu.Item>
          <Menu.Item
            className={itemClass}
            onClick={() => onOpenSettings("members")}
          >
            <IconPeople size={19} className={MENU_ICON} />
            <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>
              Members
            </span>
            {memberCount !== null && (
              <span
                {...mergeStylexProps(
                  "tabular-nums",
                  sx.textFaint,
                  typography.label,
                )}
              >
                {memberCount}
              </span>
            )}
          </Menu.Item>
          <Menu.Item
            className={itemClass}
            onClick={() => setDownloadOpen(true)}
          >
            <IconArrowDown size={19} className={MENU_ICON} />
            <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>
              Download apps
            </span>
          </Menu.Item>
          <Menu.Item
            className={`${itemClass} text-accent`}
            onClick={() => setInviteOpen(true)}
          >
            <IconPlus size={19} className="text-accent" />
            <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>
              Invite member
            </span>
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
                    <span
                      {...stylex.props(
                        sx.flex,
                        sx.size22px,
                        sx.shrink0,
                        sx.itemsCenter,
                        sx.justifyCenter,
                      )}
                    >
                      {active ? (
                        <OrganizationAppIcon
                          className={mergeStylexOverrideClassName(
                            "",
                            sx.size22px,
                            sx.roundedSm,
                            sx.objectCover,
                          )}
                        />
                      ) : (
                        <IconTile name={account.label} size={22} />
                      )}
                    </span>
                    <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>
                      {active ? name : account.label}
                    </span>
                    {account.unread > 0 && (
                      <span
                        {...mergeStylexProps(
                          "tabular-nums",
                          sx.roundedFull,
                          sx.bgAccent,
                          sx.px15,
                          sx.fontSemibold,
                          sx.textOnAccent,
                          typography.meta,
                        )}
                      >
                        {account.unread}
                      </span>
                    )}
                    {account.shortcut !== null && (
                      <Menu.Shortcut>⌘⇧{account.shortcut}</Menu.Shortcut>
                    )}
                    <Menu.Check
                      on={active}
                      className={mergeStylexOverrideClassName("", sx.textDim)}
                    />
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
                <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>
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
                <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>
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
            {...stylex.props(sx.flex, sx.flexCol, sx.gap3)}
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
          <div
            {...stylex.props(
              sx.truncate,
              sx.roundedControl,
              sx.bgPanel,
              sx.px3,
              sx.py2,
              sx.textDim,
              typography.controlLabel,
            )}
          >
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
