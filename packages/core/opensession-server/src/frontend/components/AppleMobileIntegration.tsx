import { mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import { useEffect, useState } from "react";
import {
  approveAppleRelease,
  fetchAppleMobileSetup,
  fetchAppleReleaseApprovals,
  saveAppleMobileSetup,
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
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  flex: {
    display: "flex",
  },
  itemsStart: {
    alignItems: "flex-start",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  leadingRelaxed: {
    lineHeight: "var(--leading-relaxed)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap25: {
    gap: "calc(4px * 2.5)",
  },
  flexCol: {
    flexDirection: "column",
  },
  gap4: {
    gap: "calc(4px * 4)",
  },
  border0: {
    borderStyle: "solid",
    borderWidth: "0px",
  },
  bgPanel: {
    backgroundColor: "var(--bg-panel)",
  },
  p4: {
    padding: "calc(4px * 4)",
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
  grid: {
    display: "grid",
  },
  gridCols2: {
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  },
  gap3: {
    gap: "calc(4px * 3)",
  },
  phoneGridCols1: {
    "@media (max-width: 720px)": {
      gridTemplateColumns: "repeat(1, minmax(0, 1fr))",
    },
  },
  colSpan2: {
    gridColumn: "span 2 / span 2",
  },
  phoneColSpan1: {
    "@media (max-width: 720px)": {
      gridColumn: "span 1 / span 1",
    },
  },
  m0: {
    margin: "0",
  },
  mt1: {
    marginTop: "4px",
  },
  mt3: {
    marginTop: "calc(4px * 3)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  roundedControl: {
    borderRadius: "calc(12px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  bgSurface: {
    backgroundColor: "var(--bg)",
  },
  p3: {
    padding: "calc(4px * 3)",
  },
  flexWrap: {
    flexWrap: "wrap",
  },
  mt2: {
    marginTop: "calc(4px * 2)",
  },
  gap15: {
    gap: "calc(4px * 1.5)",
  },
  block: {
    display: "block",
  },
  breakAll: {
    wordBreak: "break-all",
  },
  phoneMinH11: {
    "@media (max-width: 720px)": {
      minHeight: "calc(4px * 11)",
    },
  },
  listNone: {
    listStyleType: "none",
  },
  p0: {
    padding: "0",
  },
  px5: {
    paddingInline: "calc(4px * 5)",
  },
  py4: {
    paddingBlock: "calc(4px * 4)",
  },
  minW14rem: {
    minWidth: "14rem",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  mlAuto: {
    marginLeft: "auto",
  },
});

function ReadinessRow({
  ready,
  children,
}: {
  ready?: boolean;
  children: string;
}) {
  return (
    <li
      {...stylex.props(
        sx.flex,
        sx.itemsStart,
        sx.gap2,
        sx.leadingRelaxed,
        sx.textDim,
        typography.supporting,
      )}
    >
      <span
        className={
          ready === true
            ? utilityClassName("text-green")
            : utilityClassName("text-faint")
        }
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
      const updated = await saveAppleMobileSetup({
        buildEnabled,
        releaseEnabled,
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
      <Modal.Content widthClassName={utilityClassName("max-w-[42rem]")}>
        <Modal.Header
          title={
            <span {...stylex.props(sx.flex, sx.itemsCenter, sx.gap25)}>
              <IconTile name="apple-mobile" size={28} />
              Apple mobile
            </span>
          }
          description="Build Swift apps without credentials, then add a tightly restricted release connection when this Mac is ready."
        />

        <div {...stylex.props(sx.flex, sx.flexCol, sx.gap4)}>
          {error ? <InlineAlert>{error}</InlineAlert> : null}

          <SettingsSection
            className={mergeStylexOverrideClassName(
              "",
              sx.flex,
              sx.flexCol,
              sx.gap4,
              sx.border0,
              sx.bgPanel,
              sx.p4,
            )}
          >
            <div {...stylex.props(sx.flex, sx.itemsCenter, sx.gap4)}>
              <div {...stylex.props(sx.minW0, sx.flex1)}>
                <div
                  {...stylex.props(
                    sx.fontMedium,
                    sx.textFg,
                    typography.itemTitle,
                  )}
                >
                  Development builds
                </div>
                <div
                  {...stylex.props(sx.mt05, sx.textDim, typography.supporting)}
                >
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

          <SettingsSection
            className={mergeStylexOverrideClassName(
              "",
              sx.flex,
              sx.flexCol,
              sx.gap4,
              sx.border0,
              sx.bgPanel,
              sx.p4,
            )}
          >
            <div {...stylex.props(sx.flex, sx.itemsCenter, sx.gap4)}>
              <div {...stylex.props(sx.minW0, sx.flex1)}>
                <div
                  {...stylex.props(
                    sx.fontMedium,
                    sx.textFg,
                    typography.itemTitle,
                  )}
                >
                  Ad-hoc and TestFlight releases
                </div>
                <div
                  {...stylex.props(sx.mt05, sx.textDim, typography.supporting)}
                >
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
              <div
                {...stylex.props(
                  sx.grid,
                  sx.gridCols2,
                  sx.gap3,
                  sx.phoneGridCols1,
                )}
              >
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
                <SettingsField
                  className={mergeStylexOverrideClassName(
                    "",
                    sx.colSpan2,
                    sx.phoneColSpan1,
                  )}
                >
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
            <SettingsSection
              className={mergeStylexOverrideClassName(
                "",
                sx.border0,
                sx.bgPanel,
                sx.p4,
              )}
            >
              <div
                {...stylex.props(
                  sx.fontMedium,
                  sx.textFg,
                  typography.itemTitle,
                )}
              >
                Release approvals
              </div>
              <p
                {...stylex.props(
                  sx.m0,
                  sx.mt1,
                  sx.leadingRelaxed,
                  sx.textDim,
                  typography.supporting,
                )}
              >
                Planning never authorizes execution. An allowed, signed-in
                person must approve the exact plan here in a later step.
              </p>
              {approvals ? (
                !approvals.authenticated ? (
                  <InlineAlert
                    className={mergeStylexOverrideClassName("", sx.mt3)}
                  >
                    Sign in with GitHub to approve Apple releases.
                  </InlineAlert>
                ) : !approvals.allowed ? (
                  <InlineAlert
                    className={mergeStylexOverrideClassName("", sx.mt3)}
                  >
                    Your account is not in the release allowlist.
                  </InlineAlert>
                ) : approvals.requests.length === 0 ? (
                  <div
                    {...stylex.props(
                      sx.mt3,
                      sx.textFaint,
                      typography.supporting,
                    )}
                  >
                    No release plans are waiting for approval.
                  </div>
                ) : (
                  <div {...stylex.props(sx.mt3, sx.grid, sx.gap2)}>
                    {approvals.requests.map((request) => (
                      <div
                        key={request.planId}
                        {...stylex.props(
                          sx.roundedControl,
                          sx.bgSurface,
                          sx.p3,
                        )}
                      >
                        <div
                          {...stylex.props(
                            sx.flex,
                            sx.flexWrap,
                            sx.itemsStart,
                            sx.gap3,
                          )}
                        >
                          <div {...stylex.props(sx.minW0, sx.flex1)}>
                            <div
                              {...stylex.props(
                                sx.fontMedium,
                                sx.textFg,
                                typography.itemTitle,
                              )}
                            >
                              {request.action === "adhoc"
                                ? "Ad-hoc export"
                                : request.action === "testflight"
                                  ? "TestFlight upload"
                                  : "IPA upload"}
                            </div>
                            {request.marketingVersion || request.buildNumber ? (
                              <div
                                {...stylex.props(
                                  sx.mt1,
                                  sx.textDim,
                                  typography.meta,
                                )}
                              >
                                {request.marketingVersion ??
                                  "Version unchanged"}
                                {request.buildNumber
                                  ? ` (${request.buildNumber})`
                                  : ""}
                              </div>
                            ) : null}
                            <dl
                              {...stylex.props(
                                sx.m0,
                                sx.mt2,
                                sx.grid,
                                sx.gap15,
                                typography.meta,
                              )}
                            >
                              <div>
                                <dt {...stylex.props(sx.textFaint)}>Project</dt>
                                <dd {...stylex.props(sx.m0)}>
                                  <code
                                    {...stylex.props(
                                      sx.block,
                                      sx.breakAll,
                                      sx.textDim,
                                    )}
                                  >
                                    {request.projectDir}
                                  </code>
                                </dd>
                              </div>
                              <div>
                                <dt {...stylex.props(sx.textFaint)}>Plan ID</dt>
                                <dd {...stylex.props(sx.m0)}>
                                  <code
                                    {...stylex.props(
                                      sx.block,
                                      sx.breakAll,
                                      sx.textDim,
                                    )}
                                  >
                                    {request.planId}
                                  </code>
                                </dd>
                              </div>
                              <div>
                                <dt {...stylex.props(sx.textFaint)}>Commit</dt>
                                <dd {...stylex.props(sx.m0)}>
                                  <code
                                    {...stylex.props(
                                      sx.block,
                                      sx.breakAll,
                                      sx.textDim,
                                    )}
                                  >
                                    {request.commit}
                                  </code>
                                </dd>
                              </div>
                              {request.action === "upload" ? (
                                <>
                                  <div>
                                    <dt {...stylex.props(sx.textFaint)}>
                                      Artifact
                                    </dt>
                                    <dd {...stylex.props(sx.m0)}>
                                      <code
                                        {...stylex.props(
                                          sx.block,
                                          sx.breakAll,
                                          sx.textDim,
                                        )}
                                      >
                                        {request.sourceArtifactName ??
                                          "Missing artifact name"}
                                      </code>
                                    </dd>
                                  </div>
                                  <div>
                                    <dt {...stylex.props(sx.textFaint)}>
                                      SHA-256
                                    </dt>
                                    <dd {...stylex.props(sx.m0)}>
                                      <code
                                        {...stylex.props(
                                          sx.block,
                                          sx.breakAll,
                                          sx.textDim,
                                        )}
                                      >
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
                            className={mergeStylexOverrideClassName(
                              "",
                              sx.phoneMinH11,
                            )}
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
                <div
                  {...stylex.props(sx.mt3, sx.textFaint, typography.supporting)}
                >
                  Checking for release plans…
                </div>
              )}
            </SettingsSection>
          ) : null}

          <SettingsSection
            className={mergeStylexOverrideClassName(
              "",
              sx.border0,
              sx.bgPanel,
              sx.p4,
            )}
          >
            <div
              {...stylex.props(sx.fontMedium, sx.textFg, typography.itemTitle)}
            >
              Before the first ad-hoc build
            </div>
            <ul
              {...stylex.props(
                sx.m0,
                sx.mt2,
                sx.grid,
                sx.listNone,
                sx.gap2,
                sx.p0,
              )}
            >
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
            <p
              {...stylex.props(
                sx.m0,
                sx.mt3,
                sx.leadingRelaxed,
                sx.textFaint,
                typography.meta,
              )}
            >
              The private key must be mode 0600 and outside the app project.
              Release execution still waits for explicit approval of the full
              commit SHA. It cannot submit for App Review or publish an app.
            </p>
          </SettingsSection>
        </div>

        <Modal.Footer>
          <Modal.Close
            render={
              <Button
                className={mergeStylexOverrideClassName("", sx.phoneMinH11)}
                disabled={saving}
              >
                Cancel
              </Button>
            }
          />
          <Button
            className={mergeStylexOverrideClassName("", sx.phoneMinH11)}
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
        <div
          {...stylex.props(
            sx.flex,
            sx.flexWrap,
            sx.itemsStart,
            sx.gap3,
            sx.px5,
            sx.py4,
          )}
        >
          <IconTile name="apple-mobile" size={40} />
          <div {...stylex.props(sx.minW14rem, sx.flex1)}>
            <div
              {...stylex.props(sx.flex, sx.flexWrap, sx.itemsCenter, sx.gap2)}
            >
              <div
                {...stylex.props(
                  sx.fontSemibold,
                  sx.textFg,
                  typography.itemTitle,
                )}
              >
                Apple mobile
              </div>
              <StateChip tone={tone} label={label} />
            </div>
            <p
              {...stylex.props(
                sx.m0,
                sx.mt1,
                sx.leadingRelaxed,
                sx.textDim,
                typography.supporting,
              )}
            >
              SwiftPM and xtool development builds with restricted Xcode
              releases.
            </p>
          </div>
          <Button
            size="sm"
            className={mergeStylexOverrideClassName(
              "",
              sx.mlAuto,
              sx.phoneMinH11,
            )}
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
