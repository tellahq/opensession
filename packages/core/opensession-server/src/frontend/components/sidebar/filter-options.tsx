import { AGENT_PERSON_KEY } from "../../lib/automation-audience";
import type { GroupBy, PrsFilter } from "../../lib/sidebar-filter";
import type { WsTimePref } from "../../lib/workspace-time";
import type { SettingOption } from "../../ui/setting-row";
import { RepoTile, repoLabel } from "../RepoTile";
import { UserAvatar } from "../UserAvatar";
import { IconRepo, IconRobot } from "../icons";

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
    { value: "all", label: "All repos", icon: <IconRepo size={20} /> },
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
      <span className="inline-flex size-4 shrink-0 items-center justify-center rounded-avatar bg-active text-dim">
        <IconRobot size={20} />
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
