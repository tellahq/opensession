import { AGENT_PERSON_KEY } from "../../lib/automation-audience";
import type { GroupBy, PrsFilter } from "../../lib/sidebar-filter";
import type { WsTimePref } from "../../lib/workspace-time";
import type { SettingOption } from "../../ui/setting-row";
import { RepoTile, repoLabel } from "../RepoTile";
import { UserAvatar } from "../UserAvatar";
import { IconRepo, IconRobot } from "../icons";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  inlineFlex: {
    display: "inline-flex",
  },
  size4: {
    width: "calc(4px * 4)",
    height: "calc(4px * 4)",
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
  roundedAvatar: {
    borderRadius: "calc(32% * var(--rp))",
    cornerShape: "var(--cs)",
  },
  bgActive: {
    backgroundColor: "var(--bg-active)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
});

export const GROUP_BY_OPTIONS: Array<SettingOption & { value: GroupBy }> = [
  { value: "inbox", label: "Inbox" },
  { value: "activity", label: "Activity" },
  { value: "status", label: "Status" },
];

export const PR_FILTER_OPTIONS: Array<SettingOption & { value: PrsFilter }> = [
  { value: "default", label: "Mine + requested" },
  { value: "all", label: "Everyone's" },
  { value: "none", label: "Hidden" },
];

export const LAST_USED_TIME_OPTIONS: Array<
  SettingOption & { value: WsTimePref }
> = [
  { value: "off", label: "Off" },
  { value: "always", label: "Always" },
  { value: "hover", label: "On hover" },
];

export function repoFilterOptions(
  repos: Array<{ id: string }>,
): SettingOption[] {
  return [
    { value: "all", label: "All repos", icon: <IconRepo size={16} /> },
    ...repos.map(({ id }) => ({
      value: id,
      label: repoLabel(id),
      icon: <RepoTile name={id} size={16} />,
    })),
  ];
}

export function personFilterOptions({
  people,
  currentUser,
}: {
  people: Array<{ key: string; label: string }>;
  currentUser: string;
}): SettingOption[] {
  const meKey = currentUser.toLowerCase();
  const avatar = (name: string) => <UserAvatar name={name} size={16} />;
  const icon = (key: string, label: string) =>
    key === AGENT_PERSON_KEY ? (
      <span
        {...stylex.props(
          sx.inlineFlex,
          sx.size4,
          sx.shrink0,
          sx.itemsCenter,
          sx.justifyCenter,
          sx.roundedAvatar,
          sx.bgActive,
          sx.textDim,
        )}
      >
        <IconRobot size={13} />
      </span>
    ) : (
      avatar(label)
    );

  return [
    { value: "me", label: `${currentUser} (you)`, icon: avatar(currentUser) },
    ...people
      .filter(({ key }) => key !== meKey)
      .map(({ key, label }) => ({ value: key, label, icon: icon(key, label) })),
    { value: "unassigned", label: "Unassigned" },
    { value: "everyone", label: "Everyone" },
  ];
}
