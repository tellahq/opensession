import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
import {
  bootstrapRunner,
  createRunnerPairing,
  fetchRunnerBootstrapTargets,
  fetchRunners,
  revokeRunner,
  updateRunner,
  type RunnerBootstrapTarget,
  type RunnerInfo,
} from "../../lib/api/runners";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { Field, Input } from "../../ui/input";
import { Modal } from "../../ui/modal";
import { OptionSelect } from "../../ui/select";
import { Switch } from "../../ui/switch";
import { toast } from "../../ui/toast";
import {
  SettingCard,
  SettingCardSkeleton,
  SettingsGroupLabel,
  SettingsHeader,
  SettingsHint,
  SettingsPanel,
} from "../../ui/settings";
import {
  markTileClass,
  markTileGradient,
  markTileInk,
  markTileShadow,
} from "../../lib/mark-tile";
import { IconServer } from "../icons";

const stateStyle: Record<RunnerInfo["state"], string> = {
  online: "bg-green-soft text-green",
  busy: "bg-yellow-soft text-yellow",
  offline: "bg-hover text-dim",
  maintenance: "bg-hover text-dim",
};

function resourceSummary(runner: RunnerInfo): string {
  const values = [
    runner.resources?.cpuCores
      ? `${runner.resources.cpuCores} cores`
      : undefined,
    runner.resources?.memoryGb ? `${runner.resources.memoryGb} GB` : undefined,
    runner.resources?.gpu?.model
      ? `${runner.resources.gpu.model}${runner.resources.gpu.vramGb ? ` · ${runner.resources.gpu.vramGb} GB VRAM` : ""}`
      : undefined,
  ].filter(Boolean);
  return values.join(" · ") || "No resource inventory yet";
}

function pairingCommand(code: string): string {
  return `opensession runner connect --server ${location.origin} --code ${code}`;
}

export function RunnersPanel() {
  const [runners, setRunners] = useState<RunnerInfo[]>([]);
  const [admin, setAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pairing, setPairing] = useState<{
    code: string;
    expiresAt: number;
  } | null>(null);
  const [connectChoice, setConnectChoice] = useState<
    "choices" | "ssh" | "kubernetes" | null
  >(null);
  const [bootstrapTargets, setBootstrapTargets] = useState<{
    ssh: RunnerBootstrapTarget[];
    kubernetes: RunnerBootstrapTarget[];
  }>({ ssh: [], kubernetes: [] });
  const [bootstrapTargetId, setBootstrapTargetId] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async () => {
    await (async () => {
      const data = await fetchRunners();
      setRunners(data.runners);
      setAdmin(data.admin);
    })()
      .catch(async (error) => {
        toast(
          error instanceof Error ? error.message : "Failed to load Runners",
          { variant: "error" },
        );
      })
      .finally(async () => {
        setLoading(false);
      });
  };

  useEffect(() => {
    void load();
  }, []);

  const pair = async () => {
    await (async () => {
      setPairing(await createRunnerPairing());
      setConnectChoice(null);
    })().catch(async (error) => {
      toast(
        error instanceof Error ? error.message : "Could not create pairing",
        { variant: "error" },
      );
    });
  };
  const chooseBootstrap = async (kind: "ssh" | "kubernetes") => {
    await (async () => {
      const targets = await fetchRunnerBootstrapTargets();
      setBootstrapTargets(targets);
      setBootstrapTargetId(targets[kind][0]?.id || "");
      setConnectChoice(kind);
    })().catch(async (error) => {
      toast(
        error instanceof Error
          ? error.message
          : "Could not load Runner connection options",
        { variant: "error" },
      );
    });
  };
  const startBootstrap = async () => {
    if (!connectChoice || connectChoice === "choices" || !bootstrapTargetId)
      return;
    await (async () => {
      const result = await bootstrapRunner(connectChoice, bootstrapTargetId);
      setConnectChoice(null);
      toast(
        `${result.target} is connecting. It appears here when its Runner channel is online.`,
        { variant: "success" },
      );
      void load();
    })().catch(async (error) => {
      toast(
        error instanceof Error
          ? error.message
          : "Could not start Runner migration",
        { variant: "error" },
      );
    });
  };
  const copy = async () => {
    if (!pairing) return;
    await (async () => {
      await navigator.clipboard.writeText(pairingCommand(pairing.code));
      toast("Pairing command copied", { variant: "success" });
    })().catch(async () => {
      toast("Copy the command from this page", { variant: "error" });
    });
  };
  const change = async (
    runner: RunnerInfo,
    patch: Parameters<typeof updateRunner>[1],
  ) => {
    setBusyId(runner.id);
    setBusyId(runner.id);
    const updated = await updateRunner(runner.id, patch)
      .then((next) => {
        setRunners((items) =>
          items.map((item) => (item.id === next.id ? next : item)),
        );
        return true;
      })
      .catch((error) => {
        toast(
          error instanceof Error ? error.message : "Could not update Runner",
          { variant: "error" },
        );
        return false;
      })
      .finally(() => setBusyId(null));
    return updated;
  };
  const revoke = async (runner: RunnerInfo) => {
    if (
      !confirm(
        `Revoke ${runner.label || runner.name}? It disconnects immediately.`,
      )
    )
      return;
    setBusyId(runner.id);
    await (async () => {
      await revokeRunner(runner.id);
      setRunners((items) => items.filter((item) => item.id !== runner.id));
    })()
      .catch(async (error) => {
        toast(
          error instanceof Error ? error.message : "Could not revoke Runner",
          { variant: "error" },
        );
      })
      .finally(async () => {
        setBusyId(null);
      });
  };

  return (
    <SettingsPanel>
      <SettingsHeader
        title="Runners"
        description="Computers your workspace explicitly trusts for work that needs their hardware or platform. They are not isolated Sandboxes."
        actions={
          admin ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() => setConnectChoice("choices")}
            >
              Add Runner
            </Button>
          ) : undefined
        }
      />
      {connectChoice === "choices" && (
        <div className="mx-4 mb-4 rounded-lg bg-raised p-4">
          <div className="text-item-title font-semibold text-fg">
            Connect a Runner
          </div>
          <p className="mb-3 mt-1 text-supporting leading-relaxed text-dim">
            Choose the machine path first. Runners are trusted computers, not
            isolated Sandboxes.
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            <Button size="sm" onClick={() => void pair()}>
              Connect on this machine
            </Button>
            <Button
              size="sm"
              variant="soft"
              onClick={() => void chooseBootstrap("ssh")}
            >
              Migrate SSH machine
            </Button>
            <Button
              size="sm"
              variant="soft"
              onClick={() => void chooseBootstrap("kubernetes")}
            >
              Connect Kubernetes GPU
            </Button>
          </div>
          <Button
            className="mt-3"
            size="sm"
            variant="ghost"
            onClick={() => setConnectChoice(null)}
          >
            Cancel
          </Button>
        </div>
      )}
      {(connectChoice === "ssh" || connectChoice === "kubernetes") && (
        <div className="mx-4 mb-4 rounded-lg bg-raised p-4">
          <div className="text-item-title font-semibold text-fg">
            {connectChoice === "ssh"
              ? "Migrate an SSH machine"
              : "Connect a Kubernetes GPU Runner"}
          </div>
          <p className="mb-3 mt-1 text-supporting leading-relaxed text-dim">
            Select a preconfigured operator target. The migration installs and
            starts only the Runner service, then the machine connects outbound.
          </p>
          {bootstrapTargets[connectChoice].length ? (
            <>
              <OptionSelect
                label="Operator target"
                value={bootstrapTargetId}
                options={bootstrapTargets[connectChoice].map((target) => ({
                  value: target.id,
                  label: `${target.label} · ${target.host ? `${target.user}@${target.host}:${target.port}` : `${target.context} / ${target.namespace} / ${target.workload}`}`,
                }))}
                onChange={setBootstrapTargetId}
              />
              <div className="mt-3 flex gap-2">
                <Button size="sm" onClick={() => void startBootstrap()}>
                  Connect
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setConnectChoice("choices")}
                >
                  Back
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="mb-0 text-supporting text-dim">
                No configured {connectChoice === "ssh" ? "SSH" : "Kubernetes"}{" "}
                targets are available.
              </p>
              <Button
                className="mt-3"
                size="sm"
                variant="ghost"
                onClick={() => setConnectChoice("choices")}
              >
                Back
              </Button>
            </>
          )}
        </div>
      )}

      {pairing && (
        <div className="mx-4 mb-4 rounded-lg bg-raised p-4">
          <div className="text-item-title font-semibold text-fg">
            Connect on this machine
          </div>
          <p className="mb-3 mt-1 text-supporting leading-relaxed text-dim">
            Run this once on the computer. It detects capabilities and opens a
            reconnecting Runner channel.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              readOnly
              value={pairingCommand(pairing.code)}
              className="min-w-0 flex-1 font-mono text-xs"
            />
            <Button size="sm" onClick={() => void copy()}>
              Copy
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPairing(null)}>
              Done
            </Button>
          </div>
          <p className="mb-0 mt-2 text-supporting text-faint">
            This one-time code expires at{" "}
            {new Date(pairing.expiresAt).toLocaleTimeString()}.
          </p>
          <p className="mb-0 mt-1 text-supporting text-faint">
            New machine? Install the command first: install.sh on macOS and
            Linux, install.ps1 on Windows.
          </p>
        </div>
      )}

      <SettingsGroupLabel
        actions={
          <Button size="sm" variant="ghost" onClick={() => void load()}>
            Refresh
          </Button>
        }
      >
        Workspace inventory
      </SettingsGroupLabel>
      {loading ? (
        <SettingCardSkeleton rows={3} icon={40} label="Loading Runners" />
      ) : !runners.length ? (
        <SettingCard>
          <div className="px-5 py-5">
            <div className="text-item-title font-medium text-fg">
              No Runners connected
            </div>
            <p className="mb-0 mt-1 text-supporting leading-relaxed text-dim">
              Choose a computer, connect it with a pairing command, then choose
              its permissions.
            </p>
          </div>
        </SettingCard>
      ) : (
        <div className="grid gap-3">
          {runners.map((runner) => (
            <RunnerRow
              key={runner.id}
              runner={runner}
              admin={admin}
              busy={busyId === runner.id}
              onChange={change}
              onRevoke={revoke}
            />
          ))}
        </div>
      )}
      <SettingsHint>
        SSH and Kubernetes bootstrap remain operator-managed migration paths.
        They never give agents direct SSH or kubectl access.
      </SettingsHint>
    </SettingsPanel>
  );
}

type RunnerChange = (
  runner: RunnerInfo,
  patch: Parameters<typeof updateRunner>[1],
) => Promise<boolean>;

function RunnerIcon() {
  const size = 40;
  return (
    <span
      className={markTileClass(size)}
      style={{
        width: size,
        height: size,
        backgroundImage: markTileGradient("indigo"),
        color: "#fff",
        boxShadow: markTileShadow(markTileInk("indigo")),
      }}
    >
      <IconServer size={22} />
    </span>
  );
}

function RunnerRow({
  runner,
  admin,
  busy,
  onChange,
  onRevoke,
}: {
  runner: RunnerInfo;
  admin: boolean;
  busy: boolean;
  onChange: RunnerChange;
  onRevoke: (runner: RunnerInfo) => void;
}) {
  const [editing, setEditing] = useState(false);
  // Focus the first field rather than letting Base UI land on the ✕, which
  // opens the dialog with its close button ringed.
  const labelRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <SettingCard>
        <div className="grid grid-cols-[minmax(0,1fr)_5.75rem] gap-x-4 px-5 py-4 desktop:grid-cols-[minmax(0,1fr)_13rem]">
          <div className="col-start-1 row-start-1 flex min-w-0 items-start gap-3">
            <RunnerIcon />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-item-title font-semibold text-fg">
                  {runner.label || runner.name}
                </span>
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-meta font-medium capitalize",
                    stateStyle[runner.state],
                  )}
                >
                  {runner.state}
                </span>
              </div>
              <div className="mt-1 text-supporting leading-relaxed text-dim">
                {runner.platform} · {runner.arch} · {resourceSummary(runner)}
              </div>
              {runner.workload && (
                <div className="mt-2 text-supporting text-dim">
                  Working:{" "}
                  {runner.workload.operation ||
                    runner.workload.sessionId ||
                    "session work"}
                </div>
              )}
              <div className="mt-2 grid gap-0.5 text-meta text-faint">
                {runner.capabilities.toolchains.length > 0 && (
                  <div>{runner.capabilities.toolchains.join(" · ")}</div>
                )}
                {runner.resources?.localInference?.length ? (
                  <div>
                    Local inference:{" "}
                    {runner.resources.localInference
                      .map(
                        (runtime) =>
                          `${runtime.runtime}${runtime.models.length ? ` (${runtime.models.join(", ")})` : ""}`,
                      )
                      .join(" · ")}
                  </div>
                ) : null}
                {runner.migration?.kind === "kubernetes" && (
                  <div>
                    Kubernetes · {runner.migration.context} /{" "}
                    {runner.migration.namespace} / {runner.migration.workload}
                  </div>
                )}
              </div>
            </div>
          </div>
          {admin && (
            <div className="col-start-2 row-start-1 flex justify-end self-start">
              <Button size="sm" onClick={() => setEditing(true)}>
                Configure
              </Button>
            </div>
          )}
        </div>
      </SettingCard>
      {admin && (
        <Modal.Root open={editing} onOpenChange={setEditing}>
          {/* The form is a child so Base UI's portal remounts it on every open,
			    which re-reads the current runner instead of showing edits staged
			    against a Runner that has since reported new state. */}
          <Modal.Content initialFocus={labelRef}>
            <RunnerDetails
              runner={runner}
              busy={busy}
              labelRef={labelRef}
              onChange={onChange}
              onRevoke={onRevoke}
              onSaved={() => setEditing(false)}
            />
          </Modal.Content>
        </Modal.Root>
      )}
    </>
  );
}

function RunnerDetails({
  runner,
  busy,
  labelRef,
  onChange,
  onRevoke,
  onSaved,
}: {
  runner: RunnerInfo;
  busy: boolean;
  labelRef: RefObject<HTMLInputElement | null>;
  onChange: RunnerChange;
  onRevoke: (runner: RunnerInfo) => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState(runner.label || "");
  const [tags, setTags] = useState(runner.capabilities.tags.join(", "));
  const [users, setUsers] = useState(runner.allowedUsers.join(", "));
  const [repos, setRepos] = useState(runner.allowedRepos.join(", "));
  const [maintenance, setMaintenance] = useState(Boolean(runner.maintenance));
  const [commands, setCommands] = useState(runner.permissions.commands);
  const [inferenceModels, setInferenceModels] = useState(
    runner.localInferencePolicy?.allowedModels.join(", ") || "",
  );
  const [inferenceEnabled, setInferenceEnabled] = useState(
    Boolean(runner.localInferencePolicy?.enabled),
  );
  const inference = Boolean(runner.resources?.localInference?.length);
  // Every field commits on Save, the switches included: a dialog with its own
  // Save button that also applies two of its controls the moment they move
  // leaves Cancel meaning different things in one form.
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const patch: Parameters<typeof updateRunner>[1] = {
      label: label.trim() || undefined,
      capabilities: { tags: list(tags) },
      allowedUsers: list(users),
      allowedRepos: list(repos),
      maintenance,
      permissions: { commands },
    };
    if (inference) {
      patch.localInferencePolicy = {
        enabled: inferenceEnabled,
        allowedUsers: list(users),
        allowedModels: list(inferenceModels),
        allowedTasks: ["chat", "embedding", "image", "video"],
      };
    }
    const saved = await onChange(runner, patch);
    if (saved) onSaved();
  };
  return (
    <>
      <Modal.Header
        title={runner.label || runner.name}
        description={
          <>
            <span className={`capitalize ${stateStyle[runner.state]}`}>
              {runner.state}
            </span>{" "}
            · {runner.platform} · {runner.arch} · {resourceSummary(runner)}
          </>
        }
      />
      {/* Every field here is a comma-separated LIST, and a list clips in a
		    half-dialog column (the same reason SetupTeam runs its email and
		    alias full width). So none of them pair up, and the dialog keeps the
		    standard width rather than widening to fit a grid. */}
      {/* Below the title every line in this dialog is 13px, so hierarchy can
		    only come from grouping. The three zones are what the fields
		    actually are: what the Runner is called, who may use it, and what
		    it is doing. 20px between them against 12px inside. */}
      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => void save(event)}
      >
        <div className="flex flex-col gap-3">
          <Field label="Label">
            <Input
              ref={labelRef}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder={runner.name}
              spellCheck={false}
            />
          </Field>
          <Field label="Tags" title="Comma-separated.">
            <Input
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              placeholder="No tags"
              autoCapitalize="none"
              spellCheck={false}
            />
          </Field>
        </div>
        <div className="flex flex-col gap-3">
          <Field
            label="Allowed people"
            title="Comma-separated. Blank means every workspace member."
          >
            <Input
              value={users}
              onChange={(event) => setUsers(event.target.value)}
              placeholder="All workspace members"
              autoCapitalize="none"
              spellCheck={false}
            />
          </Field>
          <Field
            label="Allowed repositories"
            title="Comma-separated. Blank means every repository."
          >
            <Input
              value={repos}
              onChange={(event) => setRepos(event.target.value)}
              placeholder="All repositories"
              autoCapitalize="none"
              spellCheck={false}
            />
          </Field>
          {inference ? (
            <Field label="Allowed local models" title="Comma-separated.">
              <Input
                value={inferenceModels}
                onChange={(event) => setInferenceModels(event.target.value)}
                placeholder="Model names"
                autoCapitalize="none"
                spellCheck={false}
              />
            </Field>
          ) : null}
        </div>
        {/* Label left, control right: the shape every toggle in settings
			    already has, so two of them read as a list rather than as pairs
			    floating in a row. */}
        <div className="flex flex-col">
          <SwitchRow
            label="Maintenance"
            checked={maintenance}
            onChange={setMaintenance}
            disabled={busy}
          />
          <SwitchRow
            label="Commands"
            checked={commands}
            onChange={setCommands}
            disabled={busy}
          />
          {inference ? (
            <SwitchRow
              label="Local inference"
              checked={inferenceEnabled}
              onChange={setInferenceEnabled}
              disabled={busy}
            />
          ) : null}
        </div>
        <Modal.Footer>
          <Button
            variant="danger"
            onClick={() => onRevoke(runner)}
            disabled={busy}
          >
            Revoke
          </Button>
          <span className="flex-1" />
          <Modal.Close
            render={
              <Button variant="ghost" disabled={busy}>
                Cancel
              </Button>
            }
          />
          <Button variant="primary" type="submit" disabled={busy}>
            Save
          </Button>
        </Modal.Footer>
      </form>
    </>
  );
}

function SwitchRow({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled: boolean;
}) {
  // `text-dim`, matching Field's label: both name a control, so both are
  // chrome. Two label colours at one size in one dialog reads as arbitrary,
  // and it is the values (the typed text, the lit switch) that should carry.
  return (
    <label className="flex min-h-9 items-center justify-between gap-4 text-label font-medium text-dim">
      {label}
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
      />
    </label>
  );
}

function list(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
