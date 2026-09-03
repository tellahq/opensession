import { Field, FieldGrid, Input } from "../ui/input";
import { GithubPrivateKeyField } from "./GithubPrivateKeyField";
import { SecretField, type SetupGithub } from "./setup-shared";

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
    <div className="flex flex-col gap-4">
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
      <FieldGrid className={showInstallationOwner ? undefined : "grid-cols-1"}>
        <Field label="App slug">
          <Input
            type="text"
            className="font-mono phone:min-h-11 phone:text-input-phone"
            value={appSlug}
            onChange={(event) => onAppSlugChange(event.target.value)}
            placeholder="open-session-example"
            aria-label="GitHub App slug"
            disabled={saving}
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
          />
          <span className="text-meta leading-snug text-faint">
            From github.com/apps/&lt;slug&gt;. Identifies App-authored activity.
          </span>
        </Field>
        {showInstallationOwner && (
          <Field label="Installation owner">
            <Input
              type="text"
              className="font-mono phone:min-h-11 phone:text-input-phone"
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
            <span className="text-meta leading-snug text-faint">
              Optional default for GitHub calls that do not name a repository.
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
