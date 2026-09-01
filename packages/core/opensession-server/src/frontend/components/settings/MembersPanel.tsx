import { BASE_PATH } from "../../lib/base";
import { SettingsHeader, SettingsPanel } from "../../ui/settings";
import { TeamSection } from "../SetupTeam";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  textLink: {
    color: "var(--link)",
  },
  hoverUnderline: {
    "@media (hover: hover)": {
      ":hover": {
        textDecorationLine: "underline",
      },
    },
  },
});

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
            Members identify who sessions act as. Configure who can sign in
            under{" "}
            <a
              href={`${BASE_PATH}/settings/authentication`}
              {...stylex.props(sx.textLink, sx.hoverUnderline)}
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
