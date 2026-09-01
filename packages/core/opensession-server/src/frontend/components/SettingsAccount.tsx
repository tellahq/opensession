import { mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import React from "react";
import { SETTINGS_NAV_ICON, SETTINGS_NAV_ROW } from "../lib/settings-classes";
import { SIDEBAR_HOVER_LAYER, SIDEBAR_RAIL_GAP } from "../lib/sidebar-classes";
import { Menu } from "../ui/menu";
import { IconCheck, IconChevronRight, IconLogOut } from "./icons";
import {
  TEAM,
  setCurrentUser,
  signOut,
  useAuthStatus,
  useCurrentUser,
} from "./UserPicker";
import { UserAvatar } from "./UserAvatar";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  shrink0: {
    flexShrink: "0",
  },
  flex: {
    display: "flex",
  },
  minW0: {
    minWidth: "0",
  },
  flex1: {
    flex: "1",
  },
  flexCol: {
    flexDirection: "column",
  },
  gap05: {
    gap: "calc(4px * 0.5)",
  },
  textLeft: {
    textAlign: "left",
  },
  leadingTight: {
    lineHeight: "var(--leading-tight)",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  textFg: {
    color: "var(--text)",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  sticky: {
    position: "sticky",
  },
  bottom0: {
    bottom: "0",
  },
  Mx3: {
    marginInline: "calc(4px * -3)",
  },
  Mb4: {
    marginBottom: "calc(4px * -4)",
  },
  mtAuto: {
    marginTop: "auto",
  },
  borderX0: {
    borderInlineStyle: "solid",
    borderInlineWidth: "0px",
  },
  borderB0: {
    borderBottomStyle: "solid",
    borderBottomWidth: "0px",
  },
  borderT: {
    borderTopStyle: "solid",
    borderTopWidth: "1px",
  },
  borderSolid: {
    borderStyle: "solid",
  },
  borderDivider: {
    borderColor: "var(--divider)",
  },
  bgSidebar: {
    backgroundColor: "var(--sidebar-bg)",
  },
  px15: {
    paddingInline: "calc(4px * 1.5)",
  },
  pb4: {
    paddingBottom: "calc(4px * 4)",
  },
  pt3: {
    paddingTop: "calc(4px * 3)",
  },
  minW200px: {
    minWidth: "200px",
  },
  gap9px: {
    gap: "9px",
  },
  roundedSm: {
    borderRadius: "calc(4px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  px2: {
    paddingInline: "calc(4px * 2)",
  },
  py15: {
    paddingBlock: "calc(4px * 1.5)",
  },
  mb2: {
    marginBottom: "calc(4px * 2)",
  },
  mt5: {
    marginTop: "calc(4px * 5)",
  },
  px1: {
    paddingInline: "4px",
  },
  overflowHidden: {
    overflow: "hidden",
  },
  rounded2xl: {
    borderRadius: "calc(22px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  border: {
    borderStyle: "solid",
    borderWidth: "1px",
  },
  borderDividerSoft: {
    borderColor: "var(--divider-soft)",
  },
  bgSettingsPlate: {
    backgroundColor: "var(--settings-plate)",
  },
  h7: {
    height: "calc(4px * 7)",
  },
  w7: {
    width: "calc(4px * 7)",
  },
  itemsCenter: {
    alignItems: "center",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  textDim: {
    color: "var(--text-dim)",
  },
});

// The account lives at the bottom of Settings: who your sessions act as, and
// the way out. Two shapes for the two Settings layouts — a footer pinned under
// the desktop sub-nav, and a last card in the phone sheet's root list.
//
// Two identity modes, same as everywhere else in the app: with GitHub sign-in
// the server decides who you are (nothing to switch, just a way out), without
// it the local "Acting as" name picker applies.

function useAccount() {
  const currentUser = useCurrentUser();
  const auth = useAuthStatus();
  // GitHub sign-in active ⇒ identity is server-verified, no account switcher.
  const githubAuth = auth?.required && auth.authenticated ? auth : null;
  return {
    currentUser,
    githubAuth,
    canSignOut: !!githubAuth,
    subtitle: githubAuth
      ? githubAuth.login
        ? `Signed in with GitHub · @${githubAuth.login}`
        : "Signed in with GitHub"
      : "Acting as",
  };
}

/** Avatar · name · how that name was decided. */
function AccountIdentity({
  name,
  subtitle,
}: {
  name: string;
  subtitle: string;
}) {
  return (
    <>
      <UserAvatar
        name={name}
        size={28}
        className={mergeStylexOverrideClassName("", sx.shrink0)}
      />
      <span
        {...stylex.props(
          sx.flex,
          sx.minW0,
          sx.flex1,
          sx.flexCol,
          sx.gap05,
          sx.textLeft,
          sx.leadingTight,
        )}
      >
        <span
          {...stylex.props(
            sx.truncate,
            sx.fontSemibold,
            sx.textFg,
            typography.label,
          )}
        >
          {name}
        </span>
        <span
          {...stylex.props(
            sx.truncate,
            sx.fontMedium,
            sx.textFaint,
            typography.meta,
          )}
        >
          {subtitle}
        </span>
      </span>
    </>
  );
}

/** Desktop: pinned to the bottom of the settings sub-nav. */
export function SettingsAccountFooter() {
  const { currentUser, githubAuth, canSignOut, subtitle } = useAccount();

  return (
    // Sticky so it stays reachable once the section list outgrows the nav
    // (the negative margins cover the nav's own padding as rows scroll under).
    // It carries the nav's own surface, not a raised one: the block is the
    // bottom of that column, not a bar laid across it. Its 6px gutter is the
    // list's outdent spelled forwards, so the account row and Sign out sit on
    // the same rail as the sections above them.
    <div
      {...stylex.props(
        sx.sticky,
        sx.bottom0,
        sx.Mx3,
        sx.Mb4,
        sx.mtAuto,
        sx.flex,
        sx.flexCol,
        sx.borderX0,
        sx.borderB0,
        sx.borderT,
        sx.borderSolid,
        sx.borderDivider,
        sx.bgSidebar,
        sx.px15,
        sx.pb4,
        sx.pt3,
      )}
    >
      {githubAuth ? (
        <div
          className={utilityClassName(
            `flex items-center ${SIDEBAR_RAIL_GAP} py-[var(--sidebar-row-pad)] pl-2.5 pr-2`,
          )}
        >
          <AccountIdentity name={currentUser} subtitle={subtitle} />
        </div>
      ) : (
        <Menu.Root>
          <Menu.Trigger
            aria-label="Switch account"
            className={utilityClassName(
              `flex w-full min-w-0 items-center ${SIDEBAR_RAIL_GAP} rounded-row border-none bg-transparent py-[var(--sidebar-row-pad)] pl-2.5 pr-2 text-left data-[popup-open]:bg-selected ${SIDEBAR_HOVER_LAYER}`,
            )}
          >
            <AccountIdentity name={currentUser} subtitle={subtitle} />
            <IconChevronRight
              size={20}
              className={mergeStylexOverrideClassName(
                "",
                sx.shrink0,
                sx.textFaint,
              )}
            />
          </Menu.Trigger>
          {/* The trigger sits at the very bottom — open upward. */}
          <Menu.Popup
            side="top"
            align="start"
            sideOffset={8}
            className={mergeStylexOverrideClassName("", sx.minW200px)}
          >
            <Menu.RadioGroup
              value={currentUser}
              onValueChange={(value) => setCurrentUser(String(value))}
            >
              {TEAM.map((name) => (
                <Menu.RadioItem
                  key={name}
                  value={name}
                  closeOnClick
                  className={mergeStylexOverrideClassName(
                    "",
                    sx.gap9px,
                    sx.roundedSm,
                    sx.px2,
                    sx.py15,
                  )}
                >
                  <UserAvatar name={name} size={22} />
                  <span {...stylex.props(sx.minW0, sx.flex1, sx.fontMedium)}>
                    {name}
                  </span>
                  <Menu.Check on={name === currentUser} />
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Root>
      )}
      {canSignOut && (
        <button className={SETTINGS_NAV_ROW} onClick={() => void signOut()}>
          <span className={SETTINGS_NAV_ICON}>
            <IconLogOut />
          </span>
          Sign out
        </button>
      )}
    </div>
  );
}

/** Phone: the last card in the settings sheet's root list. */
export function SettingsAccountCard() {
  const { currentUser, githubAuth, canSignOut, subtitle } = useAccount();
  const rowClass = utilityClassName(
    "relative flex w-full items-center gap-3 border-0 bg-transparent px-3.5 py-3 text-left after:absolute after:bottom-0 after:left-[54px] after:right-0 after:h-px after:bg-divider-soft last:after:hidden active:bg-hover",
  );

  return (
    <div>
      <div
        {...stylex.props(
          sx.mb2,
          sx.mt5,
          sx.px1,
          sx.fontSemibold,
          sx.textFaint,
          typography.controlLabel,
        )}
      >
        Account
      </div>
      <div
        {...stylex.props(
          sx.overflowHidden,
          sx.rounded2xl,
          sx.border,
          sx.borderDividerSoft,
          sx.bgSettingsPlate,
        )}
      >
        {githubAuth ? (
          <div className={rowClass}>
            <AccountIdentity name={currentUser} subtitle={subtitle} />
          </div>
        ) : (
          TEAM.map((name) => (
            <button
              key={name}
              className={rowClass}
              onClick={() => setCurrentUser(name)}
            >
              <UserAvatar
                name={name}
                size={28}
                className={mergeStylexOverrideClassName("", sx.shrink0)}
              />
              <span
                {...stylex.props(
                  sx.minW0,
                  sx.flex1,
                  sx.fontMedium,
                  sx.textFg,
                  typography.itemTitle,
                )}
              >
                {name}
              </span>
              {name === currentUser && (
                <IconCheck
                  size={22}
                  className={mergeStylexOverrideClassName(
                    "text-accent",
                    sx.shrink0,
                  )}
                />
              )}
            </button>
          ))
        )}
        {canSignOut && (
          <button className={rowClass} onClick={() => void signOut()}>
            <span
              {...stylex.props(
                sx.flex,
                sx.h7,
                sx.w7,
                sx.shrink0,
                sx.itemsCenter,
                sx.justifyCenter,
                sx.textDim,
              )}
            >
              <IconLogOut size={20} />
            </span>
            <span
              {...stylex.props(
                sx.minW0,
                sx.flex1,
                sx.fontMedium,
                sx.textFg,
                typography.itemTitle,
              )}
            >
              Sign out
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
