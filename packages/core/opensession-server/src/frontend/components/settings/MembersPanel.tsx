import { BASE_PATH } from "../../lib/base";
import { SettingsHeader, SettingsPanel } from "../../ui/settings";
import { TeamSection } from "../SetupTeam";

// Workspace → Members: the identity table, on a page of its own. Commit
// attribution, `allowedUsers` scoping and GitHub sign-in all resolve through
// it, so it long outlives the Setup wizard step that first fills it in.

export function MembersPanel() {
  return (
    <SettingsPanel>
      <SettingsHeader
        title="Members"
        description={
          <>
            Members identify who sessions act as. Configure GitHub sign-in under{" "}
            <a
              href={`${BASE_PATH}/settings/authentication`}
              className="text-link hover:underline"
            >
              Authentication
            </a>
            .
          </>
        }
      />
      <TeamSection onChanged={() => {}} />
    </SettingsPanel>
  );
}
