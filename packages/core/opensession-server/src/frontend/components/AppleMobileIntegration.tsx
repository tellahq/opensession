import { useEffect, useState } from "react";
import {
  fetchAppleMobileSetup,
  saveAppleMobileSetup,
  type AppleMobileSetupStatus,
} from "../lib/api/apple-mobile";
import { Button } from "../ui/button";
import { Modal } from "../ui/modal";
import {
  SettingCard,
  SettingCardSkeleton,
  SettingsField,
  SettingsSection,
  settingsInputClass,
  settingsTextareaClass,
} from "../ui/settings";
import { InlineAlert } from "../ui/state";
import { Switch } from "../ui/switch";
import { toast } from "../ui/toast";
import { IconTile } from "./BrandTile";
import { LinkChips, StateChip } from "./setup-shared";

function ReadinessRow({
  ready,
  children,
}: {
  ready?: boolean;
  children: string;
}) {
  return (
    <li className="flex items-start gap-2 text-supporting leading-relaxed text-dim">
      <span
        className={ready === true ? "text-green" : "text-faint"}
        aria-hidden="true"
      >
        {ready === true ? "✓" : "•"}
      </span>
      <span>{children}</span>
    </li>
  );
}

function AppleMobileSetupDialog({
  open,
  status,
  teamNames,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  status: AppleMobileSetupStatus;
  teamNames: string[];
  onOpenChange: (open: boolean) => void;
  onSaved: (status: AppleMobileSetupStatus) => void;
}) {
  const [buildEnabled, setBuildEnabled] = useState(status.buildEnabled);
  const [releaseEnabled, setReleaseEnabled] = useState(status.releaseEnabled);
  const [allowedRoots, setAllowedRoots] = useState(
    status.allowedRoots.join("\n"),
  );
  const [teamId, setTeamId] = useState(status.teamId);
  const [keyId, setKeyId] = useState("");
  const [issuerId, setIssuerId] = useState("");
  const [privateKeyPath, setPrivateKeyPath] = useState("");
  const [allowedUsers, setAllowedUsers] = useState(
    status.allowedUsers.join(", "),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setBuildEnabled(status.buildEnabled);
    setReleaseEnabled(status.releaseEnabled);
    setAllowedRoots(status.allowedRoots.join("\n"));
    setTeamId(status.teamId);
    setKeyId("");
    setIssuerId("");
    setPrivateKeyPath("");
    setAllowedUsers(status.allowedUsers.join(", "));
    setError(null);
  }, [open, status]);

  async function save() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await saveAppleMobileSetup({
        buildEnabled,
        releaseEnabled,
        allowedRoots: allowedRoots
          .split("\n")
          .map((root) => root.trim())
          .filter(Boolean),
        teamId: teamId.trim(),
        ...(keyId.trim() ? { keyId: keyId.trim() } : {}),
        ...(issuerId.trim() ? { issuerId: issuerId.trim() } : {}),
        ...(privateKeyPath.trim()
          ? { privateKeyPath: privateKeyPath.trim() }
          : {}),
        allowedUsers: allowedUsers
          .split(",")
          .map((user) => user.trim())
          .filter(Boolean),
      });
      onSaved(updated);
      onOpenChange(false);
      toast("Apple mobile saved");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not save Apple mobile",
      );
    }
    setSaving(false);
  }

  const keyPlaceholder = status.credentials.keyId
    ? "Configured. Leave blank to keep it"
    : "ABC123DEFG";
  const issuerPlaceholder = status.credentials.issuerId
    ? "Configured. Leave blank to keep it"
    : "00000000-0000-0000-0000-000000000000";
  const privateKeyPlaceholder = status.credentials.privateKeyPath
    ? "Configured. Leave blank to keep it"
    : "/protected/apple/AuthKey_ABC123DEFG.p8";

  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content widthClassName="max-w-[42rem]">
        <Modal.Header
          title={
            <span className="flex items-center gap-2.5">
              <IconTile name="apple-mobile" size={28} />
              Apple mobile
            </span>
          }
          description="Build Swift apps without credentials, then add a tightly restricted release connection when this Mac is ready."
        />

        <div className="flex flex-col gap-4">
          {error ? <InlineAlert>{error}</InlineAlert> : null}

          <SettingsSection className="flex flex-col gap-4 border-0 bg-panel p-4">
            <div className="flex items-center gap-4">
              <div className="min-w-0 flex-1">
                <div className="text-item-title font-medium text-fg">
                  Development builds
                </div>
                <div className="mt-0.5 text-supporting text-dim">
                  Credential-free tests, unsigned builds, and xtool development
                  IPAs.
                </div>
              </div>
              <Switch
                checked={buildEnabled}
                onCheckedChange={setBuildEnabled}
                disabled={saving}
                aria-label="Enable Apple mobile development builds"
              />
            </div>
            <SettingsField>
              Allowed project roots, one per line
              <textarea
                className={settingsTextareaClass}
                rows={3}
                value={allowedRoots}
                onChange={(event) => setAllowedRoots(event.target.value)}
                placeholder={
                  "/Users/you/dev\n/Users/you/.opensession/worktrees"
                }
                disabled={saving}
              />
            </SettingsField>
            <p className="m-0 text-meta leading-relaxed text-faint">
              Builds can run repository build scripts. Keep this list narrow.
              xtool signing is development-only.
            </p>
          </SettingsSection>

          <SettingsSection className="flex flex-col gap-4 border-0 bg-panel p-4">
            <div className="flex items-center gap-4">
              <div className="min-w-0 flex-1">
                <div className="text-item-title font-medium text-fg">
                  Ad-hoc and TestFlight releases
                </div>
                <div className="mt-0.5 text-supporting text-dim">
                  Xcode signing behind a reviewed, commit-bound release plan.
                </div>
              </div>
              <Switch
                checked={releaseEnabled}
                onCheckedChange={setReleaseEnabled}
                disabled={saving || !status.host.releaseCapable}
                aria-label="Enable Apple mobile release tools"
              />
            </div>

            {!status.host.releaseCapable ? (
              <InlineAlert>
                Release tools require Xcode on this Mac. Development builds can
                still use SwiftPM or xtool.
              </InlineAlert>
            ) : null}

            {releaseEnabled ? (
              <div className="grid grid-cols-2 gap-3 phone:grid-cols-1">
                <SettingsField>
                  Apple Developer Team ID
                  <input
                    className={settingsInputClass}
                    value={teamId}
                    onChange={(event) => setTeamId(event.target.value)}
                    placeholder="TEAM123456"
                    disabled={saving}
                    autoComplete="off"
                  />
                </SettingsField>
                <SettingsField>
                  App Store Connect key ID
                  <input
                    className={settingsInputClass}
                    value={keyId}
                    onChange={(event) => setKeyId(event.target.value)}
                    placeholder={keyPlaceholder}
                    disabled={saving}
                    autoComplete="off"
                  />
                </SettingsField>
                <SettingsField>
                  App Store Connect issuer ID
                  <input
                    className={settingsInputClass}
                    value={issuerId}
                    onChange={(event) => setIssuerId(event.target.value)}
                    placeholder={issuerPlaceholder}
                    disabled={saving}
                    autoComplete="off"
                  />
                </SettingsField>
                <SettingsField>
                  Private key path
                  <input
                    className={settingsInputClass}
                    value={privateKeyPath}
                    onChange={(event) => setPrivateKeyPath(event.target.value)}
                    placeholder={privateKeyPlaceholder}
                    disabled={saving}
                    autoComplete="off"
                  />
                </SettingsField>
                <SettingsField className="col-span-2 phone:col-span-1">
                  People allowed to release
                  <input
                    className={settingsInputClass}
                    value={allowedUsers}
                    onChange={(event) => setAllowedUsers(event.target.value)}
                    placeholder={
                      teamNames.length ? teamNames.join(", ") : "Alice, Bob"
                    }
                    disabled={saving}
                    autoComplete="off"
                  />
                </SettingsField>
              </div>
            ) : null}
          </SettingsSection>

          <SettingsSection className="border-0 bg-panel p-4">
            <div className="text-item-title font-medium text-fg">
              Before the first ad-hoc build
            </div>
            <ul className="m-0 mt-2 grid list-none gap-2 p-0">
              <ReadinessRow ready={status.host.releaseCapable}>
                Xcode and its command-line tools are installed on this Mac.
              </ReadinessRow>
              <ReadinessRow>
                Apple Developer Program enrollment and agreements are active.
              </ReadinessRow>
              <ReadinessRow>
                An Apple Distribution certificate and private key are available
                in this Mac&rsquo;s Keychain.
              </ReadinessRow>
              <ReadinessRow>
                Target device UDIDs are registered in the Apple Developer
                portal.
              </ReadinessRow>
              <ReadinessRow>
                The App Store Connect API key can manage certificates,
                identifiers, and profiles.
              </ReadinessRow>
            </ul>
            <LinkChips
              links={[
                {
                  label: "App Store Connect API keys",
                  url: "https://appstoreconnect.apple.com/access/integrations/api",
                },
                {
                  label: "Certificates",
                  url: "https://developer.apple.com/account/resources/certificates/list",
                },
                {
                  label: "Devices",
                  url: "https://developer.apple.com/account/resources/devices/list",
                },
              ]}
            />
            <p className="m-0 mt-3 text-meta leading-relaxed text-faint">
              The private key must be mode 0600 and outside every allowed
              project root. Release execution still waits for explicit approval
              of the full commit SHA. It cannot submit for App Review or publish
              an app.
            </p>
          </SettingsSection>
        </div>

        <Modal.Footer>
          <Modal.Close
            render={
              <Button className="phone:min-h-11" disabled={saving}>
                Cancel
              </Button>
            }
          />
          <Button
            className="phone:min-h-11"
            variant="primary"
            onClick={() => void save()}
            disabled={saving}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}

export function AppleMobileIntegration({ teamNames }: { teamNames: string[] }) {
  const [status, setStatus] = useState<AppleMobileSetupStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let active = true;
    fetchAppleMobileSetup()
      .then((next) => {
        if (active) setStatus(next);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, []);

  if (!status) {
    return failed ? (
      <InlineAlert>Couldn&rsquo;t load Apple mobile setup.</InlineAlert>
    ) : (
      <SettingCardSkeleton rows={1} icon={40} label="Loading Apple mobile" />
    );
  }

  const tone = status.releaseEnabled
    ? "on"
    : status.buildEnabled
      ? "warn"
      : "off";
  const label = status.releaseEnabled
    ? "Build and release ready"
    : status.buildEnabled
      ? "Development only"
      : "Off";

  return (
    <>
      <SettingCard>
        <div className="flex flex-wrap items-start gap-3 px-5 py-4">
          <IconTile name="apple-mobile" size={40} />
          <div className="min-w-[14rem] flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-item-title font-semibold text-fg">
                Apple mobile
              </div>
              <StateChip tone={tone} label={label} />
            </div>
            <p className="m-0 mt-1 text-supporting leading-relaxed text-dim">
              SwiftPM and xtool development builds with restricted Xcode
              releases.
            </p>
          </div>
          <Button
            size="sm"
            className="ml-auto phone:min-h-11"
            variant={tone === "off" ? "primary" : "default"}
            onClick={() => setOpen(true)}
          >
            {tone === "off" ? "Set up" : "Configure"}
          </Button>
        </div>
      </SettingCard>
      <AppleMobileSetupDialog
        open={open}
        status={status}
        teamNames={teamNames}
        onOpenChange={setOpen}
        onSaved={setStatus}
      />
    </>
  );
}
