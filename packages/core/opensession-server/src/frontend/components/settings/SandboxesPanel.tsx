import { useEffect, useRef, useState } from "react";
import type {
  SandboxConnectionInfo,
  SandboxOperationInfo,
} from "../../lib/api";
import type { SandboxConnectionsResponse } from "../../lib/api/sandboxes";
import type {
  SandboxEnvironmentInfo,
  SandboxMachineSettings,
} from "../../lib/api/sandboxes";
import {
  connectSandbox,
  disconnectSandbox,
  fetchSandboxEnvironments,
  fetchSandboxConnections,
  rebuildSandboxEnvironment,
  testSandboxConnection,
  updateSandboxConnection,
} from "../../lib/api/sandboxes";
import { errorMessage } from "../../lib/error-message";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { Field, Input, Select } from "../../ui/input";
import { Modal } from "../../ui/modal";
import {
  SettingCard,
  SettingCardSkeleton,
  SettingsGroupLabel,
  SettingsHeader,
  SettingsHint,
  SettingsPanel,
} from "../../ui/settings";
import { InlineAlert } from "../../ui/state";
import { Switch } from "../../ui/switch";
import { toast } from "../../ui/toast";
import { IconCheck, IconPlus } from "../icons";
import { WorkspaceSandboxDefaults } from "./SandboxDefaults";
import { SandboxProviderLogo } from "./SandboxProviderLogo";

const PROVIDERS: Array<{
  id: SandboxConnectionInfo["provider"];
  label: string;
  description: string;
  command: string;
}> = [
  {
    id: "docker",
    label: "Docker",
    description:
      "Local container isolation using the Open Session runner image.",
    command: "opensession sandbox enable docker",
  },
  {
    id: "daytona",
    label: "Daytona",
    description:
      "Remote workspaces in your Daytona account, connected with your workspace API key.",
    command: "",
  },
  {
    id: "box",
    label: "Box",
    description:
      "Persistent Linux VMs in your Box account with fast snapshot restores and private previews.",
    command: "",
  },
  {
    id: "modal",
    label: "Modal",
    description:
      "Remote sandboxes in your Modal account, connected with a token pair.",
    command: "",
  },
];

const STATE_LABEL: Record<SandboxConnectionInfo["state"], string> = {
  not_configured: "Not configured",
  checking: "Checking",
  ready: "Ready",
  needs_attention: "Needs attention",
  disabled: "Disabled",
};

function statusClasses(state: SandboxConnectionInfo["state"]): string {
  if (state === "ready") return "bg-green-soft text-green";
  if (state === "needs_attention") return "bg-red-soft text-red";
  if (state === "checking") return "bg-accent-soft text-accent";
  return "bg-hover text-dim";
}

function latestOperation(
  provider: SandboxConnectionInfo["provider"],
  operations: SandboxOperationInfo[],
): SandboxOperationInfo | undefined {
  return operations.find(
    (operation) =>
      operation.provider === provider && operation.kind === "qualification",
  );
}

function providerLabel(provider: SandboxConnectionInfo["provider"]): string {
  return (
    PROVIDERS.find((candidate) => candidate.id === provider)?.label || provider
  );
}

function machineSummary(environment: SandboxEnvironmentInfo): string {
  const settings = environment.settings;
  if (!settings || !Object.keys(settings).length) {
    return "Provider defaults";
  }
  return [
    settings.cpu
      ? `${settings.cpu} ${environment.provider === "modal" ? "physical CPU" : "vCPU"}`
      : undefined,
    settings.memoryMb
      ? `${settings.memoryMb >= 1024 ? `${settings.memoryMb / 1024} GB` : `${settings.memoryMb} MB`} memory`
      : undefined,
    settings.diskGb ? `${settings.diskGb} GB disk` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

type MachineProfile = {
  id: string;
  label: string;
  detail: string;
  settings: SandboxMachineSettings;
};

const MACHINE_PROFILES: Record<"daytona" | "box" | "modal", MachineProfile[]> =
  {
    daytona: [
      {
        id: "small",
        label: "Small",
        detail: "1 vCPU · 1 GB · 3 GB disk",
        settings: { cpu: 1, memoryMb: 1024, diskGb: 3 },
      },
      {
        id: "medium",
        label: "Medium",
        detail: "2 vCPU · 4 GB · 8 GB disk",
        settings: { cpu: 2, memoryMb: 4096, diskGb: 8 },
      },
      {
        id: "large",
        label: "Large",
        detail: "4 vCPU · 8 GB · 10 GB disk",
        settings: { cpu: 4, memoryMb: 8192, diskGb: 10 },
      },
    ],
    box: [
      {
        id: "small",
        label: "Small",
        detail: "2 shared vCPU · 4 GB · 40+ GB SSD",
        settings: { cpu: 2, memoryMb: 4096, diskGb: 40 },
      },
      {
        id: "default",
        label: "Default",
        detail: "4 shared vCPU · 8 GB · 80+ GB SSD",
        settings: { cpu: 4, memoryMb: 8192, diskGb: 80 },
      },
      {
        id: "large",
        label: "Large",
        detail: "8 shared vCPU · 16 GB · 100+ GB SSD",
        settings: { cpu: 8, memoryMb: 16_384, diskGb: 100 },
      },
    ],
    modal: [
      {
        id: "efficient",
        label: "Efficient",
        detail: "0.5 physical CPU · 2 GB",
        settings: { cpu: 0.5, memoryMb: 2048 },
      },
      {
        id: "balanced",
        label: "Balanced",
        detail: "1 physical CPU · 4 GB",
        settings: { cpu: 1, memoryMb: 4096 },
      },
      {
        id: "performance",
        label: "Performance",
        detail: "2 physical CPUs · 8 GB",
        settings: { cpu: 2, memoryMb: 8192 },
      },
      {
        id: "power",
        label: "Power",
        detail: "8 physical CPUs · 16 GB",
        settings: { cpu: 8, memoryMb: 16_384 },
      },
    ],
  };

function machineProfiles(
  provider: SandboxConnectionInfo["provider"],
): MachineProfile[] {
  return provider === "daytona" || provider === "box" || provider === "modal"
    ? MACHINE_PROFILES[provider]
    : [];
}

function defaultMachineProfile(
  provider: SandboxConnectionInfo["provider"],
): string {
  if (provider === "daytona") return "medium";
  if (provider === "box") return "default";
  if (provider === "modal") return "balanced";
  return "large";
}

function machineProfileForSettings(
  provider: SandboxConnectionInfo["provider"],
  settings?: SandboxMachineSettings,
): string {
  if (!settings) return defaultMachineProfile(provider);
  return (
    machineProfiles(provider).find(
      (profile) =>
        profile.settings.cpu === settings.cpu &&
        profile.settings.memoryMb === settings.memoryMb &&
        profile.settings.diskGb === settings.diskGb,
    )?.id || defaultMachineProfile(provider)
  );
}

function ConnectDialog({
  connection,
  open,
  onOpenChange,
  onChanged,
}: {
  connection: SandboxConnectionInfo;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: (response: SandboxConnectionsResponse) => void;
}) {
  const provider = PROVIDERS.find(
    (candidate) => candidate.id === connection.provider,
  )!;
  const [apiKey, setApiKey] = useState("");
  const [tokenId, setTokenId] = useState("");
  const [tokenSecret, setTokenSecret] = useState("");
  const [region, setRegion] = useState(
    String(connection.settings.region || ""),
  );
  const [snapshot, setSnapshot] = useState(
    String(connection.settings.snapshot || ""),
  );
  const [app, setApp] = useState(String(connection.settings.app || ""));
  const [environment, setEnvironment] = useState(
    String(connection.settings.environment || ""),
  );
  const [cpu, setCpu] = useState(String(connection.settings.cpu || ""));
  const [memoryMb, setMemoryMb] = useState(
    String(connection.settings.memoryMb || ""),
  );
  const [saving, setSaving] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  // The credential field, so the dialog opens ready to paste rather than with
  // focus on its close button. Only one of the two branches below renders, so
  // they share the ref; Docker has no field at all and leaves it null, which
  // Base UI treats as "focus the first tabbable" exactly as before.
  const firstFieldRef = useRef<HTMLInputElement>(null);

  async function connect() {
    setSaving(true);
    await (async () => {
      const settings: NonNullable<
        Parameters<typeof connectSandbox>[1]["settings"]
      > = {};
      const body: Parameters<typeof connectSandbox>[1] = { settings };
      if (apiKey) body.apiKey = apiKey;
      if (tokenId) body.tokenId = tokenId;
      if (tokenSecret) body.tokenSecret = tokenSecret;
      if (region) settings.region = region;
      if (snapshot) settings.snapshot = snapshot;
      if (app) settings.app = app;
      if (environment) settings.environment = environment;
      if (cpu) settings.cpu = Number(cpu);
      if (memoryMb) settings.memoryMb = Number(memoryMb);
      const response = await connectSandbox(connection.provider, body);
      onChanged(response);
      onOpenChange(false);
      toast(`${provider.label} connection check started`, {
        variant: "success",
      });
    })()
      .catch(async (error) => {
        toast(errorMessage(error, `Failed to connect ${provider.label}`), {
          variant: "error",
        });
      })
      .finally(async () => {
        setSaving(false);
      });
  }

  async function disconnect() {
    setSaving(true);
    await (async () => {
      const response = await disconnectSandbox(connection.provider);
      onChanged(response);
      onOpenChange(false);
      toast(`${provider.label} disconnected`, { variant: "success" });
    })()
      .catch(async (error) => {
        toast(errorMessage(error, `Failed to disconnect ${provider.label}`), {
          variant: "error",
        });
      })
      .finally(async () => {
        setSaving(false);
      });
  }

  const exists = connection.state !== "not_configured";
  const remote =
    connection.provider === "daytona" ||
    connection.provider === "box" ||
    connection.provider === "modal";
  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        setConfirmingDisconnect(false);
        onOpenChange(next);
      }}
    >
      <Modal.Content
        widthClassName="max-w-[31rem]"
        initialFocus={firstFieldRef}
      >
        <Modal.Header
          title={`${exists ? "Configure" : "Connect"} ${provider.label}`}
          description={
            remote
              ? connection.provider === "box"
                ? "Credentials stay on this server. Open Session tests ingress, creates a disposable Box, verifies archive/resume and snapshot restore, then archives it."
                : "Credentials stay on this server. Open Session tests ingress, creates a disposable sandbox, restores a snapshot, and cleans up."
              : "Run the setup command on this machine, then let Open Session verify the runtime and snapshot path."
          }
        />

        {(connection.provider === "daytona" ||
          connection.provider === "box") && (
          <Field
            label={
              connection.provider === "box" ? "Box API key" : "Daytona API key"
            }
          >
            <Input
              ref={firstFieldRef}
              type="password"
              autoComplete="off"
              placeholder={
                connection.hasCredentials
                  ? "Leave blank to keep current key"
                  : `Enter ${connection.provider === "box" ? "box_…" : "API key"}`
              }
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </Field>
        )}

        {connection.provider === "modal" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Modal token ID">
              <Input
                ref={firstFieldRef}
                type="password"
                autoComplete="off"
                placeholder={
                  connection.hasCredentials ? "Keep current token" : "Token ID"
                }
                value={tokenId}
                onChange={(event) => setTokenId(event.target.value)}
              />
            </Field>
            <Field label="Modal token secret">
              <Input
                type="password"
                autoComplete="off"
                placeholder={
                  connection.hasCredentials
                    ? "Keep current secret"
                    : "Token secret"
                }
                value={tokenSecret}
                onChange={(event) => setTokenSecret(event.target.value)}
              />
            </Field>
          </div>
        )}

        {!remote && (
          <div className="rounded-lg bg-surface p-3">
            <div className="mb-1 text-label font-medium text-dim">
              Setup command
            </div>
            <code className="block select-all overflow-x-auto text-sm text-fg">
              {provider.command}
            </code>
          </div>
        )}

        {remote && (
          <>
            <p className="m-0 text-supporting text-dim">
              Remote providers use Public callback under Domains for webhooks
              and workload identity.
            </p>
            {connection.provider !== "box" && (
              <details className="rounded-lg bg-surface p-3 text-supporting text-dim">
                <summary className="cursor-pointer font-medium text-fg">
                  Provider settings
                </summary>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <Field label="Region">
                    <Input
                      value={region}
                      onChange={(event) => setRegion(event.target.value)}
                      placeholder="Provider default"
                    />
                  </Field>
                  <Field label="CPU">
                    <Input
                      type="number"
                      min="1"
                      value={cpu}
                      onChange={(event) => setCpu(event.target.value)}
                      placeholder="Provider default"
                    />
                  </Field>
                  <Field label="Memory (MB)">
                    <Input
                      type="number"
                      min="512"
                      value={memoryMb}
                      onChange={(event) => setMemoryMb(event.target.value)}
                      placeholder="Provider default"
                    />
                  </Field>
                  {connection.provider === "daytona" ? (
                    <Field label="Base snapshot">
                      <Input
                        value={snapshot}
                        onChange={(event) => setSnapshot(event.target.value)}
                        placeholder="Daytona default"
                      />
                    </Field>
                  ) : connection.provider === "modal" ? (
                    <>
                      <Field label="Modal app">
                        <Input
                          value={app}
                          onChange={(event) => setApp(event.target.value)}
                          placeholder="opensession-sandboxes"
                        />
                      </Field>
                      <Field label="Environment">
                        <Input
                          value={environment}
                          onChange={(event) =>
                            setEnvironment(event.target.value)
                          }
                          placeholder="Modal default"
                        />
                      </Field>
                    </>
                  ) : null}
                </div>
              </details>
            )}
          </>
        )}

        <Modal.Footer className="mt-1">
          {exists &&
            (confirmingDisconnect ? (
              <>
                <Button
                  variant="ghost"
                  onClick={() => setConfirmingDisconnect(false)}
                  disabled={saving}
                >
                  Keep connection
                </Button>
                <Button
                  variant="danger-strong"
                  onClick={() => void disconnect()}
                  disabled={saving}
                >
                  Disconnect now
                </Button>
              </>
            ) : (
              <Button
                variant="danger"
                onClick={() => setConfirmingDisconnect(true)}
                disabled={saving}
              >
                Disconnect
              </Button>
            ))}
          <span className="flex-1" />
          <Modal.Close
            render={
              <Button variant="ghost" disabled={saving}>
                Cancel
              </Button>
            }
          />
          <Button
            variant="primary"
            onClick={() => void connect()}
            disabled={saving}
          >
            {saving ? "Starting…" : remote ? "Connect and test" : "Test setup"}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}

function ConnectionCard({
  connection,
  operations,
  onChanged,
  canManage,
}: {
  connection: SandboxConnectionInfo;
  operations: SandboxOperationInfo[];
  onChanged: (response: SandboxConnectionsResponse) => void;
  canManage: boolean;
}) {
  const provider = PROVIDERS.find(
    (candidate) => candidate.id === connection.provider,
  )!;
  const operation = latestOperation(connection.provider, operations);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function testAgain() {
    setBusy(true);
    await (async () => {
      onChanged(await testSandboxConnection(connection.provider));
    })()
      .catch(async (error) => {
        toast(errorMessage(error, `Failed to test ${provider.label}`), {
          variant: "error",
        });
      })
      .finally(async () => {
        setBusy(false);
      });
  }

  async function toggle(enabled: boolean) {
    setBusy(true);
    await (async () => {
      onChanged(
        await updateSandboxConnection(connection.provider, { enabled }),
      );
    })()
      .catch(async (error) => {
        toast(errorMessage(error, `Failed to update ${provider.label}`), {
          variant: "error",
        });
      })
      .finally(async () => {
        setBusy(false);
      });
  }

  const checking =
    connection.state === "checking" || operation?.status === "running";
  const summary = checking
    ? operation?.stage || "Checking connection"
    : connection.qualification?.failureSummary;

  return (
    <>
      <SettingCard>
        <div className="grid grid-cols-[minmax(0,1fr)_5.75rem] gap-x-4 gap-y-3 px-5 py-4 desktop:grid-cols-[minmax(0,1fr)_13rem]">
          <div className="col-start-1 row-start-1 flex min-w-0 items-start gap-3">
            <SandboxProviderLogo provider={connection.provider} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <div className="text-item-title font-semibold text-fg">
                  {provider.label}
                </div>
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-meta font-medium",
                    statusClasses(checking ? "checking" : connection.state),
                  )}
                >
                  {checking ? "Checking" : STATE_LABEL[connection.state]}
                </span>
              </div>
              <p className="m-0 mt-1 text-supporting leading-relaxed text-dim">
                {provider.description}
              </p>
              {summary && (
                <p
                  className={cn(
                    "m-0 mt-2 text-supporting",
                    connection.state === "needs_attention"
                      ? "text-red"
                      : "text-dim",
                  )}
                >
                  {summary}
                </p>
              )}
            </div>
          </div>
          <div className="col-start-2 row-start-1 flex justify-end self-start">
            {connection.state === "not_configured" ? (
              <Button
                size="sm"
                variant="primary"
                onClick={() => setDialogOpen(true)}
                disabled={!canManage || checking}
              >
                {connection.provider === "docker" ? "Enable" : "Connect"}
              </Button>
            ) : (
              <Switch
                aria-label={`${connection.enabled ? "Disable" : "Enable"} ${provider.label}`}
                checked={connection.enabled}
                disabled={!canManage || busy || checking}
                onCheckedChange={(checked) => void toggle(checked)}
              />
            )}
          </div>
          {(connection.qualification ||
            connection.state !== "not_configured") && (
            <div className="col-span-2 row-start-2 flex items-baseline justify-between gap-4">
              {connection.qualification && (
                <details className="ml-10 min-w-0 text-meta text-faint">
                  <summary className="h-[26px] w-fit cursor-pointer select-none leading-[26px] hover:text-fg">
                    Diagnostics
                  </summary>
                  <div className="mt-1 grid gap-0.5 pl-3">
                    <span>Connection {connection.id}</span>
                    <span>
                      Adapter {connection.qualification.adapterSignature}
                    </span>
                    {connection.qualification.checkedAt && (
                      <span>
                        Checked{" "}
                        {new Date(
                          connection.qualification.checkedAt,
                        ).toLocaleString()}
                      </span>
                    )}
                    {connection.qualification.failureCode && (
                      <span>Code {connection.qualification.failureCode}</span>
                    )}
                  </div>
                </details>
              )}
              {connection.state !== "not_configured" && (
                <div className="ml-auto flex shrink-0 items-center gap-2">
                  {connection.state === "ready" && !checking && (
                    <Button
                      size="sm"
                      icon={<IconCheck size={17} />}
                      onClick={() => void testAgain()}
                      disabled={!canManage || busy}
                    >
                      Test again
                    </Button>
                  )}
                  <Button
                    size="sm"
                    onClick={() => setDialogOpen(true)}
                    disabled={!canManage || checking}
                  >
                    Configure
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </SettingCard>
      <ConnectDialog
        connection={connection}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onChanged={onChanged}
      />
    </>
  );
}

function ProjectEnvironmentDialog({
  open,
  onOpenChange,
  target,
  available,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target?: SandboxEnvironmentInfo;
  available: SandboxEnvironmentInfo[];
  onStarted: (
    operation: SandboxOperationInfo,
    environment: SandboxEnvironmentInfo,
    settings?: SandboxMachineSettings,
  ) => void;
}) {
  const first = target || available[0];
  const [provider, setProvider] = useState<SandboxConnectionInfo["provider"]>(
    first?.provider || "daytona",
  );
  const [repo, setRepo] = useState(first?.repo || "");
  const [profile, setProfile] = useState(
    machineProfileForSettings(first?.provider || "daytona", first?.settings),
  );
  const [saving, setSaving] = useState(false);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open && !wasOpen.current) {
      const selected = target || available[0];
      if (selected) {
        setProvider(selected.provider);
        setRepo(selected.repo);
        setProfile(
          machineProfileForSettings(selected.provider, selected.settings),
        );
      }
    }
    wasOpen.current = open;
  }, [open, target, available]);

  const providerOptions = Array.from(
    new Set(available.map((environment) => environment.provider)),
  );
  const projectOptions = available.filter(
    (environment) => environment.provider === provider,
  );
  const selected =
    target || projectOptions.find((environment) => environment.repo === repo);

  function chooseProvider(next: SandboxConnectionInfo["provider"]) {
    setProvider(next);
    const nextEnvironment = available.find(
      (environment) => environment.provider === next,
    );
    if (nextEnvironment) setRepo(nextEnvironment.repo);
    setProfile(defaultMachineProfile(next));
  }

  async function prepare() {
    if (!selected) return;
    const settings = machineProfiles(provider).find(
      (candidate) => candidate.id === profile,
    )?.settings;
    setSaving(true);
    await (async () => {
      const response = await rebuildSandboxEnvironment(
        selected.repo,
        provider,
        settings,
      );
      onStarted(response.operation, selected, settings);
      onOpenChange(false);
      toast(
        `${providerLabel(provider)} snapshot build started for ${selected.repo}`,
        {
          variant: "success",
        },
      );
    })()
      .catch(async (error) => {
        toast(errorMessage(error, "Failed to build project snapshot"), {
          variant: "error",
        });
      })
      .finally(async () => {
        setSaving(false);
      });
  }

  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content widthClassName="max-w-[32rem]">
        <Modal.Header
          title={
            target
              ? `Configure ${target.repo} snapshot`
              : "Create a project snapshot"
          }
          description="Open Session builds a reusable, credential-free project snapshot only when you opt in here. Each new session still gets its own isolated sandbox."
        />
        {!target ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Provider">
              <Select
                value={provider}
                onChange={(event) => {
                  const nextProvider = providerOptions.find(
                    (candidate) => candidate === event.target.value,
                  );
                  if (nextProvider) chooseProvider(nextProvider);
                }}
              >
                {providerOptions.map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {providerLabel(candidate)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Project">
              <Select
                value={repo}
                onChange={(event) => setRepo(event.target.value)}
              >
                {projectOptions.map((environment) => (
                  <option key={environment.repo} value={environment.repo}>
                    {environment.repo}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        ) : (
          <div className="flex items-center gap-3 rounded-lg bg-surface p-3">
            <SandboxProviderLogo provider={target.provider} />
            <div>
              <div className="text-item-title font-medium text-fg">
                {target.repo}
              </div>
              <div className="text-supporting text-dim">
                {providerLabel(target.provider)}
              </div>
            </div>
          </div>
        )}

        <Field label="Machine size">
          <Select
            value={profile}
            onChange={(event) => setProfile(event.target.value)}
          >
            {machineProfiles(provider).map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.label} · {candidate.detail}
              </option>
            ))}
          </Select>
        </Field>
        <div className="rounded-lg bg-surface p-3 text-supporting leading-relaxed text-dim">
          {provider === "daytona" &&
            "Daytona supports custom resource combinations, but these documented sizes avoid invalid or undersized setups."}
          {provider === "box" &&
            "Box exposes three fixed machine types. Stop and resume retain the disk, and new sandboxes restore from this project's named snapshot."}
          {provider === "modal" &&
            "Modal CPU values are physical cores and memory is a guaranteed request; workloads may burst when capacity is available."}
        </div>

        <Modal.Footer>
          <Modal.Close
            render={
              <Button variant="ghost" disabled={saving}>
                Cancel
              </Button>
            }
          />
          <Button
            variant="primary"
            onClick={() => void prepare()}
            disabled={saving || !selected}
          >
            {saving
              ? "Starting…"
              : target
                ? "Save and rebuild snapshot"
                : "Build snapshot"}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}

export function SandboxesPanel() {
  const [connections, setConnections] = useState<SandboxConnectionInfo[]>([]);
  const [operations, setOperations] = useState<SandboxOperationInfo[]>([]);
  const [environments, setEnvironments] = useState<SandboxEnvironmentInfo[]>(
    [],
  );
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [connectionsError, setConnectionsError] = useState<string | null>(null);
  const [environmentsError, setEnvironmentsError] = useState<string | null>(
    null,
  );
  const [environmentDialogOpen, setEnvironmentDialogOpen] = useState(false);
  const [environmentTarget, setEnvironmentTarget] =
    useState<SandboxEnvironmentInfo>();

  function apply(response: SandboxConnectionsResponse) {
    setConnections(response.connections);
    setOperations(response.operations);
    setCanManage(response.canManage);
  }

  const hasRunningValue = operations.some(
    (operation) => operation.status === "running",
  );
  useEffect(() => {
    let active = true;
    const load = () => {
      void fetchSandboxEnvironments()
        .then((response) => {
          if (!active) return;
          setEnvironments(response.environments);
          setEnvironmentsError(null);
        })
        .catch((error) => {
          if (active) {
            setEnvironmentsError(
              errorMessage(error, "Failed to load sandbox environments"),
            );
          }
        });
      return fetchSandboxConnections().then(
        (response) => {
          if (!active) return;
          apply(response);
          setConnectionsError(null);
          setLoading(false);
        },
        (error) => {
          if (!active) return;
          setConnectionsError(
            errorMessage(error, "Failed to load sandbox connections"),
          );
          setLoading(false);
        },
      );
    };
    void load();
    const interval = setInterval(() => {
      if (hasRunningValue) void load();
    }, 2_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [hasRunningValue]);

  function environmentStarted(
    operation: SandboxOperationInfo,
    environment: SandboxEnvironmentInfo,
    settings?: SandboxMachineSettings,
  ) {
    setOperations((current) => [operation, ...current]);
    setEnvironments((current) =>
      current.map((candidate) =>
        candidate.repo === environment.repo &&
        candidate.provider === environment.provider
          ? {
              ...candidate,
              state: "preparing",
              updatedAt: new Date().toISOString(),
              settings,
            }
          : candidate,
      ),
    );
  }

  const reusableEnvironments = environments.filter(
    (environment) =>
      environment.provider !== "docker" &&
      connections.some(
        (connection) =>
          connection.provider === environment.provider &&
          connection.state === "ready",
      ),
  );
  const configuredEnvironments = reusableEnvironments.filter(
    (environment) => environment.state !== "not_prepared",
  );
  const availableEnvironments = reusableEnvironments.filter(
    (environment) => environment.state === "not_prepared",
  );

  return (
    <SettingsPanel>
      <SettingsHeader
        title="Sandboxes"
        description="Connect compute you already pay for. Each session gets an isolated sandbox; project snapshots make new sandboxes start faster."
      />
      <WorkspaceSandboxDefaults canManage={canManage} />
      {connectionsError && <InlineAlert>{connectionsError}</InlineAlert>}
      {environmentsError && <InlineAlert>{environmentsError}</InlineAlert>}
      <SettingsGroupLabel>Connections</SettingsGroupLabel>
      {!canManage && (
        <SettingsHint>
          You can use Ready connections, but only a workspace administrator can
          configure them.
        </SettingsHint>
      )}
      <div className="grid gap-3">
        {loading && (
          <SettingCardSkeleton
            rows={3}
            icon={40}
            label="Loading sandbox connections"
          />
        )}
        {connections.map((connection) => (
          <ConnectionCard
            key={connection.provider}
            connection={connection}
            operations={operations}
            onChanged={apply}
            canManage={canManage}
          />
        ))}
      </div>
      <SettingsHint>
        None remains the default. Personal and per-session choices can override
        the workspace default.
      </SettingsHint>
      {reusableEnvironments.length > 0 && (
        <>
          <SettingsGroupLabel
            actions={
              availableEnvironments.length > 0 && (
                <Button
                  size="sm"
                  icon={<IconPlus size={16} />}
                  disabled={!canManage}
                  onClick={() => {
                    setEnvironmentTarget(undefined);
                    setEnvironmentDialogOpen(true);
                  }}
                >
                  Create snapshot
                </Button>
              )
            }
          >
            Project snapshots
          </SettingsGroupLabel>
          <div className="grid gap-3">
            {configuredEnvironments.length === 0 && (
              <SettingCard>
                <div className="px-5 py-5 text-center">
                  <div className="text-item-title font-medium text-fg">
                    No project snapshots
                  </div>
                  <p className="mx-auto mb-0 mt-1 max-w-[30rem] text-supporting leading-relaxed text-dim">
                    Choose only the projects that should get a reusable sandbox
                    snapshot. Nothing is built automatically.
                  </p>
                </div>
              </SettingCard>
            )}
            {configuredEnvironments.map((environment) => {
              const provider = PROVIDERS.find(
                (candidate) => candidate.id === environment.provider,
              )!;
              const operation = operations.find(
                (operation) =>
                  operation.kind === "environment_rebuild" &&
                  operation.repo === environment.repo &&
                  operation.provider === environment.provider,
              );
              const running = operation?.status === "running";
              const status = running
                ? operation.stage
                : environment.state === "ready"
                  ? "Snapshot ready"
                  : environment.state === "failed"
                    ? environment.failureSummary || "Setup failed"
                    : "Snapshot is stale";
              return (
                <SettingCard
                  key={`${environment.repo}:${environment.provider}`}
                >
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-3 px-5 py-3.5">
                    <div className="col-span-2 row-start-1 flex min-w-0 items-start gap-3">
                      <SandboxProviderLogo provider={environment.provider} />
                      <div className="min-w-0 flex-1">
                        <div className="text-item-title font-medium text-fg">
                          {environment.repo}
                        </div>
                        <div
                          className={cn(
                            "mt-0.5 text-supporting",
                            environment.state === "failed" && !running
                              ? "text-red"
                              : "text-dim",
                          )}
                        >
                          {provider.label} · {status}
                        </div>
                        <div className="mt-1 text-meta text-faint">
                          {machineSummary(environment)}
                        </div>
                        {running && (
                          <div className="mt-2 max-w-[24rem]">
                            <div className="h-1 overflow-hidden rounded-full bg-hover">
                              <div
                                className="h-full rounded-full bg-accent transition-[width] duration-[var(--dur)]"
                                style={{ width: `${operation.progress || 2}%` }}
                              />
                            </div>
                            {operation.detail && (
                              <div className="mt-1 text-meta text-faint">
                                {operation.detail}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="col-span-2 row-start-2 flex items-baseline justify-between gap-4">
                      {(operation || environment.failureCode) && (
                        <details className="ml-10 min-w-0 text-meta text-faint">
                          <summary className="h-[26px] w-fit cursor-pointer select-none leading-[26px] hover:text-fg">
                            Details
                          </summary>
                          <div className="mt-1 grid gap-0.5 pl-3">
                            {operation && (
                              <span>
                                {operation.stage} · updated{" "}
                                {new Date(operation.updatedAt).toLocaleString()}
                              </span>
                            )}
                            {(environment.failureCode ||
                              operation?.failureCode) && (
                              <span>
                                Code{" "}
                                {environment.failureCode ||
                                  operation?.failureCode}
                              </span>
                            )}
                          </div>
                        </details>
                      )}
                      <Button
                        className="ml-auto shrink-0"
                        size="sm"
                        disabled={!canManage || running}
                        onClick={() => {
                          setEnvironmentTarget(environment);
                          setEnvironmentDialogOpen(true);
                        }}
                      >
                        {running
                          ? "Preparing…"
                          : environment.state === "failed"
                            ? "Retry"
                            : environment.state === "stale"
                              ? "Refresh"
                              : "Configure"}
                      </Button>
                    </div>
                  </div>
                </SettingCard>
              );
            })}
          </div>
          <SettingsHint>
            Project snapshots expire after 24 hours and refresh only for
            projects you have chosen here. A snapshot never contains session or
            model credentials.
          </SettingsHint>
        </>
      )}
      <ProjectEnvironmentDialog
        open={environmentDialogOpen}
        onOpenChange={setEnvironmentDialogOpen}
        target={environmentTarget}
        available={
          environmentTarget ? [environmentTarget] : availableEnvironments
        }
        onStarted={environmentStarted}
      />
    </SettingsPanel>
  );
}
