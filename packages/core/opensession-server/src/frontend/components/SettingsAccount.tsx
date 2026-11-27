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
      <UserAvatar name={name} size={28} className="shrink-0" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left leading-tight">
        <span className="truncate text-label font-semibold text-fg">
          {name}
        </span>
        <span className="truncate text-meta font-medium text-faint">
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
    <div className="sticky bottom-0 -mx-3 -mb-4 mt-auto flex flex-col border-x-0 border-b-0 border-t border-solid border-divider bg-sidebar px-1.5 pb-4 pt-3">
      {githubAuth ? (
        <div
          className={`flex items-center ${SIDEBAR_RAIL_GAP} py-[var(--sidebar-row-pad)] pl-2.5 pr-2`}
        >
          <AccountIdentity name={currentUser} subtitle={subtitle} />
        </div>
      ) : (
        <Menu.Root>
          <Menu.Trigger
            aria-label="Switch account"
            className={`flex w-full min-w-0 items-center ${SIDEBAR_RAIL_GAP} rounded-control border-none bg-transparent py-[var(--sidebar-row-pad)] pl-2.5 pr-2 text-left data-[popup-open]:bg-selected ${SIDEBAR_HOVER_LAYER}`}
          >
            <AccountIdentity name={currentUser} subtitle={subtitle} />
            <IconChevronRight size={20} className="shrink-0 text-faint" />
          </Menu.Trigger>
          {/* The trigger sits at the very bottom — open upward. */}
          <Menu.Popup
            side="top"
            align="start"
            sideOffset={8}
            className="min-w-[200px]"
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
                  className="gap-[9px] rounded-sm px-2 py-1.5"
                >
                  <UserAvatar name={name} size={22} />
                  <span className="min-w-0 flex-1 font-medium">{name}</span>
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
  const rowClass =
    "relative flex w-full items-center gap-3 border-0 bg-transparent px-3.5 py-3 text-left after:absolute after:bottom-0 after:left-[54px] after:right-0 after:h-px after:bg-divider-soft last:after:hidden active:bg-hover";

  return (
    <div>
      <div className="mb-2 mt-5 px-1 text-control-label font-semibold text-faint">
        Account
      </div>
      <div className="overflow-hidden rounded-2xl border border-divider-soft bg-settings-plate">
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
              <UserAvatar name={name} size={28} className="shrink-0" />
              <span className="min-w-0 flex-1 text-item-title font-medium text-fg">
                {name}
              </span>
              {name === currentUser && (
                <IconCheck size={22} className="shrink-0 text-accent" />
              )}
            </button>
          ))
        )}
        {canSignOut && (
          <button className={rowClass} onClick={() => void signOut()}>
            <span className="flex h-7 w-7 shrink-0 items-center justify-center text-dim">
              <IconLogOut size={20} />
            </span>
            <span className="min-w-0 flex-1 text-item-title font-medium text-fg">
              Sign out
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
