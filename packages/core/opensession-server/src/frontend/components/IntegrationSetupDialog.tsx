import { useEffect, useState, type ReactNode } from "react";
import { Button } from "../ui/button";
import { Disclosure } from "../ui/disclosure";
import { Modal } from "../ui/modal";
import { SettingsSection } from "../ui/settings";
import { InlineAlert } from "../ui/state";
import { Segmented, SegmentedOption } from "../ui/segmented";
import { Switch } from "../ui/switch";
import { toast } from "../ui/toast";
import { WEBHOOK_BASE_URL } from "../lib/brand";
import { SLACK_SCOPE_GROUPS } from "../lib/slack-manifest";
import {
  publicWebhookAvailable,
  savedSlackTransport,
  slackCredentialRequired,
  type SlackTransport,
} from "../lib/slack-setup";
import { IconTile } from "./BrandTile";
import { CodeStorageConfiguration } from "./CodeStorageConfiguration";
import { GithubAppFields } from "./GithubAppFields";
import { PlainRouterConfiguration } from "./PlainRouterConfiguration";
import { SlackManifestGuide } from "./SlackManifestGuide";
import {
  Code,
  CopyableCode,
  GuideBlock,
  LinkChips,
  ScopeGroups,
  SecretField,
  SetupSteps,
  setupRequest,
  type SetupGithub,
  type SetupIntegration,
  type SetupScopeGroup,
} from "./setup-shared";

// One integration's whole configuration, in the order you work through it:
// the switch and the credential fields first, the provider's recipe behind a
// disclosure under them. It used to run the other way — five numbered steps
// and four paragraphs of scopes ahead of the form — so anyone opening the
// dialog a second time scrolled past a page of documentation to reach the two
// fields they came for, and on a laptop the first field was below the fold.

function Value({ value }: { value: string }) {
  return (
    <span className="mt-1.5 block">
      <CopyableCode value={value} />
    </span>
  );
}

function ConfigurationSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <header className="px-1">
        <h3 className="m-0 text-item-title font-semibold text-fg">{title}</h3>
        {description && (
          <p className="m-0 mt-0.5 text-supporting leading-relaxed text-dim">
            {description}
          </p>
        )}
      </header>
      <SettingsSection className="border-0 bg-panel p-4">
        {children}
      </SettingsSection>
    </section>
  );
}

type Guide = {
  description: string;
  /** Rendered above the numbered steps, for a provider that can be set up
   *  from generated config rather than transcription — Slack's manifest. */
  intro?: ReactNode;
  steps: ReactNode[];
  /** Permission tokens you transcribe into the provider's own form. Data,
   *  rather than bold runs inside a sentence — see ScopeGroups. */
  scopes?: SetupScopeGroup[];
  /** One line that finishes the scope list, for the thing a person looking at
   *  it wonders next ("do I need file access?"). */
  scopesNote?: ReactNode;
  permissions?: ReactNode[];
  note?: ReactNode;
};

type GithubSetupUpdate = {
  oauthClientId?: string;
  appSlug?: string;
  installationOwner?: string;
  oauthClientSecret?: string;
  privateKey?: string;
};

type IntegrationSetupUpdate = {
  enabled?: boolean;
  env?: Record<string, string>;
};

function endpoint(publicBaseUrl: string, path: string): string {
  return `${publicBaseUrl.replace(/\/$/, "")}${path}`;
}

function guideFor(
  integration: SetupIntegration,
  publicBaseUrl: string,
  transport: SlackTransport,
): Guide {
  const url = (path: string) => endpoint(publicBaseUrl, path);

  switch (integration.id) {
    case "plain":
      return {
        description:
          "Connect a Plain machine user and send support webhooks to Open Session.",
        steps: [
          <>In Plain, create a machine user and generate its API key.</>,
          <>
            Create a webhook for <strong>thread created</strong>,{" "}
            <strong>thread status transitioned</strong>, and{" "}
            <strong>thread note created</strong>. Use this endpoint:
            <Value value={url("/plain/webhook")} />
          </>,
          <>
            Paste the API key and webhook signing secret into the fields above.
          </>,
          <>
            Enable Plain, save, and restart Open Session. Then send a test
            webhook from Plain.
          </>,
        ],
        permissions: [
          <>
            Give the machine user access to read threads and create internal
            notes.
          </>,
          <>
            Keep customer replies human-controlled; the built-in triage flow
            writes an internal note, not a customer reply.
          </>,
        ],
      };

    case "linear":
      return {
        description:
          "Create a Linear app that can receive agent assignments and work with issues.",
        steps: [
          <>
            Create an OAuth application in Linear and enable its app/agent actor
            capability.
          </>,
          <>
            Set the OAuth callback URL to exactly:
            <Value value={url("/oauth/callback")} />
          </>,
          <>
            Create a Linear webhook for agent-session and issue events. Use this
            endpoint:
            <Value value={url("/webhook")} />
          </>,
          <>
            Paste the client id, client secret, webhook secret, and API key into
            the fields above.
          </>,
          <>
            Enable Linear, save, restart Open Session, then install and
            authorize the app in your workspace.
          </>,
        ],
        scopes: [
          { label: "OAuth scopes", items: ["app:assignable", "read", "write"] },
        ],
        permissions: [
          <>
            The optional API key is used for direct issue reads and writes when
            no stored OAuth grant is available.
          </>,
        ],
      };

    case "slack": {
      const socket = transport === "socket";
      return {
        description:
          "Create a Slack bot for DMs, mentions, session channels, and interactive controls.",
        intro: <SlackManifestGuide transport={transport} />,
        steps: [
          <>
            Create the app from the manifest above, then install it to your
            workspace.
          </>,
          socket ? (
            <>
              Open <strong>Basic Information → App-Level Tokens</strong>,
              generate a token with the <strong>connections:write</strong>{" "}
              scope, and paste the <Code>xapp-</Code> value into{" "}
              <Code>SLACK_APP_TOKEN</Code> above.
            </>
          ) : (
            <>
              Copy the signing secret from <strong>Basic Information</strong>{" "}
              into <Code>SLACK_SIGNING_SECRET</Code> above. The manifest already
              includes the event and interactivity request URLs.
            </>
          ),
          <>
            Copy the bot token from <strong>OAuth &amp; Permissions</strong>{" "}
            after installing, and set an allowed Slack user id so admin tools
            are not open to every workspace member.
          </>,
          <>
            Enable Slack, save, restart Open Session, and invite the bot to
            every existing channel it should read.
          </>,
        ],
        // Same list the manifest carries, so the chips and the generated app
        // can never drift apart. Keep it visible for someone reviewing an
        // existing app rather than creating a new one.
        scopes: SLACK_SCOPE_GROUPS,
        scopesNote: socket ? (
          <>
            The manifest grants all of these. The app-level token only needs{" "}
            <strong>connections:write</strong>.
          </>
        ) : (
          <>The manifest grants all of these and enables interactivity.</>
        ),
      };
    }

    case "stripe":
      return {
        description:
          "Receive dispute events from Stripe and route them into a scoped automation.",
        steps: [
          <>
            Create a Stripe webhook endpoint at:
            <Value value={url("/stripe/webhook")} />
          </>,
          <>
            Subscribe it only to <strong>charge.dispute.created</strong>.
          </>,
          <>
            Reveal the endpoint signing secret and paste it into the field
            above.
          </>,
          <>
            Enable Stripe, save, restart Open Session, then send a test dispute
            event.
          </>,
        ],
        permissions: [
          <>
            The webhook integration needs no Stripe API key; it only verifies
            and receives the selected event.
          </>,
          <>
            If you separately connect Stripe MCP, use a restricted key with read
            access to the billing data you need and only the narrow write
            permissions you explicitly intend.
          </>,
        ],
        note: (
          <>
            Money-moving Stripe tools remain unavailable to agent runs even when
            the MCP server has a write-capable key.
          </>
        ),
      };

    case "grafana":
      return {
        description:
          "Let Open Session query Loki for failure signatures and start investigation automations.",
        steps: [
          <>Create a Grafana service account dedicated to Open Session.</>,
          <>Generate a service-account token and copy your Grafana base URL.</>,
          <>
            Paste both values above. If your Loki datasource is not named{" "}
            <strong>loki</strong>, also enter its datasource UID.
          </>,
          <>
            Enable the poller, save, restart Open Session, then configure a
            Grafana poll on the automation that should investigate matches.
          </>,
        ],
        permissions: [
          <>
            Grant only enough Grafana access to query the selected Loki
            datasource.
          </>,
          <>No Grafana admin or dashboard-write permission is needed.</>,
        ],
      };

    case "github":
      return {
        description:
          "Connect the GitHub App that handles PR comments, reviews, clones, and pushes.",
        steps: [
          <>
            Create an organization-owned GitHub App and turn on{" "}
            <strong>Device Flow</strong>.
          </>,
          <>
            Grant the repository and organization permissions shown below, then
            install the App only on the repositories Open Session should reach.
          </>,
          <>
            Enter the client id, app slug, installation owner, and client secret
            above, then upload the generated private key.
          </>,
          <>
            Add an organization webhook with content type{" "}
            <strong>application/json</strong> and this payload URL:
            <Value value={url("/github/webhook")} />
          </>,
          <>
            Create a webhook secret, paste it both into GitHub and above, then
            add any additional @handles that should wake the PR agent.
          </>,
          <>
            Enable GitHub, save, restart Open Session, and send a webhook test
            delivery.
          </>,
        ],
        permissions: [
          <>
            Repository:{" "}
            <strong>Actions, Checks, Commit statuses, Deployments</strong> read;{" "}
            <strong>Contents, Issues, Pull requests</strong> read and write;
            Metadata read.
          </>,
          <>
            Organization: <strong>Members</strong> read.
          </>,
          <>
            Webhook events: issue comments, pull requests, pull-request reviews
            and review comments, and workflow runs.
          </>,
        ],
      };

    case "codestorage":
      return {
        description:
          "Connect a code.storage organization with a local signing key instead of a long-lived token.",
        steps: [
          <>Create or choose your organization in code.storage.</>,
          <>
            Generate a PKCS8 ES256 or RS256 keypair. Register the public key
            with the organization and keep the private key on this Open Session
            host.
          </>,
          <>
            Enter the organization id and private key above. Open Session stores
            the key with mode 0600 and verifies the connection.
          </>,
          <>
            Register or clone a code.storage repository from the Repositories
            setup page.
          </>,
        ],
        permissions: [
          <>
            The registered organization key must allow Git read and write for
            the repositories Open Session will use.
          </>,
          <>
            There are no user seats, OAuth grants, or personal access tokens to
            configure.
          </>,
        ],
      };

    default:
      return {
        description: `Connect ${integration.label} to Open Session.`,
        steps: [
          <>Create the provider credentials linked below.</>,
          <>Paste each value into its matching field above.</>,
          <>Enable the integration, save, and restart Open Session.</>,
        ],
      };
  }
}

export function IntegrationSetupDialog({
  integration,
  open,
  onOpenChange,
  onSaved,
  github,
  onGithubSaved,
  githubManifestSetup,
}: {
  integration: SetupIntegration;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (updated: SetupIntegration, restartRequired: boolean) => void;
  github?: SetupGithub;
  onGithubSaved?: (updated: SetupGithub, restartRequired: boolean) => void;
  githubManifestSetup?: ReactNode;
}) {
  const [enabled, setEnabled] = useState(integration.enabled);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [cleared, setCleared] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transport, setTransport] = useState<SlackTransport>(() =>
    savedSlackTransport(integration.env),
  );
  const [clientId, setClientId] = useState("");
  const [appSlug, setAppSlug] = useState(github?.appSlug ?? "");
  const [installationOwner, setInstallationOwner] = useState(
    github?.installationOwner ?? github?.appOrg ?? "",
  );
  const [clientSecret, setClientSecret] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [clearClientId, setClearClientId] = useState(false);
  const [clearClientSecret, setClearClientSecret] = useState(false);
  const guide = guideFor(integration, WEBHOOK_BASE_URL, transport);
  const httpAvailable = publicWebhookAvailable(WEBHOOK_BASE_URL);

  // Cancel discards a transport change just like it discards typed credentials.
  useEffect(() => {
    if (!open) return;
    setEnabled(integration.enabled);
    setTyped({});
    setCleared({});
    setError(null);
    setTransport(savedSlackTransport(integration.env));
    setClientId("");
    setAppSlug(github?.appSlug ?? "");
    setInstallationOwner(github?.installationOwner ?? github?.appOrg ?? "");
    setClientSecret("");
    setPrivateKey("");
    setClearClientId(false);
    setClearClientSecret(false);
  }, [open, integration, github]);

  function pickTransport(next: SlackTransport) {
    setTransport(next);
    setTyped((current) => ({ ...current, SLACK_APP_TOKEN: "" }));
    setCleared((current) => ({ ...current, SLACK_APP_TOKEN: next === "http" }));
  }

  const hiddenEnvKey =
    integration.id === "slack"
      ? transport === "socket"
        ? "SLACK_SIGNING_SECRET"
        : "SLACK_APP_TOKEN"
      : null;
  const visibleEnv = hiddenEnvKey
    ? integration.env.filter((envVar) => envVar.name !== hiddenEnvKey)
    : integration.env;

  const typedKeys = integration.env
    .map((envVar) => envVar.name)
    .filter((name) => (typed[name] ?? "").trim() !== "");
  const clearedKeys = integration.env
    .filter(
      (envVar) =>
        envVar.present &&
        cleared[envVar.name] &&
        !(typed[envVar.name] ?? "").trim(),
    )
    .map((envVar) => envVar.name);
  const integrationDirty =
    enabled !== integration.enabled ||
    typedKeys.length > 0 ||
    clearedKeys.length > 0;
  const clientIdCleared =
    Boolean(github?.clientIdConfigured) && clearClientId && !clientId.trim();
  const clientSecretCleared =
    Boolean(github?.clientSecretConfigured) &&
    clearClientSecret &&
    !clientSecret.trim();
  const githubDirty =
    Boolean(github) &&
    (clientId.trim() !== "" ||
      appSlug.trim() !== (github?.appSlug ?? "") ||
      installationOwner.trim() !==
        (github?.installationOwner ?? github?.appOrg ?? "") ||
      clientSecret.trim() !== "" ||
      privateKey.trim() !== "" ||
      clientIdCleared ||
      clientSecretCleared);
  const dirty = integrationDirty || githubDirty;

  // code.storage owns its enabled state through the organization connection
  // below rather than the registry's generic switch.
  const canToggle = integration.id !== "codestorage";
  const configured =
    integration.env.some((envVar) => envVar.present) ||
    Boolean(github?.appCredentialConfigured);
  const setupLinks = github
    ? [
        { label: "Create GitHub App", url: github.appCreateUrl },
        ...integration.links,
      ]
    : integration.links;

  async function refreshIntegration() {
    const body = await setupRequest<{ integrations: SetupIntegration[] }>(
      "/api/setup/status",
    );
    const updated = body.integrations.find(
      (item) => item.id === integration.id,
    );
    if (updated) onSaved(updated, false);
  }

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    await (async () => {
      let githubResult: {
        github: SetupGithub;
        restartRequired: boolean;
      } | null = null;
      if (githubDirty && github) {
        const update: GithubSetupUpdate = {};
        if (clientId.trim()) update.oauthClientId = clientId.trim();
        else if (clientIdCleared) update.oauthClientId = "";
        if (appSlug.trim() !== (github.appSlug ?? ""))
          update.appSlug = appSlug.trim();
        if (
          installationOwner.trim() !==
          (github.installationOwner ?? github.appOrg ?? "")
        )
          update.installationOwner = installationOwner.trim();
        if (clientSecret.trim())
          update.oauthClientSecret = clientSecret.replace(/\s+/g, "");
        else if (clientSecretCleared) update.oauthClientSecret = "";
        if (privateKey.trim()) update.privateKey = privateKey.trim();

        githubResult = await setupRequest<{
          github: SetupGithub;
          restartRequired: boolean;
        }>("/api/setup/github", {
          method: "PUT",
          json: update,
        });
      }

      let integrationResult: {
        integration: SetupIntegration;
        restartRequired: boolean;
      } | null = null;
      if (integrationDirty) {
        const env: Record<string, string> = {};
        for (const name of typedKeys)
          env[name] = (typed[name] ?? "").replace(/\s+/g, "");
        for (const name of clearedKeys) env[name] = "";
        const update: IntegrationSetupUpdate = {};
        if (enabled !== integration.enabled) update.enabled = enabled;
        if (Object.keys(env).length > 0) update.env = env;
        integrationResult = await setupRequest<{
          integration: SetupIntegration;
          restartRequired: boolean;
        }>(`/api/setup/integrations/${encodeURIComponent(integration.id)}`, {
          method: "PUT",
          json: update,
        });
      }

      setTyped({});
      setCleared({});
      setClientId("");
      setClientSecret("");
      setPrivateKey("");
      setClearClientId(false);
      setClearClientSecret(false);
      if (githubResult)
        onGithubSaved?.(
          githubResult.github,
          githubResult.restartRequired === true,
        );
      if (integrationResult)
        onSaved(
          integrationResult.integration,
          integrationResult.restartRequired !== false,
        );
      toast(`${integration.label} saved`);
      onOpenChange(false);
    })().catch((cause) => {
      setError(
        cause instanceof Error
          ? cause.message
          : `Could not save ${integration.label}`,
      );
    });
    setSaving(false);
  }

  if (integration.id === "github" && githubManifestSetup) {
    return (
      <Modal.Root open={open} onOpenChange={onOpenChange}>
        <Modal.Content widthClassName="max-w-[34rem]">
          <Modal.Header
            title={
              <span className="flex items-center gap-2.5">
                <IconTile name="github" size={28} />
                GitHub App
              </span>
            }
            description="Create and install the App that connects GitHub to Open Session."
          />
          <SettingsSection className="flex flex-col gap-4 border-0 bg-panel p-4">
            {githubManifestSetup}
          </SettingsSection>
          <Modal.Footer>
            <Modal.Close render={<Button variant="primary">Done</Button>} />
          </Modal.Footer>
        </Modal.Content>
      </Modal.Root>
    );
  }

  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content widthClassName="max-w-[40rem]">
        <Modal.Header
          title={
            integration.id === "github" ? (
              integration.label
            ) : (
              <span className="flex items-center gap-2.5">
                <IconTile name={integration.id} size={28} />
                {integration.label}
              </span>
            )
          }
          description={guide.description}
        />

        {(canToggle || integration.env.length > 0) && (
          <div className="flex flex-col gap-4">
            {canToggle && (
              <SettingsSection className="flex items-center gap-4 border-0 bg-panel p-4">
                {integration.id === "github" && (
                  <IconTile name="github" size={40} />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-item-title font-medium text-fg">
                    Enable {integration.label}
                  </div>
                  <div className="mt-0.5 text-supporting text-dim">
                    Takes effect after you restart Open Session.
                  </div>
                </div>
                <Switch
                  checked={enabled}
                  onCheckedChange={setEnabled}
                  disabled={saving}
                  aria-label={`Enable ${integration.label}`}
                />
              </SettingsSection>
            )}
            {github && (
              <ConfigurationSection
                title="App credentials"
                description="Used for bot work and teammate GitHub connections."
              >
                <GithubAppFields
                  github={github}
                  saving={saving}
                  clientId={clientId}
                  appSlug={appSlug}
                  installationOwner={installationOwner}
                  clientSecret={clientSecret}
                  privateKey={privateKey}
                  clientIdCleared={clientIdCleared}
                  clientSecretCleared={clientSecretCleared}
                  onClientIdChange={(value) => {
                    setClientId(value);
                    if (value.trim()) setClearClientId(false);
                  }}
                  onToggleClientIdClear={() => {
                    setClearClientId((current) => !current);
                    setClientId("");
                  }}
                  onAppSlugChange={setAppSlug}
                  onInstallationOwnerChange={setInstallationOwner}
                  onClientSecretChange={(value) => {
                    setClientSecret(value);
                    if (value.trim()) setClearClientSecret(false);
                  }}
                  onToggleClientSecretClear={() => {
                    setClearClientSecret((current) => !current);
                    setClientSecret("");
                  }}
                  onPrivateKeyChange={setPrivateKey}
                />
              </ConfigurationSection>
            )}
            {integration.id === "slack" && (
              <ConfigurationSection title="Event delivery">
                <div className="flex flex-wrap items-center gap-4">
                  <div className="min-w-[12rem] flex-1 text-supporting text-dim">
                    {transport === "socket"
                      ? "Uses an outbound connection and needs no public webhook URL."
                      : "Slack posts events to this instance's public webhook URL."}
                  </div>
                  <Segmented
                    label="Slack event delivery"
                    value={transport}
                    onValueChange={(next) => {
                      if (next === "socket" || next === "http")
                        pickTransport(next);
                    }}
                    className="ml-auto phone:ml-0 phone:w-full"
                  >
                    <SegmentedOption
                      value="socket"
                      disabled={saving}
                      className="phone:min-h-11 phone:flex-1"
                    >
                      Socket Mode
                    </SegmentedOption>
                    <SegmentedOption
                      value="http"
                      disabled={saving || !httpAvailable}
                      className="phone:min-h-11 phone:flex-1"
                    >
                      HTTP
                    </SegmentedOption>
                  </Segmented>
                </div>
                {transport === "http" && !httpAvailable && (
                  <InlineAlert variant="warn" className="mt-3">
                    This instance has no public webhook URL. Choose Socket Mode
                    or configure a public URL first.
                  </InlineAlert>
                )}
              </ConfigurationSection>
            )}
            {visibleEnv.length > 0 && (
              <ConfigurationSection
                title={
                  integration.id === "github"
                    ? "Webhooks and mentions"
                    : "Credentials"
                }
                description={
                  integration.id === "github"
                    ? "Verify inbound events and choose extra handles that wake the PR agent."
                    : "Credentials stay on this server and are never shown back."
                }
              >
                <div className="flex flex-col gap-4">
                  {visibleEnv.map((envVar) => (
                    <SecretField
                      key={envVar.name}
                      name={envVar.name}
                      label={<Code>{envVar.name}</Code>}
                      description={envVar.description}
                      present={envVar.present}
                      required={
                        integration.id === "slack"
                          ? slackCredentialRequired(
                              envVar.name,
                              envVar.required,
                              transport,
                            )
                          : envVar.required
                      }
                      disabled={saving}
                      cleared={Boolean(
                        envVar.present &&
                        cleared[envVar.name] &&
                        !(typed[envVar.name] ?? "").trim(),
                      )}
                      value={typed[envVar.name] ?? ""}
                      onChange={(value) => {
                        setTyped((current) => ({
                          ...current,
                          [envVar.name]: value,
                        }));
                        if (value.trim() && cleared[envVar.name]) {
                          setCleared((current) => ({
                            ...current,
                            [envVar.name]: false,
                          }));
                        }
                      }}
                      onToggleClear={() => {
                        setCleared((current) => ({
                          ...current,
                          [envVar.name]: !current[envVar.name],
                        }));
                        setTyped((current) => ({
                          ...current,
                          [envVar.name]: "",
                        }));
                      }}
                    />
                  ))}
                </div>
              </ConfigurationSection>
            )}
          </div>
        )}

        {integration.id === "codestorage" && (
          <CodeStorageConfiguration onChanged={refreshIntegration} />
        )}
        {integration.id === "plain" && <PlainRouterConfiguration />}

        {/* Open on a first setup, closed once there are credentials to keep:
				    the recipe is a one-time read, the fields are not. */}
        <Disclosure
          title="Setup guide"
          defaultOpen={!configured}
          actions={<LinkChips links={setupLinks} className="mt-0" />}
        >
          <div className="flex flex-col gap-4">
            {guide.intro}
            <SetupSteps steps={guide.steps} />
            {guide.scopes && (
              <GuideBlock title="Bot scopes">
                <ScopeGroups groups={guide.scopes} />
                {guide.scopesNote && (
                  <p className="m-0 mt-2.5 text-supporting text-dim">
                    {guide.scopesNote}
                  </p>
                )}
              </GuideBlock>
            )}
            {guide.permissions && (
              <GuideBlock title="Permissions">
                <ul className="m-0 flex flex-col gap-1.5 pl-5 text-supporting leading-relaxed text-dim">
                  {guide.permissions.map((permission, index) => (
                    <li key={index}>{permission}</li>
                  ))}
                </ul>
              </GuideBlock>
            )}
            {guide.note && (
              <div className="rounded-lg bg-surface p-3 text-supporting leading-relaxed text-dim">
                {guide.note}
              </div>
            )}
          </div>
        </Disclosure>

        {error && <InlineAlert>{error}</InlineAlert>}

        {/* Nothing to change here means nothing to abandon, so the dialog
				    closes on one button rather than offering Cancel beside Done. */}
        <Modal.Footer>
          {canToggle || integration.env.length > 0 ? (
            <>
              <Modal.Close
                render={
                  <Button variant="ghost" disabled={saving}>
                    Cancel
                  </Button>
                }
              />
              <Button
                variant="primary"
                disabled={!dirty || saving}
                onClick={() => void save()}
              >
                {saving ? "Saving…" : "Save"}
              </Button>
            </>
          ) : (
            <Modal.Close render={<Button variant="primary">Done</Button>} />
          )}
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
