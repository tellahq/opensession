import { useEffect, useState } from "react";
import {
  approveAppleRelease,
  fetchAppleMobileSetup,
  fetchAppleReleaseApprovals,
  saveAppleMobileSetup,
  type AppleMobileSetupInput,
  type AppleMobileSetupStatus,
  type AppleReleaseApprovals,
} from "../lib/api/apple-mobile";
import { Button } from "../ui/button";
import { Modal } from "../ui/modal";
import {
  SettingCard,
  SettingCardSkeleton,
  SettingsField,
  SettingsSection,
  settingsInputClass,
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
  const [teamId, setTeamId] = useState(status.teamId);
  const [keyId, setKeyId] = useState("");
  const [issuerId, setIssuerId] = useState("");
  const [privateKeyPath, setPrivateKeyPath] = useState("");
  const [allowedUsers, setAllowedUsers] = useState(
    status.allowedUsers.join(", "),
  );
  const [saving, setSaving] = useState(false);
  const [approvals, setApprovals] = useState<AppleReleaseApprovals | null>(
    null,
  );
  const [approving, setApproving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setBuildEnabled(status.buildEnabled);
    setReleaseEnabled(status.releaseEnabled);
    setTeamId(status.teamId);
    setKeyId("");
    setIssuerId("");
    setPrivateKeyPath("");
    setAllowedUsers(status.allowedUsers.join(", "));
    setApprovals(null);
    setApproving(null);
    setError(null);
    void fetchAppleReleaseApprovals()
      .then(setApprovals)
      .catch((cause) =>
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not load Apple release approvals",
        ),
      );
  }, [open, status]);

  async function approve(planId: string) {
    if (approving) return;
    setApproving(planId);
    setError(null);
    try {
      await approveAppleRelease(planId);
      setApprovals(await fetchAppleReleaseApprovals());
      toast("Apple release approved");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not approve Apple release",
      );
    }
    setApproving(null);
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const input: AppleMobileSetupInput = {
        buildEnabled,
        releaseEnabled,
        teamId: teamId.trim(),
        allowedUsers: allowedUsers
          .split(",")
          .map((user) => user.trim())
          .filter(Boolean),
      };
      if (keyId.trim()) input.keyId = keyId.trim();
      if (issuerId.trim()) input.issuerId = issuerId.trim();
      if (privateKeyPath.trim()) input.privateKeyPath = privateKeyPath.trim();
      const updated = await saveAppleMobileSetup(input);
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

          {status.releaseEnabled ? (
            <SettingsSection className="border-0 bg-panel p-4">
              <div className="text-item-title font-medium text-fg">
                Release approvals
              </div>
              <p className="m-0 mt-1 text-supporting leading-relaxed text-dim">
                Planning never authorizes execution. An allowed, signed-in
                person must approve the exact plan here in a later step.
              </p>
              {approvals ? (
                !approvals.authenticated ? (
                  <InlineAlert className="mt-3">
                    Sign in with GitHub to approve Apple releases.
                  </InlineAlert>
                ) : !approvals.allowed ? (
                  <InlineAlert className="mt-3">
                    Your account is not in the release allowlist.
                  </InlineAlert>
                ) : approvals.requests.length === 0 ? (
                  <div className="mt-3 text-supporting text-faint">
                    No release plans are waiting for approval.
                  </div>
                ) : (
                  <div className="mt-3 grid gap-2">
                    {approvals.requests.map((request) => (
                      <div
                        key={request.planId}
                        className="rounded-control bg-surface p-3"
                      >
                        <div className="flex flex-wrap items-start gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="text-item-title font-medium text-fg">
                              {request.action === "adhoc"
                                ? "Ad-hoc export"
                                : request.action === "testflight"
                                  ? "TestFlight upload"
                                  : "IPA upload"}
                            </div>
                            {request.marketingVersion || request.buildNumber ? (
                              <div className="mt-1 text-meta text-dim">
                                {request.marketingVersion ??
                                  "Version unchanged"}
                                {request.buildNumber
                                  ? ` (${request.buildNumber})`
                                  : ""}
                              </div>
                            ) : null}
                            <dl className="m-0 mt-2 grid gap-1.5 text-meta">
                              <div>
                                <dt className="text-faint">Project</dt>
                                <dd className="m-0">
                                  <code className="block break-all text-dim">
                                    {request.projectDir}
                                  </code>
                                </dd>
                              </div>
                              <div>
                                <dt className="text-faint">Plan ID</dt>
                                <dd className="m-0">
                                  <code className="block break-all text-dim">
                                    {request.planId}
                                  </code>
                                </dd>
                              </div>
                              <div>
                                <dt className="text-faint">Commit</dt>
                                <dd className="m-0">
                                  <code className="block break-all text-dim">
                                    {request.commit}
                                  </code>
                                </dd>
                              </div>
                              {request.action === "upload" ? (
                                <>
                                  <div>
                                    <dt className="text-faint">Artifact</dt>
                                    <dd className="m-0">
                                      <code className="block break-all text-dim">
                                        {request.sourceArtifactName ??
                                          "Missing artifact name"}
                                      </code>
                                    </dd>
                                  </div>
                                  <div>
                                    <dt className="text-faint">SHA-256</dt>
                                    <dd className="m-0">
                                      <code className="block break-all text-dim">
                                        {request.sourceArtifactSha256 ??
                                          "Missing artifact hash"}
                                      </code>
                                    </dd>
                                  </div>
                                </>
                              ) : null}
                            </dl>
                          </div>
                          <Button
                            size="sm"
                            className="phone:min-h-11"
                            variant="primary"
                            disabled={approving !== null}
                            onClick={() => void approve(request.planId)}
                          >
                            {approving === request.planId
                              ? "Approving…"
                              : "Approve"}
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )
              ) : (
                <div className="mt-3 text-supporting text-faint">
                  Checking for release plans…
                </div>
              )}
            </SettingsSection>
          ) : null}

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
              The private key must be mode 0600 and outside the app project.
              Release execution still waits for explicit approval of the full
              commit SHA. It cannot submit for App Review or publish an app.
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
