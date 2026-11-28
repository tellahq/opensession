import { SettingsHeader, SettingsPanel } from "../../ui/settings";
import { TeamSection } from "../SetupTeam";

// Organization → Members: the identity table. Commit attribution,
// `allowedUsers` scoping and GitHub sign-in all resolve through it.

export function MembersPanel() {
  return (
    <SettingsPanel>
      <SettingsHeader title="Members" />
      <TeamSection onChanged={() => {}} />
    </SettingsPanel>
  );
}
