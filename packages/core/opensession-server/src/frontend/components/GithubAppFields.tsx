import { mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import { Field, FieldGrid, Input } from "../ui/input";
import { GithubPrivateKeyField } from "./GithubPrivateKeyField";
import { SecretField, type SetupGithub } from "./setup-shared";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  flex: {
    display: "flex",
  },
  flexCol: {
    flexDirection: "column",
  },
  gap4: {
    gap: "calc(4px * 4)",
  },
  fontMono: {
    fontFamily: "var(--mono)",
  },
  phoneMinH11: {
    "@media (max-width: 720px)": {
      minHeight: "calc(4px * 11)",
    },
  },
  phoneTextInputPhone: {
    "@media (max-width: 720px)": {
      fontSize: "var(--type-input-phone)",
    },
  },
  leadingSnug: {
    lineHeight: "var(--leading-snug)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
});

export function GithubAppFields({
  github,
  saving,
  clientId,
  appSlug,
  installationOwner,
  clientSecret,
  privateKey,
  clientIdCleared,
  clientSecretCleared,
  onClientIdChange,
  onToggleClientIdClear,
  onAppSlugChange,
  onInstallationOwnerChange,
  showInstallationOwner = true,
  onClientSecretChange,
  onToggleClientSecretClear,
  onPrivateKeyChange,
}: {
  github: SetupGithub;
  saving: boolean;
  clientId: string;
  appSlug: string;
  installationOwner: string;
  clientSecret: string;
  privateKey: string;
  clientIdCleared: boolean;
  clientSecretCleared: boolean;
  onClientIdChange: (value: string) => void;
  onToggleClientIdClear: () => void;
  onAppSlugChange: (value: string) => void;
  onInstallationOwnerChange: (value: string) => void;
  showInstallationOwner?: boolean;
  onClientSecretChange: (value: string) => void;
  onToggleClientSecretClear: () => void;
  onPrivateKeyChange: (value: string) => void;
}) {
  return (
    <div {...stylex.props(sx.flex, sx.flexCol, sx.gap4)}>
      <SecretField
        name="Client id"
        type="text"
        required
        placeholder="Iv23li…"
        present={github.clientIdConfigured}
        cleared={clientIdCleared}
        value={clientId}
        disabled={saving}
        onChange={onClientIdChange}
        onToggleClear={onToggleClientIdClear}
      />
      <FieldGrid
        className={
          showInstallationOwner ? undefined : utilityClassName("grid-cols-1")
        }
      >
        <Field label="App slug">
          <Input
            type="text"
            className={mergeStylexOverrideClassName(
              "",
              sx.fontMono,
              sx.phoneMinH11,
              sx.phoneTextInputPhone,
            )}
            value={appSlug}
            onChange={(event) => onAppSlugChange(event.target.value)}
            placeholder="open-session-example"
            aria-label="GitHub App slug"
            disabled={saving}
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
          />
          <span
            {...stylex.props(sx.leadingSnug, sx.textFaint, typography.meta)}
          >
            From github.com/apps/&lt;slug&gt;. Identifies App-authored activity.
          </span>
        </Field>
        {showInstallationOwner && (
          <Field label="Installation owner">
            <Input
              type="text"
              className={mergeStylexOverrideClassName(
                "",
                sx.fontMono,
                sx.phoneMinH11,
                sx.phoneTextInputPhone,
              )}
              value={installationOwner}
              onChange={(event) =>
                onInstallationOwnerChange(event.target.value)
              }
              placeholder="my-organization"
              aria-label="GitHub App installation owner"
              disabled={saving}
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
            />
            <span
              {...stylex.props(sx.leadingSnug, sx.textFaint, typography.meta)}
            >
              The GitHub account or organization where the App is installed.
            </span>
          </Field>
        )}
      </FieldGrid>
      <SecretField
        name="Client secret"
        required
        present={github.clientSecretConfigured}
        cleared={clientSecretCleared}
        value={clientSecret}
        disabled={saving}
        onChange={onClientSecretChange}
        onToggleClear={onToggleClientSecretClear}
      />
      <GithubPrivateKeyField
        configured={github.privateKeyConfigured}
        saving={saving}
        value={privateKey}
        onChange={onPrivateKeyChange}
      />
    </div>
  );
}
