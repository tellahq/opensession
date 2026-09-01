import { mergeStylexOverrideClassName } from "../../ui/cn";
import { useState } from "react";
import { useSetupStatus } from "../../hooks/useSetupStatus";
import { shouldReloadAfterGithubAuthEnabled } from "../../lib/github-app-setup";
import { Segmented, SegmentedOption } from "../../ui/segmented";
import {
  SettingCard,
  SettingCardSkeleton,
  SettingsGroupLabel,
  SettingsHeader,
  SettingsHint,
  SettingsPanel,
} from "../../ui/settings";
import { InlineAlert } from "../../ui/state";
import { toast } from "../../ui/toast";
import { setupRequest, type SetupGithub } from "../setup-shared";
import { SetupRestart } from "../SetupRestart";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  flex: {
    display: "flex",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap4: {
    gap: "calc(4px * 4)",
  },
  px5: {
    paddingInline: "calc(4px * 5)",
  },
  py4: {
    paddingBlock: "calc(4px * 4)",
  },
  phoneFlexCol: {
    "@media (max-width: 720px)": {
      flexDirection: "column",
    },
  },
  phoneItemsStretch: {
    "@media (max-width: 720px)": {
      alignItems: "stretch",
    },
  },
  phonePx3: {
    "@media (max-width: 720px)": {
      paddingInline: "calc(4px * 3)",
    },
  },
  minW0: {
    minWidth: "0",
  },
  flex1: {
    flex: "1",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  textFg: {
    color: "var(--text)",
  },
  mt05: {
    marginTop: "calc(4px * 0.5)",
  },
  leadingRelaxed: {
    lineHeight: "var(--leading-relaxed)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  phoneWFull: {
    "@media (max-width: 720px)": {
      width: "100%",
    },
  },
  phoneMinH11: {
    "@media (max-width: 720px)": {
      minHeight: "calc(4px * 11)",
    },
  },
  phoneFlex1: {
    "@media (max-width: 720px)": {
      flex: "1",
    },
  },
  phoneJustifyCenter: {
    "@media (max-width: 720px)": {
      justifyContent: "center",
    },
  },
  relative: {
    position: "relative",
  },
});

function AuthenticationMethod({
  github,
  onSaved,
}: {
  github: SetupGithub;
  onSaved: (updated: SetupGithub, restartRequired: boolean) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function select(provider: string) {
    const enabled = provider === "github";
    if (saving || enabled === github.userPrAuth) return;
    setSaving(true);
    setError(null);
    await setupRequest<{
      github: SetupGithub;
      restartRequired: boolean;
    }>("/api/setup/github", {
      method: "PUT",
      json: { userPrAuth: enabled },
    })
      .then((body) => {
        toast(`GitHub sign-in ${enabled ? "enabled" : "disabled"}`);
        onSaved(body.github, body.restartRequired === true);
        if (
          shouldReloadAfterGithubAuthEnabled(
            github.userPrAuth,
            body.github.userPrAuth,
          )
        ) {
          window.location.reload();
        }
      })
      .catch((cause) => {
        const message =
          cause instanceof Error
            ? cause.message
            : "Could not update authentication";
        setError(message);
        toast(message, { variant: "error" });
      });
    setSaving(false);
  }

  return (
    <>
      <SettingCard>
        <div
          {...stylex.props(
            sx.flex,
            sx.itemsCenter,
            sx.gap4,
            sx.px5,
            sx.py4,
            sx.phoneFlexCol,
            sx.phoneItemsStretch,
            sx.phonePx3,
          )}
        >
          <div {...stylex.props(sx.minW0, sx.flex1)}>
            <div
              {...stylex.props(sx.fontMedium, sx.textFg, typography.itemTitle)}
            >
              Sign-in method
            </div>
            <div
              {...stylex.props(
                sx.mt05,
                sx.leadingRelaxed,
                sx.textDim,
                typography.supporting,
              )}
            >
              Require GitHub sign-in, or leave this workspace open.
            </div>
          </div>
          <Segmented
            label="Sign-in method"
            value={github.userPrAuth ? "github" : "none"}
            onValueChange={(value) => void select(value)}
            className={mergeStylexOverrideClassName("", sx.phoneWFull)}
          >
            <SegmentedOption
              value="none"
              disabled={saving}
              className={mergeStylexOverrideClassName(
                "",
                sx.phoneMinH11,
                sx.phoneFlex1,
                sx.phoneJustifyCenter,
              )}
            >
              None
            </SegmentedOption>
            <SegmentedOption
              value="github"
              disabled={saving}
              className={mergeStylexOverrideClassName(
                "",
                sx.phoneMinH11,
                sx.phoneFlex1,
                sx.phoneJustifyCenter,
              )}
            >
              GitHub
            </SegmentedOption>
          </Segmented>
        </div>
      </SettingCard>
      {error && <InlineAlert>{error}</InlineAlert>}
    </>
  );
}

// Organization → Authentication controls only the workspace sign-in gate.
// Provider credentials belong to Organization → Integrations.
export function AuthenticationPanel() {
  const setup = useSetupStatus();
  const { status, failed } = setup;
  return (
    <SettingsPanel className={mergeStylexOverrideClassName("", sx.relative)}>
      <SettingsHeader
        title="Authentication"
        description="Choose how teammates sign in to this workspace."
      />
      {!status ? (
        failed ? (
          <InlineAlert>
            Couldn&rsquo;t load authentication settings.
          </InlineAlert>
        ) : (
          <SettingCardSkeleton rows={1} label="Loading authentication" />
        )
      ) : (
        <>
          <SettingsGroupLabel>Workspace access</SettingsGroupLabel>
          <AuthenticationMethod
            github={status.github}
            onSaved={setup.applyGithub}
          />
          <SettingsHint>
            Configure the GitHub App and its credentials under Integrations.
          </SettingsHint>
        </>
      )}
      <SetupRestart setup={setup} />
    </SettingsPanel>
  );
}
