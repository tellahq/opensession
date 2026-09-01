import { mergeStylexOverrideClassName } from "../ui/cn";
import React, { useCallback, useEffect, useState } from "react";
import { Button } from "../ui/button";
import { EmptyState, InlineAlert } from "../ui/state";
import {
  disconnectTool,
  fetchToolAccounts,
  knownToolAccounts,
  startToolConnect,
  type ToolAccountDto,
} from "../lib/api/settings";
import {
  SettingCard,
  SettingCardSkeleton,
  SettingRow,
  SettingRowControl,
  SettingRowDescription,
  SettingRowText,
  SettingRowTitle,
  SettingsGroupLabel,
  SettingsHeader,
  SettingsPanel,
  StatusChip,
  rowMenuTriggerClasses,
} from "../ui/settings";
import { Menu } from "../ui/menu";
import { IconDotsHorizontal, IconPlug, IconTrash } from "./icons";
import { displayName } from "../brand-logos";
import { IconTile } from "./BrandTile";
import { useCurrentUser } from "./UserPicker";
import { GithubAccounts } from "./Connections";
import { KeychainSection } from "./settings/KeychainPanel";
import { ProfileSection } from "./settings/ProfileSection";
import { errorMessage } from "../lib/error-message";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  gap3: {
    gap: "calc(4px * 3)",
  },
  flex: {
    display: "flex",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  textRed: {
    color: "var(--red)",
  },
});

/**
 * Settings → Personal → Account: everything about you on this instance.
 *
 * Your profile (picture, name, the roster fields you own: ProfileSection),
 * then every per-user sign-in: OAuth-capable MCP servers (connect as yourself;
 * your sessions then use YOUR account, falling back to the workspace grant —
 * src/server/mcp-oauth.ts), the per-user GitHub auth section (PRs as
 * yourself), and your keychain (the credentials a session can borrow from
 * you). Workspace-wide MCP grants stay on the Connections page's server cards
 * (admin surface).
 *
 * Profile and sign-ins were briefly two pages. They are one because they
 * answer one question between them, and because split in two the GitHub login
 * appeared on both: once as a read-only roster field, once as the account your
 * PRs are opened with.
 */
export function MyAccountsPanel() {
  const currentUser = useCurrentUser();
  // Seeded from the last list this page session saw, so re-opening settings
  // shows the tools rather than a placeholder standing in for a list we
  // already know. The fetch below replaces it either way.
  const [tools, setTools] = useState<ToolAccountDto[] | null>(
    knownToolAccounts,
  );
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    await (async () => {
      const body = await fetchToolAccounts();
      setTools(body.servers);
      setChecking(body.pending);
    })().catch(async () => {});
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A tool the server has never probed (one just added to the config)
  // resolves in the background there. Ask again a few times rather than
  // leaving it out of the list until someone reopens the page.
  useEffect(() => {
    if (!checking) return;
    let tries = 0;
    const t = setInterval(() => {
      tries += 1;
      if (tries >= 4) clearInterval(t);
      void load();
    }, 1500);
    return () => clearInterval(t);
  }, [checking, load]);

  async function connect(name: string) {
    await (async () => {
      const { url } = await startToolConnect(name);
      window.open(url, "_blank", "noopener");
      // Re-poll for a while so the row flips once they approve the consent.
      let polls = 0;
      const t = setInterval(() => {
        polls += 1;
        if (polls > 24) return clearInterval(t);
        void load();
      }, 5000);
    })().catch(async (error) => {
      setError(errorMessage(error, `Could not connect ${name}`));
    });
  }

  async function disconnect(name: string) {
    await (async () => {
      await disconnectTool(name);
      void load();
    })().catch(async (error) => {
      setError(errorMessage(error, `Could not disconnect ${name}`));
    });
  }

  const isMe = (teamName: string) => {
    const a = teamName.toLowerCase();
    const b = (currentUser || "").toLowerCase();
    return !!b && (a === b || a.startsWith(b) || b.startsWith(a));
  };
  // OAuth-capable = the server publishes OAuth metadata (even when it runs
  // on a workspace key today) or has a preset flow, which is what a personal
  // sign-in needs. Anything else has nothing to connect.
  const oauthServers = (tools || []).filter((s) => s.capable);

  return (
    <SettingsPanel>
      <SettingsHeader title="Account" />
      {error && (
        <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>
      )}
      <ProfileSection />
      <GithubAccounts personal />
      <SettingsGroupLabel>Tools</SettingsGroupLabel>
      {tools === null || (oauthServers.length === 0 && checking) ? (
        // Ghost rows, not "no tools yet": an empty state is a confident
        // claim, and the list is merely in flight.
        <SettingCardSkeleton rows={4} icon={30} label="Loading tools" />
      ) : oauthServers.length === 0 ? (
        <EmptyState placement="card">
          No tools with personal sign-in are configured yet. Add one on the
          Connections page and it shows up here.
        </EmptyState>
      ) : (
        <SettingCard>
          {oauthServers.map((s) => {
            const mine = s.users.some(isMe);
            const slack = s.name.toLowerCase() === "slack";
            return (
              <SettingRow
                key={s.name}
                className={mergeStylexOverrideClassName("", sx.gap3)}
              >
                <IconTile name={s.name} size={30} />
                <SettingRowText>
                  <SettingRowTitle>{displayName(s.name)}</SettingRowTitle>
                  <SettingRowDescription>
                    {slack && mine
                      ? "Post messages and screenshots as you after a PR merges"
                      : slack
                        ? "Connect to post messages and screenshots as you after a PR merges"
                        : mine
                          ? // Not "Connected as you": the chip beside it already
                            // says connected, so the description says what that
                            // buys instead of repeating the state.
                            "Sessions use your account"
                          : s.shared
                            ? "Using the workspace account"
                            : "Using the workspace key"}
                  </SettingRowDescription>
                </SettingRowText>
                <SettingRowControl
                  className={mergeStylexOverrideClassName(
                    "",
                    sx.flex,
                    sx.itemsCenter,
                    sx.gap2,
                  )}
                >
                  {mine ? (
                    // A connected row states that it is connected and keeps its
                    // actions in the ⋯ menu. Left as buttons, "Disconnect" sat
                    // exactly where an unconnected row shows "Connect", in the
                    // same neutral style, so the two states read alike.
                    <>
                      <StatusChip label="Connected" dot="var(--green)" />
                      <Menu.Root>
                        <Menu.Trigger
                          className={rowMenuTriggerClasses}
                          aria-label={`Manage ${displayName(s.name)}`}
                        >
                          <IconDotsHorizontal size={18} />
                        </Menu.Trigger>
                        <Menu.Popup align="end" sideOffset={4}>
                          <Menu.Item onClick={() => connect(s.name)}>
                            <IconPlug
                              size={16}
                              className={mergeStylexOverrideClassName(
                                "",
                                sx.textFaint,
                              )}
                            />
                            Reconnect
                          </Menu.Item>
                          <Menu.Item
                            onClick={() => disconnect(s.name)}
                            className={mergeStylexOverrideClassName(
                              "data-[highlighted]:bg-red-soft",
                              sx.textRed,
                            )}
                          >
                            <IconTrash size={16} />
                            Disconnect
                          </Menu.Item>
                        </Menu.Popup>
                      </Menu.Root>
                    </>
                  ) : (
                    // Not `primary`: one red button per row would make a list of
                    // unconnected servers shout, and the GitHub rows below use the
                    // same neutral Connect.
                    <Button size="sm" onClick={() => connect(s.name)}>
                      Connect
                    </Button>
                  )}
                </SettingRowControl>
              </SettingRow>
            );
          })}
        </SettingCard>
      )}
      <KeychainSection />
    </SettingsPanel>
  );
}
